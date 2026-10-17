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

import { useId, useMemo } from 'react';
import { useI18n } from '../../hooks/useI18n';
import { addDays, isoDate, parseISODate, startOfWeekMonday } from '../../lib/day';
import { formatDate, formatDateRange, formatNumber } from '../../lib/i18n/format';

/** How many weeks the panel shows (design/parc/screens/Stats.dc.html: six). */
export const WEEKS_SHOWN = 6;

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

// The geometry of the chart, in the units of its viewBox: the plot sits
// right of the value axis and above the week labels.
const W = 326;
const H = 168;
const PLOT_LEFT = 28;
const PLOT_TOP = 12;
const BASELINE = 140;
const BAR_W = 14;
const BAR_GAP = 4;
const RADIUS = 4;

// A round number at or above `max`, for the top of the axis: 2, 5 or 10 times
// a power of ten, so the three ticks read cleanly.
function niceCeiling(max) {
  if (max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 5, 10].find((m) => m * power >= max) ?? 10;
  return step * power;
}

// A bar that grows from the baseline, its data end rounded and its foot
// square (the dataviz marks: 4px data-end, square at the baseline).
function barPath(x, top, width) {
  const height = BASELINE - top;
  if (height <= 0) return '';
  const r = Math.min(RADIUS, height, width / 2);
  return `M${x},${BASELINE} V${top + r} Q${x},${top} ${x + r},${top} H${x + width - r} Q${x + width},${top} ${x + width},${top + r} V${BASELINE} Z`;
}

/**
 * The volume of the last weeks as columns, pull and push side by side
 * (design/parc/screens/Stats.dc.html): `chart-pull` and `chart-push` on
 * `surface`, a written legend, the value axis in three ticks, each week named
 * by its Monday — the current one in bold — and one sentence for the last week.
 * A screen reader gets the same as a table; each week says its figures on
 * hover (`<title>`).
 *
 * `weeks` is the hook's `weeklyVolume`, whole; the panel picks its window.
 * `current` says whether the scope holds the block being trained
 * (`scopeReachesToday` of lib/statsPrefs). `now` is for tests.
 */
export default function WeeklyVolumePanel({ weeks, current = true, now }) {
  const { t, lang } = useI18n();
  const titleId = useId();
  const shown = useMemo(() => weeklyWindow(weeks, { now, current }), [weeks, now, current]);
  const peak = Math.max(0, ...shown.map((w) => Math.max(w.pull, w.push)));
  const top = niceCeiling(peak);
  const thisWeek = isoDate(startOfWeekMonday(now ?? new Date()));

  const header = (
    <>
      <h2 id={titleId} className="pk-headline">
        {t('parcStats.volumeTitle')}
      </h2>
      <p className="pk-caption mt-0.5">{t('parcStats.volumeCaption')}</p>
    </>
  );

  if (shown.length === 0) {
    return (
      <section aria-labelledby={titleId} className="rounded-group bg-surface p-4">
        {header}
        <p className="pk-caption mt-3">{t('parcStats.noTraining')}</p>
      </section>
    );
  }

  const band = (W - PLOT_LEFT) / shown.length;
  const yFor = (value) => BASELINE - (value / top) * (BASELINE - PLOT_TOP);
  const weekLabel = (w) => formatDate(lang, parseISODate(w.bucket_start), { day: 'numeric', month: 'short' });
  const fmt = (value) => formatNumber(lang, Math.round(value));
  const last = shown[shown.length - 1];
  const lastIsThisWeek = last.bucket_start === thisWeek;
  const setsLine =
    last.sets_prescribed > 0
      ? t(lastIsThisWeek ? 'parcStats.setsThisWeek' : 'parcStats.setsThatWeek', {
          week: weekLabel(last),
          done: fmt(last.sets_done),
          total: fmt(last.sets_prescribed),
        })
      : t(lastIsThisWeek ? 'parcStats.nothingThisWeek' : 'parcStats.nothingThatWeek', { week: weekLabel(last) });
  const extra =
    last.extra_sets_done > 0 ? ` ${t('parcStats.extraSets', { n: fmt(last.extra_sets_done) })}` : '';

  return (
    <section aria-labelledby={titleId} className="rounded-group bg-surface p-4">
      {header}
      {/* The legend names the columns: weeks of sets without volume draw none. */}
      {peak > 0 && (
        <div className="mt-3 flex gap-4" aria-hidden="true">
          <span className="pk-caption flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-[3px] bg-chart-pull" />
            {t('parcStats.pull')}
          </span>
          <span className="pk-caption flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-[3px] bg-chart-push" />
            {t('parcStats.push')}
          </span>
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 block h-auto w-full" aria-hidden="true" focusable="false">
        {[1, 0.5, 0].map((frac) => {
          const y = yFor(top * frac);
          return (
            <g key={frac}>
              <line
                x1={PLOT_LEFT}
                x2={W}
                y1={y}
                y2={y}
                stroke={frac === 0 ? 'var(--line-strong)' : 'var(--line)'}
                strokeWidth="1"
              />
              <text x="0" y={y + 4} fontSize="12" fill="var(--ink-2)">
                {fmt(top * frac)}
              </text>
            </g>
          );
        })}
        {shown.map((w, i) => {
          const centre = PLOT_LEFT + band * i + band / 2;
          const pullX = centre - BAR_W - BAR_GAP / 2;
          const pushX = centre + BAR_GAP / 2;
          const isCurrent = w.bucket_start === thisWeek;
          return (
            <g key={w.bucket_start} data-week={w.bucket_start}>
              <title>
                {t('parcStats.weekTooltip', {
                  week: formatBucketRange(w.bucket_start, lang),
                  pull: fmt(w.pull),
                  push: fmt(w.push),
                  done: fmt(w.sets_done),
                  total: fmt(w.sets_prescribed),
                })}
              </title>
              {/* The whole band answers the pointer, wider than the bars. */}
              <rect x={PLOT_LEFT + band * i} y={PLOT_TOP} width={band} height={BASELINE - PLOT_TOP} fill="transparent" />
              {w.pull > 0 && <path d={barPath(pullX, yFor(w.pull), BAR_W)} fill="var(--chart-pull)" />}
              {w.push > 0 && <path d={barPath(pushX, yFor(w.push), BAR_W)} fill="var(--chart-push)" />}
              <text
                x={centre}
                y={H - 6}
                fontSize="12"
                textAnchor="middle"
                fill={isCurrent ? 'var(--ink)' : 'var(--ink-2)'}
                fontWeight={isCurrent ? 700 : 400}
              >
                {weekLabel(w)}
              </text>
            </g>
          );
        })}
      </svg>
      <table className="sr-only">
        <caption>{t('parcStats.volumeTitle')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('parcStats.week')}</th>
            <th scope="col">{t('parcStats.pull')}</th>
            <th scope="col">{t('parcStats.push')}</th>
            <th scope="col">{t('parcStats.setsColumn')}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((w) => (
            <tr key={w.bucket_start}>
              <th scope="row">{formatBucketRange(w.bucket_start, lang)}</th>
              <td>{fmt(w.pull)}</td>
              <td>{fmt(w.push)}</td>
              <td>
                {w.sets_prescribed > 0
                  ? t('parcStats.setsOf', { done: fmt(w.sets_done), total: fmt(w.sets_prescribed) })
                  : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="pk-caption mt-2">
        {setsLine}
        {extra}
      </p>
    </section>
  );
}
