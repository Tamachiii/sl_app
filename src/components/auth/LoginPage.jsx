import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import LanguageSelect from '../ui/LanguageSelect';

const inputCls =
  'w-full rounded-lg border border-ink-200 bg-white px-3 py-2.5 sl-mono text-[13px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]';

export default function LoginPage() {
  const { user, role, signIn } = useAuth();
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (user && role) {
    return <Navigate to={`/${role}`} replace />;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const { error: err } = await signIn(email, password);
    if (err) setError(err.message);
    setLoading(false);
  }

  return (
    <div className="flex items-center justify-center h-full px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm sl-card p-6 space-y-5"
      >
        <div className="text-center space-y-1">
          <div className="sl-label text-ink-400">{t('login.kicker')}</div>
          <h1 className="sl-display text-[28px] text-gray-900 leading-none">
            {t('login.title')}
          </h1>
        </div>

        <div className="flex justify-center">
          <LanguageSelect />
        </div>

        {error && (
          <div
            id="login-error"
            role="alert"
            className="sl-mono text-[12px] rounded-lg p-3"
            style={{
              background: 'color-mix(in srgb, var(--color-danger) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--color-danger) 35%, transparent)',
              color: 'var(--color-danger)',
            }}
          >
            {error}
          </div>
        )}

        <div>
          <label htmlFor="login-email" className="sl-label text-ink-400 block mb-1">
            {t('login.email')}
          </label>
          <input
            id="login-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputCls}
          />
        </div>

        <div>
          <label htmlFor="login-password" className="sl-label text-ink-400 block mb-1">
            {t('login.password')}
          </label>
          <input
            id="login-password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputCls}
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full sl-btn-primary text-[13px] disabled:opacity-50"
          style={{ padding: '10px 16px' }}
        >
          {loading ? t('login.signingIn') : t('login.signIn')}
        </button>
      </form>
    </div>
  );
}
