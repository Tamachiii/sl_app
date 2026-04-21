import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import Header from '../layout/Header';
import { useAuth } from '../../hooks/useAuth';
import { useStudentProgramDetails } from '../../hooks/useStudentProgramDetails';
import { useMyConfirmedSessionIds } from '../../hooks/useSessionConfirmation';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import SessionCard from './SessionCard';

// day_number 1 = Monday … 7 = Sunday
const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DAY_FULL   = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Map JS getDay() (0=Sun … 6=Sat) → training day_number (1=Mon … 7=Sun). */
function todayDayNumber() {
  const d = new Date().getDay();
  return d === 0 ? 7 : d;
}

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

function DayCell({ dayLabel, session, confirmed, isToday, onClick }) {
  const hasSession = !!session;
  const isRest = !hasSession;

  // Background / text color logic — editorial dark-first treatment.
  let cellClass;
  if (isToday && hasSession && !confirmed) {
    cellClass = 'bg-accent text-ink-900';
  } else if (confirmed) {
    cellClass = 'bg-white border border-ink-100 text-ink-900';
  } else if (hasSession) {
    cellClass = 'bg-white border border-ink-100 text-ink-900';
  } else {
    cellClass = 'bg-ink-50 text-ink-400';
  }

  const title = session?.title || (isRest ? 'REST' : '');
  const label5 = (title || '').slice(0, 5).toUpperCase();

  return (
    <button
      onClick={hasSession && !confirmed && onClick ? onClick : undefined}
      disabled={!hasSession || confirmed}
      aria-label={isRest ? `${dayLabel} rest day` : `${dayLabel} ${session.title}`}
      className={`relative flex-1 min-w-0 rounded-xl h-[78px] px-1.5 py-2 flex flex-col justify-between items-start overflow-hidden transition-transform ${cellClass} ${
        hasSession && !confirmed ? 'cursor-pointer active:scale-95' : 'cursor-default'
      }`}
    >
      <span className="sl-mono text-[10px] font-semibold opacity-70">{dayLabel}</span>
      <span
        className="sl-display text-[16px]"
        style={{
          writingMode: 'vertical-rl',
          textOrientation: 'mixed',
          transform: 'rotate(180deg)',
          opacity: hasSession ? 1 : 0.3,
          lineHeight: 1,
        }}
      >
        {label5 || 'REST'}
      </span>
      {confirmed && (
        <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-accent" />
      )}
    </button>
  );
}

// ─── Session list item ─────────────────────────────────────────────────────

