import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { useStudentProgramDetails } from '../../hooks/useStudentProgramDetails';
import { useMyConfirmedSessionIds } from '../../hooks/useSessionConfirmation';
import { useMyFeedbackSessionIds } from '../../hooks/useMessages';
import { DAY_FULL_LONG, parseISODate, performedDate } from '../../lib/day';
import { buildQueue, flattenSessions } from '../../lib/sessionQueue';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import UserMenu from '../ui/UserMenu';
import SessionCard from './SessionCard';

const LOCALE = { en: 'en-US', fr: 'fr-FR', de: 'de-DE' };

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
  const { data: weeks, isLoading } = useStudentProgramDetails(user?.id, { allPrograms: true });
  const { data: confirmedIds = new Set() } = useMyConfirmedSessionIds();
  const { data: feedbackIds = new Set() } = useMyFeedbackSessionIds();

  const [showArchived, setShowArchived] = useState(false);
  const [openSessionId, setOpenSessionId] = useState(null);

  const activeWeeks = useMemo(
    () => (weeks || []).filter((w) => w.program?.is_active),
    [weeks]
  );

  // The queue is the ACTIVE block only. A past block's unfinished sessions are
  // history the athlete moved on from, not work that is somehow still due.
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
    // Finished work reads newest-first, by the day it was really trained.
    // Sessions with no recorded date (confirmed before the column existed)
    // sink below the dated ones rather than jumping to the top.
    dn.sort((a, b) => {
      const da = performedDate(a);
      const db = performedDate(b);
      if (da && db) return db - da;
      if (da) return -1;
      if (db) return 1;
      return 0;
    });
    return { upcoming: up, done: dn };
  }, [activeWeeks, confirmedIds, showArchived]);

  // Past blocks: everything in them is history, newest block first.
  const pastPrograms = useMemo(() => {
    const byProgram = new Map();
    for (const w of weeks || []) {
      if (w.program?.is_active) continue;
      const pid = w.program?.id ?? '__none__';
      if (!byProgram.has(pid)) byProgram.set(pid, { program: w.program, sessions: [] });
      for (const s of w.sessions || []) {
        if (s.archived_at && !showArchived) continue;
        byProgram.get(pid).sessions.push(s);
      }
    }
    const groups = [...byProgram.values()].filter((g) => g.sessions.length > 0);
    for (const g of groups) {
      g.sessions.sort((a, b) => {
        const da = performedDate(a);
        const db = performedDate(b);
        if (da && db) return db - da;
        if (da) return -1;
        if (db) return 1;
        return 0;
      });
    }
    groups.sort((a, b) => (b.program?.sort_order ?? 0) - (a.program?.sort_order ?? 0));
    return groups;
  }, [weeks, showArchived]);

  const archivedCount = useMemo(
    () =>
      (weeks || []).reduce(
        (n, w) => n + (w.sessions || []).filter((s) => s.archived_at).length,
        0
      ),
    [weeks]
  );

  if (isLoading) {
    return (
      <div className="p-4">
        <h1 className="sr-only">Training</h1>
        <div className="flex justify-center py-12"><Spinner /></div>
      </div>
    );
  }

  const next = upcoming[0] ?? null;
  const later = upcoming.slice(1);

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
    onStart: () => navigate(`/student/session/${session.id}`),
    open: openSessionId === session.id,
    onToggle: () => setOpenSessionId((id) => (id === session.id ? null : session.id)),
  });

  return (
    <div className="p-4 pb-6 md:p-8 space-y-6">
      <Greeting fullName={profile?.full_name} queue={queue} onSignOut={signOut} />

      {!weeks?.length && <EmptyState message={t('student.home.noProgram')} />}

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
              <SessionCard
                {...cardProps(next)}
                collapsible={false}
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

      {pastPrograms.map((group) => (
        <Drawer
          key={group.program?.id ?? 'no-program'}
          headingId={`program-${group.program?.id ?? 'none'}-heading`}
          title={group.program?.name || ''}
          meta={`${t('student.sessions.pastProgram')} · ${t(
            group.sessions.length === 1
              ? 'student.training.sessionsOne'
              : 'student.training.sessionsMany',
            { n: group.sessions.length }
          )}`}
          renderBody={() =>
            group.sessions.map((s) => (
              <SessionCard
                key={s.id}
                {...cardProps(s, { readOnly: true })}
                subtitle={formatDoneDate(s, lang)}
              />
            ))
          }
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
