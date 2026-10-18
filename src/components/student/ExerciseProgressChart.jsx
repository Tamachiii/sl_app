import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../hooks/useI18n';
import { formatDate, formatNumber } from '../../lib/i18n/format';

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

const TICK_FONT = 12;

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

function readStoredExerciseId(storageKey) {
  if (!storageKey) return '';
  try { return localStorage.getItem(storageKey) || ''; } catch { return ''; }
}

/**
 * The tonnage of one exercise, session by session, on a time axis: the
 * performed line in `chart-pull` (2px, round), a dot per session with a ring
 * of the surface, a light wash of the same blue under each session, the
 * planned tonnage dashed in `ink-3` where the athlete moved away from it, the
 * value axis in three ticks, at most six dates under it (`thinTicks`). Each
 * dot says its session on hover (`<title>`), and a screen reader gets a table.
 *
 * Two ways to use it:
 * - with `exerciseId`, it draws that exercise and nothing else — the
 *   Progression list of the stats opens it under the row that was tapped;
 * - without, it carries its own choice of exercise (a select), remembered
 *   under `storageKey` — the coach's stats section.
 * `bare` drops the white box, for a chart drawn inside one.
 */
export default function ExerciseProgressChart({ exercises, byExercise, storageKey, exerciseId, bare = false }) {
  const { t, lang } = useI18n();
  const controlled = exerciseId !== undefined;
  const [chosenId, setChosenId] = useState(() => {
    const stored = readStoredExerciseId(storageKey);
    if (stored && exercises.some((e) => e.id === stored)) return stored;
    return exercises[0]?.id ?? '';
  });

  useEffect(() => {
    if (controlled) return;
    if (exercises.length === 0) {
      setChosenId('');
      return;
    }
    if (!exercises.some((e) => e.id === chosenId)) {
      const stored = readStoredExerciseId(storageKey);
      if (stored && exercises.some((e) => e.id === stored)) {
        setChosenId(stored);
      } else {
        setChosenId(exercises[0].id);
      }
    }
  }, [controlled, exercises, chosenId, storageKey]);

  const selectedId = controlled ? exerciseId : chosenId;

  function handleSelect(next) {
    setChosenId(next);
    if (!storageKey) return;
    try {
      if (next) localStorage.setItem(storageKey, next);
      else localStorage.removeItem(storageKey);
    } catch { /* ignore — private mode, quota, etc. */ }
  }

  const points = useMemo(() => byExercise[selectedId] || [], [byExercise, selectedId]);

  const showProgramLabel = useMemo(() => {
    const names = new Set(points.map((p) => p.program_name).filter(Boolean));
    return names.size > 1;
  }, [points]);

  const box = bare ? 'flex flex-col gap-3' : 'flex flex-col gap-3 rounded-group bg-surface p-4';

  if (exercises.length === 0) {
    return (
      <div className={box}>
        <p className="pk-caption">{t('parcStats.chartNoExercises')}</p>
      </div>
    );
  }

  const maxTonnage = points.reduce((m, p) => Math.max(m, p.tonnage, p.plannedTonnage ?? 0), 0);
  const performedPeak = points.reduce((m, p) => Math.max(m, p.tonnage), 0);
  const hasPlannedDivergence = points.some((p) => Math.abs((p.plannedTonnage ?? p.tonnage) - p.tonnage) > 1);

  const W = 326;
  const H = 150;
  const PAD_L = 40;
  const PAD_R = 8;
  const PAD_T = 8;
  const PAD_B = 26;
  // Breathing room so the first and last points sit inside the frame.
  const INSET = 10;
  const plotH = H - PAD_T - PAD_B;
  const baseline = PAD_T + plotH;

  const xs = pointPositions(points, { left: PAD_L + INSET, right: W - PAD_R - INSET });
  const yFor = (v) => (maxTonnage === 0 ? baseline : baseline - (v / maxTonnage) * plotH);

  // A session's wash: never wider than the room between two sessions.
  const distinctXs = [...new Set(xs)].sort((a, b) => a - b);
  const nearestGap = distinctXs.reduce(
    (m, x, i) => (i === 0 ? m : Math.min(m, x - distinctXs[i - 1])),
    Infinity,
  );
  const barW = Math.max(2, Math.min(18, nearestGap * 0.6));

  const fmt = (n) => formatNumber(lang, Math.round(n));
  const tickLabel = (p) =>
    showProgramLabel && p.program_name
      ? t('parcStats.chartProgramTick', { program: p.program_name.slice(0, 3), date: formatTick(p.date, lang) })
      : formatTick(p.date, lang);
  const tickTexts = points.map(tickLabel);
  const ticks = thinTicks(
    points.map((_, i) => ({ x: xs[i], width: tickWidth(tickTexts[i]) })),
    { minX: 0, maxX: W },
  ).filter((i) => tickTexts[i]);

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xs[i]} ${yFor(p.tonnage)}`).join(' ');
  const plannedPath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xs[i]} ${yFor(p.plannedTonnage ?? p.tonnage)}`)
    .join(' ');

  const pointText = (p) => {
    const parts = [
      p.program_name ? `${p.program_name}, ${formatPointDate(p.date, lang)}` : formatPointDate(p.date, lang),
      p.title,
      t('parcStats.chartTonnage', { kg: fmt(p.tonnage) }),
      p.swappedTo ? t('parcStats.chartSwappedTo', { name: p.swappedTo }) : null,
      p.swappedFrom ? t('parcStats.chartSwappedFrom', { name: p.swappedFrom }) : null,
    ];
    return parts.filter(Boolean).join(', ');
  };

  return (
    <div className={box}>
      {!controlled && (
        <label className="grid gap-1.5">
          <span className="pk-small">{t('parcStats.chartExercise')}</span>
          <select value={selectedId} onChange={(e) => handleSelect(e.target.value)} className="pk-field">
            {exercises.map((ex) => (
              <option key={ex.id} value={ex.id}>
                {ex.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {points.length === 0 ? (
        <p className="pk-caption">{t('parcStats.chartNoData')}</p>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" aria-hidden="true" focusable="false">
            {[0, 0.5, 1].map((frac) => {
              const y = baseline - frac * plotH;
              return (
                <g key={frac}>
                  <line
                    x1={PAD_L}
                    x2={W - PAD_R}
                    y1={y}
                    y2={y}
                    stroke={frac === 0 ? 'var(--line-strong)' : 'var(--line)'}
                    strokeWidth="1"
                  />
                  <text x={PAD_L - 6} y={y + 4} textAnchor="end" fill="var(--ink-2)" fontSize="12">
                    {fmt(maxTonnage * frac)}
                  </text>
                </g>
              );
            })}

            {points.map((p, i) => {
              const top = yFor(p.tonnage);
              return (
                <rect
                  key={p.key ?? p.session_id}
                  x={xs[i] - barW / 2}
                  y={top}
                  width={barW}
                  height={baseline - top}
                  rx="2"
                  fill="var(--chart-pull)"
                  fillOpacity="0.1"
                />
              );
            })}

            {/* The planned tonnage, dashed, under the performed line — only
                where the athlete moved away from the plan. */}
            {points.length > 1 && hasPlannedDivergence && (
              <path
                d={plannedPath}
                fill="none"
                stroke="var(--ink-3)"
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
                stroke="var(--chart-pull)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}

            {points.map((p, i) => (
              <circle
                key={p.key ?? p.session_id}
                cx={xs[i]}
                cy={yFor(p.tonnage)}
                r="4"
                fill="var(--chart-pull)"
                stroke="var(--surface)"
                strokeWidth="2"
              >
                <title>{pointText(p)}</title>
              </circle>
            ))}

            <g data-axis="x">
              {ticks.map((i) => (
                <text
                  key={points[i].key ?? points[i].session_id ?? i}
                  x={tickCentre(xs[i], tickWidth(tickTexts[i]), { minX: 0, maxX: W })}
                  y={H - 6}
                  textAnchor="middle"
                  fill="var(--ink-2)"
                  fontSize={TICK_FONT}
                >
                  {tickTexts[i]}
                </text>
              ))}
            </g>
          </svg>

          <table className="sr-only">
            <caption>{t('parcStats.chartTitle')}</caption>
            <tbody>
              {points.map((p) => (
                <tr key={p.key ?? p.session_id}>
                  <td>{pointText(p)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="pk-caption">
            {t('parcStats.chartCaption', { kg: fmt(performedPeak) })}
            {/* Only a line that is drawn is said: it needs two sessions and
                a real difference. */}
            {points.length > 1 && hasPlannedDivergence && ` ${t('parcStats.chartPlanned')}`}
          </p>
        </>
      )}
    </div>
  );
}
