import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import { useExerciseLibrary } from '../../hooks/useExerciseLibrary';
import {
  useStudentGoals,
  useStudentProfileId,
  useCreateGoal,
  useDeleteGoal,
  formatGoalTarget,
} from '../../hooks/useGoals';

const EMPTY_FORM = {
  exerciseId: '',
  kind: 'one_rm',
  targetWeightKg: '',
  targetSets: '',
  targetReps: '1',
  notes: '',
};

const inputCls =
  'w-full rounded-lg border border-ink-200 bg-white px-3 py-2 sl-mono text-[13px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]';

function PageHeader({ onBack }) {
  return (
    <div className="flex items-start gap-3">
      <button
        onClick={onBack}
        aria-label="Back"
        className="w-9 h-9 rounded-lg bg-ink-100 flex items-center justify-center text-ink-700 hover:bg-ink-200 shrink-0"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <div className="flex-1 min-w-0">
        <div className="sl-label text-ink-400">Goals</div>
        <h1 className="sl-display text-[28px] text-gray-900 leading-none mt-1">Goals.</h1>
      </div>
    </div>
  );
}

export default function StudentGoals() {
  const navigate = useNavigate();
  const { studentId } = useParams();
  const { data: studentProfileId, isLoading: pidLoading } = useStudentProfileId(studentId);
  const { data: library } = useExerciseLibrary();
  const { data: goals, isLoading } = useStudentGoals(studentProfileId);
  const createGoal = useCreateGoal();
  const deleteGoal = useDeleteGoal();

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  function resetForm() {
    setForm(EMPTY_FORM);
    setShowForm(false);
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!form.exerciseId || !form.targetWeightKg) return;
    const payload = {
      student_id: studentProfileId,
      exercise_id: form.exerciseId,
      kind: form.kind,
      target_weight_kg: Number(form.targetWeightKg),
      target_reps: Number(form.targetReps) || 1,
      target_sets: form.kind === 'format' ? Number(form.targetSets) || null : null,
      notes: form.notes || null,
    };
    createGoal.mutate(payload, { onSuccess: resetForm });
  }

  if (pidLoading || isLoading) {
    return (
      <div className="p-4 pb-6 space-y-5">
        <PageHeader onBack={() => navigate(-1)} />
        <div className="flex justify-center py-12"><Spinner /></div>
      </div>
    );
  }

  return (
    <div className="p-4 pb-6 space-y-5">
      <PageHeader onBack={() => navigate(-1)} />

      <div className="space-y-2">
        {(!goals || goals.length === 0) && !showForm && (
          <EmptyState message="No goals set yet" />
        )}

        {goals?.map((g) => {
          const attempts = (g.goal_progress || []).length;
          return (
            <div key={g.id} className="sl-card px-4 py-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="sl-display text-[16px] text-gray-900">
                      {g.exercise?.name}
                    </span>
                    {g.achieved && (
                      <span
                        className="sl-pill inline-flex items-center gap-1"
                        style={{
                          background: 'color-mix(in srgb, var(--color-success) 18%, transparent)',
                          color: 'var(--color-ink-900)',
                        }}
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                        achieved
                      </span>
                    )}
                  </div>
                  <p className="sl-mono text-[12px] text-ink-600 mt-1">{formatGoalTarget(g)}</p>
                  {g.notes && (
                    <p className="text-[13px] text-ink-700 whitespace-pre-wrap mt-1">{g.notes}</p>
                  )}
                  <p className="sl-mono text-[11px] text-ink-400 mt-1">
                    {attempts} attempt{attempts === 1 ? '' : 's'} logged
                  </p>
                </div>
                <button
                  onClick={() => {
                    if (confirm('Delete this goal?')) deleteGoal.mutate(g.id);
                  }}
                  aria-label="Delete goal"
                  className="text-ink-400 hover:text-danger p-1 shrink-0"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          );
        })}

        {showForm ? (
          <form onSubmit={handleSubmit} className="sl-card p-4 space-y-3">
            <label className="block">
              <span className="sl-label text-ink-400 block mb-1">Exercise</span>
              <select
                value={form.exerciseId}
                onChange={(e) => setForm({ ...form, exerciseId: e.target.value })}
                className={inputCls}
                required
              >
                <option value="">Select exercise…</option>
                {(library || []).map((ex) => (
                  <option key={ex.id} value={ex.id}>
                    {ex.name} ({ex.type})
                  </option>
                ))}
              </select>
            </label>

            <fieldset className="flex gap-4 sl-mono text-[12px] text-ink-700">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="kind"
                  value="one_rm"
                  checked={form.kind === 'one_rm'}
                  onChange={(e) => setForm({ ...form, kind: e.target.value, targetReps: '1' })}
                />
                1RM
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="kind"
                  value="format"
                  checked={form.kind === 'format'}
                  onChange={(e) => setForm({ ...form, kind: e.target.value })}
                />
                Sets × reps @ weight
              </label>
            </fieldset>

            <div className="flex gap-2">
              {form.kind === 'format' && (
                <label className="flex-1">
                  <span className="sl-label text-ink-400 block mb-1">Sets</span>
                  <input
                    type="number"
                    min={1}
                    value={form.targetSets}
                    onChange={(e) => setForm({ ...form, targetSets: e.target.value })}
                    className={inputCls}
                    required
                  />
                </label>
              )}
              <label className="flex-1">
                <span className="sl-label text-ink-400 block mb-1">Reps</span>
                <input
                  type="number"
                  min={1}
                  value={form.targetReps}
                  onChange={(e) => setForm({ ...form, targetReps: e.target.value })}
                  className={inputCls}
                  required
                />
              </label>
              <label className="flex-1">
                <span className="sl-label text-ink-400 block mb-1">Weight (kg)</span>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={form.targetWeightKg}
                  onChange={(e) => setForm({ ...form, targetWeightKg: e.target.value })}
                  className={inputCls}
                  required
                />
              </label>
            </div>

            <label className="block">
              <span className="sl-label text-ink-400 block mb-1">Notes (optional)</span>
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={2}
                className={inputCls}
              />
            </label>

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={createGoal.isPending}
                className="flex-1 sl-btn-primary text-[13px] disabled:opacity-50"
                style={{ padding: '10px 16px' }}
              >
                {createGoal.isPending ? 'Saving…' : 'Save goal'}
              </button>
              <button
                type="button"
                onClick={resetForm}
                className="flex-1 sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200"
              >
                cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            onClick={() => setShowForm(true)}
            className="w-full border border-dashed border-ink-200 text-ink-400 rounded-xl py-3 sl-mono text-[12px] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors"
          >
            + ADD GOAL
          </button>
        )}
      </div>
    </div>
  );
}
