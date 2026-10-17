import { useRef } from 'react';
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
import { startRestTimer, clearRestTimer } from '../../hooks/useRestTimer';
import { pushToast, dismissToast } from '../../lib/toast';
import { hasLoggedActual } from '../../lib/volume';

// What the Actual editor's two fields accept: what their columns hold
// (`set_logs.actual_reps` is an int, `actual_weight_kg` a numeric(6,2)). A
// value past them is refused in the editor, where the athlete sees why, and
// not by the server once the write replays — after the set was shown as saved.
export const ACTUAL_REPS_RULES = { integer: true, max: 2147483647 };
export const ACTUAL_WEIGHT_RULES = { max: 9999.99 };

// An extra set has no prescription: it says what was done, or it is not done.
// Reps (none on a duration exercise: there is no column for an actual
// duration) and a load, 0 being no load — a set with no volume, or reps added
// to an exercise measured in seconds, is what an empty extra set used to count
// as (P61).
export function extraValuesComplete({ reps, weightKg, durationBased }) {
  const repsOk = durationBased || (reps != null && reps > 0);
  return repsOk && weightKg != null && weightKg >= 0;
}

// What a skip or a failure clears on its set, read at the gesture so that its
// Undo can write it back: the outcome and its date, the RPE, the actual values.
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

function maybeVibrate() {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(10);
    } catch {
      // Some browsers throw on user-gesture mismatches; ignore.
    }
  }
}

/**
 * The writes of one set and what follows them, for the session screen: the
 * ActionBar's « Valider la série n », the long press of a row, the set's sheet
 * and the RPE sheet each call it on their set. It draws nothing; it says what
 * the screen should open next (the RPE sheet, the set's sheet).
 *
 * The rest timer and the RPE follow the GESTURE — what the athlete just did —
 * and never a change of `log`: the row changes for other reasons than a tap (a
 * queued write that lands, a read that comes back without it, a write taken
 * back), and an effect on `log.done` restarted the rest and scheduled a rest
 * push once per set when a workout logged offline was replayed.
 *
 * `log.id` is the scope of the set's writes in useSetLogs: the writes of one
 * set land in the order they were made, whichever component made them.
 *
 * What the exercise tells it, as in the editor's seeds (sessionModel
 * `editorSeeds`):
 *   - `swapped`: the athlete does another exercise in this slot. The pinned
 *     targets are the ORIGINAL exercise's, so the editor stores both values as
 *     entered and never collapses one equal to a target to null — the
 *     substitute's records and "Last time" only read logged actuals
 *     (lib/doneSetHistory), and a same-scheme swap used to store nothing (P59).
 *   - `seedReps` / `seedWeightKg`: what the editor opens with on a swapped
 *     exercise and on an extra set. Ignored on a prescribed set of an exercise
 *     that was not swapped, whose editor opens on its targets.
 *   - `durationBased`: the exercise is held for a time — an extra set then has
 *     no reps to give.
 */
