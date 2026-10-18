import { useId, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import Spinner from '../ui/Spinner';
import { parseDecimalInput } from '../../lib/number';
import { exerciseTypeLabel } from '../../lib/exerciseTypes';
import { formatNumber, pluralKey } from '../../lib/i18n/format';
import { useExerciseLibrary, isActiveExercise } from '../../hooks/useExerciseLibrary';
import {
  useStudentGoals,
  useStudentProfileId,
  useCreateGoal,
  useDeleteGoal,
} from '../../hooks/useGoals';
import { Button, ConfirmSheet, Icon, IconButton, NumberField, SegmentedControl, SelectField } from '../parc';
import { goalTargetText } from '../student/goalText';

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
// Its sets and reps: whole numbers, one at least.
const COUNT_RULES = { min: 1, max: 999, integer: true, allowEmpty: false };

/**
 * The goals of one athlete, in the coach's athlete page (no mock): a card per
 * goal — the exercise, the target, achieved in blue, the notes, how many
 * attempts the athlete logged, and its delete behind a question —, then the
 * form of a new goal.
 */
export default function StudentGoalsSection() {
  const { student } = useOutletContext();
  const studentId = student.id;
  const ctx = useI18n();
  const { t, lang } = ctx;
  const { data: studentProfileId, isLoading: pidLoading } = useStudentProfileId(studentId);
  const { data: library } = useExerciseLibrary();
  const { data: goals, isLoading } = useStudentGoals(studentProfileId);
  const createGoal = useCreateGoal();
  const deleteGoal = useDeleteGoal();
  const notesId = useId();

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [refused, setRefused] = useState(null);
  const [deleting, setDeleting] = useState(null);

  function resetForm() {
    setForm(EMPTY_FORM);
    setRefused(null);
    setShowForm(false);
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!form.exerciseId) return;
    // "62,5" is 62.5 whatever the language of the browser (L9): a number field
    // read it as 625, or as "".
    const weight = parseDecimalInput(form.targetWeightKg, GOAL_WEIGHT_RULES);
    if (!weight.ok) return setRefused('weight');
    const reps = parseDecimalInput(form.targetReps, COUNT_RULES);
    if (!reps.ok) return setRefused('reps');
    let sets = null;
    if (form.kind === 'format') {
      const parsed = parseDecimalInput(form.targetSets, COUNT_RULES);
      if (!parsed.ok) return setRefused('sets');
      sets = parsed.value;
    }
    const payload = {
      student_id: studentProfileId,
      exercise_id: form.exerciseId,
      kind: form.kind,
      target_weight_kg: weight.value,
      target_reps: reps.value,
      target_sets: sets,
      notes: form.notes || null,
    };
    createGoal.mutate(payload, { onSuccess: resetForm });
  }

  if (pidLoading || isLoading) {
    return <div className="flex justify-center py-6"><Spinner /></div>;
  }

  const set = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setRefused(null);
  };

  return (
    <div className="flex flex-col gap-3">
      {(!goals || goals.length === 0) && !showForm && (
        <p className="rounded-group bg-surface p-4 pk-body">{t('parcGoals.coachEmpty')}</p>
      )}

      {goals?.map((g) => {
        const attempts = (g.goal_progress || []).length;
        return (
          <section key={g.id} aria-label={g.exercise?.name} className="flex items-start gap-2 rounded-group bg-surface p-4">
            <div className="min-w-0 flex-1">
              <h2 className="pk-headline">{g.exercise?.name}</h2>
              <p className="pk-caption m-0">
                {t('parcGoals.target', { what: goalTargetText(g, ctx) })}
                {g.achieved && (
                  <>
                    {', '}
                    <span className="font-semibold text-blue">{t('parcGoals.achieved')}</span>
                  </>
                )}
              </p>
              {g.notes && <p className="pk-body m-0 mt-1 whitespace-pre-wrap">{g.notes}</p>}
              <p className="pk-small m-0 mt-1">
                {t(pluralKey(lang, attempts, 'parcGoals.attempts'), { n: formatNumber(lang, attempts) })}
              </p>
            </div>
            <IconButton
              icon="close"
              tone="none"
              onClick={() => setDeleting(g)}
              label={t('parcGoals.deleteLabel', { name: g.exercise?.name ?? '' })}
            />
          </section>
        );
      })}

      {showForm ? (
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4 rounded-group bg-surface p-4">
          <SelectField
            label={t('parcGoals.exercise')}
            value={form.exerciseId}
            onChange={(e) => set({ exerciseId: e.target.value })}
            required
          >
            <option value="">{t('parcGoals.chooseExercise')}</option>
            {/* No new goal on an archived exercise; the goals already set on
                one keep it (each goal embeds its exercise). */}
            {(library || []).filter(isActiveExercise).map((ex) => (
              <option key={ex.id} value={ex.id}>
                {t('parcGoals.exerciseOption', { name: ex.name, type: exerciseTypeLabel(ex.type, t) })}
              </option>
            ))}
          </SelectField>

          <SegmentedControl
            label={t('parcGoals.kind')}
            value={form.kind}
            onChange={(kind) => set(kind === 'one_rm' ? { kind, targetReps: '1' } : { kind })}
            options={[
              { value: 'one_rm', label: t('parcGoals.kindOneRm') },
              { value: 'format', label: t('parcGoals.kindFormat') },
            ]}
          />

          <div className={`grid gap-2 ${form.kind === 'format' ? 'grid-cols-3' : 'grid-cols-2'}`}>
            {form.kind === 'format' && (
              <NumberField
                {...COUNT_RULES}
                label={t('parcGoals.sets')}
                value={form.targetSets}
                onChange={(e) => set({ targetSets: e.target.value })}
                error={refused === 'sets' ? t('uiSharedHelpers.integerInvalid') : undefined}
              />
            )}
            <NumberField
              {...COUNT_RULES}
              label={t('parcGoals.reps')}
              value={form.targetReps}
              onChange={(e) => set({ targetReps: e.target.value })}
              error={refused === 'reps' ? t('uiSharedHelpers.integerInvalid') : undefined}
            />
            <NumberField
              {...GOAL_WEIGHT_RULES}
              label={t('parcGoals.weight')}
              value={form.targetWeightKg}
              onChange={(e) => set({ targetWeightKg: e.target.value })}
              error={refused === 'weight' ? t('coachDecimalInputs.goalWeightRange') : undefined}
            />
          </div>

          <label htmlFor={notesId} className="flex flex-col gap-1.5">
            <span className="pk-caption">{t('parcGoals.notes')}</span>
            <textarea
              id={notesId}
              value={form.notes}
              onChange={(e) => set({ notes: e.target.value })}
              rows={2}
              className="pk-field resize-none py-2.5 leading-[1.45]"
            />
          </label>

          <div className="flex flex-col gap-1">
            <Button type="submit" variant="primary" size="lg" disabled={createGoal.isPending || !form.exerciseId}>
              {createGoal.isPending ? t('common.saving') : t('parcGoals.save')}
            </Button>
            <Button variant="text" onClick={resetForm}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="text" className="self-start" onClick={() => setShowForm(true)}>
          <Icon name="plus" size={18} />
          {t('parcGoals.addGoal')}
        </Button>
      )}

      <ConfirmSheet
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) deleteGoal.mutate(deleting.id);
        }}
        title={t('parcGoals.deleteTitle')}
        message={t('parcGoals.deleteMessage')}
        confirmText={t('parcGoals.deleteAction')}
      />
    </div>
  );
}
