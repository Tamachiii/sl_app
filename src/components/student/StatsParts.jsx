// Two parts of the stats, shared by the athlete's page and the coach's section
// of an athlete, so that both say the same figures the same way.
import { Fragment, useState } from 'react';
import { useI18n } from '../../hooks/useI18n';
import { formatNumber, pluralKey } from '../../lib/i18n/format';
import { Icon, ListGroup, Row } from '../parc';
import ExerciseProgressChart from './ExerciseProgressChart';

/**
 * The exercises of the scope as rows: the tonnage of their last session and
 * how it moved since the first one of the scope (design/parc/screens/
 * Stats.dc.html, « Progression »). A tap opens the chart of that exercise
 * under its row, and the open one is remembered (`storageKey`) as the chart's
 * choice was.
 */
export function ProgressList({ exercises, byExercise, storageKey }) {
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
export function Summary({ stats, completionPct }) {
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
