import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { subscribeToasts, getToasts, dismissToast } from '../../lib/toast';
import { useI18n } from '../../hooks/useI18n';

// How long a toast stays. One with an action stays longer: it is the only
// way back from what was just done, and has to be found, read and reached.
const AUTO_DISMISS_MS = 6000;
const ACTION_DISMISS_MS = 8000;
// What is left, at least, when the clock starts again after a pause — a toast
// must not vanish under the pointer that has just left it for its button.
const RESUME_MIN_MS = 2000;

/**
 * Close the toast after `lifetime` ms on screen, the time it is `paused` not
 * counted. Pausing stops the clock where it is; it starts again with what was
 * left, or with RESUME_MIN_MS when less was left.
 */
function useAutoDismiss(id, lifetime, paused, onDismiss) {
  const remaining = useRef(lifetime);

  useEffect(() => {
    if (paused) return undefined;
    const startedAt = Date.now();
    const timer = setTimeout(() => onDismiss(id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(RESUME_MIN_MS, remaining.current - (Date.now() - startedAt));
    };
  }, [id, paused, onDismiss]);
}

function Toast({ toast, onDismiss }) {
  const { t } = useI18n();
  // A toast message is an i18n key (pushed by non-React code that can't call
  // t()); resolve it here. t() gives a string that is no key back as it is.
  const resolve = (text) => (typeof text === 'string' ? t(text) : String(text));
  const { action } = toast;

  // The clock stops while the toast is under the pointer or holds the focus:
  // someone is reading it, or on the way to its button (WCAG 2.2.1). On a
  // touch screen the pointer "enters" with the finger and leaves with it.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useAutoDismiss(toast.id, action ? ACTION_DISMISS_MS : AUTO_DISMISS_MS, hovered || focused, onDismiss);

  // Once, whatever the hands do: a second tap lands before the toast is gone.
  const acted = useRef(false);
  function runAction() {
    if (acted.current) return;
    acted.current = true;
    try {
      action.onClick();
    } finally {
      onDismiss(toast.id);
    }
  }

  const isError = toast.kind === 'error';
  return (
    <div
      role={isError ? 'alert' : 'status'}
      className="sl-card px-4 py-3 flex items-center gap-4 shadow-lg pointer-events-auto"
      style={{
        borderLeft: `3px solid ${isError ? 'var(--color-danger)' : 'var(--color-accent)'}`,
        maxWidth: 'min(92vw, 420px)',
      }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        // Focus moving between the toast's own buttons has not left it.
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <p className="text-[13px] text-gray-900 flex-1 min-w-0">{resolve(toast.message)}</p>
      {action && (
        // Accent on the pill's ink surface, resting and hovered: 5.5:1 and
        // 5.0:1 (ToastHost.test.jsx recomputes them from the stylesheet).
        <button
          type="button"
          onClick={runAction}
          className="sl-pill sl-pill-btn shrink-0 -my-1.5 bg-ink-100 text-accent hover:bg-ink-200"
        >
          {resolve(action.label)}
        </button>
      )}
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label={t('common.dismiss')}
        className="sl-hit shrink-0 text-ink-400 hover:text-gray-900"
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
 *
 * A toast pushed with an `action` carries one button; pressing it calls the
 * action once and closes the toast. Every toast stops its clock while it is
 * under the pointer or holds the focus.
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
