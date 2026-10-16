// Shared weekly-volume panel for the student Stats page and the coach's
// per-student Stats tab, so the performance-aware rendering (performed bars
// over a faint planned ghost track + per-week adherence) can't drift between
// the two surfaces again.
//
// A row is a REAL calendar week (Mon–Sun), labelled by its date range. It
// used to be an ordinal training week labelled "W3", which said nothing about
// when the work happened — a block spread over ten days still read as one
// week.
//
// The rows are consecutive weeks, a week with nothing trained included, as a
// row of zeros (`weeklyWindow`). They used to be the last four weeks TRAINED,
// so a three-week layoff simply did not show — the four rows could be months
// apart.

import { useMemo } from 'react';
import { useI18n } from '../../hooks/useI18n';
import { addDays, isoDate, parseISODate, startOfWeekMonday } from '../../lib/day';
import { formatDateRange } from '../../lib/i18n/format';

/** How many weeks the panel shows. */
export const WEEKS_SHOWN = 4;

/** Scale bars to the larger of performed / planned so the ghost track fits. */
export function computeMaxWeeklyTotal(weeks) {
  if (!weeks?.length) return 0;
  return Math.max(
    ...weeks.map((w) =>
      Math.max(w.pull + w.push, (w.pull_planned || 0) + (w.push_planned || 0))
    )
  );
}

// A week nothing was trained in, in the shape of the hook's buckets.
function emptyWeek(monday) {
  return {
    bucket_start: isoDate(monday),
    bucket_end: isoDate(addDays(monday, 6)),
    pull: 0,
    push: 0,
    pull_planned: 0,
    push_planned: 0,
    sets_done: 0,
    extra_sets_done: 0,
    sets_prescribed: 0,
    sessions_confirmed: 0,
  };
}

/**
 * The weeks the panel draws, oldest first: `size` consecutive Mon–Sun weeks,
 * each the hook's bucket for it or a week of zeros.
 *
 *   weeklyWindow(stats.weeklyVolume, { now, current })
 *
 *   - The window ends at the week of `now` when `current` is true — the scope
 *     holds the block being trained (`scopeReachesToday`), so the weeks since
 *     the last session are part of the picture. It ends at the newest trained
 *     week otherwise: a past block's last four weeks are its own, not four
 *     empty weeks of today.
 *   - It never starts before the oldest trained week: an athlete in their
 *     second week sees two rows, not two empty weeks before they began.
 *   - Nothing trained in the scope gives [] — the panel then says so.
 *
 * `weeks` is the hook's `weeklyVolume`: one bucket per week trained, keyed by
 * the Monday of that week (`bucket_start`).
 */
export function weeklyWindow(weeks, { now = new Date(), current = true, size = WEEKS_SHOWN } = {}) {
  const buckets = (weeks || []).filter((w) => parseISODate(w?.bucket_start));
  if (buckets.length === 0) return [];
  const byStart = new Map(buckets.map((w) => [w.bucket_start, w]));
  const starts = [...byStart.keys()].sort();
  const oldest = starts[0];
  const newest = starts[starts.length - 1];
  const thisWeek = isoDate(startOfWeekMonday(now));
  // A bucket later than this week (a clock that is behind) still ends it.
  const end = current && thisWeek > newest ? thisWeek : newest;

  const out = [];
  let monday = parseISODate(end);
  for (let i = 0; i < size; i += 1) {
    const key = isoDate(monday);
    if (key < oldest) break;
    out.push(byStart.get(key) ?? emptyWeek(monday));
    monday = addDays(monday, -7);
  }
  return out.reverse();
}

/** "Jul 6 – 12" for the bucket's Mon–Sun span, in the app's language. */
export function formatBucketRange(bucketStart, lang) {
  const monday = parseISODate(bucketStart);
  if (!monday) return '';
  return formatDateRange(lang, monday, addDays(monday, 6));
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
  // Shown whenever the week had prescribed sets, volume or not: a week of
  // planks and holds has no volume and is still 3/3.
  const adherence =
    sets_prescribed > 0 ? Math.round((sets_done / sets_prescribed) * 100) : null;

  return (
    <div className="space-y-1.5" data-week={bucket_start}>
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

/**
 * `weeks` is the hook's `weeklyVolume`, whole; the panel picks its window.
 * `current` says whether the scope holds the block being trained
 * (`scopeReachesToday` of lib/statsPrefs). `now` is for tests.
 */
export default function WeeklyVolumePanel({ weeks, current = true, now }) {
  const { t, lang } = useI18n();
  const shown = useMemo(() => weeklyWindow(weeks, { now, current }), [weeks, now, current]);
  const maxTotal = computeMaxWeeklyTotal(shown);
  const hasAdherence = shown.some((w) => w.sets_prescribed > 0);

  if (shown.length === 0) {
    return (
      <div className="sl-card p-4">
        <p className="sl-mono text-[11px] text-ink-400">{t('statsPanels.noTraining')}</p>
      </div>
    );
  }

  return (
    <div className="sl-card p-4 space-y-3">
      {shown.map((w) => (
        <VolumeWeekRow key={w.bucket_start} week={w} maxTotal={maxTotal} t={t} lang={lang} />
      ))}
      {(maxTotal > 0 || hasAdherence) && (
        <div className="space-y-1.5 pt-2 border-t border-ink-100">
          {maxTotal > 0 && (
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
          )}
          {maxTotal > 0 && (
            <p className="sl-mono text-[10px] text-ink-400">
              {t('student.stats.volumePerformedNote')}
            </p>
          )}
          {/* Planned work travels with a session into the week it was
              trained, so a week's sets are those of the sessions trained in
              it — never of a session still to do. */}
          {hasAdherence && (
            <p className="sl-mono text-[10px] text-ink-400">{t('statsPanels.adherenceNote')}</p>
          )}
        </div>
      )}
    </div>
  );
}
