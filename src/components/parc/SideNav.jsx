import { Link, NavLink } from 'react-router-dom';
import Icon from './Icon';
import { Count } from './TabBar';

/**
 * The navigation of a large screen, from 1024px (design/parc/screens/
 * Roster.dc.html): a white column at the left with the app's name in
 * condensed type, the same tabs as the TabBar, and `footer` — the account —
 * at the bottom.
 */
export default function SideNav({ label, brand, footer, className = '', children }) {
  return (
    <nav aria-label={label} className={`pk-sidenav ${className}`}>
      {brand && <p className="pk-condensed m-0 px-3 text-[30px] font-extrabold leading-none">{brand}</p>}
      <ul className="m-0 flex list-none flex-col gap-1 p-0">{children}</ul>
      {footer && <div className="mt-auto">{footer}</div>}
    </nav>
  );
}

/**
 * One item of the SideNav: a 22px icon, the label, and a count at the right.
 * The open item is `aria-current="page"`, on `blue-soft` in `blue`. `active`
 * and `end` work as on a `Tab`.
 */
export function SideNavItem({ to, end, active, icon, label, count, countLabel, badge, onClick }) {
  const inner = (
    <>
      {typeof icon === 'string' ? <Icon name={icon} size={22} /> : icon}
      <span className="flex-1">{label}</span>
      {count ? <Count count={count} countLabel={countLabel} /> : badge}
    </>
  );
  return (
    <li>
      {active !== undefined ? (
        <Link to={to} onClick={onClick} aria-current={active ? 'page' : undefined} className="pk-sidenav-item">
          {inner}
        </Link>
      ) : (
        <NavLink to={to} end={end} onClick={onClick} className="pk-sidenav-item">
          {inner}
        </NavLink>
      )}
    </li>
  );
}
