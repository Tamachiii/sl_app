import { useState } from 'react';
import { ConfirmSheet } from '../parc';
import { useSaveSlotDeviation } from '../../hooks/useSlotDeviations';
import { useI18n } from '../../hooks/useI18n';
import ActionMenu from './ActionMenu';
import { SwapPickerSheet } from './SlotDeviationBar';

/**
 * The « ⋯ » of the exercise shown, at the right of its name in the panel: the
 * athlete's way off the plan on it — replace it by another exercise of the
 * coach's library, skip it — and the note for the coach.
 *
 * `canDeviate`: the exercise is as planned and its sets can still change; once
 * it is replaced or skipped, `SlotDeviationBar` says so and holds the way
 * back. `canNote`: the note can be written; `hasNote` names the item « Modifier
 * la note »; `onNote` opens the note's field.
 *
 * Skip asks first (L12): a new deviation notifies the coach, bell and push, as
 * soon as it is written (`notify_coach_on_slot_deviation`, AFTER INSERT). The
 * sheet says the coach will be told.
 */
export default function ExerciseMenu({
  sessionId,
  slot,
  name,
  exerciseLibrary,
  canDeviate,
  canNote,
  hasNote,
  onNote,
  className,
}) {
  const { t } = useI18n();
  const saveDeviation = useSaveSlotDeviation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [skipAsked, setSkipAsked] = useState(false);

  const items = [];
  if (canDeviate) {
    items.push(
      { key: 'swap', icon: 'swap', title: t('sessionMenus.replaceExercise'), onSelect: () => setPickerOpen(true) },
      { key: 'skip', icon: 'skip', title: t('sessionMenus.skipExercise'), onSelect: () => setSkipAsked(true) },
    );
  }
  if (canNote) {
    items.push({
      key: 'note',
      icon: 'note',
      title: hasNote ? t('parcSession.editNote') : t('parcSession.addNote'),
      onSelect: onNote,
    });
  }

  const exerciseName = slot.exercise?.name;
  return (
    <>
      <ActionMenu
        label={t('sessionMenus.exerciseOptions')}
        title={name}
        items={items}
        tone="fill"
        className={className}
      />
      {/* Drawn whatever `canDeviate` says: the choice that makes it false is
          made in them, and they close the way a sheet does. */}
      <SwapPickerSheet
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        slot={slot}
        exerciseLibrary={exerciseLibrary}
        onPick={(exerciseId) =>
          saveDeviation.mutate({ sessionId, slotId: slot.id, kind: 'swap', substituteExerciseId: exerciseId })
        }
      />
      <ConfirmSheet
        open={skipAsked}
        onClose={() => setSkipAsked(false)}
        onConfirm={() => saveDeviation.mutate({ sessionId, slotId: slot.id, kind: 'skip' })}
        title={
          exerciseName
            ? t('parcSession.skipExerciseTitle', { name: exerciseName })
            : t('parcSession.skipExerciseTitleNoName')
        }
        message={t('parcSession.skipExerciseMessage')}
        confirmText={t('parcSession.skipExerciseConfirm')}
        cancelText={t('parcSession.skipExerciseKeep')}
        isDestructive={false}
      />
    </>
  );
}
