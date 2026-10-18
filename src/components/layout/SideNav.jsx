import { useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { SideNav as ParcSideNav, SideNavItem } from '../parc';
import { getNavItems, reselectOnClick } from './navItems';
import UnreadMessagesBadge from '../messaging/UnreadMessagesBadge';
import ReviewCountBadge from './ReviewCountBadge';

function NavItem({ to, label, icon, end = false, matches, badge, onReselect }) {
  const { pathname } = useLocation();
  const active = matches ? matches(pathname) : undefined;
  return (
    <SideNavItem
      to={to}
      end={end}
      active={active}
      icon={icon}
      label={label}
      onClick={(event) => reselectOnClick(event, active, onReselect)}
      badge={
        badge === 'unread-messages' ? (
          <UnreadMessagesBadge variant="count" />
        ) : badge === 'to-review' ? (
          <ReviewCountBadge variant="count" />
        ) : null
      }
    />
  );
}

/**
 * The navigation of a large screen, from 1024px (design/parc/screens/
 * Roster.dc.html): the same tabs as the tab bar, in a white column at the
 * left under the app's name.
 */
export default function SideNav() {
  const { role } = useAuth();
  const { t } = useI18n();
  const items = getNavItems(role, t);
  return (
    <ParcSideNav
      label={t('parcShell.navLabel')}
      brand={t('parcShell.brand')}
      className="hidden w-60 shrink-0 lg:flex"
    >
      {items.map((item) => (
        <NavItem key={item.to} {...item} />
      ))}
    </ParcSideNav>
  );
}
