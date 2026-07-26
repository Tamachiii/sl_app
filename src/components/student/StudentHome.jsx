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
  preferSession,
} from '../../lib/day';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import UserMenu from '../ui/UserMenu';
import SessionCard from './SessionCard';

/** First week that still has at least one unconfirmed non-archived session. */
function findActiveWeek(weeks, confirmedIds) {
  for (const w of weeks) {
    const hasOpen = (w.sessions || []).some(
      (s) => !s.archived_at && !confirmedIds.has(s.id)
    );
    if (hasOpen) return w;
  }
  return weeks[weeks.length - 1] ?? null;
}

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

function DayCell({ dayLabel, dayName, dateNumber, session, confirmed, archived, isToday, onClick }) {
  const hasSession = !!session;
  const isRest = !hasSession;
  const interactive = hasSession && !confirmed && !archived;

  // Background / text color logic — editorial dark-first treatment.
  let cellClass;
  if (archived) {
    cellClass = 'bg-ink-50 text-ink-400 border border-transparent';
  } else if (isToday && hasSession && !confirmed) {
    cellClass = 'bg-accent text-ink-900 border border-transparent';
  } else if (hasSession) {
    // Both confirmed and pending use the surface card; confirmed gets a corner dot.
    cellClass = 'bg-white border border-ink-100 text-gray-900';
  } else {
    cellClass = 'bg-ink-50 text-ink-400 border border-transparent';
  }

  const shortTitle = (session?.title || (isRest ? 'Rest' : '')).toUpperCase();
  // Aria uses the full weekday name plus the day-of-month so screen readers
  // can tell navigated weeks apart — the button's aria-label masks its inner
  // text, so the visible date number alone is not exposed to AT.
  const dayWord = dateNumber != null ? `${dayName || dayLabel} ${dateNumber}` : dayName || dayLabel;
  const ariaLabel = isRest
    ? `${dayWord} — rest day`
    : archived
      ? `${dayWord} — ${session.title} (archived)`
      : `${dayWord} — ${session.title}`;

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
          opacity: hasSession && !archived ? 1 : 0.45,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          textDecoration: archived ? 'line-through' : undefined,
        }}
      >
        {shortTitle}
      </span>
      {confirmed && !archived && (
        <span
          aria-label="completed"
          className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full"
          style={{ background: 'var(--color-accent)' }}
        />
      )}
    </button>
  );
}

// ─── Greeting block ────────────────────────────────────────────────────────

