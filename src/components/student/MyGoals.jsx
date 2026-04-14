import { useState } from 'react';
import Header from '../layout/Header';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import {
  useMyGoals,
  useAddGoalProgress,
  useToggleGoalAchieved,
  formatGoalTarget,
} from '../../hooks/useGoals';

function GoalCard({ goal }) {
  const addProgress = useAddGoalProgress();
  const toggleAchieved = useToggleGoalAchieved();
  const [open, setOpen] = useState(false);
  const [weight, setWeight] = useState('');
  const [sets, setSets] = useState(goal.kind === 'format' ? String(goal.target_sets ?? '') : '');
  const [reps, setReps] = useState(String(goal.target_reps ?? ''));
  const [notes, setNotes] = useState('');

  const entries = [...(goal.goal_progress || [])].sort(
    (a, b) => new Date(b.recorded_at) - new Date(a.recorded_at)
  );
  const best = entries.reduce(
    (acc, e) => (e.weight_kg > (acc?.weight_kg ?? -Infinity) ? e : acc),
    null
  );

  function handleLog(e) {
    e.preventDefault();
    if (!weight) return;
    addProgress.mutate(
      {
        goalId: goal.id,
        weight_kg: Number(weight),
        sets: sets ? Number(sets) : null,
        reps: reps ? Number(reps) : null,
        notes: notes || null,
      },
      {
        onSuccess: () => {
          setWeight('');
          setNotes('');
          setOpen(false);
        },
      }
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-sm p-4 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-900">{goal.exercise?.name}</span>
            {goal.achieved && (
              <span className="flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-1.5 py-0.5 rounded">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
                Achieved
              </span>
            )}
          </div>
          <p className="text-sm text-gray-600">Target: {formatGoalTarget(goal)}</p>
          {goal.notes && (
            <p className="text-xs text-gray-500 whitespace-pre-wrap mt-0.5">{goal.notes}</p>
          )}
        </div>
        <button
          onClick={() =>
            toggleAchieved.mutate({ id: goal.id, achieved: !goal.achieved })
          }
          className={`text-xs rounded-lg px-2.5 py-1.5 font-medium shrink-0 ${
            goal.achieved
              ? 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              : 'bg-primary text-white hover:opacity-90'
          }`}
        >
          {goal.achieved ? 'Undo' : 'Mark achieved'}
        </button>
      </div>

      {entries.length > 0 && (
        <div className="border-t border-gray-100 pt-2">
          <p className="text-xs font-medium text-gray-600 mb-1">Best so far</p>
          <p className="text-sm text-gray-800">
            {best.weight_kg}kg
            {best.sets && best.reps ? ` (${best.sets} × ${best.reps})` : ''}
          </p>
          <details className="mt-2">
            <summary className="text-xs text-gray-500 cursor-pointer">
              {entries.length} attempt{entries.length === 1 ? '' : 's'}
            </summary>
            <ul className="mt-1 space-y-1">
              {entries.slice(0, 8).map((e) => (
                <li key={e.id} className="text-xs text-gray-600 flex justify-between gap-2">
                  <span>
                    {e.weight_kg}kg
                    {e.sets && e.reps ? ` — ${e.sets} × ${e.reps}` : ''}
                    {e.notes ? ` · ${e.notes}` : ''}
                  </span>
                  <span className="text-gray-400 shrink-0">
                    {new Date(e.recorded_at).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {open ? (
        <form onSubmit={handleLog} className="border-t border-gray-100 pt-3 space-y-2">
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="text-xs text-gray-600 block mb-1">Weight (kg)</span>
              <input
                type="number"
                min={0}
                step={0.5}
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                required
                className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex-1">
              <span className="text-xs text-gray-600 block mb-1">Sets</span>
              <input
                type="number"
                min={0}
                value={sets}
                onChange={(e) => setSets(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex-1">
              <span className="text-xs text-gray-600 block mb-1">Reps</span>
              <input
                type="number"
                min={0}
                value={reps}
                onChange={(e) => setReps(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
              />
            </label>
          </div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes (optional)"
            rows={2}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={addProgress.isPending}
              className="flex-1 bg-primary text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50"
            >
              {addProgress.isPending ? 'Logging…' : 'Log attempt'}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="flex-1 bg-gray-100 text-gray-600 rounded-lg py-2 text-sm font-medium"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="w-full text-xs font-medium text-primary border border-primary/40 rounded-lg py-1.5 hover:bg-primary/5"
        >
          + Log attempt
        </button>
      )}
    </div>
  );
}

export default function MyGoals() {
  const { data: goals, isLoading } = useMyGoals();

  if (isLoading) {
    return (
      <>
        <Header title="My Goals" />
        <div className="flex justify-center py-12"><Spinner /></div>
      </>
    );
  }

  return (
    <>
      <Header title="My Goals" />
      <div className="p-4 space-y-3">
        {(!goals || goals.length === 0) && (
          <EmptyState message="Your coach hasn't set any goals yet" />
        )}
        {goals?.map((g) => (
          <GoalCard key={g.id} goal={g} />
        ))}
      </div>
    </>
  );
}
