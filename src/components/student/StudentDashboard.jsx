import { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import UserMenu from '../ui/UserMenu';
import { useAuth } from '../../hooks/useAuth';
import { useStudentProgressStats } from '../../hooks/useStudentProgressStats';
import { useStudentHistoricalSessions } from '../../hooks/useStudentHistoricalSessions';
import { useMyStudentId } from '../../hooks/useStudents';
import { useProgramsForStudent } from '../../hooks/useProgram';
import { useI18n } from '../../hooks/useI18n';
import {
  exerciseStorageKey,
  readStatsPrefs,
  resolveStatsScope,
  statsPrefsKey,
  writeStatsPref,
} from '../../lib/statsPrefs';
import SessionCalendar from './SessionCalendar';
import ExerciseProgressChart from './ExerciseProgressChart';
import ProgramScopeSelector from './ProgramScopeSelector';
import WeeklyVolumePanel, { computeMaxWeeklyTotal } from './WeeklyVolumePanel';

const STATS_PREFS_KEY = statsPrefsKey({ surface: 'self' });
const EXERCISE_STORAGE_KEY = exerciseStorageKey(STATS_PREFS_KEY);

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
  const [searchParams, setSearchParams] = useSearchParams();

  // Scope: the URL (`?scope=`) wins, else what the athlete picked last time
  // (localStorage, which survives a tab switch — the new URL has no search
  // params). Both are read DURING RENDER, so the first render already knows
  // what to compute, and the stats query waits until it does: a saved program
  // id is only known once the programs list says the block still exists.
  // Stale ids fall back to 'all' rather than fetching ∅.
  const studentIdQuery = useMyStudentId();
  const programsQuery = useProgramsForStudent(studentIdQuery.data);
  const programs = programsQuery.data;
  const rawScope = searchParams.get('scope') || '';
  const { scope, resolved: scopeResolved } = resolveStatsScope({
    urlScope: rawScope,
    // Not memoized: picking "All" clears it, and the next render must see that.
    savedScope: readStatsPrefs(STATS_PREFS_KEY)?.scope,
    programs,
    listUnavailable: [studentIdQuery, programsQuery].some((q) => q.isError || q.isPaused),
  });

  // Mirrors the saved scope into the address, so the URL names what the page
  // shows. Nothing waits for it: the scope above is already the saved one.
  useEffect(() => {
    if (rawScope) return;
    const saved = readStatsPrefs(STATS_PREFS_KEY)?.scope;
    if (!saved || saved === 'all') return;
    const sp = new URLSearchParams(searchParams);
    sp.set('scope', saved);
    setSearchParams(sp, { replace: true });
    // Mount-only — subsequent changes flow through handleScopeChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleScopeChange(next) {
    const sp = new URLSearchParams(searchParams);
    if (next === 'all') sp.delete('scope');
    else sp.set('scope', next);
    setSearchParams(sp, { replace: true });
    writeStatsPref(STATS_PREFS_KEY, 'scope', next === 'all' ? null : next);
  }

  const statsQuery = useStudentProgressStats(undefined, scope, { enabled: scopeResolved });
  const { data } = statsQuery;
  // A query that is held back is not "loading" for React Query, and the page
  // has nothing to show yet either way.
  const isLoading = !scopeResolved || statsQuery.isLoading;
  // The athlete changed the scope and the new one is on its way: `data` is
  // still the previous scope's. The page stays — selector included, which
  // already shows the new choice — and its figures are marked as outgoing.
  const isSwitchingScope = !!statsQuery.isPlaceholderData;
  // Historical-sessions overlay only adds value when stats are scoped to the
  // active block — in 'all' or specific-program scope, the calendar already
  // includes everything in scope, so the overlay would be redundant noise.
  // It is only READ in that scope too.
  const showHistoricalOverlay = scopeResolved && scope === 'active';
  const { data: historicalSessions } = useStudentHistoricalSessions({
    enabled: showHistoricalOverlay,
  });

  const recentWeeklyVolume = useMemo(
    () => (data?.weeklyVolume || []).slice(-4),
    [data]
  );

  const maxWeeklyTotal = useMemo(
    () => computeMaxWeeklyTotal(recentWeeklyVolume),
    [recentWeeklyVolume]
  );

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
        <UserMenu fullName={profile?.full_name} onSignOut={signOut} profileHref="/student/profile" />
      </div>

      {Array.isArray(programs) && programs.length > 0 && (
        <ProgramScopeSelector
          programs={programs}
          value={scope}
          onChange={handleScopeChange}
        />
      )}

      <div
        className={`space-y-6${isSwitchingScope ? ' opacity-50' : ''}`}
        aria-busy={isSwitchingScope ? 'true' : undefined}
      >
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
              <SessionCalendar
                sessions={
                  // Never over the figures of the scope that is leaving.
                  showHistoricalOverlay && !isSwitchingScope
                    ? [...(stats.sessionCalendar || []), ...(historicalSessions || [])]
                    : (stats.sessionCalendar || [])
                }
              />
            </section>

            <section aria-labelledby="volume-heading">
              <SectionHeading id="volume-heading">{t('student.stats.weeklyVolume')}</SectionHeading>
              <WeeklyVolumePanel weeks={recentWeeklyVolume} maxTotal={maxWeeklyTotal} t={t} />
            </section>

            <section aria-labelledby="progress-heading">
              <SectionHeading id="progress-heading">{t('student.stats.exerciseProgression')}</SectionHeading>
              <ExerciseProgressChart
                exercises={stats.exerciseProgress?.exercises ?? []}
                byExercise={stats.exerciseProgress?.byExercise ?? {}}
                storageKey={EXERCISE_STORAGE_KEY}
              />
            </section>
          </>
        )}
      </div>
    </div>
  );
}
