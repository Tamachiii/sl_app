import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { SKIP_WAITING } from './lib/swHandlers';

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
vi.mock('workbox-strategies', () => ({
  CacheFirst: class {},
  StaleWhileRevalidate: class {},
}));
vi.mock('workbox-expiration', () => ({ ExpirationPlugin: class {} }));
vi.mock('workbox-cacheable-response', () => ({ CacheableResponsePlugin: class {} }));

const handlers = {};
const marks = new Map();
let addEventListener;

function extendable(data) {
  const waits = [];
  return { data, waitUntil: (p) => waits.push(p), done: () => Promise.all(waits) };
}

async function dispatch(type, data) {
  const e = extendable(data);
  for (const handler of handlers[type] ?? []) handler(e);
  await e.done();
}

beforeAll(async () => {
  addEventListener = vi.spyOn(self, 'addEventListener').mockImplementation((type, handler) => {
    (handlers[type] ??= []).push(handler);
  });
  self.skipWaiting = vi.fn(async () => {});
  self.clients = { claim: vi.fn(async () => {}) };
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
