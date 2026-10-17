import Icon from './Icon';

/**
 * The search field of a list, under the large title
 * (design/parc/components/SearchField). The `<label>` holds the field and
 * says its name to assistive technology only (`label`, « Rechercher un
 * athlète »); the placeholder repeats it. The loupe sits at the left.
 *
 * Every other prop goes to the <input>: `value`, `onChange`, `autoFocus`.
 */
export default function SearchField({ label, placeholder, className = '', ...rest }) {
  return (
    <label className={`relative block ${className}`}>
      <span className="sr-only">{label}</span>
      <Icon name="search" size={18} className="pointer-events-none absolute left-3.5 top-[13px] text-ink-2" />
      <input
        type="search"
        autoComplete="off"
        {...rest}
        placeholder={placeholder ?? label}
        className="pk-field pl-[42px]"
      />
    </label>
  );
}
