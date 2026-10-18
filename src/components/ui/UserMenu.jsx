import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import { usePushSubscription } from '../../hooks/usePushSubscription';
import { preloadLogin } from '../../lib/preload';
import LanguageSelect from './LanguageSelect';
import NotificationBell from '../notifications/NotificationBell';
import { Button } from '../parc';

/**
 * Web Push opt-in row for the coach popover (mirrors the student's
 * StudentProfile toggle — same role-agnostic usePushSubscription hook). Only
 * mounted while the popover is open, so the enabled-state DB check defers
 * until the coach actually opens the menu. Renders nothing on devices where
 * push isn't available (desktop without support, missing VAPID key, etc.).
 */
function PushToggleRow() {
  const { t } = useI18n();
  const { supported, enabled, permission, pending, errorKey, enable, disable } = usePushSubscription();
  if (!supported) return null;

  const denied = permission === 'denied';
  const hint = errorKey
    ? t(errorKey)
    : denied
      ? t('coach.notifications.denied')
      : !enabled
        ? t('coach.notifications.hint')
        : null;

  return (
    <div className="flex flex-col gap-1.5 border-b border-line px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="pk-body font-semibold">{t('coach.notifications.label')}</span>
        <Button
          variant={enabled ? 'primary' : 'secondary'}
          onClick={enabled ? disable : enable}
          disabled={pending || denied}
          aria-pressed={enabled}
          className="shrink-0"
        >
          {pending
            ? t('coach.notifications.pending')
            : enabled
              ? t('coach.notifications.on')
              : t('coach.notifications.enable')}
        </Button>
      </div>
      {hint && <p className="pk-small m-0">{hint}</p>}
    </div>
  );
}

/**
 * Right-aligned page header action — every top-level page renders this.
 * The notification bell sits to the left of the avatar so any new event
 * (a student completing a session, etc.) surfaces on every screen without
 * each page needing to wire it in individually.
 *
 * Two avatar modes:
 *   - `profileHref` set → avatar is a <Link> to that page (no popover).
 *     Used by the student app to open the dedicated Profile page; the
 *     language and sign-out live there too.
 *   - `profileHref` unset → avatar opens a popover with the language, the
 *     notifications and sign-out inline. Used on the coach side, which has no
 *     Profile page yet.
 */
export default function UserMenu({ fullName, onSignOut, profileHref }) {
  const { t } = useI18n();
  const initials = (fullName || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');

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

  if (!initials) return null;

  // Link-mode avatar: tap navigates straight to the Profile page.
  // onPointerEnter preloads LoginPage — Profile is where signOut lives, so
  // by the time the user clicks Sign out the chunk is warm.
  // The group is `relative`: the bell's popover anchors to its right edge
  // (NotificationBell). No z-index on it: that would make it a stacking
  // context, and the popovers' z-30 and z-20 would count only inside it.
  if (profileHref) {
    return (
      <div className="relative flex items-center gap-2 shrink-0">
        <NotificationBell />
        <Link
          to={profileHref}
          aria-label={t('common.openProfile')}
          onPointerEnter={preloadLogin}
          onFocus={preloadLogin}
          className="pk-icon-btn text-[16px] font-bold text-ink no-underline"
        >
          {initials}
        </Link>
      </div>
    );
  }

  return (
    <div className="relative flex items-center gap-2 shrink-0">
      <NotificationBell />
      <div ref={ref} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          onPointerEnter={preloadLogin}
          onFocus={preloadLogin}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={menuId}
          aria-label={t('common.openUserMenu')}
          className="pk-icon-btn text-[16px] font-bold text-ink no-underline"
        >
          {initials}
        </button>
        {open && (
          <div
            id={menuId}
            role="menu"
            aria-label={t('common.openUserMenu')}
            className="absolute top-12 right-0 z-20 w-[300px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-group border border-line bg-surface shadow-lg"
          >
            <div className="border-b border-line px-4 py-3">
              <LanguageSelect label={t('common.language')} />
            </div>
            <PushToggleRow />
            {onSignOut && (
              <button
                type="button"
                role="menuitem"
                onClick={() => { setOpen(false); onSignOut(); }}
                className="flex min-h-13 w-full items-center px-4 text-left text-[16px] font-semibold text-red hover:bg-fill"
              >
                {t('common.signOut')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
