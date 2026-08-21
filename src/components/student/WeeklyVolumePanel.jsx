// Shared weekly-volume panel for the student Stats page and the coach's
// per-student Stats tab, so the performance-aware rendering (performed bars
// over a faint planned ghost track + per-week adherence) can't drift between
// the two surfaces again.
//
// A row is a REAL calendar week the student trained in (Mon–Sun), labelled by
// its date range. It used to be an ordinal training week labelled "W3", which
// said nothing about when the work happened — a block spread over ten days
// still read as one week.

import { useI18n } from '../../hooks/useI18n';
import { addDays, parseISODate } from '../../lib/day';

const LOCALE = { en: 'en-US', fr: 'fr-FR', de: 'de-DE' };

/** Scale bars to the larger of performed / planned so the ghost track fits. */
export function computeMaxWeeklyTotal(weeks) {
  if (!weeks?.length) return 0;
  return Math.max(
    ...weeks.map((w) =>
      Math.max(w.pull + w.push, (w.pull_planned || 0) + (w.push_planned || 0))
    )
  );
}

/** "6 – 12 Jul" for the bucket's Mon–Sun span. */
export function formatBucketRange(bucketStart, lang) {
  const monday = parseISODate(bucketStart);
  if (!monday) return '';
  const locale = LOCALE[lang] || LOCALE.en;
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).formatRange(
    monday,
    addDays(monday, 6)
  );
}

function VolumeWeekRow({ week, maxTotal, t, lang }) {
  const { bucket_start, pull, push, sets_done, sets_prescribed } = week;
  // `pull`/`push` are PERFORMED; `*_planned` is the prescribed reference.
  const total = pull + push;
  const planned = (week.pull_planned || 0) + (week.push_planned || 0);
  const rowPct = maxTotal === 0 ? 0 : (total / maxTotal) * 100;
  const plannedPct = maxTotal === 0 ? 0 : (planned / maxTotal) * 100;
  const pullPct = total === 0 ? 0 : (pull / total) * 100;
  const pushPct = total === 0 ? 0 : (push / total) * 100;
  const adherence =
    sets_prescribed > 0 ? Math.round((sets_done / sets_prescribed) * 100) : null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="sl-mono text-[11px] text-gray-800">
          {formatBucketRange(bucket_start, lang)}
        </span>
        <span className="sl-mono text-[11px] text-ink-400 tabular-nums">
          {adherence != null && (
            <span className="mr-2">
              {t('student.stats.setsAdherence', {
                done: sets_done,
                total: sets_prescribed,
                pct: adherence,
              })}
            </span>
          )}
          {Math.round(total)}
        </span>
      </div>
      {/* Faint full-width track sized to the PLANNED volume; the performed
          pull/push bar sits on top, so a short bar in a long track reads as
          "did less than planned" at a glance. */}
      <div className="relative h-2.5 rounded-full bg-ink-100 overflow-hidden">
        {planned > 0 && (
          <div
            className="absolute inset-y-0 left-0 bg-ink-200"
            style={{ width: `${plannedPct}%` }}
            aria-hidden="true"
          />
        )}
        {total > 0 && (
          <div className="relative flex h-full" style={{ width: `${rowPct}%` }} aria-hidden="true">
            {pull > 0 && <div className="bg-pull" style={{ width: `${pullPct}%` }} />}
            {push > 0 && <div className="bg-push" style={{ width: `${pushPct}%` }} />}
          </div>
        )}
      </div>
    </div>
  );
}

export default function WeeklyVolumePanel({ weeks, maxTotal, t }) {
  const { lang } = useI18n();
  return (
    <div className="sl-card p-4 space-y-3">
      {maxTotal === 0 ? (
        <p className="sl-mono text-[11px] text-ink-400">{t('student.stats.noVolume')}</p>
      ) : (
        weeks.map((w) => (
          <VolumeWeekRow key={w.bucket_start} week={w} maxTotal={maxTotal} t={t} lang={lang} />
        ))
      )}
      {maxTotal > 0 && (
        <div className="space-y-1.5 pt-2 border-t border-ink-100">
          <div className="flex justify-between sl-mono text-[11px] text-ink-400">
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-pull" />
              PULL
            </span>
            <span className="flex items-center gap-1.5">
              PUSH
              <span className="inline-block w-2 h-2 rounded-full bg-push" />
            </span>
          </div>
          <p className="sl-mono text-[10px] text-ink-400">
            {t('student.stats.volumePerformedNote')}
          </p>
        </div>
      )}
    </div>
  );
}
