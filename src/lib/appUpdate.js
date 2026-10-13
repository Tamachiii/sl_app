import { BUILD_ID } from './buildInfo';
import { SKIP_WAITING } from './swHandlers';

// How a new version of the app reaches a page that is already open.
//
// The page registers the service worker itself and keeps three promises:
//
//   1. IT ASKS. `registration.update()` runs when the app comes back to the
//      foreground and once an hour — a hash route change is not a navigation,
//      so the browser never asks on its own for a tab that stays open.
//   2. IT DECIDES WHEN. A new worker installs and waits (src/lib/swHandlers.js).
//      It is told to take over only at a moment the page calls safe — nothing
//      being written, no rest timer, nothing being typed — which is a question
//      the updater puts to whoever registered with `watchForSafeMoment`
//      (components/ui/UpdatePrompt, mounted in AppShell). At any other moment
//      the update is `offered` and the person chooses.
//   3. IT RELOADS ONLY ITSELF, ONLY HERE, AND ONLY ONCE THE NEW WORKER IS
//      `activated`. The one `location.reload()` of the update flow is
//      `doReload` below. A worker that changes under the page without this
//      page having asked (another window applied the update) makes the page
//      `pending` like any other update: it reloads at its own safe moment,
//      never because another window was ready first.
//
// What "activated" is about. A worker that is told to take over becomes
// `activating`, the page hears `controllerchange` — and only then does the
// browser run the worker's `activate` handlers; Chromium takes a full second
// to get there. A reload asked for in that second is not refused: it is held
// back until the worker is `activated`, and the page it will replace stays on
// the screen meanwhile, takes taps and sends writes. So nothing is asked of the
// browser before `activated`, where a reload is a matter of milliseconds; the
// page says "Updating…" until then (`applying`), and an update the page applied
// by itself puts the question of promise 2 a second time at that point
// (`arrive`) — whatever began during the wait is not reloaded over.
//
// The state a component reads is `{ pending, applying, offered, failed }`;
// `pending` stays true for the whole of an attempt.

/** A tab that stays in front asks once an hour. */
export const CHECK_EVERY_MS = 60 * 60 * 1000;
/** Coming back to the app asks again only after this long: a rest between two sets is not a reason to fetch. */
export const CHECK_MIN_GAP_MS = 15 * 60 * 1000;
/** An attempt whose worker is not `activated` after this long is over, and nothing is reloaded. */
export const APPLY_TIMEOUT_MS = 10 * 1000;
/**
 * sessionStorage: the build that last reloaded ITSELF for an update. A page
 * that finds its own id there is the same build again — the reload brought
 * nothing new — so it does not try a second time on its own. This is what
 * makes a reload loop impossible; a tap on "Update" is not held by it.
 */
export const AUTO_APPLIED_KEY = 'sl_update_auto_applied';

const IDLE = Object.freeze({ pending: false, applying: false, offered: false, failed: false });