export function useSetActions(log, { swapped = false, seedReps = null, seedWeightKg = null, durationBased = false } = {}) {
  const logId = log?.id;
  const toggleDone = useToggleSetDone(logId);
  const setFailed = useSetFailed(logId);
  const setRpe = useSetRpe(logId);
  const logActual = useLogActual(logId);
  const setSkipped = useSetSkipped(logId);
  const removeStudentSet = useRemoveStudentSet();
  // The way back of a removed extra set: the toast's Undo inserts it again.
  const addStudentSet = useAddStudentSet();
  // The last skip of this set that can still be taken back: what it cleared,
  // and its toast.
  const skipUndo = useRef(null);

  if (!log) return null;

  const restSeconds = log.target_rest_seconds ?? null;
  const failed = !!log.failed;
  const pending = !log.done && !failed;
  const isExtra = !!log.is_student_added;
  // "Actual reps" only makes sense for rep-based work — a 30 s plank has no
  // rep count to deviate on, so only the load is asked for. An extra set has
  // no target of its own: the exercise's unit decides.
  const repsApplies = isExtra ? !durationBased : log.target_reps != null || log.target_duration_seconds == null;
  // An extra set that does not say yet what was done cannot be marked done:
  // every gesture that would (Valider, an RPE) opens its sheet instead.
  const extraIncomplete =
    isExtra &&
    !extraValuesComplete({
      reps: log.actual_reps ?? log.target_reps ?? null,
      weightKg: log.actual_weight_kg ?? log.target_weight_kg ?? null,
      durationBased: !repsApplies,
    });

  // Pending → done or failed starts the rest: the athlete needs to recover
  // whatever the outcome. Between done and failed nothing moves — that rest is
  // already running.
  function startRest() {
    if (restSeconds && restSeconds > 0) startRestTimer(log.id, restSeconds);
  }

  /**
   * « Valider la série n »: the set done, its rest started. Answers what the
   * screen opens next: `'rpe'` — the RPE sheet —, or `'values'` for an extra
   * set that does not say yet what was done, whose sheet opens instead and
   * nothing is written.
   */
  function markDone() {
    if (extraIncomplete) return 'values';
    toggleDone.mutate({ logId: log.id, done: true });
    if (!failed) startRest();
    return 'rpe';
  }

  // The long press: the set failed, its rest started when it was pending, and
  // a toast whose « Annuler » puts back what the set was. One write: the
  // done → failed step clears `done` in the same UPDATE (patchForFailed), so
  // the CHECK set_logs_done_xor_failed never sees both.
  function markFailed({ toast } = {}) {
    if (failed || log.skipped) return;
    const before = outcomeOf(log);
    setFailed.mutate({ logId: log.id, failed: true });
    if (!log.done) startRest();
    maybeVibrate();
    if (toast) {
      pushToast(toast, {
        kind: 'info',
        action: { label: 'uiSharedHelpers.undo', onClick: () => takeBackFailure(before) },
      });
    }
  }

  // The Undo of a failure: the set no longer failed, and what it was before
  // written back — done at the moment it was done, with its rating. A set that
  // was pending goes back to pending, and the rest it started is over.
  function takeBackFailure(before) {
    const id = log.id;
    setFailed.mutate({ logId: id, failed: false });
    if (before.done) {
      toggleDone.mutate({ logId: id, done: true, at: before.loggedAt ?? undefined });
      if (before.rpe != null) setRpe.mutate({ logId: id, rpe: before.rpe });
    } else {
      clearRestTimer(id);
    }
  }

  // Back to pending: the rest this set started is over. clearRestTimer leaves
  // a timer that belongs to a later set alone.
  function clearFailed() {
    setFailed.mutate({ logId: log.id, failed: false });
    clearRestTimer(log.id);
  }

  /**
   * A rating. Given on a pending set it is the set done, in the same write
   * (P27), and starts its rest; taking a rating back (null) is never a reason
   * to date the set. Answers `'values'` for an extra set that does not say yet
   * what was done: nothing is written, its sheet opens.
   */
  function rate(rpe) {
    if (rpe != null && pending) {
      if (extraIncomplete) return 'values';
      setRpe.mutate({ logId: log.id, rpe, done: true });
      startRest();
      return 'done';
    }
    setRpe.mutate({ logId: log.id, rpe });
    return 'done';
  }

  // What the editor opens with: the logged actual when there is one, else the
  // prescribed target — the common "did it as written" case is one tap — and
  // on a swapped exercise or an extra set, the seeds (`seedReps`,
  // `seedWeightKg`): the targets there are another exercise's, or none. On a
  // swapped exercise the reps fall back on the prescribed ones (the same
  // scheme, as Stats reads it); its load never does.
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

  /**
   * Saves what was done (`reps`, `weightKg`, read by the caller from the two
   * fields). A swapped exercise and an extra set store both as entered; a
   * prescribed set stores a value equal to its target as null, so a stored
   * actual always denotes a deviation — the target columns are never written
   * here. Saved on a pending set, what was done marks it done in the same
   * write (P27) and starts its rest; answers `'rpe'` then, for the RPE sheet.
   */
  function saveActual(reps, weightKg) {
    let nextReps;
    let nextWeight;
    if (swapped || isExtra) {
      // A swapped exercise left without a load is done without one — null
      // would read as the original exercise's load (formatActual, Stats).
      nextReps = reps;
      nextWeight = weightKg ?? 0;
    } else {
      const tgtReps = log.target_reps ?? null;
      const tgtWeight = log.target_weight_kg == null ? null : Number(log.target_weight_kg);
      nextReps = reps != null && reps !== tgtReps ? reps : null;
      nextWeight = weightKg != null && weightKg !== tgtWeight ? weightKg : null;
    }
    // A done set is not dated again; a failed one stays failed.
    logActual.mutate(
      pending
        ? { logId: log.id, actualReps: nextReps, actualWeightKg: nextWeight, done: true }
        : { logId: log.id, actualReps: nextReps, actualWeightKg: nextWeight },
    );
    if (pending) {
      startRest();
      return 'rpe';
    }
    return 'done';
  }

  function clearActual() {
    logActual.mutate({ logId: log.id, actualReps: null, actualWeightKg: null });
  }

  // A skipped set is neither done nor failed any more, so its rest goes like
  // the one of a cleared outcome. A skip clears what the set held (P68), so it
  // is followed by a « Série sautée » toast whose Undo writes it back. The skip
  // is a queued write, and so is each write of its Undo: both work without a
  // network.
  function skip({ toast } = {}) {
    const undo = { logId: log.id, before: outcomeOf(log), toastId: null };
    skipUndo.current = undo;
    setSkipped.mutate({ logId: log.id, skipped: true });
    clearRestTimer(log.id);
    undo.toastId = pushToast(toast ?? 'parcSession.toastSkipped', {
      kind: 'info',
      action: { label: 'uiSharedHelpers.undo', onClick: () => takeBackSkip(undo) },
    });
  }

  // The Undo of a skip, from its toast or from the set's sheet: the set
  // un-skipped, then what the skip cleared written back by the hook of each
  // field — the outcome dated as it was, the RPE, the actual values. One row,
  // one FIFO scope: the writes land in this order, and each row they leave
  // satisfies the CHECKs of `set_logs`. The rest the skip cleared is not
  // started again: it was the rest of a set done earlier.
  function takeBackSkip(undo) {
    // Once: the toast and the sheet are two ways back from the same skip.
    if (skipUndo.current !== undo) return;
    skipUndo.current = null;
    const { logId: id, before } = undo;
    setSkipped.mutate({ logId: id, skipped: false });
    if (before.done) toggleDone.mutate({ logId: id, done: true, at: before.loggedAt ?? undefined });
    else if (before.failed) setFailed.mutate({ logId: id, failed: true, at: before.failedAt ?? undefined });
    if (before.done && before.rpe != null) setRpe.mutate({ logId: id, rpe: before.rpe });
    if (before.actualReps != null || before.actualWeightKg != null) {
      logActual.mutate({ logId: id, actualReps: before.actualReps, actualWeightKg: before.actualWeightKg });
    }
  }

  // The sheet's « Reprendre la série ». After a skip made in this sheet it is
  // the toast's Undo (and closes the toast); on a set skipped before, what the
  // skip cleared is not known any more: the set goes back to pending.
  function unskip() {
    const undo = skipUndo.current;
    if (undo && undo.logId === log.id) {
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
  // removal settles, and a per-call callback of an unmounted component is
  // never called. Nothing removed, nothing to undo; a refusal has its own
  // toast (the MutationCache's).
  function removeExtra() {
    removeStudentSet.mutateAsync({ logId: log.id }).then(
      ({ removed }) => {
        if (!removed) return;
        pushToast('parcSession.toastRemoved', {
          kind: 'info',
          action: { label: 'uiSharedHelpers.undo', onClick: () => bringBackExtra(removed) },
        });
      },
      () => {},
    );
  }

  // Called by the toast, after the set's sheet is gone. The insert is
  // online-only: started without a network it would wait, stored nowhere, and
  // land whenever the network returns — or never.
  function bringBackExtra(removed) {
    if (!onlineManager.isOnline() || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      pushToast('parcSession.undoNeedsNetwork');
      return;
    }
    addStudentSet.mutate({
      slotId: removed.exercise_slot_id,
      setNumber: removed.set_number,
      restore: removed,
    });
  }

  return {
    failed,
    pending,
    isExtra,
    repsApplies,
    extraIncomplete,
    loggedActual: hasLoggedActual(log),
    removing: removeStudentSet.isPending,
    markDone,
    markFailed,
    clearFailed,
    rate,
    editorSeed,
    saveActual,
    clearActual,
    skip,
    unskip,
    removeExtra,
  };
}
