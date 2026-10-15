import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useIsRestoring } from '@tanstack/react-query';
import { useSession } from '../../hooks/useSession';
import { useSetLogs, useEnsureSetLogs } from '../../hooks/useSetLogs';
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
import { readState } from '../../lib/readState';
import Spinner from '../ui/Spinner';
import Dialog from '../ui/Dialog';
import ConfirmDialog from '../ui/ConfirmDialog';
import { groupSlotsBySuperset } from '../../lib/volume';
import { DAY_FULL, performedOnFromLogs } from '../../lib/day';
import SlotGroupCard from './SlotGroupCard';
import Unavailable from './Unavailable';
import RestTimerBanner from './RestTimerBanner';

// The exercises of a session that is not read yet: one array, so that what is
// derived from the exercises is not derived again on every render.
const NO_SLOTS = [];

// A set no longer needs the student's attention iff it was skipped, failed,
// completed with an RPE, or belongs to an exercise the student skip-deviated
// (those logs are hidden by SlotGroupCard, so they could otherwise never
// resolve — pinning the accordion and capping progress below 100% for the
// rest of the session). The RPE requirement pairs with SetRow's auto-expand
// on the done transition — see the firstOpenIdx comment.
function isLogResolved(log, skippedSlotIds) {
  return (
    log.skipped ||
    log.failed ||
    (log.done && log.rpe != null) ||
    skippedSlotIds.has(log.exercise_slot_id)
  );
}

function SessionTopBar({ title, meta, onBack }) {
  return (
    <div className="flex items-center justify-between gap-3 pt-3 pb-4">
      <button
        onClick={onBack}
        aria-label="Go back"
        className="w-11 h-11 rounded-full bg-ink-100 text-ink-700 flex items-center justify-center hover:bg-ink-200 active:scale-95 transition shrink-0"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <div className="min-w-0 text-center flex-1">
        {meta && <div className="sl-label truncate">{meta}</div>}
        <div className="sl-display text-[16px] text-gray-900 truncate">{title}</div>
      </div>
      {/* Right slot: rest-timer pill when active, empty 44px placeholder
          otherwise — the width of the back button, which keeps the title
          centered between the two. */}
      <div className="min-w-11 h-11 flex items-center justify-end shrink-0">
        <RestTimerBanner />
      </div>
    </div>
  );
}

// What stands where "Undo confirmation" would on a session the coach has
// reviewed: why it can no longer be changed, and the one way to get something
// corrected. There is no reopening in the app — the coach is asked, in the
// thread.
function ReviewedLock({ children }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <p className="sl-mono text-[11px] text-ink-400 leading-relaxed">{children}</p>
      <Link
        to="/student/messages"
        className="sl-pill min-h-11 px-4 bg-ink-100 text-ink-700 hover:bg-ink-200"
      >
        {t('sessionReviewedLock.messageCoach')}
      </Link>
    </div>
  );
}

