import { useId } from 'react';
import { useI18n } from '../../hooks/useI18n';
import { formatNumber, pluralKey } from '../../lib/i18n/format';
import { formatRpe } from '../../lib/rpe';
import { Button, CoachNote, SetPanel, SetRow } from '../parc';
import SlotCommentBox from './SlotCommentBox';
import SlotDeviationBar from './SlotDeviationBar';
import { useSetActions } from './useSetActions';
import {
  actualText,
  capitalize,
  currentLogOf,
  lastTimeText,
  loadText,
  restText,
  sharedRest,
  targetText,
} from './sessionModel';

// The name of a slot's exercise. The session read embeds the library row, and
// row-level security hides a row the athlete may not read — an exercise of a
// former coach's library — which leaves `exercise` null. The screen says so
// instead of throwing on `.name` (B8, the athlete's half).
export function exerciseNameOf(slot, t) {
  return slot.exercise?.name ?? t('sessionNavPastReview.exerciseUnavailable');
}

// The two figures of the panel for `log`: the reps (or the seconds of a hold)
// and the load, from what the set's editor would open with (`seed`), else the
// set's targets.
function panelFigures(log, seed, { durationBased, loadMode, t, lang }) {
  if (!log) return {};
  let primary;
  if (durationBased) {
    const seconds = log.target_duration_seconds;
    primary = {
      value: seconds == null ? '–' : formatNumber(lang, seconds),
      unit: t(pluralKey(lang, seconds ?? 0, 'parcSession.unitSecond')),
    };
  } else {
    const reps = seed?.reps ?? log.target_reps ?? null;
    primary = {
      value: reps == null ? '–' : formatNumber(lang, reps),
      unit: t(pluralKey(lang, reps ?? 0, 'parcSession.unitRep')),
    };
  }
  const weight = seed?.weightKg ?? log.target_weight_kg ?? null;
  const kg = weight == null ? 0 : Number(weight);
  const secondary =
    kg > 0
      ? {
          value: formatNumber(lang, kg),
          unit: t(loadMode === 'full' ? 'parcSession.unitKg' : 'parcSession.unitKgAdded'),
        }
      : { value: t('parcSession.bodyweightShort'), unit: t('parcSession.bodyweight') };
  return { primary, secondary };
}

/**
 * One row of the list of sets: its state drawn by the Parc SetRow, a tap that
 * opens the set's sheet (`onOpen`) and a press of 500 ms that marks it failed,
 * with « Annuler » in a toast. Its own `useSetActions`, for that press.
 */
function SessionSetRow({ log, current, locked, showRest, recordVideo, video, durationBased, holdHintId, onOpen, onGesture }) {
  const { t, lang } = useI18n();
  const actions = useSetActions(log, { durationBased });
  const ctx = { t, lang };
  const n = log.set_number;
  const isExtra = !!log.is_student_added;

  let state;
  let title;
  let caption;
  let trailing = null;
  if (log.skipped) {
    state = 'skipped';
    title = t('parcSession.setSkippedTitle', { n });
    caption = targetText(log, ctx);
  } else if (log.failed) {
    state = 'failed';
    title = t('parcSession.setFailedTitle', { n });
    caption =
      log.actual_reps != null && log.target_reps != null
        ? t('parcSession.failedCaption', {
            done: formatNumber(lang, log.actual_reps),
            target: formatNumber(lang, log.target_reps),
            load: loadText(log.actual_weight_kg ?? log.target_weight_kg, ctx),
          })
        : targetText(log, ctx);
  } else if (log.done) {
    const offPlan = isExtra || actions.loggedActual;
    state = offPlan ? 'offplan' : 'done';
    title = t(isExtra ? 'parcSession.setAddedTitle' : 'parcSession.setDoneTitle', { n });
    caption = offPlan ? t('parcSession.offPlanCaption', { work: actualText(log, ctx) }) : targetText(log, ctx);
    if (log.rpe != null) trailing = t('parcSession.rpeValue', { rpe: formatRpe(log.rpe, lang) });
  } else {
    state = current ? 'current' : 'pending';
    title = t(isExtra ? 'parcSession.setAddedTitle' : 'parcSession.setTitle', { n });
    caption = isExtra
      ? actions.extraIncomplete
        ? t('parcSession.extraCaption')
        : actualText(log, ctx)
      : targetText(log, ctx);
    if (current) trailing = t('parcSession.inProgress');
  }
  if (showRest && log.target_rest_seconds != null) {
    caption = t('parcSession.withRest', { text: caption, rest: restText(log.target_rest_seconds) });
  }
  if (recordVideo) {
    caption = t(video ? 'parcSession.withVideoSent' : 'parcSession.withVideoAsked', { text: caption });
  }

  const canPress = !locked || (recordVideo && !!video);
  const canFail = !locked && !log.failed && !log.skipped;
  return (
    <SetRow
      state={state}
      number={n}
      title={title}
      caption={caption}
      trailing={trailing}
      onPress={canPress ? () => onOpen(log.id) : undefined}
      onLongPress={
        canFail
          ? () => {
              onGesture?.();
              actions.markFailed({ toast: t('parcSession.toastFailed', { n }) });
            }
          : undefined
      }
      describedBy={canFail ? holdHintId : undefined}
    />
  );
}

