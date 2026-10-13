// What the service worker does at the steps of its own life — install,
// activate, a message from a page — written as functions of the worker's scope
// so that vitest can run them. src/sw.js only wires them to the events.
//
// The rule they hold: A NEW WORKER TAKES OVER WHEN A PAGE ASKS FOR IT. It
// installs next to the one that is serving the app, waits, and is activated by
// the message below, which a page sends once nothing would be lost by the
// reload that follows (src/lib/appUpdate.js, components/ui/UpdatePrompt).

/** The message a page sends to the waiting worker. */
export const SKIP_WAITING = 'SKIP_WAITING';

// The one case in which a worker still takes over by itself: the pages it
// would wait for cannot ask.
//
// The app published before this file registered its worker in "auto update"
// mode: its pages reload when a new worker activates and never send a message.
// A worker that waited for them would wait until every window of the app is
// closed — and a reload does not count as closing. So a worker of this kind
// leaves a mark when it activates, and the next one reads it at install: no
// mark means the pages on this device were served by a worker older than this
// file, and the new worker takes over at once, exactly as every worker before
// it did. From then on the pages come from a worker that left the mark, and
// they are the ones that ask.
//
// The mark is one entry of a cache of its own, in the Cache Storage the worker
// already uses for the app's files. Workbox's clean-up only touches caches
// whose name contains "-precache-".
export const UPDATE_MARK_CACHE = 'sl-app-update';
export const UPDATE_MARK_URL = '/sl_app/__worker-waits-for-the-page';

/** True once a worker that waits for the page's message has been activated here. */
export async function pagesAskForUpdates(caches) {
  try {
    const cache = await caches.open(UPDATE_MARK_CACHE);
    return Boolean(await cache.match(UPDATE_MARK_URL));
  } catch {
    // An unreadable mark is read as no mark: taking over is what the pages of
    // both kinds are ready for (the new ones keep running and offer a reload),
    // waiting is not.
    return false;
  }
}

async function leaveUpdateMark(caches) {
  try {
    const cache = await caches.open(UPDATE_MARK_CACHE);
    await cache.put(UPDATE_MARK_URL, new Response('1'));
  } catch {
    // Without the mark the next worker takes over by itself, once more.
  }
}

/**
 * `install`: wait for a page to ask — unless no page here can.
 * Never an unconditional `skipWaiting()`: that is the reload in the middle of
 * a rest or of a message being typed.
 */
export function handleInstall(scope, event) {
  event.waitUntil(
    pagesAskForUpdates(scope.caches).then((theyDo) => (theyDo ? undefined : scope.skipWaiting())),
  );
}

/**
 * `activate`: leave the mark for the next worker, and take the open pages
 * (a first install controls the page that registered it; an update reaches
 * every window, each of which then reloads when it can).
 */
export function handleActivate(scope, event) {
  event.waitUntil(Promise.all([leaveUpdateMark(scope.caches), scope.clients.claim()]));
}

/** `message`: the page says the worker may take over. Anything else is ignored. */
export function handleMessage(scope, event) {
  if (!event.data || event.data.type !== SKIP_WAITING) return;
  const done = scope.skipWaiting();
  if (typeof event.waitUntil === 'function') event.waitUntil(done);
}
