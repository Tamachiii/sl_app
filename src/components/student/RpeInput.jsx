import { memo } from 'react';
import { useI18n } from '../../hooks/useI18n';

// The ratings and their writing live in lib/rpe.js; re-exported for the
// callers that still import them from here.
import { RPE_VALUES, formatRpe } from '../../lib/rpe';

export { RPE_VALUES, formatRpe };

// Two rows of five at 44 px (P68). Ten columns on a 390 px phone left each
// button about 27 × 36 px, and the selector opens after every set — between
// sets, with chalk on the hands and the phone on a bench.
//
// Nine ratings leave a tenth cell. It holds a rating that is not offered any
// more — a 1 to 5 logged before half steps, or sent by an older version of
// the app — shown first and pressed, so the set's rating is on screen and can
// be taken back like any other.
const RpeInput = memo(function RpeInput({ value, onChange, disabled = false }) {
  const { lang } = useI18n();
  const current = value == null || value === '' ? null : Number(value);
  const offered =
    current != null && Number.isFinite(current) && !RPE_VALUES.includes(current)
      ? [current, ...RPE_VALUES]
      : RPE_VALUES;
  return (
    <div className="grid grid-cols-5 gap-1.5 w-full">
      {offered.map((n) => {
        const active = current === n;
        const label = formatRpe(n, lang);
        return (
          <button
            key={n}
            type="button"
            onClick={() => !disabled && onChange(active ? null : n)}
            disabled={disabled}
            aria-label={`RPE ${label}`}
            aria-pressed={active}
            className={`sl-display h-11 rounded-md text-[15px] font-bold tabular-nums transition-colors ${
              active
                ? 'bg-accent text-ink-900'
                : 'bg-ink-100 text-ink-500 hover:bg-ink-200'
            } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
});

export default RpeInput;