/**
 * The exercise shown on the session screen (screens/Seance.dc.html): the panel
 * of the set in progress, what the coach asked, the sets, and the athlete's
 * own controls on the exercise — replace or skip it, add a set, a note for
 * the coach.
 *
 * `slotLogs` are the exercise's sets in set order; `seeds` what each set's
 * editor opens with (sessionModel `editorSeeds`); `lastPerf` the exercise's
 * last time, `lastPerfLoading` while it is read (its line keeps its place).
 * `setsLocked`: the session is confirmed or read-only, and no set can change;
 * `isReadOnly`: nothing about the session can change, its notes included.
 */
export default function SessionExercise({
  slot,
  slotLogs,
  seeds,
  deviation,
  swapped,
  skipped,
  durationBased,
  partners,
  noteSlotId,
  slotComment,
  lastPerf,
  lastPerfLoading,
  exerciseLibrary,
  sessionId,
  setsLocked,
  isReadOnly,
  online,
  getVideoForLog,
  onOpenSet,
  onGesture,
  onAddSet,
  addingSet,
}) {
  const { t, lang } = useI18n();
  const holdHintId = useId();
  const ctx = { t, lang };

  const substitute = swapped
    ? (exerciseLibrary || []).find((e) => e.id === deviation.substitute_exercise_id) ?? null
    : null;
  const name = substitute?.name ?? exerciseNameOf(slot, t);
  const loadMode = (substitute ?? slot.exercise)?.load_mode ?? null;
  // A session that can no longer be logged has no set in progress.
  const current = skipped || setsLocked ? null : currentLogOf(slotLogs);
  const shown = current ?? slotLogs[slotLogs.length - 1] ?? null;
  const figures = skipped ? {} : panelFigures(shown, shown ? seeds.get(shown.id) : null, {
    durationBased,
    loadMode,
    t,
    lang,
  });
  const position = skipped
    ? t('parcSession.exerciseSkipped')
    : current
      ? t('parcSession.setOf', { n: current.set_number, total: slotLogs.length })
      : slotLogs.length > 0
        ? t('parcSession.exerciseDone')
        : null;
  const lastTime = skipped ? '' : lastTimeText(lastPerf, ctx);
  // The rest is said on each row when the sets are not rested alike (N5), and
  // once on the panel otherwise.
  const rest = sharedRest(slotLogs);
  const restOnRows = rest === undefined;
  const deviationBar = (
    <SlotDeviationBar
      sessionId={sessionId}
      slot={slot}
      deviation={deviation}
      exerciseLibrary={exerciseLibrary}
      locked={setsLocked}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      <SetPanel
        label={t('parcSession.panelLabel')}
        title={name}
        position={position}
        primary={figures.primary}
        secondary={figures.secondary}
        footer={
          lastTime ||
          (lastPerfLoading && !skipped ? (
            <span aria-hidden="true" className="motion-safe:animate-pulse">
              …
            </span>
          ) : null)
        }
      >
        {(partners.length > 0 || rest != null) && !skipped && (
          <p className="pk-caption mt-3">
            {capitalize(
              [
                partners.length > 0 &&
                  t('parcSession.supersetWith', { names: partners.map((p) => exerciseNameOf(p, t)).join(', ') }),
                rest != null && t('parcSession.restBetween', { rest: restText(rest) }),
              ]
                .filter(Boolean)
                .join(', '),
            )}
          </p>
        )}
      </SetPanel>

      {/* A swap or a skip is said under the panel: it changes what the panel
          shows. The way off the plan waits under the sets. */}
      {deviation && deviationBar}

      {slot.notes && <CoachNote title={t('parcSession.coachNote')}>{slot.notes}</CoachNote>}

      {!skipped && slotLogs.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <ol className="pk-group" aria-label={t('parcSession.setsLabel')}>
            {slotLogs.map((log) => {
              const recordVideo = (slot.record_video_set_numbers || []).includes(log.set_number);
              return (
                <SessionSetRow
                  key={log.id}
                  log={log}
                  current={current?.id === log.id}
                  locked={setsLocked}
                  showRest={restOnRows}
                  recordVideo={recordVideo}
                  video={recordVideo ? getVideoForLog(log.id) : null}
                  durationBased={durationBased}
                  holdHintId={holdHintId}
                  onOpen={onOpenSet}
                  onGesture={onGesture}
                />
              );
            })}
          </ol>
          {!setsLocked && (
            <p id={holdHintId} className="pk-caption">
              {t('parcSession.holdHint')}
            </p>
          )}
        </div>
      )}

      {!skipped && !setsLocked && (
        online ? (
          <Button variant="text" className="self-start" onClick={onAddSet} disabled={addingSet}>
            {t('parcSession.addSet')}
          </Button>
        ) : (
          <p className="pk-caption">{t('parcSession.addSetOffline')}</p>
        )
      )}

      {!deviation && deviationBar}

      <SlotCommentBox
        sessionId={sessionId}
        slotId={noteSlotId}
        comment={slotComment}
        locked={isReadOnly}
      />
    </div>
  );
}
