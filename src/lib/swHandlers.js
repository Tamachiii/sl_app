// What the service worker does when something happens to it — the steps of its
// own life (install, activate, a message from a page), a push that arrives, a
// notification that is tapped — written as functions of the worker's scope so
// that vitest can run them. src/sw.js only wires them to the events.
//
// The first half is the update flow. The rule it holds: A NEW WORKER TAKES OVER
// WHEN A PAGE ASKS FOR IT. It installs next to the one that is serving the app,
// waits, and is activated by the message below, which a page sends once nothing
// would be lost by the reload that follows (src/lib/appUpdate.js,
// components/ui/UpdatePrompt).
//
// The second half is the notifications. The rule it holds: EVERY PUSH SHOWS A
// NOTIFICATION — see "Notifications" below.

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

// ============================================================
// Notifications: a push that arrives, a notification that is tapped.
//
// A payload is what the server sends, forwarded as it is by the Edge Functions
// (send-push, dispatch-rest-push):
//
//   { title, body, tag?, data?: { url? } }
//
// `tag` makes a second push for the same thing replace the first instead of
// stacking. `data.url` is where a tap leads: a path of the app, with the route
// in the hash ("/sl_app/#/student/session/<id>").
//
// EVERY PUSH SHOWS A NOTIFICATION. A push whose handler shows nothing is a
// silent push, which a subscription made with `userVisibleOnly` does not allow:
// WebKit counts them and takes the subscription away, and the device then gets
// no notification at all until its owner turns them on again. So nothing below
// returns before `showNotification`, nothing is awaited before it without a
// bound, and the one notification nobody wants — "Rest done" while the athlete
// is looking at the countdown, which beeps by itself — is shown quietly and
// taken away a few seconds later. It is never skipped.
// ============================================================

/** The tag of the "Rest done" push (hooks/useRestTimerPush writes it into the payload). */
export const REST_TIMER_TAG = 'rest-timer';

/** How long a "Rest done" shown while the app is in front stays before the worker closes it. */
export const FOCUSED_REST_CLOSE_MS = 4000;

/**
 * How long the worker waits to learn whether the app is in front. Without an
 * answer by then the push is shown the usual way: late is better than never.
 */
export const IN_FRONT_ANSWER_MS = 1000;

const APP_NAME = 'SL Coach';
const DEFAULT_TAG = 'sl-coach';
const ICON = '/sl_app/icon-192.png';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `promise`, or `fallback` when it has not answered after `ms`. The timer is
 * cleared either way. For the worker and for a page (lib/restNotifications).
 */
export function within(ms, promise, fallback) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * What a push carries, as an object: its JSON, or its text as the body. Never
 * throws — a payload that cannot be read is still a push that must be shown.
 */
export function readPushPayload(message) {
  if (!message) return {};
  try {
    const payload = message.json();
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload;
    return { body: payload == null ? '' : String(payload) };
  } catch {
    // Not JSON: the text is the body.
  }
  try {
    return { body: message.text() };
  } catch {
    return {};
  }
}

/**
 * The notification of a payload: `{ title, options }` for `showNotification`.
 * `quiet` is the same notification without sound or vibration. `silent` and
 * `vibrate` cannot go together — `showNotification` throws a TypeError, and a
 * push that throws has shown nothing — so the quiet one has no `vibrate` key
 * at all.
 */
export function notificationFor(payload, { quiet = false } = {}) {
  const options = {
    body: payload.body || '',
    icon: ICON,
    badge: ICON,
    // Never empty: `renotify` without a tag is a TypeError too.
    tag: payload.tag || DEFAULT_TAG,
    data: payload.data || {},
  };
  if (quiet) {
    options.silent = true;
    options.renotify = false;
  } else {
    // A backup for the browsers that honour it from a worker.
    options.vibrate = [200, 100, 200];
    options.renotify = true;
  }
  return { title: payload.title || APP_NAME, options };
}

