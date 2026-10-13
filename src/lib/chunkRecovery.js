import { appUpdater, sessionStore } from './appUpdate';
import { BUILD_ID } from './buildInfo';

// A page that cannot load one of its own files.
//
// Every screen is a file of its own, fetched the first time it is opened
// (React.lazy in src/routes.jsx), and the name of a file changes with its
// content. A page that was opened before a deploy asks for the names of ITS
// build. Two things can answer: the service worker of that build, from its
// precache, and the server, where a deploy keeps the files of the last three
// builds (scripts/prune-gh-pages.mjs). A page asks in vain when both are gone
// — its worker was replaced under it, or lost its cache, and three deploys
// went by — and after an emergency publish, which keeps nothing. Its
// import fails, React.lazy keeps the failure for good, and nothing on the page
// can open that screen any more: the way on is a reload, which brings the page
// of the build that is published.
//
// Vite announces the failure on `window` before the import rejects:
// `vite:preloadError`, with the error as `event.payload`. From there:
//
//   1. THE PAGE RELOADS BY ITSELF, ONCE PER BUILD, and only when the reload
//      costs nothing: the device is online, and the question the update flow
//      puts to the page — "would a reload lose something right now?"
//      (lib/appUpdate, answered by components/ui/UpdatePrompt) — is answered
//      no. CHUNK_RELOADED_KEY in sessionStorage holds the id of the build that
//      reloaded itself this way: a page that finds its own id there is the
//      same build again, the reload brought nothing new, and it does not try a
//      second time. That is what makes a loop impossible.
//   2. OTHERWISE THE ERROR GOES ON to where it was going: React.lazy, then
//      components/ui/ErrorBoundary, which recognises it (isChunkLoadError),
//      reports nothing and offers the reload (`reloadNow`).
//
// The event is never cancelled. `preventDefault()` makes Vite swallow the
// error, and the import then resolves to nothing: React.lazy would fail a
// second time, on an error that says nothing about a missing file.
//
// This reload is not the update flow's (`doReload` in lib/appUpdate, which
// waits for a worker to be activated). It needs no worker and tells none: it
// asks the server, or the worker that serves the page now, for the page again.
// A page whose worker was replaced under it is the update flow's first — the
// change of route that asks for the file is one of its moments, and it reloads
// the page there when nothing would be lost. What is left for this file is the
// page the update flow cannot help: one no worker serves, one whose worker
// lost its cache, one whose own reload was already spent.

/**
 * sessionStorage: the build that last reloaded ITSELF because one of its files
 * could not be loaded.
 */
export const CHUNK_RELOADED_KEY = 'sl_chunk_reloaded';

/** The event Vite dispatches on `window` when a dynamic import, or one of its files, fails to load. */
export const PRELOAD_ERROR_EVENT = 'vite:preloadError';

// What a browser says when a module, or a stylesheet it needs, did not load.
// The wording is the only thing they have in common: the type is a TypeError
// here, a plain Error there.
const NOT_LOADED = [
  /Failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /Importing a module script failed/i, // Safari, and an installed app on iOS
  /Unable to preload CSS for/i, // Vite: a stylesheet of the screen
  /Failed to load module script/i, // Chromium: the host answered with its "not found" page
  /is not a valid JavaScript MIME type/i, // Safari: the same
  /Loading (?:CSS )?chunk [\w-]+ failed/i, // bundlers that name it
];

/**
 * Is this the error of a file of the app that did not load — and not an error
 * of the code in it? A request to the API that failed ("Failed to fetch") is
 * not one.
 */
export function isChunkLoadError(error) {
  if (!error) return false;
  if (typeof error === 'object' && error.name === 'ChunkLoadError') return true;
  const message = typeof error === 'string' ? error : error.message;
  return typeof message === 'string' && NOT_LOADED.some((wording) => wording.test(message));
}

/**
 * One recovery. The app uses the single instance at the end of this file; the
 * arguments exist for the tests.
 */
export function createChunkRecovery({
  storage = sessionStore(),
  buildId = BUILD_ID,
  reload = () => window.location.reload(),
  isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false,
  // `null` — nobody to ask: no shell is mounted, so nothing of what the
  // question is about can be in progress — counts as "no".
  isBusy = () => appUpdater.busy() === true,
} = {}) {
  let reloading = false;
  let listeningOn = null;

  /**
   * `error` reached the page: reload for it, if it is a file that did not
   * load and the reload is free. Returns whether a reload was asked for.
   */
  function recover(error) {
    if (!isChunkLoadError(error)) return false;
    if (reloading) return true;
    // Offline, the same error means "no network", and a page no worker serves
    // would be reloaded into the browser's own error page.
    if (!isOnline()) return false;
    if (isBusy()) return false;
    if (storage.get(CHUNK_RELOADED_KEY) === buildId) return false;
    // No guard, no reload on our own: without it nothing would stop a loop.
    if (!storage.set(CHUNK_RELOADED_KEY, buildId)) return false;
    reloading = true;
    reload();
    return true;
  }

  const onPreloadError = (event) => {
    recover(event.payload);
  };

  return {
    recover,
    /** The person asked for the reload: no guard, no question. */
    reloadNow() {
      reloading = true;
      reload();
    },
    /** A reload has been asked for and the page is on its way out. */
    isReloading: () => reloading,
    /** Listen for Vite's announcement. Once: a second call changes nothing. */
    install(target = window) {
      if (listeningOn) return;
      listeningOn = target;
      target.addEventListener(PRELOAD_ERROR_EVENT, onPreloadError);
    },
    uninstall() {
      if (!listeningOn) return;
      listeningOn.removeEventListener(PRELOAD_ERROR_EVENT, onPreloadError);
      listeningOn = null;
    },
  };
}

/**
 * The app's recovery: installed once by src/main.jsx (production builds), read
 * and answered by components/ui/ErrorBoundary. Making it touches nothing.
 */
export const chunkRecovery = createChunkRecovery();
