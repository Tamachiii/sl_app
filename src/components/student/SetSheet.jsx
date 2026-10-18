import { useState } from 'react';
import { useI18n } from '../../hooks/useI18n';
import { decimalText, parseDecimalInput } from '../../lib/number';
import { Button, NumberField, Sheet } from '../parc';
import RpeChoices from './RpeChoices';
import VideoUploadButton from './VideoUploadButton';
import { ACTUAL_REPS_RULES, ACTUAL_WEIGHT_RULES, extraValuesComplete } from './useSetActions';

const NO_REPS = { ok: true, value: null };

/**
 * The inside of a set's sheet while it is open: what was done, the rating,
 * and the other things a set can be — skipped, not failed after all, removed,
 * filmed. Built when the sheet opens, so its fields start from the set as it
 * is (`actions.editorSeed()`) every time.
 */
function SetSheetBody({ log, actions, locked, online, recordVideo, video, onDone, onNeedRpe }) {
  const { t } = useI18n();
  const { repsApplies, isExtra, pending, failed } = actions;
  const [reps, setReps] = useState(() => (repsApplies ? decimalText(actions.editorSeed().reps) : ''));
  const [weight, setWeight] = useState(() => decimalText(actions.editorSeed().weightKg));
  const [needsValues, setNeedsValues] = useState(false);

  // What the fields hold, read as typed: "82,5" and "82.5" are 82.5 in every
  // browser (P31). Text that is not a number is refused, not read as an empty
  // field: empty is "as prescribed" on a set the coach wrote — which wiped the
  // actual it held — and no load (0 kg) on a swapped or extra set. An extra set
  // saves only once its fields say what was done.
  const repsInput = repsApplies ? parseDecimalInput(reps, ACTUAL_REPS_RULES) : NO_REPS;
  const weightInput = parseDecimalInput(weight, ACTUAL_WEIGHT_RULES);
  const typedInvalid = !repsInput.ok || !weightInput.ok;
  const typedReps = repsInput.ok ? repsInput.value : null;
  const typedWeight = weightInput.ok ? weightInput.value : null;
  const typedIncomplete =
    !typedInvalid &&
    isExtra &&
    !extraValuesComplete({ reps: typedReps, weightKg: typedWeight, durationBased: !repsApplies });
  const incompleteText = t(repsApplies ? 'parcSession.extraNeedsRepsAndLoad' : 'parcSession.extraNeedsLoad');

  // Nothing is written while a field says something the editor cannot read:
  // the sheet stays open on the text, with the message under the field.
  function save() {
    if (typedInvalid || typedIncomplete) return;
    const next = actions.saveActual(typedReps, typedWeight);
    if (next === 'rpe') onNeedRpe();
    else onDone();
  }

  function rate(rpe) {
    if (actions.rate(rpe) === 'values') {
      setNeedsValues(true);
      return;
    }
    onDone();
  }

  if (locked) {
    return recordVideo ? (
      <VideoUploadButton
        setLogId={log.id}
        exerciseSlotId={log.exercise_slot_id}
        setNumber={log.set_number}
        existingVideo={video}
        disabled
      />
    ) : null;
  }

  if (log.skipped) {
    return (
      <div className="flex flex-col gap-4">
        <p className="pk-body">{t('parcSession.skippedSet')}</p>
        <Button
          variant="primary"
          size="lg"
          onClick={() => {
            actions.unskip();
            onDone();
          }}
        >
          {t('parcSession.unskipSet')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <div className={`grid gap-3 ${repsApplies ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {repsApplies && (
            <NumberField
              {...ACTUAL_REPS_RULES}
              size="lg"
              label={t('parcSession.repsField')}
              value={reps}
              onChange={(event) => setReps(event.target.value)}
              error={!repsInput.ok ? t('uiSharedHelpers.integerInvalid') : undefined}
            />
          )}
          <NumberField
            {...ACTUAL_WEIGHT_RULES}
            size="lg"
            label={t('parcSession.loadField')}
            value={weight}
            onChange={(event) => setWeight(event.target.value)}
            error={repsInput.ok && !weightInput.ok ? t('uiSharedHelpers.decimalInvalid') : undefined}
          />
        </div>
        {(typedIncomplete || needsValues) && (
          <p className="pk-caption" role="status">
            {incompleteText}
          </p>
        )}
        <Button variant="primary" size="lg" onClick={save} disabled={typedInvalid || typedIncomplete}>
          {pending ? t('parcSession.validateSet', { n: log.set_number }) : t('parcSession.save')}
        </Button>
        {/* A done extra set keeps what it says it was. */}
        {actions.loggedActual && !(isExtra && log.done) && (
          <Button
            variant="text"
            className="self-start"
            onClick={() => {
              actions.clearActual();
              onDone();
            }}
          >
            {t('parcSession.backToTarget')}
          </Button>
        )}
      </div>

      {!failed && (
        <div className="flex flex-col gap-2.5">
          <span className="pk-small">{t('parcSession.rpeLabel')}</span>
          <RpeChoices value={log.rpe} onChange={rate} />
        </div>
      )}

      {recordVideo && (
        <div className="flex flex-col gap-2.5">
          <span className="pk-small">{t('parcSession.videoLabel')}</span>
          <VideoUploadButton
            setLogId={log.id}
            exerciseSlotId={log.exercise_slot_id}
            setNumber={log.set_number}
            existingVideo={video}
          />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {failed && (
          <Button
            onClick={() => {
              actions.clearFailed();
              onDone();
            }}
          >
            {t('parcSession.clearFailed')}
          </Button>
        )}
        {!isExtra && (
          <Button
            onClick={() => {
              actions.skip();
              onDone();
            }}
          >
            {t('parcSession.skipSet')}
          </Button>
        )}
        {isExtra && online && (
          <Button
            className="text-red"
            disabled={actions.removing}
            onClick={() => {
              actions.removeExtra();
              onDone();
            }}
          >
            {t('parcSession.removeSet')}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The sheet of one set, opened by a tap on its row (design/parc/components/
 * SetRow): the actual value, the RPE, and the set's other actions. Mounted
 * per set (`key` = the set's id) by SessionView; `actions` is that set's
 * `useSetActions`. `onNeedRpe` opens the RPE sheet once a pending set was
 * saved as done; `onClose` closes this one.
 */
export default function SetSheet({ open, log, title, actions, locked, online, recordVideo, video, onClose, onNeedRpe }) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {log && actions && (
        <SetSheetBody
          log={log}
          actions={actions}
          locked={locked}
          online={online}
          recordVideo={recordVideo}
          video={video}
          onDone={onClose}
          onNeedRpe={onNeedRpe}
        />
      )}
    </Sheet>
  );
}
