import { REST_TIMER_TAG, closeNotifications, within } from './swHandlers';

// The page's half of "a `Rest done` that is no longer news goes away".
//
// The push that ends a rest is shown by the service worker (lib/swHandlers).
// It carries a tag, so the next rest replaces it — but nothing replaces the
// last one of a session, which stays on the lock screen and in the
// notification centre until someone swipes it away. The worker closes it when
// a notification is tapped; it hears nothing when the app is opened from its
// icon or brought back from the app switcher. The page does: this file closes
// the notification each time the app comes back in front of its user.
//
// A push that arrives while the app is in front is the worker's again: it shows
// that one quietly and closes it itself (FOCUSED_REST_CLOSE_MS).

/**
 * Close the "Rest done" notifications of this device. Never throws; answers
 * how many it closed (0 where notifications are not allowed, or without a
 * service worker — a dev server, a browser that has none).
 */
export async function closeRestNotifications({
  container = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker,
  permission = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
} = {}) {
  // Nothing was ever shown on a device that never allowed it: no need to ask.
  if (permission !== 'granted') return 0;
  if (!container || typeof container.getRegistration !== 'function') return 0;
  try {
    // Not `ready`, which never answers where no worker is registered.
    return await closeNotifications(await container.getRegistration(), REST_TIMER_TAG);
  } catch {
    return 0;
  }
}

/**
 * How long a sweep waits for the device to answer. Without an answer by then
 * it is given up, and the next return of the app sweeps again.
 */
export const SWEEP_ANSWER_MS = 5000;

/**
 * One watcher. The app uses the single instance at the end of this file; the
 * argument exists for the tests.
 */
export function createRestNotificationSweep({ close = closeRestNotifications } = {}) {
  let listeningOn = null;
  let running = false;

  // "In front" for a page: visible. Returning to an installed app changes
  // `visibilityState`; clicking back into a desktop window that was visible all
  // along only fires `focus` — the two together cover both.
  const sweep = () => {
    if (!listeningOn || listeningOn.doc.visibilityState !== 'visible') return;
    if (running) return; // both events fire on one return
    running = true;
    // Bounded: a getRegistration() or a getNotifications() that never answers
    // would keep `running` set, and every later return would sweep nothing.
    within(SWEEP_ANSWER_MS, Promise.resolve().then(() => close()), 0)
      .catch(() => {})
      .finally(() => {
        running = false;
      });
  };

  return {
    /** Listen, and sweep once for the app that was just opened. Once: a second call changes nothing. */
    install(doc = document, win = window) {
      if (listeningOn) return;
      listeningOn = { doc, win };
      doc.addEventListener('visibilitychange', sweep);
      win.addEventListener('focus', sweep);
      sweep();
    },
    uninstall() {
      if (!listeningOn) return;
      listeningOn.doc.removeEventListener('visibilitychange', sweep);
      listeningOn.win.removeEventListener('focus', sweep);
      listeningOn = null;
    },
  };
}

/** The app's watcher: installed once by src/main.jsx (production builds). Making it touches nothing. */
export const restNotifications = createRestNotificationSweep();
