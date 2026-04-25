import { useEffect, useMemo, useState } from 'react';

export default function ExerciseProgressChart({ exercises, byExercise }) {
  const [selectedId, setSelectedId] = useState(exercises[0]?.id ?? '');

  useEffect(() => {
    if (exercises.length === 0) {
      setSelectedId('');
    } else if (!exercises.some((e) => e.id === selectedId)) {
      setSelectedId(exercises[0].id);
    }
  }, [exercises, selectedId]);

  const points = useMemo(() => {
    // Hook returns points already in (program order, week order). Don't
    // re-sort by week_number alone — that would shuffle weeks across
    // programs (W1 of block A and W1 of block B end up adjacent).
    return byExercise[selectedId] || [];
  }, [byExercise, selectedId]);

  // When points span multiple programs, surface the program in the x-axis
  // label so W1 of block A vs W1 of block B aren't visually identical.
  const showProgramLabel = useMemo(() => {
    const names = new Set(points.map((p) => p.program_name).filter(Boolean));
    return names.size > 1;
  }, [points]);

  const maxTonnage = points.reduce((m, p) => Math.max(m, p.tonnage), 0);

  if (exercises.length === 0) {
    return (
      <div className="sl-card p-4">
        <p className="sl-mono text-[11px] text-ink-400">
          No weighted exercises in your program yet.
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

  return (
    <div className="sl-card p-4 space-y-3">
      <label className="block">
        <span className="sr-only">Select exercise</span>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
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
        <p className="sl-mono text-[11px] text-ink-400">No data for this exercise yet.</p>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full h-auto"
            role="img"
            aria-label="Weekly tonnage chart"
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
                    stroke="var(--color-ink-100)"
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
                  key={p.key ?? `${p.program_id}:${p.week_number}`}
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
                key={p.key ?? `${p.program_id}:${p.week_number}`}
                cx={xFor(i)}
                cy={yFor(p.tonnage)}
                r="3"
                fill="var(--color-accent)"
              >
                <title>
                  {p.program_name ? `${p.program_name} · ` : ''}Week {p.week_number}
                  {p.label ? ` — ${p.label}` : ''}: {Math.round(p.tonnage)} kg
                </title>
              </circle>
            ))}

            {points.map((p, i) => (
              <text
                key={p.key ?? `${p.program_id}:${p.week_number}`}
                x={xFor(i)}
                y={H - 8}
                textAnchor="middle"
                fill="var(--color-ink-400)"
                fontFamily="var(--font-mono, 'JetBrains Mono', monospace)"
                fontSize="10"
              >
                {showProgramLabel && p.program_name
                  ? `${p.program_name.slice(0, 3).toUpperCase()}·W${p.week_number}`
                  : `W${p.week_number}`}
              </text>
            ))}
          </svg>

          <p className="sl-mono text-[11px] text-ink-400">
            Weekly tonnage = Σ (sets × reps × weight; BW = 1 kg). Peak:{' '}
            <span className="text-gray-800" style={{ color: 'var(--color-accent)' }}>
              {Math.round(maxTonnage)} kg
            </span>
          </p>
        </>
      )}
    </div>
  );
}
