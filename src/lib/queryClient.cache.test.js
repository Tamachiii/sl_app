import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  QueryObserver,
  dehydrate,
  focusManager,
  hydrate,
  onlineManager,
} from '@tanstack/react-query';

// What the app's client keeps of what it read: the allow-list of the persisted
// cache, how long an entry lives, and what is left out of the device.
// (The queue of writes and the drafts are in queryClient.test.js.)

vi.mock('./supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: { getSession: vi.fn() } },
}));
vi.mock('./toast', () => ({ pushToast: vi.fn() }));

import { supabase } from './supabase';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function deviceIs(online) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
}

// The app as a page load finds it: its modules evaluated again. React Query
// itself is not — its managers are one object for the whole file.
const mounted = [];
async function launchApp() {
  onlineManager.setOnline(true);
  vi.resetModules();
  const [app, offline] = await Promise.all([import('./queryClient'), import('./offlineMutations')]);
  app.queryClient.mount();
  mounted.push(app.queryClient);
  return { ...app, ...offline };
}

// What the persister is handed when the cache is saved, and what it writes.
function saved({ queryClient, shouldPersistQuery }) {
  return dehydrate(queryClient, { shouldDehydrateQuery: shouldPersistQuery });
}
const savedKeys = (app) => saved(app).queries.map((query) => query.queryKey);
function written(app) {
  return JSON.parse(app.serializeCache({ timestamp: Date.now(), buster: '', clientState: saved(app) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  supabase.auth.getSession.mockResolvedValue({
    data: { session: { access_token: 'jwt', user: { id: 'u-1' } } },
    error: null,
  });
  deviceIs(true);
});

afterEach(() => {
  while (mounted.length) {
    const client = mounted.pop();
    client.unmount();
    client.clear();
  }
  vi.useRealTimers();
  delete navigator.onLine;
  onlineManager.setOnline(true);
  focusManager.setFocused(undefined);
});

// --- the allow-list -------------------------------------------------------------

describe('what is written to the device: an allow-list', () => {
  it('twelve roots, and no other', async () => {
    const { PERSISTED_QUERY_ROOTS } = await launchApp();

    // A root added here is on every athlete's device at the next deploy, and
    // on a coach's: read the comment above the list before changing this.
    expect([...PERSISTED_QUERY_ROOTS].sort()).toEqual([
      'draft-tree',
      'exercise-library',
      'last-performance',
      'my-confirmed-session-ids',
      'my-draft',
      'session',
      'session-confirmation',
      'set-logs',
      'set-videos',
      'slot-comments',
      'slot-deviations',
      'student-program-details',
    ]);
    expect(Object.isFrozen(PERSISTED_QUERY_ROOTS)).toBe(true);
  });

  it('every entry of those roots is stored, and nothing a coach reads across athletes', async () => {
    const app = await launchApp();
    const { queryClient } = app;
    const kept = [
      ['session', 's-1'],
      ['set-logs', 's-1', ['slot-1']],
      ['slot-comments', 's-1'],
      ['slot-deviations', 's-1'],
      ['session-confirmation', 's-1'],
      ['set-videos', 's-1', ['l-1']],
      ['student-program-details', 'u-1', 'active'],
      ['my-confirmed-session-ids', 'u-1'],
      ['last-performance', 'self', 's-1', ['e-1']],
      ['my-draft', 'u-1'],
      ['draft-tree', 'p-1'],
      ['exercise-library'],
    ];
    const leftOut = [
      // The coach's roll-ups over every athlete.
      ['all-confirmations', 'c-1'],
      ['coach-dashboard-programs'],
      ['students'],
      ['program', 'st-1'],
      ['client-errors', 50],
      // Chatter.
      ['messages', 'conversations', 'u-1'],
      ['messages', 'unread-count', 'u-1'],
      ['notifications', 'list', 'u-1'],
      // Hundreds of kB each, re-serialised on every change of the cache.
      ['student-records', 'history', 'u-1'],
      ['student-records', 'u-1'],
      ['student-progress-stats', 'u-1', 'active'],
      ['student-program-details', 'u-1', 'all'],
      // Not a key at all.
      [{ root: 'session' }],
    ];
    for (const key of [...kept, ...leftOut]) queryClient.setQueryData(key, { some: 'rows' });

    expect(savedKeys(app)).toEqual(kept);
  });
});

// --- P24: how long an entry lives ------------------------------------------------

describe('what the device read is still there at the gym', () => {
  it('every persisted root keeps an entry nobody observes for as long as the persisted cache lives', async () => {
    const { queryClient, PERSISTED_QUERY_ROOTS, PERSIST_MAX_AGE_MS } = await launchApp();

    expect(PERSIST_MAX_AGE_MS).toBe(14 * DAY);
    for (const root of PERSISTED_QUERY_ROOTS) {
      expect(queryClient.getQueryDefaults([root, 'any']).gcTime, root).toBe(PERSIST_MAX_AGE_MS);
    }
    // The age at which the provider throws the whole cache away is that number.
    const provider = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../App.jsx'), 'utf8');
    expect(provider).toMatch(/maxAge: PERSIST_MAX_AGE_MS,/);
  });

  it('a session opened at home is on the device hours later; so is the list of what is confirmed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const app = await launchApp();
    const { queryClient } = app;
    const workout = [
      ['session', 's-1'],
      ['set-logs', 's-1', ['slot-1']],
      ['slot-comments', 's-1'],
      ['slot-deviations', 's-1'],
      ['session-confirmation', 's-1'],
      ['set-videos', 's-1', ['l-1']],
      ['student-program-details', 'u-1', 'active'],
      // Observed by the training list only: gone from the device five minutes
      // into a workout, the list started again from week 1 at the next launch.
      ['my-confirmed-session-ids', 'u-1'],
      ['last-performance', 'self', 's-1', ['e-1']],
      ['exercise-library'],
    ];
    // Read at home. The athlete goes back to the list, then locks the phone.
    for (const key of workout) queryClient.setQueryData(key, key[0] === 'session-confirmation' ? null : []);
    queryClient.setQueryData(['notifications', 'list', 'u-1'], []);

    await vi.advanceTimersByTimeAsync(9 * HOUR);

    // What React Query does with an entry nobody observes, left to its default.
    expect(queryClient.getQueryState(['notifications', 'list', 'u-1'])).toBeUndefined();
    for (const key of workout) expect(queryClient.getQueryState(key), key[0]).toBeDefined();
    // And what is still in memory is what the next save writes.
    expect(savedKeys(app)).toEqual(workout);
  });
});

// --- P24: a refresh that failed ---------------------------------------------------

describe('a read that could not be refreshed', () => {
  const session = { id: 's-1', title: 'Push A' };
  // What postgrest-js hands back when `fetch` failed.
  const noAnswer = { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' };

  // The session was read; then a refresh got no answer.
  async function refreshFailed(app) {
    const read = vi.fn().mockResolvedValueOnce(session).mockRejectedValue(noAnswer);
    const page = new QueryObserver(app.queryClient, { queryKey: ['session', 's-1'], queryFn: read, retry: false });
    const close = page.subscribe(() => {});
    await vi.waitFor(() => expect(page.getCurrentResult().data).toEqual(session));
    await page.refetch();
    close();
    return app.queryClient.getQueryCache().find({ queryKey: ['session', 's-1'] });
  }

  it('is still stored: the data is there, only the last attempt failed', async () => {
    const app = await launchApp();

    const query = await refreshFailed(app);

    expect(query.state).toMatchObject({ status: 'error', data: session, error: noAnswer });
    expect(app.shouldPersistQuery(query)).toBe(true);
    expect(savedKeys(app)).toEqual([['session', 's-1']]);
  });

  it('is stored as what was read, not as a failure — and comes back out of date', async () => {
    const before = await launchApp();
    await refreshFailed(before);

    const [stored] = written(before).clientState.queries;

    expect(stored.state).toMatchObject({
      status: 'success',
      data: session,
      error: null,
      fetchFailureCount: 0,
      fetchFailureReason: null,
      // A failed fetch flags what it could not replace.
      isInvalidated: true,
    });

    // The app is opened again, in the basement.
    deviceIs(false);
    const { queryClient } = await launchApp();
    hydrate(queryClient, { mutations: [], queries: [stored] });
    const read = vi.fn().mockResolvedValue({ ...session, title: 'Push A (edited)' });
    const page = new QueryObserver(queryClient, { queryKey: ['session', 's-1'], queryFn: read });
    const close = page.subscribe(() => {});

    expect(page.getCurrentResult()).toMatchObject({
      status: 'success',
      isError: false,
      error: null,
      data: session,
      fetchStatus: 'paused',
    });
    expect(read).not.toHaveBeenCalled();

    // Upstairs it is read again, however recent the copy.
    deviceIs(true);
    window.dispatchEvent(new Event('online'));

    await vi.waitFor(() => expect(page.getCurrentResult().data.title).toBe('Push A (edited)'));
    expect(read).toHaveBeenCalledTimes(1);
    close();
  });

  it('a read that never succeeded has nothing to store', async () => {
    const app = await launchApp();
    const page = new QueryObserver(app.queryClient, {
      queryKey: ['session', 's-2'],
      queryFn: vi.fn().mockRejectedValue(noAnswer),
      retry: false,
    });
    const close = page.subscribe(() => {});
    await vi.waitFor(() => expect(page.getCurrentResult().status).toBe('error'));
    // And one that is still on its way.
    const slow = new QueryObserver(app.queryClient, { queryKey: ['session', 's-3'], queryFn: () => new Promise(() => {}) });
    const closeSlow = slow.subscribe(() => {});

    expect(savedKeys(app)).toEqual([]);
    close();
    closeSlow();
  });

  it('an entry that is not an error is written as it is', async () => {
    const app = await launchApp();
    app.queryClient.setQueryData(['session', 's-1'], session);

    const persisted = { timestamp: 1791907401033, buster: 'v1', clientState: saved(app) };

    expect(JSON.parse(app.serializeCache(persisted))).toEqual(JSON.parse(JSON.stringify(persisted)));
  });
});

// --- P24: what is left out ---------------------------------------------------------
// With nothing collected for fourteen days, what the save leaves out is the
// only thing that ever takes an entry off the device.

describe('what is left out of the device', () => {
  const NOW = Date.parse('2026-10-13T18:00:00.000Z');
  const ago = (ms) => ({ updatedAt: NOW - ms });
  const confirmedAt = (ms) => ({
    session_id: 's',
    student_id: 'u-1',
    notes: null,
    performed_on: null,
    confirmed_at: new Date(NOW - ms).toISOString(),
  });
  // Everything the device holds about one session.
  const entriesOf = (sessionId) => [
    ['session', sessionId],
    ['set-logs', sessionId, ['slot-1']],
    ['slot-comments', sessionId],
    ['slot-deviations', sessionId],
    ['session-confirmation', sessionId],
    ['set-videos', sessionId, ['l-1']],
    ['last-performance', 'self', sessionId, ['e-1']],
  ];
  function seedSession(queryClient, sessionId, confirmation, options) {
    for (const key of entriesOf(sessionId)) {
      queryClient.setQueryData(key, key[0] === 'session-confirmation' ? confirmation : [], options);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  it('an entry nobody read or wrote for fourteen days', async () => {
    const app = await launchApp();
    const { queryClient } = app;
    queryClient.setQueryData(['student-program-details', 'u-1', 'active'], [], ago(14 * DAY + 1000));
    queryClient.setQueryData(['exercise-library'], [], ago(14 * DAY - 1000));
    queryClient.setQueryData(['session', 's-1'], {}, ago(15 * DAY));
    queryClient.setQueryData(['session', 's-2'], {}, ago(13 * DAY));

    expect(savedKeys(app)).toEqual([['exercise-library'], ['session', 's-2']]);

    // Read again, it is stored again.
    queryClient.setQueryData(['session', 's-1'], {});
    expect(savedKeys(app)).toEqual([['exercise-library'], ['session', 's-1'], ['session', 's-2']]);
  });

  it('everything about a session confirmed more than seven days ago — and nothing about one that is not', async () => {
    const app = await launchApp();
    const { queryClient, CONFIRMED_SESSION_KEPT_MS } = app;
    expect(CONFIRMED_SESSION_KEPT_MS).toBe(7 * DAY);
    // All of them opened a minute ago: their age is not what decides.
    seedSession(queryClient, 's-old', confirmedAt(7 * DAY + 1000), ago(MINUTE));
    seedSession(queryClient, 's-week', confirmedAt(7 * DAY - 1000), ago(MINUTE));
    seedSession(queryClient, 's-next', null, ago(MINUTE));
    // A coach's "last time" for the same sessions: the key names the athlete.
    queryClient.setQueryData(['last-performance', 'st-4', 's-old', ['e-1']], {}, ago(MINUTE));
    queryClient.setQueryData(['last-performance', 'st-4', 's-next', ['e-1']], {}, ago(MINUTE));
    // Nothing of the athlete's own block goes with them.
    queryClient.setQueryData(['student-program-details', 'u-1', 'active'], [], ago(MINUTE));
    queryClient.setQueryData(['my-confirmed-session-ids', 'u-1'], ['s-old', 's-week'], ago(MINUTE));

    expect(savedKeys(app)).toEqual([
      ...entriesOf('s-week'),
      ...entriesOf('s-next'),
      ['last-performance', 'st-4', 's-next', ['e-1']],
      ['student-program-details', 'u-1', 'active'],
      ['my-confirmed-session-ids', 'u-1'],
    ]);
  });

  it('a confirmation that is undone puts the session back on the device', async () => {
    const app = await launchApp();
    const { queryClient } = app;
    seedSession(queryClient, 's-old', confirmedAt(30 * DAY), ago(MINUTE));
    expect(savedKeys(app)).toEqual([]);

    // What the undo writes into the cache (useUnconfirmSession).
    queryClient.setQueryData(['session-confirmation', 's-old'], null);

    expect(savedKeys(app)).toEqual(entriesOf('s-old'));
  });

  it('a session whose confirmation is not in the cache is not known to be finished', async () => {
    const app = await launchApp();
    const { queryClient } = app;
    // The next session, read ahead from the list: no page asked for its
    // confirmation yet.
    queryClient.setQueryData(['session', 's-next'], { performed_at: null }, ago(MINUTE));
    queryClient.setQueryData(['set-logs', 's-next', ['slot-1']], [], ago(MINUTE));
    // And a row a caller wrote without a date.
    queryClient.setQueryData(['session-confirmation', 's-odd'], { session_id: 's-odd' }, ago(MINUTE));
    queryClient.setQueryData(['session', 's-odd'], {}, ago(MINUTE));

    expect(savedKeys(app)).toEqual([
      ['session', 's-next'],
      ['set-logs', 's-next', ['slot-1']],
      ['session-confirmation', 's-odd'],
      ['session', 's-odd'],
    ]);
  });

  it('never a draft that is ahead of the server, however old: the device holds its only copy', async () => {
    const app = await launchApp();
    const { queryClient } = app;
    const tree = (id) => ({ id, name: 'Off-season', status: 'draft', submitted_at: null, weeks: [] });
    // Written a month ago in a hut, refused by the database ever since.
    queryClient.setQueryData(['draft-tree', 'p-ahead'], { ...tree('p-ahead'), unsynced: { rev: 7 } }, ago(30 * DAY));
    // The pointer to it: for a draft created offline the server has no row.
    queryClient.setQueryData(['my-draft', 'u-1'], { id: 'p-ahead', name: 'Off-season' }, ago(30 * DAY));
    // A draft the database has, not opened for as long.
    queryClient.setQueryData(['draft-tree', 'p-synced'], tree('p-synced'), ago(30 * DAY));
    queryClient.setQueryData(['my-draft', 'u-2'], { id: 'p-synced', name: 'Off-season' }, ago(30 * DAY));
    queryClient.setQueryData(['my-draft', 'u-3'], null, ago(30 * DAY));

    expect(savedKeys(app)).toEqual([
      ['draft-tree', 'p-ahead'],
      ['my-draft', 'u-1'],
    ]);
  });

  it('a query handed over without its timestamps is judged on its key alone', async () => {
    const { shouldPersistQuery } = await launchApp();
    // How the other suites ask "is this key stored".
    const settled = (queryKey) => ({ queryKey, state: { status: 'success' } });

    expect(shouldPersistQuery(settled(['student-program-details', 'u-1', 'active']))).toBe(true);
    expect(shouldPersistQuery(settled(['student-program-details', 'u-1', 'all']))).toBe(false);
    expect(shouldPersistQuery(settled(['session', 's-1']))).toBe(true);
    expect(shouldPersistQuery(settled(['students']))).toBe(false);
    expect(shouldPersistQuery({ queryKey: 'session', state: { status: 'success' } })).toBe(false);
  });
});
