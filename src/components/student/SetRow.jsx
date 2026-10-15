import { memo, useEffect, useId, useRef, useState } from 'react';
import { onlineManager } from '@tanstack/react-query';
import {
  useToggleSetDone,
  useSetFailed,
  useSetRpe,
  useLogActual,
  useSetSkipped,
  useAddStudentSet,
  useRemoveStudentSet,
} from '../../hooks/useSetLogs';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useI18n } from '../../hooks/useI18n';
import { startRestTimer, clearRestTimer } from '../../hooks/useRestTimer';
import { pushToast, dismissToast } from '../../lib/toast';
import { formatSetTarget, formatActual, hasLoggedActual } from '../../lib/volume';
import { decimalText, parseDecimalInput } from '../../lib/number';
import DecimalInput from '../ui/DecimalInput';
import RpeInput, { formatRpe } from './RpeInput';
import VideoUploadButton from './VideoUploadButton';

// What the Actual editor's two fields accept: what their columns hold
// (`set_logs.actual_reps` is an int, `actual_weight_kg` a numeric(6,2)). A
// value past them is refused here, where the athlete sees why, and not by the
// server once the write replays — after the set was shown as saved.
const ACTUAL_REPS_RULES = { integer: true, max: 2147483647 };
const ACTUAL_WEIGHT_RULES = { max: 9999.99 };
const NO_REPS = { ok: true, value: null };

// Touch-swipe thresholds for the mobile outcome gestures (right-to-left
// commits the set as done, left-to-right marks it failed). Two checks gate
// the commit: the absolute horizontal travel must clear COMMIT_PX, and the
// swipe must read as horizontal-dominant (|dx| > |dy| * H_OVER_V) so a
// vertical scroll near the row never accidentally fires the gesture.
const SWIPE_COMMIT_PX = 64;
const SWIPE_INTENT_PX = 8;
const SWIPE_H_OVER_V = 1.4;
const SWIPE_MAX_OFFSET = 96;

// Failed is a HOLD on the indicator, not a tap (P68). The tap cycled done →
// failed: a brush of the thumb turned the set done a moment ago into a failure
// and dropped its rating. A press held LONG_PRESS_MS marks a pending or a done
// set failed; a finger that travels more than LONG_PRESS_SLOP_PX first is a
// swipe or a scroll, and holds nothing. A tap on a done set says how, for
// HOLD_HINT_MS.
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;
const HOLD_HINT_MS = 4000;

// An extra set has no prescription: it says what was done, or it is not done.
// Reps (none on a duration exercise: there is no column for an actual
// duration) and a load, 0 being no load — a set with no volume, or reps added
// to an exercise measured in seconds, is what an empty extra set used to count
// as (P61).
function extraValuesComplete({ reps, weightKg, durationBased }) {
  const repsOk = durationBased || (reps != null && reps > 0);
  return repsOk && weightKg != null && weightKg >= 0;
}

// What a skip clears on its set (`patchForSkipped(true)`: the outcome and its
// date, the RPE, the actual values), read at the tap so that its Undo can write
// it back.
function outcomeOf(log) {
  return {
    done: !!log.done,
    failed: !!log.failed,
    rpe: log.rpe ?? null,
    loggedAt: log.logged_at ?? null,
    failedAt: log.failed_at ?? null,
    actualReps: log.actual_reps ?? null,
    actualWeightKg: log.actual_weight_kg ?? null,
  };
}

/**
 * SetRow — one row per set_log entry inside a SessionView exercise card.
 *
 * Rest target is read from the per-set `target_rest_seconds` on the log;
 * this lets a coach prescribe different rests per set within one exercise.
 *
 * The per-set target (e.g. `3 @ 107.5kg`) renders inline on every row.
 * It overlaps with the slot-header summary on uniform slots, but a row
 * with only an indicator and an RPE pill reads as empty — repeating the
 * target keeps the row scannable.
 *
 * What SlotGroupCard tells it about the exercise, as primitives (it is memo):
 *   - `swapped`: the athlete does another exercise in this slot. The pinned
 *     targets are the ORIGINAL exercise's, so the Actual editor stores both
 *     values as entered and never collapses one equal to a target to null —
 *     the substitute's records and "Last time" only read logged actuals
 *     (lib/doneSetHistory), and a same-scheme swap used to store nothing (P59).
 *   - `seedReps` / `seedWeightKg`: what the Actual editor opens with on a
 *     swapped exercise (the substitute's last performance) and on an extra set
 *     (the set before it). Ignored on a prescribed set of an exercise that was
 *     not swapped, whose editor opens on its targets.
 *   - `durationBased`: the exercise is prescribed in seconds — an extra set
 *     then has no reps to give.
 */
