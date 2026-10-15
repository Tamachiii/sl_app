import { memo } from 'react';

// The ratings offered, in order. The grid lays them out five to a row.
const RPE_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

// Two rows of five at 44 px (P68). Ten columns on a 390 px phone left each
// button about 27 × 36 px, and the selector opens after every set — between
// sets, with chalk on the hands and the phone on a bench.
const RpeInput = memo(function RpeInput({ value, onChange, disabled = false }) {
  return (
    <div className="grid grid-cols-5 gap-1.5 w-full">
      {RPE_VALUES.map((n) => {
        const active = value === n;
        return (
          <button
            key={n}
            onClick={() => !disabled && onChange(active ? null : n)}
            disabled={disabled}
            aria-label={`RPE ${n}`}
            aria-pressed={active}
            className={`sl-display h-11 rounded-md text-[15px] font-bold transition-colors ${
              active
                ? 'bg-accent text-ink-900'
                : 'bg-ink-100 text-ink-500 hover:bg-ink-200'
            } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
          >
            {n}
          </button>
        );
      })}
    </div>
  );
});

export default RpeInput;