// Just the name and the week's adherence. The week/day kicker and the
// "today is a rest day" line both restated what the Week overview strip
// directly below already shows — week number, which day it is, and whether
// today is a training day — so they were noise above the fold.
function Greeting({ fullName, adherence, onSignOut }) {
  const { t } = useI18n();
  const firstName = (fullName || '').split(' ')[0] || 'there';

  return (
    <div
      title={fullName ? `Student · ${fullName}` : undefined}
      className="pt-3 pb-1"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="sl-display text-[32px] md:text-[44px] text-gray-900 truncate">{t('student.home.hey')}, {firstName}.</div>
          {adherence && adherence.total > 0 && (
            <p className="sl-mono text-[11px] text-ink-400 mt-2">
              {t('student.home.weekAdherence', { done: adherence.done, total: adherence.total })}
            </p>
          )}
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

  const activeWeek = useMemo(() => {
    if (!weeks?.length) return null;
    return findActiveWeek(weeks, confirmedIds);
  }, [weeks, confirmedIds]);

  const weekSessions = useMemo(() => activeWeek?.sessions || [], [activeWeek]);
  const activeSessions = useMemo(
    () => weekSessions.filter((s) => !s.archived_at),
    [weekSessions]
  );

  // Every session of the active program, tagged with its training week —
  // dated sessions place onto the calendar independently of week grouping.
  const allSessions = useMemo(
    () =>
      (weeks || []).flatMap((w) =>
        (w.sessions || []).map((s) => ({ session: s, week: w }))
      ),
    [weeks]
  );

  // scheduled_date → session; collisions resolve via preferSession so an
  // archived or already-confirmed session never hides a pending sibling.
  const sessionsByDate = useMemo(() => {
    const byDate = new Map();
    for (const entry of allSessions) {
      const s = entry.session;
      if (!s.scheduled_date || !parseISODate(s.scheduled_date)) continue;
      const key = s.scheduled_date.slice(0, 10);
      const existing = byDate.get(key);
      const winner = preferSession(existing?.session, s, confirmedIds);
      byDate.set(key, winner === s ? entry : existing);
    }
    return byDate;
  }, [allSessions, confirmedIds]);

  const todayIso = isoDate(new Date());
  const currentMonday = useMemo(() => startOfWeekMonday(new Date()), [todayIso]);
  const displayedMonday = useMemo(
    () => addDays(currentMonday, weekOffset * 7),
    [currentMonday, weekOffset]
  );

  // Undated sessions have no calendar anchor: keep the legacy behavior and
  // show the active training week's undated sessions by day_number — but only
  // on the real current week, so they never bleed into other weeks.
  const undatedByDay = useMemo(() => {
    const byDay = {};
    for (const s of weekSessions) {
      // A malformed scheduled_date falls back to day_number placement,
      // consistent with sessionDayNumber().
      if (s.scheduled_date && parseISODate(s.scheduled_date)) continue;
      const d = s.day_number;
      if (d < 1 || d > 7) continue;
      byDay[d] = preferSession(byDay[d], s, confirmedIds);
    }
    return byDay;
  }, [weekSessions, confirmedIds]);

  // One placement rule for a calendar day: the dated session for that date,
  // else (when allowed) the active week's undated session for that weekday —
  // collisions resolved by preferSession, so dated placement wins ties but an
  // archived or confirmed dated session never hides a pending undated one.
  // Both the strip (daySlots) and the greeting's adherence line use this, so
  // the two can never disagree.
  const placeDay = (monday, i, useUndatedFallback) =>
    preferSession(
      sessionsByDate.get(isoDate(addDays(monday, i)))?.session ?? null,
      useUndatedFallback ? undatedByDay[i + 1] ?? null : null,
      confirmedIds
    );

  const daySlots = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const date = addDays(displayedMonday, i);
        return {
          dayNumber: i + 1,
          label: DAY_LABELS[i],
          name: DAY_FULL_LONG[i],
          dateNumber: date.getDate(),
          // Undated sessions have no calendar anchor — they only place on
          // the real current week.
          session: placeDay(displayedMonday, i, weekOffset === 0),
        };
      }),
    [displayedMonday, sessionsByDate, undatedByDay, weekOffset, confirmedIds]
  );

  // Training-week context for the strip header. Named only when it can be
  // stated honestly: either every dated session in the displayed week comes
  // from one training week, or there are no dated sessions at all and we are
  // on the current calendar week — in which case the strip is showing the
  // ACTIVE week's undated sessions (undated placement is gated on
  // weekOffset === 0, see daySlots), so that is the right label.
  //
  // The greeting used to name the active week and this deliberately had no
  // fallback. The greeting no longer does, so a program built with undated
  // sessions would otherwise show no week number anywhere.
  const displayedTrainingWeek = useMemo(() => {
    const weeksSeen = new Set();
    let match = null;
    for (let i = 0; i < 7; i++) {
      const dated = sessionsByDate.get(isoDate(addDays(displayedMonday, i)));
      if (dated) {
        weeksSeen.add(dated.week.id);
        match = dated.week;
      }
    }
    if (weeksSeen.size === 1) return match;
    if (weeksSeen.size === 0 && weekOffset === 0) return activeWeek;
    return null;
  }, [sessionsByDate, displayedMonday, weekOffset, activeWeek]);

  // Chronological position for a session: its real date when scheduled,
  // otherwise its day_number projected onto the current calendar week.
  const effectiveTime = useMemo(() => {
    return (s) => {
      const d = s.scheduled_date ? parseISODate(s.scheduled_date) : null;
      if (d) return d.getTime();
      const dn = s.day_number >= 1 && s.day_number <= 7 ? s.day_number : 7;
      return addDays(currentMonday, dn - 1).getTime();
    };
  }, [currentMonday]);

  // Pending pool for the "Next session" card: the active training week's
  // sessions plus every DATED session from other weeks — a date gives a
  // session a real chronological position, so it can legitimately come due
  // before the active week finishes. Undated sessions outside the active
  // week stay out (they have no calendar anchor; program order still rules).
  const upcoming = useMemo(
    () =>
      allSessions
        .filter(
          ({ session: s, week: w }) =>
            !s.archived_at &&
            !confirmedIds.has(s.id) &&
            (w.id === activeWeek?.id || (s.scheduled_date && parseISODate(s.scheduled_date)))
        )
        .map(({ session: s }) => s)
        .sort((a, b) => effectiveTime(a) - effectiveTime(b) || a.sort_order - b.sort_order),
    [allSessions, confirmedIds, activeWeek, effectiveTime]
  );

  const completed = useMemo(
    () =>
      activeSessions
        .filter((s) => confirmedIds.has(s.id))
        .sort((a, b) => effectiveTime(a) - effectiveTime(b) || a.sort_order - b.sort_order),
    [activeSessions, confirmedIds, effectiveTime]
  );

  // "2/3 sessions done this week" — always the REAL current week (weekOffset
  // navigation doesn't move it), placed by the same placeDay rule as the
  // strip's current-week view.
  const weekAdherence = useMemo(() => {
    let total = 0;
    let done = 0;
    for (let i = 0; i < 7; i++) {
      const s = placeDay(currentMonday, i, true);
      if (!s || s.archived_at) continue;
      total += 1;
      if (confirmedIds.has(s.id)) done += 1;
    }
    return { total, done };
  }, [sessionsByDate, currentMonday, undatedByDay, confirmedIds]);

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

  return (
    <>
      <h1 className="sr-only">Home</h1>
      <div className="p-4 md:p-8 space-y-6">

        {profile?.full_name && (
          <Greeting
            fullName={profile.full_name}
            adherence={weekAdherence}
            onSignOut={signOut}
          />
        )}

        <section aria-label="Week overview">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="sl-label truncate" aria-live="polite">
              {formatWeekRange(displayedMonday, lang)}
              {displayedTrainingWeek && (
                <span className="sl-mono text-[10px] normal-case text-ink-400 ml-2">
                  {t('student.home.week')} {displayedTrainingWeek.week_number}
                  {displayedTrainingWeek.label ? ` · ${displayedTrainingWeek.label}` : ''}
                </span>
              )}
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
            {daySlots.map(({ dayNumber, label, name, dateNumber, session }) => {
              const isArchived = !!session?.archived_at;
              return (
                <DayCell
                  key={dayNumber}
                  dayLabel={label}
                  dayName={name}
                  dateNumber={dateNumber}
                  session={session}
                  confirmed={session && !isArchived ? confirmedIds.has(session.id) : false}
                  archived={isArchived}
                  isToday={weekOffset === 0 && dayNumber === todayDN}
                  onClick={session && !isArchived ? () => navigate(`/student/session/${session.id}`) : null}
                />
              );
            })}
          </div>
        </section>

        {upcoming.length > 0 && (
          <section aria-labelledby="next-heading" className="relative">
            <h2 id="next-heading" className="sl-label mb-3">{t('student.home.nextSession')}</h2>
            <div className="relative overflow-hidden rounded-2xl">
              <div
                className="absolute top-0 left-0 bottom-0 w-1 z-10"
                style={{ background: 'var(--color-accent)' }}
              />
              <SessionCard
                session={upcoming[0]}
                confirmed={false}
                archived={false}
                hasFeedback={feedbackIds.has(upcoming[0].id)}
                collapsible={false}
                subtitle={(() => {
                  // A real date beats a bare weekday name — "Mon" alone reads
                  // as this week's Monday even when the session is weeks out.
                  const d = upcoming[0].scheduled_date
                    ? parseISODate(upcoming[0].scheduled_date)
                    : null;
                  if (d) {
                    return d.toLocaleDateString(LOCALE[lang] || LOCALE.en, {
                      weekday: 'short',
                      day: 'numeric',
                      month: 'short',
                    });
                  }
                  const dn = sessionDayNumber(upcoming[0]);
                  return dn >= 1 && dn <= 7 ? DAY_FULL[dn - 1] : null;
                })()}
                onStart={() => navigate(`/student/session/${upcoming[0].id}`)}
              />
            </div>
          </section>
        )}

        {upcoming.length === 0 && completed.length === 0 && (
          <EmptyState message={t('student.home.noSessionsInWeek')} />
        )}
      </div>
    </>
  );
}
