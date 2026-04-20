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

  // Sync local state when server data changes (e.g. after mutation refetch)
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

  return (
    <div className="bg-white rounded-xl shadow-sm p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <span className="font-medium text-gray-900 text-sm">{ex.name}</span>
          <span className={`ml-2 text-xs font-medium px-1.5 py-0.5 rounded ${
            ex.type === 'pull' ? 'bg-pull/10 text-pull' : 'bg-push/10 text-push'
          }`}>
            {ex.type}
          </span>
          <span className="ml-1 text-xs text-gray-400">D{ex.difficulty}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onMove(-1)}
            disabled={index === 0}
            aria-label="Move up"
            className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-30"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
          <button
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            aria-label="Move down"
            className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-30"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <button
            onClick={() => { if (confirm('Remove this exercise?')) onDelete(); }}
            aria-label="Remove exercise"
            className="p-1 text-gray-400 hover:text-danger"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex gap-3">
        <div className="flex-1">
          <label htmlFor={`sets-${slot.id}`} className="text-xs text-gray-500 block mb-0.5">Sets</label>
          <input
            id={`sets-${slot.id}`}
            type="number"
            min={1}
            value={sets}
            onChange={(e) => setSets(Number(e.target.value))}
            onBlur={handleBlur}
            className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm text-center"
          />
        </div>
        {isTimeBased ? (
          <div className="flex-1">
            <label htmlFor={`seconds-${slot.id}`} className="text-xs text-gray-500 block mb-0.5">Seconds</label>
            <input
              id={`seconds-${slot.id}`}
              type="number"
              min={1}
              value={seconds}
              onChange={(e) => setSeconds(e.target.value)}
              onBlur={handleBlur}
              className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm text-center"
            />
          </div>
        ) : (
          <div className="flex-1">
            <label htmlFor={`reps-${slot.id}`} className="text-xs text-gray-500 block mb-0.5">Reps</label>
            <input
              id={`reps-${slot.id}`}
              type="number"
              min={1}
              value={reps}
              onChange={(e) => setReps(e.target.value)}
              onBlur={handleBlur}
              className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm text-center"
            />
          </div>
        )}
        <div className="flex-1">
          <label htmlFor={`weight-${slot.id}`} className="text-xs text-gray-500 block mb-0.5">Weight (kg)</label>
          <input
            id={`weight-${slot.id}`}
            type="number"
            min={0}
            step={0.5}
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            onBlur={handleBlur}
            placeholder="BW"
            className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm text-center"
          />
        </div>
        <div className="flex-1">
          <label htmlFor={`rest-${slot.id}`} className="text-xs text-gray-500 block mb-0.5">Rest (s)</label>
          <input
            id={`rest-${slot.id}`}
            type="number"
            min={0}
            step={15}
            value={rest}
            onChange={(e) => setRest(e.target.value)}
            onBlur={handleBlur}
            placeholder="—"
            className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm text-center"
          />
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-gray-500 flex items-center gap-1">
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
                className={`text-xs font-medium rounded-full px-2 py-0.5 border transition-colors ${
                  active
                    ? 'bg-amber-100 border-amber-300 text-amber-800'
                    : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
                }`}
              >
                {n}
              </button>
            );
          })}
        </div>
        {Number(sets) > 1 && (
          <button
            type="button"
            onClick={videoSets.length === Number(sets) ? clearVideoSets : selectAllVideoSets}
            className="text-xs text-gray-400 hover:text-primary underline"
          >
            {videoSets.length === Number(sets) ? 'None' : 'All'}
          </button>
        )}
      </div>

      {showNotes ? (
        <div className="space-y-1">
          <label htmlFor={`notes-${slot.id}`} className="text-xs text-gray-500 block">
            Coach note for student
          </label>
          <textarea
            id={`notes-${slot.id}`}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={handleNotesBlur}
            placeholder="e.g. keep elbows tucked, focus on the negative…"
            rows={2}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
      ) : (
        <button
          onClick={() => setShowNotes(true)}
          className="text-xs text-gray-400 hover:text-primary"
        >
          + Add coach note
        </button>
      )}

      {children}
    </div>
  );
}
