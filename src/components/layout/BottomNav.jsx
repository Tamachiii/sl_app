import { useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { Tab, TabBar } from '../parc';
import { getNavItems, reselectOnClick } from './navItems';
import UnreadMessagesBadge from '../messaging/UnreadMessagesBadge';
import ReviewCountBadge from './ReviewCountBadge';

function NavTab({ to, label, icon, end = false, matches, badge, onReselect }) {
  const { pathname } = useLocation();
  // A tab whose pages are not all under its own path says when it is open
  // (navItems `matches`); the others follow the router.
  const active = matches ? matches(pathname) : undefined;
  return (
    <Tab
      to={to}
      end={end}
      active={active}
      icon={icon}
      label={label}
      onClick={(event) => reselectOnClick(event, active, onReselect)}
      badge={
        badge === 'unread-messages' ? (
          <UnreadMessagesBadge variant="dot" />
        ) : badge === 'to-review' ? (
          <ReviewCountBadge variant="icon" />
        ) : null
      }
    />
  );
}

/**
 * The tab bar at the bottom of a top-level screen, under 1024px
 * (design/parc/components/TabBar): the tabs of the role, the open one in blue,
 * a count on Séances and Messages. From 1024px the SideNav carries the same
 * tabs.
 */
export default function BottomNav() {
  const { role } = useAuth();
  const { t } = useI18n();
  const items = getNavItems(role, t);
  return (
    <TabBar label={t('parcShell.navLabel')} className="sticky bottom-0 z-10 lg:hidden">
      {items.map((item) => (
        <NavTab key={item.to} {...item} />
      ))}
    </TabBar>
  );
}
