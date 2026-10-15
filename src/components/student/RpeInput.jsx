import { memo } from 'react';
import { useI18n } from '../../hooks/useI18n';

// The ratings offered, in order: half steps from 6 to 10 (decision L34). An
// athlete who felt 7.5 had to say 7 or 8. The database takes 1 to 10 in steps
// of 0.5 (`set_logs.rpe numeric(3,1)`, migration
// 2026_10_16_21_rpe_half_steps_day_check); below 6 is not offered.
export const RPE_VALUES = [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];

// A rating as the athlete reads it: "7.5" in English, "7,5" in French and
// German, "8" for a whole one. The API hands `numeric` over as a JSON number.
export function formatRpe(value, lang = 'en') {
  const n = Number(value);
  try {
    return new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(n);
  } catch {
    return String(n);
  }
}

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
