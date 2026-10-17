import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useIsRestoring } from '@tanstack/react-query';
import { useSession } from '../../hooks/useSession';
import { useSetLogs, useEnsureSetLogs, useAddStudentSet } from '../../hooks/useSetLogs';
import { useSlotComments } from '../../hooks/useSlotComments';
import { useSlotDeviations } from '../../hooks/useSlotDeviations';
import { useLastPerformance } from '../../hooks/useLastPerformance';
import { useExerciseLibrary } from '../../hooks/useExerciseLibrary';
import { useSetVideos } from '../../hooks/useSetVideo';
import {
  useSessionConfirmation,
  useConfirmSession,
  useUnconfirmSession,
  useConfirmationWaiting,
} from '../../hooks/useSessionConfirmation';
import { useSessionFeedback, formatMessageStamp } from '../../hooks/useMessages';
import { useI18n } from '../../hooks/useI18n';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useBackOr } from '../../hooks/useBackOr';
import { useRestTimer, extendRestTimer } from '../../hooks/useRestTimer';
import { readState } from '../../lib/readState';
import { groupSlotsBySuperset } from '../../lib/volume';
import { performedOnFromLogs } from '../../lib/day';
import { dayName, formatDateTime, formatNumber, pluralKey } from '../../lib/i18n/format';
import Spinner from '../ui/Spinner';
import {
  ActionBar,
  Button,
  CoachNote,
  ConfirmSheet,
  ExerciseSwitcher,
  Icon,
  LargeTitle,
  RestCountdown,
  Sheet,
  formatRestClock,
} from '../parc';
import SessionExercise, { exerciseNameOf } from './SessionExercise';
import SetSheet from './SetSheet';
import RpeSheet from './RpeSheet';
import Unavailable from './Unavailable';
import { useSetActions } from './useSetActions';
import {
  capitalize,
  currentLogOf,
  deviationOf,
  editorSeeds,
  firstSlotToShow,
  isDurationBased,
  isLogResolved,
  nextSlotToShow,
} from './sessionModel';

// The exercises of a session that is not read yet: one array, so that what is
// derived from the exercises is not derived again on every render.
const NO_SLOTS = [];

// What « +30 s » adds to the rest that is running.
const EXTEND_SECONDS = 30;

// What stands where « Annuler la confirmation » would on a session the coach
// has reviewed: why it can no longer be changed, and the one way to get
// something corrected. There is no reopening in the app — the coach is asked,
// in the thread.
function ReviewedLock({ children }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="pk-body">{children}</p>
      <Button as={Link} to="/student/messages" variant="secondary">
        {t('parcSession.messageCoach')}
      </Button>
    </div>
  );
}

// The rest that is running, at the left of the ActionBar: the time left and
// « +30 s ». Nothing once it is over: the start and the end of a rest are
// said by RestTimerHost's status region, in the student shell, never each
// second.
function RestControls() {
  const { t } = useI18n();
  const snap = useRestTimer();
  if (snap.endsAt == null) return null;
  // The store's snapshot changes every second so that this read is made again:
  // the remaining time is the end time minus now, never a counter.
  // eslint-disable-next-line react-hooks/purity -- the clock is what this renders
  const remainingMs = snap.endsAt - Date.now();
  if (remainingMs <= 0) return null;
  const time = formatRestClock(remainingMs / 1000);
  return (
    <>
      <RestCountdown label={t('parcSession.rest')} time={time} ariaLabel={t('parcSession.restAria', { time })} />
      <Button aria-label={t('parcSession.addThirtyAria')} onClick={() => extendRestTimer(snap.logId, EXTEND_SECONDS)}>
        {t('parcSession.addThirty')}
      </Button>
    </>
  );
}

// « Valider la série n »: the set done through its own hooks, then the RPE
// sheet — or the set's sheet for an extra set that does not say yet what was
// done. Mounted per set (`key`), like the sheets.
function ValidateSetButton({ log, exercise, onRpe, onValues }) {
  const { t } = useI18n();
  const actions = useSetActions(log, exercise);
  return (
    <Button
      variant="primary"
      size="lg"
      className="flex-1"
      onClick={() => {
        if (actions.markDone() === 'values') onValues(log.id);
        else onRpe(log.id);
      }}
    >
      {t('parcSession.validateSet', { n: log.set_number })}
    </Button>
  );
}

