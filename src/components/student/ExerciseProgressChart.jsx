import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../hooks/useI18n';
import { formatDate } from '../../lib/i18n/format';

// Compact axis tick — "17/8" (fr) / "8/17" (en). One point per session on a
// real date, so the ticks have to stay short enough to sit side by side.
function formatTick(iso, lang) {
  return formatDate(lang, iso, { day: 'numeric', month: 'numeric' });
}

function formatPointDate(iso, lang) {
  return formatDate(lang, iso);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// A calendar day as a whole number. Read from the date's digits, never from
// the device's midnight: the night the clocks change is 23 or 25 hours long,
// and two sessions a day apart must stay one day apart on the axis.
function dayNumber(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(typeof iso === 'string' ? iso : '');
  return m ? Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS) : null;
}

/**
 * Where each point sits on the x axis, between `left` and `right`.
 *
 * On a time axis: a point's place is its training day, so two sessions two
 * days apart and two months apart no longer look the same, and the slope of
 * the line is the rate of progress. Points of a single day — or a single
 * point — are centred. When a point has no date (rows read before the hook
 * dated them) the axis cannot be a time axis, and the points are spaced
 * evenly in their order, as they were.
 */
export function pointPositions(points, { left, right }) {
  const n = points.length;
  const mid = (left + right) / 2;
  if (n === 0) return [];
  const days = points.map((p) => dayNumber(p?.date));
  if (days.every((d) => d != null)) {
    const first = Math.min(...days);
    const last = Math.max(...days);
    if (last === first) return days.map(() => mid);
    return days.map((d) => left + ((d - first) / (last - first)) * (right - left));
  }
  if (n === 1) return [mid];
  return points.map((_, i) => left + (i * (right - left)) / (n - 1));
}

const TICK_FONT = 10;

/** The width an axis label takes, in the chart's units (a monospace font). */
export function tickWidth(text) {
  return String(text ?? '').length * TICK_FONT * 0.6;
}

/** The centre of a label of `width` at `x`, held inside [minX, maxX]. */
export function tickCentre(x, width, { minX = 0, maxX = Infinity } = {}) {
  return Math.min(Math.max(x, minX + width / 2), maxX - width / 2);
}

/**
 * Which points get their date under the axis — indices, in order.
 *
 * At most `max` labels, spread evenly along the axis: for k = max down to 2,
 * the point nearest each of k even marks, and the first k whose labels do not
 * overlap (with `gap` between two) wins. The first and the last point are
 * always among them, unless they are on the same spot, which gets one label.
 * One label per point used to be drawn: about 24 on top of each other after
 * three months of a lift trained twice a week.
 *
 * `ticks` are `{ x, width }`, in the order of x.
 */
export function thinTicks(ticks, { max = 6, gap = 4, minX = 0, maxX = Infinity } = {}) {
  const n = ticks.length;
  if (n === 0) return [];
  const extent = (i) => {
    const centre = tickCentre(ticks[i].x, ticks[i].width, { minX, maxX });
    return [centre - ticks[i].width / 2, centre + ticks[i].width / 2];
  };
  const fits = (chosen) =>
    chosen.every((i, k) => k === 0 || extent(chosen[k - 1])[1] + gap <= extent(i)[0]);
  const from = ticks[0].x;
  const to = ticks[n - 1].x;
  for (let k = Math.min(max, n); k >= 2; k -= 1) {
    const chosen = [];
    for (let j = 0; j < k; j += 1) {
      const mark = from + (j * (to - from)) / (k - 1);
      // The nearest point; on a tie the earlier one, but the last mark takes
      // the last point.
      let best = 0;
      for (let i = 1; i < n; i += 1) {
        const d = Math.abs(ticks[i].x - mark);
        const bestD = Math.abs(ticks[best].x - mark);
        if (d < bestD || (d === bestD && j === k - 1)) best = i;
      }
      if (chosen[chosen.length - 1] !== best) chosen.push(best);
    }
    if (fits(chosen)) return chosen;
  }
  return [0];
}

// ink-100 is a near-white cream: a faint rule on the light card, but bright
// lines across the dark one. A tint of the mid-tone ink reads correctly in
// both themes — and unlike a utility class, an SVG `stroke` gets no dark-mode
// remap from index.css.
const GRIDLINE_STROKE = 'color-mix(in srgb, var(--color-ink-400) 30%, transparent)';

