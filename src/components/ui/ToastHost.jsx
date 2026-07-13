import { useEffect, useState, useSyncExternalStore } from 'react';
import { subscribeToasts, getToasts, dismissToast } from '../../lib/toast';
import { useI18n } from '../../hooks/useI18n';

const AUTO_DISMISS_MS = 6000;

function Toast({ toast, onDismiss }) {
  const { t } = useI18n();
  // A toast message is an i18n key (pushed by non-React code that can't call
  // t()); resolve it here, falling back to the raw string if it isn't a key.
  const text = t(toast.message);
  const label = text === toast.message ? toast.message : text;

  useEffect(() => {
    const id = setTimeout(() => onDismiss(toast.id), AUTO_DISMISS_MS);
    return () => clearTimeout(id);
  }, [toast.id, onDismiss]);

  const isError = toast.kind === 'error';
  return (
    <div
      role={isError ? 'alert' : 'status'}
      className="sl-card px-4 py-3 flex items-start gap-3 shadow-lg pointer-events-auto"
      style={{
        borderLeft: `3px solid ${isError ? 'var(--color-danger)' : 'var(--color-accent)'}`,
        maxWidth: 'min(92vw, 420px)',
      }}
    >
      <p className="text-[13px] text-gray-900 flex-1 min-w-0">{label}</p>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label={t('common.dismiss')}
        className="shrink-0 text-ink-400 hover:text-gray-900 -mt-0.5"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

/**
 * Renders the global toast stack. Mounted once in AppShell. Fixed to the
 * bottom (above the mobile BottomNav's safe area) so it never shifts page
 * layout. Toasts are pushed from anywhere via lib/toast.pushToast — notably
 * the query client's MutationCache onError for otherwise-silent failures.
 */
export default function ToastHost() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(mq.matches);
    update();
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed inset-x-0 z-50 flex flex-col items-center gap-2 px-3 pointer-events-none"
      style={{
        bottom: 'calc(env(safe-area-inset-bottom) + 72px)',
        transition: reducedMotion ? undefined : 'opacity 150ms ease',
      }}
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={dismissToast} />
      ))}
    </div>
  );
}
