import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
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
import { buildQueue, flattenSessions } from '../../lib/sessionQueue';
import { readState } from '../../lib/readState';
import { isLoggedSet } from '../../lib/loggedSets';
import { formatNumber, formatRelativeDays, pluralKey } from '../../lib/i18n/format';
import { prescriptionText } from '../../lib/prescriptionText';
import Spinner from '../ui/Spinner';
import UserMenu from '../ui/UserMenu';
import { Button, Icon, LargeTitle, ListGroup, Row, StatusText, WeekDots } from '../parc';
import Unavailable from './Unavailable';
import {
  newestTrainedFirst,
  placesOf,
  positionsOf,
  trainedOnText,
  weekOf,
  weekSentence,
  whenText,
} from './trainingModel';

// Stable stand-ins for "not read yet", so a memo that depends on them does not
// run again on every render.
const NO_WEEKS = [];
const NO_IDS = new Set();

// How many of the sessions after the next one « Ensuite » shows before
// « Voir les n autres séances ».
const THEN_SHOWN = 3;

/**
 * The athlete's ONE training surface (design/parc/screens/Entrainement.dc.html):
 * the next session in a panel with its exercises and « Commencer la séance »,
 * the sessions after it in program order, and the history in closed rows.
 *
 * This replaced a Home page and a Sessions page that both listed sessions and
 * both offered "start the next one". It shows no Mon–Sun grid with arrows —
 * that framing is what the block was rewritten to stop imposing — only the
 * seven dots of the week the athlete is in.
 *
 * Finished sessions are ordered by the day they were ACTUALLY trained — the
 * only order that means anything once the athlete stops following a calendar.
 */

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

function exercisesText(n, { t, lang }) {
  return t(pluralKey(lang, n, 'parcTraining.exercises'), { n: formatNumber(lang, n) });
}

/**
 * The page's title, the place in the block, and the week in seven dots with
 * one line beside them: how many sessions were done this week — or, in a
 * week with none, when the last one was, or that there was never one.
 *
 * `neverTrained`: no confirmation in any block. The queue knows the block
 * being trained only, so "No sessions logged yet" went to an athlete with 24
 * confirmed sessions in the blocks before it (live N7). It is said when it is
 * true, and only then. That athlete, in a block with nothing done yet, read
 * nothing at all beside the dots: the line says the block has not begun.
 */
function Header({ fullName, onSignOut, subtitle, week, queue, neverTrained }) {
  const { t, lang } = useI18n();
  let line = null;
  if (week?.doneCount > 0) {
    line = t(pluralKey(lang, week.doneCount, 'parcTraining.weekCount'), {
      n: formatNumber(lang, week.doneCount),
    });
  } else if (queue?.daysSinceLast != null) {
    line = t('parcTraining.lastTrained', { when: formatRelativeDays(lang, -queue.daysSinceLast) });
  } else if (neverTrained && queue?.total > 0) {
    line = t('parcTraining.neverTrained');
  } else if (neverTrained === false && queue?.total > 0 && queue.completed === 0) {
    line = t('parcTraining.blockNotStarted');
  }
  return (
    <header>
      <LargeTitle
        title={t('nav.training')}
        subtitle={subtitle}
        trailing={<UserMenu fullName={fullName} onSignOut={onSignOut} profileHref="/student/profile" />}
      />
      {week && (
        <div className="mt-3 flex items-center gap-3">
          <WeekDots days={week.days} label={weekSentence(week, { t, lang })} />
          {line && <span className="pk-caption">{line}</span>}
        </div>
      )}
      {!week && line && <p className="pk-caption mt-3">{line}</p>}
    </header>
  );
}

/**
 * The next session, open: when it is planned, its name, its place and its
 * exercises with what each asks for, and « Commencer la séance ».
 */