function readStoredExerciseId(storageKey) {
  if (!storageKey) return '';
  try { return localStorage.getItem(storageKey) || ''; } catch { return ''; }
}

export default function ExerciseProgressChart({ exercises, byExercise, storageKey }) {
  const { t, lang } = useI18n();
  const [selectedId, setSelectedId] = useState(() => {
    const stored = readStoredExerciseId(storageKey);
    if (stored && exercises.some((e) => e.id === stored)) return stored;
    return exercises[0]?.id ?? '';
  });

  useEffect(() => {
    if (exercises.length === 0) {
      setSelectedId('');
      return;
    }
    if (!exercises.some((e) => e.id === selectedId)) {
      const stored = readStoredExerciseId(storageKey);
      if (stored && exercises.some((e) => e.id === stored)) {
        setSelectedId(stored);
      } else {
        setSelectedId(exercises[0].id);
      }
    }
  }, [exercises, selectedId, storageKey]);

  function handleSelect(next) {
    setSelectedId(next);
    if (!storageKey) return;
    try {
      if (next) localStorage.setItem(storageKey, next);
      else localStorage.removeItem(storageKey);
    } catch { /* ignore — private mode, quota, etc. */ }
  }

  const points = useMemo(() => {
    // Hook returns points already sorted by training date — one per session.
    return byExercise[selectedId] || [];
  }, [byExercise, selectedId]);

  // When points span multiple programs, surface the program in the x-axis
  // label so two blocks' sessions aren't visually identical.
  const showProgramLabel = useMemo(() => {
    const names = new Set(points.map((p) => p.program_name).filter(Boolean));
    return names.size > 1;
  }, [points]);

  // Scale to whichever is larger so the planned reference always fits...
  const maxTonnage = points.reduce(
    (m, p) => Math.max(m, p.tonnage, p.plannedTonnage ?? 0),
    0
  );
  // ...but the caption's "Peak" reports the PERFORMED peak only, so it never
  // overstates what the student actually did (planned may be higher).
  const performedPeak = points.reduce((m, p) => Math.max(m, p.tonnage), 0);
  // Only draw the planned reference when it actually diverges from performed
  // (i.e. the student deviated somewhere) — otherwise it's visual noise.
  const hasPlannedDivergence = points.some(
    (p) => Math.abs((p.plannedTonnage ?? p.tonnage) - p.tonnage) > 1
  );

  if (exercises.length === 0) {
    return (
      <div className="sl-card p-4">
        <p className="sl-mono text-[11px] text-ink-400">
          {t('student.stats.chart.noExercises')}
        </p>
      </div>
    );
  }

  const W = 320;
  const H = 140;
  const PAD_L = 32;
  const PAD_R = 8;
  const PAD_T = 8;
  const PAD_B = 24;
  // The first and the last point sit this far inside the plot, so their bar
  // stays inside it.
  const INSET = 10;
  const plotH = H - PAD_T - PAD_B;

  const xs = pointPositions(points, { left: PAD_L + INSET, right: W - PAD_R - INSET });
  const xFor = (i) => xs[i];
  const yFor = (v) =>
    maxTonnage === 0 ? PAD_T + plotH : PAD_T + plotH - (v / maxTonnage) * plotH;

  // A bar is at most 18 wide, and narrower than the nearest gap between two
  // training days, so that two sessions a day apart do not draw one bar.
  const distinctXs = [...new Set(xs)].sort((a, b) => a - b);
  const nearestGap = distinctXs.reduce(
    (m, x, i) => (i === 0 ? m : Math.min(m, x - distinctXs[i - 1])),
    Infinity,
  );
  const barW = Math.max(2, Math.min(18, nearestGap * 0.6));

  const tickLabel = (p) =>
    showProgramLabel && p.program_name
      ? `${p.program_name.slice(0, 3).toUpperCase()}·${formatTick(p.date, lang)}`
      : formatTick(p.date, lang);
  const tickTexts = points.map(tickLabel);
  const ticks = thinTicks(
    points.map((_, i) => ({ x: xs[i], width: tickWidth(tickTexts[i]) })),
    { minX: 0, maxX: W },
  ).filter((i) => tickTexts[i]);

  const linePath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(p.tonnage)}`)
    .join(' ');
  const plannedPath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(p.plannedTonnage ?? p.tonnage)}`)
    .join(' ');

  return (
    <div className="sl-card p-4 space-y-3">
      <label className="block">
        <span className="sr-only">Select exercise</span>
        <select
          value={selectedId}
          onChange={(e) => handleSelect(e.target.value)}
          className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 sl-display text-[16px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
        >
          {exercises.map((ex) => (
            <option key={ex.id} value={ex.id}>
              {ex.name}
            </option>
          ))}
        </select>
      </label>

      {points.length === 0 ? (
        <p className="sl-mono text-[11px] text-ink-400">{t('student.stats.chart.noData')}</p>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full h-auto"
            role="img"
            aria-label={t('student.stats.chart.ariaLabel')}
          >
            {[0, 0.5, 1].map((frac) => {
              const y = PAD_T + plotH - frac * plotH;
              const label = Math.round(maxTonnage * frac);
              return (
                <g key={frac}>
                  <line
                    x1={PAD_L}
                    x2={W - PAD_R}
                    y1={y}
                    y2={y}
                    stroke={GRIDLINE_STROKE}
                    strokeWidth="1"
                  />
                  <text
                    x={PAD_L - 4}
                    y={y + 3}
                    textAnchor="end"
                    fill="var(--color-ink-400)"
                    fontFamily="var(--font-mono, 'JetBrains Mono', monospace)"
                    fontSize="9"
                  >
                    {label}
                  </text>
                </g>
              );
            })}

            {points.map((p, i) => {
              const cx = xFor(i);
              const top = yFor(p.tonnage);
              return (
                <rect
                  key={p.key ?? p.session_id}
                  x={cx - barW / 2}
                  y={top}
                  width={barW}
                  height={PAD_T + plotH - top}
                  rx="2"
                  fill="var(--color-accent)"
                  fillOpacity="0.2"
                />
              );
            })}

            {/* Planned reference (dashed, faint) — drawn under the performed
                line, only when the student deviated from the plan. */}
            {points.length > 1 && hasPlannedDivergence && (
              <path
                d={plannedPath}
                fill="none"
                stroke="var(--color-ink-400)"
                strokeWidth="1.5"
                strokeDasharray="3 3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}

            {points.length > 1 && (
              <path
                d={linePath}
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}

            {points.map((p, i) => (
              <circle
                key={p.key ?? p.session_id}
                cx={xFor(i)}
                cy={yFor(p.tonnage)}
                r="3"
                fill="var(--color-accent)"
              >
                <title>
                  {p.program_name ? `${p.program_name} · ` : ''}
                  {formatPointDate(p.date, lang)}
                  {p.title ? ` — ${p.title}` : ''}: {Math.round(p.tonnage)} kg
                  {p.swappedTo ? ` · swapped to ${p.swappedTo}` : ''}
                  {p.swappedFrom ? ` · substituted for ${p.swappedFrom}` : ''}
                </title>
              </circle>
            ))}

            <g data-axis="x">
              {ticks.map((i) => (
                <text
                  key={points[i].key ?? points[i].session_id ?? i}
                  // Centred under its point, held inside the chart: the last
                  // label used to be cut in half by the edge.
                  x={tickCentre(xFor(i), tickWidth(tickTexts[i]), { minX: 0, maxX: W })}
                  y={H - 8}
                  textAnchor="middle"
                  fill="var(--color-ink-400)"
                  fontFamily="var(--font-mono, 'JetBrains Mono', monospace)"
                  fontSize={TICK_FONT}
                >
                  {tickTexts[i]}
                </text>
              ))}
            </g>
          </svg>

          <p className="sl-mono text-[11px] text-ink-400">
            {t('student.stats.chart.performedCaption')}{' '}
            <span className="text-gray-800" style={{ color: 'var(--color-accent)' }}>
              {t('student.stats.chart.peak', { n: Math.round(performedPeak) })}
            </span>
            {/* Only claim a dashed line when one is actually drawn (needs >1
                point AND real divergence). */}
            {points.length > 1 && hasPlannedDivergence && (
              <span className="block mt-0.5">{t('student.stats.chart.plannedLegend')}</span>
            )}
          </p>
        </>
      )}
    </div>
  );
}
