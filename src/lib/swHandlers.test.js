// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import {
  SKIP_WAITING,
  UPDATE_MARK_CACHE,
  UPDATE_MARK_URL,
  handleActivate,
  handleInstall,
  handleMessage,
  pagesAskForUpdates,
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
