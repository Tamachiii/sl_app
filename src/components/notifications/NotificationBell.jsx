import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import {
  useNotifications,
  useUnreadNotificationCount,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
  describeNotification,
  formatNotificationStamp,
} from '../../hooks/useNotifications';
import Spinner from '../ui/Spinner';
import { Button, Count } from '../parc';

// The bell, drawn as the Parc icons are — a 2px stroke in a 24px box, in the
// colour of the text around it. The design system's set has none: it is the
// one icon of the app outside it.
const BellIcon = (
  <svg width="22" height="22" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 0 0-4-5.66V5a2 2 0 1 0-4 0v.34A6 6 0 0 0 6 11v3.2a2 2 0 0 1-.6 1.4L4 17h5m6 0a3 3 0 1 1-6 0"
    />
  </svg>
);

function NotificationRow({ notif, onSelect }) {
  const { t, lang } = useI18n();
  const { i18nKey, params } = describeNotification(notif);
  const stamp = formatNotificationStamp(notif.created_at, lang);
  const isUnread = !notif.read_at;

  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => onSelect(notif)}
      className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-fill"
    >
      <span
        aria-hidden="true"
        className={`mt-2 h-2 w-2 shrink-0 rounded-full ${isUnread ? 'bg-blue' : 'bg-transparent'}`}
      />
      <span className="min-w-0 flex-1">
        <span className={`block text-[15px] leading-[1.4] ${isUnread ? 'font-semibold text-ink' : 'text-ink-2'}`}>
          {t(i18nKey, params)}
        </span>
        <span className="pk-small mt-0.5 block">{stamp}</span>
      </span>
    </button>
  );
}

/**
 * Bell button with an unread-count badge that opens a popover listing recent
 * notifications. Mounted only by `ui/UserMenu`, whose group positions the
 * popover. Selecting a row marks it read and (if the kind has a
 * deep-link) navigates there. A "Mark all read" footer action clears the
 * badge in one shot.
 */
export default function NotificationBell() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { data: notifications, isLoading } = useNotifications();
  const { data: unreadCount = 0 } = useUnreadNotificationCount();
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();

  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    function handle(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    function handleKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handle);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handle);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  function handleSelect(notif) {
    if (!notif.read_at) markRead.mutate(notif.id);
    const { path } = describeNotification(notif);
    setOpen(false);
    if (path) navigate(path);
  }

  return (
    <div ref={ref} className="shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={
          unreadCount > 0
            ? t('notifications.openWithUnread', { n: unreadCount })
            : t('notifications.open')
        }
        className="pk-icon-btn relative text-ink"
      >
        {BellIcon}
        {/* The number is said by the button's name. */}
        <Count count={unreadCount} className="absolute -top-1 -right-1" />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={t('notifications.title')}
          className="absolute top-12 right-0 z-30 w-[340px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-group border border-line bg-surface shadow-lg"
        >
          {/* 52px with or without "Mark all read": the button is 44px high. It
              may shrink: its German label takes two lines rather than pushing
              the row past the popover. */}
          <div className="flex min-h-13 items-center justify-between gap-2 border-b border-line py-1 pr-1 pl-4">
            <span className="pk-headline">{t('notifications.title')}</span>
            {unreadCount > 0 && (
              <Button variant="text" onClick={() => markAll.mutate()} disabled={markAll.isPending}>
                {t('notifications.markAllRead')}
              </Button>
            )}
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {isLoading && (
              <div className="flex justify-center py-6"><Spinner /></div>
            )}

            {!isLoading && (!notifications || notifications.length === 0) && (
              <p className="pk-caption m-0 px-4 py-6 text-center">{t('notifications.empty')}</p>
            )}

            {!isLoading && notifications && notifications.length > 0 && (
              <ul className="m-0 list-none divide-y divide-line p-0">
                {notifications.map((n) => (
                  <li key={n.id}>
                    <NotificationRow notif={n} onSelect={handleSelect} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
