import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../hooks/useI18n';
import { parseISODate } from '../../lib/day';

const LOCALE = { en: 'en-US', fr: 'fr-FR', de: 'de-DE' };

// Compact axis tick — "17/8" (fr) / "8/17" (en). One point per session on a
// real date, so the ticks have to stay short enough to sit side by side.
function formatTick(iso, lang) {
  const d = parseISODate(iso);
  if (!d) return '';
  try {
    return new Intl.DateTimeFormat(LOCALE[lang] || LOCALE.en, {
      day: 'numeric',
      month: 'numeric',
    }).format(d);
  } catch {
    return iso.slice(5);
  }
}

function formatPointDate(iso, lang) {
  const d = parseISODate(iso);
  if (!d) return '';
  try {
    return new Intl.DateTimeFormat(LOCALE[lang] || LOCALE.en, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(d);
  } catch {
    return iso;
  }
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
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const xFor = (i) =>
    points.length === 1
      ? PAD_L + plotW / 2
      : PAD_L + (i * plotW) / (points.length - 1);
  const yFor = (v) =>
    maxTonnage === 0 ? PAD_T + plotH : PAD_T + plotH - (v / maxTonnage) * plotH;

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
              const barW = Math.min(18, (plotW / Math.max(points.length, 1)) * 0.45);
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

            {points.map((p, i) => (
              <text
                key={p.key ?? p.session_id}
                x={xFor(i)}
                y={H - 8}
                textAnchor="middle"
                fill="var(--color-ink-400)"
                fontFamily="var(--font-mono, 'JetBrains Mono', monospace)"
                fontSize="10"
              >
                {showProgramLabel && p.program_name
                  ? `${p.program_name.slice(0, 3).toUpperCase()}·${formatTick(p.date, lang)}`
                  : formatTick(p.date, lang)}
              </text>
            ))}
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