export default function SessionView() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
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
  // The "Last time" hints are on their way: their card keeps their place
  // (N6). On their way is a read in flight, or one that waits for the swaps it
  // is keyed on while those are read. A read paused without a network, or
  // that failed, keeps no place: it would be kept for good.
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
  // Per-group offset = cumulative slot count of all preceding groups. Lets
  // SlotGroupCard label its rows with the global slot position (e.g. an
  // entry after a 2-slot superset starts at 04, not 03 from the group
  // index).
  const groupSlotOffsets = useMemo(() => {
    const offsets = [];
    let acc = 0;
    for (const g of slotGroups) {
      offsets.push(acc);
      acc += g.slots.length;
    }
    return offsets;
  }, [slotGroups]);
  const { data: confirmation, isLoading: confLoading } = useSessionConfirmation(sessionId);
  const confirmSession = useConfirmSession();
  const unconfirmSession = useUnconfirmSession();
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

  const [notes, setNotes] = useState('');
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  // The dialog has asked, since it was opened, whether a session without a
  // single logged set is really to be confirmed.
  const [askedAgain, setAskedAgain] = useState(false);
  const [undoDialogOpen, setUndoDialogOpen] = useState(false);
  // Accordion-style manual override:
  //   null      → no manual override; defer to auto (firstOpenIdx).
  //   string    → that group key is the only open one (closes any auto-open).
  //   false     → user manually closed the auto-open group; nothing is open.
  const [openKey, setOpenKey] = useState(null);

  // ── What can still be written ────────────────────────────────────────
  const hasSession = !!session;
  const isConfirmed = !!confirmation;
  const isArchived = !!session?.archived_at;
  // Sessions become read-only once the parent program is no longer the
  // student's active block (so history viewed via the stats calendar can't
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

  // Slot ids the student skip-deviated: every log under them counts as
  // resolved (see isLogResolved).
  const skippedSlotIds = useMemo(
    () =>
      new Set(
        (slotDeviations || [])
          .filter((d) => d.kind === 'skip')
          .map((d) => d.exercise_slot_id)
      ),
    [slotDeviations]
  );

  // Auto-open only the first group that still has unresolved sets (see
  // isLogResolved for the predicate). The RPE requirement pairs with
  // SetRow's auto-expand on the done transition: without it, the last set's
  // auto-expanded RPE panel would collapse before the student can record a
  // value, because the group would advance the moment the set flips to done.
  // Failed and skipped sets bypass — RPE is locked/meaningless there.
  const firstOpenIdx = useMemo(() => {
    for (let i = 0; i < slotGroups.length; i++) {
      const gl = slotGroups[i].slots.flatMap((s) =>
        (logs || []).filter((l) => l.exercise_slot_id === s.id)
      );
      if (gl.length === 0 || gl.some((l) => !isLogResolved(l, skippedSlotIds))) return i;
    }
    return -1;
  }, [slotGroups, logs, skippedSlotIds]);

  // Manual open/close overrides are single-shot: once the natural auto-open
  // target shifts (e.g. student cancels/undoes a set, or finishes the last
  // set of the current group), drop the override so auto-open/close resumes.
  // Without this reset, revisiting a completed group and then reverting state
  // would leave `openKey` sticky and starve subsequent auto transitions.
  useEffect(() => {
    setOpenKey(null);
  }, [firstOpenIdx]);

  if (pageState === 'loading') {
    return <div className="flex justify-center py-12"><Spinner /></div>;
  }

  // Nothing to build the page from, and nothing on its way. Said as what it
  // is, with a way to ask again — and without the rest of the page: there is
  // no set to tick, and a confirmation would be the confirmation of nothing.
  if (!ready) {
    const offline = pageState === 'offline';
    return (
      <div className="p-4 pb-6 md:p-8 space-y-5">
        <SessionTopBar
          title={session?.title || t('sessionUnavailable.title')}
          onBack={() => navigate(-1)}
        />
        <Unavailable
          title={t(offline ? 'sessionUnavailable.offlineTitle' : 'sessionUnavailable.errorTitle')}
          body={t(offline ? 'sessionUnavailable.offlineBody' : 'sessionUnavailable.errorBody')}
          onRetry={retry}
        />
      </div>
    );
  }

  function getLogsForSlot(slotId) {
    return (logs || [])
      .filter((l) => l.exercise_slot_id === slotId)
      .sort((a, b) => a.set_number - b.set_number);
  }

  function isGroupOpen(group, idx) {
    // No manual override → auto behavior (only firstOpenIdx is open).
    if (openKey === null) return idx === firstOpenIdx;
    // Manual override → only the chosen key (or none, if `false`) is open.
    return openKey === group.key;
  }

  // Accordion: opening a group closes whichever was previously open. Tapping
  // the currently-open group collapses it (mirrors the Sessions page).
  function toggleGroup(group, idx) {
    const wasOpen = isGroupOpen(group, idx);
    setOpenKey(wasOpen ? false : group.key);
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
      // confirmation that is refused, the dialog opens on what was written.
      // And the answer takes out of the field what it carried, nothing else:
      // it can come hours after the tap, to an athlete who has taken the
      // confirmation back and is writing the note of the next one.
      onSuccess: () => setNotes((current) => (current === written ? '' : current)),
    });
    // The dialog closes at the tap, not on the answer. The page behind it
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

  // Build total-sets progress numbers. The text counts only successfully
  // completed sets (a quality signal), but the progress bar reflects every
  // resolved set — failed, skipped, and skip-deviated included — so a
  // deviated session can still reach 100%.
  const allLogs = logs || [];
  const doneCount = allLogs.filter((l) => l.done).length;
  // `l.done ||` is the bar's sole divergence from isLogResolved: the bar
  // doesn't wait for an RPE on a done set.
  const resolvedCount = allLogs.filter(
    (l) => l.done || isLogResolved(l, skippedSlotIds)
  ).length;
  const totalCount = allLogs.length;
  const progress = totalCount > 0 ? Math.round((resolvedCount / totalCount) * 100) : 0;
  // What the confirm dialog says before it is answered: the sets the athlete
  // has dealt with — the ones the bar counts, so a session at 100% is not
  // confirmed as "10 of 12". A session without a set has nothing to count.
  const nothingLogged = totalCount > 0 && resolvedCount === 0;

  // Top-bar metadata: weekday + exercise count.
  const metaBits = [];
  if (session?.scheduled_date) {
    const [y, m, d] = session.scheduled_date.split('-').map(Number);
    const jsDay = new Date(y, m - 1, d).getDay();
    const dn = jsDay === 0 ? 7 : jsDay;
    metaBits.push(DAY_FULL[dn - 1].toUpperCase());
  }
  if (slots.length > 0) metaBits.push(`${slots.length} EX`);

  return (
    <div className="p-4 pb-6 md:p-8 space-y-5">
      <SessionTopBar
        title={session?.title || t('sessionUnavailable.title')}
        meta={metaBits.join(' · ')}
        onBack={() => navigate(-1)}
      />

      {/* Progress bar */}
      {totalCount > 0 && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="sl-mono text-[11px] text-ink-400">{doneCount} of {totalCount} sets</span>
            <span className="sl-mono text-[11px]" style={{ color: 'var(--color-accent)' }}>{progress}%</span>
          </div>
          <div className="h-1 rounded-full bg-ink-100 overflow-hidden">
            <div
              className="h-full transition-[width] duration-300"
              style={{ width: `${progress}%`, background: 'var(--color-accent)' }}
            />
          </div>
        </div>
      )}

      {feedback && (
        <section
          aria-labelledby="coach-feedback-heading"
          className="sl-card p-4 space-y-3"
          style={{ borderLeft: '3px solid var(--color-accent)' }}
        >
          <div className="flex items-center justify-between gap-3">
            <h2
              id="coach-feedback-heading"
              className="sl-label flex items-center gap-2"
              style={{ color: 'var(--color-accent)' }}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              {t('student.feedback.title')}
            </h2>
            <span className="sl-mono text-[11px] text-ink-400 shrink-0">
              {formatMessageStamp(feedback.created_at, lang)}
            </span>
          </div>
          <p className="text-[14px] text-gray-900 whitespace-pre-wrap leading-relaxed">
            {feedback.body}
          </p>
          <button
            type="button"
            onClick={() => navigate('/student/messages')}
            className="sl-pill sl-pill-btn bg-ink-100 text-ink-700 hover:bg-ink-200"
          >
            {t('student.feedback.replyInMessages')}
          </button>
        </section>
      )}

      {slotGroups.map((group, groupIdx) => (
        <SlotGroupCard
          key={group.key}
          group={group}
          slotOffset={groupSlotOffsets[groupIdx]}
          open={isGroupOpen(group, groupIdx)}
          onToggle={() => toggleGroup(group, groupIdx)}
          getLogsForSlot={getLogsForSlot}
          slotComments={slotComments}
          slotDeviations={slotDeviations}
          lastPerformance={lastPerformance}
          lastPerformanceLoading={lastPerformanceLoading}
          exerciseLibrary={exerciseLibrary}
          sessionId={sessionId}
          isConfirmed={isConfirmed}
          isReadOnly={isReadOnly}
          getVideoForLog={(logId) => videosByLogId.get(logId) || null}
        />
      ))}

      {!confLoading && (isConfirmed ? (
        <div
          className="sl-card p-4 space-y-3 !bg-success/5"
          style={{ borderLeft: '3px solid var(--color-success)' }}
        >
          <div className="flex items-start gap-3">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
              style={{ background: 'var(--color-success)', color: 'var(--color-ink-900)' }}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="sl-display text-[16px] text-gray-900">{t('student.session.confirmed')}</p>
              <p className="sl-mono text-[11px] text-ink-400 mt-0.5">
                {new Date(confirmation.confirmed_at).toLocaleString()}
              </p>
              {confirmWaiting && (
                <p role="status" className="sl-mono text-[11px] text-ink-400 mt-1 leading-relaxed">
                  {t('sessionConfirm.waiting')}
                </p>
              )}
              {confirmation.notes && (
                <p className="mt-2 text-[13px] text-gray-700 whitespace-pre-wrap">
                  {confirmation.notes}
                </p>
              )}
            </div>
          </div>
          {isClosed ? (
            <p className="sl-mono text-[11px] text-ink-400 text-center">
              {isArchived
                ? t('student.session.lockedArchived')
                : t('student.session.lockedPast')}
            </p>
          ) : isReviewed ? (
            <ReviewedLock>{t('sessionReviewedLock.locked')}</ReviewedLock>
          ) : (
            <button
              onClick={() => {
                setUndoDialogOpen(true);
                // "Not reviewed" is as old as the cached row, and a review
                // without feedback sends nothing that would refresh it. Ask
                // again while the athlete reads the dialog: an answer that
                // says "reviewed" closes it (see `canUndo` on the dialog).
                refetchSession({ cancelRefetch: false });
              }}
              disabled={undoInFlight}
              className="sl-mono text-[11px] text-ink-400 hover:text-danger underline w-full"
            >
              {t('student.session.undoConfirmation')}
            </button>
          )}
        </div>
      ) : isClosed ? (
        <div
          className="sl-card p-4 text-center"
          style={{ borderLeft: '3px solid var(--color-ink-300)' }}
        >
          <p className="sl-mono text-[11px] text-ink-400">
            {isArchived
              ? t('student.session.readOnlyArchived')
              : t('student.session.readOnlyPast')}
          </p>
        </div>
      ) : (
        <>
          {isReviewed && (
            <div
              className="sl-card p-4"
              style={{ borderLeft: '3px solid var(--color-ink-300)' }}
            >
              <ReviewedLock>{t('sessionReviewedLock.lockedUnconfirmed')}</ReviewedLock>
            </div>
          )}
          <button
            onClick={() => setConfirmDialogOpen(true)}
            disabled={confirmInFlight}
            className="sl-btn-primary w-full text-[13px] disabled:opacity-50"
            style={{ padding: '10px 16px' }}
          >
            {confirmInFlight
              ? t('student.session.confirming')
              : t('student.session.confirmCta')}
          </button>
        </>
      ))}

      <Dialog
        open={confirmDialogOpen}
        onClose={closeConfirmDialog}
        title={t('student.session.confirmDialogTitle')}
      >
        {totalCount > 0 && (
          <p className="sl-mono text-[12px] text-gray-900 mb-1">
            {t('sessionConfirm.summary', { n: resolvedCount, total: totalCount })}
          </p>
        )}
        <p className="sl-mono text-[12px] text-ink-400 mb-3 leading-relaxed">
          {t('student.session.confirmDialogBody')}
        </p>
        <label htmlFor="confirm-notes" className="sr-only">
          {t('student.session.notesLabel')}
        </label>
        <textarea
          id="confirm-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t('student.session.notesPlaceholder')}
          rows={4}
          className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-[16px] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] mb-4"
        />
        {askedAgain && (
          <p role="alert" className="text-[13px] text-gray-900 mb-4 leading-relaxed">
            {t('sessionConfirm.nothingLogged')}
          </p>
        )}
        <div className="flex gap-2">
          <button
            onClick={handleConfirm}
            className="flex-1 rounded-lg py-2.5 sl-display text-[13px] text-white"
            style={{ background: 'var(--color-accent)' }}
          >
            {askedAgain ? t('sessionConfirm.confirmAnyway') : t('common.confirm')}
          </button>
          <button
            onClick={closeConfirmDialog}
            className="flex-1 bg-ink-100 text-ink-700 rounded-lg py-2.5 sl-display text-[13px] hover:bg-ink-200"
          >
            {t('common.cancel')}
          </button>
        </div>
      </Dialog>

      {/* `canUndo` and not the tap alone: the session can become reviewed (or
          archived) while this dialog is open, and its button must go with the
          one that opened it. */}
      <ConfirmDialog
        open={undoDialogOpen && canUndo}
        onClose={() => setUndoDialogOpen(false)}
        onConfirm={handleUnconfirm}
        title={t('student.session.undoConfirmTitle')}
        message={t('student.session.undoConfirmBody')}
        confirmText={t('student.session.undoConfirmation')}
      />
    </div>
  );
}