function SessionItem({ session, confirmed, onClick }) {
  const dn = sessionDayNumber(session);
  const dayName = dn >= 1 && dn <= 7
    ? DAY_FULL[dn - 1].toUpperCase()
    : `D${session.day_number || session.sort_order + 1}`;

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 text-left bg-white rounded-2xl shadow-sm px-4 py-3.5 hover:shadow-md transition-shadow"
    >
      <div className="w-11 text-center">
        <div className="sl-mono text-[10px] font-semibold text-ink-400 tracking-widest">{dayName}</div>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[15px] font-semibold text-gray-900 truncate">
          {session.title || `Session ${session.sort_order + 1}`}
        </p>
        <p className="sl-mono text-[11px] text-ink-400 mt-0.5">
          {(session.exercise_slots || []).length} exercises
          {confirmed ? ' · Done' : ''}
        </p>
      </div>
      {confirmed ? (
        <svg className="w-4 h-4 text-accent shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-4 h-4 text-ink-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      )}
    </button>
  );
}

// ─── Greeting block ────────────────────────────────────────────────────────

function Greeting({ fullName, todayDN, todaysMessage, activeWeek }) {
  const firstName = (fullName || '').split(' ')[0] || 'there';
  const initials = (fullName || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');

  const metaBits = [`Week ${activeWeek?.week_number ?? '—'}`];
  if (activeWeek?.label) metaBits.push(activeWeek.label);
  metaBits.push(DAY_FULL[todayDN - 1]);

  return (
    <div
      title={fullName ? `Student · ${fullName}` : undefined}
      className="flex items-start justify-between gap-4 px-1 pt-2 pb-1"
    >
      <div className="min-w-0">
        <div className="sl-label mb-1.5 truncate">{metaBits.join(' · ')}</div>
        <div className="sl-display text-[30px] text-gray-900 truncate">Hey, {firstName}.</div>
        <p className="sl-mono text-[11px] text-ink-400 mt-2">{todaysMessage}</p>
      </div>
      {initials && (
        <div
          className="w-10 h-10 rounded-full bg-ink-100 flex items-center justify-center sl-display text-[13px] text-ink-900 shrink-0"
          style={{ border: '1.5px solid var(--color-accent)' }}
        >
          {initials}
        </div>
      )}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────

export default function StudentHome() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const { data: weeks, isLoading } = useStudentProgramDetails(user?.id);
  const { data: confirmedIds = new Set() } = useMyConfirmedSessionIds();

  const todayDN = todayDayNumber();

  const activeWeek = useMemo(() => {
    if (!weeks?.length) return null;
    return findActiveWeek(weeks, confirmedIds);
  }, [weeks, confirmedIds]);

  const activeSessions = useMemo(
    () => (activeWeek?.sessions || []).filter((s) => !s.archived_at),
    [activeWeek]
  );

  const daySlots = useMemo(() => {
    const byDay = {};
    for (const s of activeSessions) {
      const d = sessionDayNumber(s);
      if (d >= 1 && d <= 7) byDay[d] = s;
    }
    return Array.from({ length: 7 }, (_, i) => ({
      dayNumber: i + 1,
      label: DAY_LABELS[i],
      session: byDay[i + 1] ?? null,
    }));
  }, [activeSessions]);

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
    todaysMessage = 'Today is a day off — rest up.';
  } else if (todayConfirmed) {
    todaysMessage = "Today's session is done — great work.";
  } else {
    todaysMessage = 'You have a session to finish today.';
  }

  const doneCount = completed.length;
  const totalCount = activeSessions.length;

  if (isLoading) {
    return (
      <>
        <Header title="Home" />
        <div className="flex justify-center py-12"><Spinner /></div>
      </>
    );
  }

  if (!weeks?.length) {
    return (
      <>
        <Header title="Home" />
        <div className="p-4"><EmptyState message="No program assigned yet" /></div>
      </>
    );
  }

  return (
    <>
      <Header title="Home" />
      <div className="p-4 space-y-6">

        {profile?.full_name && (
          <Greeting
            fullName={profile.full_name}
            todayDN={todayDN}
            todaysMessage={todaysMessage}
            activeWeek={activeWeek}
          />
        )}

        {/* Week overview */}
        <section aria-labelledby="week-heading">
          <div className="flex items-baseline justify-between mb-3">
            <h2 id="week-heading" className="sl-label">
              Week {activeWeek?.week_number}
              {activeWeek?.label && (
                <span className="ml-1 normal-case tracking-normal font-normal text-ink-500">
                  — {activeWeek.label}
                </span>
              )}
            </h2>
            {totalCount > 0 && (
              <span className="sl-label" style={{ color: 'var(--color-accent)' }}>
                {doneCount} / {totalCount} done
              </span>
            )}
          </div>
          <div className="grid grid-cols-7 gap-1.5">
            {daySlots.map(({ dayNumber, label, session }) => (
              <DayCell
                key={dayNumber}
                dayLabel={label}
                session={session}
                confirmed={session ? confirmedIds.has(session.id) : false}
                isToday={dayNumber === todayDN}
                onClick={session ? () => navigate(`/student/session/${session.id}`) : null}
              />
            ))}
          </div>
        </section>

        {/* Next session preview */}
        {upcoming.length > 0 && (
          <section aria-labelledby="next-heading" className="relative">
            <h2 id="next-heading" className="sl-label mb-3">Next session</h2>
            {/* Left accent bar, sits inside the rounded card via overflow clipping. */}
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

        {/* Upcoming sessions */}
        {upcoming.length > 1 && (
          <section aria-labelledby="upcoming-heading">
            <h2 id="upcoming-heading" className="sl-label mb-3">Upcoming</h2>
            <div className="space-y-2">
              {upcoming.slice(1).map((s) => (
                <SessionItem
                  key={s.id}
                  session={s}
                  confirmed={false}
                  onClick={() => navigate(`/student/session/${s.id}`)}
                />
              ))}
            </div>
          </section>
        )}

        {/* Completed this week */}
        {completed.length > 0 && (
          <section aria-labelledby="completed-heading">
            <h2 id="completed-heading" className="sl-label mb-3">Completed this week</h2>
            <div className="space-y-2">
              {completed.map((s) => (
                <SessionItem
                  key={s.id}
                  session={s}
                  confirmed={true}
                  onClick={() => navigate(`/student/session/${s.id}`)}
                />
              ))}
            </div>
          </section>
        )}

        {upcoming.length === 0 && completed.length === 0 && (
          <EmptyState message="No sessions in this week" />
        )}
      </div>
    </>
  );
}
