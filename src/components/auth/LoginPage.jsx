import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';

function ArrowRight({ size = 20 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

const inputCls =
  'w-full rounded-lg px-3 py-3 sl-mono text-[13px] focus:outline-none focus:ring-2';

const inputStyle = {
  background: 'var(--color-ink-850)',
  color: 'var(--color-ink-0)',
  border: '1px solid var(--color-ink-700)',
  '--tw-ring-color': 'var(--color-accent)',
};

export default function LoginPage() {
  const { user, role, signIn } = useAuth();
  const { t } = useI18n();
  const [step, setStep] = useState('welcome');
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
    <div
      className="relative flex flex-col h-full overflow-hidden"
      style={{ background: 'var(--color-ink-900)', color: 'var(--color-ink-50)' }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute"
        style={{
          top: 80,
          right: -60,
          width: 280,
          height: 280,
          background: 'var(--color-accent)',
          borderRadius: '50%',
          filter: 'blur(120px)',
          opacity: 0.35,
          zIndex: 0,
        }}
      />

      <div
        className="relative flex flex-1 flex-col px-7"
        style={{ zIndex: 1, paddingTop: 'calc(52px + env(safe-area-inset-top))' }}
      >
        <div className="pt-10">
          <div className="flex items-center gap-2.5" style={{ marginBottom: 80 }}>
            <div
              className="flex items-center justify-center"
              style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                background: 'var(--color-accent)',
              }}
            >
              <div
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  background: 'var(--color-ink-900)',
                }}
              />
            </div>
            <div
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 800,
                fontSize: 16,
                letterSpacing: '-0.02em',
                color: 'var(--color-ink-50)',
              }}
            >
              STREETLIFT
            </div>
          </div>

          <div
            className="sl-label"
            style={{ marginBottom: 14, color: 'var(--color-ink-400)' }}
          >
            COACHING · STREET LIFTING · STREET WORKOUT
          </div>

          <h1
            className="sl-display"
            style={{ fontSize: 64, lineHeight: 0.92, color: 'var(--color-ink-0)' }}
          >
            Become
            <br />
            a big monster
            <br />
            like
            <br />
            Tony.
          </h1>

          <p
            style={{
              marginTop: 28,
              fontSize: 14,
              lineHeight: 1.5,
              maxWidth: 280,
              color: 'var(--color-ink-300)',
            }}
          >
            Your coach programs the work. You log every set, rep and RPE. Progress stays honest.
          </p>
        </div>

        <div className="flex-1" />

        <div style={{ paddingBottom: 'calc(48px + env(safe-area-inset-bottom))' }}>
          {step === 'welcome' ? (
            <button
              type="button"
              onClick={() => setStep('form')}
              className="sl-btn-primary w-full transition active:scale-[0.98]"
              style={{ padding: '18px 20px', justifyContent: 'space-between' }}
            >
              <span>{t('login.signIn')}</span>
              <ArrowRight />
            </button>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              {error && (
                <div
                  role="alert"
                  className="sl-mono text-[12px] rounded-lg p-3"
                  style={{
                    background: 'color-mix(in srgb, var(--color-danger) 18%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--color-danger) 45%, transparent)',
                    color: 'var(--color-danger)',
                  }}
                >
                  {error}
                </div>
              )}

              <div>
                <label
                  htmlFor="login-email"
                  className="sl-label block"
                  style={{ marginBottom: 6, color: 'var(--color-ink-400)' }}
                >
                  {t('login.email')}
                </label>
                <input
                  id="login-email"
                  type="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputCls}
                  style={inputStyle}
                />
              </div>

              <div>
                <label
                  htmlFor="login-password"
                  className="sl-label block"
                  style={{ marginBottom: 6, color: 'var(--color-ink-400)' }}
                >
                  {t('login.password')}
                </label>
                <input
                  id="login-password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputCls}
                  style={inputStyle}
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="sl-btn-primary w-full transition active:scale-[0.98] disabled:opacity-60"
                style={{ padding: '18px 20px', justifyContent: 'space-between' }}
              >
                <span>{loading ? t('login.signingIn') : t('login.signIn')}</span>
                <ArrowRight />
              </button>
            </form>
          )}

          <div
            className="flex justify-between sl-mono"
            style={{ marginTop: 24, fontSize: 10, color: 'var(--color-ink-500)' }}
          >
            <span>EST. 2026</span>
            <span>BUILT FOR THE BAR</span>
          </div>
        </div>
      </div>
    </div>
  );
}
