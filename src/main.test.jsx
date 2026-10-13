import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

vi.mock('./App', () => ({ default: () => null }));
vi.mock('./lib/appUpdate', () => ({ appUpdater: { start: vi.fn() } }));
vi.mock('./lib/chunkRecovery', () => ({ chunkRecovery: { install: vi.fn() } }));
vi.mock('./lib/restNotifications', () => ({ restNotifications: { install: vi.fn() } }));

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

async function boot() {
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  // main.jsx renders the app. Inside act() React finishes that render before
  // the test goes on; left to its scheduler, the render can still be waiting
  // when this file's document is taken away, and fails on a `window` that is
  // gone.
  await act(async () => {
    await import('./main.jsx');
  });
  const { appUpdater } = await import('./lib/appUpdate');
  return appUpdater;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  document.body.innerHTML = '';
});

describe('src/main.jsx — who registers the service worker', () => {
  it('starts the updater on the worker of the app, in a production build', async () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('BASE_URL', '/sl_app/'); // `base` of vite.config.js; vitest serves from '/'
    const appUpdater = await boot();
    expect(appUpdater.start).toHaveBeenCalledTimes(1);
    expect(appUpdater.start).toHaveBeenCalledWith({ swUrl: '/sl_app/sw.js', scope: '/sl_app/' });
  });

  it('registers nothing in dev, where no worker is built', async () => {
    vi.stubEnv('PROD', false);
    const appUpdater = await boot();
    expect(appUpdater.start).not.toHaveBeenCalled();
  });
});

// What the listener does with an error is lib/chunkRecovery.test.js; what is
// held here is that the app has one, and only where a build made the files.
describe('src/main.jsx — who listens for a file that did not load', () => {
  it('installs the recovery once, on window, in a production build', async () => {
    vi.stubEnv('PROD', true);
    await boot();
    const { chunkRecovery } = await import('./lib/chunkRecovery');
    expect(chunkRecovery.install).toHaveBeenCalledTimes(1);
    expect(chunkRecovery.install).toHaveBeenCalledWith(); // its default target: window
  });

  it('installs nothing in dev, where the server has every file', async () => {
    vi.stubEnv('PROD', false);
    await boot();
    const { chunkRecovery } = await import('./lib/chunkRecovery');
    expect(chunkRecovery.install).not.toHaveBeenCalled();
  });
});

// What the watcher closes, and when, is lib/restNotifications.test.js; what is
// held here is that the app has one, and only where a worker shows
// notifications.
describe('src/main.jsx — who closes a "Rest done" that is over when the app is opened', () => {
  it('installs the watcher once, on the document and the window, in a production build', async () => {
    vi.stubEnv('PROD', true);
    await boot();
    const { restNotifications } = await import('./lib/restNotifications');
    expect(restNotifications.install).toHaveBeenCalledTimes(1);
    expect(restNotifications.install).toHaveBeenCalledWith(); // its default targets
  });

  it('installs nothing in dev, where there is no worker', async () => {
    vi.stubEnv('PROD', false);
    await boot();
    const { restNotifications } = await import('./lib/restNotifications');
    expect(restNotifications.install).not.toHaveBeenCalled();
  });
});

// The plugin's own registration reloads every window as soon as a new worker
// takes over. If it came back next to lib/appUpdate — through its virtual
// module, or through the script the plugin adds to index.html when nothing
// imports that module — the page would be reloaded twice over, and the first
// time without being asked.
describe('vite-plugin-pwa leaves the registration to the page', () => {
  const sources = (dir) =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return sources(full);
      return /\.jsx?$/.test(entry) && !/\.test\.jsx?$/.test(entry) ? [full] : [];
    });

  it('nothing in src imports virtual:pwa-register', () => {
    const offenders = sources(join(root, 'src'))
      .filter((file) => /from\s+['"]virtual:pwa-register|import\(\s*['"]virtual:pwa-register/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });

  it('vite.config.js turns the plugin\'s registration script off and asks for a worker that waits', () => {
    const config = readFileSync(join(root, 'vite.config.js'), 'utf8');
    expect(config).toMatch(/^\s*injectRegister:\s*false,/m);
    expect(config).toMatch(/^\s*registerType:\s*'prompt',/m);
    expect(config).not.toMatch(/registerType:\s*'autoUpdate'/);
  });
});
