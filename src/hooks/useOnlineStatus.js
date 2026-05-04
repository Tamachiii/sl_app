import { useSyncExternalStore } from 'react';

// Track navigator.onLine across the app via the standard online/offline events.
// useSyncExternalStore keeps every consumer in sync without each having to
// register its own listener — fine for a small banner, the VideoUploadButton
// gate, and any future offline-aware callsite.

function subscribe(onChange) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

function getSnapshot() {
  if (typeof navigator === 'undefined') return true;
  // navigator.onLine is best-effort: some browsers report true even when the
  // network is down (no captive-portal probe). Good enough for student-facing
  // UX — replay still gates on actual mutation success.
  return navigator.onLine !== false;
}

function getServerSnapshot() {
  return true;
}

export function useOnlineStatus() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
