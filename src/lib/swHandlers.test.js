// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FOCUSED_REST_CLOSE_MS,
  IN_FRONT_ANSWER_MS,
  REST_TIMER_TAG,
  SKIP_WAITING,
  UPDATE_MARK_CACHE,
  UPDATE_MARK_URL,
  appIsInFront,
  closeNotifications,
  handleActivate,
  handleInstall,
  handleMessage,
  handleNotificationClick,
  handlePush,
  isSameRoute,
  notificationFor,
  pagesAskForUpdates,
  readPushPayload,
  targetOf,
} from './swHandlers';

// The Cache Storage of one device: it outlives the workers, which is the point
// of the mark.
function deviceCaches() {
  const stores = new Map();
  return {
    stores,
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        match: async (url) => entries.get(url),
        put: async (url, response) => {
          entries.set(url, response);
        },
      };
    },
  };
}

function worker(caches = deviceCaches()) {
  return {
    caches,
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}) },
  };
}

// An ExtendableEvent: `done()` is what the browser waits for.
function event(data) {
  const waits = [];
  return {
    data,
    waitUntil: (promise) => waits.push(promise),
    done: () => Promise.all(waits),
  };
}

async function fire(handler, scope, data) {
  const e = event(data);
  handler(scope, e);
  await e.done();
}

