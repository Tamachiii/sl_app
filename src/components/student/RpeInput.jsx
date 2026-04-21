import { memo } from 'react';

const RpeInput = memo(function RpeInput({ value, onChange, disabled = false }) {
  return (
    <div className="w-full">
      <div className="sl-label mb-1.5">RPE</div>
      <div className="grid grid-cols-10 gap-1">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => {
          const active = value === n;
          return (
            <button
              key={n}
              onClick={() => !disabled && onChange(active ? null : n)}
              disabled={disabled}
              aria-label={`RPE ${n}`}
              aria-pressed={active}
              className={`sl-display h-10 rounded-md text-[13px] font-bold transition-colors ${
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
    </div>
  );
});

export default RpeInput;
