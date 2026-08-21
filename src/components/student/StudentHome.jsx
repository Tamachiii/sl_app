import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { useStudentProgramDetails } from '../../hooks/useStudentProgramDetails';
import { useMyConfirmedSessionIds } from '../../hooks/useSessionConfirmation';
import { useMyFeedbackSessionIds } from '../../hooks/useMessages';
import {
  DAY_LABELS,
  DAY_FULL,
  DAY_FULL_LONG,
  todayDayNumber,
  sessionDayNumber,
  parseISODate,
  isoDate,
  addDays,
  startOfWeekMonday,
} from '../../lib/day';
import { buildQueue, buildDayStrip } from '../../lib/sessionQueue';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import UserMenu from '../ui/UserMenu';
import SessionCard from './SessionCard';

const LOCALE = { en: 'en-US', fr: 'fr-FR', de: 'de-DE' };

// "Jul 6 – 12" (en) / "6 – 12 juil." (fr) — compact label for the displayed week.
function formatWeekRange(monday, lang) {
  const locale = LOCALE[lang] || LOCALE.en;
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).formatRange(
    monday,
    addDays(monday, 6)
  );
}

// ─── Day strip cell ────────────────────────────────────────────────────────

// A cell is one of:
//   performed — the student trained this session on this date. The truth.
//   planned   — a recommended date the coach set, not yet trained.
//   suggested — no date at all, just a recommended weekday. Drawn dashed so it
//               reads as advice rather than a commitment.
//   rest      — nothing here.
// There is deliberately no "missed" state: a session not done on its
// recommended day is still next in the queue, not a failure.
function DayCell({ dayLabel, dayName, dateNumber, session, state, isToday, onClick }) {
  const { t } = useI18n();
  const hasSession = !!session;
  const archived = state === 'archived';
  const performed = state === 'performed';
  const suggested = state === 'suggested';
  const interactive = hasSession && !performed && !archived;

  let cellClass;
  if (archived || !hasSession) {
    cellClass = 'bg-ink-50 text-ink-400 border border-transparent';
  } else if (performed) {
    cellClass = 'bg-white border border-ink-100 text-gray-900';
  } else if (isToday) {
    cellClass = 'bg-accent text-ink-900 border border-transparent';
  } else if (suggested) {
    cellClass = 'bg-transparent border border-dashed border-ink-100 text-ink-600';
  } else {
    cellClass = 'bg-white border border-ink-100 text-gray-900';
  }

  const shortTitle = (session?.title || (hasSession ? '' : 'Rest')).toUpperCase();
  // Aria uses the full weekday name plus the day-of-month so screen readers
  // can tell navigated weeks apart — the button's aria-label masks its inner
  // text, so the visible date number alone is not exposed to AT.
  const dayWord = dateNumber != null ? `${dayName || dayLabel} ${dateNumber}` : dayName || dayLabel;
  let ariaLabel;
  if (!hasSession) ariaLabel = `${dayWord} — rest day`;
  else if (archived) ariaLabel = `${dayWord} — ${session.title} (archived)`;
  else if (performed) ariaLabel = `${dayWord} — ${session.title} (${t('common.done')})`;
  else if (suggested) ariaLabel = `${dayWord} — ${session.title} (${t('student.home.suggestedDay')})`;
  else ariaLabel = `${dayWord} — ${session.title}`;

  return (
    <button
      onClick={interactive && onClick ? onClick : undefined}
      disabled={!interactive}
      aria-label={ariaLabel}
      className={`relative flex-1 min-w-0 rounded-xl h-[108px] px-1.5 py-2 flex flex-col items-center gap-1.5 overflow-hidden transition-transform ${cellClass} ${
        interactive ? 'cursor-pointer active:scale-95' : 'cursor-default'
      }`}
    >
      <span className="sl-mono text-[10px] font-semibold opacity-70 text-center leading-tight">
        {dayLabel}
        {dateNumber != null && (
          <span className="block text-[9px] font-normal opacity-80">{dateNumber}</span>
        )}
      </span>
      <span
        className="sl-display flex-1 min-h-0 leading-none tracking-wide"
        style={{
          writingMode: 'vertical-rl',
          transform: 'rotate(180deg)',
          fontSize: shortTitle.length > 6 ? 11 : 12,
          opacity: hasSession && !archived && !suggested ? 1 : 0.55,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          textDecoration: archived ? 'line-through' : undefined,
        }}
      >
        {shortTitle}
      </span>
      {performed && (
        <span
          aria-hidden="true"
          className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full"
          style={{ background: 'var(--color-accent)' }}
        />
      )}
    </button>
  );
}

