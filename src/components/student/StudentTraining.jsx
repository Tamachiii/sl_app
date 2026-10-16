import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useIsMutating, useIsRestoring, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import {
  useStudentProgramDetails,
  useStudentPastProgram,
} from '../../hooks/useStudentProgramDetails';
import { sessionQueryOptions } from '../../hooks/useSession';
import { setLogsQueryOptions } from '../../hooks/useSetLogs';
import { useMyConfirmedSessionIds } from '../../hooks/useSessionConfirmation';
import { useMyFeedbackSessionIds } from '../../hooks/useMessages';
import { DAY_FULL_LONG, parseISODate, performedDate } from '../../lib/day';
import { buildQueue, flattenSessions } from '../../lib/sessionQueue';
import { readState } from '../../lib/readState';
import { isLoggedSet } from '../../lib/loggedSets';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import UserMenu from '../ui/UserMenu';
import SessionCard from './SessionCard';
import Unavailable from './Unavailable';

const LOCALE = { en: 'en-US', fr: 'fr-FR', de: 'de-DE' };

// Stable stand-ins for "not read yet", so a memo that depends on them does not
// run again on every render.
const NO_WEEKS = [];
const NO_IDS = new Set();

/**
 * The student's ONE training surface: the block as a single ordered list.
 *
 * This replaces a Home page and a Sessions page that both listed sessions and
 * both offered "start the next one". Two screens for one question — "what do I
 * do now?" — is the redundancy this merge removes. It also drops the Mon–Sun
 * day strip: a seven-column grid with week arrows IS the calendar week, which
 * is the exact framing the block was rewritten to stop imposing.
 *
 * Reading order is the model, stated once: the next session sits at the top,
 * expanded, with the athlete's place in the block beside the program name.
 * Sessions still to do follow it in program order. Finished sessions sit below
 * under one heading, ordered by the day they were ACTUALLY trained — which is
 * the only order that means anything once the athlete stops following a
 * calendar (the old list sorted them by recommended weekday, so a session done
 * on the 18th could sit above one done on the 21st).
 */

