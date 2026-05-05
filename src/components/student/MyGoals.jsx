import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import { useI18n } from '../../hooks/useI18n';
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
    <div className="sl-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="sl-display text-[18px] text-gray-900">{goal.exercise?.name}</span>
            {goal.achieved && (
              <span
                className="sl-pill inline-flex items-center gap-1"
                style={{ background: 'var(--color-success)', color: 'var(--color-ink-900)' }}
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
                achieved
              </span>
            )}
          </div>
          <p className="sl-mono text-[11px] text-ink-400 mt-1">TARGET · {formatGoalTarget(goal)}</p>
          {goal.notes && (
            <p className="text-[13px] text-gray-700 whitespace-pre-wrap mt-1.5 leading-snug">{goal.notes}</p>
          )}
        </div>
        <button
          onClick={() =>
            toggleAchieved.mutate({ id: goal.id, achieved: !goal.achieved })
          }
          className={`sl-pill shrink-0 ${
            goal.achieved
              ? 'bg-ink-100 text-ink-500 hover:bg-ink-200'
              : ''
          }`}
          style={
            goal.achieved
              ? undefined
              : { background: 'var(--color-accent)', color: 'var(--color-ink-900)' }
          }
        >
          {goal.achieved ? 'undo' : 'mark achieved'}
        </button>
      </div>

      {entries.length > 0 && (
        <div className="border-t border-ink-100 pt-3">
          <p className="sl-label text-ink-400 mb-1">Best so far</p>
          <p className="sl-display text-[20px] text-gray-900 tabular-nums">
            {best.weight_kg}kg
            {best.sets && best.reps ? (
              <span className="sl-mono text-[12px] text-ink-400 ml-2">
                {best.sets} × {best.reps}
              </span>
            ) : null}
          </p>
          <details className="mt-2">
            <summary className="sl-mono text-[11px] text-ink-400 cursor-pointer hover:text-gray-700">
              {entries.length} attempt{entries.length === 1 ? '' : 's'}
            </summary>
            <ul className="mt-2 space-y-1">
              {entries.slice(0, 8).map((e) => (
                <li key={e.id} className="sl-mono text-[11px] text-gray-700 flex justify-between gap-2">
                  <span className="truncate">
                    {e.weight_kg}kg
                    {e.sets && e.reps ? ` — ${e.sets} × ${e.reps}` : ''}
                    {e.notes ? ` · ${e.notes}` : ''}
                  </span>
                  <span className="text-ink-400 shrink-0 tabular-nums">
                    {new Date(e.recorded_at).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {open ? (
        <form onSubmit={handleLog} className="border-t border-ink-100 pt-3 space-y-2">
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="sl-label text-ink-400 block mb-1">Weight (kg)</span>
              <input
                type="number"
                min={0}
                step={0.5}
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                required
                className="w-full rounded-lg border border-ink-200 bg-white px-2 py-1.5 sl-mono text-[16px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              />
            </label>
            <label className="flex-1">
              <span className="sl-label text-ink-400 block mb-1">Sets</span>
              <input
                type="number"
                min={0}
                value={sets}
                onChange={(e) => setSets(e.target.value)}
                className="w-full rounded-lg border border-ink-200 bg-white px-2 py-1.5 sl-mono text-[16px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              />
            </label>
            <label className="flex-1">
              <span className="sl-label text-ink-400 block mb-1">Reps</span>
              <input
                type="number"
                min={0}
                value={reps}
                onChange={(e) => setReps(e.target.value)}
                className="w-full rounded-lg border border-ink-200 bg-white px-2 py-1.5 sl-mono text-[16px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              />
            </label>
          </div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes (optional)"
            rows={2}
            className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-[16px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={addProgress.isPending}
              className="flex-1 sl-btn-primary text-[13px] disabled:opacity-50"
              style={{ padding: '10px 16px' }}
            >
              {addProgress.isPending ? 'Logging…' : 'Log attempt'}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="flex-1 bg-ink-100 text-ink-700 rounded-lg py-2 sl-display text-[13px] hover:bg-ink-200"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="w-full sl-mono text-[11px] rounded-lg py-2 hover:bg-ink-50 transition-colors"
          style={{
            border: '1px solid color-mix(in srgb, var(--color-accent) 40%, transparent)',
            color: 'var(--color-accent)',
          }}
        >
          + LOG ATTEMPT
        </button>
      )}
    </div>
  );
}

export default function MyGoals() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { data: goals, isLoading } = useMyGoals();

  if (isLoading) {
    return (
      <div className="p-4">
        <h1 className="sr-only">My Goals</h1>
        <div className="flex justify-center py-12"><Spinner /></div>
      </div>
    );
  }

  return (
    <div className="p-4 pb-6 md:p-8 space-y-4">
      {/* Goals is no longer a bottom-nav tab — it's reached from the Profile
          page. So the right-hand slot mirrors Profile's: a back button in
          the avatar's spot rather than UserMenu, since avatar→profile from
          here would land on the page the user just came from. */}
      <div className="pt-3 pb-1 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="sl-label text-ink-400">Milestones</div>
          <h1 className="sl-display text-[32px] md:text-[44px] text-gray-900 leading-none mt-1">Goals.</h1>
        </div>
        <button
          type="button"
          onClick={() => navigate(-1)}
          aria-label={t('common.back')}
          className="w-10 h-10 rounded-full bg-ink-100 flex items-center justify-center text-ink-700 hover:brightness-95 active:scale-95 transition-transform shrink-0"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      </div>

      {(!goals || goals.length === 0) && (
        <EmptyState message="Your coach hasn't set any goals yet" />
      )}
      <div className="space-y-3">
        {goals?.map((g) => (
          <GoalCard key={g.id} goal={g} />
        ))}
      </div>
    </div>
  );
}
