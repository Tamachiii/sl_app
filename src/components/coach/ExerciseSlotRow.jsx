import { useState } from 'react';

export default function ExerciseSlotRow({ slot, index, total, onUpdate, onDelete, onMove, children }) {
  const ex = slot.exercise;
  const isTimeBased = slot.duration_seconds != null;
  const [sets, setSets] = useState(slot.sets);
  const [reps, setReps] = useState(slot.reps ?? '');
  const [seconds, setSeconds] = useState(slot.duration_seconds ?? '');
  const [weight, setWeight] = useState(slot.weight_kg ?? '');
  const [rest, setRest] = useState(slot.rest_seconds ?? '');

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

      {children}
    </div>
  );
}
