import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { REST_TIMER_TAG, SKIP_WAITING } from './lib/swHandlers';

// src/sw.js itself, loaded the way the browser loads it: once, top to bottom.
// Workbox is replaced by nothing — the precache is not what is tested here —
// and the worker's global scope is the jsdom window, with the few members a
// worker has and a window has not.

vi.mock('workbox-precaching', () => ({
  precacheAndRoute: vi.fn(),
  cleanupOutdatedCaches: vi.fn(),
  createHandlerBoundToURL: vi.fn(() => () => {}),
}));
vi.mock('workbox-routing', () => ({
  registerRoute: vi.fn(),
  NavigationRoute: class {},
}));

const handlers = {};
const marks = new Map();
let addEventListener;

function extendable(data, more = {}) {
  const waits = [];
  return { data, ...more, waitUntil: (p) => waits.push(p), done: () => Promise.all(waits) };
}

async function dispatch(type, data, more) {
  const e = extendable(data, more);
  for (const handler of handlers[type] ?? []) handler(e);
  await e.done();
}

// `event.data` of a push that carries JSON.
const pushed = (payload) => ({ json: () => payload, text: () => JSON.stringify(payload) });

beforeAll(async () => {
  addEventListener = vi.spyOn(self, 'addEventListener').mockImplementation((type, handler) => {
    (handlers[type] ??= []).push(handler);
  });
  self.skipWaiting = vi.fn(async () => {});
  self.clients = {
    claim: vi.fn(async () => {}),
    matchAll: vi.fn(async () => []),
    openWindow: vi.fn(async () => null),
  };
  self.registration = {
    scope: 'https://example.test/sl_app/',
    showNotification: vi.fn(async () => {}),
    getNotifications: vi.fn(async () => []),
  };
  self.caches = {
    open: async () => ({
      match: async (url) => marks.get(url),
      put: async (url, response) => {
        marks.set(url, response);
      },
    }),
  };
  await import('./sw.js');
});

afterAll(() => {
  addEventListener.mockRestore();
  delete self.skipWaiting;
  delete self.clients;
  delete self.registration;
  delete self.caches;
});

describe('src/sw.js — when a new worker takes over', () => {
  it('listens to install, activate and message, once each', () => {
    expect(handlers.install).toHaveLength(1);
    expect(handlers.activate).toHaveLength(1);
    expect(handlers.message).toHaveLength(1);
  });

  it('installs without taking over once a worker of this kind has been active', async () => {
    await dispatch('activate');
    expect(self.clients.claim).toHaveBeenCalledTimes(1);

    self.skipWaiting.mockClear();
    await dispatch('install');
    expect(self.skipWaiting).not.toHaveBeenCalled();
  });

  it('takes over when a page sends the message, and not for another one', async () => {
    self.skipWaiting.mockClear();
    await dispatch('message', { type: 'HELLO' });
    expect(self.skipWaiting).not.toHaveBeenCalled();

    await dispatch('message', { type: SKIP_WAITING });
    expect(self.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('keeps its other listeners', () => {
    expect(handlers.push).toHaveLength(1);
    expect(handlers.notificationclick).toHaveLength(1);
    expect(handlers.pushsubscriptionchange).toHaveLength(1);
  });
});

describe('src/sw.js — a push, and a tap on its notification', () => {
  const REST_DONE = {
    title: 'Rest done',
    body: 'Time for your next set.',
    tag: REST_TIMER_TAG,
    data: { url: '/sl_app/#/student/session/s1' },
  };

  it('shows a push', async () => {
    self.registration.showNotification.mockClear();
    await dispatch('push', pushed({ title: 'Feedback from Coach', tag: 'feedback-s1' }));

    expect(self.registration.showNotification).toHaveBeenCalledTimes(1);
    expect(self.registration.showNotification).toHaveBeenCalledWith(
      'Feedback from Coach',
      expect.objectContaining({ tag: 'feedback-s1', renotify: true }),
    );
  });

  // The one push somebody could be tempted to drop. A push that shows nothing
  // costs the device its subscription.
  it('shows "Rest done" with the app in front too — quietly, and takes it away afterwards', async () => {
    const session = {
      url: 'https://example.test/sl_app/#/student/session/s1',
      focused: true,
      visibilityState: 'visible',
    };
    const shown = { close: vi.fn() };
    self.clients.matchAll.mockResolvedValueOnce([session]);
    self.registration.getNotifications.mockResolvedValueOnce([shown]);
    self.registration.showNotification.mockClear();

    vi.useFakeTimers();
    try {
      const over = dispatch('push', pushed(REST_DONE));
      await vi.runAllTimersAsync();
      await over;
    } finally {
      vi.useRealTimers();
    }

    expect(self.registration.showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = self.registration.showNotification.mock.calls[0];
    expect(title).toBe('Rest done');
    expect(options).toMatchObject({ tag: REST_TIMER_TAG, silent: true });
    expect('vibrate' in options).toBe(false);
    expect(self.registration.getNotifications).toHaveBeenCalledWith({ tag: REST_TIMER_TAG });
    expect(shown.close).toHaveBeenCalledTimes(1);
  });

  it('a tap focuses the window that is on the page, without moving it', async () => {
    const session = {
      url: 'https://example.test/sl_app/#/student/session/s1',
      focus: vi.fn(async () => session),
      navigate: vi.fn(async () => session),
    };
    self.clients.matchAll.mockResolvedValueOnce([session]);
    self.clients.openWindow.mockClear();
    const notification = { tag: REST_TIMER_TAG, data: REST_DONE.data, close: vi.fn() };

    await dispatch('notificationclick', undefined, { notification });

    expect(notification.close).toHaveBeenCalledTimes(1);
    expect(session.focus).toHaveBeenCalledTimes(1);
    expect(session.navigate).not.toHaveBeenCalled();
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });

  it('a tap opens the app on the page when no window is open', async () => {
    self.clients.openWindow.mockClear();
    const notification = { tag: 'feedback-s1', data: { url: '/sl_app/#/student/session/s1' }, close: vi.fn() };

    await dispatch('notificationclick', undefined, { notification });

    expect(self.clients.openWindow).toHaveBeenCalledTimes(1);
    expect(self.clients.openWindow).toHaveBeenCalledWith('https://example.test/sl_app/#/student/session/s1');
  });
});