const SetRow = memo(function SetRow({
  log,
  locked = false,
  recordVideo = false,
  video = null,
  swapped = false,
  seedReps = null,
  seedWeightKg = null,
  durationBased = false,
}) {
  const { t, lang } = useI18n();
  const hintId = useId();
  const holdHintId = useId();
  // log.id feeds the per-row mutation scope: same-row writes stay FIFO,
  // different rows don't block each other. See useSetLogs.rowScope.
  const toggleDone = useToggleSetDone(log.id);
  const setFailed = useSetFailed(log.id);
  const setRpe = useSetRpe(log.id);
  const logActual = useLogActual(log.id);
  const setSkipped = useSetSkipped(log.id);
  const removeStudentSet = useRemoveStudentSet();
  // The way back of a removed extra set: the toast's Undo inserts it again.
  const addStudentSet = useAddStudentSet();
  const online = useOnlineStatus();
  const restSeconds = log.target_rest_seconds ?? null;

  const [rpeOpen, setRpeOpen] = useState(false);
  const [actualOpen, setActualOpen] = useState(false);
  const [actualReps, setActualReps] = useState('');
  const [actualWeight, setActualWeight] = useState('');

  // "actual reps" only makes sense for rep-based work — a 30s plank has no
  // rep count to deviate on, so we collect load only for duration sets. An
  // extra set has no target of its own: the exercise's unit decides.
  const isExtra = !!log.is_student_added;
  const repsApplies = isExtra
    ? !durationBased
    : log.target_reps != null || log.target_duration_seconds == null;
  const loggedActual = hasLoggedActual(log);

  // Swipe state lives in a ref to avoid re-rendering on every touchmove;
  // the visible offset/intent are mirrored into useState only when intent
  // is established or released.
  const swipe = useRef({ active: false, startX: 0, startY: 0, dx: 0, dy: 0, captured: false });
  const [swipeOffset, setSwipeOffset] = useState(0);

  // The hold on the indicator: its timer, where it started, and whether it
  // fired — the click that ends a press that fired is not a tap.
  const press = useRef({ timer: null, down: false, x: 0, y: 0, fired: false });
  const [holdHint, setHoldHint] = useState(false);

  // The last skip of this set that can still be taken back: what it cleared,
  // and its toast.
  const skipUndo = useRef(null);

  useEffect(() => {
    if (!holdHint) return undefined;
    const timer = setTimeout(() => setHoldHint(false), HOLD_HINT_MS);
    return () => clearTimeout(timer);
  }, [holdHint]);

  // A hold still counting when the row goes away marks nothing.
  useEffect(() => {
    const current = press.current;
    return () => clearTimeout(current.timer);
  }, []);

  const failed = !!log.failed;
  const rpeLocked = locked || failed;
  // Neither done nor failed (a skipped set renders without these controls).
  const pending = !log.done && !failed;
  // An extra set that does not say yet what was done cannot be marked done:
  // every gesture that would (the tap, the swipe, an RPE) opens its editor.
  const extraIncomplete =
    isExtra &&
    !extraValuesComplete({
      reps: log.actual_reps ?? log.target_reps ?? null,
      weightKg: log.actual_weight_kg ?? log.target_weight_kg ?? null,
      durationBased: !repsApplies,
    });

  // The three outcome gestures. The rest timer and the RPE selector follow
  // THEM — what the athlete just did — and never a change of `log`. The row
  // changes for other reasons than a tap: a queued write that lands, a read
  // that comes back without it, a write that is taken back. Driven by an
  // effect on `log.done`, each of those restarted the rest, reopened a selector
  // the athlete had closed and scheduled a rest push — once per set when a
  // workout logged offline was replayed.
  //
  // The timer itself is rendered globally by RestTimerBanner (mounted in
  // SessionView): SetRow only writes to the singleton, it doesn't read or
  // display remaining time, so the indicator survives exercise-card
  // transitions.

  // Pending → done or failed starts the rest: the student needs to recover
  // whatever the outcome. Between done and failed nothing moves — that rest is
  // already running.
  function startRest() {
    if (restSeconds && restSeconds > 0) startRestTimer(log.id, restSeconds);
  }

  function markDone() {
    if (extraIncomplete) {
      openActual();
      return;
    }
    toggleDone.mutate({ logId: log.id, done: true });
    if (!failed) startRest();
    // Only with "done": RPE is locked for a failed set, so opening it there
    // would just show a disabled UI.
    setRpeOpen(true);
  }

  function markFailed() {
    setFailed.mutate({ logId: log.id, failed: true });
    if (!log.done) startRest();
  }

  // Back to pending: the rest this set started is over. clearRestTimer leaves
  // a timer that belongs to a later set alone.
  function clearFailed() {
    setFailed.mutate({ logId: log.id, failed: false });
    clearRestTimer(log.id);
  }

  // A tap marks a pending set done and clears a failed one. On a done set it
  // writes nothing: it says that a hold marks the set failed.
  function handleIndicatorTap() {
    if (locked) return;
    if (log.done) setHoldHint(true);
    else if (failed) clearFailed();
    else markDone();
  }

  // A pending or a done set can be held to failed; a failed one is cleared by
  // a tap. The done → failed step is one write: patchForFailed(true) clears
  // `done` in the same UPDATE, so the DB CHECK set_logs_done_xor_failed never
  // sees an intermediate both-true row.
  const canHoldToFail = !locked && !failed;

  function holdToFail() {
    press.current.fired = true;
    setHoldHint(false);
    markFailed();
    maybeVibrate();
  }

  function stopPress() {
    const p = press.current;
    clearTimeout(p.timer);
    p.timer = null;
    p.down = false;
  }

  function handleIndicatorPointerDown(e) {
    const p = press.current;
    p.fired = false;
    stopPress();
    // A second mouse button or a second finger holds nothing.
    if (!canHoldToFail || e.button > 0 || e.isPrimary === false) return;
    p.down = true;
    p.x = e.clientX;
    p.y = e.clientY;
    p.timer = setTimeout(() => {
      p.timer = null;
      holdToFail();
    }, LONG_PRESS_MS);
  }

  // The row's swipe starts on the indicator too, and the row lets the browser
  // pan vertically only (`touch-action: pan-y`): a horizontal drag is never
  // cancelled by the browser, so the travel itself ends the hold.
  function handleIndicatorPointerMove(e) {
    const p = press.current;
    if (!p.timer) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_SLOP_PX) stopPress();
  }

  function handleIndicatorClick() {
    if (press.current.fired) {
      // The click that ends a hold: the hold has done its work.
      press.current.fired = false;
      return;
    }
    handleIndicatorTap();
  }

  // The context menu is the hold for those who cannot hold: a right click, the
  // menu key or Shift+F10 on a keyboard (WCAG 2.1.1) — and Android, which
  // opens it on a long press. It marks the set failed and shows no menu.
  function handleIndicatorContextMenu(e) {
    e.preventDefault();
    const p = press.current;
    if (p.fired) return; // the hold got there first
    const pressing = p.down;
    stopPress();
    if (!canHoldToFail) return;
    holdToFail();
    // Only a press still down ends in a click to swallow.
    if (!pressing) p.fired = false;
  }

  // A key press is never the end of a hold.
  function handleIndicatorKeyDown() {
    press.current.fired = false;
  }

  // Seed the inputs from the logged actual when present, else from the
  // prescribed target, so the common "did it as written" case is one tap
  // (open → Save) and the student only edits the dimension that differed.
  // A swapped exercise and an extra set open on what SlotGroupCard worked out
  // (`seedReps` / `seedWeightKg`): the targets on those rows are another
  // exercise's, or none. On a swapped exercise the reps fall back on the
  // prescribed ones (the same scheme, as Stats reads it); its load never does.
  function editorSeed() {
    if (swapped) {
      return {
        reps: log.actual_reps ?? seedReps ?? log.target_reps ?? null,
        weightKg: log.actual_weight_kg ?? seedWeightKg ?? null,
      };
    }
    if (isExtra) {
      return {
        reps: log.actual_reps ?? seedReps ?? null,
        weightKg: log.actual_weight_kg ?? seedWeightKg ?? null,
      };
    }
    return {
      reps: log.actual_reps ?? log.target_reps ?? null,
      weightKg: log.actual_weight_kg ?? log.target_weight_kg ?? null,
    };
  }

  // Opens the editor on its seeds. Already open: what the athlete typed stays.
  function openActual() {
    if (actualOpen) return;
    const seed = editorSeed();
    setActualReps(repsApplies ? decimalText(seed.reps) : '');
    setActualWeight(decimalText(seed.weightKg));
    setActualOpen(true);
  }

  function toggleActualOpen() {
    if (locked) return;
    if (actualOpen) setActualOpen(false);
    else openActual();
  }

  // What the inputs hold now, read as typed: "82,5" and "82.5" are 82.5 in
  // every browser (P31). Text that is not a number is refused, not read as an
  // empty field: empty is "as prescribed" on a set the coach wrote — which
  // wiped the actual it held — and no load (0 kg) on a swapped or extra set.
  // An extra set saves only once they say what was done; a done one must keep
  // saying it.
  const repsInput = repsApplies ? parseDecimalInput(actualReps, ACTUAL_REPS_RULES) : NO_REPS;
  const weightInput = parseDecimalInput(actualWeight, ACTUAL_WEIGHT_RULES);
  const typedInvalid = !repsInput.ok || !weightInput.ok;
  const typedReps = repsInput.ok ? repsInput.value : null;
  const typedWeight = weightInput.ok ? weightInput.value : null;
  const typedIncomplete =
    !typedInvalid &&
    isExtra &&
    !extraValuesComplete({ reps: typedReps, weightKg: typedWeight, durationBased: !repsApplies });

  // Nothing is written while a field says something the editor cannot read:
  // the editor stays open on the text, with the alert below it.
  function handleSaveActual() {
    if (typedInvalid || typedIncomplete) return;
    let nextReps;
    let nextWeight;
    if (swapped || isExtra) {
      // Stored as entered: the targets on the row are not what was done. A
      // swapped exercise left without a load is done without one — null would
      // read as the original exercise's load (formatActual, Stats).
      nextReps = typedReps;
      nextWeight = typedWeight ?? 0;
    } else {
      // Normalize a value that matches the prescription back to null so a
      // stored actual_* always denotes a genuine deviation. The target_*
      // columns are never written here — they stay the coach's source of truth.
      const tgtReps = log.target_reps ?? null;
      const tgtWeight = log.target_weight_kg == null ? null : Number(log.target_weight_kg);
      nextReps = typedReps != null && typedReps !== tgtReps ? typedReps : null;
      nextWeight = typedWeight != null && typedWeight !== tgtWeight ? typedWeight : null;
    }
    // Saved on a pending set, what was done marks it done: one write (P27).
    // A done set is not dated again; a failed one stays failed.
    logActual.mutate(
      pending
        ? { logId: log.id, actualReps: nextReps, actualWeightKg: nextWeight, done: true }
        : { logId: log.id, actualReps: nextReps, actualWeightKg: nextWeight },
    );
    setActualOpen(false);
    if (pending) {
      // The gesture that marked the set done: its rest, and its rating.
      startRest();
      setRpeOpen(true);
    }
  }

  // A rating given on a pending set is the set done, in the same write (P27).
  // Taking a rating back (null) is never a reason to date the set.
  function handleRpe(rpe) {
    if (rpe != null && pending) {
      if (extraIncomplete) {
        setRpeOpen(false);
        openActual();
        return;
      }
      setRpe.mutate({ logId: log.id, rpe, done: true });
      startRest();
    } else {
      setRpe.mutate({ logId: log.id, rpe });
    }
    if (rpe != null) setRpeOpen(false);
  }

  function handleRpePill() {
    if (rpeLocked) return;
    if (pending && extraIncomplete && !rpeOpen) {
      openActual();
      return;
    }
    setRpeOpen((v) => !v);
  }

  function handleClearActual() {
    logActual.mutate({ logId: log.id, actualReps: null, actualWeightKg: null });
    setActualOpen(false);
  }

  // A skipped set is neither done nor failed any more, so its rest goes like
  // the one of a cleared outcome.
  //
  // A skip clears what the set held (P68), so it is followed by a "Set
  // skipped" toast whose Undo writes it back. The skip is a queued write, and
  // so is each write of its Undo: both work without a network.
  function handleSkip() {
    const undo = { logId: log.id, before: outcomeOf(log), toastId: null };
    skipUndo.current = undo;
    setSkipped.mutate({ logId: log.id, skipped: true });
    clearRestTimer(log.id);
    setActualOpen(false);
    undo.toastId = pushToast('sessionTouchUndo.setSkipped', {
      kind: 'info',
      action: { label: 'uiSharedHelpers.undo', onClick: () => takeBackSkip(undo) },
    });
  }

  // The Undo of a skip, from its toast or from the strip of the skipped set:
  // the set un-skipped, then what the skip cleared written back by the hook of
  // each field — the outcome dated as it was, the RPE, the actual values. One
  // row, one FIFO scope (`rowScope`): the writes land in this order, and each
  // row they leave satisfies the CHECKs of `set_logs`. The rest the skip
  // cleared is not started again: it was the rest of a set done earlier.
  function takeBackSkip(undo) {
    // Once: the toast and the strip are two ways back from the same skip.
    if (skipUndo.current !== undo) return;
    skipUndo.current = null;
    const { logId, before } = undo;
    setSkipped.mutate({ logId, skipped: false });
    if (before.done) toggleDone.mutate({ logId, done: true, at: before.loggedAt ?? undefined });
    else if (before.failed) setFailed.mutate({ logId, failed: true, at: before.failedAt ?? undefined });
    if (before.done && before.rpe != null) setRpe.mutate({ logId, rpe: before.rpe });
    if (before.actualReps != null || before.actualWeightKg != null) {
      logActual.mutate({ logId, actualReps: before.actualReps, actualWeightKg: before.actualWeightKg });
    }
  }

  // The strip's Undo. After a skip made on this row it is the toast's Undo
  // (and closes the toast); on a set skipped before the row was shown, what
  // the skip cleared is not known any more: the set goes back to pending.
  function handleUnskip() {
    const undo = skipUndo.current;
    if (undo) {
      dismissToast(undo.toastId);
      takeBackSkip(undo);
      return;
    }
    setSkipped.mutate({ logId: log.id, skipped: false });
  }

  // Removing an extra set deletes what it said was done (P68): the toast that
  // says it is gone carries an Undo, which puts the row back as the database
  // answered it — id, outcome, RPE, actual values. The toast is pushed from the
  // promise, not from a per-call `onSuccess`: the row is gone by the time the
  // removal settles (its `onSettled` reads the sets again first), and a
  // per-call callback of an unmounted row is never called. Nothing removed,
  // nothing to undo; a refusal has its own toast (the MutationCache's).
  function handleRemoveExtra() {
    removeStudentSet.mutateAsync({ logId: log.id }).then(
      ({ removed }) => {
        if (!removed) return;
        pushToast('sessionTouchUndo.setRemoved', {
          kind: 'info',
          action: { label: 'uiSharedHelpers.undo', onClick: () => bringBackExtra(removed) },
        });
      },
      () => {},
    );
  }

  // Called by the toast, on a row that may be gone. The insert is online-only:
  // started without a network it would wait, stored nowhere, and land whenever
  // the network returns — or never.
  function bringBackExtra(removed) {
    if (!onlineManager.isOnline() || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      pushToast('sessionTouchUndo.undoNeedsNetwork');
      return;
    }
    addStudentSet.mutate({
      slotId: removed.exercise_slot_id,
      setNumber: removed.set_number,
      restore: removed,
    });
  }

  function handleTouchStart(e) {
    if (locked) return;
    const t = e.touches[0];
    swipe.current = { active: true, startX: t.clientX, startY: t.clientY, dx: 0, dy: 0, captured: false };
  }

  function handleTouchMove(e) {
    const s = swipe.current;
    if (!s.active) return;
    const t = e.touches[0];
    s.dx = t.clientX - s.startX;
    s.dy = t.clientY - s.startY;

    if (!s.captured) {
      // Wait until the gesture clearly reads as horizontal before claiming it,
      // otherwise let the page scroll vertically.
      const horizDominant = Math.abs(s.dx) > SWIPE_INTENT_PX && Math.abs(s.dx) > Math.abs(s.dy) * SWIPE_H_OVER_V;
      if (!horizDominant) return;
      s.captured = true;
    }

    // Cap the visible offset so the row doesn't translate off-screen on long
    // drags; the underlying mutation still fires once the threshold is met.
    const clamped = Math.max(-SWIPE_MAX_OFFSET, Math.min(SWIPE_MAX_OFFSET, s.dx));
    setSwipeOffset(clamped);
  }

  function handleTouchEnd() {
    const s = swipe.current;
    if (!s.active) return;
    const captured = s.captured;
    const dx = s.dx;
    swipe.current = { active: false, startX: 0, startY: 0, dx: 0, dy: 0, captured: false };
    setSwipeOffset(0);

    if (!captured || locked) return;

    if (dx <= -SWIPE_COMMIT_PX) {
      if (!log.done) markDone();
      maybeVibrate();
    } else if (dx >= SWIPE_COMMIT_PX) {
      if (!failed) markFailed();
      maybeVibrate();
    }
  }

  function handleTouchCancel() {
    swipe.current = { active: false, startX: 0, startY: 0, dx: 0, dy: 0, captured: false };
    setSwipeOffset(0);
  }

  // Skipped sets render as a muted strip with the prescription struck through
  // and an Undo. No outcome/RPE/actual controls — a skipped set has no result.
  if (log.skipped) {
    return (
      <div className="rounded-xl bg-ink-50 px-3 py-2 flex items-center gap-3 opacity-75">
        <span className="w-11 h-11 rounded-lg bg-ink-100 text-ink-400 flex items-center justify-center shrink-0 sl-display text-[15px]">
          —
        </span>
        <span className="sl-label normal-case text-ink-400 line-through">{formatSetTarget(log)}</span>
        <span className="sl-pill bg-ink-100 text-ink-500">Skipped</span>
        <div className="flex-1" />
        {!locked && (
          <button
            type="button"
            onClick={handleUnskip}
            className="sl-pill sl-pill-btn bg-ink-100 text-ink-600 hover:bg-ink-200"
          >
            Undo
          </button>
        )}
      </div>
    );
  }

  let rowBg;
  if (failed) rowBg = 'bg-danger/10';
  else if (log.done) rowBg = 'bg-success/10';
  else rowBg = 'bg-ink-50';

  // Indicator-button state: done = green check, failed = red ✕, else number.
  let indicatorBg, indicatorContent, indicatorAriaLabel;
  if (log.done) {
    indicatorBg = 'bg-accent text-ink-900';
    indicatorContent = (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
      </svg>
    );
    indicatorAriaLabel = t('sessionTouchUndo.doneIndicatorLabel');
  } else if (failed) {
    indicatorBg = 'text-white';
    indicatorContent = (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 6l12 12M18 6L6 18" />
      </svg>
    );
    indicatorAriaLabel = 'Clear failed mark';
  } else {
    indicatorBg = 'bg-ink-100 text-ink-500 hover:bg-ink-200';
    indicatorContent = log.set_number;
    indicatorAriaLabel = 'Mark set done';
  }

  // Swipe affordance: tint the trailing edge of the row so the student sees
  // which outcome will commit (green from the right while swiping toward
  // done, red from the left while swiping toward failed). Opacity ramps up
  // as the gesture nears the commit threshold.
  const swipeProgress = Math.min(1, Math.abs(swipeOffset) / SWIPE_COMMIT_PX);
  const swipeColor =
    swipeOffset < 0
      ? 'var(--color-success)'
      : swipeOffset > 0
        ? 'var(--color-danger)'
        : 'transparent';

  return (
    <div
      className={`relative rounded-xl overflow-hidden transition-colors ${rowBg} ${
        log.done || failed ? 'opacity-75' : ''
      }`}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
      style={{ touchAction: 'pan-y' }}
    >
      {swipeOffset !== 0 && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background: swipeColor,
            opacity: 0.18 * swipeProgress,
          }}
        />
      )}
      <div
        className="relative px-3 py-2"
        style={{
          transform: swipeOffset ? `translateX(${swipeOffset}px)` : undefined,
          transition: swipe.current.active ? 'none' : 'transform 150ms ease-out',
        }}
      >
        <div className="flex items-center flex-wrap gap-x-3 gap-y-2">
          <button
            onClick={handleIndicatorClick}
            onPointerDown={handleIndicatorPointerDown}
            onPointerMove={handleIndicatorPointerMove}
            onPointerUp={stopPress}
            onPointerCancel={stopPress}
            onPointerLeave={stopPress}
            onContextMenu={handleIndicatorContextMenu}
            onKeyDown={handleIndicatorKeyDown}
            disabled={locked}
            aria-label={indicatorAriaLabel}
            aria-describedby={holdHint && log.done ? holdHintId : undefined}
            // select-none and no touch callout: iOS selects text and opens a
            // callout under a finger held this long.
            className={`w-11 h-11 rounded-lg flex items-center justify-center shrink-0 transition-colors sl-display text-[15px] font-extrabold select-none ${indicatorBg} ${
              locked ? 'opacity-70 cursor-not-allowed' : ''
            }`}
            style={{
              WebkitTouchCallout: 'none',
              ...(failed ? { background: 'var(--color-danger)' } : null),
            }}
          >
            {indicatorContent}
          </button>

          {isExtra ? (
            !locked && online ? (
              // Student-added set: fold the "Extra" marker and its remove
              // control into ONE compact chip. A separate ✕ pill made this row
              // wider than a normal one (indicator + label + ✕ + Actual + RPE),
              // overflowing on mobile so RPE wrapped to a second line. Merging
              // them drops an element + its gap and keeps the row to one line.
              <button
                type="button"
                onClick={handleRemoveExtra}
                disabled={removeStudentSet.isPending}
                aria-label="Remove extra set"
                className="sl-pill sl-pill-btn bg-ink-100 text-ink-500 hover:bg-ink-200 px-2.5 gap-1 shrink-0 disabled:opacity-50"
              >
                Extra <span aria-hidden="true">✕</span>
              </button>
            ) : (
              <span className="sl-label normal-case text-ink-500">Extra set</span>
            )
          ) : (
            <span className="sl-label normal-case text-ink-500">{formatSetTarget(log)}</span>
          )}

          <div className="flex-1" />

          {recordVideo && (
            <VideoUploadButton
              setLogId={log.id}
              exerciseSlotId={log.exercise_slot_id}
              setNumber={log.set_number}
              existingVideo={video}
              disabled={locked}
            />
          )}

          {(loggedActual || !locked) && (
            <button
              type="button"
              onClick={toggleActualOpen}
              disabled={locked}
              aria-expanded={actualOpen}
              aria-label={
                loggedActual
                  ? `Logged actual ${formatActual(log)}, tap to edit`
                  : 'Log what you actually did'
              }
              className={`sl-pill shrink-0 min-h-11 px-3.5 ${
                loggedActual ? 'text-ink-900' : 'bg-ink-100 text-ink-500'
              } ${locked ? 'opacity-60 cursor-not-allowed' : 'hover:brightness-95'}`}
              style={
                loggedActual
                  ? { background: 'color-mix(in srgb, var(--color-warn) 20%, transparent)' }
                  : undefined
              }
            >
              {loggedActual ? formatActual(log) : 'Actual'}
            </button>
          )}

          <button
            type="button"
            onClick={handleRpePill}
            disabled={rpeLocked}
            aria-expanded={rpeOpen}
            aria-label={
              failed
                ? 'RPE disabled — set is failed'
                : log.rpe != null
                  ? `RPE ${formatRpe(log.rpe, lang)}, tap to change`
                  : 'Set RPE'
            }
            className={`sl-pill shrink-0 min-h-11 px-3.5 ${
              log.rpe != null
                ? 'bg-accent/15 text-accent'
                : 'bg-ink-100 text-ink-500'
            } ${rpeLocked ? 'opacity-60 cursor-not-allowed' : 'hover:brightness-95'}`}
            style={log.rpe != null ? { color: 'var(--color-accent)' } : undefined}
          >
            {log.rpe != null ? `RPE ${formatRpe(log.rpe, lang)}` : 'RPE'}
          </button>
        </div>

        {holdHint && log.done && (
          <p id={holdHintId} role="status" className="pt-2 sl-mono text-[11px] text-ink-500">
            {t('sessionTouchUndo.holdToFail')}
          </p>
        )}

        {rpeOpen && !failed && (
          <div className="pt-2">
            <RpeInput value={log.rpe} disabled={locked} onChange={handleRpe} />
          </div>
        )}

        {actualOpen && !locked && (
          // Compact off-plan editor: mirror the row's own "10 @ 100kg" notation
          // as two inputs joined by "@" so the whole thing stays on one line on
          // mobile. The "Actually did" lead-in and the "reps" unit label are
          // dropped — tapping Actual already framed the intent, and the set
          // target sits directly above for reference.
          <div className="pt-2 flex items-center flex-wrap gap-x-1.5 gap-y-2">
            {repsApplies && (
              <>
                <DecimalInput
                  {...ACTUAL_REPS_RULES}
                  value={actualReps}
                  onChange={(e) => setActualReps(e.target.value)}
                  aria-label="Actual reps performed"
                  aria-describedby={!repsInput.ok ? hintId : undefined}
                  className="w-12 min-h-11 rounded-lg bg-ink-50 border border-ink-200 px-2 py-1.5 text-gray-900"
                />
                <span className="sl-label normal-case text-ink-400" aria-hidden="true">@</span>
              </>
            )}
            <label className="flex items-center gap-1.5 text-[13px] text-ink-500">
              <DecimalInput
                {...ACTUAL_WEIGHT_RULES}
                value={actualWeight}
                onChange={(e) => setActualWeight(e.target.value)}
                aria-label="Actual weight in kilograms"
                aria-describedby={repsInput.ok && !weightInput.ok ? hintId : undefined}
                className="w-16 min-h-11 rounded-lg bg-ink-50 border border-ink-200 px-2 py-1.5 text-gray-900"
              />
              <span className="sl-label normal-case">kg</span>
            </label>
            <button
              type="button"
              onClick={handleSaveActual}
              disabled={typedInvalid || typedIncomplete}
              aria-describedby={typedInvalid || typedIncomplete ? hintId : undefined}
              className="sl-pill shrink-0 min-h-11 px-4 bg-accent text-ink-900 hover:brightness-95 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Save
            </button>
            {/* A done extra set keeps what it says it was. */}
            {loggedActual && !(isExtra && log.done) && (
              <button
                type="button"
                onClick={handleClearActual}
                className="sl-pill shrink-0 min-h-11 px-3 bg-ink-100 text-ink-500 hover:brightness-95"
              >
                Clear
              </button>
            )}
            {!isExtra && (
              <button
                type="button"
                onClick={handleSkip}
                className="sl-pill shrink-0 min-h-11 px-3 bg-ink-100 text-ink-500 hover:brightness-95"
              >
                Skip
              </button>
            )}
            {/* The reps field comes first on the line, so its message does. */}
            {typedInvalid && (
              <p id={hintId} role="alert" className="basis-full sl-mono text-[11px] text-danger">
                {t(
                  repsInput.ok
                    ? 'uiSharedHelpers.decimalInvalid'
                    : 'uiSharedHelpers.integerInvalid',
                )}
              </p>
            )}
            {typedIncomplete && (
              <p id={hintId} className="basis-full sl-mono text-[11px] text-ink-500">
                {t(
                  repsApplies
                    ? 'sessionRpeActualsExtras.extraNeedsRepsAndLoad'
                    : 'sessionRpeActualsExtras.extraNeedsLoad',
                )}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

function maybeVibrate() {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(10);
    } catch {
      // some browsers throw on user-gesture mismatches; ignore.
    }
  }
}

export default SetRow;
