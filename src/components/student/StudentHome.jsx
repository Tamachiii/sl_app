import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import Header from '../layout/Header';
import { useAuth } from '../../hooks/useAuth';
import { useStudentWeeks } from '../../hooks/useStudentWeeks';
import { useMyConfirmedSessionIds } from '../../hooks/useSessionConfirmation';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';

// day_number 1 = Monday … 7 = Sunday
const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DAY_FULL   = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Map JS getDay() (0=Sun … 6=Sat) → training day_number (1=Mon … 7=Sun). */
function todayDayNumber() {
  const d = new Date().getDay(); // 0=Sun, 1=Mon, …
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

  let bg, icon;
  if (isRest) {
    bg = isToday ? 'bg-gray-200' : 'bg-gray-100';
    icon = <span className="text-gray-400 text-xs">—</span>;
  } else if (confirmed) {
    bg = 'bg-green-100';
    icon = (
      <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
      </svg>
    );
  } else {
    bg = isToday ? 'bg-primary text-white' : 'bg-primary/10';
    icon = (
      <span className={`w-2 h-2 rounded-full ${isToday ? 'bg-white' : 'bg-primary'}`} />
    );
  }

  return (
    <button
      onClick={hasSession && !confirmed && onClick ? onClick : undefined}
      disabled={!hasSession || confirmed}
      className={`flex flex-col items-center gap-1 py-2 rounded-lg flex-1 min-w-0 transition-colors
        ${hasSession && !confirmed ? 'cursor-pointer active:opacity-70' : 'cursor-default'}
        ${bg}`}
      aria-label={isRest ? `${dayLabel} rest day` : `${dayLabel} ${session.title}`}
    >
      <span className={`text-xs font-semibold ${isToday && !isRest && !confirmed ? 'text-white' : isToday ? 'text-gray-700' : 'text-gray-500'}`}>
        {dayLabel}
      </span>
      {icon}
    </button>
  );
}

// ─── Session list item ─────────────────────────────────────────────────────

function SessionItem({ session, confirmed, onClick }) {
  const dn = sessionDayNumber(session);
  const dayName = dn >= 1 && dn <= 7
    ? DAY_FULL[dn - 1]
    : `Day ${session.day_number || session.sort_order + 1}`;

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between gap-2 text-left bg-white rounded-xl shadow-sm px-4 py-3 hover:shadow-md transition-shadow"
    >
      <div>
        <p className="text-sm font-medium text-gray-900">{session.title || `Session ${session.sort_order + 1}`}</p>
        <p className="text-xs text-gray-400 mt-0.5">{dayName}</p>
      </div>
      {confirmed ? (
        <span className="flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-2 py-0.5 rounded-full shrink-0">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
          Done
        </span>
      ) : (
        <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      )}
    </button>
  );
}

// ─── Main component ────────────────────────────────────────────────────────

export default function StudentHome() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: weeks, isLoading } = useStudentWeeks(user?.id);
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

  // Build 7-slot day strip keyed by weekday (from scheduled_date when set, else day_number).
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

        {/* Week overview */}
        <section aria-labelledby="week-heading">
          <div className="flex items-baseline justify-between mb-2">
            <h2 id="week-heading" className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Week {activeWeek?.week_number}
              {activeWeek?.label && (
                <span className="font-normal normal-case ml-1">— {activeWeek.label}</span>
              )}
            </h2>
          </div>
          <div className="flex gap-1">
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

        {/* Upcoming sessions */}
        {upcoming.length > 0 && (
          <section aria-labelledby="upcoming-heading">
            <h2 id="upcoming-heading" className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
              Upcoming
            </h2>
            <div className="space-y-2">
              {upcoming.map((s) => (
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
            <h2 id="completed-heading" className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
              Completed this week
            </h2>
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
