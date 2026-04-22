import { NavLink } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { getNavItems } from './navItems';

function NavItem({ to, label, icon, end = false }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `relative flex-1 flex flex-col items-center justify-center gap-1 py-2.5 transition-colors ${
          isActive ? 'text-[var(--color-accent)]' : 'text-ink-400 hover:text-ink-700'
        }`
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span
              aria-hidden="true"
              className="absolute top-0 left-1/2 -translate-x-1/2 h-[2px] w-8 rounded-full"
              style={{ background: 'var(--color-accent)' }}
            />
          )}
          {icon}
          <span className="sl-label text-[10px]">{label}</span>
        </>
      )}
    </NavLink>
  );
}

export default function BottomNav() {
  const { role } = useAuth();
  const { t } = useI18n();
  const items = getNavItems(role, t);

  const navClass =
    'sticky bottom-0 flex justify-around backdrop-blur supports-[backdrop-filter]:bg-white/80 bg-white border-t border-ink-100 md:hidden';

  // Honor the home-indicator / gesture-bar safe area on iOS + Samsung edge devices.
  // On non-notched devices env(...) returns 0, so this is a no-op visually.
  const navStyle = {
    paddingBottom: 'env(safe-area-inset-bottom)',
    paddingLeft: 'env(safe-area-inset-left)',
    paddingRight: 'env(safe-area-inset-right)',
  };

  return (
    <nav aria-label="Main navigation" className={navClass} style={navStyle}>
      {items.map((item) => (
        <NavItem key={item.to} {...item} />
      ))}
    </nav>
  );
}
