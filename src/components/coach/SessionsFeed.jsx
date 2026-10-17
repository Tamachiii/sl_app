import { useEffect, useId, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useIsRestoring } from '@tanstack/react-query';
import Spinner from '../ui/Spinner';
import UserMenu from '../ui/UserMenu';
import {
  useReviewInbox,
  useConfirmationTotals,
  useConfirmationHistory,
} from '../../hooks/useSessionConfirmation';
import { useCoachSessionPositions } from '../../hooks/useProgram';
import { useStudents } from '../../hooks/useStudents';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { readState } from '../../lib/readState';
import { CoachReadProblem } from './CoachPageState';
import { isoDate, performedDate } from '../../lib/day';
import { dayName, formatDate, formatNumber, formatRelativeDays, pluralKey } from '../../lib/i18n/format';
import { capitalize } from '../student/sessionModel';
import { Avatar, Button, Count, Icon, LargeTitle, ListGroup, Row } from '../parc';
import {
  getLastCoachSession,
  getLastCoachSessionsStudent,
  rememberLastCoachSessionsStudent,
} from '../../hooks/useRememberCoachStudentsPath';

// The day a session was trained, as the heading of its group: « Aujourd'hui »,
// « Hier », the weekday within the week, the date beyond it — with the year
// when it is not this one.
function dayHeading(date, { t, lang }, now = new Date()) {
  if (!date) return t('parcSessions.undated');
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const ago = Math.round((today - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / 86400000);
  if (ago === 0 || ago === 1) return capitalize(formatRelativeDays(lang, -ago));
  if (ago > 1 && ago < 7) return capitalize(dayName(lang, ((date.getDay() + 6) % 7) + 1, 'long'));
  return capitalize(
    formatDate(lang, date, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
    }),
  );
}

// The sessions of a list, grouped by the day they were trained, newest day
// first; inside a day, the order the read gave. A session without a date
// closes the list.
function groupByDay(rows) {
  const groups = new Map();
  for (const row of rows) {
    const date = performedDate(row);
    const key = date ? isoDate(date) : '';
    if (!groups.has(key)) groups.set(key, { key, date, rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].sort((a, b) => (a.key === b.key ? 0 : !a.key ? 1 : !b.key ? -1 : a.key < b.key ? 1 : -1));
}

// One section per day: its heading, then the sessions of that day.
function DayGroups({ rows, renderRow, level = 2 }) {
  const ctx = useI18n();
  const Heading = `h${level}`;
  return groupByDay(rows).map((group) => (
    <DaySection key={group.key || 'undated'} heading={dayHeading(group.date, ctx)} Heading={Heading}>
      {group.rows.map(renderRow)}
    </DaySection>
  ));
}

function DaySection({ heading, Heading, children }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2.5">
      <Heading id={id} className="pk-headline">
        {heading}
      </Heading>
      <ul className="pk-group">{children}</ul>
    </section>
  );
}

// The pages of the history read so far, the button that reads the next one,
// and what a read that failed says. `read` is a `useConfirmationHistory`.
function HistoryList({ read, renderRow, level, t }) {
  const online = useOnlineStatus();
  const state = readState([read], { online, restoring: false });
  if (state === 'loading') return <div className="flex justify-center py-6"><Spinner /></div>;
  if (state !== 'ready') {
    return (
      <CoachReadProblem
        compact
        state={state}
        onRetry={() => read.refetch({ cancelRefetch: false })}
        retrying={read.isFetching}
      />
    );
  }
  return (
    <>
      <DayGroups rows={read.data} renderRow={renderRow} level={level} />
      {read.isFetchNextPageError && (
        <p role="status" className="pk-caption text-center">
          {t('coachListsScale.loadMoreFailed')}
        </p>
      )}
      {read.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="on-ground" onClick={() => read.fetchNextPage()} disabled={read.isFetchingNextPage}>
            {read.isFetchingNextPage ? t('coachListsScale.loadingMore') : t('coachListsScale.loadMore')}
          </Button>
        </div>
      )}
    </>
  );
}

