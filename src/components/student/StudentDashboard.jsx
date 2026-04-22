import { useMemo } from 'react';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import UserMenu from '../ui/UserMenu';
import { useAuth } from '../../hooks/useAuth';
import { useStudentProgressStats } from '../../hooks/useStudentProgressStats';
import { useI18n } from '../../hooks/useI18n';
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
  const { t } = useI18n();
  const { profile, signOut } = useAuth();
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
    <div className="p-4 pb-6 md:p-8 space-y-6">
      <div className="pt-3 pb-1 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="sl-label text-ink-400">{t('student.stats.kicker')}</div>
          <h1 className="sl-display text-[32px] md:text-[44px] text-gray-900 leading-none mt-1">{t('student.stats.title')}</h1>
        </div>
        <UserMenu fullName={profile?.full_name} onSignOut={signOut} />
      </div>

      {!hasProgram && <EmptyState message={t('student.home.noProgram')} />}

      {hasProgram && (
        <>
          <section aria-labelledby="summary-heading">
            <SectionHeading id="summary-heading">{t('student.stats.summary')}</SectionHeading>
            <div className="grid grid-cols-3 gap-2">
              <StatCard
                label={t('student.stats.sessions')}
                value={`${stats.totalSessionsConfirmed}/${stats.totalSessions}`}
                sub={t('student.stats.pctComplete', { n: completionPct })}
              />
              <StatCard
                label={t('student.stats.setsDone')}
                value={stats.totalSetsDone}
                sub={t('student.stats.ofPrescribed', { n: stats.totalSets })}
              />
              <StatCard
                label={t('student.stats.avgRpe')}
                value={stats.avgRpe != null ? stats.avgRpe.toFixed(1) : '—'}
                sub={stats.avgRpe != null ? t('student.stats.acrossLogged') : t('student.stats.logSetsToSee')}
              />
            </div>
          </section>

          <section aria-labelledby="calendar-heading">
            <SectionHeading id="calendar-heading">{t('student.stats.calendar')}</SectionHeading>
            <SessionCalendar sessions={stats.sessionCalendar} />
          </section>

          <section aria-labelledby="volume-heading">
            <SectionHeading id="volume-heading">{t('student.stats.weeklyVolume')}</SectionHeading>
            <div className="sl-card p-4 space-y-3">
              {maxWeeklyTotal === 0 ? (
                <p className="sl-mono text-[11px] text-ink-400">{t('student.stats.noVolume')}</p>
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
            <SectionHeading id="progress-heading">{t('student.stats.exerciseProgression')}</SectionHeading>
            <ExerciseProgressChart
              exercises={stats.exerciseProgress?.exercises ?? []}
              byExercise={stats.exerciseProgress?.byExercise ?? {}}
            />
          </section>
        </>
      )}
    </div>
  );
}
