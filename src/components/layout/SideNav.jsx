import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { getNavItems } from './navItems';
import UnreadMessagesBadge from '../messaging/UnreadMessagesBadge';

function SideNavItem({ to, label, icon, end = false, matches, badge }) {
  const { pathname } = useLocation();
  const customActive = matches ? matches(pathname) : null;
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => {
        const active = customActive ?? isActive;
        return `relative flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors ${
          active
            ? 'text-[var(--color-accent)]'
            : 'text-ink-500 hover:text-ink-800 hover:bg-ink-50'
        }`;
      }}
      style={({ isActive }) => {
        const active = customActive ?? isActive;
        return active
          ? { background: 'color-mix(in srgb, var(--color-accent) 10%, transparent)' }
          : undefined;
      }}
    >
      {icon}
      <span className="sl-display text-[14px] tracking-tight">{label}</span>
      {badge === 'unread-messages' && <UnreadMessagesBadge variant="count" />}
    </NavLink>
  );
}

export default function SideNav() {
  const { role } = useAuth();
  const { t } = useI18n();
  const items = getNavItems(role, t);

  return (
    <aside
      aria-label="Main navigation"
      className="hidden md:flex md:flex-col w-56 shrink-0 border-r border-ink-100 bg-white px-3 py-6"
    >
      <div className="px-3 pb-6">
        <div
          aria-hidden="true"
          className="sl-display text-[22px] leading-none"
          style={{ color: 'var(--color-accent)' }}
        >
          SL
        </div>
      </div>
      <nav className="flex flex-col gap-1">
        {items.map((item) => (
          <SideNavItem key={item.to} {...item} />
        ))}
      </nav>
    </aside>
  );
}