/** "Fri, 21 Aug" — the day a session was really trained. */
function formatDoneDate(session, lang) {
  const d = performedDate(session);
  if (!d) return null;
  return d.toLocaleDateString(LOCALE[lang] || LOCALE.en, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/**
 * What to say under an unfinished session's title. A real date when the coach
 * set one, otherwise the recommended weekday spelled out as advice — never a
 * pill on a grid, which is what made a suggestion read as a deadline.
 */
function upcomingSubtitle(session, lang, t) {
  const d = session.scheduled_date ? parseISODate(session.scheduled_date) : null;
  if (d) {
    return d.toLocaleDateString(LOCALE[lang] || LOCALE.en, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
  }
  const dn = session.day_number;
  if (dn >= 1 && dn <= 7) {
    return t('student.training.recommendedDay', { day: DAY_FULL_LONG[dn - 1] });
  }
  return null;
}

// Finished work reads newest-first, by the day it was really trained. Sessions
// with no recorded date (confirmed before the column existed) sink below the
// dated ones rather than jumping to the top.
function newestTrainedFirst(a, b) {
  const da = performedDate(a);
  const db = performedDate(b);
  if (da && db) return db - da;
  if (da) return -1;
  if (db) return 1;
  return 0;
}

/**
 * Read a session and its sets into the cache, under the keys and in the shapes
 * the session page reads — the same options objects its hooks mount.
 *
 * The sets are asked for with the slots of the session row this very call
 * cached, not with the list's: the page builds the key of its set read from
 * that row, and the list may be one coach edit behind it.
 *
 * `fetchQuery` answers from the cache while the copy is fresh, so calling this
 * again costs nothing until it is not. A failure is nobody's problem here: the
 * page reads again when it is opened.
 */
function readAheadSession(queryClient, sessionId) {
  return queryClient
    .fetchQuery(sessionQueryOptions(sessionId))
    .then((session) => {
      const slots = session?.exercise_slots || [];
      if (slots.length === 0) return undefined;
      return queryClient.prefetchQuery(setLogsQueryOptions(sessionId, slots));
    })
    .catch(() => {});
}

// Whether the athlete logged anything in a session — a set done, failed or
// skipped, an RPE, an actual. Asked of the sessions of a past block only: its
// read selects the columns `isLoggedSet` needs, the active block's does not.
function holdsLoggedSet(session) {
  return (session.exercise_slots || []).some((slot) => (slot.set_logs || []).some(isLoggedSet));
}

// Name plus at most ONE short line, and only when it says something. "Trained
// today" told the athlete what they already knew; staleness and recent rhythm
// are the two facts worth a line, and never both at once.
function Greeting({ fullName, queue, onSignOut }) {
  const { t, lang } = useI18n();
  const firstName = (fullName || '').split(' ')[0] || 'there';

  let line = null;
  if (queue.daysSinceLast == null) {
    line = queue.total > 0 ? t('student.training.neverTrained') : null;
  } else if (queue.daysSinceLast === 0) {
    line = queue.doneLast7 > 0
      ? t(queue.doneLast7 === 1 ? 'student.training.last7One' : 'student.training.last7Many', {
          n: queue.doneLast7,
        })
      : null;
  } else {
    let when = '';
    try {
      when = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(
        -queue.daysSinceLast,
        'day'
      );
    } catch {
      when = '';
    }
    line = when ? t('student.training.lastTrained', { when }) : null;
  }

  return (
    <div className="pt-3 pb-1 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="sl-label text-ink-400">{t('student.training.kicker')}</div>
        <h1 className="sl-display text-[32px] md:text-[44px] text-gray-900 leading-none mt-1 truncate">
          {t('student.home.hey')}, {firstName}.
        </h1>
        {line && <p className="sl-mono text-[11px] text-ink-400 mt-2">{line}</p>}
      </div>
      <UserMenu fullName={fullName} onSignOut={onSignOut} profileHref="/student/profile" />
    </div>
  );
}

/**
 * A closed drawer of finished work — the active block's completed sessions, or
 * a whole past block.
 *
 * History is something the athlete goes looking for, never something the
 * landing page should spend its height on: a month-long block is ~20 cards and
 * a year of coaching is hundreds, every one of them standing between the
 * athlete and the only question this page exists to answer. `renderBody` is a
 * function, not children, so a closed drawer builds NOTHING — the cost stays a
 * single row however long the history gets.
 *
 * Open state is deliberately not persisted: you open a drawer to look one
 * thing up, and coming back to a clean page next visit is the right default.
 */
function Drawer({ headingId, title, meta, renderBody }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-3 border-b border-ink-100 pb-1.5 text-left"
      >
        <div className="min-w-0 flex-1">
          <div id={headingId} className="sl-label text-gray-900 truncate">
            {title}
          </div>
          {meta && <div className="sl-mono text-[10px] text-ink-400 mt-0.5">{meta}</div>}
        </div>
        <svg
          className={`w-4 h-4 text-ink-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className="space-y-2">{renderBody()}</div>}
    </section>
  );
}

/**
 * What an open past-block drawer holds: that block's sessions, read when the
 * drawer opens and not before.
 *
 * The list's own read carries a past block as a name and a count, which is all
 * a closed drawer shows — and is why that read stays small enough to be the
 * one the device keeps. Because the query lives in this component, and a
 * closed drawer builds nothing, a block nobody opens is never asked for.
 */
function PastBlockSessions({ userId, programId, showArchived, renderCard }) {
  const { t } = useI18n();
  const online = useOnlineStatus();
  const restoring = useIsRestoring();
  const block = useStudentPastProgram(userId, programId);
  const { data: weeks, refetch } = block;

  const sessions = useMemo(
    () =>
      flattenSessions(weeks)
        .map(({ session }) => session)
        .filter((s) => showArchived || !s.archived_at)
        .sort(newestTrainedFirst),
    [weeks, showArchived]
  );

  const state = readState([block], { online, restoring });
  if (state === 'loading') {
    return <div className="flex justify-center py-6"><Spinner /></div>;
  }
  if (state !== 'ready') {
    return (
      <Unavailable
        compact
        title={t(
          state === 'offline' ? 'trainingListOffline.blockOffline' : 'trainingListOffline.blockError'
        )}
        onRetry={() => refetch({ cancelRefetch: false })}
      />
    );
  }
  return sessions.map(renderCard);
}

function ArchivedToggle({ count, expanded, onToggle, t }) {
  const label = expanded
    ? t(count === 1 ? 'student.sessions.hideArchivedOne' : 'student.sessions.hideArchivedMany', { n: count })
    : t(count === 1 ? 'student.sessions.showArchivedOne' : 'student.sessions.showArchivedMany', { n: count });
  return (
    <button
      onClick={onToggle}
      aria-pressed={expanded}
      className="sl-mono text-[11px] text-ink-400 hover:text-gray-700 underline py-1 shrink-0"
    >
      {label}
    </button>
  );
}

export default function StudentTraining() {
  const { user, profile, signOut } = useAuth();
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const online = useOnlineStatus();
  const restoring = useIsRestoring();
  // The list is made of two reads, and both are among the few the device
  // keeps: the block being trained (with the names of the ones before it), and
  // which sessions are confirmed. It needs BOTH to say anything — the block
  // alone, with no confirmation known, puts the athlete back on its first
  // session.
  const details = useStudentProgramDetails(user?.id);
  const confirmations = useMyConfirmedSessionIds();
  const { data: feedbackIds = NO_IDS } = useMyFeedbackSessionIds();
  const writesWaiting = useIsMutating() > 0;

  const [showArchived, setShowArchived] = useState(false);
  // `undefined` = the student hasn't chosen yet, so the next session opens by
  // default; `null` = they deliberately collapsed it. The distinction matters
  // because the next session's id isn't known until the query resolves, so a
  // plain initial value can't express "whatever turns out to be next".
  const [openSessionId, setOpenSessionId] = useState(undefined);

  const listState = readState([details, confirmations], { online, restoring });
  const ready = listState === 'ready';

  // The block being trained — the only one this read brings whole. A past
  // block's unfinished sessions are history the athlete moved on from, not
  // work that is somehow still due, so the queue is built from these alone.
  const activeWeeks = details.data?.weeks ?? NO_WEEKS;
  const confirmedIds = confirmations.data ?? NO_IDS;

  const queue = useMemo(() => buildQueue(activeWeeks, confirmedIds), [activeWeeks, confirmedIds]);

  const activeProgramName = activeWeeks[0]?.program?.name || null;

  const { upcoming, done } = useMemo(() => {
    const up = [];
    const dn = [];
    for (const { session } of flattenSessions(activeWeeks)) {
      if (session.archived_at && !showArchived) continue;
      if (session.archived_at) {
        dn.push(session);
      } else if (confirmedIds.has(session.id)) {
        dn.push(session);
      } else {
        up.push(session);
      }
    }
    dn.sort(newestTrainedFirst);
    return { upcoming: up, done: dn };
  }, [activeWeeks, confirmedIds, showArchived]);

  // Past blocks, newest first, as the rows their closed drawers are: a name
  // and how many sessions the drawer would show. A block with nothing to show
  // (every session archived, the toggle off) gets no row.
  const pastHeaders = details.data?.pastPrograms;
  const pastPrograms = useMemo(
    () =>
      (pastHeaders || [])
        .map((program) => ({
          program,
          count: showArchived
            ? program.session_count
            : program.session_count - program.archived_count,
        }))
        .filter((group) => group.count > 0),
    [pastHeaders, showArchived]
  );

  const archivedCount = useMemo(
    () =>
      activeWeeks.reduce(
        (n, w) => n + (w.sessions || []).filter((s) => s.archived_at).length,
        0
      ) + (pastHeaders || []).reduce((n, program) => n + program.archived_count, 0),
    [activeWeeks, pastHeaders]
  );

  const { refetch: refetchDetails } = details;
  const { refetch: refetchConfirmations } = confirmations;
  // `cancelRefetch: false` joins a request that is already on its way — a
  // read React Query resumes by itself when the network returns — instead of
  // starting a second one.
  const retry = useCallback(() => {
    refetchDetails({ cancelRefetch: false });
    refetchConfirmations({ cancelRefetch: false });
  }, [refetchDetails, refetchConfirmations]);

  // The network is back and the list still has nothing to show: ask again,
  // without waiting for a tap. Only on that step, never in a loop — a read
  // that keeps failing while the device is online stops at the message and
  // its button.
  const wasOnline = useRef(online);
  useEffect(() => {
    const cameBack = online && !wasOnline.current;
    wasOnline.current = online;
    if (cameBack && !ready) retry();
  }, [online, ready, retry]);

  // Read the NEXT session ahead, into the cache the session page reads from
  // and the device keeps. The list is where an athlete is before a workout,
  // usually still on a network; the session is opened in the gym, often
  // without one — and a session that was never opened on this device had
  // nothing to show there but a spinner and an empty page.
  //
  // It runs again each time the list itself is read again (`dataUpdatedAt`),
  // so a session the coach rewrote this afternoon is not kept as it was this
  // morning, and when the network returns. It does not run while a write is
  // waiting or on its way: the answer could be older than what the device
  // holds, and would put the ticked sets back as they were.
  const nextId = ready ? upcoming[0]?.id ?? null : null;
  const listReadAt = details.dataUpdatedAt ?? 0;
  useEffect(() => {
    if (!nextId || !online || writesWaiting) return;
    readAheadSession(queryClient, nextId);
  }, [queryClient, nextId, listReadAt, online, writesWaiting]);

  if (listState === 'loading') {
    return (
      <div className="p-4">
        <h1 className="sr-only">Training</h1>
        <div className="flex justify-center py-12"><Spinner /></div>
      </div>
    );
  }

  // Nothing to build the list from, and nothing on its way. Said as what it
  // is — never as "No program assigned yet", which is a statement about the
  // athlete's program that only an answer can make.
  if (!ready) {
    const offline = listState === 'offline';
    return (
      <div className="p-4 pb-6 md:p-8 space-y-6">
        <Greeting fullName={profile?.full_name} queue={queue} onSignOut={signOut} />
        <Unavailable
          title={t(offline ? 'trainingListOffline.offlineTitle' : 'trainingListOffline.errorTitle')}
          body={t(offline ? 'trainingListOffline.offlineBody' : 'trainingListOffline.errorBody')}
          onRetry={retry}
        />
      </div>
    );
  }

  const next = upcoming[0] ?? null;
  const later = upcoming.slice(1);
  const openId = openSessionId === undefined ? next?.id ?? null : openSessionId;

  // `readOnly` covers sessions from a past block: locked for logging both in
  // the UI and by RLS. It must NOT block navigation — opening a finished
  // session to review what you did is the whole point of keeping history on
  // the page, and SessionView already renders a past block read-only.
  const cardProps = (session, { readOnly = false } = {}) => ({
    session,
    confirmed: confirmedIds.has(session.id),
    archived: !!session.archived_at,
    hasFeedback: feedbackIds.has(session.id),
    locked: readOnly,
    // A past-block session trained in and never confirmed keeps its Review
    // entry: what was logged there is history too (L32).
    hasLoggedSets: readOnly && holdsLoggedSet(session),
    onStart: () => navigate(`/student/session/${session.id}`),
    // Compared against the EFFECTIVE open id, not the raw state: while that is
    // still `undefined` the next card is visually open, and toggling it has to
    // close it rather than re-open what is already open.
    open: openId === session.id,
    onToggle: () => setOpenSessionId(openId === session.id ? null : session.id),
  });

  return (
    <div className="p-4 pb-6 md:p-8 space-y-6">
      <Greeting fullName={profile?.full_name} queue={queue} onSignOut={signOut} />

      {activeWeeks.length === 0 && pastPrograms.length === 0 && (
        <EmptyState message={t('student.home.noProgram')} />
      )}

      {activeWeeks.length > 0 && (
        <section aria-labelledby="active-block-heading" className="space-y-3">
          {/* One "you are here" marker for the whole page: the block's name and
              the athlete's place in it, on a single line. It replaced a stack of
              four headings (week range, "Next session", "Session 6 of 7", "Then"). */}
          <header className="flex items-baseline justify-between gap-3 border-b border-ink-100 pb-1.5">
            <div id="active-block-heading" className="sl-label text-gray-900 truncate">
              {activeProgramName}
            </div>
            {queue.total > 0 && (
              <span className="sl-mono text-[11px] text-ink-400 shrink-0">
                {t('student.home.sessionPosition', { n: queue.position, total: queue.total })}
              </span>
            )}
          </header>

          {next && (
            <div className="relative overflow-hidden rounded-2xl">
              <div
                className="absolute top-0 left-0 bottom-0 w-1 z-10"
                style={{ background: 'var(--color-accent)' }}
              />
              {/* Collapsible like every other card: once the student opens
                  another one this shrinks out of the way instead of holding a
                  screenful for a session that is no longer the subject. The
                  NEXT badge carries the meaning the permanent expansion used
                  to. */}
              <SessionCard
                {...cardProps(next)}
                badge={t('student.training.nextBadge')}
                subtitle={upcomingSubtitle(next, lang, t)}
              />
            </div>
          )}

          {!next && <EmptyState message={t('student.home.blockComplete')} />}

          {later.length > 0 && (
            <div className="space-y-2">
              {later.map((s) => (
                <SessionCard key={s.id} {...cardProps(s)} subtitle={upcomingSubtitle(s, lang, t)} />
              ))}
            </div>
          )}

        </section>
      )}

      {/* Everything already trained lives in a drawer — the active block's own
          finished sessions first, then each past block. A month-long block
          reaches ~20 completed cards, so the active block needs the same
          treatment as the history; the queue position in the header above
          already states progress without listing it. */}
      {done.length > 0 && (
        <Drawer
          headingId="done-heading"
          title={t('student.training.doneHeading')}
          meta={t(
            done.length === 1 ? 'student.training.sessionsOne' : 'student.training.sessionsMany',
            { n: done.length }
          )}
          renderBody={() =>
            done.map((s) => (
              <SessionCard key={s.id} {...cardProps(s)} subtitle={formatDoneDate(s, lang)} />
            ))
          }
        />
      )}

      {pastPrograms.map(({ program, count }) => (
        <Drawer
          key={program.id}
          headingId={`program-${program.id}-heading`}
          title={program.name || ''}
          meta={`${t('student.sessions.pastProgram')} · ${t(
            count === 1 ? 'student.training.sessionsOne' : 'student.training.sessionsMany',
            { n: count }
          )}`}
          renderBody={() => (
            <PastBlockSessions
              userId={user?.id}
              programId={program.id}
              showArchived={showArchived}
              renderCard={(s) => (
                <SessionCard
                  key={s.id}
                  {...cardProps(s, { readOnly: true })}
                  subtitle={formatDoneDate(s, lang)}
                />
              )}
            />
          )}
        />
      ))}

      {/* One quiet footer link rather than a control tucked inside a drawer the
          student would have to open first. Archived work is a rare lookup. */}
      {archivedCount > 0 && (
        <div className="flex justify-end">
          <ArchivedToggle
            count={archivedCount}
            expanded={showArchived}
            onToggle={() => setShowArchived((v) => !v)}
            t={t}
          />
        </div>
      )}
    </div>
  );
}