// The set's sheet with that set's hooks: mounted per set (`key`), so that the
// writes of a set go through its own scope and a skip remembered for its Undo
// is the skip of this set.
function SetSheetFor({ log, exercise, ...props }) {
  const actions = useSetActions(log, exercise);
  return <SetSheet log={log} actions={actions} {...props} />;
}

export default function SessionView() {
  const { sessionId } = useParams();
  // A session is opened from a push notification, a link or a cold start as
  // often as from the list: on the first entry of the tab, back goes to the
  // list instead of doing nothing (L31).
  const goBack = useBackOr('/student');
  const { t, lang } = useI18n();
  const online = useOnlineStatus();
  const restoring = useIsRestoring();
  const sessionRead = useSession(sessionId);
  const { data: session, refetch: refetchSession } = sessionRead;
  const { data: feedback } = useSessionFeedback(sessionId);
  const slots = session?.exercise_slots || NO_SLOTS;
  const hasSlots = slots.length > 0;
  const logsRead = useSetLogs(sessionId, slots);
  const { data: logs, refetch: refetchLogs } = logsRead;
  const { data: slotComments } = useSlotComments(sessionId, slots);
  const deviationsRead = useSlotDeviations(sessionId, slots);
  const { data: slotDeviations, isFetched: deviationsFetched } = deviationsRead;
  const lastPerformanceRead = useLastPerformance(
    sessionId,
    slots,
    session?.scheduled_date,
    slotDeviations,
    deviationsFetched,
  );
  const { data: lastPerformance } = lastPerformanceRead;
  // The "Last time" line is on its way: its place is kept (N6). On its way is
  // a read in flight, or one that waits for the swaps it is keyed on while
  // those are read. A read paused without a network, or that failed, keeps no
  // place: it would be kept for good.
  const lastPerformanceLoading =
    !!lastPerformanceRead.isPending &&
    (lastPerformanceRead.fetchStatus === 'fetching' ||
      (!deviationsFetched && deviationsRead.fetchStatus === 'fetching'));
  const { data: exerciseLibrary } = useExerciseLibrary();
  const slotIds = useMemo(() => slots.map((s) => s.id), [slots]);
  const { data: videos } = useSetVideos(sessionId, slotIds);
  const videosByLogId = useMemo(() => {
    const m = new Map();
    (videos || []).forEach((v) => m.set(v.set_log_id, v));
    return m;
  }, [videos]);
  const slotGroups = useMemo(() => groupSlotsBySuperset(slots), [slots]);
  const { data: confirmation, isLoading: confLoading } = useSessionConfirmation(sessionId);
  const confirmSession = useConfirmSession();
  const unconfirmSession = useUnconfirmSession();
  const addSet = useAddStudentSet();
  // The confirmation is on the device and waits for a network — asked of the
  // queue, so it is also true of one made before the app was last closed.
  const confirmWaiting = useConfirmationWaiting(sessionId);
  // A write that is BEING SENT holds its button; one that is parked until the
  // network returns does not. Parked is still `isPending`, for hours: keyed on
  // that alone, "Confirm session" stayed off and on "Confirming…" for a
  // session whose confirmation had been made and taken back in the gym, and
  // "Undo confirmation" stayed off after an undo followed by a new confirm.
  const confirmInFlight = confirmSession.isPending && !confirmSession.isPaused;
  const undoInFlight = unconfirmSession.isPending && !unconfirmSession.isPaused;

  // The rest timer's wake lock, beep and push are not run here: they live in
  // RestTimerHost, in the student shell, so that leaving this page in the
  // middle of a rest does not end them.

  const notesId = useId();
  const [notes, setNotes] = useState('');
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  // The sheet has asked, since it was opened, whether a session without a
  // single logged set is really to be confirmed.
  const [askedAgain, setAskedAgain] = useState(false);
  const [undoDialogOpen, setUndoDialogOpen] = useState(false);
  // The exercise shown: chosen by a chip, or by the screen moving on after a
  // set. null until then: the first exercise with a set to do.
  const [chosenSlotId, setChosenSlotId] = useState(null);
  // The set whose sheet is open, and the last one opened: the sheet stays
  // mounted on it while it closes, and its focus goes back to the row.
  const [setSheet, setSetSheet] = useState({ open: false, logId: null });
  // The set whose RPE is asked, and the exercise it belongs to: the screen
  // moves on from there once the sheet closes.
  const [rpeSheet, setRpeSheet] = useState({ open: false, logId: null, slotId: null });
  const rpeOpenRef = useRef(false);

  // ── What can still be written ────────────────────────────────────────
  const hasSession = !!session;
  const isConfirmed = !!confirmation;
  const isArchived = !!session?.archived_at;
  // Sessions become read-only once the parent program is no longer the
  // athlete's active block (so history viewed via the stats calendar can't
  // be retroactively confirmed/undone) or once the coach has individually
  // archived the session. RLS enforces the same rule server-side; this is
  // the UI gate.
  const isPastProgram = session ? session.program_is_active === false : false;
  // Closed: nothing about the session can be written any more, the
  // confirmation included.
  const isClosed = isPastProgram || isArchived;
  // Reviewed: the coach has read this session — feedback sent, or "finish
  // without feedback". From then on what the athlete logged has to stay what
  // the coach read, and the confirmation can no longer be undone.
  // `reviewed_at` on the session row is the ONE source of this: a review is
  // recorded there with or without feedback. A feedback message is not a
  // second source — a lock keyed on anything but the column would drift from
  // whatever else reads it.
  const isReviewed = !!session?.reviewed_at;
  // Read-only is wider than closed: a reviewed session of the active block
  // keeps its sets, notes, deviations and videos as the coach read them, but a
  // confirmation can still be ADDED to it — only undoing one is over. That
  // case exists: sessions reviewed without a confirmation, or whose
  // confirmation was undone after the review, from before the two were tied
  // together. Hiding Confirm there would leave such a session "Next" in the
  // training list for good, with no way for the athlete to finish it.
  const isReadOnly = isClosed || isReviewed;
  const canUndo = isConfirmed && !isReadOnly;
  // Sets lock once the session is confirmed, or read-only. Notes lock on
  // read-only only: an athlete can still add one to a confirmed session.
  const setsLocked = isConfirmed || isReadOnly;

  // The session row reaches the page through a cache — served without a
  // request while it is fresh, persisted for offline use — and nothing pushes
  // a review to the athlete's device. "Not reviewed" is therefore only as true
  // as the row is recent, so the row is asked for again at the moments a
  // review may have happened behind the cache: when the page shows a confirmed
  // session (the only kind a coach reviews), and when the coach's feedback
  // arrives over the messages channel — the usual way a session becomes
  // reviewed, a second after it happens. Tapping "Undo confirmation" asks a
  // third time, below. It only asks: an answer that still says "not reviewed"
  // stands, and offline the request waits for the network without holding
  // anything up. A closed session has nothing left to lock.
  const feedbackId = feedback?.id ?? null;
  useEffect(() => {
    if (hasSession && !isReadOnly && (isConfirmed || feedbackId)) {
      refetchSession({ cancelRefetch: false });
    }
  }, [sessionId, hasSession, isReadOnly, isConfirmed, feedbackId, refetchSession]);

  // ── What the page is made of ─────────────────────────────────────────
  // Two reads: the session, and its sets once it is known to have exercises.
  // Until both hold data the page has nothing to show — and nothing to
  // confirm. A read that waits for the network or failed is not an empty
  // session: rendered as one, it was a page titled "Session" with no exercise
  // and a live "Confirm session" button (live item N1).
  const pageState = readState(hasSlots ? [sessionRead, logsRead] : [sessionRead], {
    online,
    restoring,
  });
  const ready = pageState === 'ready';

  // `cancelRefetch: false` joins a request that is already on its way — a
  // read React Query resumes by itself when the network returns — instead of
  // starting a second one.
  const retry = useCallback(() => {
    refetchSession({ cancelRefetch: false });
    if (hasSlots) refetchLogs({ cancelRefetch: false });
  }, [refetchSession, refetchLogs, hasSlots]);

  // The network is back and the page still has nothing to show: ask again,
  // without waiting for a tap. On that step only, never in a loop — a read
  // that keeps failing while the device is online stops at its message and its
  // button. (A client that believed it was online when the read failed holds
  // an errored read that nothing else picks up.)
  const wasOnline = useRef(online);
  useEffect(() => {
    const cameBack = online && !wasOnline.current;
    wasOnline.current = online;
    if (cameBack && !ready) retry();
  }, [online, ready, retry]);

  // A prescribed set without its row is added by the database, when the page
  // can tell that one is missing — see useEnsureSetLogs, which sends nothing
  // otherwise and nothing without a network. Not on a session shown read-only:
  // the function refuses a past block and an archived session, and rows added
  // to a reviewed one would be sets the coach never read. And not on a copy
  // that is being read again: "missing" is counted on the session and its
  // sets, and the two are only worth comparing once both have answered.
  const canMaterializeLogs = hasSession && !isReadOnly;
  const readingAgain = !!sessionRead.isFetching || !!logsRead.isFetching;
  useEnsureSetLogs(sessionId, slots, logs, { enabled: canMaterializeLogs && !readingAgain });

  // Slot ids the athlete skip-deviated: every set under them counts as
  // resolved (see isLogResolved), and they have no set to do.
  const skippedSlotIds = useMemo(
    () =>
      new Set(
        (slotDeviations || [])
          .filter((d) => d.kind === 'skip')
          .map((d) => d.exercise_slot_id)
      ),
    [slotDeviations]
  );

  const logsBySlot = useMemo(() => {
    const bySlot = new Map();
    for (const log of logs || []) {
      if (!bySlot.has(log.exercise_slot_id)) bySlot.set(log.exercise_slot_id, []);
      bySlot.get(log.exercise_slot_id).push(log);
    }
    for (const list of bySlot.values()) list.sort((a, b) => a.set_number - b.set_number);
    return bySlot;
  }, [logs]);
  const logsOf = useCallback((slotId) => logsBySlot.get(slotId) ?? NO_SLOTS, [logsBySlot]);

  if (pageState === 'loading') {
    return <div className="flex justify-center py-12"><Spinner /></div>;
  }

  // Nothing to build the page from, and nothing on its way. Said as what it
  // is, with a way to ask again — and without the rest of the page: there is
  // no set to tick, and a confirmation would be the confirmation of nothing.
  if (!ready) {
    const offline = pageState === 'offline';
    return (
      <div className="flex flex-col gap-4 px-4 pt-3 pb-6 md:px-8">
        <LargeTitle
          title={session?.title || t('sessionUnavailable.title')}
          back={{ label: t('parcSession.back'), onClick: goBack }}
        />
        <Unavailable
          title={t(offline ? 'parcSession.offlineTitle' : 'parcSession.errorTitle')}
          body={t(offline ? 'parcSession.offlineBody' : 'parcSession.errorBody')}
          onRetry={retry}
        />
      </div>
    );
  }

  // ── The exercise shown ───────────────────────────────────────────────
  const shownSlotId =
    chosenSlotId && slots.some((s) => s.id === chosenSlotId)
      ? chosenSlotId
      : firstSlotToShow(slots, logsOf, skippedSlotIds);
  const shownSlot = slots.find((s) => s.id === shownSlotId) ?? null;
  const shownGroup = shownSlot ? slotGroups.find((g) => g.slots.some((s) => s.id === shownSlot.id)) : null;
  const shown = shownSlot ? deviationOf(shownSlot, slotDeviations) : null;
  const shownLogs = shownSlot ? logsOf(shownSlot.id) : NO_SLOTS;
  const shownDuration = shownSlot ? isDurationBased(shownSlot, shownLogs) : false;
  const shownEffectiveExerciseId = shown?.swapped ? shown.deviation.substitute_exercise_id : shownSlot?.exercise?.id;
  const shownLastPerf = lastPerformance && shownEffectiveExerciseId ? lastPerformance[shownEffectiveExerciseId] : null;
  const shownSeeds = editorSeeds(shownLogs, { swapped: !!shown?.swapped, lastPerf: shownLastPerf });
  // A superset shares one note for the coach, anchored to its first exercise.
  const noteSlotId = shownGroup?.slots[0]?.id ?? shownSlot?.id;
  const currentLog = shownSlot && !shown.skipped ? currentLogOf(shownLogs) : null;
  const nextSlotId =
    shownSlot && !currentLog ? nextSlotToShow(shownSlot.id, slots, logsOf, skippedSlotIds) : null;
  const nextSlot = nextSlotId && nextSlotId !== shownSlot?.id ? slots.find((s) => s.id === nextSlotId) : null;

  function chipName(slot) {
    const { swapped, deviation } = deviationOf(slot, slotDeviations);
    if (swapped) {
      const substitute = (exerciseLibrary || []).find((e) => e.id === deviation.substitute_exercise_id);
      if (substitute) return substitute.name;
    }
    return exerciseNameOf(slot, t);
  }

  // The editor context of a set of the exercise shown: whether it is swapped,
  // what its fields open with, and its unit.
  function exerciseContextOf(log) {
    const seed = shownSeeds.get(log.id);
    return {
      swapped: !!shown?.swapped,
      seedReps: seed?.reps ?? null,
      seedWeightKg: seed?.weightKg ?? null,
      durationBased: shownDuration,
    };
  }

  // The exercise shown stays the one the athlete is working on: once a
  // gesture is made on it, the screen no longer follows "the first exercise
  // with a set to do" — a set failed by a long press would otherwise take its
  // exercise off the screen, and the set its toast's « Annuler » brings back
  // with it. The screen moves on after the RPE, or by « Passer à ».
  function pin() {
    if (chosenSlotId == null && shownSlot) setChosenSlotId(shownSlot.id);
  }

  function openSet(logId) {
    pin();
    setSetSheet({ open: true, logId });
  }

  function closeSet() {
    setSetSheet((current) => ({ ...current, open: false }));
  }

  function openRpe(logId) {
    pin();
    rpeOpenRef.current = true;
    setRpeSheet({ open: true, logId, slotId: shownSlot?.id ?? null });
  }

  // Once the RPE is given or the sheet is closed, the screen moves on: the
  // next exercise of a superset, or the next exercise with a set to do once
  // this one is finished. Once per opening: the sheet tells its close more
  // than once.
  function closeRpe() {
    if (!rpeOpenRef.current) return;
    rpeOpenRef.current = false;
    const from = rpeSheet.slotId;
    setRpeSheet((current) => ({ ...current, open: false }));
    if (!from) return;
    const next = nextSlotToShow(from, slots, logsOf, skippedSlotIds);
    if (next && next !== from) setChosenSlotId(next);
  }

  function handleAddSet() {
    if (!shownSlot) return;
    pin();
    const maxNum = shownLogs.reduce((m, l) => Math.max(m, l.set_number), 0);
    addSet.mutate({ slotId: shownSlot.id, setNumber: maxNum + 1 });
  }

  function closeConfirmDialog() {
    setConfirmDialogOpen(false);
    setAskedAgain(false);
  }

  function handleConfirm() {
    // Nothing is logged: the first tap asks, the second confirms. A session
    // can be confirmed without a set — the athlete trained and ticked nothing,
    // or did not train and says so in the note — but not by a slip of the
    // thumb on the way out of the page: the coach is notified, and the session
    // leaves "Next" (live item N8).
    if (nothingLogged && !askedAgain) {
      setAskedAgain(true);
      return;
    }
    // Pin the training date HERE, from the set logs, rather than letting the
    // server's confirmed_at default stand in for it: a confirm queued offline
    // replays whenever connectivity returns, which can be days later.
    const performedOn = performedOnFromLogs(logs);
    const written = notes;
    confirmSession.mutate({ sessionId, notes: written.trim() || null, performedOn }, {
      // The note stays in the field until the database has it: after a
      // confirmation that is refused, the sheet opens on what was written.
      // And the answer takes out of the field what it carried, nothing else:
      // it can come hours after the tap, to an athlete who has taken the
      // confirmation back and is writing the note of the next one.
      onSuccess: () => setNotes((current) => (current === written ? '' : current)),
    });
    // The sheet closes at the tap, not on the answer. The page behind it
    // shows the session as confirmed from this moment (the hook writes it into
    // the cache), and the answer can be hours away: a confirmation made
    // without a network is parked, which is not a failure and not a success,
    // and the dialog used to sit on "Confirming…" with Cancel switched off
    // until the network came back (P25).
    closeConfirmDialog();
  }

  function handleUnconfirm() {
    setUndoDialogOpen(false);
    unconfirmSession.mutate({ sessionId });
  }

  // What the confirm sheet counts before it is answered: the sets the athlete
  // has dealt with — failed, skipped and skip-deviated included —, so a
  // session with every set dealt with is not confirmed as "10 of 12". A
  // session without a set has nothing to count.
  const allLogs = logs || [];
  const doneCount = allLogs.filter((l) => l.done).length;
  const resolvedCount = allLogs.filter((l) => l.done || isLogResolved(l, skippedSlotIds)).length;
  const totalCount = allLogs.length;
  const nothingLogged = totalCount > 0 && resolvedCount === 0;
  // A set is still to do somewhere in the session.
  const anySetLeft = slots.some((slot) => !skippedSlotIds.has(slot.id) && currentLogOf(logsOf(slot.id)));
  const canConfirm = !confLoading && !isConfirmed && !isClosed;

  // The facts under the title: the day, the exercises, the sets done.
  const facts = [];
  if (session?.scheduled_date) {
    const [y, m, d] = session.scheduled_date.split('-').map(Number);
    const jsDay = new Date(y, m - 1, d).getDay();
    facts.push(capitalize(dayName(lang, jsDay === 0 ? 7 : jsDay, 'long')));
  }
  if (slots.length > 0) {
    facts.push(
      t(pluralKey(lang, slots.length, 'parcSession.exercises'), {
        n: formatNumber(lang, slots.length),
      }),
    );
  }
  if (totalCount > 0) {
    facts.push(
      t('parcSession.setsDone', { done: formatNumber(lang, doneCount), total: formatNumber(lang, totalCount) }),
    );
  }
  const subtitle = facts.join(', ');

  // ── The main action, in the ActionBar ────────────────────────────────
  let mainAction = null;
  if (!setsLocked && currentLog) {
    mainAction = (
      <ValidateSetButton
        key={currentLog.id}
        log={currentLog}
        exercise={exerciseContextOf(currentLog)}
        onRpe={openRpe}
        onValues={openSet}
      />
    );
  } else if (!setsLocked && nextSlot) {
    mainAction = (
      <Button variant="primary" size="lg" className="flex-1" onClick={() => setChosenSlotId(nextSlot.id)}>
        {t('parcSession.goTo', { name: chipName(nextSlot) })}
      </Button>
    );
  } else if (canConfirm && !anySetLeft) {
    mainAction = (
      <Button
        variant="primary"
        size="lg"
        className="flex-1"
        disabled={confirmInFlight}
        onClick={() => setConfirmDialogOpen(true)}
      >
        {confirmInFlight ? t('parcSession.confirming') : t('parcSession.confirmCta')}
      </Button>
    );
  }

  const sheetLog = setSheet.logId ? allLogs.find((l) => l.id === setSheet.logId) ?? null : null;
  const sheetSlot = sheetLog ? slots.find((s) => s.id === sheetLog.exercise_slot_id) ?? null : null;
  const sheetRecordVideo = !!(sheetSlot && sheetLog && (sheetSlot.record_video_set_numbers || []).includes(sheetLog.set_number));
  const rpeLog = rpeSheet.logId ? allLogs.find((l) => l.id === rpeSheet.logId) ?? null : null;

  function setSheetTitle(log) {
    const n = log.set_number;
    if (log.skipped) return t('parcSession.setSkippedTitle', { n });
    if (log.failed) return t('parcSession.setFailedTitle', { n });
    if (log.is_student_added) return t('parcSession.setAddedTitle', { n });
    if (log.done) return t('parcSession.setDoneTitle', { n });
    return t('parcSession.setTitle', { n });
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-1 flex-col gap-4 px-4 pt-3 pb-6 md:px-8">
        <LargeTitle
          title={session?.title || t('sessionUnavailable.title')}
          subtitle={subtitle}
          back={{ label: t('parcSession.back'), onClick: goBack }}
        />

        {feedback && (
          <CoachNote title={t('parcSession.feedbackTitle')}>
            {feedback.body}
            <span className="pk-caption mt-1 block">{formatMessageStamp(feedback.created_at, lang)}</span>
            <span className="mt-2 block">
              <Button as={Link} to="/student/messages" variant="secondary">
                {t('parcSession.replyInMessages')}
              </Button>
            </span>
          </CoachNote>
        )}

        {slots.length > 1 && (
          <ExerciseSwitcher
            label={t('parcSession.exercisesLabel')}
            items={slots.map((slot) => ({ id: slot.id, label: chipName(slot) }))}
            currentId={shownSlotId}
            onSelect={setChosenSlotId}
          />
        )}

        {shownSlot && (
          <SessionExercise
            key={shownSlot.id}
            slot={shownSlot}
            slotLogs={shownLogs}
            seeds={shownSeeds}
            deviation={shown.deviation}
            swapped={shown.swapped}
            skipped={shown.skipped}
            durationBased={shownDuration}
            partners={(shownGroup?.slots ?? []).filter((s) => s.id !== shownSlot.id)}
            noteSlotId={noteSlotId}
            slotComment={(slotComments || []).find((c) => c.exercise_slot_id === noteSlotId)}
            lastPerf={shownLastPerf}
            lastPerfLoading={lastPerformanceLoading}
            exerciseLibrary={exerciseLibrary}
            sessionId={sessionId}
            setsLocked={setsLocked}
            isReadOnly={isReadOnly}
            online={online}
            getVideoForLog={(logId) => videosByLogId.get(logId) || null}
            onOpenSet={openSet}
            onGesture={pin}
            onAddSet={handleAddSet}
            addingSet={addSet.isPending}
          />
        )}

        {/* Confirming before every set is dealt with: the sheet counts what
            was logged, and asks twice when nothing was. Once every set is
            dealt with, the ActionBar carries it. */}
        {canConfirm && anySetLeft && (
          <Button
            variant="text"
            className="self-start"
            disabled={confirmInFlight}
            onClick={() => setConfirmDialogOpen(true)}
          >
            {confirmInFlight ? t('parcSession.confirming') : t('parcSession.confirmCta')}
          </Button>
        )}

        {!confLoading && isConfirmed && (
          <section className="flex flex-col gap-3 rounded-group bg-surface p-4">
            <div className="flex items-start gap-3">
              <span className="pk-set-dot pk-set-dot-done" aria-hidden="true">
                <Icon name="check" size={16} strokeWidth={3} />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="pk-headline">{t('parcSession.confirmed')}</p>
                <p className="pk-caption">{formatDateTime(lang, confirmation.confirmed_at)}</p>
                {confirmWaiting && (
                  <p role="status" className="pk-caption">
                    {t('parcSession.confirmWaiting')}
                  </p>
                )}
                {confirmation.notes && (
                  <p className="pk-body mt-1 whitespace-pre-wrap break-words">{confirmation.notes}</p>
                )}
              </div>
            </div>
            {isClosed ? (
              <p className="pk-caption">
                {isArchived ? t('parcSession.lockedArchived') : t('parcSession.lockedPast')}
              </p>
            ) : isReviewed ? (
              <ReviewedLock>{t('parcSession.reviewedLocked')}</ReviewedLock>
            ) : (
              <Button
                variant="text"
                className="self-start"
                disabled={undoInFlight}
                onClick={() => {
                  setUndoDialogOpen(true);
                  // "Not reviewed" is as old as the cached row, and a review
                  // without feedback sends nothing that would refresh it. Ask
                  // again while the athlete reads the sheet: an answer that
                  // says "reviewed" closes it (see `canUndo` on the sheet).
                  refetchSession({ cancelRefetch: false });
                }}
              >
                {t('parcSession.undoConfirmation')}
              </Button>
            )}
          </section>
        )}

        {!confLoading && !isConfirmed && isClosed && (
          <p className="rounded-group bg-surface p-4 pk-caption">
            {isArchived ? t('parcSession.readOnlyArchived') : t('parcSession.readOnlyPast')}
          </p>
        )}

        {!confLoading && !isConfirmed && !isClosed && isReviewed && (
          <section className="rounded-group bg-surface p-4">
            <ReviewedLock>{t('parcSession.reviewedLockedUnconfirmed')}</ReviewedLock>
          </section>
        )}
      </div>

      {(mainAction || !setsLocked) && (
        <ActionBar className="sticky bottom-0 z-10 mt-auto">
          {!setsLocked && <RestControls />}
          {mainAction}
        </ActionBar>
      )}

      {sheetLog && (
        <SetSheetFor
          key={sheetLog.id}
          log={sheetLog}
          exercise={exerciseContextOf(sheetLog)}
          open={setSheet.open}
          title={setSheetTitle(sheetLog)}
          locked={setsLocked}
          online={online}
          recordVideo={sheetRecordVideo}
          video={videosByLogId.get(sheetLog.id) || null}
          onClose={closeSet}
          onNeedRpe={() => {
            closeSet();
            openRpe(sheetLog.id);
          }}
        />
      )}

      {rpeLog && (
        <RpeSheet
          key={rpeLog.id}
          open={rpeSheet.open}
          log={rpeLog}
          exercise={exerciseContextOf(rpeLog)}
          setNumber={rpeLog.set_number}
          onClose={closeRpe}
        />
      )}

      <Sheet open={confirmDialogOpen} onClose={closeConfirmDialog} title={t('parcSession.confirmTitle')}>
        <div className="flex flex-col gap-4">
          {totalCount > 0 && (
            <p className="pk-body">
              {t('parcSession.confirmSummary', {
                n: formatNumber(lang, resolvedCount),
                total: formatNumber(lang, totalCount),
              })}
            </p>
          )}
          <div className="grid gap-1.5">
            <label htmlFor={notesId} className="pk-small">
              {t('parcSession.notesLabel')}
            </label>
            <textarea
              id={notesId}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('parcSession.notesPlaceholder')}
              rows={3}
              className="pk-field py-2.5"
            />
          </div>
          {askedAgain && (
            <p role="alert" className="pk-body">
              {t('parcSession.nothingLogged')}
            </p>
          )}
          <div className="flex flex-col gap-1">
            <Button variant="primary" size="lg" onClick={handleConfirm}>
              {askedAgain ? t('parcSession.confirmAnyway') : t('parcSession.confirm')}
            </Button>
            <Button variant="text" onClick={closeConfirmDialog}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      </Sheet>

      {/* `canUndo` and not the tap alone: the session can become reviewed (or
          archived) while this sheet is open, and its button must go with the
          one that opened it. */}
      <ConfirmSheet
        open={undoDialogOpen && canUndo}
        onClose={() => setUndoDialogOpen(false)}
        onConfirm={handleUnconfirm}
        title={t('parcSession.undoTitle')}
        message={t('parcSession.undoBody')}
        confirmText={t('parcSession.undoConfirmation')}
        cancelText={t('parcSession.keepConfirmation')}
      />
    </div>
  );
}
