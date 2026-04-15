import { memo } from 'react';

const RpeInput = memo(function RpeInput({ value, onChange, disabled = false }) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      <span className="text-xs text-gray-400 mr-1">RPE</span>
      <div className="flex flex-wrap gap-0.5">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
          <button
            key={n}
            onClick={() => !disabled && onChange(value === n ? null : n)}
            disabled={disabled}
            aria-label={`RPE ${n}`}
            aria-pressed={value === n}
            className={`w-6 h-6 sm:w-7 sm:h-7 shrink-0 rounded text-xs font-medium transition-colors ${
              value === n
                ? n <= 3 ? 'bg-green-500 text-white'
                : n <= 6 ? 'bg-yellow-500 text-white'
                : n <= 8 ? 'bg-orange-500 text-white'
                : 'bg-red-500 text-white'
                : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
});

export default RpeInput;
