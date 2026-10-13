import { vi } from 'vitest';

// The browser's side of a service worker, small enough to read: a container
// (navigator.serviceWorker), a registration with its three slots, and workers
// that change state. `fakeBrowser()` returns them with the moves a browser
// makes — a worker is found, installs, waits, takes over — so that a test of
// lib/appUpdate or of UpdatePrompt reads like the sequence it is about.
//
// The moves keep the browser's ORDER, which is what the updater is written
// against. Taking over is two of them, with time in between: `activating`
// (the slots change, the pages hear `controllerchange`) and, once the worker's
// `activate` handlers have run, `activated` — about a second later in
// Chromium, during which the old page is still on the screen and in use.

export class FakeWorker extends EventTarget {
  constructor(state) {
    super();
    this.state = state;
    this.postMessage = vi.fn();
  }

  become(state) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

/**
 * `served: true` (the default) is a page already controlled by an active
 * worker — a returning visitor. `served: false` is a first visit.
 */
export function fakeBrowser({ served = true } = {}) {
  const registration = new EventTarget();
  Object.assign(registration, {
    installing: null,
    waiting: null,
    active: null,
    update: vi.fn(async () => {}),
  });
  const container = new EventTarget();
  Object.assign(container, {
    controller: null,
    register: vi.fn(async () => registration),
  });
  if (served) {
    registration.active = new FakeWorker('activated');
    container.controller = registration.active;
  }

  return {
    registration,
    container,
    /** The server has a new worker: it is found and starts installing. */
    find() {
      const worker = new FakeWorker('installing');
      registration.installing = worker;
      registration.dispatchEvent(new Event('updatefound'));
      return worker;
    },
    /** It has installed and waits behind the active one. */
    installed(worker) {
      registration.installing = null;
      registration.waiting = worker;
      worker.become('installed');
    },
    /** find + installed: a new version is ready. */
    waitingWorker() {
      const worker = this.find();
      this.installed(worker);
      return worker;
    },
    /**
     * It starts to take over: the worker it replaces is gone, it holds the
     * active slot, and every open page is handed to it (`controllerchange`) —
     * while it is still `activating`. Its `activate` handlers have not run.
     */
    activating(worker) {
      const previous = registration.active;
      if (previous && previous !== worker) previous.become('redundant');
      if (registration.waiting === worker) registration.waiting = null;
      if (registration.installing === worker) registration.installing = null;
      registration.active = worker;
      worker.become('activating');
      container.controller = worker;
      container.dispatchEvent(new Event('controllerchange'));
    },
    /** Its `activate` handlers are done: from here on it answers a navigation at once. */
    activated(worker) {
      worker.become('activated');
    },
    /** activating + activated: the whole take-over, with nothing happening in between. */
    takeOver(worker) {
      this.activating(worker);
      this.activated(worker);
    },
  };
}

/** The `storage` argument of createAppUpdater, in memory. */
export function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: (key) => (values.has(key) ? values.get(key) : null),
    set: (key, value) => {
      values.set(key, value);
      return true;
    },
  };
}
