import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { subscribeToasts, getToasts, dismissToast } from '../../lib/toast';
import { useI18n } from '../../hooks/useI18n';
import Toast from '../parc/Toast';

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

function HostedToast({ toast, onDismiss }) {
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

  return (
    <Toast
      kind={toast.kind === 'error' ? 'error' : 'info'}
      message={resolve(toast.message)}
      actionLabel={action ? resolve(action.label) : undefined}
      onAction={action ? runAction : undefined}
      onDismiss={() => onDismiss(toast.id)}
      dismissLabel={t('common.dismiss')}
      className="pointer-events-auto w-full"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        // Focus moving between the toast's own buttons has not left it.
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    />
  );
}

/**
 * Renders the global toast stack, drawn by the Parc `Toast`
 * (components/parc/Toast): a black line, « Annuler » in light blue, an error
 * with its cross and a close button. Mounted once in AppShell. Fixed to the
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
      className="fixed inset-x-0 z-50 mx-auto flex max-w-[560px] flex-col items-center gap-2.5 px-4 pointer-events-none"
      style={{
        // Above the bottom nav, or above the ActionBar of the page that has
        // one, which says its height in --toast-lift (parc/ActionBar).
        bottom: 'var(--toast-lift, calc(env(safe-area-inset-bottom) + 72px))',
        transition: reducedMotion ? undefined : 'opacity 150ms ease',
      }}
    >
      {toasts.map((toast) => (
        <HostedToast key={toast.id} toast={toast} onDismiss={dismissToast} />
      ))}
    </div>
  );
}