export default function SessionsFeed() {
  const { t, lang } = useI18n();
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const online = useOnlineStatus();
  const restoring = useIsRestoring();
  // Every session that waits for a review, of every athlete, read in full:
  // the inbox the feed opens on. The rest of the history is read a page at a
  // time, and only when its view is open (below).
  const inboxRead = useReviewInbox();
  const inbox = inboxRead.data;
  // The athletes of the filter are the coach's athletes — not the ones whose
  // confirmations happened to be read.
  const { data: students } = useStudents();
  // Where each session stands in its block. A read of its own that nothing
  // waits for: while it is missing, a card names the phase alone.
  const { data: positions } = useCoachSessionPositions();
  const [showArchived, setShowArchived] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const studentFilter = searchParams.get('student') || '';
  // Whether the coach was SENT here for one athlete: the roster's "N to
  // review" chip and the athlete page's "Sessions" action both link to
  // `?student=<id>`. Read once — the filter the coach picks afterwards in the
  // select is not an arrival.
  const [arrivedForStudent] = useState(() => !!searchParams.get('student'));

  // If the coach left a review open and tabbed to another section, bounce
  // them back into that review on return. Explicit "back" on the review
  // clears the saved state (see SessionReview), and so does a tap on the
  // Sessions tab while it is open. The memory lasts one launch
  // (hooks/useRememberCoachStudentsPath): a cold start opens on the feed.
  //
  // Not when they arrive for one athlete: that link names its destination,
  // and bouncing into whichever review was last left open — possibly another
  // athlete's — would make the chip land anywhere but on what it counts.
  useEffect(() => {
    if (arrivedForStudent) return;
    const saved = getLastCoachSession();
    if (!saved) return;
    navigate(
      `/coach/student/${saved.studentId}/session/${saved.sessionId}/review`,
      { replace: true },
    );
    // Only run on mount — re-running on every render would fight the nested
    // route's own effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore the last-picked student filter on mount if the URL has none.
  // Skip when a saved SessionReview is about to redirect (effect above) —
  // otherwise setSearchParams clobbers that redirect with /coach/sessions.
  useEffect(() => {
    if (studentFilter) return;
    if (getLastCoachSession()) return;
    const saved = getLastCoachSessionsStudent();
    if (!saved) return;
    const next = new URLSearchParams(searchParams);
    next.set('student', saved);
    setSearchParams(next, { replace: true });
    // Only run on mount — changes after mount flow through handleFilterChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const studentOptions = useMemo(
    () =>
      (students || [])
        .map((s) => ({ id: s.id, name: (s.profile?.full_name || '').trim() || t('parcSessions.unnamed') }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [students, t],
  );

  const needsReview = useMemo(
    () => (inbox || []).filter((c) => !studentFilter || c.student_id === studentFilter),
    [inbox, studentFilter],
  );

  // How many confirmations there are besides the inbox, for this filter:
  // counted by the database, never read. Unknown (null) while another
  // athlete's numbers are read, or when the count failed — then no empty
  // state that depends on it is claimed.
  const totalsRead = useConfirmationTotals(studentFilter);
  const totals = totalsRead.isPlaceholderData ? null : totalsRead.data ?? null;
  // The inbox is part of the active sessions; the larger of the two numbers
  // holds while the two reads disagree for a moment.
  const activeCount = totals ? Math.max(totals.active, needsReview.length) : null;
  const archivedCount = totals ? totals.archived : null;

  // The feed defaults to an inbox: only confirmations still awaiting review,
  // with "All" restoring the full history. One exception, for a coach who was
  // sent here for an athlete with nothing left to review: they get that
  // athlete's history instead of an "all caught up" empty page. An athlete
  // who DOES have sessions to review opens on them — that is what the chip
  // that links here counts. (Every `?student=` arrival used to open on "All",
  // which buried the three sessions to review among the reviewed ones.)
  //
  // `viewChoice` is null until the coach picks a view, so the default can
  // still follow the data when it arrives after the first render.
  //
  // Not before the inbox has answered: "nothing to review" is only known then,
  // and deciding earlier would send the history read for nothing.
  const [viewChoice, setViewChoice] = useState(null);
  const showAll = viewChoice ?? (inbox != null && arrivedForStudent && needsReview.length === 0);
  // "All": every session that is not archived, reviewed or not, newest first.
  const historyRead = useConfirmationHistory({ studentId: studentFilter, enabled: showAll });
  const archivedRead = useConfirmationHistory({ studentId: studentFilter, archived: true, enabled: showArchived });
  // Handed to the review so its back button returns to this feed AND this
  // filter; without it the athlete filter of a `?student=` arrival is lost.
  const here = location.pathname + location.search;

  function handleFilterChange(e) {
    const value = e.target.value;
    const next = new URLSearchParams(searchParams);
    if (value) next.set('student', value);
    else next.delete('student');
    setSearchParams(next, { replace: true });
    rememberLastCoachSessionsStudent(value);
  }

  const inboxState = readState([inboxRead], { online, restoring });
  const menu = <UserMenu fullName={profile?.full_name} onSignOut={signOut} />;
  if (inboxState === 'loading' || (inboxState === 'ready' && totalsRead.isLoading)) {
    return (
      <div className="flex flex-col gap-6 px-4 pt-3 pb-6 md:px-8">
        <LargeTitle title={t('parcSessions.title')} trailing={menu} />
        <div className="flex justify-center py-12"><Spinner /></div>
      </div>
    );
  }

  function renderRow(c) {
    const isArchived = !!c.archived_at;
    const isReviewed = !!c.reviewed_at;
    const position = positions?.[c.session_id];
    const name = (c.student_name || '').trim() || t('parcSessions.unnamed');
    // Where the session sits: its name, its phase and its place in the block,
    // as the Programming sheet says them. Not "W3 · D2": a phase is not a
    // calendar week, and a session no longer needs a weekday (review item
    // L14). An untitled session is named by its place — "Session null" was
    // the day number of a session that has none (review item B28).
    const place = position ? { n: formatNumber(lang, position.n), total: formatNumber(lang, position.total) } : null;
    const where = [
      c.session_title || (place ? t('parcSessions.sessionOf', place) : t('parcSessions.untitled')),
      c.week_label,
      c.session_title && place ? t('parcSessions.placeOf', place) : null,
    ].filter(Boolean).join(', ');
    const status = [
      isReviewed ? t('parcSessions.reviewed') : null,
      isArchived ? t('parcSessions.archived') : null,
    ].filter(Boolean).join(', ');
    return (
      <Row
        key={c.id}
        to={`/coach/student/${c.student_id}/session/${c.session_id}/review`}
        state={{ from: here }}
        leading={<Avatar name={name} />}
      >
        <span className="pk-headline">{name}</span>
        {/* The commas are for a screen reader, which reads the row as one name. */}
        <span className="pk-caption">
          <span className="sr-only">,</span> {where}
        </span>
        {status && (
          <span className="pk-caption">
            <span className="sr-only">,</span> {status}
          </span>
        )}
        {c.notes && (
          <span className="mt-1 flex items-start gap-1.5 text-[14px] leading-[1.4] text-ink-2">
            <Icon name="note" size={16} className="mt-0.5 shrink-0" />
            <span className="sr-only">,</span>{' '}
            <span className="line-clamp-2 whitespace-pre-wrap">{c.notes}</span>
          </span>
        )}
      </Row>
    );
  }

  const subtitle =
    inbox == null
      ? null
      : needsReview.length > 0
        ? t(pluralKey(lang, needsReview.length, 'parcSessions.toReview'), { n: formatNumber(lang, needsReview.length) })
        : t('parcSessions.nothingToReview');

  return (
    <div className="flex flex-col gap-6 px-4 pt-3 pb-6 md:px-8">
      <header className="flex flex-col gap-4">
        <LargeTitle
          title={t('parcSessions.title')}
          subtitle={subtitle}
          trailing={menu}
        />

        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          {/* Unknown numbers keep the controls: the history can still be asked for. */}
          {(needsReview.length > 0 || activeCount !== 0 || archivedCount !== 0) && (
            <div className="flex gap-2" role="group" aria-label={t('parcSessions.filterLabel')}>
              <button
                type="button"
                aria-pressed={!showAll}
                onClick={() => setViewChoice(false)}
                className="pk-chip inline-flex items-center gap-2"
              >
                {t('parcSessions.filterToReview')}
                {needsReview.length > 0 && (
                  <>
                    <span className="sr-only">,</span>{' '}
                    <Count count={needsReview.length} countLabel={formatNumber(lang, needsReview.length)} />
                  </>
                )}
              </button>
              <button
                type="button"
                aria-pressed={showAll}
                onClick={() => setViewChoice(true)}
                className="pk-chip"
              >
                {t('parcSessions.filterDone')}
              </button>
            </div>
          )}

          {studentOptions.length > 0 && (
            <label className="flex flex-col gap-1.5 md:w-72">
              <span className="pk-caption">{t('parcSessions.athlete')}</span>
              <span className="relative">
                <select
                  value={studentFilter}
                  onChange={handleFilterChange}
                  className="pk-field appearance-none pr-10"
                >
                  <option value="">{t('parcSessions.allAthletes')}</option>
                  {studentOptions.map((o) => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </select>
                <Icon
                  name="chevron-down"
                  size={18}
                  className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-ink-2"
                />
              </span>
            </label>
          )}
        </div>
      </header>

      {(inboxState === 'offline' || inboxState === 'failed') && (
        <CoachReadProblem
          state={inboxState}
          onRetry={() => inboxRead.refetch({ cancelRefetch: false })}
          retrying={inboxRead.isFetching}
        />
      )}

      {inbox != null && activeCount === 0 && archivedCount === 0 && (
        <EmptyNote>{studentFilter ? t('parcSessions.noneForAthlete') : t('parcSessions.noneYet')}</EmptyNote>
      )}
      {inbox != null && activeCount === 0 && archivedCount > 0 && !showArchived && (
        <EmptyNote>{t('parcSessions.allArchived')}</EmptyNote>
      )}
      {inbox != null && !showAll && needsReview.length === 0 && activeCount !== 0 && (
        <EmptyNote>{t('parcSessions.allReviewed')}</EmptyNote>
      )}

      {showAll ? (
        activeCount !== 0 && <HistoryList read={historyRead} renderRow={renderRow} t={t} />
      ) : (
        <DayGroups rows={needsReview} renderRow={renderRow} />
      )}

      {archivedCount > 0 && (
        <ListGroup title={t('parcSessions.archivedTitle')}>
          <Row
            onClick={() => setShowArchived((v) => !v)}
            aria-expanded={showArchived}
            title={t(pluralKey(lang, archivedCount, 'parcSessions.archivedCount'), {
              n: formatNumber(lang, archivedCount),
            })}
            chevron={showArchived ? 'chevron-up' : 'chevron-down'}
          />
        </ListGroup>
      )}

      {showArchived && archivedCount !== 0 && (
        <HistoryList read={archivedRead} renderRow={renderRow} level={3} t={t} />
      )}
    </div>
  );
}

function EmptyNote({ children }) {
  return <p className="rounded-group bg-surface p-4 pk-body">{children}</p>;
}
