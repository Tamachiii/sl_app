import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import Header from '../layout/Header';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import { useStudentProgressStats } from '../../hooks/useStudentProgressStats';
import SessionCalendar from './SessionCalendar';

function StatCard({ label, value, sub }) {
  return (
    <div className="bg-white rounded-xl shadow-sm p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold text-gray-900 leading-none">
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-gray-400">{sub}</div>}
    </div>
  );
}

/**
 * Stacked pull/push bar scaled against the max weekly total.
 */
function VolumeWeekRow({ week, maxTotal }) {
  const { week_number, label, pull, push } = week;
  const total = pull + push;
  const rowPct = maxTotal === 0 ? 0 : (total / maxTotal) * 100;
  const pullPct = total === 0 ? 0 : (pull / total) * 100;
  const pushPct = total === 0 ? 0 : (push / total) * 100;

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-gray-700">
          Week {week_number}
          {label && <span className="text-gray-400 font-normal ml-1">· {label}</span>}
        </span>
        <span className="text-gray-500 tabular-nums">{Math.round(total)}</span>
      </div>
      <div className="h-3 rounded-full bg-gray-100 overflow-hidden" aria-hidden="true">
        {total > 0 ? (
          <div className="flex h-full" style={{ width: `${rowPct}%` }}>
            {pull > 0 && <div className="bg-pull" style={{ width: `${pullPct}%` }} />}
            {push > 0 && <div className="bg-push" style={{ width: `${pushPct}%` }} />}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function StudentDashboard() {
  const { data, isLoading } = useStudentProgressStats();

  const maxWeeklyTotal = useMemo(() => {
    if (!data?.weeklyVolume?.length) return 0;
    return Math.max(...data.weeklyVolume.map((w) => w.pull + w.push));
  }, [data]);

  if (isLoading) {
    return (
      <>
        <Header title="Stats" />
        <div className="flex justify-center py-12"><Spinner /></div>
      </>
    );
  }

  const stats = data || {
    totalSessions: 0,
    totalSessionsConfirmed: 0,
    totalSets: 0,
    totalSetsDone: 0,
    weeksActive: 0,
    avgRpe: null,
    weeklyVolume: [],
    recentConfirmations: [],
    weightHistory: [],
    sessionCalendar: [],
  };

  const hasProgram = stats.totalSessions > 0;
  const completionPct =
    stats.totalSessions === 0
      ? 0
      : Math.round((stats.totalSessionsConfirmed / stats.totalSessions) * 100);

  return (
    <>
      <Header title="Stats" />
      <div className="p-4 space-y-6">
        {!hasProgram && <EmptyState message="No program assigned yet" />}

        {hasProgram && (
          <>
            {/* Summary cards */}
            <section aria-labelledby="summary-heading">
              <h2
                id="summary-heading"
                className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2"
              >
                Summary
              </h2>
              <div className="grid grid-cols-2 gap-2">
                <StatCard
                  label="Sessions"
                  value={`${stats.totalSessionsConfirmed}/${stats.totalSessions}`}
                  sub={`${completionPct}% complete`}
                />
                <StatCard
                  label="Sets done"
                  value={stats.totalSetsDone}
                  sub={`of ${stats.totalSets} prescribed`}
                />
                <StatCard
                  label="Full weeks"
                  value={stats.weeklyVolume.filter(
                    (w) => w.sessions_total > 0 && w.sessions_confirmed === w.sessions_total
                  ).length}
                  sub={`of ${stats.weeklyVolume.length} weeks`}
                />
                <StatCard
                  label="Avg RPE"
                  value={stats.avgRpe != null ? stats.avgRpe.toFixed(1) : '—'}
                  sub={stats.avgRpe != null ? 'across logged sets' : 'log sets to see'}
                />
              </div>
            </section>

            {/* Session calendar */}
            <section aria-labelledby="calendar-heading">
              <h2
                id="calendar-heading"
                className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2"
              >
                Calendar
              </h2>
              <SessionCalendar sessions={stats.sessionCalendar} />
            </section>

            {/* Weekly volume */}
            <section aria-labelledby="volume-heading">
              <h2
                id="volume-heading"
                className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2"
              >
                Weekly volume
              </h2>
              <div className="bg-white rounded-xl shadow-sm p-4 space-y-3">
                {maxWeeklyTotal === 0 ? (
                  <p className="text-xs text-gray-400">No volume assigned yet.</p>
                ) : (
                  stats.weeklyVolume.map((w) => (
                    <VolumeWeekRow key={w.week_id} week={w} maxTotal={maxWeeklyTotal} />
                  ))
                )}
                {maxWeeklyTotal > 0 && (
                  <div className="flex justify-between text-xs text-gray-500 pt-1 border-t border-gray-100">
                    <span>
                      <span className="inline-block w-2 h-2 rounded-full bg-pull mr-1" />
                      Pull
                    </span>
                    <span>
                      Push
                      <span className="inline-block w-2 h-2 rounded-full bg-push ml-1" />
                    </span>
                  </div>
                )}
              </div>
            </section>

            {/* Recent activity */}
            <section aria-labelledby="activity-heading">
              <h2
                id="activity-heading"
                className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2"
              >
                Recent activity
              </h2>
              {stats.recentConfirmations.length === 0 ? (
                <EmptyState message="No confirmed sessions yet" />
              ) : (
                <div className="space-y-2">
                  {stats.recentConfirmations.map((c) => (
                    <Link
                      key={c.id}
                      to={`/student/session/${c.session_id}`}
                      className="block bg-white rounded-xl shadow-sm p-3 hover:shadow-md transition-shadow"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-gray-900 truncate">
                          {c.session_title || `Session ${c.day_number}`}
                        </span>
                        <span className="text-xs text-gray-400 shrink-0">
                          {new Date(c.confirmed_at).toLocaleDateString()}
                        </span>
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">
                        Week {c.week_number}
                        {c.week_label ? ` — ${c.week_label}` : ''} · Day {c.day_number}
                      </p>
                    </Link>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </>
  );
}
