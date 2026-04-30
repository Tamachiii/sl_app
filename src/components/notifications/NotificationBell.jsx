import { useEffect, useRef, useState } from 'react';
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

const BellIcon = (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.75}
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
      className={`w-full flex items-start gap-2 px-3 py-2.5 text-left hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors ${
        isUnread ? '' : 'opacity-70'
      }`}
    >
      {isUnread && (
        <span
          aria-hidden="true"
          className="mt-1.5 w-2 h-2 rounded-full shrink-0"
          style={{ background: 'var(--color-accent)' }}
        />
      )}
      {!isUnread && <span aria-hidden="true" className="mt-1.5 w-2 shrink-0" />}
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-gray-900 leading-snug">
          {t(i18nKey, params)}
        </p>
        <p className="sl-mono text-[10px] text-ink-400 mt-0.5">{stamp}</p>
      </div>
    </button>
  );
}

/**
 * Bell button with an unread-count badge that opens a popover listing recent
 * notifications. Selecting a row marks it read and (if the kind has a
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

  const badgeLabel = unreadCount > 9 ? '9+' : String(unreadCount);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={
          unreadCount > 0
            ? t('notifications.openWithUnread', { n: unreadCount })
            : t('notifications.open')
        }
        className="relative w-10 h-10 rounded-full bg-ink-100 flex items-center justify-center text-ink-700 cursor-pointer hover:bg-ink-200 active:scale-95 transition-transform"
      >
        {BellIcon}
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 sl-mono text-[9px] tabular-nums px-1.5 py-0.5 rounded-full leading-none"
            style={{
              background: 'var(--color-accent)',
              color: 'var(--color-ink-900)',
              border: '1.5px solid var(--color-ink-0)',
            }}
          >
            {badgeLabel}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-12 z-30 w-[320px] max-w-[calc(100vw-2rem)] rounded-xl bg-white shadow-lg border border-ink-100 overflow-hidden"
        >
          <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-ink-100">
            <span className="sl-label">{t('notifications.title')}</span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => markAll.mutate()}
                disabled={markAll.isPending}
                className="sl-mono text-[10px] uppercase tracking-wide text-ink-400 hover:text-[var(--color-accent)] disabled:opacity-50"
              >
                {t('notifications.markAllRead')}
              </button>
            )}
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {isLoading && (
              <div className="flex justify-center py-6"><Spinner /></div>
            )}

            {!isLoading && (!notifications || notifications.length === 0) && (
              <p className="sl-mono text-[12px] text-ink-400 text-center px-4 py-6">
                {t('notifications.empty')}
              </p>
            )}

            {!isLoading && notifications && notifications.length > 0 && (
              <ul className="list-none p-0 m-0 divide-y divide-ink-100">
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
