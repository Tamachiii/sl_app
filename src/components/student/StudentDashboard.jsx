import { Fragment, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Spinner from '../ui/Spinner';
import UserMenu from '../ui/UserMenu';
import { Icon, LargeTitle, ListGroup, Row } from '../parc';
import { formatNumber, pluralKey } from '../../lib/i18n/format';
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
  saveStatsScope,
  scopeReachesToday,
  settleSavedScope,
  statsPrefsKey,
} from '../../lib/statsPrefs';
import SessionCalendar from './SessionCalendar';
import ExerciseProgressChart from './ExerciseProgressChart';
import ProgramScopeSelector from './ProgramScopeSelector';
import WeeklyVolumePanel from './WeeklyVolumePanel';
import PersonalRecords from './PersonalRecords';
import BodyweightCard from './BodyweightCard';

const STATS_PREFS_KEY = statsPrefsKey({ surface: 'self' });
const EXERCISE_STORAGE_KEY = exerciseStorageKey(STATS_PREFS_KEY);

/**
 * The exercises of the scope as rows: the tonnage of their last session and
 * how it moved since the first one of the scope (design/parc/screens/
 * Stats.dc.html, « Progression »). A tap opens the chart of that exercise
 * under its row, and the open one is remembered (`storageKey`) as the chart's
 * choice was.
 */
function ProgressList({ exercises, byExercise, storageKey }) {
  const { t, lang } = useI18n();
  const [openId, setOpenId] = useState(() => {
    try {
      return localStorage.getItem(storageKey) || null;
    } catch {
      return null;
    }
  });
  function toggle(id) {
    const next = openId === id ? null : id;
    setOpenId(next);
    try {
      if (next) localStorage.setItem(storageKey, next);
      else localStorage.removeItem(storageKey);
    } catch {
      // Private mode, quota: the row opens all the same.
    }
  }
  const fmt = (n, options) => formatNumber(lang, Math.round(n), options);
  return (
    <ListGroup title={t('parcStats.progress')} aside={t('parcStats.progressAside')}>
      {exercises.length === 0 && (
        <li className="pk-row">
          <span className="pk-caption">{t('parcStats.chartNoExercises')}</span>
        </li>
      )}
      {exercises.map((ex) => {
        const points = byExercise[ex.id] || [];
        const last = points[points.length - 1];
        const delta = points.length > 1 ? last.tonnage - points[0].tonnage : null;
        const open = openId === ex.id;
        return (
          <Fragment key={ex.id}>
            <li>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => toggle(ex.id)}
                className="pk-row w-full bg-transparent text-left"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="pk-headline">{ex.name}</span>
                  {last && (
                    <span className="pk-caption">
                      <span className="sr-only">,</span>{' '}
                      {t('parcStats.progressLast', { kg: fmt(last.tonnage) })}
                    </span>
                  )}
                </span>
                {delta != null && Math.round(delta) !== 0 && (
                  <span className={`shrink-0 whitespace-nowrap text-[15px] font-bold ${delta > 0 ? 'text-blue' : 'text-ink-2'}`}>
                    <span className="sr-only">,</span>{' '}
                    {t('parcStats.progressDelta', { kg: fmt(delta, { signDisplay: 'exceptZero' }) })}
                  </span>
                )}
                <Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} className="shrink-0 text-ink-2" />
              </button>
            </li>
            {open && (
              <li className="border-b border-line pb-4 last:border-b-0">
                <ExerciseProgressChart exercises={exercises} byExercise={byExercise} exerciseId={ex.id} bare />
              </li>
            )}
          </Fragment>
        );
      })}
    </ListGroup>
  );
}

