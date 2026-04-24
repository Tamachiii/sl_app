import { useState, useEffect } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import ConfirmDialog from '../ui/ConfirmDialog';

export default function ExerciseSlotRow({ slot, onUpdate, onDelete, children }) {
  const ex = slot.exercise;
  const isTimeBased = slot.duration_seconds != null;
  const [sets, setSets] = useState(slot.sets);
  const [reps, setReps] = useState(slot.reps ?? '');
  const [seconds, setSeconds] = useState(slot.duration_seconds ?? '');
  const [weight, setWeight] = useState(slot.weight_kg ?? '');
  const [rest, setRest] = useState(slot.rest_seconds ?? '');
  const [notes, setNotes] = useState(slot.notes ?? '');
  const [showNotes, setShowNotes] = useState(!!slot.notes);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const videoSets = Array.isArray(slot.record_video_set_numbers) ? slot.record_video_set_numbers : [];

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: slot.id });

  const sortableStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  useEffect(() => {
    setSets(slot.sets);
    setReps(slot.reps ?? '');
    setSeconds(slot.duration_seconds ?? '');
    setWeight(slot.weight_kg ?? '');
    setRest(slot.rest_seconds ?? '');
    setNotes(slot.notes ?? '');
  }, [slot.id, slot.sets, slot.reps, slot.duration_seconds, slot.weight_kg, slot.rest_seconds, slot.notes]);

  function handleBlur() {
    const updates = {};
    if (sets !== slot.sets) updates.sets = sets;
    if (isTimeBased) {
      const s = seconds === '' ? null : Number(seconds);
      if (s !== slot.duration_seconds) updates.duration_seconds = s;
    } else {
      const r = reps === '' ? null : Number(reps);
      if (r !== slot.reps) updates.reps = r;
    }
    const w = weight === '' ? null : Number(weight);
    if (w !== slot.weight_kg) updates.weight_kg = w;
    const rs = rest === '' ? null : Number(rest);
    if (rs !== (slot.rest_seconds ?? null)) updates.rest_seconds = rs;
    if (Object.keys(updates).length > 0) onUpdate(updates);
  }

  function commitVideoSets(next) {
    const sorted = [...new Set(next)].filter((n) => n >= 1 && n <= Number(sets)).sort((a, b) => a - b);
    const current = [...videoSets].sort((a, b) => a - b);
    if (sorted.length === current.length && sorted.every((n, i) => n === current[i])) return;
    onUpdate({ record_video_set_numbers: sorted });
  }

  function toggleVideoSet(n) {
    const next = videoSets.includes(n) ? videoSets.filter((x) => x !== n) : [...videoSets, n];
    commitVideoSets(next);
  }

  function selectAllVideoSets() {
    commitVideoSets(Array.from({ length: Number(sets) || 0 }, (_, i) => i + 1));
  }

  function clearVideoSets() {
    commitVideoSets([]);
  }

  function handleNotesBlur() {
    const n = notes.trim() || null;
    if (n !== (slot.notes ?? null)) onUpdate({ notes: n });
  }

  const inputCls =
    'w-full rounded-lg border border-ink-200 bg-white px-2 py-1.5 sl-mono text-[16px] text-center text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]';

  return (
    <div ref={setNodeRef} style={sortableStyle} className="sl-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${ex.name}`}
            className="shrink-0 px-1 text-ink-400 hover:text-gray-700 cursor-grab active:cursor-grabbing touch-none"
          >
            <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
              <circle cx="2.5" cy="3" r="1.25" />
              <circle cx="7.5" cy="3" r="1.25" />
              <circle cx="2.5" cy="8" r="1.25" />
              <circle cx="7.5" cy="8" r="1.25" />
              <circle cx="2.5" cy="13" r="1.25" />
              <circle cx="7.5" cy="13" r="1.25" />
            </svg>
          </button>
          <span className="sl-display text-[16px] text-gray-900 truncate">{ex.name}</span>
          <span className="sl-mono text-[10px] text-ink-400 shrink-0">D{ex.difficulty}</span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => setConfirmDelete(true)}
            aria-label="Remove exercise"
            className="w-7 h-7 rounded-md flex items-center justify-center text-ink-400 hover:bg-ink-100 hover:text-danger"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          <ConfirmDialog
            open={confirmDelete}
            onClose={() => setConfirmDelete(false)}
            onConfirm={onDelete}
            title="Remove exercise"
            message={`Remove "${ex.name}" from this session? This can't be undone.`}
            confirmText="Remove"
          />
        </div>
      </div>

      <div className="flex gap-2">
        <div className="flex-1">
          <label htmlFor={`sets-${slot.id}`} className="sl-label text-ink-400 block mb-1">Sets</label>
          <input
            id={`sets-${slot.id}`}
            type="number"
            min={1}
            value={sets}
            onChange={(e) => setSets(Number(e.target.value))}
            onBlur={handleBlur}
            className={inputCls}
          />
        </div>
        {isTimeBased ? (
          <div className="flex-1">
            <label htmlFor={`seconds-${slot.id}`} className="sl-label text-ink-400 block mb-1">Seconds</label>
            <input
              id={`seconds-${slot.id}`}
              type="number"
              min={1}
              value={seconds}
              onChange={(e) => setSeconds(e.target.value)}
              onBlur={handleBlur}
              className={inputCls}
            />
          </div>
        ) : (
          <div className="flex-1">
            <label htmlFor={`reps-${slot.id}`} className="sl-label text-ink-400 block mb-1">Reps</label>
            <input
              id={`reps-${slot.id}`}
              type="number"
              min={1}
              value={reps}
              onChange={(e) => setReps(e.target.value)}
              onBlur={handleBlur}
              className={inputCls}
            />
          </div>
        )}
        <div className="flex-1">
          <label htmlFor={`weight-${slot.id}`} className="sl-label text-ink-400 block mb-1">Weight</label>
          <input
            id={`weight-${slot.id}`}
            type="number"
            min={0}
            step={0.5}
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            onBlur={handleBlur}
            placeholder="BW"
            className={inputCls}
          />
        </div>
        <div className="flex-1">
          <label htmlFor={`rest-${slot.id}`} className="sl-label text-ink-400 block mb-1">Rest (s)</label>
          <input
            id={`rest-${slot.id}`}
            type="number"
            min={0}
            step={15}
            value={rest}
            onChange={(e) => setRest(e.target.value)}
            onBlur={handleBlur}
            placeholder="—"
            className={inputCls}
          />
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="sl-label text-ink-400">Record</span>
        <div className="flex gap-1 flex-wrap">
          {Array.from({ length: Number(sets) || 0 }, (_, i) => i + 1).map((n) => {
            const active = videoSets.includes(n);
            return (
              <button
                key={n}
                type="button"
                onClick={() => toggleVideoSet(n)}
                aria-pressed={active}
                className="sl-mono text-[11px] rounded-md w-7 h-6 flex items-center justify-center border transition-colors"
                style={
                  active
                    ? {
                        background: 'var(--color-warn)',
                        borderColor: 'var(--color-warn)',
                        color: 'var(--color-ink-900)',
                      }
                    : undefined
                }
              >
                <span className={active ? '' : 'text-ink-500'}>{n}</span>
              </button>
            );
          })}
        </div>
        {Number(sets) > 1 && (
          <button
            type="button"
            onClick={videoSets.length === Number(sets) ? clearVideoSets : selectAllVideoSets}
            className="sl-mono text-[11px] text-ink-400 hover:text-[var(--color-accent)] underline"
          >
            {videoSets.length === Number(sets) ? 'NONE' : 'ALL'}
          </button>
        )}
      </div>

      {showNotes ? (
        <div className="space-y-1">
          <label htmlFor={`notes-${slot.id}`} className="sl-label text-ink-400 block">
            Coach note for student
          </label>
          <textarea
            id={`notes-${slot.id}`}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={handleNotesBlur}
            placeholder="e.g. keep elbows tucked, focus on the negative…"
            rows={2}
            className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-[16px] text-gray-900 resize-none focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
          />
        </div>
      ) : (
        <button
          onClick={() => setShowNotes(true)}
          className="sl-mono text-[11px] text-ink-400 hover:text-[var(--color-accent)]"
        >
          + Add coach note
        </button>
      )}

      {children}
    </div>
  );
}
