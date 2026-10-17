import { useId } from 'react';
import DecimalInput from '../ui/DecimalInput';

/**
 * The field of a typed number — a load, reps, seconds
 * (design/parc/components/NumberField). It dresses `ui/DecimalInput`, whose
 * logic stays: comma or point, the text kept as typed, `parseDecimalInput`
 * on save, never `type="number"`.
 *
 * `label` is visible above the field and gives the unit (« Charge en kg »).
 * `size="lg"` is the field of an input sheet: condensed 28px digits in a 56px
 * box. `error` is the sentence of a refused entry — the expected range — in
 * `red` under the field, tied to it by `aria-describedby`; the field is then
 * `aria-invalid` with a 2px red outline.
 *
 * The rest goes to DecimalInput: `value`, `onChange(event, parsed)`, `min`,
 * `max`, `integer`, `allowEmpty`, `disabled`, `onBlur`, `autoFocus`.
 */
export default function NumberField({ label, error, size, className = '', ...rest }) {
  const errorId = useId();
  const fieldClass =
    size === 'lg'
      ? 'pk-field pk-condensed pk-tnum min-h-button-lg text-[28px]! font-extrabold'
      : 'pk-field pk-tnum';
  return (
    <div className={`grid gap-1.5 ${className}`}>
      <label className="grid gap-1.5">
        <span className="pk-small">{label}</span>
        <DecimalInput
          {...rest}
          invalid={Boolean(error) || rest.invalid}
          aria-describedby={error ? errorId : undefined}
          className={fieldClass}
        />
      </label>
      {/* Outside the <label>: it describes the field, it does not name it. */}
      {error && (
        <span id={errorId} role="alert" className="text-[13px] leading-[1.35] text-red">
          {error}
        </span>
      )}
    </div>
  );
}
