import { useMemo, useState } from 'react';
import TypeBadge from '../ui/TypeBadge';
import { Button, Row, SearchField, Sheet } from '../parc';
import { useSaveSlotDeviation, useRequestPromote } from '../../hooks/useSlotDeviations';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useI18n } from '../../hooks/useI18n';
import { isActiveExercise } from '../../hooks/useExerciseLibrary';

/**
 * The sheet that picks the exercise replacing `slot`'s: a search, and the
 * coach's library without the exercise itself. `onPick(exerciseId)` runs, then
 * the sheet closes. Opened by « Remplacer l'exercice » of the exercise's menu
 * (`ExerciseMenu`) and by « Changer » on a swap.
 *
 * The substitute is library-only (no free text) so every swap stays a known
 * exercise. `exerciseLibrary` is the coach's catalogue (athletes have read
 * access).
 */
export function SwapPickerSheet({ open, onClose, slot, exerciseLibrary, onPick }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');

  // An exercise the coach archived is not offered for new work. One already
  // swapped in keeps its name in the bar: `substituteName` reads the whole
  // library.
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (exerciseLibrary || [])
      .filter(isActiveExercise)
      .filter((e) => e.id !== slot.exercise?.id)
      .filter((e) => (q ? e.name.toLowerCase().includes(q) : true));
  }, [exerciseLibrary, slot.exercise, query]);

  function close() {
    setQuery('');
    onClose();
  }

  return (
    <Sheet open={open} onClose={close} title={t('parcSession.swapTitle')} description={t('parcSession.swapHint')}>
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
                onClick={() => {
                  onPick(ex.id);
                  close();
                }}
                title={ex.name}
                trailing={<TypeBadge type={ex.type} className="shrink-0" />}
              />
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
}

/**
 * An exercise the athlete took off the plan: replaced by another of the
 * coach's library, or skipped. One slot_deviations row per slot (swap XOR
 * skip). Says what was done, with « Changer » (a swap) and « Revenir au
 * plan », and the request to make it the plan. Draws nothing while the
 * exercise is as planned: the way off the plan is in the exercise's menu
 * (`ExerciseMenu`).
 *
 * « Revenir au plan » deletes the row, which takes back the coach's unread
 * notification (`retract_slot_deviation_notifications`) — not a push already
 * delivered.
 */
export default function SlotDeviationBar({ sessionId, slot, deviation, exerciseLibrary, locked = false }) {
  const { t } = useI18n();
  const saveDeviation = useSaveSlotDeviation();
  const requestPromote = useRequestPromote();
  const online = useOnlineStatus();
  const [pickerOpen, setPickerOpen] = useState(false);

  const kind = deviation?.kind || null;
  const promoteRequested = !!deviation?.promote_requested_at;
  const substituteName = useMemo(() => {
    if (kind !== 'swap' || !deviation?.substitute_exercise_id) return null;
    const ex = (exerciseLibrary || []).find((e) => e.id === deviation.substitute_exercise_id);
    return ex?.name || t('parcSession.anotherExercise');
  }, [kind, deviation, exerciseLibrary, t]);

  if (!kind) return null;

  function applySwap(exerciseId) {
    saveDeviation.mutate({ sessionId, slotId: slot.id, kind: 'swap', substituteExerciseId: exerciseId });
  }

  function clearDeviation() {
    saveDeviation.mutate({ sessionId, slotId: slot.id, kind: null });
  }

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
      {isSwap && (
        <SwapPickerSheet
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          slot={slot}
          exerciseLibrary={exerciseLibrary}
          onPick={applySwap}
        />
      )}
    </section>
  );
}
