import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useIsRestoring } from '@tanstack/react-query';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
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
import { performedDate } from '../../lib/day';
import { formatDate } from '../../lib/i18n/format';
import {
  getLastCoachSession,
  getLastCoachSessionsStudent,
  rememberLastCoachSessionsStudent,
} from '../../hooks/useRememberCoachStudentsPath';

// The pages of the history read so far, the button that reads the next one,
// and what a read that failed says. `read` is a `useConfirmationHistory`.
function HistoryList({ read, renderCard, t }) {
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
      <div className="space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0">{read.data.map(renderCard)}</div>
      {read.isFetchNextPageError && (
        <p role="status" className="text-center text-[13px] text-ink-400">
          {t('coachListsScale.loadMoreFailed')}
        </p>
      )}
      {read.hasNextPage && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => read.fetchNextPage()}
            disabled={read.isFetchingNextPage}
            className="sl-pill sl-pill-btn bg-ink-100 text-ink-700 hover:bg-ink-200 disabled:opacity-50"
          >
            {read.isFetchingNextPage ? t('coachListsScale.loadingMore') : t('coachListsScale.loadMore')}
          </button>
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
        .map((s) => ({ id: s.id, name: s.profile?.full_name || 'Student' }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [students],
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
  if (inboxState === 'loading' || (inboxState === 'ready' && totalsRead.isLoading)) {
    return <div className="flex justify-center py-12"><Spinner /></div>;
  }

  function renderCard(c) {
    const isArchived = !!c.archived_at;
    const isReviewed = !!c.reviewed_at;
    const position = positions?.[c.session_id];
    // Where the session sits: the name of its phase and its place in the
    // block, as the Programming sheet says them. Not "W3 · D2": a phase is not
    // a calendar week, and a session no longer needs a weekday — the card
    // ended in a bare "· D", or read "W1 · W1 · D2" (review item L14).
    const where = [
      c.week_label,
      position ? t('coach.roster.sessionOf', { n: position.n, total: position.total }) : null,
    ].filter(Boolean).join(' · ');
    return (
      <Link
        key={c.id}
        to={`/coach/student/${c.student_id}/session/${c.session_id}/review`}
        state={{ from: here }}
        className={`block sl-card p-4 space-y-1 hover:bg-ink-50 transition-colors ${
          isArchived ? 'opacity-75' : ''
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <span
            className="sl-mono text-[11px] truncate"
            style={{ color: 'var(--color-accent)' }}
          >
            {c.student_name}
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            {isReviewed && (
              <span
                className="sl-pill text-ink-900"
                style={{
                  background: 'color-mix(in srgb, var(--color-success) 18%, transparent)',
                }}
              >
                {t('coach.sessions.reviewed')}
              </span>
            )}
            {isArchived && (
              <span
                className="sl-pill text-ink-900"
                style={{
                  background: 'color-mix(in srgb, var(--color-warn) 18%, transparent)',
                }}
              >
                {t('common.archived')}
              </span>
            )}
            {/* The day the athlete trained, not the day the confirmation
                reached the server — which, for one sent offline, is the day
                the queue was replayed. */}
            <span className="sl-mono text-[11px] text-ink-400">
              {formatDate(lang, performedDate(c))}
            </span>
          </div>
        </div>
        <h3 className={`sl-display text-[16px] ${isArchived ? 'text-ink-600' : 'text-gray-900'}`}>
          {/* An untitled session is named by its place in the block, as the
              sheet names it — "Session null" was the day number of a session
              that has none (review item B28). */}
          {c.session_title
            || (position ? t('coach.week.sessionN', { n: position.n }) : t('coach.editor.titlePlaceholder'))}
        </h3>
        {where && <p className="sl-mono text-[11px] text-ink-400">{where}</p>}
        {c.notes && (
          <p className="mt-2 text-[13px] text-ink-700 whitespace-pre-wrap">{c.notes}</p>
        )}
      </Link>
    );
  }

  return (
    <div className="p-4 pb-6 md:p-8 space-y-5">
      <div className="pt-3 pb-1 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="sl-label text-ink-400">{t('coach.sessions.kicker')}</div>
          <h1 className="sl-display text-[28px] md:text-[40px] text-gray-900 leading-none mt-1">
            {t('coach.sessions.title')}
          </h1>
        </div>
        <UserMenu fullName={profile?.full_name} onSignOut={signOut} />
      </div>

      {studentOptions.length > 0 && (
        <label className="flex items-center gap-2">
          <span className="sl-label text-ink-400">{t('coach.sessions.student')}</span>
          <select
            value={studentFilter}
            onChange={handleFilterChange}
            className="flex-1 rounded-lg border border-ink-200 bg-white px-3 py-1.5 sl-mono text-[16px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
          >
            <option value="">{t('coach.sessions.allStudents')}</option>
            {studentOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </label>
      )}

      {(inboxState === 'offline' || inboxState === 'failed') && (
        <CoachReadProblem
          state={inboxState}
          onRetry={() => inboxRead.refetch({ cancelRefetch: false })}
          retrying={inboxRead.isFetching}
        />
      )}

      {/* Unknown numbers keep the controls: the history can still be asked for. */}
      {(needsReview.length > 0 || activeCount !== 0 || archivedCount !== 0) && (
        <div
          className="flex items-center gap-1.5"
          role="group"
          aria-label={t('coach.sessions.reviewFilterLabel')}
        >
          <button
            type="button"
            aria-pressed={!showAll}
            onClick={() => setViewChoice(false)}
            className={`sl-pill ${
              !showAll ? 'bg-accent text-ink-900' : 'bg-ink-100 text-ink-700 hover:bg-ink-200'
            }`}
          >
            {t('coach.sessions.filterNeedsReview')}
            {needsReview.length > 0 ? ` · ${needsReview.length}` : ''}
          </button>
          <button
            type="button"
            aria-pressed={showAll}
            onClick={() => setViewChoice(true)}
            className={`sl-pill ${
              showAll ? 'bg-accent text-ink-900' : 'bg-ink-100 text-ink-700 hover:bg-ink-200'
            }`}
          >
            {t('coach.sessions.filterAll')}
          </button>
        </div>
      )}

      {inbox != null && activeCount === 0 && archivedCount === 0 && (
        <EmptyState message={studentFilter ? t('coach.sessions.noneForStudent') : t('coach.sessions.noneYet')} />
      )}
      {inbox != null && activeCount === 0 && archivedCount > 0 && !showArchived && (
        <EmptyState message={t('coach.sessions.allArchived')} />
      )}
      {inbox != null && !showAll && needsReview.length === 0 && activeCount !== 0 && (
        <EmptyState message={t('coach.sessions.allReviewed')} />
      )}

      {showAll ? (
        activeCount !== 0 && <HistoryList read={historyRead} renderCard={renderCard} t={t} />
      ) : (
        <div className="space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0">{needsReview.map(renderCard)}</div>
      )}

      {archivedCount > 0 && (
        <button
          type="button"
          onClick={() => setShowArchived((v) => !v)}
          className="w-full sl-mono text-[11px] text-ink-400 hover:text-ink-700 py-2 underline"
        >
          {showArchived
            ? t('coach.sessions.hideArchived', { n: archivedCount })
            : t('coach.sessions.showArchived', { n: archivedCount })}
        </button>
      )}

      {showArchived && archivedCount !== 0 && <HistoryList read={archivedRead} renderCard={renderCard} t={t} />}
    </div>
  );
}
