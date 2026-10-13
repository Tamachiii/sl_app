// A tiny toast store, framework-agnostic so non-React callers (the query
// client's MutationCache onError) can push a toast. Components subscribe via
// useToasts(); the ToastHost renders them.

// How many toasts are on screen at most. A toast with an action is never
// merged with another (see pushToast), so five sets removed in a row are five
// toasts — and the host sits over the bottom of the page the athlete is
// logging in. Past this number the oldest gives its place.
const MAX_TOASTS = 3;

let toasts = [];
const listeners = new Set();
let seq = 0;

function emit() {
  // New array identity so useSyncExternalStore sees a change.
  toasts = toasts.slice();
  for (const l of listeners) l();
}

export function subscribeToasts(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToasts() {
  return toasts;
}

export function dismissToast(id) {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length !== toasts.length) {
    toasts = next;
    emit();
  }
}

/**
 * Show a transient toast. `kind` is 'error' | 'info'. Returns the id.
 *
 * `message` is an i18n key or, from a caller that already has the sentence,
 * the sentence itself; the host resolves it. There are no parameters.
 *
 * `action` — `{ label, onClick }` — adds one button to the toast: "Undo" after
 * a set was removed, "Retry" after a failure. `label` is an i18n key or a
 * string, like `message`. The host calls `onClick` once and closes the toast;
 * a toast that goes away by itself, or is dismissed, calls nothing.
 *
 * De-dupes identical (kind, message) toasts already on screen so a retry
 * storm or a burst of the same constraint failure shows one line, not ten —
 * but ONLY toasts without an action. Two "Set removed" toasts say the same
 * and undo two different sets: merging them would leave one set without its
 * way back, and the other with the wrong one.
 *
 * Auto-dismiss is handled by the host (it owns the timer so it can pause on
 * hover / respect reduced-motion); this module stays render-free.
 */
export function pushToast(message, { kind = 'error', action } = {}) {
  if (!message) return null;
  const button =
    action && action.label && typeof action.onClick === 'function'
      ? { label: action.label, onClick: action.onClick }
      : null;
  if (!button) {
    const existing = toasts.find((t) => !t.action && t.message === message && t.kind === kind);
    if (existing) return existing.id;
  }
  const id = ++seq;
  const toast = button ? { id, message, kind, action: button } : { id, message, kind };
  toasts = [...toasts, toast].slice(-MAX_TOASTS);
  emit();
  return id;
}
