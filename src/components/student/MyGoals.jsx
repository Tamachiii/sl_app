import { useId, useState } from 'react';
import Spinner from '../ui/Spinner';
import { useI18n } from '../../hooks/useI18n';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useBackOr } from '../../hooks/useBackOr';
import {
  useMyGoals,
  useAddGoalProgress,
  useDeleteGoalProgress,
  useToggleGoalAchieved,
} from '../../hooks/useGoals';
import { decimalText, parseDecimalInput } from '../../lib/number';
import { formatDate, formatNumber, pluralKey } from '../../lib/i18n/format';
import { Button, ConfirmSheet, Icon, IconButton, LargeTitle, NumberField } from '../parc';
import { goalTargetText } from './goalText';

// What an attempt may hold: what `goal_progress` stores — a load of
// numeric(6,2) and whole numbers of sets and reps.
const WEIGHT_RULES = { min: 0, max: 9999.99, allowEmpty: false };
const COUNT_RULES = { min: 0, max: 999, integer: true };

function GoalCard({ goal }) {
  const ctx = useI18n();
  const { t, lang } = ctx;
  // Goal writes are not offline-queued (a client-minted progress INSERT has no
  // offline id story), so they are gated rather than left to pause silently —
  // same treatment as the bodyweight card and the video upload button.
  const isOnline = useOnlineStatus();
  const addProgress = useAddGoalProgress();
  const deleteProgress = useDeleteGoalProgress();
  const toggleAchieved = useToggleGoalAchieved();
  const notesId = useId();
  const [open, setOpen] = useState(false);
  const [weight, setWeight] = useState('');
  const [sets, setSets] = useState(goal.kind === 'format' ? decimalText(goal.target_sets) : '');
  const [reps, setReps] = useState(decimalText(goal.target_reps));
  const [notes, setNotes] = useState('');
  const [refused, setRefused] = useState(null);
  const [showAll, setShowAll] = useState(false);
  // ID of the attempt the athlete is asking to delete; null = sheet closed.
  // Not the row itself: its `goal_progress` reference goes stale once the
  // cache is refreshed after the delete.
  const [pendingDeleteId, setPendingDeleteId] = useState(null);

  const entries = [...(goal.goal_progress || [])].sort(
    (a, b) => new Date(b.recorded_at) - new Date(a.recorded_at),
  );
  const best = entries.reduce(
    (acc, e) => (Number(e.weight_kg) > Number(acc?.weight_kg ?? -Infinity) ? e : acc),
    null,
  );
  const kg = (value) => t('parcGoals.kg', { kg: formatNumber(lang, Number(value)) });
  const day = (iso) => formatDate(lang, iso, { day: 'numeric', month: 'long' });

  function handleLog(e) {
    e.preventDefault();
    const w = parseDecimalInput(weight, WEIGHT_RULES);
    const s = parseDecimalInput(sets, COUNT_RULES);
    const r = parseDecimalInput(reps, COUNT_RULES);
    if (!w.ok) return setRefused('weight');
    if (!s.ok) return setRefused('sets');
    if (!r.ok) return setRefused('reps');
    addProgress.mutate(
      // 0 sets or reps is no count: written as none, as it always was.
      { goalId: goal.id, weight_kg: w.value, sets: s.value || null, reps: r.value || null, notes: notes || null },
      {
        onSuccess: () => {
          setWeight('');
          setNotes('');
          setOpen(false);
        },
      },
    );
  }

  const shown = showAll ? entries : entries.slice(0, 8);

  return (
    <section aria-label={goal.exercise?.name} className="flex flex-col gap-3 rounded-group bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="pk-headline">{goal.exercise?.name}</h2>
          <p className="pk-caption m-0">
            {t('parcGoals.target', { what: goalTargetText(goal, ctx) })}
            {goal.achieved && (
              <>
                {', '}
                <span className="font-semibold text-blue">{t('parcGoals.achieved')}</span>
              </>
            )}
          </p>
          {goal.notes && <p className="pk-body m-0 mt-1.5 whitespace-pre-wrap">{goal.notes}</p>}
        </div>
      </div>

      {best && (
        <div className="border-t border-line pt-3">
          <p className="pk-small m-0">{t('parcGoals.best')}</p>
          <p className="m-0 flex items-baseline gap-2">
            <span className="pk-condensed pk-tnum text-[32px] font-extrabold leading-none">{kg(best.weight_kg)}</span>
            {best.sets && best.reps ? (
              <span className="pk-caption">
                {formatNumber(lang, best.sets)} × {formatNumber(lang, best.reps)}
              </span>
            ) : null}
          </p>
        </div>
      )}

      {entries.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="pk-small m-0">
            {t(pluralKey(lang, entries.length, 'parcGoals.attempts'), { n: formatNumber(lang, entries.length) })}
          </p>
          <ul className="pk-group bg-fill">
            {shown.map((e) => (
              <li key={e.id} className="pk-row">
                <span className="min-w-0 flex-1">
                  <span className="pk-body block font-semibold">
                    {kg(e.weight_kg)}
                    {e.sets && e.reps ? `, ${formatNumber(lang, e.sets)} × ${formatNumber(lang, e.reps)}` : ''}
                  </span>
                  <span className="pk-caption block">
                    {day(e.recorded_at)}
                    {e.notes ? `, ${e.notes}` : ''}
                  </span>
                </span>
                <IconButton
                  icon="close"
                  tone="none"
                  size={18}
                  onClick={() => setPendingDeleteId(e.id)}
                  disabled={!isOnline}
                  title={!isOnline ? t('common.offlineAction') : undefined}
                  label={t('student.goals.deleteAttemptAria', { when: day(e.recorded_at) })}
                />
              </li>
            ))}
          </ul>
          {!showAll && entries.length > shown.length && (
            <Button variant="text" className="self-start" onClick={() => setShowAll(true)}>
              {t('parcGoals.showAllAttempts', { n: formatNumber(lang, entries.length) })}
            </Button>
          )}
        </div>
      )}

      {open ? (
        <form onSubmit={handleLog} noValidate className="flex flex-col gap-3 border-t border-line pt-3">
          <div className="grid grid-cols-3 gap-2">
            <NumberField
              {...WEIGHT_RULES}
              label={t('parcGoals.weight')}
              value={weight}
              onChange={(e) => {
                setWeight(e.target.value);
                setRefused(null);
              }}
              error={refused === 'weight' ? t('coachDecimalInputs.goalWeightRange') : undefined}
            />
            <NumberField
              {...COUNT_RULES}
              label={t('parcGoals.sets')}
              value={sets}
              onChange={(e) => {
                setSets(e.target.value);
                setRefused(null);
              }}
              error={refused === 'sets' ? t('uiSharedHelpers.integerInvalid') : undefined}
            />
            <NumberField
              {...COUNT_RULES}
              label={t('parcGoals.reps')}
              value={reps}
              onChange={(e) => {
                setReps(e.target.value);
                setRefused(null);
              }}
              error={refused === 'reps' ? t('uiSharedHelpers.integerInvalid') : undefined}
            />
          </div>
          <label htmlFor={notesId} className="flex flex-col gap-1.5">
            <span className="pk-caption">{t('parcGoals.notes')}</span>
            <textarea
              id={notesId}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="pk-field resize-none py-2.5 leading-[1.45]"
            />
          </label>
          <div className="flex flex-col gap-1">
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={addProgress.isPending || !isOnline}
              title={!isOnline ? t('common.offlineAction') : undefined}
            >
              {addProgress.isPending ? t('parcGoals.logging') : t('parcGoals.logAttempt')}
            </Button>
            <Button variant="text" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => setOpen(true)}>
            <Icon name="plus" size={18} />
            {t('parcGoals.logAttempt')}
          </Button>
          <Button
            onClick={() => toggleAchieved.mutate({ id: goal.id, achieved: !goal.achieved })}
            disabled={!isOnline}
            title={!isOnline ? t('common.offlineAction') : undefined}
          >
            {goal.achieved ? t('parcGoals.undoAchieved') : t('parcGoals.markAchieved')}
          </Button>
        </div>
      )}

      <ConfirmSheet
        open={!!pendingDeleteId}
        onClose={() => setPendingDeleteId(null)}
        onConfirm={() => {
          if (pendingDeleteId) deleteProgress.mutate(pendingDeleteId);
        }}
        title={t('student.goals.deleteAttemptTitle')}
        message={t('student.goals.deleteAttemptMessage')}
        confirmText={t('student.goals.deleteConfirm')}
      />
    </section>
  );
}

export default function MyGoals() {
  const { t } = useI18n();
  // Back on the first entry of the tab (a link, a cold start) goes to the
  // athlete's home instead of leaving the app (L31).
  const goBack = useBackOr('/student');
  const { data: goals, isLoading } = useMyGoals();
  const back = { label: t('common.back'), onClick: goBack };

  return (
    <div className="flex flex-col gap-6 px-4 pt-3 pb-6 md:px-8">
      {/* Goals is reached from the Profile page: back where the avatar would
          be, since the avatar would lead to the page the athlete came from. */}
      <LargeTitle back={back} title={t('parcGoals.title')} />

      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : !goals || goals.length === 0 ? (
        <p className="rounded-group bg-surface p-4 pk-body">{t('parcGoals.empty')}</p>
      ) : (
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-2 lg:items-start">
          {goals.map((g) => (
            <GoalCard key={g.id} goal={g} />
          ))}
        </div>
      )}
    </div>
  );
}
