import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';

// Catch-all for unknown authenticated routes. Without this, react-router
// would silently match the outer wildcard and bounce to /login, which then
// redirects back to the role home — the user lands on their dashboard with
// no explanation of why their deep link didn't work.
export default function NotFound() {
  const { t } = useI18n();
  const { role } = useAuth();
  const location = useLocation();
  const home = role === 'coach' ? '/coach/dashboard' : '/student';

  return (
    <div className="p-4 pb-6 md:p-8">
      <div className="max-w-md mx-auto pt-6 md:pt-12 space-y-5 text-center">
        <div className="sl-label text-ink-400">404</div>
        <h1 className="sl-display text-[32px] md:text-[40px] text-gray-900 leading-none">
          {t('notFound.title')}
        </h1>
        <p className="text-[14px] text-gray-700 leading-snug">
          {t('notFound.body')}
        </p>
        <p className="sl-mono text-[11px] text-ink-400 break-all">
          <span className="opacity-60">URL:</span> {location.pathname || '/'}
        </p>
        <Link
          to={home}
          className="sl-btn-primary inline-block text-[13px]"
          style={{ padding: '10px 20px' }}
        >
          {t('notFound.goHome')}
        </Link>
      </div>
    </div>
  );
}
