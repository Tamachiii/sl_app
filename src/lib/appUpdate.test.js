import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  APPLY_TIMEOUT_MS,
  AUTO_APPLIED_KEY,
  CHECK_EVERY_MS,
  CHECK_MIN_GAP_MS,
  createAppUpdater,
} from './appUpdate';
import { SKIP_WAITING } from './swHandlers';
import { FakeWorker, fakeBrowser, memoryStorage } from '../test/fakeServiceWorker';

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

let visibility;
let online;
const updaters = [];

function setVisibility(value) {
  visibility = value;
  document.dispatchEvent(new Event('visibilitychange'));
}

async function started(world, options = {}) {
  const reload = vi.fn();
  const storage = options.storage ?? memoryStorage();
  const updater = createAppUpdater({
    container: world.container,
    reload,
    storage,
    buildId: options.buildId ?? 'build-1',
  });
  updaters.push(updater);
  await updater.start({ swUrl: '/sl_app/sw.js', scope: '/sl_app/' });
  return { updater, reload, storage };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-13T08:00:00Z'));
  visibility = 'visible';
  online = true;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
});

afterEach(() => {
  while (updaters.length) updaters.pop().stop();
  delete document.visibilityState;
  delete navigator.onLine;
  vi.useRealTimers();
});

describe('registration', () => {
  it('registers the worker of the app once, with its scope', async () => {
    const world = fakeBrowser();
    const { updater } = await started(world);
    await updater.start({ swUrl: '/sl_app/sw.js', scope: '/sl_app/' });

    expect(world.container.register).toHaveBeenCalledTimes(1);
    expect(world.container.register).toHaveBeenCalledWith('/sl_app/sw.js', { scope: '/sl_app/' });
    expect(updater.getState()).toEqual({ pending: false, applying: false, offered: false, failed: false });
  });

  it('does nothing in a browser without service workers', async () => {
    const reload = vi.fn();
    const updater = createAppUpdater({ container: undefined, reload, storage: memoryStorage() });
    await expect(updater.start({ swUrl: '/sl_app/sw.js', scope: '/sl_app/' })).resolves.toBeUndefined();
    expect(updater.apply()).toBe(false);
    expect(updater.getState().pending).toBe(false);
    updater.stop();
  });

  it('survives a registration that is refused, and asks nothing afterwards', async () => {
    const world = fakeBrowser();
    world.container.register = vi.fn(async () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    const { updater, reload } = await started(world);

    vi.advanceTimersByTime(CHECK_EVERY_MS * 2);
    setVisibility('visible');
    world.container.dispatchEvent(new Event('controllerchange'));
    await flush();

    expect(world.registration.update).not.toHaveBeenCalled();
    expect(updater.getState().pending).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('asking the server for a new version', () => {
  it('asks when the app comes back to the foreground', async () => {
    const world = fakeBrowser();
    await started(world);
    expect(world.registration.update).not.toHaveBeenCalled(); // registering asked already

    setVisibility('hidden');
    vi.advanceTimersByTime(CHECK_MIN_GAP_MS);
    expect(world.registration.update).not.toHaveBeenCalled();

    setVisibility('visible');
    await flush();
    expect(world.registration.update).toHaveBeenCalledTimes(1);
  });

  it('does not ask again for a return that follows the last question closely', async () => {
    const world = fakeBrowser();
    await started(world);

    // Three rests of four minutes: the phone is locked and unlocked each time.
    for (let i = 0; i < 3; i += 1) {
      setVisibility('hidden');
      vi.advanceTimersByTime(4 * 60 * 1000);
      setVisibility('visible');
      await flush();
    }
    expect(world.registration.update).not.toHaveBeenCalled();

    setVisibility('hidden');
    vi.advanceTimersByTime(4 * 60 * 1000);
    setVisibility('visible');
    await flush();
    expect(world.registration.update).toHaveBeenCalledTimes(1);
  });

  it('asks once an hour in a tab that never leaves the foreground', async () => {
    const world = fakeBrowser();
    await started(world);

    vi.advanceTimersByTime(CHECK_EVERY_MS - 1);
    await flush();
    expect(world.registration.update).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await flush();
    expect(world.registration.update).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(CHECK_EVERY_MS);
    await flush();
    expect(world.registration.update).toHaveBeenCalledTimes(2);
  });

  it('does not ask while offline, and asks when the connection returns', async () => {
    const world = fakeBrowser();
    await started(world);
    online = false;

    vi.advanceTimersByTime(CHECK_EVERY_MS);
    setVisibility('visible');
    await flush();
    expect(world.registration.update).not.toHaveBeenCalled();

    online = true;
    window.dispatchEvent(new Event('online'));
    await flush();
    expect(world.registration.update).toHaveBeenCalledTimes(1);
  });

  it('lives through a question that fails, and asks again later', async () => {
    const world = fakeBrowser();
    world.registration.update = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(undefined);
    const { updater } = await started(world);

    vi.advanceTimersByTime(CHECK_EVERY_MS);
    await flush();
    expect(updater.getState().pending).toBe(false);

    vi.advanceTimersByTime(CHECK_EVERY_MS);
    await flush();
    expect(world.registration.update).toHaveBeenCalledTimes(2);
  });

  it('asks again at the next return after a question that got no answer, however soon', async () => {
    const world = fakeBrowser();
    world.registration.update = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(undefined);
    await started(world);

    // The hourly question falls into a dead spot of the gym's network.
    vi.advanceTimersByTime(CHECK_EVERY_MS);
    await flush();
    expect(world.registration.update).toHaveBeenCalledTimes(1);

    // One minute later the phone is unlocked again: well inside the gap that
    // holds a question back after one that was ANSWERED.
    setVisibility('hidden');
    vi.advanceTimersByTime(60 * 1000);
    setVisibility('visible');
    await flush();
    expect(world.registration.update).toHaveBeenCalledTimes(2);

    // That one was answered: the gap holds again.
    setVisibility('hidden');
    vi.advanceTimersByTime(60 * 1000);
    setVisibility('visible');
    await flush();
    expect(world.registration.update).toHaveBeenCalledTimes(2);
  });

  it('stops asking once stopped', async () => {
    const world = fakeBrowser();
    const { updater } = await started(world);
    updater.stop();

    vi.advanceTimersByTime(CHECK_EVERY_MS * 3);
    setVisibility('visible');
    await flush();
    expect(world.registration.update).not.toHaveBeenCalled();
  });
});

describe('knowing that a new version waits', () => {
  it('is pending once a new worker has installed behind the one serving the page', async () => {
    const world = fakeBrowser();
    const { updater } = await started(world);
    const seen = [];
    updater.subscribe(() => seen.push(updater.getState()));

    const worker = world.find();
    expect(updater.getState().pending).toBe(false);

    world.installed(worker);
    expect(updater.getState().pending).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(updater.getState()); // one object per change: a store React can read
  });

  it('is pending from the start when the worker was already waiting', async () => {
    const world = fakeBrowser();
    world.registration.waiting = new FakeWorker('installed');
    const { updater } = await started(world);
    expect(updater.getState().pending).toBe(true);
  });

  it('sees a worker found by its own question', async () => {
    const world = fakeBrowser();
    const { updater } = await started(world);
    world.registration.update = vi.fn(async () => {
      world.installed(world.find());
    });

    vi.advanceTimersByTime(CHECK_EVERY_MS);
    await flush();
    expect(updater.getState().pending).toBe(true);
  });

  it('is not an update when the page installs its first worker', async () => {
    const world = fakeBrowser({ served: false });
    const { updater, reload } = await started(world);

    const worker = world.find();
    world.installed(worker);
    expect(updater.getState().pending).toBe(false);

    world.takeOver(worker); // clients.claim() on the page that registered it
    expect(updater.getState().pending).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('is no longer pending when the install fails', async () => {
    const world = fakeBrowser();
    const { updater } = await started(world);
    const worker = world.waitingWorker();
    expect(updater.getState().pending).toBe(true);

    world.registration.waiting = null;
    worker.become('redundant');
    expect(updater.getState().pending).toBe(false);
  });
});

describe('applying it', () => {
  it('tells the waiting worker to take over, and reloads only once it is activated', async () => {
    const world = fakeBrowser();
    const { updater, reload } = await started(world);
    const worker = world.waitingWorker();
    const seen = [];
    updater.subscribe(() => seen.push(updater.getState()));

    expect(updater.apply()).toBe(true);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledWith({ type: SKIP_WAITING });
    expect(updater.getState()).toMatchObject({ pending: true, applying: true });
    expect(reload).not.toHaveBeenCalled();

    expect(updater.apply()).toBe(true); // a second tap changes nothing
    expect(worker.postMessage).toHaveBeenCalledTimes(1);

    // The worker holds the active slot and the page hears `controllerchange`.
    // Its `activate` handlers have not run: a reload asked for now would be
    // held back by the browser while the old page stays in use.
    world.activating(worker);
    expect(reload).not.toHaveBeenCalled();
    expect(updater.getState()).toEqual({ pending: true, applying: true, offered: false, failed: false });

    world.activated(worker);
    expect(reload).toHaveBeenCalledTimes(1);

    world.container.dispatchEvent(new Event('controllerchange'));
    worker.become('activated');
    expect(reload).toHaveBeenCalledTimes(1);

    // From the message to the reload the page was told one thing: "updating".
    expect(seen).toEqual([{ pending: true, applying: true, offered: false, failed: false }]);
  });

  it('says "updating" all the way on a page no worker serves (a hard reload), and reloads at `activated`', async () => {
    const world = fakeBrowser();
    world.container.controller = null; // the registration has its worker; this page was loaded around it
    const { updater, reload } = await started(world);
    const worker = world.waitingWorker();
    expect(updater.getState().pending).toBe(true);

    updater.apply();
    // Nobody served this page, so no `controllerchange` comes with the change of slot…
    world.registration.waiting = null;
    world.registration.active = worker;
    worker.become('activating');
    expect(updater.getState()).toEqual({ pending: true, applying: true, offered: false, failed: false });
    expect(reload).not.toHaveBeenCalled();

    // …it comes from the worker's `activate` handler (clients.claim), and `activated` after it.
    world.container.controller = worker;
    world.container.dispatchEvent(new Event('controllerchange'));
    expect(reload).not.toHaveBeenCalled();
    worker.become('activated');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('has nothing to apply when nothing waits', async () => {
    const world = fakeBrowser();
    const { updater, reload } = await started(world);
    expect(updater.apply()).toBe(false);
    expect(updater.getState().applying).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('speaks to the worker that waits now, not to one it replaced', async () => {
    const world = fakeBrowser();
    const { updater } = await started(world);
    const older = world.waitingWorker();
    const newer = world.find();
    world.installed(newer); // takes the waiting slot
    older.become('redundant');

    updater.apply();
    expect(older.postMessage).not.toHaveBeenCalled();
    expect(newer.postMessage).toHaveBeenCalledWith({ type: SKIP_WAITING });
  });

  it('gives up without reloading when the worker never takes over, and offers the update again', async () => {
    const world = fakeBrowser();
    const { updater, reload } = await started(world);
    const worker = world.waitingWorker();
    updater.apply();

    vi.advanceTimersByTime(APPLY_TIMEOUT_MS - 1);
    expect(updater.getState().applying).toBe(true);
    vi.advanceTimersByTime(1);

    expect(updater.getState()).toEqual({ pending: true, applying: false, offered: true, failed: true });
    expect(reload).not.toHaveBeenCalled();

    // Not on its own a second time…
    expect(updater.apply({ auto: true })).toBe(false);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    // …but the person may ask again.
    expect(updater.apply()).toBe(true);
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    expect(updater.getState()).toMatchObject({ applying: true, failed: false });
  });

  it('gives up without reloading when the worker starts to take over and does not get there', async () => {
    const world = fakeBrowser();
    const { updater, reload } = await started(world);
    const worker = world.waitingWorker();
    updater.apply();
    world.activating(worker);

    vi.advanceTimersByTime(APPLY_TIMEOUT_MS);
    // Still an update — the page is older than the worker that serves it now.
    expect(updater.getState()).toEqual({ pending: true, applying: false, offered: true, failed: true });
    expect(reload).not.toHaveBeenCalled();

    // It gets there after all, long after the attempt: nothing behind the person's back.
    world.activated(worker);
    expect(reload).not.toHaveBeenCalled();

    // The tap that follows has no worker to tell and nothing to wait for.
    expect(updater.apply()).toBe(true);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('gives up at once when the worker it told is thrown away instead of taking over', async () => {
    const world = fakeBrowser();
    const { updater, reload } = await started(world);
    const worker = world.waitingWorker();
    updater.apply();

    world.registration.waiting = null;
    worker.become('redundant');

    expect(updater.getState()).toEqual({ pending: false, applying: false, offered: false, failed: false });
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(APPLY_TIMEOUT_MS);
    expect(updater.getState().pending).toBe(false);
  });

  it('offers the next worker, saying the last attempt failed, when one took the place of the worker it told', async () => {
    const world = fakeBrowser();
    const { updater, reload } = await started(world);
    const older = world.waitingWorker();
    updater.apply();

    const newer = world.find();
    world.installed(newer); // takes the waiting slot before the older one moved
    older.become('redundant');

    expect(updater.getState()).toEqual({ pending: true, applying: false, offered: true, failed: true });
    expect(reload).not.toHaveBeenCalled();

    expect(updater.apply()).toBe(true);
    expect(newer.postMessage).toHaveBeenCalledWith({ type: SKIP_WAITING });
    world.takeOver(newer);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('a worker that changes without this page asking (another window applied the update)', () => {
  it('does not reload the page: the update is pending, like any other', async () => {
    const world = fakeBrowser();
    const { updater, reload } = await started(world);
    const worker = world.waitingWorker();

    world.takeOver(worker);

    expect(reload).not.toHaveBeenCalled();
    expect(updater.getState()).toMatchObject({ pending: true, applying: false });
  });

  it('reloads when the page says so, with no worker left to speak to', async () => {
    const world = fakeBrowser();
    const { updater, reload } = await started(world);
    const worker = world.waitingWorker();
    world.takeOver(worker);

    expect(updater.apply()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it('a reload asked for while that worker is still activating waits for it', async () => {
    const world = fakeBrowser();
    const { updater, reload } = await started(world);
    const worker = world.waitingWorker();

    world.activating(worker); // the other window told it a moment ago
    expect(updater.getState()).toMatchObject({ pending: true, applying: false });

    expect(updater.apply()).toBe(true);
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(updater.getState()).toMatchObject({ pending: true, applying: true });

    world.activated(worker);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('…and gives up, without reloading, when it does not get there', async () => {
    const world = fakeBrowser();
    const { updater, reload } = await started(world);
    world.activating(world.waitingWorker());
    updater.apply();

    vi.advanceTimersByTime(APPLY_TIMEOUT_MS);
    expect(updater.getState()).toEqual({ pending: true, applying: false, offered: true, failed: true });
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads at once when the worker that took over is gone already', async () => {
    const world = fakeBrowser();
    const { updater, reload } = await started(world);
    const worker = world.waitingWorker();
    world.activating(worker);
    worker.become('redundant'); // unregistered, or replaced in its turn

    expect(updater.apply()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('safe moments', () => {
  it('applies by itself an update that appears while nothing would be lost', async () => {
    const world = fakeBrowser();
    const { updater, storage } = await started(world);
    const busy = vi.fn(() => false);
    updater.watchForSafeMoment(busy);

    const worker = world.waitingWorker();

    expect(busy).toHaveBeenCalled();
    expect(worker.postMessage).toHaveBeenCalledWith({ type: SKIP_WAITING });
    expect(updater.getState()).toMatchObject({ applying: true, offered: false });
    expect(storage.get(AUTO_APPLIED_KEY)).toBe('build-1');
  });

  it('offers it instead while something would be lost, and never applies it then', async () => {
    const world = fakeBrowser();
    const { updater, reload } = await started(world);
    updater.watchForSafeMoment(() => true);

    const worker = world.waitingWorker();

    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(updater.getState()).toEqual({ pending: true, applying: false, offered: true, failed: false });

    vi.advanceTimersByTime(CHECK_EVERY_MS);
    await flush();
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('"Later" takes the offer away until the next moment', async () => {
    const world = fakeBrowser();
    const { updater } = await started(world);
    let busy = true;
    updater.watchForSafeMoment(() => busy);
    const worker = world.waitingWorker();

    updater.dismiss();
    expect(updater.getState()).toMatchObject({ pending: true, offered: false });

    // Back to the app, still in the middle of something: offered again.
    setVisibility('hidden');
    setVisibility('visible');
    expect(updater.getState().offered).toBe(true);
    expect(worker.postMessage).not.toHaveBeenCalled();

    // Back to the app with nothing going on: applied.
    updater.dismiss();
    busy = false;
    setVisibility('hidden');
    setVisibility('visible');
    expect(worker.postMessage).toHaveBeenCalledWith({ type: SKIP_WAITING });
  });

  it('applies on a moment the page names (a change of route)', async () => {
    const world = fakeBrowser();
    const { updater } = await started(world);
    let busy = true;
    updater.watchForSafeMoment(() => busy);
    const worker = world.waitingWorker();

    busy = false;
    expect(worker.postMessage).not.toHaveBeenCalled(); // becoming safe is not a moment by itself
    updater.consider();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
  });

  it('neither applies nor offers in a window nobody is looking at', async () => {
    const world = fakeBrowser();
    const { updater } = await started(world);
    updater.watchForSafeMoment(() => false);
    setVisibility('hidden');

    const worker = world.waitingWorker();
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(updater.getState()).toMatchObject({ pending: true, offered: false });

    setVisibility('visible');
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
  });

  it('waits for a page that can answer (signed out: nobody watches)', async () => {
    const world = fakeBrowser();
    const { updater } = await started(world);
    const worker = world.waitingWorker();
    setVisibility('visible');

    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(updater.getState()).toMatchObject({ pending: true, offered: false });

    // The shell mounts: registering the question is a moment.
    const unwatch = updater.watchForSafeMoment(() => true);
    expect(updater.getState().offered).toBe(true);

    // …and unmounts: nobody to ask again.
    unwatch();
    updater.dismiss();
    setVisibility('hidden');
    setVisibility('visible');
    expect(updater.getState().offered).toBe(false);
  });

  it('does not reload over something that began while the worker was taking over', async () => {
    const world = fakeBrowser();
    const { updater, reload, storage } = await started(world);
    let busy = false;
    updater.watchForSafeMoment(() => busy);

    // Nothing going on: the page applies the update by itself.
    const worker = world.waitingWorker();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(updater.getState().applying).toBe(true);

    // The worker takes the page (`controllerchange`) and needs a second more to
    // be activated. The page is still on the screen: a set is ticked.
    world.activating(worker);
    expect(reload).not.toHaveBeenCalled();
    expect(updater.getState()).toEqual({ pending: true, applying: true, offered: false, failed: false });
    busy = true;
    world.activated(worker);

    expect(reload).not.toHaveBeenCalled();
    expect(updater.getState()).toEqual({ pending: true, applying: false, offered: true, failed: false });
    // No reload happened, so the page may still reload by itself later.
    expect(storage.get(AUTO_APPLIED_KEY)).not.toBe('build-1');

    // The timeout of the attempt that was called off changes nothing.
    vi.advanceTimersByTime(APPLY_TIMEOUT_MS);
    expect(updater.getState()).toEqual({ pending: true, applying: false, offered: true, failed: false });

    // The next safe moment: the reload, at once, with no worker left to tell.
    busy = false;
    updater.consider();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
  });

  it('a tap on "Update" is not asked a second time: it reloads when the worker has taken over', async () => {
    const world = fakeBrowser();
    const { updater, reload } = await started(world);
    updater.watchForSafeMoment(() => true); // a rest timer runs, and the person chose anyway
    const worker = world.waitingWorker();

    expect(updater.apply()).toBe(true);
    world.activating(worker);
    expect(reload).not.toHaveBeenCalled(); // it waits for the worker like any other reload
    world.activated(worker);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads by itself, at a safe moment, a page whose worker changed under it', async () => {
    const world = fakeBrowser();
    const { updater, reload } = await started(world);
    let busy = true;
    updater.watchForSafeMoment(() => busy);
    world.takeOver(world.waitingWorker());
    expect(reload).not.toHaveBeenCalled();
    expect(updater.getState().offered).toBe(true);

    busy = false;
    updater.consider();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload a page whose worker changed under it over what began before that worker was activated', async () => {
    const world = fakeBrowser();
    const { updater, reload, storage } = await started(world);
    let busy = true;
    updater.watchForSafeMoment(() => busy);
    const worker = world.waitingWorker(); // something is going on: offered, not applied
    expect(worker.postMessage).not.toHaveBeenCalled();
    busy = false; // …and over, which is not a moment by itself

    // Another window applies the update. For this page that is a moment, and a
    // safe one: it will reload — once the worker is activated.
    world.activating(worker);
    expect(updater.getState()).toEqual({ pending: true, applying: true, offered: false, failed: false });
    expect(reload).not.toHaveBeenCalled();

    busy = true; // a message is begun in that second
    world.activated(worker);
    expect(reload).not.toHaveBeenCalled();
    expect(updater.getState()).toEqual({ pending: true, applying: false, offered: true, failed: false });
    expect(storage.get(AUTO_APPLIED_KEY)).not.toBe('build-1');

    busy = false;
    updater.consider();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads a page whose worker changed under it, at a safe moment, once that worker is activated', async () => {
    const world = fakeBrowser();
    const { updater, reload } = await started(world);
    let busy = true;
    updater.watchForSafeMoment(() => busy);
    const worker = world.waitingWorker();
    busy = false;

    world.activating(worker);
    expect(reload).not.toHaveBeenCalled();
    world.activated(worker);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('never a loop', () => {
  it('a build that reloaded itself once does not do it a second time on its own', async () => {
    // The page is build-1 again after a reload that was meant to replace it.
    const storage = memoryStorage({ [AUTO_APPLIED_KEY]: 'build-1' });
    const world = fakeBrowser();
    const { updater, reload } = await started(world, { storage, buildId: 'build-1' });
    updater.watchForSafeMoment(() => false);

    const worker = world.waitingWorker();

    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(updater.getState()).toMatchObject({ pending: true, applying: false, offered: true });

    // The offer still works.
    expect(updater.apply()).toBe(true);
    world.takeOver(worker);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('the next build is free to', async () => {
    const storage = memoryStorage({ [AUTO_APPLIED_KEY]: 'build-1' });
    const world = fakeBrowser();
    const { updater } = await started(world, { storage, buildId: 'build-2' });
    updater.watchForSafeMoment(() => false);

    const worker = world.waitingWorker();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(storage.get(AUTO_APPLIED_KEY)).toBe('build-2');
  });

  it('nothing is applied automatically when the guard cannot be written', async () => {
    const storage = { get: () => null, set: () => false };
    const world = fakeBrowser();
    const { updater } = await started(world, { storage });
    updater.watchForSafeMoment(() => false);

    const worker = world.waitingWorker();
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(updater.getState().offered).toBe(true);
  });

  it('a tap on "Update" does not use up the automatic attempt', async () => {
    const world = fakeBrowser();
    const { updater, storage } = await started(world);
    world.waitingWorker();
    updater.apply();
    expect(storage.get(AUTO_APPLIED_KEY)).toBeNull();
  });
});