// ─── Greeting block ────────────────────────────────────────────────────────

// Name plus an ACTIVITY line, not an adherence line. "2/3 sessions done this
// week" measured the student against a calendar the plan no longer imposes;
// "last trained 3 days ago · 2 in the last 7 days" states what they did, which
// is the only thing the new model treats as fact.
function Greeting({ fullName, activity, onSignOut }) {
  const { t, lang } = useI18n();
  const firstName = (fullName || '').split(' ')[0] || 'there';

  let line = null;
  if (activity.daysSinceLast == null) {
    line = t('student.home.neverTrained');
  } else if (activity.daysSinceLast === 0) {
    line = t('student.home.trainedToday');
  } else {
    let when = '';
    try {
      when = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(
        -activity.daysSinceLast,
        'day'
      );
    } catch {
      when = '';
    }
    line = when ? t('student.home.lastTrained', { when }) : null;
  }
  if (line && activity.doneLast7 > 0) {
    const count = t(
      activity.doneLast7 === 1 ? 'student.home.last7One' : 'student.home.last7Many',
      { n: activity.doneLast7 }
    );
    line = `${line} · ${count}`;
  }

  return (
    <div
      title={fullName ? `Student · ${fullName}` : undefined}
      className="pt-3 pb-1"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="sl-display text-[32px] md:text-[44px] text-gray-900 truncate">{t('student.home.hey')}, {firstName}.</div>
          {line && <p className="sl-mono text-[11px] text-ink-400 mt-2">{line}</p>}
        </div>
        <UserMenu fullName={fullName} onSignOut={onSignOut} profileHref="/student/profile" />
      </div>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────

export default function StudentHome() {
  const { user, profile, signOut } = useAuth();
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const { data: weeks, isLoading } = useStudentProgramDetails(user?.id);
  const { data: confirmedIds = new Set() } = useMyConfirmedSessionIds();
  const { data: feedbackIds = new Set() } = useMyFeedbackSessionIds();

  const todayDN = todayDayNumber();

  // 0 = the real current calendar week; ±n navigates n weeks away.
  const [weekOffset, setWeekOffset] = useState(0);

  // The queue IS the plan: position in the block decides what comes next, and
  // the calendar below only records what happened.
  const queue = useMemo(
    () => buildQueue(weeks, confirmedIds),
    [weeks, confirmedIds]
  );
  const upcoming = queue.upcoming;

  const allSessions = useMemo(
    () =>
      (weeks || []).flatMap((w) =>
        (w.sessions || []).map((s) => ({ session: s, week: w }))
      ),
    [weeks]
  );

  const todayIso = isoDate(new Date());
  const currentMonday = useMemo(() => startOfWeekMonday(new Date()), [todayIso]);
  const displayedMonday = useMemo(
    () => addDays(currentMonday, weekOffset * 7),
    [currentMonday, weekOffset]
  );

  // Placement lives in lib/sessionQueue so the coach roster's strip and this
  // one can't drift apart. Decorate the shared slots with display labels here.
  const daySlots = useMemo(() => {
    const slots = buildDayStrip({
      sessions: allSessions.map((e) => e.session),
      upcoming: upcoming.map((e) => e.session),
      confirmedIds,
      monday: displayedMonday,
      // Recommendations only make sense on the week the student is in.
      weekdayFallback: weekOffset === 0,
    });
    return slots.map((slot, i) => ({
      ...slot,
      label: DAY_LABELS[i],
      name: DAY_FULL_LONG[i],
      dateNumber: addDays(displayedMonday, i).getDate(),
    }));
  }, [allSessions, upcoming, confirmedIds, displayedMonday, weekOffset]);

  if (isLoading) {
    return (
      <>
        <h1 className="sr-only">Home</h1>
        <div className="flex justify-center py-12"><Spinner /></div>
      </>
    );
  }

  if (!weeks?.length) {
    return (
      <>
        <h1 className="sr-only">Home</h1>
        <div className="p-4"><EmptyState message={t('student.home.noProgram')} /></div>
      </>
    );
  }

  const next = upcoming[0]?.session ?? null;
  const then = upcoming.slice(1, 3);

  // A real date beats a bare weekday name — "Mon" alone reads as this week's
  // Monday even when the session is weeks out.
  const subtitleFor = (session) => {
    const d = session.scheduled_date ? parseISODate(session.scheduled_date) : null;
    if (d) {
      return d.toLocaleDateString(LOCALE[lang] || LOCALE.en, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      });
    }
    const dn = sessionDayNumber(session);
    return dn >= 1 && dn <= 7 ? DAY_FULL[dn - 1] : null;
  };

  return (
    <>
      <h1 className="sr-only">Home</h1>
      <div className="p-4 md:p-8 space-y-6">

        {profile?.full_name && (
          <Greeting
            fullName={profile.full_name}
            activity={queue}
            onSignOut={signOut}
          />
        )}

        <section aria-label="Week overview">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="sl-label truncate" aria-live="polite">
              {formatWeekRange(displayedMonday, lang)}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {weekOffset !== 0 && (
                <button
                  onClick={() => setWeekOffset(0)}
                  className="sl-mono text-[11px] text-ink-400 hover:text-gray-700 underline px-1.5 py-1"
                >
                  {t('student.home.backToToday')}
                </button>
              )}
              <button
                onClick={() => setWeekOffset((o) => o - 1)}
                aria-label={t('student.home.prevWeek')}
                className="p-1.5 rounded-lg text-ink-400 hover:text-gray-900 hover:bg-ink-50 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <button
                onClick={() => setWeekOffset((o) => o + 1)}
                aria-label={t('student.home.nextWeek')}
                className="p-1.5 rounded-lg text-ink-400 hover:text-gray-900 hover:bg-ink-50 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-1.5">
            {daySlots.map(({ dayNumber, label, name, dateNumber, session, state }) => (
              <DayCell
                key={dayNumber}
                dayLabel={label}
                dayName={name}
                dateNumber={dateNumber}
                session={session}
                state={state}
                isToday={weekOffset === 0 && dayNumber === todayDN}
                onClick={session ? () => navigate(`/student/session/${session.id}`) : null}
              />
            ))}
          </div>
        </section>

        {next && (
          <section aria-labelledby="next-heading" className="relative">
            <div className="flex items-baseline justify-between gap-3 mb-3">
              <h2 id="next-heading" className="sl-label">{t('student.home.nextSession')}</h2>
              {queue.total > 0 && (
                <span className="sl-mono text-[11px] text-ink-400 shrink-0">
                  {t('student.home.sessionPosition', { n: queue.position, total: queue.total })}
                </span>
              )}
            </div>
            <div className="relative overflow-hidden rounded-2xl">
              <div
                className="absolute top-0 left-0 bottom-0 w-1 z-10"
                style={{ background: 'var(--color-accent)' }}
              />
              <SessionCard
                session={next}
                confirmed={false}
                archived={false}
                hasFeedback={feedbackIds.has(next.id)}
                collapsible={false}
                subtitle={subtitleFor(next)}
                onStart={() => navigate(`/student/session/${next.id}`)}
              />
            </div>
          </section>
        )}

        {then.length > 0 && (
          <section aria-labelledby="then-heading" className="space-y-2">
            <h2 id="then-heading" className="sl-label mb-3">{t('student.home.then')}</h2>
            {then.map(({ session }) => (
              <SessionCard
                key={session.id}
                session={session}
                confirmed={false}
                archived={false}
                hasFeedback={feedbackIds.has(session.id)}
                subtitle={subtitleFor(session)}
                onStart={() => navigate(`/student/session/${session.id}`)}
              />
            ))}
          </section>
        )}

        {!next && <EmptyState message={t('student.home.blockComplete')} />}
      </div>
    </>
  );
}