// The page's figures in words: sessions and sets done of what the scope holds,
// and the average RPE (« Bilan »).
function Summary({ stats, completionPct }) {
  const { t, lang } = useI18n();
  const n = (value) => formatNumber(lang, value);
  const row = (label, value, note) => (
    <Row
      title={label}
      subtitle={note}
      trailing={<span className="pk-tnum shrink-0 text-[17px] font-bold">{value}</span>}
    />
  );
  return (
    <ListGroup title={t('parcStats.summary')}>
      {row(
        t('parcStats.sessionsDone'),
        t('parcStats.ofTotal', { n: n(stats.totalSessionsConfirmed), total: n(stats.totalSessions) }),
        t('parcStats.percentDone', { pct: n(completionPct) }),
      )}
      {row(
        t('parcStats.setsDone'),
        t('parcStats.ofTotal', { n: n(stats.totalSetsDone), total: n(stats.totalSets) }),
        // The prescribed sets done, of the prescribed sets; what the athlete
        // added is said apart, never in the count.
        stats.totalExtraSetsDone > 0
          ? t(pluralKey(lang, stats.totalExtraSetsDone, 'parcStats.extraSetsCount'), { n: n(stats.totalExtraSetsDone) })
          : null,
      )}
      {row(
        t('parcStats.avgRpe'),
        stats.avgRpe != null ? formatNumber(lang, stats.avgRpe, { maximumFractionDigits: 1 }) : '–',
        stats.avgRpe != null ? null : t('parcStats.avgRpeEmpty'),
      )}
    </ListGroup>
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
  // id is only known once the programs list says the block still exists —
  // and that no new block has been made active since it was picked.
  // Stale ids fall back to 'all' rather than fetching ∅.
  const studentIdQuery = useMyStudentId();
  const programsQuery = useProgramsForStudent(studentIdQuery.data);
  const programs = programsQuery.data;
  const rawScope = searchParams.get('scope') || '';
  // Not memoized: picking "All" clears it, and the next render must see that.
  const saved = readStatsPrefs(STATS_PREFS_KEY);
  const { scope, resolved: scopeResolved, reset: scopeReset = false } = resolveStatsScope({
    urlScope: rawScope,
    savedScope: saved?.scope,
    savedActiveBlock: saved?.activeBlock,
    programs,
    listUnavailable: [studentIdQuery, programsQuery].some((q) => q.isError || q.isPaused),
  });

  // Once the scope is known, with no scope in the URL: the saved scope is
  // settled (forgotten when a new block replaced it, stamped when it was saved
  // before the stamp existed) and the scope is mirrored into the address, so
  // the URL names what the page shows. It waits for the scope to be known:
  // written at mount, the saved block reached the URL before the list could
  // say it was replaced, and the URL wins over what was saved. The stats
  // query never waits for this.
  useEffect(() => {
    if (!scopeResolved || rawScope) return;
    settleSavedScope(STATS_PREFS_KEY, { reset: scopeReset, programs });
    if (scope === 'all') return;
    const sp = new URLSearchParams(searchParams);
    sp.set('scope', scope);
    setSearchParams(sp, { replace: true });
  }, [scopeResolved, rawScope, scopeReset, scope, programs, searchParams, setSearchParams]);

  function handleScopeChange(next) {
    const sp = new URLSearchParams(searchParams);
    if (next === 'all') sp.delete('scope');
    else sp.set('scope', next);
    setSearchParams(sp, { replace: true });
    saveStatsScope(STATS_PREFS_KEY, next, programs);
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

  const stats = data || {
    totalSessions: 0,
    totalSessionsConfirmed: 0,
    totalSets: 0,
    totalSetsDone: 0,
    totalExtraSetsDone: 0,
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

  // What the figures are of, under the title — nothing while the block in
  // progress is not known yet: "all your blocks" would name what is not shown.
  const scoped = Array.isArray(programs)
    ? programs.find((p) => p.id === scope || (scope === 'active' && p.is_active))
    : null;
  const subtitle = scoped
    ? scoped.is_active
      ? t('parcStats.subtitleActive', { name: scoped.name })
      : scoped.name
    : scope === 'all'
      ? t('parcStats.subtitleAll')
      : null;

  // The figures of the scope that is leaving are marked as such; the records
  // and the bodyweight do not follow the scope and stay as they are.
  const outgoing = isSwitchingScope ? { 'aria-busy': 'true' } : {};
  const scopedClass = `flex flex-col gap-6${isSwitchingScope ? ' opacity-50' : ''}`;

  return (
    <div className="flex flex-col gap-6 px-4 pt-3 pb-6 md:px-8">
      <header className="flex flex-col gap-4">
        <LargeTitle
          title={t('parcStats.title')}
          subtitle={isLoading ? null : subtitle}
          trailing={<UserMenu fullName={profile?.full_name} onSignOut={signOut} profileHref="/student/profile" />}
        />
        {/* Not before the scope is known: the chips would press "All" first. */}
        {!isLoading && Array.isArray(programs) && programs.length > 0 && (
          <ProgramScopeSelector programs={programs} value={scope} onChange={handleScopeChange} />
        )}
      </header>

      {/* The records and the bodyweight are all-time: they are read from the
          start, without waiting for the figures of the scope. */}
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-2 lg:items-start">
        <div className="flex flex-col gap-6">
          {isLoading ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : (
            <div className={scopedClass} {...outgoing}>
              {!hasProgram && <p className="rounded-group bg-surface p-4 pk-body">{t('parcStats.empty')}</p>}
              {hasProgram && (
                <>
                  <WeeklyVolumePanel weeks={stats.weeklyVolume} current={scopeReachesToday(scope, programs)} />
                  <ProgressList
                    exercises={stats.exerciseProgress?.exercises ?? []}
                    byExercise={stats.exerciseProgress?.byExercise ?? {}}
                    storageKey={EXERCISE_STORAGE_KEY}
                  />
                </>
              )}
            </div>
          )}
          <PersonalRecords />
        </div>
        <div className="flex flex-col gap-6">
          <BodyweightCard />
          {!isLoading && hasProgram && (
            <div className={scopedClass} {...outgoing}>
              <Summary stats={stats} completionPct={completionPct} />
              <SessionCalendar
                sessions={
                  // Never over the figures of the scope that is leaving.
                  showHistoricalOverlay && !isSwitchingScope
                    ? [...(stats.sessionCalendar || []), ...(historicalSessions || [])]
                    : (stats.sessionCalendar || [])
                }
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
