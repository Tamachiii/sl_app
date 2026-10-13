import { describe, it, expect, vi } from 'vitest';
import {
  CHUNK_RELOADED_KEY,
  PRELOAD_ERROR_EVENT,
  createChunkRecovery,
  isChunkLoadError,
} from './chunkRecovery';
import { AUTO_APPLIED_KEY } from './appUpdate';
import { memoryStorage } from '../test/fakeServiceWorker';

const CHUNK = 'https://tamachiii.github.io/sl_app/assets/StudentMessages-BVh2kq1x.js';
const missingFile = () => new TypeError(`Failed to fetch dynamically imported module: ${CHUNK}`);

function made(options = {}) {
  const reload = vi.fn();
  const storage = options.storage ?? memoryStorage();
  const recovery = createChunkRecovery({
    storage,
    buildId: options.buildId ?? 'build-1',
    reload,
    isOnline: options.isOnline ?? (() => true),
    isBusy: options.isBusy ?? (() => false),
  });
  return { recovery, reload, storage };
}

/** What Vite dispatches before a failed import rejects. */
function announce(target, payload) {
  const event = new Event(PRELOAD_ERROR_EVENT, { cancelable: true });
  event.payload = payload;
  target.dispatchEvent(event);
  return event;
}

describe('isChunkLoadError — a file of the app that did not load', () => {
  it.each([
    ['Chromium', new TypeError(`Failed to fetch dynamically imported module: ${CHUNK}`)],
    ['Firefox', new TypeError(`error loading dynamically imported module: ${CHUNK}`)],
    ['Safari and an installed app on iOS', new TypeError('Importing a module script failed.')],
    ['Vite, for a stylesheet of the screen', new Error('Unable to preload CSS for /sl_app/assets/SessionView-C4hq.css')],
    [
      'Chromium, when the host answers with its "not found" page',
      new TypeError('Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of "text/html".'),
    ],
    ['Safari, the same', new TypeError("'text/html' is not a valid JavaScript MIME type.")],
    ['a bundler that names it', Object.assign(new Error('Loading chunk 42 failed.'), { name: 'ChunkLoadError' })],
    ['a bundler that names it, by its message', new Error('Loading CSS chunk vendors-main failed')],
    ['an error that crossed a boundary as a plain object', { message: `Failed to fetch dynamically imported module: ${CHUNK}` }],
    ['an error that arrived as text', `error loading dynamically imported module: ${CHUNK}`],
  ])('%s', (_browser, error) => {
    expect(isChunkLoadError(error)).toBe(true);
  });

  it.each([
    ['a request to the API that failed', new TypeError('Failed to fetch')],
    ['the same, in Safari', new TypeError('Load failed')],
    ['the same, in Firefox', new TypeError('NetworkError when attempting to fetch resource.')],
    ['an error of the code in the file', new TypeError("Cannot read properties of undefined (reading 'map')")],
    ['an error PostgREST answered with', { code: '42501', message: 'new row violates row-level security policy for table "set_logs"' }],
    ['an import that resolved to nothing', new TypeError("Cannot read properties of undefined (reading 'default')")],
    ['an error without a message', new Error('')],
    ['an object that is not an error', { status: 404 }],
    ['nothing', null],
    ['nothing at all', undefined],
  ])('not %s', (_what, error) => {
    expect(isChunkLoadError(error)).toBe(false);
  });
});

