import { useMemo, useState } from 'react';
import TypeBadge from '../ui/TypeBadge';
import { Button, ConfirmSheet, Row, SearchField, Sheet } from '../parc';
import { useSaveSlotDeviation, useRequestPromote } from '../../hooks/useSlotDeviations';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useI18n } from '../../hooks/useI18n';
import { isActiveExercise } from '../../hooks/useExerciseLibrary';

/**
 * The athlete's way off the plan on one exercise: replace it by another of the
 * coach's library, or skip it. One slot_deviations row per slot (swap XOR
 * skip). Shows the current state with its way back, or « Remplacer » and
 * « Sauter » while the exercise is as planned.
 *
 * The substitute is library-only (no free text) so every swap stays a known
 * exercise. `exerciseLibrary` is the coach's catalogue (athletes have read
 * access); the substitute's name is read from it.
 *
 * Skip asks first (L12): a new deviation notifies the coach, bell and push, as
 * soon as it is written (`notify_coach_on_slot_deviation`, AFTER INSERT). The
 * sheet says the coach will be told. « Revenir au plan » deletes the row,
 * which takes back the coach's unread notification
 * (`retract_slot_deviation_notifications`) — not a push already delivered.
 */
export default function SlotDeviationBar({ sessionId, slot, deviation, exerciseLibrary, locked = false }) {
  const { t } = useI18n();
  const saveDeviation = useSaveSlotDeviation();
  const requestPromote = useRequestPromote();
  const online = useOnlineStatus();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [skipAsked, setSkipAsked] = useState(false);
  const [query, setQuery] = useState('');

  const kind = deviation?.kind || null;
  const promoteRequested = !!deviation?.promote_requested_at;
  const substituteName = useMemo(() => {
    if (kind !== 'swap' || !deviation?.substitute_exercise_id) return null;
    const ex = (exerciseLibrary || []).find((e) => e.id === deviation.substitute_exercise_id);
    return ex?.name || t('parcSession.anotherExercise');
  }, [kind, deviation, exerciseLibrary, t]);

  // An exercise the coach archived is not offered for new work. One already
  // swapped in keeps its name above: `substituteName` reads the whole library.
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (exerciseLibrary || [])
      .filter(isActiveExercise)
      .filter((e) => e.id !== slot.exercise?.id)
      .filter((e) => (q ? e.name.toLowerCase().includes(q) : true));
  }, [exerciseLibrary, slot.exercise, query]);

  function applySwap(exerciseId) {
    saveDeviation.mutate({ sessionId, slotId: slot.id, kind: 'swap', substituteExerciseId: exerciseId });
    setPickerOpen(false);
    setQuery('');
  }

  function applySkip() {
    saveDeviation.mutate({ sessionId, slotId: slot.id, kind: 'skip' });
  }

  function clearDeviation() {
    saveDeviation.mutate({ sessionId, slotId: slot.id, kind: null });
  }

  const picker = (
    <Sheet
      open={pickerOpen}
      onClose={() => setPickerOpen(false)}
      title={t('parcSession.swapTitle')}
      description={t('parcSession.swapHint')}
    >
      <div className="flex flex-col gap-3">
        <SearchField
          label={t('parcSession.swapSearch')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {candidates.length === 0 ? (
          <p className="pk-caption py-4 text-center">{t('parcSession.swapEmpty')}</p>
        ) : (
          <ul className="pk-group p-0">
            {candidates.map((ex) => (
              <Row
                key={ex.id}
                onClick={() => applySwap(ex.id)}
                title={ex.name}
                trailing={<TypeBadge type={ex.type} className="shrink-0" />}
              />
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );

  // A swap or a skip: what it is, and the way back.
  if (kind) {
    const isSwap = kind === 'swap';
    return (
      <section className="flex flex-col gap-3 rounded-group bg-amber-soft p-4">
        <p className="pk-body text-ink">
          {isSwap ? t('parcSession.swappedTo', { name: substituteName }) : t('parcSession.exerciseSkippedByYou')}
        </p>
        {!locked && (
          <div className="flex flex-wrap gap-2">
            {isSwap && (
              <Button variant="on-ground" onClick={() => setPickerOpen(true)}>
                {t('parcSession.changeSwap')}
              </Button>
            )}
            <Button variant="on-ground" onClick={clearDeviation}>
              {t('parcSession.backToPlan')}
            </Button>
          </div>
        )}
        {/* Phase 3.3: ask the coach to make this deviation the standing plan. */}
        {promoteRequested ? (
          <p className="pk-caption text-ink">{t('parcSession.promoteAsked')}</p>
        ) : !locked && online ? (
          <Button
            variant="text"
            className="self-start text-left"
            onClick={() => requestPromote.mutate({ sessionId, slotId: slot.id })}
            disabled={requestPromote.isPending}
          >
            {t('parcSession.promoteAsk')}
          </Button>
        ) : null}
        {isSwap && picker}
      </section>
    );
  }

  if (locked) return null;

  const name = slot.exercise?.name;
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="on-ground" onClick={() => setPickerOpen(true)}>
        {t('parcSession.swap')}
      </Button>
      <Button variant="on-ground" onClick={() => setSkipAsked(true)}>
        {t('parcSession.skipExercise')}
      </Button>
      {picker}
      <ConfirmSheet
        open={skipAsked}
        onClose={() => setSkipAsked(false)}
        onConfirm={applySkip}
        title={name ? t('parcSession.skipExerciseTitle', { name }) : t('parcSession.skipExerciseTitleNoName')}
        message={t('parcSession.skipExerciseMessage')}
        confirmText={t('parcSession.skipExerciseConfirm')}
        cancelText={t('parcSession.skipExerciseKeep')}
        isDestructive={false}
      />
    </div>
  );
}
