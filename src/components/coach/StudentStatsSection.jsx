import { useEffect, useMemo } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import { useStudentProgressStats } from '../../hooks/useStudentProgressStats';
import { useProgramsForStudent } from '../../hooks/useProgram';
import {
  exerciseStorageKey,
  readStatsPrefs,
  statsPrefsKey,
  writeStatsPref,
} from '../../lib/statsPrefs';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import ExerciseProgressChart from '../student/ExerciseProgressChart';
import ProgramScopeSelector from '../student/ProgramScopeSelector';
import WeeklyVolumePanel, { computeMaxWeeklyTotal } from '../student/WeeklyVolumePanel';

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
  const { data: programs } = useProgramsForStudent(studentId);

  const prefsKey = useMemo(
    () => statsPrefsKey({ surface: 'coach', studentId }),
    [studentId],
  );
  const exerciseKey = useMemo(() => exerciseStorageKey(prefsKey), [prefsKey]);

  // `statsScope` (separate from `program`, which the editor's ProgramSwitcher
  // already owns) so the coach's "what program am I editing" and "what scope
  // am I viewing stats for" stay independent. URL holds it for refresh-on-page;
  // localStorage mirrors it so it survives a tab switch (which drops the URL
  // search params).
  const rawScope = searchParams.get('statsScope') || '';

  useEffect(() => {
    if (rawScope) return;
    const saved = readStatsPrefs(prefsKey)?.scope;
    if (!saved || saved === 'all') return;
    const sp = new URLSearchParams(searchParams);
    sp.set('statsScope', saved);
    setSearchParams(sp, { replace: true });
    // Re-run when the student changes — the saved scope is per-student.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefsKey]);

  const effectiveScope = rawScope || 'all';
  const scopeIsValid =
    effectiveScope === 'all'
    || effectiveScope === 'active'
    || (Array.isArray(programs) && programs.some((p) => p.id === effectiveScope));
  const scope = scopeIsValid ? effectiveScope : 'all';

  function handleScopeChange(next) {
    const sp = new URLSearchParams(searchParams);
    if (next === 'all') sp.delete('statsScope');
    else sp.set('statsScope', next);
    setSearchParams(sp, { replace: true });
    writeStatsPref(prefsKey, 'scope', next === 'all' ? null : next);
  }

  const { data, isLoading } = useStudentProgressStats(studentId, scope);

  const recentWeeklyVolume = useMemo(
    () => (data?.weeklyVolume || []).slice(-4),
    [data]
  );

  const maxWeeklyTotal = useMemo(
    () => computeMaxWeeklyTotal(recentWeeklyVolume),
    [recentWeeklyVolume]
  );

  if (isLoading) {
    return <div className="flex justify-center py-6"><Spinner /></div>;
  }

  const stats = data || {
    totalSessions: 0,
    totalSessionsConfirmed: 0,
    totalSets: 0,
    totalSetsDone: 0,
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

      {/* Coach-voice, and accurate: the athlete may well have a program, they
          just have not logged anything in the selected scope yet. This used to
          render the student-side "No program assigned yet". */}
      {!hasData && <EmptyState message={t('coach.stats.noData')} compact />}

      {hasData && <CoachStatsBody
        stats={stats}
        completionPct={completionPct}
        recentWeeklyVolume={recentWeeklyVolume}
        maxWeeklyTotal={maxWeeklyTotal}
        exerciseStorageKey={exerciseKey}
        t={t}
      />}
    </div>
  );
}

function CoachStatsBody({ stats, completionPct, recentWeeklyVolume, maxWeeklyTotal, exerciseStorageKey, t }) {
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
          sub={t('student.stats.ofPrescribed', { n: stats.totalSets })}
        />
        <StatCard
          label={t('student.stats.avgRpe')}
          value={stats.avgRpe != null ? stats.avgRpe.toFixed(1) : '—'}
          sub={stats.avgRpe != null ? t('student.stats.acrossLogged') : t('student.stats.logSetsToSee')}
        />
      </div>

      <div>
        <div className="sl-label text-ink-400 mb-2.5">{t('student.stats.weeklyVolume')}</div>
        <WeeklyVolumePanel weeks={recentWeeklyVolume} maxTotal={maxWeeklyTotal} t={t} />
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