describe('the page reloads by itself for a file that did not load', () => {
  it('once, and remembers which build did', () => {
    const { recovery, reload, storage } = made();

    expect(recovery.recover(missingFile())).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.get(CHUNK_RELOADED_KEY)).toBe('build-1');
    expect(recovery.isReloading()).toBe(true);

    // The other files of the same screen fail in the same instant.
    expect(recovery.recover(new Error('Unable to preload CSS for /sl_app/assets/StudentMessages-9fK2.css'))).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('not a second time: a page that finds its own build in the guard is the same page again', () => {
    // The reload happened, and the page that came back is build-1 once more.
    const storage = memoryStorage({ [CHUNK_RELOADED_KEY]: 'build-1' });
    const { recovery, reload } = made({ storage });

    expect(recovery.recover(missingFile())).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(recovery.isReloading()).toBe(false);
  });

  it('the build that came back in its place is free to', () => {
    const storage = memoryStorage({ [CHUNK_RELOADED_KEY]: 'build-1' });
    const { recovery, reload } = made({ storage, buildId: 'build-2' });

    expect(recovery.recover(missingFile())).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.get(CHUNK_RELOADED_KEY)).toBe('build-2');
  });

  it('keeps a guard of its own: an update the page applied by itself does not use it up', () => {
    const storage = memoryStorage({ [AUTO_APPLIED_KEY]: 'build-1' });
    const { recovery, reload } = made({ storage });

    expect(CHUNK_RELOADED_KEY).not.toBe(AUTO_APPLIED_KEY);
    expect(recovery.recover(missingFile())).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.get(AUTO_APPLIED_KEY)).toBe('build-1');
  });

  it('never without a guard it could write: nothing else would stop a loop', () => {
    const storage = { get: () => null, set: () => false };
    const { recovery, reload } = made({ storage });

    expect(recovery.recover(missingFile())).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('not while a reload would lose something, and the attempt is not used up', () => {
    let busy = true; // a rest timer runs, a set is on its way, a message is typed
    const { recovery, reload, storage } = made({ isBusy: () => busy });

    expect(recovery.recover(missingFile())).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(storage.get(CHUNK_RELOADED_KEY)).toBeNull();

    busy = false;
    expect(recovery.recover(missingFile())).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('not while offline, where the same error means "no network"', () => {
    let online = false;
    const { recovery, reload, storage } = made({ isOnline: () => online });

    expect(recovery.recover(missingFile())).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(storage.get(CHUNK_RELOADED_KEY)).toBeNull();

    online = true;
    expect(recovery.recover(missingFile())).toBe(true);
  });

  it('not for an error of the code in the file, which a reload would only repeat', () => {
    const { recovery, reload, storage } = made();

    expect(recovery.recover(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(recovery.recover(new TypeError('Failed to fetch'))).toBe(false);
    expect(recovery.recover(undefined)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(storage.get(CHUNK_RELOADED_KEY)).toBeNull();
  });
});

describe('"Reload", when the person asks', () => {
  it('reloads whatever the guard, the network and the page say', () => {
    const storage = memoryStorage({ [CHUNK_RELOADED_KEY]: 'build-1' });
    const { recovery, reload } = made({ storage, isOnline: () => false, isBusy: () => true });

    recovery.reloadNow();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(recovery.isReloading()).toBe(true);

    // A second tap is not swallowed: a reload the browser did not get to is asked for again.
    recovery.reloadNow();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('does not use the automatic attempt up', () => {
    const { recovery, storage } = made();
    recovery.reloadNow();
    expect(storage.get(CHUNK_RELOADED_KEY)).toBeNull();
  });
});

describe("listening to Vite's announcement", () => {
  it('reloads for the error the event carries, and leaves the event alone', () => {
    const target = new EventTarget();
    const { recovery, reload } = made();
    recovery.install(target);

    const event = announce(target, missingFile());

    expect(reload).toHaveBeenCalledTimes(1);
    // Cancelled, Vite would swallow the error and the import would resolve to
    // nothing: the screen would then fail on an error that names no file.
    expect(event.defaultPrevented).toBe(false);
  });

  it('does nothing for an error thrown by the module itself, which arrives the same way', () => {
    const target = new EventTarget();
    const { recovery, reload } = made();
    recovery.install(target);

    announce(target, new ReferenceError('process is not defined'));
    announce(target, undefined);
    expect(reload).not.toHaveBeenCalled();
  });

  it('listens on window unless told otherwise, which is where Vite speaks', () => {
    const { recovery, reload } = made();
    recovery.install();

    announce(window, missingFile());
    expect(reload).toHaveBeenCalledTimes(1);

    recovery.uninstall();
  });

  it('listens once, however often it is installed, and stops when told', () => {
    const target = new EventTarget();
    const add = vi.spyOn(target, 'addEventListener');
    const { recovery, reload } = made({ storage: { get: () => null, set: () => true } });

    recovery.install(target);
    recovery.install(target);
    recovery.install(new EventTarget());
    expect(add).toHaveBeenCalledTimes(1);

    recovery.uninstall();
    recovery.uninstall();
    announce(target, missingFile());
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('the recovery of the app', () => {
  it('asks the update flow whether a reload would lose something, and takes "nobody to ask" for no', async () => {
    vi.resetModules();
    const busy = vi.fn(() => true);
    vi.doMock('./appUpdate', async (original) => ({
      ...(await original()),
      appUpdater: { busy },
    }));
    const { createChunkRecovery: create } = await import('./chunkRecovery');
    const reload = vi.fn();
    const recovery = create({ storage: memoryStorage(), buildId: 'build-1', reload, isOnline: () => true });

    expect(recovery.recover(missingFile())).toBe(false); // a reload would lose something
    expect(busy).toHaveBeenCalledTimes(1);

    busy.mockReturnValue(null); // no shell is mounted: nobody answers
    expect(recovery.recover(missingFile())).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    vi.doUnmock('./appUpdate');
    vi.resetModules();
  });
});
