import { useI18n } from '../../hooks/useI18n';
import { decimalPattern, decimalText, parseDecimalInput } from '../../lib/number';

// The look of the app's number fields, for a caller that passes no className.
const DEFAULT_CLASS =
  'w-full rounded-lg border border-ink-200 bg-white px-3 py-2 sl-mono text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-60 disabled:cursor-not-allowed';

/**
 * The field for a number a person types: a weight, a number of reps.
 *
 * It is a TEXT field with a numeric keypad, not `type="number"`. A number
 * field reads "82,5" by the language of the browser: 825 in a Chromium whose
 * UI is English, "" in WebKit — which every caller then saved as null. Here
 * the text stays what was typed, comma or point, and `parseDecimalInput`
 * (lib/number.js) is the one reader of it.
 *
 * The caller holds the TEXT, as with any controlled input, and reads the
 * number when it commits:
 *
 *   const [weight, setWeight] = useState(decimalText(log.target_weight_kg));
 *   <DecimalInput value={weight} onChange={(e) => setWeight(e.target.value)} aria-label="…" />
 *
 *   const parsed = parseDecimalInput(weight);
 *   if (!parsed.ok) return showAlert();          // never write on garbage
 *   save(parsed.value);                          // null only for an empty field
 *
 * Holding the number instead loses the separator as it is typed ("82," is 82).
 *
 * Props: `value` (the text; a number is shown as its text), `onChange(event,
 * parsed)` — the native event, then what `parseDecimalInput` makes of the new
 * text under this field's rules — and the rules themselves: `min`, `max`,
 * `allowEmpty`, `integer` (whole numbers: reps, seconds). `invalid` marks the
 * field from outside (a refused save). Everything else goes to the <input>:
 * `aria-label`, `id`, `placeholder`, `disabled`, `onBlur`, `autoFocus`, `ref`.
 *
 * A text that is not a number, or not one of the range, sets `aria-invalid`
 * and explains itself in `title`. The component draws no message: its callers
 * sit in table cells and one-line rows, and say what went wrong where they
 * have room — `uiSharedHelpers.decimalInvalid` is the shared wording.
 */
export default function DecimalInput({
  value,
  onChange,
  min,
  max,
  allowEmpty = true,
  integer = false,
  invalid = false,
  className = DEFAULT_CLASS,
  title,
  ...rest
}) {
  const { t } = useI18n();
  const rules = { min, max, allowEmpty, integer };
  // A string is shown untouched — rewriting it while it is typed is how "82.05"
  // would lose its zero. Only a number is turned into text.
  const text = typeof value === 'string' ? value : decimalText(value);
  const parsed = parseDecimalInput(text, rules);
  // An empty field that needs an answer is not marked until the caller says
  // so: nobody has done anything wrong by not having typed yet.
  const flagged = invalid || (!parsed.ok && parsed.reason !== 'empty');
  const explanation = integer ? t('uiSharedHelpers.integerInvalid') : t('uiSharedHelpers.decimalInvalid');

  return (
    <input
      autoComplete="off"
      spellCheck={false}
      {...rest}
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      pattern={decimalPattern({ integer })}
      value={text}
      onChange={(event) => onChange?.(event, parseDecimalInput(event.target.value, rules))}
      aria-invalid={flagged ? 'true' : undefined}
      title={title ?? (flagged ? explanation : undefined)}
      // 16px is not a style choice: iOS Safari zooms the page on a focused
      // field under it (DESIGN_SYSTEM, "iOS 16px input rule").
      className={`text-[16px] ${className}`}
    />
  );
}