function NextSession({ session, position, hasFeedback }) {
  const { t, lang } = useI18n();
  const titleId = useId();
  const ctx = { t, lang };
  const slots = session.exercise_slots || [];
  const when = whenText(session, ctx);
  const facts = [
    position ? t('parcTraining.sessionN', { n: formatNumber(lang, position) }) : null,
    exercisesText(slots.length, ctx),
    hasFeedback ? t('parcTraining.feedback') : null,
  ].filter(Boolean);
  return (
    <section aria-labelledby={titleId} className="pk-panel">
      <p className="text-[15px] font-bold leading-[1.4] text-blue">
        {when ? t('parcTraining.nextWhen', { when }) : t('parcTraining.next')}
      </p>
      <h2 id={titleId} className="pk-large-title mt-1.5 break-words">
        {session.title || t('parcTraining.sessionN', { n: formatNumber(lang, position) })}
      </h2>
      <p className="pk-caption mt-1.5">{facts.join(', ')}</p>
      {slots.length === 0 ? (
        <p className="pk-caption mt-3">{t('parcTraining.noExercises')}</p>
      ) : (
        <ul className="m-0 mt-3 list-none p-0">
          {slots.map((slot) => (
            <li key={slot.id} className="flex items-baseline justify-between gap-3 border-t border-line py-3">
              {/* An exercise whose library row the athlete may not read (a
                  former coach's library: the embed is null) keeps its row. */}
              <span className="pk-body min-w-0 font-semibold">
                {slot.exercise?.name ?? t('sessionNavPastReview.exerciseUnavailable')}
              </span>
              <span className="pk-caption shrink-0 text-right">{prescriptionText(slot, ctx)}</span>
            </li>
          ))}
        </ul>
      )}
      <Button
        as={Link}
        to={`/student/session/${session.id}`}
        variant="primary"
        size="lg"
        className="mt-4 flex w-full"
      >
        {t('parcTraining.start')}
      </Button>
    </section>
  );
}

/**
 * A row of the history that opens in place: this block's finished sessions,
 * or a whole past block. History is something the athlete goes looking for,
 * never something the landing page spends its height on: `renderBody` is a
 * function, so a closed row builds NOTHING, however long the history is.
 *
 * Open state is deliberately not kept: one opens a row to look one thing up,
 * and the page is clean again next visit.
 */
function HistoryRow({ title, subtitle, renderBody }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <li>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="pk-row w-full bg-transparent text-left"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="pk-headline">{title}</span>
            {subtitle && (
              <span className="pk-caption">
                <span className="sr-only">,</span> {subtitle}
              </span>
            )}
          </span>
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} className="shrink-0 text-ink-2" />
        </button>
      </li>
      {open && renderBody()}
    </>
  );
}

/**
 * What an open past-block row holds: that block's sessions, read when the row
 * opens and not before.
 *
 * The list's own read carries a past block as a name and a count, which is all
 * a closed row shows — and is why that read stays small enough to be the one
 * the device keeps. Because the query lives in this component, and a closed
 * row builds nothing, a block nobody opens is never asked for.
 */
function PastBlockSessions({ userId, programId, showArchived, renderRow }) {
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
  // The place of each session in THIS block, which names an untitled one.
  const places = useMemo(() => placesOf(weeks), [weeks]);

  const state = readState([block], { online, restoring });
  if (state === 'loading') {
    return (
      <li className="flex justify-center py-4">
        <Spinner />
      </li>
    );
  }
  if (state !== 'ready') {
    return (
      <li>
        <Unavailable
          compact
          title={t(
            state === 'offline' ? 'trainingListOffline.blockOffline' : 'trainingListOffline.blockError'
          )}
          onRetry={() => refetch({ cancelRefetch: false })}
        />
      </li>
    );
  }
  return sessions.map((s) => renderRow(s, places));
}

