import { useMemo, useState } from 'react';
import Dialog from '../ui/Dialog';
import { useSaveSlotDeviation, useRequestPromote } from '../../hooks/useSlotDeviations';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';

/**
 * Per-slot off-script controls: swap the prescribed exercise for another from
 * the coach's library, or skip the exercise entirely. One slot_deviations row
 * per slot (swap XOR skip). Renders the current state with an undo, or the
 * Swap / Skip actions when the slot is still on-plan.
 *
 * The substitute is library-only (no free-text) so every swap stays a known
 * exercise. `exerciseLibrary` is the coach's catalogue (students have read
 * access); we resolve the substitute's name from it for display.
 */
export default function SlotDeviationBar({
  sessionId,
  slot,
  deviation,
  exerciseLibrary,
  locked = false,
}) {
  const saveDeviation = useSaveSlotDeviation();
  const requestPromote = useRequestPromote();
  const online = useOnlineStatus();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');

  const kind = deviation?.kind || null;
  const promoteRequested = !!deviation?.promote_requested_at;
  const substituteName = useMemo(() => {
    if (kind !== 'swap' || !deviation?.substitute_exercise_id) return null;
    const ex = (exerciseLibrary || []).find((e) => e.id === deviation.substitute_exercise_id);
    return ex?.name || 'another exercise';
  }, [kind, deviation, exerciseLibrary]);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (exerciseLibrary || [])
      .filter((e) => e.id !== slot.exercise?.id)
      .filter((e) => (q ? e.name.toLowerCase().includes(q) : true));
  }, [exerciseLibrary, slot.exercise, query]);

  function applySwap(exerciseId) {
    saveDeviation.mutate({ sessionId, slotId: slot.id, kind: 'swap', substituteExerciseId: exerciseId });
    setPickerOpen(false);
    setQuery('');
  }

  function applySkip() {
    saveDeviation.mutate({ sessionId, slotId: slot.id, kind: 'skip' });
  }

  function clearDeviation() {
    saveDeviation.mutate({ sessionId, slotId: slot.id, kind: null });
  }

  // Active swap/skip — show the state + undo (and, for swaps, change).
  if (kind) {
    const isSwap = kind === 'swap';
    return (
      <div
        className="rounded-lg px-3 py-2 flex items-center gap-2 flex-wrap"
        style={{
          background: 'color-mix(in srgb, var(--color-warn) 14%, transparent)',
          border: '1px solid color-mix(in srgb, var(--color-warn) 35%, transparent)',
        }}
      >
        {/* text-ink-900 (not inline style): the warn tint follows the dark
            card surface, and only the class remap flips the text with it. */}
        <span className="sl-label shrink-0 text-ink-900">
          {isSwap ? 'Swapped' : 'Skipped'}
        </span>
        <span className="text-[13px] text-gray-800 flex-1 min-w-0">
          {isSwap ? (
            <>Doing <span className="font-semibold">{substituteName}</span> instead</>
          ) : (
            'You skipped this exercise'
          )}
        </span>
        {!locked && (
          <span className="flex items-center gap-1.5 shrink-0">
            {isSwap && (
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200 px-3"
              >
                Change
              </button>
            )}
            <button
              type="button"
              onClick={clearDeviation}
              className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200 px-3"
            >
              Undo
            </button>
          </span>
        )}
        {/* Phase 3.3: ask the coach to make this deviation the standing plan. */}
        {promoteRequested ? (
          <span className="sl-mono text-[11px] text-ink-600 basis-full">
            ✓ Asked your coach to make this permanent
          </span>
        ) : !locked && online ? (
          <button
            type="button"
            onClick={() => requestPromote.mutate({ sessionId, slotId: slot.id })}
            disabled={requestPromote.isPending}
            className="sl-pill bg-ink-100 text-ink-600 hover:bg-ink-200 px-3 basis-full sm:basis-auto disabled:opacity-50"
          >
            Ask coach to make this permanent
          </button>
        ) : null}
        {isSwap && (
          <SwapPicker
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            candidates={candidates}
            query={query}
            setQuery={setQuery}
            onPick={applySwap}
          />
        )}
      </div>
    );
  }

  if (locked) return null;

  // On-plan — offer the actions.
  return (
    <div className="flex items-center gap-2">
      <span className="sl-mono text-[11px] text-ink-400">Can't do this exercise?</span>
      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        className="sl-pill bg-ink-100 text-ink-600 hover:bg-ink-200 px-3"
      >
        Swap
      </button>
      <button
        type="button"
        onClick={applySkip}
        className="sl-pill bg-ink-100 text-ink-600 hover:bg-ink-200 px-3"
      >
        Skip
      </button>
      <SwapPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        candidates={candidates}
        query={query}
        setQuery={setQuery}
        onPick={applySwap}
      />
    </div>
  );
}

function SwapPicker({ open, onClose, candidates, query, setQuery, onPick }) {
  return (
    <Dialog open={open} onClose={onClose} title="Swap exercise">
      <p className="sl-mono text-[12px] text-ink-400 mb-3 leading-relaxed">
        Pick a replacement from your coach's library.
      </p>
      <label htmlFor="swap-search" className="sr-only">Search exercises</label>
      <input
        id="swap-search"
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search…"
        className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-[16px] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] mb-3"
      />
      <div className="max-h-64 overflow-y-auto -mx-1 px-1 space-y-1">
        {candidates.length === 0 ? (
          <p className="sl-mono text-[12px] text-ink-400 py-4 text-center">No exercises found.</p>
        ) : (
          candidates.map((ex) => (
            <button
              key={ex.id}
              type="button"
              onClick={() => onPick(ex.id)}
              className="w-full flex items-center gap-2 rounded-lg px-3 py-2.5 text-left hover:bg-ink-50"
            >
              <span className="sl-display text-[15px] text-gray-900 flex-1 min-w-0 truncate">{ex.name}</span>
              <span
                className={`sl-pill ${ex.type === 'pull' ? 'bg-pull/15 text-pull' : 'bg-push/15 text-push'}`}
              >
                {ex.type}
              </span>
            </button>
          ))
        )}
      </div>
    </Dialog>
  );
}
