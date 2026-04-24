import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';

// Render both panels side-by-side on md+ (desktop split), one at a time on
// mobile (step-based welcome → form flow). We gate on JS matchMedia rather
// than CSS-only `hidden md:flex` so that only one "Sign In" button is in the
// DOM at a time on mobile — tests (jsdom has no Tailwind CSS loaded) count on
// that to disambiguate the CTA from the submit button.
function useIsDesktop() {
  const query = '(min-width: 768px)';
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mq = window.matchMedia(query);
    const handler = (e) => setIsDesktop(e.matches);
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, []);
  return isDesktop;
}

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

function ArrowLeft({ size = 18 }) {
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
      <path d="M19 12H5M11 18l-6-6 6-6" />
    </svg>
  );
}

const inputCls =
  'w-full rounded-lg px-3 py-3 sl-mono text-[16px] focus:outline-none focus:ring-2';

const inputStyle = {
  background: 'var(--color-ink-850)',
  color: 'var(--color-ink-0)',
  border: '1px solid var(--color-ink-700)',
  '--tw-ring-color': 'var(--color-accent)',
};

export default function LoginPage() {
  const { user, role, signIn } = useAuth();
  const { t } = useI18n();
  const isDesktop = useIsDesktop();
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

  const isWelcome = step === 'welcome';
  const showHero = isDesktop || isWelcome;
  const showForm = isDesktop || !isWelcome;
  const panelPadding = {
    paddingTop: 'calc(52px + env(safe-area-inset-top))',
    paddingBottom: 'calc(32px + env(safe-area-inset-bottom))',
  };

  return (
    <div
      className="relative h-full overflow-hidden"
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

      <div className="relative h-full mx-auto w-full md:grid md:grid-cols-2 md:max-w-6xl">
        {/* HERO PANEL — always on desktop, only on welcome step on mobile */}
        {showHero && (
        <section
          className="h-full flex flex-col px-7 md:px-12 lg:px-16"
          style={{ zIndex: 1, ...panelPadding }}
        >
          <div
            className="flex items-center gap-2.5"
            style={{
              marginTop: 40,
              marginBottom: 'clamp(32px, 10vh, 80px)',
            }}
          >
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
              Street Lifting App
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
            style={{
              fontSize: 'clamp(40px, 8vw, 76px)',
              lineHeight: 0.92,
              color: 'var(--color-ink-0)',
            }}
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
              marginTop: 'clamp(16px, 4vh, 28px)',
              fontSize: 14,
              lineHeight: 1.5,
              maxWidth: 280,
              color: 'var(--color-ink-300)',
            }}
          >
            Your coach programs the work. You log every set, rep and RPE. Progress stays honest.
          </p>

          <div className="flex-1" style={{ minHeight: 24 }} />

          {/* Mobile-only CTA + footer. On desktop the form panel owns these. */}
          <div className="md:hidden">
            <button
              type="button"
              onClick={() => setStep('form')}
              className="sl-btn-primary w-full transition active:scale-[0.98]"
              style={{ padding: '18px 20px', justifyContent: 'space-between' }}
            >
              <span>{t('login.signIn')}</span>
              <ArrowRight />
            </button>
            <div
              className="flex justify-between sl-mono"
              style={{ marginTop: 24, fontSize: 10, color: 'var(--color-ink-500)' }}
            >
              <span>EST. 2026</span>
              <span>BUILT FOR THE BAR</span>
            </div>
          </div>
        </section>
        )}

        {/* FORM PANEL — always on desktop, only on form step on mobile */}
        {showForm && (
        <section
          className="h-full flex flex-col px-7 md:px-12 lg:px-16"
          style={{ zIndex: 1, ...panelPadding }}
        >
          {/* Mobile-only top bar: back button + brand. Desktop shows brand in the hero panel only. */}
          <div
            className="md:hidden flex items-center gap-2.5"
            style={{ marginTop: 24, marginBottom: 24 }}
          >
            <button
              type="button"
              onClick={() => {
                setStep('welcome');
                setError('');
              }}
              aria-label={t('common.back')}
              className="flex items-center justify-center rounded-lg transition active:scale-95"
              style={{
                width: 32,
                height: 32,
                marginRight: 4,
                background: 'var(--color-ink-850)',
                color: 'var(--color-ink-100)',
                border: '1px solid var(--color-ink-700)',
              }}
            >
              <ArrowLeft />
            </button>
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
              Street Lifting App
            </div>
          </div>

          {/* On desktop we vertically center the form inside the panel. On mobile it sits at the bottom below the spacer. */}
          <div className="flex-1 md:flex md:flex-col md:justify-center">
            <div className="hidden md:block">
              <div
                className="sl-label"
                style={{ marginBottom: 10, color: 'var(--color-ink-400)' }}
              >
                {t('login.kicker')}
              </div>
              <h1
                className="sl-display"
                style={{
                  fontSize: 'clamp(32px, 5vw, 52px)',
                  lineHeight: 0.95,
                  color: 'var(--color-ink-0)',
                  marginBottom: 'clamp(20px, 4vh, 40px)',
                }}
              >
                {t('login.title')}
              </h1>
            </div>

            <div className="md:hidden">
              <div
                className="sl-label"
                style={{ marginBottom: 10, color: 'var(--color-ink-400)' }}
              >
                {t('login.kicker')}
              </div>
              <h1
                className="sl-display"
                style={{
                  fontSize: 'clamp(32px, 10vw, 44px)',
                  lineHeight: 0.95,
                  color: 'var(--color-ink-0)',
                }}
              >
                {t('login.title')}
              </h1>
              <div style={{ minHeight: 24 }} />
            </div>

            <form
              onSubmit={handleSubmit}
              className="space-y-3 w-full"
              style={{ maxWidth: 440 }}
            >
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
          </div>

          <div
            className="flex justify-between sl-mono"
            style={{ marginTop: 24, fontSize: 10, color: 'var(--color-ink-500)' }}
          >
            <span>EST. 2026</span>
            <span>BUILT FOR THE BAR</span>
          </div>
        </section>
        )}
      </div>
    </div>
  );
}
