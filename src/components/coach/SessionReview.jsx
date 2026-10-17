import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useIsRestoring } from '@tanstack/react-query';
import Spinner from '../ui/Spinner';
import VideoLightbox from '../ui/VideoLightbox';
import VideoPlayer from '../ui/VideoPlayer';
import { useSession } from '../../hooks/useSession';
import { useSetLogs } from '../../hooks/useSetLogs';
import { useSlotComments } from '../../hooks/useSlotComments';
import { useSlotDeviations } from '../../hooks/useSlotDeviations';
import { useExerciseLibrary } from '../../hooks/useExerciseLibrary';
import { useSetVideos } from '../../hooks/useSetVideo';
import { useArchiveSession } from '../../hooks/useWeek';
import { useSessionConfirmation } from '../../hooks/useSessionConfirmation';
import { useStudents } from '../../hooks/useStudents';
import { useSessionFeedback } from '../../hooks/useMessages';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useDeclinePromote } from '../../hooks/useAdoptSwap';
import { useI18n } from '../../hooks/useI18n';
import AdoptSwapDialog from './AdoptSwapDialog';
import RemoveExerciseDialog from './RemoveExerciseDialog';
import ReviewExercise from './ReviewExercise';
import SessionFeedbackComposer from './SessionFeedbackComposer';
import SessionFeedbackSent from './SessionFeedbackSent';
import SessionReviewedNoFeedback from './SessionReviewedNoFeedback';
import SessionReviewNotConfirmed from './SessionReviewNotConfirmed';
import { CoachNotFound, CoachReadProblem } from './CoachPageState';
import { reviewTotals } from './reviewModel';
import { readState } from '../../lib/readState';
import { clearFeedbackDraft } from '../../lib/feedbackDraft';
import { performedDate } from '../../lib/day';
import { dayName, formatDate, formatNumber, formatRelativeDays, pluralKey } from '../../lib/i18n/format';
import { formatRpe } from '../../lib/rpe';
import { pushToast } from '../../lib/toast';
import { Button, IconButton, LargeTitle, Sheet } from '../parc';
import {
  getLastCoachSession,
  rememberLastCoachSession,
  clearLastCoachSession,
} from '../../hooks/useRememberCoachStudentsPath';
import { groupSlotsBySuperset } from '../../lib/volume';

// Where "back" lands when nothing says where the coach came from: a deep link,
// a notification, a reload in another tab.
const DEFAULT_ORIGIN = '/coach/sessions';

// Only ever a coach route of this app. The value travels through router state
// and sessionStorage, and it is handed to navigate().
function coachPath(value) {
  return typeof value === 'string' && value.startsWith('/coach/') ? value : null;
}

// One mount per session. The page takes the moment it opened as the line
// between "what the cache held" and "what was read for this visit" (see
// `confirmationState`), and that moment belongs to the session on screen: a
// route change from one review to another must not carry it over.
export default function SessionReview() {
  const { studentId, sessionId } = useParams();
  return <SessionReviewPage key={`${studentId}/${sessionId}`} />;
}