// The open windows of THIS app. `includeUncontrolled` is needed for a window
// that was opened before a worker controlled it, and lists every window of the
// origin with it — an origin (<account>.github.io) the app shares with whatever
// else its owner publishes there. The scope of the registration tells them apart.
async function appWindows(scope) {
  const all = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const base = scope.registration.scope;
  return all.filter((client) => typeof client.url === 'string' && client.url.startsWith(base));
}

/** Is a window of the app in front of its user right now? "Cannot tell" counts as no. */
export async function appIsInFront(scope) {
  try {
    const windows = await appWindows(scope);
    return windows.some((client) => client.focused === true && client.visibilityState !== 'hidden');
  } catch {
    return false;
  }
}

/**
 * Close the notifications of the app that carry `tag`. For the worker and for
 * a page alike: both hold a registration (lib/restNotifications is the page).
 * Never throws; answers how many it closed.
 */
export async function closeNotifications(registration, tag) {
  try {
    const shown = await registration.getNotifications({ tag });
    shown.forEach((notification) => notification.close());
    return shown.length;
  } catch {
    return 0;
  }
}

// How many times this worker has asked for a "Rest done" to be shown. A quiet
// one is closed by its tag, a few seconds after it is shown — and the tag is
// also the one of a "Rest done" that took its place in the meantime, which may
// be loud. So a quiet one keeps the number it was shown under, and is closed
// only while no other has been shown since.
let restShows = 0;

async function showPush(scope, message) {
  const payload = readPushPayload(message);
  const loud = notificationFor(payload);
  const isRest = payload.tag === REST_TIMER_TAG;

  // Only "Rest done" asks the question; every other push is shown at once.
  // The page that runs the rest is the one that beeps at its end
  // (hooks/useRestTimerEffects) and the one that takes the push back when it is
  // left (hooks/useRestTimerPush), so the app in front means the athlete has
  // the cue already.
  const quietly = isRest && (await within(IN_FRONT_ANSWER_MS, appIsInFront(scope), false));
  if (!quietly) {
    if (isRest) restShows += 1;
    await scope.registration.showNotification(loud.title, loud.options);
    return;
  }

  const quiet = notificationFor(payload, { quiet: true });
  // Counted when it is asked for, not once it is shown: a close that lands
  // while the next one is being shown would take that one away.
  const mine = ++restShows;
  try {
    await scope.registration.showNotification(quiet.title, quiet.options);
  } catch {
    // A browser that refuses the quiet form still owes this push a notification.
    await scope.registration.showNotification(loud.title, loud.options);
    return;
  }
  // `silent` is a request a browser may ignore; taking the notification away
  // is the part that does not depend on it. One tag, one notification: what is
  // closed is the one shown above — unless another "Rest done" has been shown
  // since. That one replaced it, and is its own push's to close (a quiet one,
  // FOCUSED_REST_CLOSE_MS after it was shown) or to leave (a loud one: the app
  // went out of sight in between).
  await wait(FOCUSED_REST_CLOSE_MS);
  if (mine !== restShows) return;
  await closeNotifications(scope.registration, REST_TIMER_TAG);
}

/**
 * `push`: show it. Always — quietly, and then closed, for a "Rest done" that
 * arrives while the app is in front.
 */
export function handlePush(scope, event) {
  event.waitUntil(showPush(scope, event.data));
}

