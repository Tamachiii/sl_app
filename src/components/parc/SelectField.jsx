import Icon from './Icon';

/**
 * A choice among a list, as a field of the Parc design system: the native
 * `<select>` drawn as a `pk-field` (52px, `line-control`, 16px — no zoom on
 * a phone), its label written above it in `caption`, a chevron at the right.
 * The design system draws no select of its own: the native one keeps the
 * phone's own picker and every keyboard rule. `children` are its `<option>`s;
 * every other prop goes to the <select>.
 */
export default function SelectField({ label, className = '', children, ...rest }) {
  return (
    <label className={`flex flex-col gap-1.5 ${className}`}>
      <span className="pk-caption">{label}</span>
      <span className="relative">
        <select {...rest} className="pk-field appearance-none pr-10 disabled:bg-fill disabled:text-ink-2">
          {children}
        </select>
        <Icon
          name="chevron-down"
          size={18}
          className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-ink-2"
        />
      </span>
    </label>
  );
}
