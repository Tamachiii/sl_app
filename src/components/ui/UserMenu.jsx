import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import { usePushSubscription } from '../../hooks/usePushSubscription';
import { preloadLogin } from '../../lib/preload';
import ThemeToggle from './ThemeToggle';
import LanguageSelect from './LanguageSelect';
import NotificationBell from '../notifications/NotificationBell';

/**
 * Web Push opt-in row for the coach popover (mirrors the student's
 * StudentProfile toggle — same role-agnostic usePushSubscription hook). Only
 * mounted while the popover is open, so the enabled-state DB check defers
 * until the coach actually opens the menu. Renders nothing on devices where
 * push isn't available (desktop without support, missing VAPID key, etc.).
 */
function PushToggleRow() {
  const { t } = useI18n();
  const { supported, enabled, permission, pending, errorCode, enable, disable } = usePushSubscription();
  if (!supported) return null;

  const denied = permission === 'denied';
  const hint = errorCode
    ? t(`common.pushError.${errorCode}`)
    : denied
      ? t('coach.notifications.denied')
      : !enabled
        ? t('coach.notifications.hint')
        : null;

  return (
    <div className="px-3 py-2.5 border-b border-ink-100 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="sl-label">{t('coach.notifications.label')}</span>
        <button
          type="button"
          onClick={enabled ? disable : enable}
          disabled={pending || denied}
          aria-pressed={enabled}
          // Off state uses utility classes so it flips in dark mode; the
          // enabled accent pill is theme-independent (matches sl-btn-primary).
          className={`sl-pill shrink-0 text-[11px] disabled:opacity-50 ${enabled ? '' : 'bg-ink-100 text-ink-700'}`}
          style={enabled ? { background: 'var(--color-accent)', color: 'var(--color-ink-900)' } : undefined}
        >
          {pending
            ? t('coach.notifications.pending')
            : enabled
              ? t('coach.notifications.on')
              : t('coach.notifications.enable')}
        </button>
      </div>
      {hint && (
        <p className="text-[11px] text-ink-400 leading-snug">{hint}</p>
      )}
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
 *     Used by the student app to open the dedicated Profile page; theme,
 *     language, and sign-out live there too.
 *   - `profileHref` unset → avatar opens a popover with theme / language /
 *     sign-out inline. Used on the coach side, which has no Profile page yet.
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
  if (profileHref) {
    return (
      <div className="flex items-center gap-2 shrink-0">
        <NotificationBell />
        <Link
          to={profileHref}
          aria-label={t('common.openProfile')}
          onPointerEnter={preloadLogin}
          onFocus={preloadLogin}
          className="w-10 h-10 rounded-full bg-ink-100 flex items-center justify-center sl-display text-[13px] text-ink-900 cursor-pointer hover:brightness-95 active:scale-95 transition-transform"
          style={{ border: '1.5px solid var(--color-accent)' }}
        >
          {initials}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 shrink-0">
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
          className="w-10 h-10 rounded-full bg-ink-100 flex items-center justify-center sl-display text-[13px] text-ink-900 cursor-pointer hover:brightness-95 active:scale-95 transition-transform"
          style={{ border: '1.5px solid var(--color-accent)' }}
        >
          {initials}
        </button>
        {open && (
          <div
            id={menuId}
            role="menu"
            aria-label={t('common.openUserMenu')}
            className="absolute right-0 top-12 z-20 min-w-[168px] rounded-xl bg-white shadow-lg border border-ink-100 overflow-hidden"
          >
            <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-ink-100">
              <span className="sl-label">{t('common.theme')}</span>
              <ThemeToggle />
            </div>
            <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-ink-100">
              <span className="sl-label">{t('common.language')}</span>
              <LanguageSelect />
            </div>
            <PushToggleRow />
            {onSignOut && (
              <button
                role="menuitem"
                onClick={() => { setOpen(false); onSignOut(); }}
                className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-gray-900 hover:bg-gray-50 text-left"
              >
                <svg className="w-4 h-4 text-ink-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                {t('common.signOut')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
