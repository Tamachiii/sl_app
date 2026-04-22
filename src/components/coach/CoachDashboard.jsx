import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { useAllConfirmations } from '../../hooks/useSessionConfirmation';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import ThemeToggle from '../ui/ThemeToggle';
import LanguageSelect from '../ui/LanguageSelect';

function UserMenu({ fullName, onSignOut }) {
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

  return (
    <div ref={ref} className="relative shrink-0">
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
  );
}

export default function CoachDashboard() {
  const { t } = useI18n();
  const { profile, signOut } = useAuth();
  const { data: confirmations, isLoading: confsLoading } = useAllConfirmations();

  const recentActivity = (confirmations || [])
    .filter((c) => !c.archived_at)
    .slice(0, 5);

  return (
    <div className="p-4 pb-6 md:p-8 space-y-5">
      <div className="sl-card px-4 py-4 md:px-6 md:py-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="sl-label text-ink-400">{t('coach.dashboard.kicker')}</div>
            <p className="sl-display text-[28px] md:text-[40px] text-gray-900 leading-none mt-1">
              {t('coach.dashboard.title')}
            </p>
          </div>
          <UserMenu fullName={profile?.full_name} onSignOut={signOut} />
        </div>
      </div>

      <section aria-labelledby="activity-heading" className="space-y-2">
        <h2 id="activity-heading" className="sl-label text-ink-400">
          {t('coach.dashboard.recentActivity')}
        </h2>

        {confsLoading && (
          <div className="flex justify-center py-6"><Spinner /></div>
        )}

        {!confsLoading && recentActivity.length === 0 && (
          <EmptyState message={t('coach.dashboard.noConfirmations')} />
        )}

        <div className="space-y-2 md:grid md:grid-cols-2 md:gap-2 md:space-y-0">
          {recentActivity.map((c) => (
            <Link
              key={c.id}
              to={`/coach/student/${c.student_id}/session/${c.session_id}/review`}
              className="block sl-card p-3 hover:bg-ink-50 transition-colors"
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className="sl-mono text-[11px] truncate"
                  style={{ color: 'var(--color-accent)' }}
                >
                  {c.student_name}
                </span>
                <span className="sl-mono text-[11px] text-ink-400 shrink-0">
                  {new Date(c.confirmed_at).toLocaleDateString()}
                </span>
              </div>
              <p className="sl-display text-[15px] text-gray-900 mt-0.5">
                {c.session_title || `Session ${c.day_number}`}
              </p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