describe('install — a new worker waits for the page', () => {
  it('does not take over when a worker that waits was active here before', async () => {
    const caches = deviceCaches();
    await fire(handleActivate, worker(caches));

    const next = worker(caches);
    await fire(handleInstall, next);

    expect(next.skipWaiting).not.toHaveBeenCalled();
  });

  it('takes over at once on a device whose pages cannot ask (the app published before this worker)', async () => {
    const first = worker();
    await fire(handleInstall, first);
    expect(first.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('reads a Cache Storage it cannot open as "no mark"', async () => {
    const broken = worker({
      open: async () => {
        throw new Error('QuotaExceededError');
      },
    });
    await fire(handleInstall, broken);
    expect(broken.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('keeps the browser waiting for the answer (the decision is inside waitUntil)', async () => {
    const first = worker();
    const e = event();
    handleInstall(first, e);
    // Nothing decided synchronously: the mark is read first.
    expect(first.skipWaiting).not.toHaveBeenCalled();
    await e.done();
    expect(first.skipWaiting).toHaveBeenCalledTimes(1);
  });
});

describe('activate — the mark, and the open pages', () => {
  it('leaves the mark in a cache of its own and claims the clients', async () => {
    const scope = worker();
    expect(await pagesAskForUpdates(scope.caches)).toBe(false);

    await fire(handleActivate, scope);

    expect(scope.clients.claim).toHaveBeenCalledTimes(1);
    expect(await pagesAskForUpdates(scope.caches)).toBe(true);
    expect([...scope.caches.stores.keys()]).toEqual([UPDATE_MARK_CACHE]);
    expect(scope.caches.stores.get(UPDATE_MARK_CACHE).has(UPDATE_MARK_URL)).toBe(true);
  });

  it('is not a workbox precache name, which the clean-up of old caches deletes', () => {
    expect(UPDATE_MARK_CACHE).not.toContain('-precache-');
  });

  it('still claims the clients when the mark cannot be written', async () => {
    const scope = worker({
      open: async () => {
        throw new Error('QuotaExceededError');
      },
    });
    await expect(fire(handleActivate, scope)).resolves.toBeUndefined();
    expect(scope.clients.claim).toHaveBeenCalledTimes(1);
  });
});

describe('message — the page says when', () => {
  it('takes over on { type: SKIP_WAITING } and holds the event until it has', async () => {
    const scope = worker();
    const e = event({ type: SKIP_WAITING });
    handleMessage(scope, e);
    expect(scope.skipWaiting).toHaveBeenCalledTimes(1);
    await expect(e.done()).resolves.toHaveLength(1);
  });

  it('is the message workbox and the deployed pages know by that name', () => {
    expect(SKIP_WAITING).toBe('SKIP_WAITING');
  });

  it.each([
    ['no data', undefined],
    ['null', null],
    ['a string', 'SKIP_WAITING'],
    ['another type', { type: 'PING' }],
    ['no type', { skipWaiting: true }],
  ])('ignores %s', (_name, data) => {
    const scope = worker();
    handleMessage(scope, event(data));
    expect(scope.skipWaiting).not.toHaveBeenCalled();
  });

  it('works on an event without waitUntil', () => {
    const scope = worker();
    expect(() => handleMessage(scope, { data: { type: SKIP_WAITING } })).not.toThrow();
    expect(scope.skipWaiting).toHaveBeenCalledTimes(1);
  });
});

describe('three workers on one device', () => {
  it('the first takes over by itself, the next ones wait to be asked', async () => {
    const caches = deviceCaches();

    // 1. The worker of this package arrives on a device that runs the app
    //    published before it: nobody will send a message.
    const first = worker(caches);
    await fire(handleInstall, first);
    expect(first.skipWaiting).toHaveBeenCalledTimes(1);
    await fire(handleActivate, first);

    // 2. The next deploy: the pages now come from `first` and can ask.
    const second = worker(caches);
    await fire(handleInstall, second);
    expect(second.skipWaiting).not.toHaveBeenCalled();
    await fire(handleMessage, second, { type: SKIP_WAITING });
    expect(second.skipWaiting).toHaveBeenCalledTimes(1);
    await fire(handleActivate, second);

    // 3. And the one after.
    const third = worker(caches);
    await fire(handleInstall, third);
    expect(third.skipWaiting).not.toHaveBeenCalled();
  });
});

// ============================================================
// Notifications
// ============================================================

const SCOPE = 'https://example.test/sl_app/';

// The shape of what hooks/useRestTimerPush writes (`restPushPayload`, in
// English, for a set of session s1). That the worker knows the payload the
// hook really writes is held by hooks/useRestTimerPush.test.jsx, which runs it
// through these handlers.
const REST_DONE = {
  title: 'Rest done',
  body: 'Time for your next set.',
  tag: 'rest-timer',
  data: { url: '/sl_app/#/student/session/s1' },
};

// What `notify_student_on_session_feedback` sends through send-push.
const FEEDBACK = {
  title: 'Feedback from Coach',
  body: 'Good depth on the last set.',
  tag: 'feedback-s1',
  data: { url: '/sl_app/#/student/session/s1' },
};

// The notifications of one device: one per tag, as on the device, and the two
// TypeErrors `showNotification` has for options that cannot go together. A
// push whose handler ends on one of them has shown nothing.
function notificationCentre() {
  const shown = [];
  const remove = (notification) => {
    const at = shown.indexOf(notification);
    if (at !== -1) shown.splice(at, 1);
  };
  return {
    shown,
    showNotification: vi.fn(async (title, options = {}) => {
      if (options.silent === true && 'vibrate' in options) {
        throw new TypeError('silent must not be set together with vibrate');
      }
      if (options.renotify === true && !options.tag) {
        throw new TypeError('renotify needs a tag');
      }
      const replaced = shown.find((n) => n.tag === options.tag);
      if (replaced) remove(replaced);
      const notification = { title, ...options };
      notification.close = vi.fn(() => remove(notification));
      shown.push(notification);
    }),
    getNotifications: vi.fn(async ({ tag } = {}) =>
      shown.filter((n) => tag === undefined || n.tag === tag),
    ),
  };
}

// A window of the app, as `clients.matchAll` lists it.
function appWindow(route, { focused = false, visibilityState = focused ? 'visible' : 'hidden', url } = {}) {
  const client = {
    url: url ?? `${SCOPE}#${route}`,
    focused,
    visibilityState,
    focus: vi.fn(async () => client),
    navigate: vi.fn(async (to) => {
      client.url = to;
      return client;
    }),
  };
  return client;
}

const inFront = (route) => appWindow(route, { focused: true });

// The worker's scope, as far as notifications go.
function notifier({ windows = [], centre = notificationCentre() } = {}) {
  return {
    centre,
    registration: {
      scope: SCOPE,
      showNotification: centre.showNotification,
      getNotifications: centre.getNotifications,
    },
    clients: {
      matchAll: vi.fn(async () => windows),
      openWindow: vi.fn(async () => null),
    },
  };
}

// `event.data` of a push: JSON, or text that is not.
function message(payload) {
  if (typeof payload === 'string') {
    return { json: () => JSON.parse(payload), text: () => payload };
  }
  return { json: () => payload, text: () => JSON.stringify(payload) };
}

const push = (scope, payload) => fire(handlePush, scope, payload === undefined ? null : message(payload));

describe('push — every push shows a notification', () => {
  it('shows the payload as it is, with a vibration', async () => {
    const scope = notifier();
    await push(scope, FEEDBACK);

    expect(scope.centre.showNotification).toHaveBeenCalledTimes(1);
    expect(scope.centre.showNotification).toHaveBeenCalledWith('Feedback from Coach', {
      body: 'Good depth on the last set.',
      icon: '/sl_app/icon-192.png',
      badge: '/sl_app/icon-192.png',
      tag: 'feedback-s1',
      data: { url: '/sl_app/#/student/session/s1' },
      vibrate: [200, 100, 200],
      renotify: true,
    });
  });

  it('text that is not JSON becomes the body, under the name of the app', async () => {
    const scope = notifier();
    await push(scope, 'Your coach wrote to you');

    expect(scope.centre.shown).toHaveLength(1);
    expect(scope.centre.shown[0]).toMatchObject({
      title: 'SL Coach',
      body: 'Your coach wrote to you',
      tag: 'sl-coach',
      data: {},
    });
  });

  it('a push without a payload is shown too', async () => {
    const scope = notifier();
    await push(scope);
    expect(scope.centre.shown).toHaveLength(1);
    expect(scope.centre.shown[0]).toMatchObject({ title: 'SL Coach', body: '', tag: 'sl-coach' });
  });

  it('a payload without a tag gets one — `renotify` is refused without', async () => {
    const scope = notifier();
    await push(scope, { title: 'Program updated' });
    expect(scope.centre.shown).toHaveLength(1);
    expect(scope.centre.shown[0]).toMatchObject({ title: 'Program updated', tag: 'sl-coach', renotify: true });
  });

  it.each([
    ['null', null],
    ['a string', 'hello'],
    ['a number', 42],
    ['a list', [1, 2]],
  ])('JSON that is not an object (%s) is shown, and does not throw', async (_name, json) => {
    const scope = notifier();
    await fire(handlePush, scope, { json: () => json, text: () => JSON.stringify(json) });
    expect(scope.centre.shown).toHaveLength(1);
    expect(scope.centre.shown[0].title).toBe('SL Coach');
  });

  it('a payload that cannot be read at all is shown too', async () => {
    const scope = notifier();
    const unreadable = {
      json: () => {
        throw new SyntaxError('Unexpected token');
      },
      text: () => {
        throw new Error('no text');
      },
    };
    await fire(handlePush, scope, unreadable);
    expect(scope.centre.shown).toHaveLength(1);
  });

  it('does not ask where the app is for a push that is not "Rest done" — and shows it as usual in front of it', async () => {
    const scope = notifier({ windows: [inFront('/student/session/s1')] });
    await push(scope, FEEDBACK);

    expect(scope.clients.matchAll).not.toHaveBeenCalled();
    expect(scope.centre.shown[0]).toMatchObject({ tag: 'feedback-s1', renotify: true, vibrate: [200, 100, 200] });
    expect(scope.centre.shown[0].silent).toBeUndefined();
  });
});

describe('push — "Rest done" while the athlete is looking at the app', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Fire the push and let the worker get as far as it can without time passing.
  async function arrive(scope, payload = REST_DONE) {
    const e = event(message(payload));
    handlePush(scope, e);
    await vi.advanceTimersByTimeAsync(0);
    return e;
  }

  it('is still shown: quietly, without a vibration, and with everything else of the payload', async () => {
    const scope = notifier({ windows: [inFront('/student/session/s1')] });
    await arrive(scope);

    expect(scope.centre.showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = scope.centre.showNotification.mock.calls[0];
    expect(title).toBe('Rest done');
    expect(options).toEqual({
      body: 'Time for your next set.',
      icon: '/sl_app/icon-192.png',
      badge: '/sl_app/icon-192.png',
      tag: REST_TIMER_TAG,
      data: { url: '/sl_app/#/student/session/s1' },
      silent: true,
      renotify: false,
    });
    // `silent` with `vibrate` is a TypeError: the key must not be there at all.
    expect('vibrate' in options).toBe(false);
    expect(scope.centre.shown).toHaveLength(1);
  });

  it('is closed by the worker after FOCUSED_REST_CLOSE_MS, not before, and the event lasts until then', async () => {
    const scope = notifier({ windows: [inFront('/student/session/s1')] });
    const e = await arrive(scope);
    let over = false;
    e.done().then(() => {
      over = true;
    });

    await vi.advanceTimersByTimeAsync(FOCUSED_REST_CLOSE_MS - 1);
    expect(scope.centre.shown).toHaveLength(1);
    expect(over).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(scope.centre.shown).toHaveLength(0);
    expect(scope.centre.getNotifications).toHaveBeenCalledWith({ tag: REST_TIMER_TAG });
    expect(over).toBe(true);
  });

  it('leaves the other notifications of the device alone', async () => {
    const scope = notifier({ windows: [inFront('/student/session/s1')] });
    await push(scope, FEEDBACK);
    await arrive(scope);
    await vi.advanceTimersByTimeAsync(FOCUSED_REST_CLOSE_MS);

    expect(scope.centre.shown.map((n) => n.tag)).toEqual(['feedback-s1']);
  });

  it.each([
    ['no window of the app is open', () => []],
    ['the app is in the background', () => [appWindow('/student/session/s1')]],
    [
      'its window is visible but another one has the focus',
      () => [appWindow('/student/session/s1', { focused: false, visibilityState: 'visible' })],
    ],
    [
      'its window is said to have the focus while hidden',
      () => [appWindow('/student/session/s1', { focused: true, visibilityState: 'hidden' })],
    ],
    [
      'the window in front is another site of the same origin',
      () => [appWindow(null, { focused: true, url: 'https://example.test/blog/' })],
    ],
  ])('is shown as usual when %s — and never closed by the worker', async (_name, windows) => {
    const scope = notifier({ windows: windows() });
    const e = await arrive(scope);

    expect(scope.centre.shown).toHaveLength(1);
    expect(scope.centre.shown[0]).toMatchObject({ tag: REST_TIMER_TAG, renotify: true, vibrate: [200, 100, 200] });
    expect(scope.centre.shown[0].silent).toBeUndefined();
    await e.done(); // nothing left to wait for

    await vi.advanceTimersByTimeAsync(FOCUSED_REST_CLOSE_MS * 10);
    expect(scope.centre.shown).toHaveLength(1);
    expect(scope.centre.getNotifications).not.toHaveBeenCalled();
  });

  it('a browser that refuses the quiet form gets the usual one, which stays', async () => {
    const scope = notifier({ windows: [inFront('/student/session/s1')] });
    const real = scope.centre.showNotification.getMockImplementation();
    scope.centre.showNotification.mockImplementation(async (title, options) => {
      if (options.silent) throw new TypeError('silent is not supported');
      return real(title, options);
    });

    const e = await arrive(scope);
    await e.done();

    expect(scope.centre.shown).toHaveLength(1);
    expect(scope.centre.shown[0]).toMatchObject({ title: 'Rest done', renotify: true, vibrate: [200, 100, 200] });
    await vi.advanceTimersByTimeAsync(FOCUSED_REST_CLOSE_MS * 10);
    expect(scope.centre.shown).toHaveLength(1);
  });

  it('a worker that cannot list its windows shows the push as usual', async () => {
    const scope = notifier();
    scope.clients.matchAll.mockRejectedValue(new Error('InvalidStateError'));
    const e = await arrive(scope);
    await e.done();
    expect(scope.centre.shown).toHaveLength(1);
    expect(scope.centre.shown[0].silent).toBeUndefined();
  });

  it('a worker that gets no answer about its windows shows the push as usual after IN_FRONT_ANSWER_MS', async () => {
    const scope = notifier();
    scope.clients.matchAll.mockReturnValue(new Promise(() => {}));
    const e = await arrive(scope);
    expect(scope.centre.shown).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(IN_FRONT_ANSWER_MS);
    await e.done();
    expect(scope.centre.shown).toHaveLength(1);
    expect(scope.centre.shown[0]).toMatchObject({ tag: REST_TIMER_TAG, renotify: true });
  });

  it('notifications that cannot be listed do not fail the push', async () => {
    const scope = notifier({ windows: [inFront('/student/session/s1')] });
    scope.centre.getNotifications.mockRejectedValue(new Error('NotAllowedError'));
    const e = await arrive(scope);
    await vi.advanceTimersByTimeAsync(FOCUSED_REST_CLOSE_MS);

    await expect(e.done()).resolves.toHaveLength(1);
    expect(scope.centre.showNotification).toHaveBeenCalledTimes(1);
  });

  it('shows a second "Rest done" in place of the first', async () => {
    const scope = notifier();
    await arrive(scope);
    await arrive(scope);
    expect(scope.centre.shown).toHaveLength(1);
  });
});

describe('the notification of a payload', () => {
  it('the quiet form never carries `vibrate`, whatever the payload', () => {
    for (const payload of [REST_DONE, FEEDBACK, {}, { vibrate: [1], silent: false }]) {
      const { options } = notificationFor(payload, { quiet: true });
      expect(options.silent).toBe(true);
      expect(options.renotify).toBe(false);
      expect('vibrate' in options).toBe(false);
    }
  });

  it('the usual form is never silent and always has a tag', () => {
    for (const payload of [REST_DONE, FEEDBACK, {}, { tag: '' }]) {
      const { options } = notificationFor(payload);
      expect('silent' in options).toBe(false);
      expect(options.renotify).toBe(true);
      expect(options.tag).not.toBe('');
    }
  });

  it('reads a payload without throwing', () => {
    expect(readPushPayload(null)).toEqual({});
    expect(readPushPayload(message(REST_DONE))).toEqual(REST_DONE);
    expect(readPushPayload(message('plain text'))).toEqual({ body: 'plain text' });
  });

  it('the tag stays "rest-timer": the client deployed before wave 3 and the rows it scheduled carry it as text', () => {
    // Not REST_DONE.tag, which is a copy typed in this file: the hook's own
    // payload is checked against the worker in hooks/useRestTimerPush.test.jsx.
    // This value cannot follow a rename — main@2bb6495 writes the literal
    // 'rest-timer', and `scheduled_pushes` holds payloads written by it.
    expect(REST_TIMER_TAG).toBe('rest-timer');
  });
});

describe('is the app in front?', () => {
  it.each([
    ['a focused, visible window of the app', [inFront('/student')], true],
    ['a focused window whose visibility is not reported', [appWindow('/student', { focused: true, visibilityState: undefined })], true],
    ['a second window that has the focus', [appWindow('/student'), inFront('/student/messages')], true],
    ['no window', [], false],
    ['a window in the background', [appWindow('/student')], false],
    ['a focused window of another site of the origin', [appWindow(null, { focused: true, url: 'https://example.test/sl_app_old/' })], false],
  ])('%s', async (_name, windows, expected) => {
    expect(await appIsInFront(notifier({ windows }))).toBe(expected);
  });
});

describe('two addresses, one page?', () => {
  it.each([
    ['what a window reports and the path of a payload', `${SCOPE}#/student/session/s1`, '/sl_app/#/student/session/s1'],
    ['a trailing slash on the window', `${SCOPE}#/student/`, '/sl_app/#/student'],
    ['a trailing slash in the payload', `${SCOPE}#/student`, '/sl_app/#/student/'],
    ['the root, with and without a hash', SCOPE, '/sl_app/#/'],
    ['the root, with an empty hash', `${SCOPE}#`, '/sl_app/'],
    ['two absolute addresses', `${SCOPE}#/coach/sessions?student=a1`, `${SCOPE}#/coach/sessions?student=a1`],
    ['a query in front of the hash, which the router does not read', `${SCOPE}?source=pwa#/student`, '/sl_app/#/student'],
  ])('yes: %s', (_name, clientUrl, target) => {
    expect(isSameRoute(clientUrl, target, SCOPE)).toBe(true);
  });

  it.each([
    ['the session and the list', `${SCOPE}#/student/session/s1`, '/sl_app/#/student'],
    ['two sessions', `${SCOPE}#/student/session/s1`, '/sl_app/#/student/session/s2'],
    ['a list and the same list filtered', `${SCOPE}#/coach/sessions`, '/sl_app/#/coach/sessions?student=a1'],
    ['the same route of another site of the origin', 'https://example.test/other/#/student', '/sl_app/#/student'],
    ['the same route on another origin', 'https://elsewhere.test/sl_app/#/student', '/sl_app/#/student'],
    ['an address that cannot be read', 'http://', '/sl_app/#/student'],
    ['no address', undefined, '/sl_app/#/student'],
  ])('no: %s', (_name, clientUrl, target) => {
    expect(isSameRoute(clientUrl, target, SCOPE)).toBe(false);
  });
});

describe('where a tap leads', () => {
  it('to the address of the payload, made absolute', () => {
    expect(targetOf({ data: { url: '/sl_app/#/student/session/s1' } }, SCOPE)).toBe(`${SCOPE}#/student/session/s1`);
    expect(targetOf({ data: { url: `${SCOPE}#/coach/messages/c1` } }, SCOPE)).toBe(`${SCOPE}#/coach/messages/c1`);
  });

  it.each([
    ['no data', {}],
    ['data without an address', { data: {} }],
    ['an empty address', { data: { url: '' } }],
    ['an address that is not text', { data: { url: 42 } }],
    ['data that is not an object', { data: 'x' }],
    ['another origin', { data: { url: 'https://elsewhere.test/sl_app/#/student' } }],
    ['another site of the same origin', { data: { url: '/blog/' } }],
    ['an address that cannot be read', { data: { url: 'http://' } }],
  ])('nowhere in particular: %s', (_name, notification) => {
    expect(targetOf(notification, SCOPE)).toBeNull();
  });
});

describe('notificationclick — the app comes to the front', () => {
  // A tap on a notification of `payload`; resolves once the worker is done.
  async function tap(scope, payload = FEEDBACK) {
    const notification = { tag: payload.tag, data: payload.data, close: vi.fn() };
    const e = event();
    e.notification = notification;
    handleNotificationClick(scope, e);
    await e.done();
    return notification;
  }

  const TARGET = `${SCOPE}#/student/session/s1`;

  it('a window that is on the page already is focused and left where it is', async () => {
    const there = appWindow('/student/session/s1');
    const scope = notifier({ windows: [there] });
    await tap(scope);

    expect(scope.clients.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
    expect(there.focus).toHaveBeenCalledTimes(1);
    expect(there.navigate).not.toHaveBeenCalled();
    expect(scope.clients.openWindow).not.toHaveBeenCalled();
  });

  it.each([
    ['the window', '/student/session/s1/', '/sl_app/#/student/session/s1'],
    ['the payload', '/student/session/s1', '/sl_app/#/student/session/s1/'],
  ])('a trailing slash on %s does not make it another page', async (_name, route, url) => {
    const there = appWindow(route);
    const scope = notifier({ windows: [there] });
    await tap(scope, { ...FEEDBACK, data: { url } });

    expect(there.focus).toHaveBeenCalledTimes(1);
    expect(there.navigate).not.toHaveBeenCalled();
  });

  it('a "Rest done" that names the session in progress leaves the athlete in it', async () => {
    const session = inFront('/student/session/s1');
    const scope = notifier({ windows: [session] });
    await tap(scope, REST_DONE);

    expect(session.focus).toHaveBeenCalledTimes(1);
    expect(session.navigate).not.toHaveBeenCalled();
    expect(session.url).toBe(TARGET);
  });

  it('a window on another page is focused and sent to the page', async () => {
    const elsewhere = appWindow('/student');
    const scope = notifier({ windows: [elsewhere] });
    await tap(scope);

    expect(elsewhere.focus).toHaveBeenCalledTimes(1);
    expect(elsewhere.navigate).toHaveBeenCalledTimes(1);
    expect(elsewhere.navigate).toHaveBeenCalledWith(TARGET);
    expect(scope.clients.openWindow).not.toHaveBeenCalled();
  });

  it('of two windows, the one that is on the page is taken, wherever it is in the list', async () => {
    const elsewhere = appWindow('/student');
    const there = appWindow('/student/session/s1');
    const scope = notifier({ windows: [elsewhere, there] });
    await tap(scope);

    expect(there.focus).toHaveBeenCalledTimes(1);
    expect(there.navigate).not.toHaveBeenCalled();
    expect(elsewhere.focus).not.toHaveBeenCalled();
    expect(elsewhere.navigate).not.toHaveBeenCalled();
  });

  it('no window: one is opened on the page', async () => {
    const scope = notifier();
    await tap(scope);
    expect(scope.clients.openWindow).toHaveBeenCalledTimes(1);
    expect(scope.clients.openWindow).toHaveBeenCalledWith(TARGET);
  });

  it('a window of another site of the same origin is not the app: it is left alone and one is opened', async () => {
    const blog = appWindow(null, { focused: true, url: 'https://example.test/blog/' });
    const scope = notifier({ windows: [blog] });
    await tap(scope);

    expect(blog.focus).not.toHaveBeenCalled();
    expect(blog.navigate).not.toHaveBeenCalled();
    expect(scope.clients.openWindow).toHaveBeenCalledWith(TARGET);
  });

  it('a window that cannot be focused: the next one', async () => {
    const stuck = appWindow('/student/session/s1');
    stuck.focus.mockRejectedValue(new Error('InvalidAccessError'));
    const next = appWindow('/student');
    const scope = notifier({ windows: [stuck, next] });
    await tap(scope);

    expect(next.focus).toHaveBeenCalledTimes(1);
    expect(next.navigate).toHaveBeenCalledWith(TARGET);
    expect(scope.clients.openWindow).not.toHaveBeenCalled();
  });

  it('no window can be focused: one is opened', async () => {
    const stuck = appWindow('/student');
    stuck.focus.mockRejectedValue(new Error('InvalidAccessError'));
    const scope = notifier({ windows: [stuck] });
    await tap(scope);

    expect(stuck.navigate).not.toHaveBeenCalled();
    expect(scope.clients.openWindow).toHaveBeenCalledWith(TARGET);
  });

  it('a window that cannot be moved keeps the focus, and the tap does not fail', async () => {
    const elsewhere = appWindow('/student');
    elsewhere.navigate.mockRejectedValue(new TypeError('cannot navigate'));
    const scope = notifier({ windows: [elsewhere] });
    await expect(tap(scope)).resolves.toBeDefined();

    expect(elsewhere.focus).toHaveBeenCalledTimes(1);
    expect(scope.clients.openWindow).not.toHaveBeenCalled();
  });

  it('a window that has no `navigate` is focused', async () => {
    const elsewhere = appWindow('/student');
    delete elsewhere.navigate;
    const scope = notifier({ windows: [elsewhere] });
    await expect(tap(scope)).resolves.toBeDefined();
    expect(elsewhere.focus).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no address', {}],
    ['no data', undefined],
    ['an address outside the app', { url: 'https://elsewhere.test/' }],
  ])('a payload with %s focuses the window and moves nothing', async (_name, data) => {
    const open = appWindow('/student/session/s1');
    const scope = notifier({ windows: [open] });
    await tap(scope, { tag: 'sl-coach', data });

    expect(open.focus).toHaveBeenCalledTimes(1);
    expect(open.navigate).not.toHaveBeenCalled();
    expect(scope.clients.openWindow).not.toHaveBeenCalled();
  });

  it('a payload without an address opens the app itself when no window is open', async () => {
    const scope = notifier();
    await tap(scope, { tag: 'sl-coach', data: {} });
    expect(scope.clients.openWindow).toHaveBeenCalledWith(SCOPE);
  });

  it('a worker that cannot list its windows opens one', async () => {
    const scope = notifier();
    scope.clients.matchAll.mockRejectedValue(new Error('InvalidStateError'));
    await tap(scope);
    expect(scope.clients.openWindow).toHaveBeenCalledWith(TARGET);
  });

  it('a window that cannot be opened does not fail the tap', async () => {
    const scope = notifier();
    scope.clients.openWindow.mockRejectedValue(new Error('InvalidAccessError'));
    await expect(tap(scope)).resolves.toBeDefined();
  });

  it('closes the notification that was tapped, and a "Rest done" that is still shown', async () => {
    const scope = notifier();
    await push(scope, REST_DONE);
    await push(scope, { ...FEEDBACK, tag: 'chat-c1' });
    expect(scope.centre.shown.map((n) => n.tag)).toEqual([REST_TIMER_TAG, 'chat-c1']);

    const tapped = await tap(scope);

    expect(tapped.close).toHaveBeenCalledTimes(1);
    expect(scope.centre.getNotifications).toHaveBeenCalledWith({ tag: REST_TIMER_TAG });
    expect(scope.centre.shown.map((n) => n.tag)).toEqual(['chat-c1']);
  });

  it('does not wait for the notifications before it brings the window to the front', async () => {
    const there = appWindow('/student/session/s1');
    const scope = notifier({ windows: [there] });
    scope.centre.getNotifications.mockReturnValue(new Promise(() => {}));

    const e = event();
    e.notification = { tag: FEEDBACK.tag, data: FEEDBACK.data, close: vi.fn() };
    handleNotificationClick(scope, e);
    // The first thing asked for, in the same turn as the tap.
    expect(scope.clients.matchAll).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(there.focus).toHaveBeenCalledTimes(1));
  });

  it('notifications that cannot be listed do not fail the tap', async () => {
    const there = appWindow('/student/session/s1');
    const scope = notifier({ windows: [there] });
    scope.centre.getNotifications.mockRejectedValue(new Error('NotAllowedError'));
    await expect(tap(scope)).resolves.toBeDefined();
    expect(there.focus).toHaveBeenCalledTimes(1);
  });
});

describe('closing the notifications of a tag', () => {
  it('closes those and answers how many', async () => {
    const centre = notificationCentre();
    await centre.showNotification('Rest done', { tag: REST_TIMER_TAG });
    await centre.showNotification('Message', { tag: 'chat-c1' });

    expect(await closeNotifications(centre, REST_TIMER_TAG)).toBe(1);
    expect(centre.shown.map((n) => n.tag)).toEqual(['chat-c1']);
    expect(await closeNotifications(centre, REST_TIMER_TAG)).toBe(0);
  });

  it.each([
    ['no registration', undefined],
    ['a registration that cannot list them', {}],
    [
      'a registration that refuses',
      {
        getNotifications: async () => {
          throw new Error('NotAllowedError');
        },
      },
    ],
  ])('answers 0 for %s', async (_name, registration) => {
    expect(await closeNotifications(registration, REST_TIMER_TAG)).toBe(0);
  });
});