function sessionStore() {
  return {
    get(key) {
      try {
        return window.sessionStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        window.sessionStorage.setItem(key, value);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * One updater. The app uses the single instance at the end of this file; the
 * arguments exist for the tests.
 */
export function createAppUpdater({
  container = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined,
  reload = () => window.location.reload(),
  storage = sessionStore(),
  buildId = BUILD_ID,
} = {}) {
  let state = IDLE;
  const listeners = new Set();

  let registration = null;
  let started = false;
  let controlled = false; // has this page been served by a worker so far
  let waiting = false; // a new worker is installed and waits
  let stale = false; // a new worker took over without this page asking: only the page is old
  let applying = false;
  let applyingAuto = false; // the attempt under way is the page's own, not a tap on "Update"
  let awaited = null; // the worker whose `activated` the attempt under way waits for
  let offered = false;
  let failed = false;
  let reloading = false;
  let isBusy = null; // the question of promise 2, while someone is there to answer it
  let lastCheckAt = 0;
  let checkTimer = null;
  let applyTimer = null;
  const followed = new WeakSet();

  // An attempt is an update too, from the message to the reload: the worker
  // leaves the waiting slot long before the page is reloaded.
  const pending = () => waiting || stale || applying;

  function publish() {
    const next = {
      pending: pending(),
      applying,
      offered: offered && pending() && !applying,
      failed: failed && pending(),
    };
    if (
      next.pending === state.pending &&
      next.applying === state.applying &&
      next.offered === state.offered &&
      next.failed === state.failed
    ) {
      return;
    }
    state = next;
    for (const listener of [...listeners]) listener();
  }

  function doReload() {
    if (reloading) return;
    reloading = true;
    clearTimeout(applyTimer);
    reload();
  }

  // The attempt is over and nothing was reloaded: the worker did not take
  // over. Reloading would only bring the same page back, so the page stays and
  // the update is offered again.
  function giveUp() {
    clearTimeout(applyTimer);
    awaited = null;
    applying = false;
    failed = true;
    offered = true;
    settle();
  }

  // The worker the attempt waited for is `activated`: a reload now is the new
  // page, at once.
  function arrive() {
    awaited = null;
    // An update the page applied BY ITSELF was decided before the wait: a set
    // ticked or a field typed into since then is exactly what the reload must
    // not land on. So the question is put once more, here, right before the
    // reload — and on "yes" the page keeps running. It is now only `stale`: its
    // reload needs no worker any more and happens at the next safe moment.
    // A tap on "Update" is the person's own choice and is not asked again.
    if (applyingAuto && isBusy && isBusy()) {
      clearTimeout(applyTimer);
      applying = false;
      offered = true;
      storage.set(AUTO_APPLIED_KEY, ''); // nothing was reloaded: the attempt is not used up
      settle(() => { stale = true; });
      return;
    }
    doReload();
  }

  /**
   * Apply the update: tell the waiting worker to take over, or take the one
   * that already did, and reload once that worker is `activated`.
   * `auto` is the page acting on its own: refused after a failed attempt, and
   * once this build has already reloaded itself (AUTO_APPLIED_KEY).
   * Returns whether an update is now on its way.
   */
  function apply({ auto = false } = {}) {
    if (applying || reloading) return true;
    if (!pending()) return false;
    const worker = registration ? registration.waiting : null;
    if (!worker && !stale) {
      settle();
      return false;
    }
    if (auto) {
      if (failed || storage.get(AUTO_APPLIED_KEY) === buildId) return false;
      // No guard, no reload on our own: without it nothing would stop a loop.
      if (!storage.set(AUTO_APPLIED_KEY, buildId)) return false;
    }
    applying = true;
    applyingAuto = auto;
    failed = false;
    publish();
    let arriving = worker;
    if (worker) {
      worker.postMessage({ type: SKIP_WAITING });
    } else {
      // Stale: the worker that serves this page changed already. Nobody to
      // tell — but it may still be on its way to `activated` (another window
      // told it a moment ago), and a reload waits for that like any other.
      arriving = container.controller;
      if (!arriving || arriving.state === 'activated' || arriving.state === 'redundant') {
        doReload();
        return true;
      }
    }
    awaited = arriving;
    follow(awaited);
    clearTimeout(applyTimer);
    applyTimer = setTimeout(giveUp, APPLY_TIMEOUT_MS);
    return true;
  }

  /**
   * A moment at which the update may be applied without anyone asking: it
   * became available, the app came back to the foreground, the page changed.
   * Safe → applied. Not safe → offered.
   */
  function consider() {
    if (!pending() || applying || reloading) return;
    if (!isBusy) return; // nobody to ask (signed out): the update waits for a page that can tell
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (!isBusy() && apply({ auto: true })) return;
    offered = true;
    publish();
  }

  // Re-read the registration, publish, and treat "an update just appeared" as a moment.
  function settle(change) {
    const was = pending();
    if (change) change();
    waiting = Boolean(registration && registration.waiting && registration.active);
    if (!pending()) {
      offered = false;
      failed = false;
    }
    publish();
    if (!was && pending()) consider();
  }

  const onWorkerState = (event) => {
    settle();
    if (!applying || reloading || !awaited || event.target !== awaited) return;
    if (awaited.state === 'activated') arrive();
    else if (awaited.state === 'redundant') giveUp(); // it was replaced, or its activation failed
  };

  function follow(worker) {
    if (!worker || followed.has(worker)) return;
    followed.add(worker);
    worker.addEventListener('statechange', onWorkerState);
  }

  const onUpdateFound = () => {
    follow(registration.installing);
    settle();
  };

  function onControllerChange() {
    const wasControlled = controlled;
    controlled = true;
    // The first worker of a page that had none (first install, hard reload)
    // serves the build the page already is.
    if (!wasControlled && !applying) return;
    // From here on the page is older than the worker that serves it — because
    // it asked, or because another window did. NOTHING IS RELOADED HERE: the
    // worker is `activating`, and the reload belongs to `activated` (`arrive`).
    // An attempt under way goes on waiting for it; a page that did not ask
    // becomes pending, and `settle` treats that as a moment.
    settle(() => { stale = true; });
  }

  /** Ask the server for a new worker. Quiet when offline or when asked a moment ago. */
  async function check() {
    if (!registration) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const now = Date.now();
    if (now - lastCheckAt < CHECK_MIN_GAP_MS) return;
    lastCheckAt = now;
    try {
      await registration.update();
    } catch {
      // No network after all, or the registration is gone. A question that got
      // no answer does not hold the next one back: the next return to the app
      // asks again, however soon it comes.
      lastCheckAt = 0;
    }
    follow(registration.installing);
    settle();
  }

  const onVisibility = () => {
    if (document.visibilityState !== 'visible') return;
    consider();
    check();
  };
  const onOnline = () => {
    check();
  };

  /** Register the worker and start asking. Resolves once the registration is known. */
  async function start({ swUrl, scope }) {
    if (started || !container) return;
    started = true;
    controlled = Boolean(container.controller);
    container.addEventListener('controllerchange', onControllerChange);
    try {
      registration = await container.register(swUrl, { scope });
    } catch {
      // No worker (private window, blocked storage): the app runs from the
      // network and there is nothing to update.
      container.removeEventListener('controllerchange', onControllerChange);
      started = false;
      return;
    }
    lastCheckAt = Date.now(); // registering asked the server already
    registration.addEventListener('updatefound', onUpdateFound);
    follow(registration.installing);
    follow(registration.waiting);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    checkTimer = setInterval(check, CHECK_EVERY_MS);
    settle();
  }

  function stop() {
    if (!started) return;
    started = false;
    clearInterval(checkTimer);
    clearTimeout(applyTimer);
    container.removeEventListener('controllerchange', onControllerChange);
    if (registration) registration.removeEventListener('updatefound', onUpdateFound);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onOnline);
  }

  return {
    start,
    stop,
    check,
    apply,
    consider,
    dismiss() {
      offered = false;
      publish();
    },
    /**
     * `probe()` answers "would a reload lose something right now?". Registering
     * it is itself a moment: an update found while nobody could answer is
     * considered now. Returns the function that withdraws the probe.
     */
    watchForSafeMoment(probe) {
      isBusy = probe;
      consider();
      return () => {
        if (isBusy === probe) isBusy = null;
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
  };
}

/**
 * The app's updater: started once by src/main.jsx (production builds), read
 * and answered by components/ui/UpdatePrompt. Making it touches nothing — the
 * worker is registered by `start`.
 */
export const appUpdater = createAppUpdater();