function SessionReviewPage() {
  const { studentId, sessionId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { t, lang } = useI18n();
  const [openedAt] = useState(() => Date.now());

  // Where the coach came from: the surface that opened this review says so in
  // router state (`from`) — the athlete's sheet, the session editor, the feed
  // with its filter. Router state does not survive the Sessions tab bouncing
  // back into a review left open (SessionsFeed's restore navigates without
  // it), so the origin is saved next to the review and read back for the SAME
  // session.
  const origin = useMemo(() => {
    const fromState = coachPath(location.state?.from);
    if (fromState) return fromState;
    const saved = getLastCoachSession();
    return saved?.studentId === studentId && saved?.sessionId === sessionId
      ? coachPath(saved.from)
      : null;
  }, [location.state, studentId, sessionId]);

  const sessionRead = useSession(sessionId);
  const session = sessionRead.data;
  // The database's answer that there is no such session: deleted, or not this
  // coach's. Said as that, and never remembered as the review to come back to.
  const notFound = sessionRead.isSuccess && session == null;
  const hasSession = !!session;

  // Persist so tabbing between Sessions and other tabs returns to this
  // review instead of dropping the coach back on the feed — for this launch
  // only (hooks/useRememberCoachStudentsPath). Cleared on explicit
  // back-button click below, and by a tap on the Sessions tab while it is
  // open. Written once the session is known to
  // be there: SessionsFeed restores this key on every visit, so a review of
  // a session that is gone, saved here, would be where the Sessions tab
  // opens from then on.
  useEffect(() => {
    if (!studentId || !sessionId || !hasSession) return;
    rememberLastCoachSession({ studentId, sessionId, from: origin });
  }, [studentId, sessionId, origin, hasSession]);

  // …and a review saved on an earlier visit, when the session was still
  // there, goes as soon as the page learns it is not.
  useEffect(() => {
    if (!notFound) return;
    const saved = getLastCoachSession();
    if (saved?.studentId !== studentId || saved?.sessionId !== sessionId) return;
    clearLastCoachSession();
  }, [notFound, studentId, sessionId]);

  function forgetReview() {
    clearLastCoachSession();
  }

  function handleBack() {
    forgetReview();
    // An explicit destination, never history.back(): the previous history
    // entry can be any tab the coach came through (and the SessionsFeed
    // restore redirect complicates it). It is the page that opened the review
    // when that page said so, the feed otherwise.
    navigate(origin || DEFAULT_ORIGIN);
  }

  const slots = session?.exercise_slots || [];
  const { data: setLogs } = useSetLogs(sessionId, slots);
  const { data: slotComments } = useSlotComments(sessionId, slots);
  const { data: slotDeviations } = useSlotDeviations(sessionId, slots);
  const { data: exerciseLibrary } = useExerciseLibrary();
  const online = useOnlineStatus();
  const restoring = useIsRestoring();
  // Phase 3.1: adopting a student's swap into the program. `adoptTarget` drives
  // the confirm dialog; `adoptedSlots` hides the button once done (the reviewed
  // slot's deviation is preserved, so we track success client-side).
  const [adoptTarget, setAdoptTarget] = useState(null);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [adoptedSlots, setAdoptedSlots] = useState(() => new Set());
  const declinePromote = useDeclinePromote();
  const slotIds = useMemo(() => slots.map((s) => s.id), [slots]);
  const { data: videos } = useSetVideos(sessionId, slotIds);
  const videosBySlot = useMemo(() => {
    const m = new Map();
    (videos || []).forEach((v) => {
      const arr = m.get(v.exercise_slot_id) || [];
      arr.push(v);
      m.set(v.exercise_slot_id, arr);
    });
    return m;
  }, [videos]);
  // A review needs a confirmation: the database refuses `reviewed_at` and a
  // feedback message for a session that has none (review finding P57). The
  // feedback step below is offered on the strength of this row, so the answer
  // must have been READ SINCE THE PAGE OPENED. The cache is not enough — it
  // keeps an answer for two minutes and across reloads, and the athlete can
  // undo a confirmation in between: that is the stale "Session completed"
  // notification. Hence the forced read on mount, and four states:
  //   confirmed / none — read since the page opened;
  //   unverified       — that read failed, or waits for the network;
  //   checking         — it is in flight.
  // Both timestamps only move forward, so a background refetch that fails
  // later leaves a confirmed session confirmed, and the composer (with the
  // coach's unsent text) mounted.
  const confirmationQuery = useSessionConfirmation(sessionId, { refetchOnMount: 'always' });
  const confirmation = confirmationQuery.data;
  let confirmationState = 'checking';
  if (confirmationQuery.dataUpdatedAt >= openedAt) {
    confirmationState = confirmation ? 'confirmed' : 'none';
  } else if (confirmationQuery.errorUpdatedAt >= openedAt || confirmationQuery.isPaused) {
    confirmationState = 'unverified';
  }
  const { data: existingFeedback, isLoading: feedbackLoading } = useSessionFeedback(sessionId);
  // A feedback draft kept for a session that is reviewed has nowhere left to
  // go: the review was finished on another device, or the feedback was sent
  // from here while the coach had already left the page (the composer then
  // never heard back, and could not forget its draft itself).
  const reviewedAlready = !!existingFeedback || !!session?.reviewed_at;
  useEffect(() => {
    if (reviewedAlready) clearFeedbackDraft(sessionId);
  }, [reviewedAlready, sessionId]);
  const archiveSession = useArchiveSession();
  const { data: students } = useStudents();
  const student = useMemo(
    () => (students || []).find((s) => s.id === studentId) || null,
    [students, studentId],
  );
  const slotGroups = useMemo(() => groupSlotsBySuperset(slots), [slots]);
  const isArchived = !!session?.archived_at;
  const [playing, setPlaying] = useState(null);
  const [optionsOpen, setOptionsOpen] = useState(false);

  // One tap archives, and the session leaves the feed's lists: what was a
  // 69×23 pill next to "editor" is a 44px button now, and the archive says
  // so with a way back (live finding N14). Restoring is the same button, and
  // needs neither.
  function toggleArchived() {
    if (isArchived) {
      archiveSession.mutate({ sessionId, archived: false });
      return;
    }
    archiveSession.mutate(
      { sessionId, archived: true },
      {
        onSuccess: () => {
          pushToast(t('coachReviewComposerRoster.archive.done'), {
            kind: 'info',
            action: {
              label: 'uiSharedHelpers.undo',
              onClick: () => archiveSession.mutate({ sessionId, archived: false }),
            },
          });
        },
      },
    );
  }

  // A read that got no answer is not a session: rendered as one, it was a
  // review titled "Session" with nothing in it and a live feedback form
  // (review items P49, L11).
  const pageState = session
    ? 'ready'
    : notFound
      ? 'notFound'
      : readState([sessionRead], { online, restoring });

  const back = { label: t('parcReview.back'), onClick: handleBack };

  if (pageState === 'loading') {
    return (
      <div className="flex flex-col gap-6 px-4 pt-3 pb-6 md:px-8">
        <LargeTitle back={back} title={t('parcReview.untitled')} />
        <div className="flex justify-center py-12"><Spinner /></div>
      </div>
    );
  }

  if (pageState !== 'ready') {
    return (
      <div className="flex flex-col gap-6 px-4 pt-3 pb-6 md:px-8">
        <LargeTitle back={back} title={t('parcReview.untitled')} />
        {pageState === 'notFound' ? (
          <CoachNotFound
            title={t('coachEditorNavErrors.session.notFoundTitle')}
            body={t('coachEditorNavErrors.session.notFoundBody')}
            to={origin || DEFAULT_ORIGIN}
            onLeave={forgetReview}
            linkLabel={t('coachEditorNavErrors.session.goBack')}
          />
        ) : (
          <CoachReadProblem
            state={pageState}
            onRetry={() => sessionRead.refetch({ cancelRefetch: false })}
            retrying={sessionRead.isFetching}
          />
        )}
      </div>
    );
  }

  const athleteName = (student?.profile?.full_name || '').trim() || null;
  // Who trained, and when: the day the athlete trained, from the sets they
  // logged — not the moment the confirmation reached the server, which for
  // one sent offline is when the queue was replayed (review item L14).
  const trainedOn = confirmation ? performedDate(confirmation) : null;
  const subtitle = trainedOn
    ? t('parcReview.trained', { name: athleteName || t('parcReview.athlete'), when: whenText(trainedOn, { t, lang }) })
    : athleteName;
  const totals = reviewTotals({ slots, logs: setLogs || [], deviations: slotDeviations || [] });
  const fmt = (n) => formatNumber(lang, n);

  function renderSlot(slot) {
    const deviation = (slotDeviations || []).find((d) => d.exercise_slot_id === slot.id);
    const substituteName = deviation?.substitute_exercise_id
      ? (exerciseLibrary || []).find((e) => e.id === deviation.substitute_exercise_id)?.name ||
        t('coachEditorNavErrors.exercise.unavailableTitle')
      : null;
    const exerciseName = slot.exercise?.name ?? t('coachEditorNavErrors.exercise.unavailableTitle');
    return (
      <ReviewExercise
        key={slot.id}
        slot={slot}
        logs={(setLogs || []).filter((l) => l.exercise_slot_id === slot.id)}
        deviation={deviation}
        substituteName={substituteName}
        comment={(slotComments || []).find((x) => x.exercise_slot_id === slot.id)}
        videos={videosBySlot.get(slot.id)}
        athleteName={athleteName}
        adopted={adoptedSlots.has(slot.id)}
        online={online}
        declining={declinePromote.isPending}
        onDecline={() => declinePromote.mutate({ slotId: slot.id, sessionId })}
        onAdopt={() =>
          setAdoptTarget({
            slotId: slot.id,
            substituteId: deviation.substitute_exercise_id,
            originalName: exerciseName,
            substituteName,
          })
        }
        onRemove={() => setRemoveTarget({ slotId: slot.id, exerciseName })}
        onPlay={setPlaying}
      />
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-col gap-4 px-4 pt-3 pb-4 md:px-8">
        <div>
          <LargeTitle
            back={back}
            actions={<IconButton icon="more" label={t('parcReview.options')} onClick={() => setOptionsOpen(true)} />}
            title={session?.title || t('parcReview.untitled')}
            subtitle={subtitle}
          />
          {isArchived && (
            <p className="pk-caption mt-1">
              {t('parcReview.archivedOn', { date: formatDate(lang, session.archived_at, { day: 'numeric', month: 'long', year: 'numeric' }) })}
            </p>
          )}
        </div>

        {/* Said only once it has been read: while the read is in flight, or
            after it failed, the page does not know and claims nothing. (A
            confirmation the cache already holds is shown without waiting —
            its date and the athlete's notes are content.) */}
        {!confirmation && confirmationState === 'none' && (
          <section className="rounded-group bg-surface p-4">
            <h2 className="pk-headline">{t('coachReviewConfirmation.status.title')}</h2>
            <p className="pk-body mt-1.5">{t('coachReviewConfirmation.status.body')}</p>
          </section>
        )}

        {(setLogs || []).length > 0 && (
          <section
            aria-label={t('parcReview.totalsLabel')}
            className="grid grid-cols-3 gap-3 rounded-group bg-surface p-4"
          >
            <Figure
              value={fmt(totals.done)}
              label={t(pluralKey(lang, totals.done, 'parcReview.setsDone'), { total: fmt(totals.planned) })}
              extra={totals.extra > 0 ? t(pluralKey(lang, totals.extra, 'parcReview.added'), { n: fmt(totals.extra) }) : null}
            />
            <Figure value={totals.avgRpe != null ? formatRpe(Math.round(totals.avgRpe * 10) / 10, lang) : '–'} label={t('parcReview.avgRpe')} />
            <Figure
              value={fmt(totals.changes)}
              label={t(pluralKey(lang, totals.changes, 'parcReview.changes'))}
              tone={totals.changes > 0 ? 'amber' : null}
            />
          </section>
        )}

        {slotGroups.map((group) =>
          group.slots.length > 1 ? (
            <div key={group.key} className="flex flex-col gap-2">
              <p className="pk-caption">{t('parcReview.superset')}</p>
              {group.slots.map(renderSlot)}
            </div>
          ) : (
            renderSlot(group.slots[0])
          ),
        )}

        {confirmation?.notes && (
          <section className="rounded-group bg-surface p-4">
            <h2 className="text-[15px] font-bold leading-[1.4]">
              {athleteName ? t('parcReview.noteOf', { name: athleteName }) : t('parcReview.note')}
            </h2>
            <p className="pk-body mt-1.5 whitespace-pre-wrap">{confirmation.notes}</p>
          </section>
        )}
      </div>

      {/* Feedback step — branches on `sessions.reviewed_at`, on whether a
          feedback message exists, and on the confirmation. Feedback is
          one-shot per session (UNIQUE index on messages.session_id), and the
          review itself is one-shot (reviewed_at, set either by the feedback
          trigger or by "Finish without feedback"). The back button at the
          top is NOT a completion gesture — it leaves the session reviewable.

          The two read-only ends come first and do not look at the
          confirmation: a session reviewed before the rule existed keeps
          saying so. The composer — which also carries "Finish without
          feedback", the only other way to mark a session reviewed — is
          offered for a confirmed session only. Each carries its ActionBar. */}
      {!feedbackLoading && (
        existingFeedback ? (
          <SessionFeedbackSent
            feedback={existingFeedback}
            studentProfileId={student?.profile_id}
            onFinish={handleBack}
          />
        ) : session?.reviewed_at ? (
          <SessionReviewedNoFeedback
            reviewedAt={session.reviewed_at}
            studentProfileId={student?.profile_id}
            onFinish={handleBack}
          />
        ) : confirmationState === 'confirmed' ? (
          <SessionFeedbackComposer
            sessionId={sessionId}
            studentProfileId={student?.profile_id}
            studentFullName={athleteName}
            onFinish={handleBack}
          />
        ) : confirmationState === 'checking' ? null : (
          <SessionReviewNotConfirmed
            unverified={confirmationState === 'unverified'}
            onRetry={() => confirmationQuery.refetch()}
            retrying={confirmationQuery.isFetching}
            studentProfileId={student?.profile_id}
            onFinish={handleBack}
          />
        )
      )}

      <Sheet open={optionsOpen} onClose={() => setOptionsOpen(false)} title={t('parcReview.options')}>
        <div className="flex flex-col gap-2">
          {/* The way into the editor, now that a trained session's row on the
              sheet opens this page. On a confirmed session the editor is
              read-only and says why. Leaving through it is deliberate, so the
              Sessions tab must not bounce back here afterwards. */}
          <Button as={Link} to={`/coach/students/${studentId}/s/${sessionId}`} onClick={forgetReview} size="lg">
            {t('parcReview.openEditor')}
          </Button>
          <Button
            size="lg"
            onClick={() => {
              setOptionsOpen(false);
              toggleArchived();
            }}
            disabled={archiveSession.isPending}
          >
            {isArchived ? t('parcReview.unarchive') : t('parcReview.archive')}
          </Button>
        </div>
      </Sheet>

      <VideoLightbox open={!!playing} onClose={() => setPlaying(null)}>
        {playing && <VideoPlayer storagePath={playing.storage_path} />}
      </VideoLightbox>

      {adoptTarget && (
        <AdoptSwapDialog
          open
          onClose={() => setAdoptTarget(null)}
          slotId={adoptTarget.slotId}
          sessionId={sessionId}
          substituteId={adoptTarget.substituteId}
          originalName={adoptTarget.originalName}
          substituteName={adoptTarget.substituteName}
          onAdopted={(applied) => {
            // Only mark adopted when the rewrite actually changed something —
            // a 0-applied no-op must not read as success.
            if (applied > 0) {
              setAdoptedSlots((prev) => new Set(prev).add(adoptTarget.slotId));
            }
          }}
        />
      )}

      {removeTarget && (
        <RemoveExerciseDialog
          open
          onClose={() => setRemoveTarget(null)}
          slotId={removeTarget.slotId}
          sessionId={sessionId}
          exerciseName={removeTarget.exerciseName}
          onAdopted={(applied) => {
            if (applied > 0) {
              setAdoptedSlots((prev) => new Set(prev).add(removeTarget.slotId));
            }
          }}
        />
      )}
    </div>
  );
}

// « hier », « mardi », « le 12 octobre » — when the session was trained, as
// the line under the title says it.
function whenText(date, { t, lang }, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const ago = Math.round((today - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / 86400000);
  if (ago === 0 || ago === 1) return formatRelativeDays(lang, -ago);
  if (ago > 1 && ago < 7) return t('parcReview.whenDay', { day: dayName(lang, ((date.getDay() + 6) % 7) + 1, 'long') });
  return t('parcReview.whenOn', {
    date: formatDate(lang, date, {
      day: 'numeric',
      month: 'long',
      ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
    }),
  });
}

// One figure of the session, in large condensed digits over what it counts.
function Figure({ value, label, extra, tone }) {
  return (
    <div className="min-w-0">
      <div className={`pk-condensed pk-tnum text-[40px] font-extrabold leading-none ${tone === 'amber' ? 'text-amber' : ''}`}>
        {value}
      </div>
      <div className="pk-small mt-1">
        <span className="sr-only"> </span>
        {label}
        {extra && <span className="block">{extra}</span>}
      </div>
    </div>
  );
}
