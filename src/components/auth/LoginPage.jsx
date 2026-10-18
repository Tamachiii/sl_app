import { useId, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { returnPathFor } from '../../lib/returnPath';
import { isNetworkError } from '../../lib/networkErrors';
import { Button } from '../parc';

// What a refused sign-in says, in the app's language: the auth server's own
// message is English (« Invalid login credentials »), and it was shown as it
// came on a page in French.
function signInProblem(error) {
  const message = error?.message ?? '';
  if (error?.code === 'invalid_credentials' || /invalid (login )?credentials/i.test(message)) {
    return 'parcLogin.invalidCredentials';
  }
  if (error?.status === 429 || error?.code === 'over_request_rate_limit') return 'parcLogin.tooManyAttempts';
  if (isNetworkError(error)) return 'parcLogin.noAnswer';
  return 'parcLogin.failed';
}

/**
 * The sign-in page, in the Parc design (no mock of its own: the README and the
 * primitives). On `ground`: the app's mark and name, the coach's line in a
 * large title, and the form on `surface` — side by side from 1024px, one
 * above the other on a phone, where the form is reached without a step of its
 * own. A signed-in account goes back to the page it was sent from, when that
 * page is one of its role (`returnPathFor`).
 */
export default function LoginPage() {
  const { user, role, signIn } = useAuth();
  const { t } = useI18n();
  const location = useLocation();
  const emailId = useId();
  const passwordId = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (user && role) {
    return <Navigate to={returnPathFor(role, location.state?.from)} replace />;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const { error: err } = await signIn(email, password);
    if (err) setError(signInProblem(err));
    setLoading(false);
  }

  return (
    <div
      className="h-full overflow-y-auto bg-ground text-ink"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <div className="mx-auto flex min-h-full w-full max-w-content flex-col gap-10 px-4 py-10 md:px-8 lg:grid lg:grid-cols-2 lg:items-center lg:gap-16">
        <section className="flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width="40" height="40" className="rounded-control" />
            <p className="pk-condensed m-0 text-[30px] font-extrabold leading-none">{t('parcShell.brand')}</p>
          </div>
          <div className="flex flex-col gap-3">
            <p className="pk-caption m-0">{t('parcLogin.tagline')}</p>
            <p className="pk-large-title m-0">{t('parcLogin.hero')}</p>
            <p className="pk-subhead m-0 max-w-sm">{t('parcLogin.lead')}</p>
          </div>
        </section>

        <section aria-labelledby="login-title" className="w-full max-w-md rounded-group bg-surface p-6 lg:justify-self-end">
          <h1 id="login-title" className="pk-title">
            {t('parcLogin.title')}
          </h1>
          <form onSubmit={handleSubmit} className="mt-5 flex flex-col gap-4">
            {error && (
              <p role="alert" className="m-0 rounded-control bg-red-soft p-3 text-[14px] leading-[1.4] text-red">
                {t(error)}
              </p>
            )}
            <label htmlFor={emailId} className="flex flex-col gap-1.5">
              <span className="pk-caption">{t('parcLogin.email')}</span>
              <input
                id={emailId}
                type="email"
                autoComplete="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="pk-field"
              />
            </label>
            <label htmlFor={passwordId} className="flex flex-col gap-1.5">
              <span className="pk-caption">{t('parcLogin.password')}</span>
              <input
                id={passwordId}
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pk-field"
              />
            </label>
            <Button type="submit" variant="primary" size="lg" disabled={loading} className="mt-1">
              {loading ? t('parcLogin.signingIn') : t('parcLogin.signIn')}
            </Button>
          </form>
        </section>
      </div>
    </div>
  );
}
