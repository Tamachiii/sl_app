import { useId } from 'react';

/**
 * A single choice among two to four, drawn as one control on `fill`
 * (design/parc/screens/Librairie.dc.html: the type, the load of an
 * exercise). The choice made is on `surface`, in `ink` and bold, and
 * `aria-pressed`; the others are `ink-2`. Each choice is a 44px button.
 *
 * `label` is the visible name above the control, which names the group;
 * without one, `ariaLabel` names it.
 * `options` is `[{ value, label }]`; `onChange(value)` is called with the
 * value of the choice pressed.
 */
export default function SegmentedControl({ label, ariaLabel, options, value, onChange, className = '' }) {
  const labelId = useId();
  return (
    <div className={`grid gap-1.5 ${className}`}>
      {label && (
        <span id={labelId} className="pk-small">
          {label}
        </span>
      )}
      <div
        role="group"
        aria-labelledby={label ? labelId : undefined}
        aria-label={label ? undefined : ariaLabel}
        className="pk-segmented"
      >
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            className="pk-btn pk-segment"
            aria-pressed={option.value === value}
            onClick={() => onChange?.(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
