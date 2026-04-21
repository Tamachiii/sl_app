import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import { useStudentProgressStats } from '../../hooks/useStudentProgressStats';
import SessionCalendar from './SessionCalendar';
import ExerciseProgressChart from './ExerciseProgressChart';

function StatCard({ label, value, sub }) {
  return (
    <div className="sl-card p-3.5">
      <div className="sl-label text-ink-400">{label}</div>
      <div className="sl-display text-[28px] text-gray-900 leading-none mt-1.5 tabular-nums">
        {value}
      </div>
      {sub && <div className="sl-mono text-[11px] text-ink-400 mt-1">{sub}</div>}
    </div>
  );
}

function VolumeWeekRow({ week, maxTotal }) {
  const { week_number, label, pull, push } = week;
  const total = pull + push;
  const rowPct = maxTotal === 0 ? 0 : (total / maxTotal) * 100;
  const pullPct = total === 0 ? 0 : (pull / total) * 100;
  const pushPct = total === 0 ? 0 : (push / total) * 100;

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="sl-mono text-[11px] text-gray-800">
          W{week_number}
          {label && <span className="text-ink-400 ml-1.5">{label}</span>}
        </span>
        <span className="sl-mono text-[11px] text-ink-400 tabular-nums">{Math.round(total)}</span>
      </div>
      <div className="h-2.5 rounded-full bg-ink-100 overflow-hidden" aria-hidden="true">
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

function SectionHeading({ id, children }) {
  return (
    <h2 id={id} className="sl-label text-ink-400 mb-2.5">
      {children}
    </h2>
  );
}

export default function StudentDashboard() {
  const { data, isLoading } = useStudentProgressStats();

  const recentWeeklyVolume = useMemo(
    () => (data?.weeklyVolume || []).slice(-4),
    [data]
  );

  const maxWeeklyTotal = useMemo(() => {
    if (!recentWeeklyVolume.length) return 0;
    return Math.max(...recentWeeklyVolume.map((w) => w.pull + w.push));
  }, [recentWeeklyVolume]);

  if (isLoading) {
    return (
      <div className="p-4">
        <h1 className="sr-only">Stats</h1>
        <div className="flex justify-center py-12"><Spinner /></div>
      </div>
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
    sessionCalendar: [],
    exerciseProgress: { exercises: [], byExercise: {} },
  };

  const hasProgram = stats.totalSessions > 0;
  const completionPct =
    stats.totalSessions === 0
      ? 0
      : Math.round((stats.totalSessionsConfirmed / stats.totalSessions) * 100);

  return (
    <div className="p-4 pb-6 space-y-6">
      <div className="pt-3 pb-1">
        <div className="sl-label text-ink-400">Progress</div>
        <h1 className="sl-display text-[32px] text-gray-900 leading-none mt-1">Stats.</h1>
      </div>

      {!hasProgram && <EmptyState message="No program assigned yet" />}

      {hasProgram && (
        <>
          <section aria-labelledby="summary-heading">
            <SectionHeading id="summary-heading">Summary</SectionHeading>
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

          <section aria-labelledby="calendar-heading">
            <SectionHeading id="calendar-heading">Calendar</SectionHeading>
            <SessionCalendar sessions={stats.sessionCalendar} />
          </section>

          <section aria-labelledby="volume-heading">
            <SectionHeading id="volume-heading">Weekly volume</SectionHeading>
            <div className="sl-card p-4 space-y-3">
              {maxWeeklyTotal === 0 ? (
                <p className="sl-mono text-[11px] text-ink-400">No volume assigned yet.</p>
              ) : (
                recentWeeklyVolume.map((w) => (
                  <VolumeWeekRow key={w.week_id} week={w} maxTotal={maxWeeklyTotal} />
                ))
              )}
              {maxWeeklyTotal > 0 && (
                <div className="flex justify-between sl-mono text-[11px] text-ink-400 pt-2 border-t border-ink-100">
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-2 h-2 rounded-full bg-pull" />
                    PULL
                  </span>
                  <span className="flex items-center gap-1.5">
                    PUSH
                    <span className="inline-block w-2 h-2 rounded-full bg-push" />
                  </span>
                </div>
              )}
            </div>
          </section>

          <section aria-labelledby="progress-heading">
            <SectionHeading id="progress-heading">Exercise progression</SectionHeading>
            <ExerciseProgressChart
              exercises={stats.exerciseProgress?.exercises ?? []}
              byExercise={stats.exerciseProgress?.byExercise ?? {}}
            />
          </section>

          <section aria-labelledby="activity-heading">
            <SectionHeading id="activity-heading">Recent activity</SectionHeading>
            {stats.recentConfirmations.length === 0 ? (
              <EmptyState message="No confirmed sessions yet" />
            ) : (
              <div className="space-y-2">
                {stats.recentConfirmations.map((c) => (
                  <Link
                    key={c.id}
                    to={`/student/session/${c.session_id}`}
                    className="block sl-card p-3.5 hover:bg-ink-50 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="sl-display text-[15px] text-gray-900 truncate">
                        {c.session_title || `Session ${c.day_number}`}
                      </span>
                      <span className="sl-mono text-[11px] text-ink-400 shrink-0">
                        {new Date(c.confirmed_at).toLocaleDateString()}
                      </span>
                    </div>
                    <p className="sl-mono text-[11px] text-ink-400 mt-1">
                      W{c.week_number}
                      {c.week_label ? ` · ${c.week_label}` : ''} · Day {c.day_number}
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
