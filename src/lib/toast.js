// A tiny toast store, framework-agnostic so non-React callers (the query
// client's MutationCache onError) can push a toast. Components subscribe via
// useToasts(); the ToastHost renders them.

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
 * De-dupes identical (kind, message) toasts already on screen so a retry
 * storm or a burst of the same constraint failure shows one line, not ten.
 * Auto-dismiss is handled by the host (it owns the timer so it can pause on
 * hover / respect reduced-motion); this module stays render-free.
 */
export function pushToast(message, { kind = 'error' } = {}) {
  if (!message) return null;
  const existing = toasts.find((t) => t.message === message && t.kind === kind);
  if (existing) return existing.id;
  const id = ++seq;
  toasts = [...toasts, { id, message, kind }];
  emit();
  return id;
}
