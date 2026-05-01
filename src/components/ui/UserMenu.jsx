import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import ThemeToggle from './ThemeToggle';
import LanguageSelect from './LanguageSelect';
import NotificationBell from '../notifications/NotificationBell';

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
  if (profileHref) {
    return (
      <div className="flex items-center gap-2 shrink-0">
        <NotificationBell />
        <Link
          to={profileHref}
          aria-label={t('common.openProfile')}
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
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t('common.openUserMenu')}
          className="w-10 h-10 rounded-full bg-ink-100 flex items-center justify-center sl-display text-[13px] text-ink-900 cursor-pointer hover:brightness-95 active:scale-95 transition-transform"
          style={{ border: '1.5px solid var(--color-accent)' }}
        >
          {initials}
        </button>
        {open && (
          <div
            role="menu"
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