export default function StudentTraining() {
  const { user, profile, signOut } = useAuth();
  const { t, lang } = useI18n();
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
  const [showAllThen, setShowAllThen] = useState(false);

  const listState = readState([details, confirmations], { online, restoring });
  const ready = listState === 'ready';

  // The block being trained — the only one this read brings whole. A past
  // block's unfinished sessions are history the athlete moved on from, not
  // work that is somehow still due, so the queue is built from these alone.
  const activeWeeks = details.data?.weeks ?? NO_WEEKS;
  const confirmedIds = confirmations.data ?? NO_IDS;
  // Every confirmation of the athlete, whatever the block — and none known
  // until the read has answered: an unanswered read says nothing either way
  // (null).
  const neverTrained = confirmations.data == null ? null : confirmations.data.size === 0;

  const queue = useMemo(() => buildQueue(activeWeeks, confirmedIds), [activeWeeks, confirmedIds]);
  const positions = useMemo(() => positionsOf(activeWeeks), [activeWeeks]);
  // The place of every session, archived ones included: what names a session
  // of the history that has no title (an archived one has no position).
  const places = useMemo(() => placesOf(activeWeeks), [activeWeeks]);

  const activeProgramName = activeWeeks[0]?.program?.name || null;

  const { upcoming, done, allSessions } = useMemo(() => {
    const up = [];
    const dn = [];
    const all = [];
    for (const { session } of flattenSessions(activeWeeks)) {
      all.push(session);
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
    return { upcoming: up, done: dn, allSessions: all };
  }, [activeWeeks, confirmedIds, showArchived]);

  const week = useMemo(
    () =>
      activeWeeks.length > 0
        ? weekOf({ sessions: allSessions, upcoming: upcoming.filter((s) => !s.archived_at), confirmedIds })
        : null,
    [activeWeeks, allSessions, upcoming, confirmedIds]
  );

  // Past blocks, newest first, as the rows their closed drawers are: a name
  // and how many sessions the row would show. A block with nothing to show
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

  const ctx = { t, lang };

  if (listState === 'loading') {
    return (
      <div className="px-4 pt-3 md:px-8">
        <h1 className="sr-only">{t('nav.training')}</h1>
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
      <div className="flex flex-col gap-6 px-4 pt-3 pb-6 md:px-8">
        <Header fullName={profile?.full_name} onSignOut={signOut} />
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
  const laterShown = showAllThen ? later : later.slice(0, THEN_SHOWN);
  const laterHidden = later.length - laterShown.length;

  const subtitle =
    activeProgramName && queue.total > 0
      ? t('parcTraining.programPosition', {
          program: activeProgramName,
          n: formatNumber(lang, queue.position),
          total: formatNumber(lang, queue.total),
        })
      : activeProgramName;

  // The row of a finished session. `readOnly` covers sessions from a past
  // block: locked for logging both in the UI and by RLS. It must NOT block
  // opening one — reviewing what was done is the point of keeping history —
  // but a past-block session never trained has nothing to show and leads
  // nowhere. A past-block session trained in and never confirmed keeps its
  // way in: what was logged there is history too (L32).
  const historyRow = (session, { readOnly = false, blockPlaces = places } = {}) => {
    const confirmed = confirmedIds.has(session.id);
    const place = blockPlaces.get(session.id);
    const archived = !!session.archived_at;
    const opens = !archived && (confirmed || !readOnly || holdsLoggedSet(session));
    const trained = trainedOnText(session, lang);
    const subtitleParts = [trained, archived ? t('parcTraining.archived') : null].filter(Boolean);
    return (
      <Row
        key={session.id}
        to={opens ? `/student/session/${session.id}` : undefined}
        chevron={opens}
        leading={
          <span className={`pk-set-dot ${confirmed ? 'pk-set-dot-done' : 'pk-set-dot-pending'}`} aria-hidden="true">
            {confirmed ? <Icon name="check" size={16} strokeWidth={3} /> : place ?? '–'}
          </span>
        }
        title={
          session.title ||
          (place ? t('parcTraining.sessionN', { n: formatNumber(lang, place) }) : t('parcTraining.untitledSession'))
        }
        subtitle={subtitleParts.length ? subtitleParts.join(', ') : null}
        trailing={feedbackIds.has(session.id) ? <StatusText tone="review">{t('parcTraining.feedback')}</StatusText> : null}
      />
    );
  };

  const lastDone = done.find((s) => !s.archived_at && trainedOnText(s, lang));

  return (
    <div className="flex flex-col gap-6 px-4 pt-3 pb-6 md:px-8">
      <Header
        fullName={profile?.full_name}
        onSignOut={signOut}
        subtitle={subtitle}
        week={week}
        queue={queue}
        neverTrained={neverTrained}
      />

      {activeWeeks.length === 0 && pastPrograms.length === 0 && (
        <p className="rounded-group bg-surface p-4 pk-body">{t('parcTraining.noProgram')}</p>
      )}

      {/* From 1024px the next session and the lists stand side by side
          (design/parc/README.md, « Espacement et mise en page »). */}
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-2 lg:items-start">
        <div className="flex flex-col gap-6">
          {activeWeeks.length > 0 && next && (
            <NextSession session={next} position={positions.get(next.id)} hasFeedback={feedbackIds.has(next.id)} />
          )}

          {activeWeeks.length > 0 && !next && (
            <p className="rounded-group bg-surface p-4 pk-body">{t('parcTraining.blockComplete')}</p>
          )}
        </div>
        <div className="flex flex-col gap-6">
          {later.length > 0 && (
            <ListGroup title={t('parcTraining.then')}>
              {laterShown.map((session) => {
                const position = positions.get(session.id);
                const when = whenText(session, ctx);
                return (
                  <Row
                    key={session.id}
                    to={`/student/session/${session.id}`}
                    chevron={false}
                    leading={
                      <span
                        className="pk-set-dot pk-set-dot-pending pk-condensed text-[18px] font-extrabold"
                        aria-hidden="true"
                      >
                        {position}
                      </span>
                    }
                    title={session.title || t('parcTraining.sessionN', { n: formatNumber(lang, position) })}
                    subtitle={[
                      t('parcTraining.sessionN', { n: formatNumber(lang, position) }),
                      when ?? exercisesText((session.exercise_slots || []).length, ctx),
                    ].join(', ')}
                    trailing={
                      feedbackIds.has(session.id) ? (
                        <StatusText tone="review">{t('parcTraining.feedback')}</StatusText>
                      ) : null
                    }
                  />
                );
              })}
              {laterHidden > 0 && (
                <Row
                  onClick={() => setShowAllThen(true)}
                  title={
                    <span className="text-blue">
                      {t(pluralKey(lang, laterHidden, 'parcTraining.showMore'), {
                        n: formatNumber(lang, laterHidden),
                      })}
                    </span>
                  }
                />
              )}
            </ListGroup>
          )}

          {(done.length > 0 || pastPrograms.length > 0) && (
            <ListGroup title={t('parcTraining.history')}>
              {done.length > 0 && (
                <HistoryRow
                  title={t(pluralKey(lang, done.length, 'parcTraining.done'), {
                    n: formatNumber(lang, done.length),
                  })}
                  subtitle={
                    lastDone && queue.daysSinceLast != null
                      ? t('parcTraining.doneThisBlockLast', { when: formatRelativeDays(lang, -queue.daysSinceLast) })
                      : t('parcTraining.doneThisBlock')
                  }
                  renderBody={() => done.map((s) => historyRow(s))}
                />
              )}
              {pastPrograms.map(({ program, count }) => (
                <HistoryRow
                  key={program.id}
                  title={program.name || t('parcTraining.untitledBlock')}
                  subtitle={t(pluralKey(lang, count, 'parcTraining.pastBlock'), {
                    n: formatNumber(lang, count),
                  })}
                  renderBody={() => (
                    <PastBlockSessions
                      userId={user?.id}
                      programId={program.id}
                      showArchived={showArchived}
                      renderRow={(s, blockPlaces) => historyRow(s, { readOnly: true, blockPlaces })}
                    />
                  )}
                />
              ))}
            </ListGroup>
          )}

          {/* One quiet line rather than a control tucked inside a row the athlete
              would have to open first. Archived work is a rare lookup. */}
          {archivedCount > 0 && (
            <Button
              variant="text"
              className="self-start"
              aria-pressed={showArchived}
              onClick={() => setShowArchived((v) => !v)}
            >
              {t(
                pluralKey(lang, archivedCount, showArchived ? 'parcTraining.hideArchived' : 'parcTraining.showArchived'),
                { n: formatNumber(lang, archivedCount) }
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
