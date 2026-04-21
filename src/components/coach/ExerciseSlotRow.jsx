import { useState, useEffect } from 'react';

export default function ExerciseSlotRow({ slot, index, total, onUpdate, onDelete, onMove, children }) {
  const ex = slot.exercise;
  const isTimeBased = slot.duration_seconds != null;
  const [sets, setSets] = useState(slot.sets);
  const [reps, setReps] = useState(slot.reps ?? '');
  const [seconds, setSeconds] = useState(slot.duration_seconds ?? '');
  const [weight, setWeight] = useState(slot.weight_kg ?? '');
  const [rest, setRest] = useState(slot.rest_seconds ?? '');
  const [notes, setNotes] = useState(slot.notes ?? '');
  const [showNotes, setShowNotes] = useState(!!slot.notes);
  const videoSets = Array.isArray(slot.record_video_set_numbers) ? slot.record_video_set_numbers : [];

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
    'w-full rounded-lg border border-ink-200 bg-white px-2 py-1.5 sl-mono text-[13px] text-center text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]';

  return (
    <div className="sl-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="sl-display text-[16px] text-gray-900">{ex.name}</span>
            <span
              className={`sl-pill ${
                ex.type === 'pull' ? 'bg-pull/15 text-pull' : 'bg-push/15 text-push'
              }`}
            >
              {ex.type}
            </span>
            <span className="sl-mono text-[10px] text-ink-400">D{ex.difficulty}</span>
          </div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => onMove(-1)}
            disabled={index === 0}
            aria-label="Move up"
            className="w-7 h-7 rounded-md flex items-center justify-center text-ink-400 hover:bg-ink-100 hover:text-gray-700 disabled:opacity-30"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
          <button
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            aria-label="Move down"
            className="w-7 h-7 rounded-md flex items-center justify-center text-ink-400 hover:bg-ink-100 hover:text-gray-700 disabled:opacity-30"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <button
            onClick={() => { if (confirm('Remove this exercise?')) onDelete(); }}
            aria-label="Remove exercise"
            className="w-7 h-7 rounded-md flex items-center justify-center text-ink-400 hover:bg-ink-100 hover:text-danger"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
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
        <span className="sl-label text-ink-400 flex items-center gap-1">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          Record sets
        </span>
        <div className="flex gap-1 flex-wrap">
          {Array.from({ length: Number(sets) || 0 }, (_, i) => i + 1).map((n) => {
            const active = videoSets.includes(n);
            return (
              <button
                key={n}
                type="button"
                onClick={() => toggleVideoSet(n)}
                aria-pressed={active}
                className="sl-mono text-[11px] rounded-full w-6 h-6 flex items-center justify-center border transition-colors"
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
            className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-[13px] text-gray-900 resize-none focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
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
