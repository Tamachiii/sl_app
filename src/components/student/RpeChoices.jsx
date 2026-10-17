import { useI18n } from '../../hooks/useI18n';
import { formatRpe, rpeChoices } from '../../lib/rpe';

/**
 * The ratings of a set in a sheet (design/parc/components/Sheet): five
 * columns of 52px boxes in condensed digits, 6 to 10 in half steps. The
 * rating the set has is in `blue` and pressed; a tap on it takes it back
 * (`onChange(null)`), a tap on another gives that one.
 */
export default function RpeChoices({ value, onChange, disabled = false }) {
  const { t, lang } = useI18n();
  const current = value == null || value === '' ? null : Number(value);
  return (
    <div className="grid grid-cols-5 gap-2">
      {rpeChoices(value).map((n) => {
        const active = current === n;
        const label = formatRpe(n, lang);
        return (
          <button
            key={n}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            aria-label={t('parcSession.rpeValue', { rpe: label })}
            onClick={() => onChange(active ? null : n)}
            className={`pk-btn pk-condensed pk-tnum min-h-[52px] p-0 text-[22px] font-extrabold ${
              active ? 'bg-blue text-on-blue' : 'bg-fill text-ink'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
