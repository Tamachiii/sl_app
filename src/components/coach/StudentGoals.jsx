import { useState } from 'react';
import { useParams } from 'react-router-dom';
import Header from '../layout/Header';
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

export default function StudentGoals() {
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
      <>
        <Header title="Goals" showBack />
        <div className="flex justify-center py-12"><Spinner /></div>
      </>
    );
  }

  return (
    <>
      <Header title="Goals" showBack />
      <div className="p-4 space-y-3">
        {(!goals || goals.length === 0) && !showForm && (
          <EmptyState message="No goals set yet" />
        )}

        {goals?.map((g) => (
          <div key={g.id} className="bg-white rounded-xl shadow-sm p-4 space-y-1">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-gray-900">{g.exercise?.name}</span>
                  {g.achieved && (
                    <span className="flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-1.5 py-0.5 rounded">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                      </svg>
                      Achieved
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-600">{formatGoalTarget(g)}</p>
                {g.notes && (
                  <p className="text-xs text-gray-500 whitespace-pre-wrap mt-0.5">{g.notes}</p>
                )}
                <p className="text-xs text-gray-400 mt-1">
                  {(g.goal_progress || []).length} attempt{(g.goal_progress || []).length === 1 ? '' : 's'} logged
                </p>
              </div>
              <button
                onClick={() => {
                  if (confirm('Delete this goal?')) deleteGoal.mutate(g.id);
                }}
                aria-label="Delete goal"
                className="p-1 text-gray-400 hover:text-danger"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        ))}

        {showForm ? (
          <form
            onSubmit={handleSubmit}
            className="bg-white rounded-xl shadow-sm p-4 space-y-3"
          >
            <label className="block">
              <span className="text-xs text-gray-600 block mb-1">Exercise</span>
              <select
                value={form.exerciseId}
                onChange={(e) => setForm({ ...form, exerciseId: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
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

            <fieldset className="flex gap-3 text-sm">
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
                  <span className="text-xs text-gray-600 block mb-1">Sets</span>
                  <input
                    type="number"
                    min={1}
                    value={form.targetSets}
                    onChange={(e) => setForm({ ...form, targetSets: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                    required
                  />
                </label>
              )}
              <label className="flex-1">
                <span className="text-xs text-gray-600 block mb-1">Reps</span>
                <input
                  type="number"
                  min={1}
                  value={form.targetReps}
                  onChange={(e) => setForm({ ...form, targetReps: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                  required
                />
              </label>
              <label className="flex-1">
                <span className="text-xs text-gray-600 block mb-1">Weight (kg)</span>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={form.targetWeightKg}
                  onChange={(e) => setForm({ ...form, targetWeightKg: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                  required
                />
              </label>
            </div>

            <label className="block">
              <span className="text-xs text-gray-600 block mb-1">Notes (optional)</span>
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={2}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </label>

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={createGoal.isPending}
                className="flex-1 bg-primary text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50"
              >
                {createGoal.isPending ? 'Saving…' : 'Save goal'}
              </button>
              <button
                type="button"
                onClick={resetForm}
                className="flex-1 bg-gray-100 text-gray-600 rounded-lg py-2 text-sm font-medium"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            onClick={() => setShowForm(true)}
            className="w-full border-2 border-dashed border-gray-300 text-gray-400 rounded-xl py-3 text-sm font-medium hover:border-primary hover:text-primary transition-colors"
          >
            + Add Goal
          </button>
        )}
      </div>
    </>
  );
}
