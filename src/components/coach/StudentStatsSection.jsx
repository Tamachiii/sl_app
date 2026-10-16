import { useEffect, useMemo } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import { useStudentProgressStats } from '../../hooks/useStudentProgressStats';
import { useProgramsForStudent } from '../../hooks/useProgram';
import {
  exerciseStorageKey,
  readStatsPrefs,
  resolveStatsScope,
  saveStatsScope,
  scopeReachesToday,
  settleSavedScope,
  statsPrefsKey,
} from '../../lib/statsPrefs';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import ExerciseProgressChart from '../student/ExerciseProgressChart';
import ProgramScopeSelector from '../student/ProgramScopeSelector';
import WeeklyVolumePanel from '../student/WeeklyVolumePanel';

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

export default function StudentStatsSection() {
  const { student } = useOutletContext();
  const studentId = student.id;
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const programsQuery = useProgramsForStudent(studentId);
  const programs = programsQuery.data;

  const prefsKey = useMemo(
    () => statsPrefsKey({ surface: 'coach', studentId }),
    [studentId],
  );
  const exerciseKey = useMemo(() => exerciseStorageKey(prefsKey), [prefsKey]);

  // `statsScope` (separate from `program`, which the editor's ProgramSwitcher
  // already owns) so the coach's "what program am I editing" and "what scope
  // am I viewing stats for" stay independent. The URL wins, else what the
  // coach picked last time for THIS athlete (localStorage, which survives a
  // tab switch — that drops the URL search params). Both are read DURING
  // RENDER, so the first render already knows what to compute, and the stats
  // query waits until it does: a saved program id is only known once the
  // programs list says the block still exists — and that no new block has
  // been made active since it was picked.
  const rawScope = searchParams.get('statsScope') || '';
  // Not memoized: picking "All" clears it, and the next render must see that.
  const saved = readStatsPrefs(prefsKey);
  const { scope, resolved: scopeResolved, reset: scopeReset = false } = resolveStatsScope({
    urlScope: rawScope,
    savedScope: saved?.scope,
    savedActiveBlock: saved?.activeBlock,
    programs,
    listUnavailable: !!(programsQuery.isError || programsQuery.isPaused),
  });

  // Once the scope of THIS athlete is known, with no scope in the URL: the
  // saved scope is settled and the scope mirrored into the address, as on the
  // athlete's own page (StudentDashboard says why it waits).
  useEffect(() => {
    if (!scopeResolved || rawScope) return;
    settleSavedScope(prefsKey, { reset: scopeReset, programs });
    if (scope === 'all') return;
    const sp = new URLSearchParams(searchParams);
    sp.set('statsScope', scope);
    setSearchParams(sp, { replace: true });
  }, [prefsKey, scopeResolved, rawScope, scopeReset, scope, programs, searchParams, setSearchParams]);

  function handleScopeChange(next) {
    const sp = new URLSearchParams(searchParams);
    if (next === 'all') sp.delete('statsScope');
    else sp.set('statsScope', next);
    setSearchParams(sp, { replace: true });
    saveStatsScope(prefsKey, next, programs);
  }

  const statsQuery = useStudentProgressStats(studentId, scope, { enabled: scopeResolved });
  const { data } = statsQuery;
  // A query that is held back is not "loading" for React Query, and the
  // section has nothing to show yet either way.
  const isLoading = !scopeResolved || statsQuery.isLoading;
  // The coach changed the scope and the new one is on its way: `data` is
  // still the previous scope's (never another athlete's — the hook sees to
  // that). The section stays, selector included, which already shows the new
  // choice, and its figures are marked as outgoing.
  const isSwitchingScope = !!statsQuery.isPlaceholderData;

  if (isLoading) {
    return <div className="flex justify-center py-6"><Spinner /></div>;
  }

  const stats = data || {
    totalSessions: 0,
    totalSessionsConfirmed: 0,
    totalSets: 0,
    totalSetsDone: 0,
    totalExtraSetsDone: 0,
    avgRpe: null,
    weeklyVolume: [],
    exerciseProgress: { exercises: [], byExercise: {} },
  };

  const completionPct = stats.totalSessions === 0
    ? 0
    : Math.round((stats.totalSessionsConfirmed / stats.totalSessions) * 100);

  const hasPrograms = Array.isArray(programs) && programs.length > 0;
  const hasData = stats.totalSessions > 0;

  return (
    <div className="space-y-4">
      {hasPrograms && (
        <ProgramScopeSelector
          programs={programs}
          value={scope}
          onChange={handleScopeChange}
        />
      )}

      <div
        className={isSwitchingScope ? 'opacity-50' : undefined}
        aria-busy={isSwitchingScope ? 'true' : undefined}
      >
        {/* Coach-voice, and accurate: the athlete may well have a program, they
            just have not logged anything in the selected scope yet. This used to
            render the student-side "No program assigned yet". */}
        {!hasData && <EmptyState message={t('coach.stats.noData')} compact />}

        {hasData && <CoachStatsBody
          stats={stats}
          completionPct={completionPct}
          weeksReachToday={scopeReachesToday(scope, programs)}
          exerciseStorageKey={exerciseKey}
          t={t}
        />}
      </div>
    </div>
  );
}

function CoachStatsBody({ stats, completionPct, weeksReachToday, exerciseStorageKey, t }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <StatCard
          label={t('student.stats.sessions')}
          value={`${stats.totalSessionsConfirmed}/${stats.totalSessions}`}
          sub={t('student.stats.pctComplete', { n: completionPct })}
        />
        <StatCard
          label={t('student.stats.setsDone')}
          value={stats.totalSetsDone}
          // The prescribed sets done, of the prescribed sets; what the athlete
          // added is said apart, never in the count.
          sub={stats.totalExtraSetsDone > 0
            ? `${t('student.stats.ofPrescribed', { n: stats.totalSets })} · ${t('statsCompletionRules.extraSets', { n: stats.totalExtraSetsDone })}`
            : t('student.stats.ofPrescribed', { n: stats.totalSets })}
        />
        <StatCard
          label={t('student.stats.avgRpe')}
          value={stats.avgRpe != null ? stats.avgRpe.toFixed(1) : '—'}
          sub={stats.avgRpe != null ? t('student.stats.acrossLogged') : t('student.stats.logSetsToSee')}
        />
      </div>

      <div>
        <div className="sl-label text-ink-400 mb-2.5">{t('student.stats.weeklyVolume')}</div>
        <WeeklyVolumePanel weeks={stats.weeklyVolume} current={weeksReachToday} />
      </div>

      <div>
        <div className="sl-label text-ink-400 mb-2.5">
          {t('student.stats.exerciseProgression')}
        </div>
        <ExerciseProgressChart
          exercises={stats.exerciseProgress?.exercises ?? []}
          byExercise={stats.exerciseProgress?.byExercise ?? {}}
          storageKey={exerciseStorageKey}
        />
      </div>
    </div>
  );
}
