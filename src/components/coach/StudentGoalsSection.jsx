import { useId, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import DecimalInput from '../ui/DecimalInput';
import { parseDecimalInput } from '../../lib/number';
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

// What a goal's weight may be: what `goals.target_weight_kg` holds, a
// numeric(6,2), NOT NULL. 0 is a goal too — a bodyweight movement.
const GOAL_WEIGHT_RULES = { max: 9999.99, allowEmpty: false };

const inputCls =
  'w-full rounded-lg border border-ink-200 bg-white px-3 py-2 sl-mono text-[16px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]';

export default function StudentGoalsSection() {
  const { student } = useOutletContext();
  const studentId = student.id;
  const { t } = useI18n();
  const { data: studentProfileId, isLoading: pidLoading } = useStudentProfileId(studentId);
  const { data: library } = useExerciseLibrary();
  const { data: goals, isLoading } = useStudentGoals(studentProfileId);
  const createGoal = useCreateGoal();
  const deleteGoal = useDeleteGoal();

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [weightRefused, setWeightRefused] = useState(false);
  const weightErrId = useId();

  function resetForm() {
    setForm(EMPTY_FORM);
    setWeightRefused(false);
    setShowForm(false);
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!form.exerciseId) return;
    // "62,5" is 62.5 whatever the language of the browser (L9): a number field
    // read it as 625, or as "" — which `required` then refused as a field left
    // empty. Text that is not a number is stopped by the field's `pattern`
    // before this runs; a number out of the range is stopped here.
    const weight = parseDecimalInput(form.targetWeightKg, GOAL_WEIGHT_RULES);
    if (!weight.ok) {
      setWeightRefused(true);
      return;
    }
    const payload = {
      student_id: studentProfileId,
      exercise_id: form.exerciseId,
      kind: form.kind,
      target_weight_kg: weight.value,
      target_reps: Number(form.targetReps) || 1,
      target_sets: form.kind === 'format' ? Number(form.targetSets) || null : null,
      notes: form.notes || null,
    };
    createGoal.mutate(payload, { onSuccess: resetForm });
  }

  if (pidLoading || isLoading) {
    return <div className="flex justify-center py-6"><Spinner /></div>;
  }

  return (
    <div className="space-y-2">
      {(!goals || goals.length === 0) && !showForm && (
        <EmptyState message={t('coach.home.noGoals')} compact />
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
                      className="sl-pill inline-flex items-center gap-1 text-ink-900"
                      style={{
                        background: 'color-mix(in srgb, var(--color-success) 18%, transparent)',
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
              <DecimalInput
                {...GOAL_WEIGHT_RULES}
                value={form.targetWeightKg}
                onChange={(e) => {
                  setForm({ ...form, targetWeightKg: e.target.value });
                  setWeightRefused(false);
                }}
                invalid={weightRefused}
                aria-describedby={weightRefused ? weightErrId : undefined}
                className={inputCls}
                required
              />
            </label>
          </div>
          {weightRefused && (
            <p id={weightErrId} role="alert" className="sl-mono text-[11px] text-danger">
              {t('coachDecimalInputs.goalWeightRange')}
            </p>
          )}

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
          {t('coach.home.addGoal')}
        </button>
      )}
    </div>
  );
}
