import { Link, NavLink } from 'react-router-dom';
import Icon from './Icon';

/**
 * The tab bar fixed at the bottom of the top-level screens, under 1024px
 * (design/parc/components/TabBar). Four tabs at most: Athlètes, Séances,
 * Messages, Librairie for a coach; Entraînement, Stats, Messages for an
 * athlete. It goes away on a detail screen, where the ActionBar takes its
 * place, and becomes the SideNav from 1024px.
 *
 * The bottom padding is the screen's safe area, and never less than the 8px
 * of the bar's top: the 28px of `safe-bottom` is what the mocks draw for the
 * phone's home bar, which `env(safe-area-inset-bottom)` measures for real.
 */
export default function TabBar({ label, className = '', children }) {
  return (
    <nav
      aria-label={label}
      className={`pk-tabbar ${className}`}
      style={{
        paddingBottom: 'max(var(--space-2), env(safe-area-inset-bottom))',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
      }}
    >
      {children}
    </nav>
  );
}

/**
 * The count drawn on a tab or a side-nav item (`pk-count`): the figure for
 * the eye, « 99+ » past 99, and `countLabel` — « 2 séances à revoir » — for
 * assistive technology.
 */
export function Count({ count, countLabel, className = '' }) {
  if (!count) return null;
  return (
    <span className={`pk-count ${className}`}>
      <span aria-hidden="true">{count > 99 ? '99+' : count}</span>
      {countLabel && <span className="sr-only">{countLabel}</span>}
    </span>
  );
}

/**
 * One tab: a 24px icon (`icon`, a name of the Parc set, or an element) over
 * its label. The open tab is `aria-current="page"` and blue, the others
 * `ink-2`. `active` decides when given — a tab whose pages are not all under
 * its own path (navItems `matches`) — and the router's match otherwise
 * (`end` as on a NavLink). `count`/`countLabel` add a `Count` at the top
 * right of the icon; `badge` puts any other element there.
 */
export function Tab({ to, end, active, icon, label, count, countLabel, badge, onClick }) {
  const inner = (
    <>
      {typeof icon === 'string' ? <Icon name={icon} size={24} /> : icon}
      <span>{label}</span>
      {count ? (
        <Count count={count} countLabel={countLabel} className="absolute left-1/2 top-0 ml-1.5" />
      ) : (
        badge
      )}
    </>
  );
  if (active !== undefined) {
    return (
      <Link to={to} onClick={onClick} aria-current={active ? 'page' : undefined} className="pk-tab">
        {inner}
      </Link>
    );
  }
  return (
    <NavLink to={to} end={end} onClick={onClick} className="pk-tab">
      {inner}
    </NavLink>
  );
}
