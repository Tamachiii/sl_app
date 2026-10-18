import Icon from './Icon';

const VARIANTS = {
  primary: 'pk-btn-primary',
  secondary: 'pk-btn-secondary',
  'on-ground': 'pk-btn-on-ground',
  text: 'pk-btn-text',
  danger: 'pk-btn-danger',
};

/**
 * A button of the Parc design system (design/parc/components/Button).
 *
 * - `primary`: the action that moves things on, one per screen, most often in
 *   the ActionBar; with `size="lg"` it is the 56px button.
 * - `secondary`: a neutral action on `surface`; `on-ground`: the same, put
 *   straight on the page's `ground`.
 * - `text`: an action link in `blue` (« Ajouter une série »).
 * - `danger`: a confirmed deletion.
 *
 * The label says what the button does, in sentence case. `as` renders
 * something else with the same look — a router `Link` (`as={Link} to="…"`).
 * Every other prop goes to the element; a <button> is `type="button"` unless
 * told otherwise.
 */
export default function Button({
  variant = 'secondary',
  size,
  as: Component = 'button',
  className = '',
  children,
  ...rest
}) {
  const classes = ['pk-btn', VARIANTS[variant], size === 'lg' && 'pk-btn-lg', className]
    .filter(Boolean)
    .join(' ');
  const typeProps = Component === 'button' ? { type: 'button' } : {};
  return (
    <Component {...typeProps} {...rest} className={classes}>
      {children}
    </Component>
  );
}

/**
 * A round 44px button that holds an icon only (`pk-icon-btn`). `label` is its
 * name for assistive technology and is required. `tone`: `surface` (the
 * default, on `ground`), `fill` (on `surface`, as in a sheet's header) or
 * `none`.
 */
export function IconButton({
  icon,
  label,
  tone = 'surface',
  size = 22,
  as: Component = 'button',
  className = '',
  children,
  ...rest
}) {
  const toneClass = tone === 'fill' ? 'bg-fill' : tone === 'none' ? 'bg-transparent' : '';
  const typeProps = Component === 'button' ? { type: 'button' } : {};
  return (
    <Component
      {...typeProps}
      {...rest}
      aria-label={label}
      className={['pk-icon-btn', toneClass, className].filter(Boolean).join(' ')}
    >
      {icon ? <Icon name={icon} size={size} /> : children}
    </Component>
  );
}