// The router keeps the route in the hash. "#/student/" and "#/student" are one
// route, and so are "#/", "#" and no hash at all.
const routeOf = (url) => url.hash.replace(/^#/, '').replace(/\/+$/, '');

// The server answers "/sl_app/" with "/sl_app/index.html": one document under
// two paths. Only a whole last segment counts — "/sl_app/myindex.html" is a
// file of its own.
const documentOf = (url) => url.pathname.replace(/\/index\.html$/, '/');

/**
 * Do two addresses show the same page of the app? `clientUrl` is what a window
 * reports — absolute — and `target` what a payload carries — a path. Both are
 * read against `base`, the scope of the registration: compared as text they
 * never match, and every tap would move the window it finds. A path that ends
 * in `index.html` is its directory.
 */
export function isSameRoute(clientUrl, target, base) {
  try {
    const a = new URL(clientUrl, base);
    const b = new URL(target, base);
    return a.origin === b.origin && documentOf(a) === documentOf(b) && routeOf(a) === routeOf(b);
  } catch {
    return false;
  }
}

// The session page, "/student/session/<id>": where the athlete trains, and
// rests between two sets.
const isSessionRoute = (url, base) => {
  try {
    return /^\/student\/session\/[^/?]+/.test(routeOf(new URL(url, base)));
  } catch {
    return false;
  }
};

/**
 * Where a tap on `notification` leads, as an absolute address of the app — or
 * null when its payload names none (no `data.url`, one that cannot be read, an
 * address outside the app).
 */
export function targetOf(notification, base) {
  const url = notification && notification.data && notification.data.url;
  if (typeof url !== 'string' || url === '') return null;
  try {
    const target = new URL(url, base).href;
    return target.startsWith(base) ? target : null;
  } catch {
    return null;
  }
}

async function bringAppToFront(scope, target, tag) {
  const base = scope.registration.scope;
  const isThere = (client) => target !== null && isSameRoute(client.url, target, base);
  // A "Rest done" never takes the athlete out of a session to a page that is
  // not one. The app deployed before wave 3 (and every row it scheduled) gives
  // the push the training list as its address: a window on a session is where
  // that rest is being taken, and the list is not where it leads. A "Rest
  // done" that names a session (hooks/useRestTimerPush) is read as it is.
  const keepsSession = tag === REST_TIMER_TAG && target !== null && !isSessionRoute(target, base);
  const staysPut = (client) => keepsSession && isSessionRoute(client.url, base);
  const rank = (client) => (isThere(client) ? 0 : staysPut(client) ? 1 : 2);

  let windows = [];
  try {
    windows = await appWindows(scope);
  } catch {
    // As if none were open.
  }

  // A window that already shows the page comes first: it needs the focus and
  // nothing else. Sending it to the address it is at would load the page again
  // under its user — for a "Rest done", the session in progress. Then a window
  // that a "Rest done" leaves where it is, then the others. The sort is stable:
  // within a rank, the order of `matchAll`.
  const inOrder = [...windows].sort((a, b) => rank(a) - rank(b));
  for (const client of inOrder) {
    try {
      await client.focus();
    } catch {
      continue; // This one cannot be focused: the next.
    }
    if (rank(client) === 2 && target !== null && typeof client.navigate === 'function') {
      try {
        await client.navigate(target);
      } catch {
        // The focus is the part that is guaranteed.
      }
    }
    return;
  }

  if (typeof scope.clients.openWindow !== 'function') return;
  try {
    await scope.clients.openWindow(target ?? base);
  } catch {
    // Nothing more a worker can do.
  }
}

/**
 * `notificationclick`: the app comes to the front, on the page the payload
 * names. A window that is on that page already is focused and left as it is,
 * another one is focused and sent there, and a window is opened when there is
 * none. A payload without an address focuses a window and moves nothing. A
 * "Rest done" whose address is not a session leaves a window on a session
 * where it is.
 */
export function handleNotificationClick(scope, event) {
  const { notification } = event;
  notification.close();
  event.waitUntil(
    Promise.all([
      // Started first: a worker may focus or open a window only for a short
      // while after the tap, and nothing that is not needed is awaited before.
      bringAppToFront(scope, targetOf(notification, scope.registration.scope), notification.tag),
      // The app is being opened: a "Rest done" left on the lock screen has
      // nothing more to say, whichever notification was tapped.
      closeNotifications(scope.registration, REST_TIMER_TAG),
    ]),
  );
}
