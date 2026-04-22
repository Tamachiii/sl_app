import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { useStudentProgramDetails } from '../../hooks/useStudentProgramDetails';
import { useMyConfirmedSessionIds } from '../../hooks/useSessionConfirmation';
import { DAY_LABELS, DAY_FULL, todayDayNumber } from '../../lib/day';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import UserMenu from '../ui/UserMenu';
import SessionCard from './SessionCard';

/** Weekday slot for a session. Prefer scheduled_date (actual calendar day) over day_number. */
function sessionDayNumber(s) {
  if (s?.scheduled_date) {
    const [y, m, d] = s.scheduled_date.split('-').map(Number);
    const jsDay = new Date(y, m - 1, d).getDay();
    return jsDay === 0 ? 7 : jsDay;
  }
  return s?.day_number;
}

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

// ─── Day strip cell ────────────────────────────────────────────────────────

function DayCell({ dayLabel, session, confirmed, archived, isToday, onClick }) {
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
  const ariaLabel = isRest
    ? `${dayLabel} rest day`
    : archived
      ? `${dayLabel} ${session.title} (archived)`
      : `${dayLabel} ${session.title}`;

  return (
    <button
      onClick={interactive && onClick ? onClick : undefined}
      disabled={!interactive}
      aria-label={ariaLabel}
      className={`relative flex-1 min-w-0 rounded-xl h-[108px] px-1.5 py-2 flex flex-col items-center gap-1.5 overflow-hidden transition-transform ${cellClass} ${
        interactive ? 'cursor-pointer active:scale-95' : 'cursor-default'
      }`}
    >
      <span className="sl-mono text-[10px] font-semibold opacity-70 text-center">{dayLabel}</span>
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

function Greeting({ fullName, todayDN, todaysMessage, activeWeek, onSignOut }) {
  const { t } = useI18n();
  const firstName = (fullName || '').split(' ')[0] || 'there';

  const metaBits = [`${t('student.home.week')} ${activeWeek?.week_number ?? '—'}`];
  if (activeWeek?.label) metaBits.push(activeWeek.label);
  metaBits.push(DAY_FULL[todayDN - 1]);

  return (
    <div
      title={fullName ? `Student · ${fullName}` : undefined}
      className="pt-3 pb-1"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="sl-label mb-1.5 truncate">{metaBits.join(' · ')}</div>
          <div className="sl-display text-[32px] md:text-[44px] text-gray-900 truncate">{t('student.home.hey')}, {firstName}.</div>
          <p className="sl-mono text-[11px] text-ink-400 mt-2">{todaysMessage}</p>
        </div>
        <UserMenu fullName={fullName} onSignOut={onSignOut} />
      </div>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────

export default function StudentHome() {
  const { user, profile, signOut } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const { data: weeks, isLoading } = useStudentProgramDetails(user?.id);
  const { data: confirmedIds = new Set() } = useMyConfirmedSessionIds();

  const todayDN = todayDayNumber();

  const activeWeek = useMemo(() => {
    if (!weeks?.length) return null;
    return findActiveWeek(weeks, confirmedIds);
  }, [weeks, confirmedIds]);

  const weekSessions = useMemo(() => activeWeek?.sessions || [], [activeWeek]);
  const activeSessions = useMemo(
    () => weekSessions.filter((s) => !s.archived_at),
    [weekSessions]
  );

  // Include archived sessions in the day strip so the cell doesn't flip to
  // "Rest" when the coach archives a session. When a day has both an archived
  // and an active session, prefer the active one.
  const daySlots = useMemo(() => {
    const byDay = {};
    for (const s of weekSessions) {
      const d = sessionDayNumber(s);
      if (d < 1 || d > 7) continue;
      const existing = byDay[d];
      if (!existing || (existing.archived_at && !s.archived_at)) {
        byDay[d] = s;
      }
    }
    return Array.from({ length: 7 }, (_, i) => ({
      dayNumber: i + 1,
      label: DAY_LABELS[i],
      session: byDay[i + 1] ?? null,
    }));
  }, [weekSessions]);

  const upcoming = useMemo(
    () =>
      activeSessions
        .filter((s) => !confirmedIds.has(s.id))
        .sort((a, b) => (sessionDayNumber(a) ?? a.sort_order) - (sessionDayNumber(b) ?? b.sort_order)),
    [activeSessions, confirmedIds]
  );

  const completed = useMemo(
    () =>
      activeSessions
        .filter((s) => confirmedIds.has(s.id))
        .sort((a, b) => (sessionDayNumber(a) ?? a.sort_order) - (sessionDayNumber(b) ?? b.sort_order)),
    [activeSessions, confirmedIds]
  );

  const todaysSession = useMemo(
    () => activeSessions.find((s) => sessionDayNumber(s) === todayDN) ?? null,
    [activeSessions, todayDN]
  );
  const todayConfirmed = todaysSession ? confirmedIds.has(todaysSession.id) : false;

  let todaysMessage;
  if (!todaysSession) {
    todaysMessage = t('student.home.todayRest');
  } else if (todayConfirmed) {
    todaysMessage = t('student.home.todayDone');
  } else {
    todaysMessage = t('student.home.todayPending');
  }

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
            todayDN={todayDN}
            todaysMessage={todaysMessage}
            activeWeek={activeWeek}
            onSignOut={signOut}
          />
        )}

        <section aria-label="Week overview">
          <div className="grid grid-cols-7 gap-1.5">
            {daySlots.map(({ dayNumber, label, session }) => {
              const isArchived = !!session?.archived_at;
              return (
                <DayCell
                  key={dayNumber}
                  dayLabel={label}
                  session={session}
                  confirmed={session && !isArchived ? confirmedIds.has(session.id) : false}
                  archived={isArchived}
                  isToday={dayNumber === todayDN}
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
                defaultOpen
                subtitle={(() => {
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
