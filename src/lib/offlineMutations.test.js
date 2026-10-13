import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  QueryClient,
  QueryObserver,
  MutationObserver,
  dehydrate,
  hydrate,
  onlineManager,
} from '@tanstack/react-query';
import { createClient } from '@supabase/supabase-js';

vi.mock('./supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: { getSession: vi.fn() } },
}));
vi.mock('./toast', () => ({ pushToast: vi.fn() }));

import { supabase } from './supabase';
import { pushToast } from './toast';
import {
  REPLAY_REFUSED_KEY,
  REJECTED_WRITES_KEY,
  isRefusedReplay,
  readRejectedWrites,
} from './mutationErrors';
import {
  MUTATION_KEYS,
  MUTATION_FNS,
  patchForDone,
  patchForFailed,
  patchForSkipped,
  registerOfflineMutationDefaults,
  resumeMutationsAndReconcileDrafts,
  hasUnsyncedDraft,
} from './offlineMutations';
import { AUTH_WAIT_CAP_MS, isAuthNotReady, isNetworkError } from './networkErrors';
import {
  buildSnapshot,
  isUnsyncedDraft,
  markSynced,
  markUnsynced,
  nextDraftRev,
  unsyncedRev,
} from './draftTree';

// --- PostgREST, as far as a confirm reaches it --------------------------------
// The confirm tests send what confirmSessionFn REALLY sends: the supabase-js
// query builder is the real one and only `fetch` is answered here, by the rules
// PostgREST applies to `POST /session_confirmations`. A mocked `.upsert()`
// chain would only repeat the implementation back; the bug these tests are
// about lives in what the request asks the database to do with a row that is
// already there.
//
//   Prefer: resolution=merge-duplicates   → ON CONFLICT DO UPDATE, row returned
//   Prefer: resolution=ignore-duplicates  → ON CONFLICT DO NOTHING, no row
//   Accept: application/vnd.pgrst.object+json (what `.single()` asks for)
//                                         → 406 PGRST116 unless exactly one row
//
// `.invalid` never resolves (RFC 2606), so a request that escaped the handler
// could not reach anything.
//
// WHO IS ASKING is real too. supabase-js puts the session's access token on a
// request, and its own (anonymous) key when it has no session: here `bearer`
// is that token, `null` for "no session", and `supabase.auth.getSession()` —
// what the app reads — answers from the same variable.
let answer = null;
let bearer = null;
const ANON_KEY = 'anon-key';
const wire = createClient('https://postgrest.invalid', ANON_KEY, {
  accessToken: async () => bearer,
  global: { fetch: (input, init) => answer(input, init) },
});

function signedIn(token = 'athlete-jwt') {
  bearer = token;
}
function signedOut() {
  bearer = null;
}

const reply = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fakeConfirmationsApi({ existing = [], lockedSessionIds = [], refuseInsert = null } = {}) {
  const rows = new Map(existing.map((row) => [row.session_id, { ...row }]));
  const api = { rows, requests: [], writes: 0 };
  let minted = 0;

  answer = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const prefer = headers.get('Prefer') || '';
    const body = init.body ? JSON.parse(init.body) : null;
    api.requests.push({
      method: init.method,
      path: url.pathname,
      onConflict: url.searchParams.get('on_conflict'),
      prefer,
      body,
    });
    if (url.pathname !== '/rest/v1/session_confirmations' || !['POST', 'DELETE'].includes(init.method)) {
      return reply(404, { code: 'PGRST205', message: `not expected: ${init.method} ${url.pathname}` });
    }
    if (init.method === 'DELETE') {
      // Undo: DELETE ... WHERE session_id = eq.<id>; a missing row is no error.
      const sessionId = (url.searchParams.get('session_id') || '').replace(/^eq\./, '');
      if (rows.delete(sessionId)) api.writes += 1;
      return new Response(null, { status: 204 });
    }

    const current = rows.get(body.session_id);
    let returned;
    if (!current) {
      // The INSERT policy (own session, not archived, program writable).
      if (refuseInsert) return reply(403, refuseInsert);
      const row = { id: `c-new-${(minted += 1)}`, confirmed_at: '2026-10-11T09:30:00+00:00', ...body };
      rows.set(row.session_id, row);
      api.writes += 1;
      returned = [row];
    } else if (prefer.includes('resolution=ignore-duplicates')) {
      returned = [];
    } else if (prefer.includes('resolution=merge-duplicates')) {
      // The UPDATE policy: a confirmation is locked once its session is reviewed.
      if (lockedSessionIds.includes(body.session_id)) {
        return reply(403, {
          code: '42501',
          details: null,
          hint: null,
          message: 'new row violates row-level security policy (USING expression) for table "session_confirmations"',
        });
      }
      const row = { ...current, ...body };
      rows.set(row.session_id, row);
      api.writes += 1;
      returned = [row];
    } else {
      return reply(409, {
        code: '23505',
        details: null,
        hint: null,
        message: 'duplicate key value violates unique constraint "session_confirmations_session_id_key"',
      });
    }

    const status = current ? 200 : 201;
    if (!prefer.includes('return=representation')) return new Response(null, { status });
    if ((headers.get('Accept') || '').includes('application/vnd.pgrst.object+json')) {
      if (returned.length !== 1) {
        return reply(406, {
          code: 'PGRST116',
          details: `The result contains ${returned.length} rows`,
          hint: null,
          message: 'JSON object requested, multiple (or no) rows returned',
        });
      }
      return reply(status, returned[0]);
    }
    return reply(status, returned);
  };

  supabase.from.mockImplementation((table) => wire.from(table));
  return api;
}

const onlineDescriptor = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(navigator),
  'onLine'
);

function setOnline(value) {
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => value,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setOnline(true);
  onlineManager.setOnline(true);
  signedIn();
  supabase.auth.getSession.mockImplementation(async () => ({
    data: { session: bearer ? { access_token: bearer, user: { id: 'u-1' } } : null },
    error: null,
  }));
});

afterEach(() => {
  if (onlineDescriptor) {
    Object.defineProperty(Object.getPrototypeOf(navigator), 'onLine', onlineDescriptor);
  }
  onlineManager.setOnline(true);
});

describe('patch helpers', () => {
  it('patchForDone(true) clears any prior failed flag and stamps logged_at', () => {
    const p = patchForDone(true);
    expect(p.done).toBe(true);
    expect(p.failed).toBe(false);
    expect(p.failed_at).toBeNull();
    expect(typeof p.logged_at).toBe('string');
  });

  it('patchForFailed(true) clears done + nulls rpe so the DB CHECKs hold', () => {
    const p = patchForFailed(true);
    expect(p.failed).toBe(true);
    expect(p.done).toBe(false);
    expect(p.logged_at).toBeNull();
    expect(p.rpe).toBeNull();
  });

  it('patchForSkipped(true) clears done/failed/rpe/actuals so skipped is a clean state', () => {
    const p = patchForSkipped(true);
    expect(p.skipped).toBe(true);
    expect(p.done).toBe(false);
    expect(p.failed).toBe(false);
    expect(p.rpe).toBeNull();
    expect(p.actual_reps).toBeNull();
    expect(p.actual_weight_kg).toBeNull();
  });

  it('patchForSkipped(false) only drops the flag', () => {
    const p = patchForSkipped(false);
    expect(p.skipped).toBe(false);
    expect('done' in p).toBe(false);
  });

  // Contract with the set-log hooks: the variables carry `at`, the moment of
  // the tap, and the patch is built from it — the hook's optimistic one and
  // the request's alike.
  describe('the moment of the tap', () => {
    const TAP = '2026-10-09T18:02:11.000Z';

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-11T07:30:00.000Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('a done set is logged at the moment it is given, not at the moment the patch is built', () => {
      expect(patchForDone(true, TAP).logged_at).toBe(TAP);
    });

    it('so is a failed one', () => {
      expect(patchForFailed(true, TAP).failed_at).toBe(TAP);
    });

    it('without one the clock is read, as before', () => {
      expect(patchForDone(true).logged_at).toBe('2026-10-11T07:30:00.000Z');
      expect(patchForFailed(true).failed_at).toBe('2026-10-11T07:30:00.000Z');
    });

    it('a moment is always sent as ISO, whatever shape it arrived in', () => {
      expect(patchForDone(true, Date.parse(TAP)).logged_at).toBe(TAP);
      expect(patchForDone(true, new Date(TAP)).logged_at).toBe(TAP);
      expect(patchForDone(true, '2026-10-09T20:02:11+02:00').logged_at).toBe(TAP);
    });

    it('something that is not a date is not sent: the clock is read instead', () => {
      for (const junk of ['yesterday', '', null, undefined, NaN, 0, {}, new Date('nope')]) {
        expect(patchForDone(true, junk).logged_at).toBe('2026-10-11T07:30:00.000Z');
        expect(patchForFailed(true, junk).failed_at).toBe('2026-10-11T07:30:00.000Z');
      }
    });

    it('taking a set back carries no moment at all', () => {
      expect(patchForDone(false, TAP)).toEqual({ done: false, logged_at: null });
      expect(patchForFailed(false, TAP)).toEqual({ failed: false, failed_at: null });
    });
  });
});

describe('registerOfflineMutationDefaults', () => {
  it('wires every persisted-mutation key to a default mutationFn', () => {
    const qc = new QueryClient();
    registerOfflineMutationDefaults(qc);
    for (const key of Object.values(MUTATION_KEYS)) {
      const defaults = qc.getMutationDefaults(key);
      expect(defaults).toBeDefined();
      expect(typeof defaults.mutationFn).toBe('function');
      expect(defaults.networkMode).toBe('online');
    }
  });

  it('replays a queued toggle-done mutation against supabase once online', async () => {
    // React Query's onlineManager is the authoritative gate for networkMode;
    // navigator.onLine alone won't trigger the pause behavior in jsdom.
    onlineManager.setOnline(false);
    setOnline(false);
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'l-1', done: true }, error: null }),
    };
    supabase.from.mockReturnValue(updateChain);

    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { retry: false, networkMode: 'online' },
      },
    });
    registerOfflineMutationDefaults(qc);

    // Fire the mutation while offline — it should pause without ever calling
    // supabase.from.
    qc.getMutationCache()
      .build(qc, {
        mutationKey: MUTATION_KEYS.toggleDone,
        ...qc.getMutationDefaults(MUTATION_KEYS.toggleDone),
      })
      .execute({ logId: 'l-1', done: true });

    await new Promise((r) => setTimeout(r, 0));
    expect(supabase.from).not.toHaveBeenCalled();
    const paused = qc.getMutationCache().getAll().filter((m) => m.state.isPaused);
    expect(paused).toHaveLength(1);

    // Come back online and resume — the queued mutation now hits supabase.
    setOnline(true);
    onlineManager.setOnline(true);
    await qc.resumePausedMutations();
    expect(supabase.from).toHaveBeenCalledWith('set_logs');
    const payload = updateChain.update.mock.calls[0][0];
    expect(payload.done).toBe(true);
    expect(payload.failed).toBe(false);
  });

  it('registers a FIFO scope on every default — authoring gets its own lane', () => {
    const qc = new QueryClient();
    registerOfflineMutationDefaults(qc);
    for (const [name, key] of Object.entries(MUTATION_KEYS)) {
      const expected = name === 'saveDraftTree' || name === 'discardDraft' ? 'draft-tree' : 'offline-writes';
      expect(qc.getMutationDefaults(key).scope).toEqual({ id: expected });
    }
  });

  it('the draft-save default carries onError/onSuccess/skipErrorToast (so a hydrated resume is not silent)', () => {
    const qc = new QueryClient();
    registerOfflineMutationDefaults(qc);
    const d = qc.getMutationDefaults(MUTATION_KEYS.saveDraftTree);
    expect(typeof d.onError).toBe('function');
    expect(typeof d.onSuccess).toBe('function');
    expect(d.meta).toEqual({ skipErrorToast: true });
  });

  it('replays queued writes serially in FIFO order (shared scope)', async () => {
    // Two OPPOSITE writes to the same row queued offline: done → un-done.
    // Without the shared scope, resumePausedMutations() is Promise.all and
    // the slower first request can land last, flipping the final state back
    // to done. The scope must force strict FIFO: the second write may only
    // start after the first has finished.
    onlineManager.setOnline(false);
    setOnline(false);

    const finished = [];
    let call = 0;
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockImplementation(() => {
        const n = ++call;
        // The FIRST replay resolves much slower than the second — parallel
        // replay would finish [2, 1]; serial replay must finish [1, 2].
        const delay = n === 1 ? 30 : 0;
        return new Promise((resolve) =>
          setTimeout(() => {
            finished.push(n);
            resolve({ data: { id: 'l-1' }, error: null });
          }, delay)
        );
      }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { retry: false, networkMode: 'online' },
      },
    });
    registerOfflineMutationDefaults(qc);
    const defaults = qc.getMutationDefaults(MUTATION_KEYS.toggleDone);

    qc.getMutationCache()
      .build(qc, { mutationKey: MUTATION_KEYS.toggleDone, ...defaults })
      .execute({ logId: 'l-1', done: true });
    qc.getMutationCache()
      .build(qc, { mutationKey: MUTATION_KEYS.toggleDone, ...defaults })
      .execute({ logId: 'l-1', done: false });

    await new Promise((r) => setTimeout(r, 0));
    expect(supabase.from).not.toHaveBeenCalled();

    setOnline(true);
    onlineManager.setOnline(true);
    await qc.resumePausedMutations();

    expect(finished).toEqual([1, 2]);
    // Last-writer-wins now matches user intent: the un-done write landed last.
    expect(chain.update.mock.calls[0][0].done).toBe(true);
    expect(chain.update.mock.calls[1][0].done).toBe(false);
  });
});

// The app's client, as far as writes go: lib/queryClient.js leaves "no retry"
// as the default of every mutation and registers the queue's own defaults.
function offlineQueue() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, networkMode: 'online' },
    },
  });
  registerOfflineMutationDefaults(qc);
  return qc;
}

// Run a write the way a hydrated mutation runs: options from the registered
// defaults only, no hook around it.
function enqueue(qc, mutationKey, variables, extra = {}) {
  const mutation = qc.getMutationCache().build(qc, {
    mutationKey,
    ...qc.getMutationDefaults(mutationKey),
    ...extra,
  });
  mutation.execute(variables).catch(() => {});
  return mutation;
}

// B13. A confirm is insert-or-nothing: the first confirmation of a session
// stays, whatever a later confirm carries. The later one is not exotic — it is
// the replay of a confirm whose first attempt reached the server but whose
// answer never came back, or a second device whose persisted cache still shows
// the session as unconfirmed.
describe('confirmSession: the first confirmation of a session is the one that stays', () => {
  // What the athlete wrote on the phone, the day of the session.
  const FIRST = {
    id: 'c-1',
    session_id: 's-1',
    student_id: 'u-1',
    confirmed_at: '2026-10-09T18:02:11+00:00',
    performed_on: '2026-10-09',
    notes: 'left shoulder pinched on OHP',
  };
  // The second confirm: no note, and the date its device fell back to.
  const SECOND = { sessionId: 's-1', studentId: 'u-1', notes: null, performedOn: '2026-10-11' };

  afterEach(() => {
    supabase.from.mockReset();
    answer = null;
  });

  const queueConfirm = (qc, variables) => enqueue(qc, MUTATION_KEYS.confirmSession, variables);

  it('a first confirm inserts the row and resolves it', async () => {
    const api = fakeConfirmationsApi();

    const row = await MUTATION_FNS.confirmSession({
      sessionId: 's-1',
      studentId: 'u-1',
      notes: 'felt good',
      performedOn: '2026-10-09',
    });

    expect(row).toMatchObject({
      session_id: 's-1',
      student_id: 'u-1',
      notes: 'felt good',
      performed_on: '2026-10-09',
    });
    expect(row.id).toBeTruthy();
    expect(api.writes).toBe(1);
    expect(api.rows.get('s-1')).toEqual(row);
  });

  it('asks the database to do nothing on a conflict, not to update', async () => {
    const api = fakeConfirmationsApi();

    await MUTATION_FNS.confirmSession(SECOND);

    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toMatchObject({
      method: 'POST',
      path: '/rest/v1/session_confirmations',
      onConflict: 'session_id',
    });
    expect(api.requests[0].prefer).toContain('resolution=ignore-duplicates');
    expect(api.requests[0].prefer).not.toContain('merge-duplicates');
  });

  it('a confirm replayed against a session already confirmed resolves without error and without a write', async () => {
    const api = fakeConfirmationsApi({ existing: [FIRST] });
    onlineManager.setOnline(false);
    setOnline(false);
    const qc = offlineQueue();

    const mutation = queueConfirm(qc, SECOND);
    await new Promise((r) => setTimeout(r, 0));
    expect(mutation.state.isPaused).toBe(true);
    expect(api.requests).toHaveLength(0);

    setOnline(true);
    onlineManager.setOnline(true);
    await qc.resumePausedMutations();

    await vi.waitFor(() => expect(mutation.state.status).not.toBe('pending'));
    // One request, and it changed nothing: the note the coach may have read
    // and the day the athlete trained are the first confirm's.
    expect(api.requests).toHaveLength(1);
    expect(api.rows.get('s-1')).toEqual(FIRST);
    expect(api.writes).toBe(0);
    // Settled as a success — an error here is a toast and a rolled-back screen
    // for a session that IS confirmed.
    expect(mutation.state.error).toBeNull();
    expect(mutation.state.status).toBe('success');
    // Nothing was inserted, so there is no row to hand back.
    expect(mutation.state.data).toBeNull();
  });

  it('is not refused once the coach has reviewed the session', async () => {
    // Lock after review: the database no longer lets the athlete UPDATE the
    // confirmation of a reviewed session. An insert-or-update replay runs into
    // that refusal; an insert-or-nothing one never reaches the UPDATE policy.
    const api = fakeConfirmationsApi({ existing: [FIRST], lockedSessionIds: ['s-1'] });

    await expect(MUTATION_FNS.confirmSession(SECOND)).resolves.toBeNull();

    expect(api.writes).toBe(0);
    expect(api.rows.get('s-1')).toEqual(FIRST);
  });

  it('still fails when the database refuses the insert itself', async () => {
    // A duplicate is the only refusal that became a no-op. A session archived
    // or a block deactivated in the meantime must still surface.
    const api = fakeConfirmationsApi({
      refuseInsert: {
        code: '42501',
        details: null,
        hint: null,
        message: 'new row violates row-level security policy for table "session_confirmations"',
      },
    });
    const qc = offlineQueue();

    const mutation = queueConfirm(qc, SECOND);
    await vi.waitFor(() => expect(mutation.state.status).toBe('error'));

    expect(mutation.state.error).toMatchObject({ code: '42501' });
    expect(api.writes).toBe(0);
    expect(api.rows.size).toBe(0);
  });

  it('undo, then confirm again, still replaces the note', async () => {
    // The one way the app offers to change a confirmation, queued offline and
    // replayed in order: after the DELETE the confirm is a first confirm again,
    // so "do nothing on a conflict" must not keep the old row alive.
    const api = fakeConfirmationsApi({ existing: [FIRST] });
    onlineManager.setOnline(false);
    setOnline(false);
    const qc = offlineQueue();

    enqueue(qc, MUTATION_KEYS.unconfirmSession, { sessionId: 's-1' });
    const again = queueConfirm(qc, { ...SECOND, notes: 'shoulder fine after warm-up' });
    await new Promise((r) => setTimeout(r, 0));
    expect(api.requests).toHaveLength(0);

    setOnline(true);
    onlineManager.setOnline(true);
    await qc.resumePausedMutations();

    await vi.waitFor(() => expect(again.state.status).not.toBe('pending'));
    expect(api.requests.map((r) => r.method)).toEqual(['DELETE', 'POST']);
    expect(again.state.status).toBe('success');
    expect(again.state.data).toMatchObject({
      session_id: 's-1',
      notes: 'shoulder fine after warm-up',
      performed_on: '2026-10-11',
    });
    expect(api.rows.get('s-1')).toEqual(again.state.data);
    expect(api.rows.get('s-1').id).not.toBe(FIRST.id);
  });
});

// --- PostgREST, as far as a ticked set reaches it ------------------------------
// PATCH /set_logs?id=eq.<id>, read back with `.single()`, answered by who is
// asking. RLS shows an athlete's sets to that athlete. To the anonymous key —
// what supabase-js sends when it has no session — the row does not exist, and
// `.single()` on no row is a 406 with PGRST116: a refusal with a code, the
// same answer a session archived in the meantime gets.
const NO_ROW = {
  code: 'PGRST116',
  details: 'The result contains 0 rows',
  hint: null,
  message: 'Cannot coerce the result to a single JSON object',
};

function fakeSetLogsApi() {
  const table = new Map([['l-1', { id: 'l-1', done: false, failed: false, logged_at: null }]]);
  const api = {
    table,
    // Every request that left the app, answered or not.
    attempts: [],
    // true: `fetch` rejects, as it does without a usable network.
    down: false,
    // A function giving the Response something else sends in PostgREST's place.
    instead: null,
  };
  answer = async (input, init = {}) => {
    const url = new URL(String(input));
    const who = (new Headers(init.headers).get('Authorization') || '').replace(/^Bearer /, '');
    api.attempts.push({ method: init.method, path: url.pathname, bearer: who });
    if (api.down) throw new TypeError('Failed to fetch');
    if (api.instead) return api.instead();
    const id = (url.searchParams.get('id') || '').replace(/^eq\./, '');
    const row = who === ANON_KEY ? undefined : table.get(id);
    if (!row) return reply(406, NO_ROW);
    Object.assign(row, JSON.parse(init.body));
    return reply(200, row);
  };
  supabase.from.mockImplementation((name) => wire.from(name));
  return api;
}

const TICK = { logId: 'l-1', done: true };

// The clock of these tests is a fake one: the waits between two attempts are
// what is being tested. `pass(ms)` lets that much time go by, then lets
// whatever it started (a request, its answer) run until the next wait.
function useFakeClock() {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    supabase.from.mockReset();
    answer = null;
  });
}

async function pass(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(0);
  }
}

// P4. A write that got no answer was a failed write: `retry: 0`. On a phone the
// `online` event comes before the network is usable, so the first request of
// every queued write failed, a failed mutation is not persisted again, and a
// hydrated one has no rollback: the workout was gone at the very moment it was
// being synced.
describe('a queued write on a network that does not answer', () => {
  useFakeClock();

  it('is sent again after 1, 2, 4, 8 and 16 seconds, and fails for good on the sixth attempt', async () => {
    const api = fakeSetLogsApi();
    api.down = true;
    const qc = offlineQueue();

    const mutation = enqueue(qc, MUTATION_KEYS.toggleDone, TICK);
    await pass();
    expect(api.attempts).toHaveLength(1);
    // Not failed, and not paused either: the device says it is online.
    expect(mutation.state).toMatchObject({ status: 'pending', isPaused: false, failureCount: 1 });
    expect(isNetworkError(mutation.state.failureReason)).toBe(true);

    let sent = 1;
    for (const wait of [1000, 2000, 4000, 8000, 16000]) {
      await pass(wait - 1);
      expect(api.attempts).toHaveLength(sent);
      await pass(1);
      sent += 1;
      expect(api.attempts).toHaveLength(sent);
    }

    expect(mutation.state.status).toBe('error');
    expect(isNetworkError(mutation.state.error)).toBe(true);
    await pass(10 * 60_000);
    expect(api.attempts).toHaveLength(6);
  });

  it('goes through as soon as the network answers: one row, written once', async () => {
    const api = fakeSetLogsApi();
    api.down = true;
    const qc = offlineQueue();

    const mutation = enqueue(qc, MUTATION_KEYS.toggleDone, TICK);
    await pass();
    await pass(1000);
    expect(api.attempts).toHaveLength(2);
    expect(api.table.get('l-1').done).toBe(false);

    api.down = false;
    await pass(2000);

    expect(api.attempts).toHaveLength(3);
    expect(mutation.state.status).toBe('success');
    expect(mutation.state.error).toBeNull();
    expect(api.table.get('l-1').done).toBe(true);
    await pass(10 * 60_000);
    expect(api.attempts).toHaveLength(3);
  });

  it('is paused, not failed, when the device goes offline between two attempts', async () => {
    const api = fakeSetLogsApi();
    api.down = true;
    const qc = offlineQueue();

    const mutation = enqueue(qc, MUTATION_KEYS.toggleDone, TICK);
    await pass();
    expect(api.attempts).toHaveLength(1);

    // The phone has noticed by now.
    setOnline(false);
    onlineManager.setOnline(false);
    await pass(1000);

    expect(api.attempts).toHaveLength(1);
    expect(mutation.state).toMatchObject({ status: 'pending', isPaused: true });
    // Paused is the state the persister stores: killing the app now loses nothing.
    expect(dehydrate(qc).mutations).toHaveLength(1);
    await pass(10 * 60_000);
    expect(api.attempts).toHaveLength(1);
    expect(mutation.state.status).toBe('pending');

    api.down = false;
    setOnline(true);
    onlineManager.setOnline(true);
    await qc.resumePausedMutations();
    await pass();

    expect(api.attempts).toHaveLength(2);
    expect(mutation.state.status).toBe('success');
    expect(api.table.get('l-1').done).toBe(true);
  });

  it('a refusal fails at once: the database has answered, and would answer the same again', async () => {
    const api = fakeSetLogsApi();
    // The set is no longer the athlete's to write (its session was archived).
    api.table.delete('l-1');
    const qc = offlineQueue();

    const mutation = enqueue(qc, MUTATION_KEYS.toggleDone, TICK);
    await pass();

    expect(mutation.state.status).toBe('error');
    expect(mutation.state.error).toMatchObject({ code: 'PGRST116' });
    await pass(10 * 60_000);
    expect(api.attempts).toHaveLength(1);
  });

  it('a refused insert fails at once too', async () => {
    const api = fakeSetLogsApi();
    api.instead = () =>
      reply(403, {
        code: '42501',
        details: null,
        hint: null,
        message: 'new row violates row-level security policy for table "set_logs"',
      });
    const qc = offlineQueue();

    const mutation = enqueue(qc, MUTATION_KEYS.toggleDone, TICK);
    await pass();
    await pass(10 * 60_000);

    expect(mutation.state.status).toBe('error');
    expect(mutation.state.error).toMatchObject({ code: '42501' });
    expect(api.attempts).toHaveLength(1);
  });

  it('a database that says "not now" is asked again: a code, but not a refusal', async () => {
    const api = fakeSetLogsApi();
    // PostgREST while it rebuilds its schema cache — what the NOTIFY at the
    // end of a migration triggers, on production, under a syncing phone.
    api.instead = () =>
      reply(503, {
        code: 'PGRST002',
        details: null,
        hint: null,
        message: 'Could not query the database for the schema cache. Retrying.',
      });
    const qc = offlineQueue();

    const mutation = enqueue(qc, MUTATION_KEYS.toggleDone, TICK);
    await pass();
    expect(api.attempts).toHaveLength(1);
    expect(mutation.state.status).toBe('pending');

    api.instead = null;
    await pass(1000);

    expect(api.attempts).toHaveLength(2);
    expect(mutation.state.status).toBe('success');
  });

  it('so is a gateway that answers in the database\'s place', async () => {
    const api = fakeSetLogsApi();
    api.instead = () =>
      new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      });
    const qc = offlineQueue();

    const mutation = enqueue(qc, MUTATION_KEYS.toggleDone, TICK);
    await pass();
    expect(mutation.state.status).toBe('pending');

    api.instead = null;
    await pass(1000);

    expect(api.attempts).toHaveLength(2);
    expect(mutation.state.status).toBe('success');
  });

  it('a tick made through a hook is retried the same way: it names the key, the policy comes with it', async () => {
    const api = fakeSetLogsApi();
    api.down = true;
    const qc = offlineQueue();
    // What useToggleSetDone passes to useMutation, and nothing more.
    const observer = new MutationObserver(qc, {
      mutationKey: MUTATION_KEYS.toggleDone,
      mutationFn: MUTATION_FNS.toggleDone,
      scope: { id: 'set-log-l-1' },
    });

    observer.mutate(TICK).catch(() => {});
    await pass();
    expect(api.attempts).toHaveLength(1);
    expect(observer.getCurrentResult()).toMatchObject({ status: 'pending', failureCount: 1 });

    api.down = false;
    await pass(1000);

    expect(api.attempts).toHaveLength(2);
    expect(observer.getCurrentResult().status).toBe('success');
  });
});

// P4, the other half. supabase-js sends a request with its anonymous key when
// it has no session — and it has none while an expired token cannot be
// refreshed, the usual state of a phone coming back to a bad network. The
// database refuses the anonymous write with a code, like any refusal: final.
describe('a queued write while nobody is signed in', () => {
  useFakeClock();

  it('what it would have been: an anonymous request, refused with a code', async () => {
    const api = fakeSetLogsApi();
    signedOut();

    // The function called directly, as nothing in the app does: no client, so
    // no gate in front of the request.
    await expect(MUTATION_FNS.toggleDone(TICK)).rejects.toMatchObject({ code: 'PGRST116' });

    expect(api.attempts).toEqual([{ method: 'PATCH', path: '/rest/v1/set_logs', bearer: ANON_KEY }]);
    expect(api.table.get('l-1').done).toBe(false);
  });

  it('is not sent, and is not lost: it waits, however long', async () => {
    const api = fakeSetLogsApi();
    signedOut();
    const qc = offlineQueue();

    const mutation = enqueue(qc, MUTATION_KEYS.toggleDone, TICK);
    await pass();

    expect(api.attempts).toHaveLength(0);
    expect(mutation.state).toMatchObject({ status: 'pending', error: null });
    expect(isAuthNotReady(mutation.state.failureReason)).toBe(true);

    await pass(30 * 60_000);

    expect(api.attempts).toHaveLength(0);
    expect(mutation.state.status).toBe('pending');
    // Far past the five retries a network failure gets.
    expect(mutation.state.failureCount).toBeGreaterThan(50);
  });

  it('is sent once its owner is back — one request, with the owner\'s token', async () => {
    const api = fakeSetLogsApi();
    signedOut();
    const qc = offlineQueue();
    const mutation = enqueue(qc, MUTATION_KEYS.toggleDone, TICK);
    await pass(5 * 60_000);
    expect(api.attempts).toHaveLength(0);

    signedIn('athlete-jwt');
    await pass(AUTH_WAIT_CAP_MS);

    expect(api.attempts).toEqual([{ method: 'PATCH', path: '/rest/v1/set_logs', bearer: 'athlete-jwt' }]);
    expect(mutation.state.status).toBe('success');
    expect(api.table.get('l-1').done).toBe(true);
    await pass(10 * 60_000);
    expect(api.attempts).toHaveLength(1);
  });

  it('a session that cannot be read is no session', async () => {
    const api = fakeSetLogsApi();
    // The token expired and its refresh got no answer: supabase-js keeps the
    // stored session and hands back none.
    supabase.auth.getSession.mockResolvedValueOnce({
      data: { session: null },
      error: Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 }),
    });
    // And the auth lock timing out, which is a throw.
    supabase.auth.getSession.mockRejectedValueOnce(new Error('Acquiring an exclusive Navigator LockManager lock timed out'));
    const qc = offlineQueue();

    const mutation = enqueue(qc, MUTATION_KEYS.toggleDone, TICK);
    await pass();
    expect(api.attempts).toHaveLength(0);
    expect(isAuthNotReady(mutation.state.failureReason)).toBe(true);

    await pass(1000);
    expect(api.attempts).toHaveLength(0);
    expect(mutation.state).toMatchObject({ status: 'pending', failureCount: 2 });

    // Third read: the refresh went through.
    await pass(2000);
    expect(api.attempts).toHaveLength(1);
    expect(mutation.state.status).toBe('success');
  });

  it('waiting is not a failed send: the write still has its five retries afterwards', async () => {
    const api = fakeSetLogsApi();
    api.down = true;
    signedOut();
    const qc = offlineQueue();
    const mutation = enqueue(qc, MUTATION_KEYS.toggleDone, TICK);
    await pass(5 * 60_000);
    expect(mutation.state.failureCount).toBeGreaterThan(5);
    expect(api.attempts).toHaveLength(0);

    // The token refresh finally passes; the network is still what it was.
    signedIn();
    await pass(AUTH_WAIT_CAP_MS);
    expect(api.attempts).toHaveLength(1);
    expect(mutation.state.status).toBe('pending');

    let sent = 1;
    for (const wait of [1000, 2000, 4000, 8000]) {
      await pass(wait);
      sent += 1;
      expect(api.attempts).toHaveLength(sent);
      expect(mutation.state.status).toBe('pending');
    }

    api.down = false;
    await pass(16000);
    expect(api.attempts).toHaveLength(6);
    expect(mutation.state.status).toBe('success');
  });

  it('is a paused mutation when the device is offline as well, so the persister keeps it', async () => {
    const api = fakeSetLogsApi();
    signedOut();
    const qc = offlineQueue();
    const mutation = enqueue(qc, MUTATION_KEYS.toggleDone, TICK);
    await pass();
    expect(mutation.state.isPaused).toBe(false);

    setOnline(false);
    onlineManager.setOnline(false);
    await pass(1000);

    expect(mutation.state).toMatchObject({ status: 'pending', isPaused: true });
    expect(dehydrate(qc).mutations).toHaveLength(1);
    expect(api.attempts).toHaveLength(0);
  });

  it('writes behind it in the queue wait with it, and go out in order', async () => {
    const api = fakeSetLogsApi();
    signedOut();
    const qc = offlineQueue();
    const done = enqueue(qc, MUTATION_KEYS.toggleDone, { logId: 'l-1', done: true });
    const undone = enqueue(qc, MUTATION_KEYS.toggleDone, { logId: 'l-1', done: false });
    await pass(60_000);
    expect(api.attempts).toHaveLength(0);
    expect(undone.state).toMatchObject({ status: 'pending', isPaused: true });

    signedIn();
    await pass(AUTH_WAIT_CAP_MS);

    expect(api.attempts).toHaveLength(2);
    expect(done.state.status).toBe('success');
    expect(undone.state.status).toBe('success');
    // The last word is the athlete's last tap.
    expect(api.table.get('l-1').done).toBe(false);
  });

  it('of a queue that was cleared is never sent with the next account\'s session', async () => {
    const api = fakeSetLogsApi();
    signedOut();
    const qc = offlineQueue();
    const onError = vi.fn();
    const onSettled = vi.fn();
    const mutation = enqueue(qc, MUTATION_KEYS.toggleDone, TICK, { onError, onSettled });
    await pass();
    expect(isAuthNotReady(mutation.state.failureReason)).toBe(true);

    // The account changes: App.jsx empties the client. A mutation asleep
    // between two attempts is not stopped by that.
    qc.clear();
    signedIn('coach-jwt');
    await pass(30 * 60_000);

    // The coach's session can write an athlete's set: this request would have
    // gone through.
    expect(api.attempts).toHaveLength(0);
    expect(api.table.get('l-1').done).toBe(false);
    // And no handler ran: a rollback would put the previous account's rows
    // back into the emptied cache.
    expect(onError).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
    // It is over, not still asking.
    const reads = supabase.auth.getSession.mock.calls.length;
    await pass(30 * 60_000);
    expect(supabase.auth.getSession.mock.calls).toHaveLength(reads);
  });

  it('nor is one that was between two network retries when the queue was cleared', async () => {
    const api = fakeSetLogsApi();
    api.down = true;
    const qc = offlineQueue();
    enqueue(qc, MUTATION_KEYS.toggleDone, TICK);
    await pass();
    expect(api.attempts).toHaveLength(1);

    qc.clear();
    signedIn('coach-jwt');
    api.down = false;
    await pass(10 * 60_000);

    expect(api.attempts).toHaveLength(1);
    expect(api.table.get('l-1').done).toBe(false);
  });

  it('is only held back on a client that can wait: without the retry policy the write goes out as before', async () => {
    const api = fakeSetLogsApi();
    signedOut();
    // What a hook's own test builds. Here AuthNotReadyError would be a
    // failure, final — the loss the gate exists to prevent.
    const bare = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const observer = new MutationObserver(bare, {
      mutationKey: MUTATION_KEYS.toggleDone,
      mutationFn: MUTATION_FNS.toggleDone,
    });

    observer.mutate(TICK).catch(() => {});
    await pass();

    expect(supabase.auth.getSession).not.toHaveBeenCalled();
    expect(api.attempts).toHaveLength(1);
  });
});

// The gate above answers something supabase-js does, and the tests above stand
// in for it (`bearer = null`). This one does not: the client is whole, auth
// included, with a stored session whose token has run out and a token endpoint
// that does not answer. If an upgrade of supabase-js changes what follows, the
// gate has to be looked at again.
describe('the premise: supabase-js and a token it cannot refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports no session, keeps the stored one, and sends the next write with the anonymous key', async () => {
    const STORAGE_KEY = 'sb-premise-auth-token';
    const stored = new Map();
    const storage = {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => void stored.set(key, value),
      removeItem: (key) => void stored.delete(key),
    };
    stored.set(
      STORAGE_KEY,
      JSON.stringify({
        access_token: 'expired-jwt',
        refresh_token: 'refresh-1',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) - 60,
        user: { id: 'u-1' },
      }),
    );
    const sentAs = [];
    const client = createClient('https://premise.invalid', ANON_KEY, {
      auth: { storage, storageKey: STORAGE_KEY, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        fetch: async (input, init = {}) => {
          // The token endpoint: no answer. PostgREST: reachable, as on a
          // network where one request in two gets through.
          if (String(input).includes('/auth/v1/')) throw new TypeError('Failed to fetch');
          sentAs.push(new Headers(init.headers).get('Authorization'));
          return reply(406, NO_ROW);
        },
      },
    });

    // auth-js tries the refresh again for a while before it gives up, and
    // logs every failed try.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reading = client.auth.getSession();
    await pass(60_000);
    const { data, error } = await reading;

    expect(data.session).toBeNull();
    expect(error?.name).toBe('AuthRetryableFetchError');
    // Not a sign-out: the session is still on the device, for the next try.
    expect(JSON.parse(stored.get(STORAGE_KEY)).refresh_token).toBe('refresh-1');

    // (A query builder sends nothing until it is awaited: `then` starts it.)
    const writing = client
      .from('set_logs')
      .update({ done: true })
      .eq('id', 'l-1')
      .select()
      .single()
      .then((answerOfTheWrite) => answerOfTheWrite);
    await pass(60_000);
    const answerOfTheWrite = await writing;
    logged.mockRestore();

    // The write went out — as nobody — and the database refused it for good.
    expect(sentAs).toEqual([`Bearer ${ANON_KEY}`]);
    expect(answerOfTheWrite.error).toMatchObject({ code: 'PGRST116' });
  });
});

// The queue after the app was killed and opened again: what the persister
// stored — the paused mutations, through JSON — restored into a new client.
// Nothing of the hook that made a write survives this: no closure, no
// callback, only the key, the variables and the state.
function relaunch(phone) {
  const stored = JSON.parse(JSON.stringify(dehydrate(phone)));
  const qc = offlineQueue();
  hydrate(qc, stored);
  return qc;
}

function goOffline() {
  setOnline(false);
  onlineManager.setOnline(false);
}

function comeBackOnline() {
  setOnline(true);
  onlineManager.setOnline(true);
}

// P23. `logged_at` and `failed_at` were read from the clock inside the
// mutation function: a set ticked in a basement was dated at the moment the
// phone found a network again. `performed_on`, "N days ago", the recent
// records and the bodyweight of a ×BW ratio all followed the wrong day.
describe('a set is dated at the tap, whenever it is sent', () => {
  useFakeClock();

  const TAP = '2026-10-09T18:02:11.000Z';
  const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.setSystemTime(new Date(TAP));
  });

  it('a set ticked offline and replayed two days later, after a relaunch, keeps the moment of the tap', async () => {
    const api = fakeSetLogsApi();
    goOffline();
    const phone = offlineQueue();
    // What the set-log hook sends: the tap time is one of the variables.
    enqueue(phone, MUTATION_KEYS.toggleDone, { logId: 'l-1', done: true, at: TAP });
    await pass();

    const qc = relaunch(phone);
    await pass(TWO_DAYS);
    comeBackOnline();
    await qc.resumePausedMutations();
    await pass();

    expect(api.attempts).toHaveLength(1);
    expect(api.table.get('l-1')).toMatchObject({ done: true, logged_at: TAP });
  });

  it('a failed set too', async () => {
    const api = fakeSetLogsApi();
    goOffline();
    const phone = offlineQueue();
    enqueue(phone, MUTATION_KEYS.setFailed, { logId: 'l-1', failed: true, at: TAP });
    await pass();

    const qc = relaunch(phone);
    await pass(TWO_DAYS);
    comeBackOnline();
    await qc.resumePausedMutations();
    await pass();

    expect(api.table.get('l-1')).toMatchObject({ failed: true, failed_at: TAP, logged_at: null });
  });

  it('a write that waited in this page, without a relaunch, keeps it as well', async () => {
    const api = fakeSetLogsApi();
    goOffline();
    const qc = offlineQueue();
    enqueue(qc, MUTATION_KEYS.toggleDone, { logId: 'l-1', done: true, at: TAP });
    await pass(3 * 60 * 60 * 1000);

    comeBackOnline();
    await qc.resumePausedMutations();
    await pass();

    expect(api.table.get('l-1').logged_at).toBe(TAP);
  });

  it('a write queued by an older build carries no tap time: it is dated when it was made, which the queue stored', async () => {
    const api = fakeSetLogsApi();
    goOffline();
    const phone = offlineQueue();
    // The variables of the build deployed before this rule.
    const made = enqueue(phone, MUTATION_KEYS.toggleDone, { logId: 'l-1', done: true });
    await pass();
    expect(made.state.submittedAt).toBe(Date.parse(TAP));

    const qc = relaunch(phone);
    await pass(TWO_DAYS);
    comeBackOnline();
    await qc.resumePausedMutations();
    await pass();

    expect(api.table.get('l-1')).toMatchObject({ done: true, logged_at: TAP });
  });

  it('a tap time that cannot be read does not cost the set: it falls back on when the write was made', async () => {
    const api = fakeSetLogsApi();
    goOffline();
    const phone = offlineQueue();
    enqueue(phone, MUTATION_KEYS.setFailed, { logId: 'l-1', failed: true, at: 'not a date' });
    await pass();

    const qc = relaunch(phone);
    await pass(TWO_DAYS);
    comeBackOnline();
    await qc.resumePausedMutations();
    await pass();

    expect(api.table.get('l-1')).toMatchObject({ failed: true, failed_at: TAP });
  });

  it('a tick sent at once through a hook is dated by its variables, not by the request', async () => {
    const api = fakeSetLogsApi();
    const qc = offlineQueue();
    const observer = new MutationObserver(qc, {
      mutationKey: MUTATION_KEYS.toggleDone,
      mutationFn: MUTATION_FNS.toggleDone,
      scope: { id: 'set-log-l-1' },
    });
    // The network is slow to answer the session read: the request leaves late.
    supabase.auth.getSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ data: { session: { access_token: bearer, user: { id: 'u-1' } } }, error: null }), 20_000);
        })
    );

    observer.mutate({ logId: 'l-1', done: true, at: TAP }).catch(() => {});
    await pass(20_000);

    expect(observer.getCurrentResult().status).toBe('success');
    expect(api.table.get('l-1').logged_at).toBe(TAP);
  });

  it('the function called with nothing to go by reads the clock', async () => {
    const api = fakeSetLogsApi();
    await pass(TWO_DAYS);

    await MUTATION_FNS.toggleDone({ logId: 'l-1', done: true });

    expect(api.table.get('l-1').logged_at).toBe(new Date(Date.parse(TAP) + TWO_DAYS).toISOString());
  });
});

// --- PostgREST, for a whole workout ---------------------------------------------
// The sets (PATCH, read back with `.single()`), the confirmation, a note and a
// swap (POST with on_conflict), the undo (DELETE). `closed` is the session as
// the coach left it while the phone was offline — the next block activated,
// the session reviewed or archived: an UPDATE then matches no row the athlete
// may write (406 PGRST116) and an INSERT is turned down by its policy (403
// 42501). `refuse` answers every write with that body instead.
function fakeWorkoutApi({ sets = ['l-1'] } = {}) {
  const api = {
    sets: new Map(sets.map((id) => [id, { id, done: false, failed: false, logged_at: null }])),
    requests: [],
    closed: false,
    refuse: null,
  };
  answer = async (input, init = {}) => {
    const url = new URL(String(input));
    const table = url.pathname.replace('/rest/v1/', '');
    const body = init.body ? JSON.parse(init.body) : null;
    api.requests.push({ method: init.method, table, body });
    if (api.refuse) return reply(400, api.refuse);
    if (table === 'set_logs') {
      const id = (url.searchParams.get('id') || '').replace(/^eq\./, '');
      const row = api.closed ? undefined : api.sets.get(id);
      if (!row) return reply(406, NO_ROW);
      Object.assign(row, body);
      return reply(200, row);
    }
    if (api.closed) {
      return reply(403, {
        code: '42501',
        details: null,
        hint: null,
        message: `new row violates row-level security policy for table "${table}"`,
      });
    }
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    return reply(201, { id: `${table}-1`, ...body });
  };
  supabase.from.mockImplementation((name) => wire.from(name));
  return api;
}

const CONFIRM = { sessionId: 's-1', studentId: 'u-1', notes: 'felt good', performedOn: '2026-10-09' };

// Every read a page of the athlete may hold while a workout is replayed.
const CONFIRMATION_READS = [
  ['session-confirmation', 's-1'],
  ['my-confirmed-session-ids', 'u-1'],
  ['week-confirmed-session-ids', 'w-1'],
  ['program-confirmed-session-ids', 'p-1'],
  ['student-progress-stats', 'u-1', 'active'],
  ['student-records', 'u-1'],
  ['student-lifetime-stats', 'u-1'],
  // "Last time" of the NEXT session: the app's client holds the athlete's own
  // hints as fresh for hours (lib/queryClient.js), on the strength of this.
  ['last-performance', 'self', 's-2', ['ex-1']],
];
const OTHER_READS = [
  ['session', 's-1'],
  ['set-logs', 's-1', ['slot-1']],
  ['slot-comments', 's-1'],
  ['slot-comments', 's-2'],
  ['slot-deviations', 's-1'],
  ['slot-deviations', 's-2'],
  ['student-program-details', 'u-1', 'active'],
  // "Last time" of the session being confirmed: never about its own sets.
  ['last-performance', 'self', 's-1', ['ex-1']],
];

function seedReads(qc) {
  for (const key of [...CONFIRMATION_READS, ...OTHER_READS]) qc.setQueryData(key, []);
}

// The reads the client now holds as out of date.
function staleReads(qc) {
  return qc
    .getQueryCache()
    .getAll()
    .filter((query) => query.state.isInvalidated)
    .map((query) => query.queryKey);
}

// A workout written without signal, the app killed, opened again with a
// network: the writes restored from storage, about to be replayed.
async function workoutRestored(writes) {
  goOffline();
  const phone = offlineQueue();
  for (const [key, variables, extra] of writes) enqueue(phone, key, variables, extra);
  await pass();
  const qc = relaunch(phone);
  seedReads(qc);
  comeBackOnline();
  return qc;
}

// P25 and contract 2 of wave 2. The refresh after a write lived in the hooks'
// `onSettled`, and a write replayed after a relaunch has no hook: the list
// kept "Next" on a session whose confirmation had just reached the database.
describe('a settled write refreshes the reads it made stale, with or without a hook around it', () => {
  useFakeClock();

  it('a confirmation replayed after a relaunch refreshes every read of "is it confirmed", and the roll-ups it moves', async () => {
    const api = fakeWorkoutApi();
    const qc = await workoutRestored([[MUTATION_KEYS.confirmSession, CONFIRM]]);
    expect(staleReads(qc)).toEqual([]);

    await qc.resumePausedMutations();
    await pass();

    expect(api.requests).toHaveLength(1);
    expect(staleReads(qc)).toEqual(CONFIRMATION_READS);
  });

  it('a page that is open gets the answer of the database, not the guess it was restored with', async () => {
    fakeWorkoutApi();
    const qc = await workoutRestored([[MUTATION_KEYS.confirmSession, CONFIRM]]);
    const read = vi.fn().mockResolvedValue(['s-1']);
    const list = new QueryObserver(qc, {
      queryKey: ['my-confirmed-session-ids', 'u-1'],
      queryFn: read,
      staleTime: Infinity,
    });
    const stop = list.subscribe(() => {});
    await pass();
    expect(read).not.toHaveBeenCalled();

    await qc.resumePausedMutations();
    await pass();

    expect(read).toHaveBeenCalledTimes(1);
    expect(list.getCurrentResult().data).toEqual(['s-1']);
    stop();
  });

  it('so does an undo', async () => {
    fakeWorkoutApi();
    const qc = await workoutRestored([[MUTATION_KEYS.unconfirmSession, { sessionId: 's-1' }]]);

    await qc.resumePausedMutations();
    await pass();

    expect(staleReads(qc)).toEqual(CONFIRMATION_READS);
  });

  it('a note refreshes the notes of its session, and of no other', async () => {
    fakeWorkoutApi();
    const qc = await workoutRestored([
      [MUTATION_KEYS.saveSlotComment, { sessionId: 's-1', slotId: 'slot-1', studentId: 'u-1', body: 'elbow' }],
    ]);

    await qc.resumePausedMutations();
    await pass();

    expect(staleReads(qc)).toEqual([['slot-comments', 's-1']]);
  });

  it('a swap refreshes the deviations of its session', async () => {
    fakeWorkoutApi();
    const qc = await workoutRestored([
      [
        MUTATION_KEYS.saveSlotDeviation,
        { sessionId: 's-1', slotId: 'slot-1', studentId: 'u-1', kind: 'swap', substituteExerciseId: 'ex-2' },
      ],
    ]);

    await qc.resumePausedMutations();
    await pass();

    expect(staleReads(qc)).toEqual([['slot-deviations', 's-1']]);
  });

  it('a write that does not name its session refreshes them all: "of session undefined" would match none', async () => {
    fakeWorkoutApi();
    const qc = await workoutRestored([
      [MUTATION_KEYS.saveSlotComment, { slotId: 'slot-1', studentId: 'u-1', body: 'elbow' }],
      [MUTATION_KEYS.saveSlotDeviation, { slotId: 'slot-1', studentId: 'u-1', kind: 'skip' }],
    ]);

    await qc.resumePausedMutations();
    await pass();

    expect(staleReads(qc)).toEqual([
      ['slot-comments', 's-1'],
      ['slot-comments', 's-2'],
      ['slot-deviations', 's-1'],
      ['slot-deviations', 's-2'],
    ]);
  });

  it('a queue of sets is followed by ONE read of the sets, made after the last of them', async () => {
    const api = fakeWorkoutApi({ sets: ['l-1', 'l-2', 'l-3'] });
    const qc = await workoutRestored([
      [MUTATION_KEYS.toggleDone, { logId: 'l-1', done: true }],
      [MUTATION_KEYS.setRpe, { logId: 'l-1', rpe: 8 }],
      [MUTATION_KEYS.toggleDone, { logId: 'l-2', done: true }],
      [MUTATION_KEYS.setFailed, { logId: 'l-3', failed: true }],
    ]);
    // How many writes had reached the database each time the sets were read.
    const readAfter = [];
    const sets = new QueryObserver(qc, {
      queryKey: ['set-logs', 's-1', ['slot-1']],
      queryFn: async () => {
        readAfter.push(api.requests.length);
        return [...api.sets.values()].map((row) => ({ ...row }));
      },
      staleTime: Infinity,
    });
    const stop = sets.subscribe(() => {});

    await qc.resumePausedMutations();
    await pass();

    expect(api.requests).toHaveLength(4);
    expect(readAfter).toEqual([4]);
    expect(sets.getCurrentResult().data).toEqual([
      expect.objectContaining({ id: 'l-1', done: true, rpe: 8 }),
      expect.objectContaining({ id: 'l-2', done: true }),
      expect.objectContaining({ id: 'l-3', failed: true }),
    ]);
    expect(staleReads(qc)).toEqual([]);
    stop();
  });

  it('sets restored with the per-row scope of their hook leave together, and are still followed by one read', async () => {
    const api = fakeWorkoutApi({ sets: ['l-1', 'l-2', 'l-3'] });
    // What useToggleSetDone adds to the key: a scope per row. React Query
    // stores it with the mutation, so it is back after the relaunch.
    const ofRow = (logId) => ({ scope: { id: `set-log-${logId}` } });
    const qc = await workoutRestored([
      [MUTATION_KEYS.toggleDone, { logId: 'l-1', done: true }, ofRow('l-1')],
      [MUTATION_KEYS.toggleDone, { logId: 'l-2', done: true }, ofRow('l-2')],
      [MUTATION_KEYS.toggleDone, { logId: 'l-3', done: true }, ofRow('l-3')],
    ]);
    expect(qc.getMutationCache().getAll().map((m) => m.options.scope.id)).toEqual([
      'set-log-l-1',
      'set-log-l-2',
      'set-log-l-3',
    ]);
    const readAfter = [];
    const sets = new QueryObserver(qc, {
      queryKey: ['set-logs', 's-1', ['slot-1']],
      queryFn: async () => {
        readAfter.push([...api.sets.values()].filter((row) => row.done).length);
        return [];
      },
      staleTime: Infinity,
    });
    const stop = sets.subscribe(() => {});

    await qc.resumePausedMutations();
    await pass();

    expect(api.requests).toHaveLength(3);
    // One read, and it saw the three sets.
    expect(readAfter).toEqual([3]);
    stop();
  });

  it('a write the database turned down refreshes too: the read is what shows the row as it is', async () => {
    const api = fakeWorkoutApi();
    api.refuse = {
      code: '23514',
      details: null,
      hint: null,
      message: 'new row for relation "set_logs" violates check constraint "set_logs_done_xor_failed"',
    };
    const qc = offlineQueue();
    seedReads(qc);

    const tick = enqueue(qc, MUTATION_KEYS.toggleDone, TICK);
    await pass();

    expect(tick.state.status).toBe('error');
    expect(staleReads(qc)).toEqual([['set-logs', 's-1', ['slot-1']]]);
  });

  it('the refresh is not waited for: the next write of the queue leaves while the read is still on its way', async () => {
    const api = fakeWorkoutApi();
    const qc = await workoutRestored([
      [MUTATION_KEYS.confirmSession, CONFIRM],
      [MUTATION_KEYS.saveSlotComment, { sessionId: 's-1', slotId: 'slot-1', studentId: 'u-1', body: 'elbow' }],
    ]);
    // A read that never comes back.
    const list = new QueryObserver(qc, {
      queryKey: ['my-confirmed-session-ids', 'u-1'],
      queryFn: () => new Promise(() => {}),
      staleTime: Infinity,
    });
    const stop = list.subscribe(() => {});

    await qc.resumePausedMutations();
    await pass();

    expect(list.getCurrentResult().fetchStatus).toBe('fetching');
    expect(api.requests.map((r) => r.table)).toEqual(['session_confirmations', 'slot_comments']);
    expect(qc.isMutating()).toBe(0);
    stop();
  });

  it('a hook that names the key and sets no onSettled gets the same refresh for a write made live', async () => {
    fakeWorkoutApi();
    const qc = offlineQueue();
    seedReads(qc);
    // What useConfirmSession passes once the refresh is no longer its own:
    // the key, the function, and its optimistic update.
    const observer = new MutationObserver(qc, {
      mutationKey: MUTATION_KEYS.confirmSession,
      mutationFn: MUTATION_FNS.confirmSession,
      onMutate: () => ({ previous: null }),
      onError: () => {},
    });

    observer.mutate(CONFIRM).catch(() => {});
    await pass();

    expect(observer.getCurrentResult().status).toBe('success');
    expect(staleReads(qc)).toEqual(CONFIRMATION_READS);
  });

  it('the draft writes keep their own handlers', () => {
    const qc = offlineQueue();
    // Reconciled by draftSaveErrorHandler and `my-draft`, not by this list.
    expect(qc.getMutationDefaults(MUTATION_KEYS.saveDraftTree).onSettled).toBeUndefined();
    for (const [name, key] of Object.entries(MUTATION_KEYS)) {
      if (name === 'saveDraftTree') continue;
      expect(typeof qc.getMutationDefaults(key).onSettled).toBe('function');
    }
  });
});

// P55, the client half. The coach activates the next block (or reviews the
// session, or removes a set) while the athlete trains without signal. Past the
// 72 hours the database still allows, every write of that workout is refused:
// it was one generic toast per set, a refetch that emptied the screen, and no
// trace anywhere of what the athlete had done.
describe('a write that waited, and is refused because its session was closed meanwhile', () => {
  useFakeClock();

  const TAP = '2026-10-09T18:02:11.000Z';
  const TEN = Array.from({ length: 10 }, (_, i) => `l-${i + 1}`);
  const tick = (logId) => [MUTATION_KEYS.toggleDone, { logId, done: true, at: TAP }];
  const SETS_READ = ['set-logs', 's-1', ['slot-1']];

  const replayMessages = () => pushToast.mock.calls.filter(([message]) => message === REPLAY_REFUSED_KEY);

  beforeEach(() => {
    localStorage.removeItem(REJECTED_WRITES_KEY);
    vi.setSystemTime(new Date(TAP));
  });
  afterEach(() => {
    localStorage.removeItem(REJECTED_WRITES_KEY);
  });

  it('ten sets replayed after a relaunch and all refused: one message, no read, ten entries in the journal', async () => {
    const api = fakeWorkoutApi({ sets: TEN });
    const qc = await workoutRestored(TEN.map(tick));
    // The workout as the phone shows it: restored from storage, all ticked.
    const asLogged = TEN.map((id) => ({ id, done: true, logged_at: TAP }));
    qc.setQueryData(SETS_READ, asLogged);
    const read = vi.fn().mockResolvedValue(TEN.map((id) => ({ id, done: false, logged_at: null })));
    const sets = new QueryObserver(qc, { queryKey: SETS_READ, queryFn: read, staleTime: Infinity });
    const stop = sets.subscribe(() => {});
    // Three days on, the coach has long since started the next block.
    await pass(3 * 24 * 60 * 60 * 1000);
    api.closed = true;

    await qc.resumePausedMutations();
    await pass();

    const queue = qc.getMutationCache().getAll();
    expect(api.requests).toHaveLength(10);
    expect(queue.map((m) => m.state.status)).toEqual(TEN.map(() => 'error'));
    expect(queue.every((m) => m.state.error.code === 'PGRST116' && isRefusedReplay(m.state.error))).toBe(true);

    // One message, and it is the one that says what happened.
    expect(pushToast).toHaveBeenCalledTimes(1);
    expect(pushToast).toHaveBeenCalledWith(REPLAY_REFUSED_KEY, { kind: 'error' });

    // The sets are not read again: the athlete still sees the workout.
    expect(read).not.toHaveBeenCalled();
    expect(staleReads(qc)).toEqual([]);
    expect(sets.getCurrentResult().data).toEqual(asLogged);

    // And what was done is written down, set by set, with its moment.
    const journal = readRejectedWrites();
    expect(journal).toHaveLength(10);
    expect(journal.map((entry) => entry.variables.logId)).toEqual(TEN);
    expect(journal[0]).toEqual({
      refused_at: new Date(Date.parse(TAP) + 3 * 24 * 60 * 60 * 1000).toISOString(),
      made_at: TAP,
      user_id: 'u-1',
      write: 'toggleDone',
      variables: { logId: 'l-1', done: true, at: TAP },
      code: 'PGRST116',
      message: NO_ROW.message,
    });
    stop();
  });

  it('the same ten in the per-row scopes of their hooks, refused together: still one message, ten entries, no read', async () => {
    const api = fakeWorkoutApi({ sets: TEN });
    // As useToggleSetDone makes them; the scope is stored with the write, so
    // after the relaunch the ten requests leave at once.
    const qc = await workoutRestored(
      TEN.map((logId) => [...tick(logId), { scope: { id: `set-log-${logId}` } }])
    );
    api.closed = true;

    await qc.resumePausedMutations();
    await pass();

    expect(api.requests).toHaveLength(10);
    expect(qc.getMutationCache().getAll().every((m) => m.state.status === 'error')).toBe(true);
    expect(pushToast).toHaveBeenCalledTimes(1);
    expect(readRejectedWrites().map((entry) => entry.variables.logId).sort()).toEqual([...TEN].sort());
    expect(staleReads(qc)).toEqual([]);
  });

  it('the confirmation, the note and the swap of that workout are refused with it: still one message, and nothing is read again', async () => {
    const api = fakeWorkoutApi();
    const note = { sessionId: 's-1', slotId: 'slot-1', studentId: 'u-1', body: 'elbow' };
    const swap = { sessionId: 's-1', slotId: 'slot-1', studentId: 'u-1', kind: 'swap', substituteExerciseId: 'ex-2' };
    const qc = await workoutRestored([
      tick('l-1'),
      [MUTATION_KEYS.setRpe, { logId: 'l-1', rpe: 8 }],
      [MUTATION_KEYS.saveSlotDeviation, swap],
      [MUTATION_KEYS.saveSlotComment, note],
      [MUTATION_KEYS.confirmSession, CONFIRM],
    ]);
    api.closed = true;

    await qc.resumePausedMutations();
    await pass();

    expect(api.requests).toHaveLength(5);
    expect(qc.getMutationCache().getAll().map((m) => m.state.error?.code)).toEqual([
      'PGRST116',
      'PGRST116',
      '42501',
      '42501',
      '42501',
    ]);
    expect(pushToast).toHaveBeenCalledTimes(1);
    expect(staleReads(qc)).toEqual([]);
    expect(readRejectedWrites().map((entry) => [entry.write, entry.code, entry.variables])).toEqual([
      ['toggleDone', 'PGRST116', { logId: 'l-1', done: true, at: TAP }],
      ['setRpe', 'PGRST116', { logId: 'l-1', rpe: 8 }],
      ['saveSlotDeviation', '42501', swap],
      ['saveSlotComment', '42501', note],
      ['confirmSession', '42501', CONFIRM],
    ]);
  });

  it('a write that waited in this page, without a relaunch, is one that waited', async () => {
    const api = fakeWorkoutApi();
    goOffline();
    const qc = offlineQueue();
    seedReads(qc);
    const first = enqueue(qc, ...tick('l-1'));
    const second = enqueue(qc, MUTATION_KEYS.setRpe, { logId: 'l-1', rpe: 9 });
    await pass(2 * 60 * 60 * 1000);
    api.closed = true;

    comeBackOnline();
    await qc.resumePausedMutations();
    await pass();

    expect(first.state.status).toBe('error');
    expect(second.state.status).toBe('error');
    expect(replayMessages()).toHaveLength(1);
    expect(readRejectedWrites().map((entry) => entry.write)).toEqual(['toggleDone', 'setRpe']);
    expect(staleReads(qc)).toEqual([]);
  });

  it('so is one that was kept waiting for its owner to be signed in', async () => {
    const api = fakeWorkoutApi();
    signedOut();
    const qc = offlineQueue();
    const waiting = enqueue(qc, ...tick('l-1'));
    await pass(10 * 60_000);
    expect(api.requests).toHaveLength(0);
    api.closed = true;

    signedIn();
    await pass(AUTH_WAIT_CAP_MS);

    expect(waiting.state.status).toBe('error');
    expect(replayMessages()).toHaveLength(1);
    expect(readRejectedWrites()).toHaveLength(1);
  });

  it('a tick refused while the athlete is looking at the set is an ordinary failure', async () => {
    const api = fakeWorkoutApi();
    api.closed = true;
    const qc = offlineQueue();
    seedReads(qc);

    const live = enqueue(qc, ...tick('l-1'));
    await pass();

    expect(live.state.status).toBe('error');
    expect(live.state.error.code).toBe('PGRST116');
    // Nothing here speaks for it: the app's client shows its usual toast (see
    // lib/queryClient.test.js) and the hook takes the tick back.
    expect(isRefusedReplay(live.state.error)).toBe(false);
    expect(pushToast).not.toHaveBeenCalled();
    expect(readRejectedWrites()).toEqual([]);
    expect(staleReads(qc)).toEqual([SETS_READ]);
  });

  it('a write standing behind another one of its scope has not waited: the network was there all along', async () => {
    const api = fakeWorkoutApi();
    api.closed = true;
    const qc = offlineQueue();
    // Two taps in a row on a good network: React Query holds the second as
    // "paused" until the first has its answer.
    const first = enqueue(qc, ...tick('l-1'));
    const second = enqueue(qc, MUTATION_KEYS.setRpe, { logId: 'l-1', rpe: 8 });
    expect(second.state.isPaused).toBe(true);
    await pass();

    expect(first.state.status).toBe('error');
    expect(second.state.status).toBe('error');
    expect(pushToast).not.toHaveBeenCalled();
    expect(readRejectedWrites()).toEqual([]);
  });

  it('a replay refused for another reason stays an ordinary failure too', async () => {
    const api = fakeWorkoutApi();
    const qc = await workoutRestored([tick('l-1')]);
    api.refuse = {
      code: '23514',
      details: null,
      hint: null,
      message: 'new row for relation "set_logs" violates check constraint "set_logs_done_xor_failed"',
    };

    await qc.resumePausedMutations();
    await pass();

    const [replayed] = qc.getMutationCache().getAll();
    expect(replayed.state.error.code).toBe('23514');
    expect(isRefusedReplay(replayed.state.error)).toBe(false);
    expect(pushToast).not.toHaveBeenCalled();
    expect(readRejectedWrites()).toEqual([]);
    expect(staleReads(qc)).toEqual([SETS_READ]);
  });

  it('one refused set among accepted ones: the reads wait until the queue is empty, then the next write refreshes as usual', async () => {
    const api = fakeWorkoutApi({ sets: ['l-1', 'l-3'] });
    // l-2 is gone: the coach removed that set from the session.
    const qc = await workoutRestored([tick('l-1'), tick('l-2'), tick('l-3')]);

    await qc.resumePausedMutations();
    await pass();

    expect(qc.getMutationCache().getAll().map((m) => m.state.status)).toEqual(['success', 'error', 'success']);
    expect(api.sets.get('l-3')).toMatchObject({ done: true, logged_at: TAP });
    expect(replayMessages()).toHaveLength(1);
    expect(readRejectedWrites().map((entry) => entry.variables.logId)).toEqual(['l-2']);
    // Reading the sets now would take the tick of l-2 off the screen.
    expect(staleReads(qc)).toEqual([]);

    // That replay is over. A tick made now is followed by its read.
    enqueue(qc, MUTATION_KEYS.setRpe, { logId: 'l-1', rpe: 7 });
    await pass();

    expect(staleReads(qc)).toEqual([SETS_READ]);
    expect(replayMessages()).toHaveLength(1);
  });

  it('a later replay that is refused is said again: one message per replay, not one for ever', async () => {
    const api = fakeWorkoutApi();
    api.closed = true;
    goOffline();
    const qc = offlineQueue();
    enqueue(qc, ...tick('l-1'));
    await pass();
    comeBackOnline();
    await qc.resumePausedMutations();
    await pass();
    expect(replayMessages()).toHaveLength(1);

    // The next day, another session, the same answer.
    goOffline();
    enqueue(qc, ...tick('l-2'));
    enqueue(qc, ...tick('l-3'));
    await pass(24 * 60 * 60 * 1000);
    comeBackOnline();
    await qc.resumePausedMutations();
    await pass();

    expect(replayMessages()).toHaveLength(2);
    expect(readRejectedWrites()).toHaveLength(3);
  });

  it('a queue emptied in the middle of a refused replay ends it: the next account starts from nothing', async () => {
    const api = fakeWorkoutApi();
    api.closed = true;
    goOffline();
    const qc = offlineQueue();
    seedReads(qc);
    enqueue(qc, ...tick('l-1'));
    const behind = enqueue(qc, ...tick('l-2'));
    await pass();
    // The network goes again right after the first answer: l-2 stays queued.
    const refuseThenDrop = answer;
    answer = async (...request) => {
      const response = await refuseThenDrop(...request);
      goOffline();
      return response;
    };
    comeBackOnline();
    // Not awaited: the promise of a replay settles with its last write, and
    // that one is about to be held back.
    qc.resumePausedMutations();
    await pass();
    expect(replayMessages()).toHaveLength(1);
    expect(behind.state).toMatchObject({ status: 'pending', isPaused: true });

    // The account changes: App.jsx empties the client.
    qc.clear();
    answer = refuseThenDrop;
    api.closed = false;
    comeBackOnline();
    seedReads(qc);
    enqueue(qc, MUTATION_KEYS.setRpe, { logId: 'l-1', rpe: 7 });
    await pass();

    // Nothing of the previous replay is left: this write refreshes its reads.
    expect(staleReads(qc)).toEqual([SETS_READ]);
  });

  it('a draft that waited and is refused keeps its own handling: reconciled, not journalled', async () => {
    supabase.rpc.mockResolvedValue({
      data: null,
      error: { code: '42501', details: null, hint: null, message: 'new row violates row-level security policy for table "programs"' },
    });
    goOffline();
    const qc = offlineQueue();
    qc.setQueryData(['my-draft', 'u-1'], { id: 'p-1' });
    const save = enqueue(qc, MUTATION_KEYS.saveDraftTree, { tree: { program: { id: 'p-1' } } });
    await pass();

    comeBackOnline();
    await qc.resumePausedMutations();
    await pass();
    supabase.rpc.mockReset();

    expect(save.state.status).toBe('error');
    expect(isRefusedReplay(save.state.error)).toBe(false);
    expect(pushToast).not.toHaveBeenCalled();
    expect(readRejectedWrites()).toEqual([]);
    expect(staleReads(qc)).toEqual([['my-draft', 'u-1']]);
  });

  it('a device that cannot store the journal still gets the message, and the write still fails cleanly', async () => {
    const api = fakeWorkoutApi();
    const qc = await workoutRestored([tick('l-1')]);
    api.closed = true;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });

    await qc.resumePausedMutations();
    await pass();
    setItem.mockRestore();

    const [replayed] = qc.getMutationCache().getAll();
    expect(replayed.state.status).toBe('error');
    expect(replayed.state.error.code).toBe('PGRST116');
    expect(replayMessages()).toHaveLength(1);
  });
});

// --- PostgREST, for a draft ------------------------------------------------------
// POST /rpc/save_draft_tree with the whole tree. `saved` is what the database
// holds: the last snapshot it accepted, by program. `down`: `fetch` rejects, as
// on a network that does not answer. `refuse`: the database answers with that
// body instead of saving. `hold`: the answer waits for that promise — the
// request is out, and the app can do something else meanwhile.
function fakeDraftApi() {
  const api = { saved: new Map(), requests: [], down: false, refuse: null, hold: null };
  answer = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname !== '/rest/v1/rpc/save_draft_tree') {
      return reply(404, { code: 'PGRST202', message: `not expected: ${init.method} ${url.pathname}` });
    }
    const { p_tree: tree } = JSON.parse(init.body);
    api.requests.push(tree);
    if (api.hold) await api.hold;
    if (api.down) throw new TypeError('Failed to fetch');
    if (api.refuse) return reply(400, api.refuse);
    api.saved.set(tree.program.id, tree);
    return reply(200, {
      program_id: tree.program.id,
      weeks: tree.weeks.length,
      sessions: tree.sessions.length,
      slots: tree.slots.length,
    });
  };
  supabase.rpc.mockImplementation((name, args) => wire.rpc(name, args));
  return api;
}

function deferred() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const TREE_KEY = ['draft-tree', 'p-1'];
const POINTER_KEY = ['my-draft', 'u-1'];

// The draft as the builder last read it from the server.
function draftOpen(qc, over = {}) {
  qc.setQueryData(POINTER_KEY, { id: 'p-1', name: 'Off-season', status: 'draft', submitted_at: null });
  qc.setQueryData(TREE_KEY, {
    id: 'p-1',
    name: 'Off-season',
    status: 'draft',
    submitted_at: null,
    weeks: [{ id: 'w-1', week_number: 1, label: null, sessions: [] }],
    ...over,
  });
}

// An edit, as `useDraftActions` makes one, without React around it: the tree
// and its marker in one cache write, then the save of that tree with its rev.
function edit(qc, change) {
  const rev = nextDraftRev();
  const tree = markUnsynced({ ...qc.getQueryData(TREE_KEY), ...change }, rev);
  qc.setQueryData(TREE_KEY, tree);
  const save = enqueue(qc, MUTATION_KEYS.saveDraftTree, { tree: buildSnapshot(tree), rev });
  return { rev, tree, save };
}

const draftSaves = (qc) => qc.getMutationCache().findAll({ mutationKey: MUTATION_KEYS.saveDraftTree });

const COULD_NOT_SYNC = 'Couldn’t sync your draft — it’s saved on this device.';
const EXERCISE_GONE = 'One exercise is no longer in your coach’s library — remove or replace it.';
const EXERCISE_UNAVAILABLE = { code: 'P0001', details: 'e-9', hint: null, message: 'exercise_unavailable' };
const DRAFT_NOT_EDITABLE = {
  code: 'P0001',
  details: 'program is no longer a draft',
  hint: null,
  message: 'draft_not_editable',
};

// P54. A draft save that failed left nothing behind but the toast: the
// mutation ends in `error`, which the device does not store, and the next read
// of the server — the reconcile after a relaunch, any refetch of a cache two
// minutes old — put the tree of before the edits back. Nothing sent it again
// before the next edit either.
describe('a draft that is ahead of the server', () => {
  useFakeClock();

  beforeEach(() => {
    vi.setSystemTime(new Date('2026-10-13T10:00:00.000Z'));
  });
  afterEach(() => {
    supabase.rpc.mockReset();
  });

  // The six attempts of a save on a network that does not answer.
  async function givesUp() {
    await pass();
    for (const wait of [1000, 2000, 4000, 8000, 16000]) await pass(wait);
  }

  // The situation of the finding: the athlete edited the draft, the save got
  // no answer for half a minute, the toast said "it's saved on this device".
  async function savedOnThisDeviceOnly(change = { name: 'Off-season, rewritten' }, opened = {}) {
    const api = fakeDraftApi();
    api.down = true;
    const phone = offlineQueue();
    draftOpen(phone, opened);
    const { rev, tree, save } = edit(phone, change);
    await givesUp();
    expect(save.state.status).toBe('error');
    expect(api.requests).toHaveLength(6);
    return { api, phone, rev, tree, save };
  }

  describe('hasUnsyncedDraft', () => {
    it('is false with no draft, with a draft in sync, and for a write of the workout', async () => {
      fakeSetLogsApi();
      const qc = offlineQueue();
      expect(hasUnsyncedDraft(qc)).toBe(false);

      draftOpen(qc);
      goOffline();
      enqueue(qc, MUTATION_KEYS.toggleDone, TICK);
      await pass();

      expect(hasUnsyncedDraft(qc)).toBe(false);
    });

    it('is true for a tree that carries the marker, whatever became of its save', async () => {
      const { phone } = await savedOnThisDeviceOnly();

      expect(draftSaves(phone).map((save) => save.state.status)).toEqual(['error']);
      expect(hasUnsyncedDraft(phone)).toBe(true);
    });

    it('is true while a save is on its way, with or without a marker on the tree', async () => {
      const api = fakeDraftApi();
      api.hold = deferred().promise;
      const qc = offlineQueue();
      draftOpen(qc);
      // A save queued by a build that set no marker.
      enqueue(qc, MUTATION_KEYS.saveDraftTree, { tree: buildSnapshot(qc.getQueryData(TREE_KEY)) });
      await pass();

      expect(isUnsyncedDraft(qc.getQueryData(TREE_KEY))).toBe(false);
      expect(hasUnsyncedDraft(qc)).toBe(true);
    });

    it('is true while a save is paused without a network', async () => {
      fakeDraftApi();
      goOffline();
      const qc = offlineQueue();
      draftOpen(qc);
      const { save } = edit(qc, { name: 'Off-season, rewritten' });
      await pass();

      expect(save.state).toMatchObject({ status: 'pending', isPaused: true });
      expect(hasUnsyncedDraft(qc)).toBe(true);
    });

    it('is true while a discard is on its way: the server still has the draft just thrown away', async () => {
      supabase.from.mockReturnValue({ delete: () => ({ eq: () => new Promise(() => {}) }) });
      const qc = offlineQueue();
      // `discard`: the pointer emptied, the tree removed, then the write.
      qc.setQueryData(POINTER_KEY, null);
      const discard = enqueue(qc, MUTATION_KEYS.discardDraft, { programId: 'p-1' });
      await pass();

      expect(discard.state.status).toBe('pending');
      expect(hasUnsyncedDraft(qc)).toBe(true);
      await resumeMutationsAndReconcileDrafts(qc);
      expect(staleReads(qc)).toEqual([]);
    });

    it('is false again once the database has the tree', async () => {
      const api = fakeDraftApi();
      const qc = offlineQueue();
      draftOpen(qc);
      const { save } = edit(qc, { name: 'Off-season, rewritten' });
      await pass();

      expect(save.state.status).toBe('success');
      expect(api.saved.get('p-1').program.name).toBe('Off-season, rewritten');
      expect(hasUnsyncedDraft(qc)).toBe(false);
    });
  });

  it('a save the database accepted leaves the tree as it is, without its marker', async () => {
    const api = fakeDraftApi();
    const qc = offlineQueue();
    draftOpen(qc);

    const { tree } = edit(qc, { name: 'Off-season, rewritten' });
    expect(isUnsyncedDraft(qc.getQueryData(TREE_KEY))).toBe(true);
    await pass();

    expect(api.saved.get('p-1')).toEqual(buildSnapshot(tree));
    expect(qc.getQueryData(TREE_KEY)).toEqual(markSynced(tree));
    // The pointer is read again, the tree is not: the database holds exactly it.
    expect(staleReads(qc)).toEqual([POINTER_KEY]);
  });

  it('a save is settled when the database has answered, not when the read it starts has come back', async () => {
    fakeDraftApi();
    const qc = offlineQueue();
    draftOpen(qc);
    // The builder is open: the pointer has a reader, and its request hangs.
    const pointer = new QueryObserver(qc, {
      queryKey: POINTER_KEY,
      queryFn: () => new Promise(() => {}),
      staleTime: Infinity,
    });
    const stop = pointer.subscribe(() => {});

    const { save } = edit(qc, { name: 'Off-season, rewritten' });
    await pass();
    stop();

    expect(pointer.getCurrentResult().fetchStatus).toBe('fetching');
    expect(save.state.status).toBe('success');
  });

  it('a save that got no answer leaves the tree as the athlete wrote it, marked, and says so once', async () => {
    const { phone, tree, rev } = await savedOnThisDeviceOnly();

    expect(phone.getQueryData(TREE_KEY)).toEqual(tree);
    expect(unsyncedRev(phone.getQueryData(TREE_KEY))).toBe(rev);
    expect(pushToast.mock.calls).toEqual([[COULD_NOT_SYNC, { kind: 'error' }]]);
    // Nothing asks the server for its (older) tree.
    expect(staleReads(phone)).toEqual([]);
  });

  it('the tree is sent again when the device reconnects, as it is by then', async () => {
    const { api, phone, tree } = await savedOnThisDeviceOnly();
    api.down = false;

    // What the `online` listener of the shell runs.
    await resumeMutationsAndReconcileDrafts(phone);
    // On its way: still ahead of the server, still not read.
    expect(staleReads(phone)).toEqual([]);
    await pass();

    expect(api.requests).toHaveLength(7);
    expect(api.saved.get('p-1')).toEqual(buildSnapshot(tree));
    expect(phone.getQueryData(TREE_KEY)).toEqual(markSynced(tree));
    expect(hasUnsyncedDraft(phone)).toBe(false);
    expect(pushToast).toHaveBeenCalledTimes(1);
  });

  it('once in sync, the next reconnect reads both caches again: that is how a send-back is seen', async () => {
    const { api, phone } = await savedOnThisDeviceOnly();
    api.down = false;
    await resumeMutationsAndReconcileDrafts(phone);
    await pass();
    phone.setQueryData(POINTER_KEY, phone.getQueryData(POINTER_KEY));
    expect(staleReads(phone)).toEqual([]);

    await resumeMutationsAndReconcileDrafts(phone);

    expect(api.requests).toHaveLength(7);
    expect(staleReads(phone)).toEqual([POINTER_KEY, TREE_KEY]);
  });

  it('the attempts that follow by themselves are silent, and never cost the tree', async () => {
    const { api, phone, tree } = await savedOnThisDeviceOnly();

    // The athlete comes back to the app; the network is no better.
    await resumeMutationsAndReconcileDrafts(phone);
    await givesUp();

    expect(api.requests).toHaveLength(12);
    expect(pushToast).toHaveBeenCalledTimes(1);
    expect(phone.getQueryData(TREE_KEY)).toEqual(tree);
    expect(staleReads(phone)).toEqual([]);
  });

  it('a tree whose save is already on its way is not sent a second time', async () => {
    const api = fakeDraftApi();
    goOffline();
    const qc = offlineQueue();
    draftOpen(qc);
    const { tree } = edit(qc, { name: 'Off-season, rewritten' });
    await pass();

    // Back in the app, still without a network.
    await resumeMutationsAndReconcileDrafts(qc);
    await resumeMutationsAndReconcileDrafts(qc);
    expect(draftSaves(qc)).toHaveLength(1);

    comeBackOnline();
    await resumeMutationsAndReconcileDrafts(qc);
    await pass();

    expect(api.requests).toEqual([buildSnapshot(tree)]);
    expect(qc.getQueryData(TREE_KEY)).toEqual(markSynced(tree));
  });

  describe('after the app was killed and opened again', () => {
    it('the device stored the tree with its marker, and not the save that failed', async () => {
      const { phone, tree, rev } = await savedOnThisDeviceOnly();

      const stored = JSON.parse(JSON.stringify(dehydrate(phone)));

      expect(stored.mutations).toEqual([]);
      const storedTree = stored.queries.find((query) => query.queryKey[0] === 'draft-tree').state.data;
      expect(storedTree).toEqual(tree);
      expect(unsyncedRev(storedTree)).toBe(rev);
    });

    it('the tree is not replaced by the server\'s: it is sent, and only then is anything read', async () => {
      const { api, phone, tree } = await savedOnThisDeviceOnly();
      const qc = relaunch(phone);
      expect(draftSaves(qc)).toHaveLength(0);
      api.down = false;

      // What the restored cache runs (`replayQueuedWrites`).
      await resumeMutationsAndReconcileDrafts(qc);
      expect(staleReads(qc)).toEqual([]);
      expect(qc.getQueryData(TREE_KEY)).toEqual(tree);
      await pass();

      expect(api.requests).toHaveLength(7);
      expect(api.saved.get('p-1')).toEqual(buildSnapshot(tree));
      expect(qc.getQueryData(TREE_KEY)).toEqual(markSynced(tree));
      expect(staleReads(qc)).toEqual([POINTER_KEY]);
    });

    it('a draft created without a network keeps its pointer: the server would answer "no draft"', async () => {
      const api = fakeDraftApi();
      api.down = true;
      const phone = offlineQueue();
      // `useCreateDraft`: the pointer and a tree marked from its first moment.
      const rev = nextDraftRev();
      const tree = markUnsynced({ id: 'p-1', name: 'My program', status: 'draft', submitted_at: null, weeks: [] }, rev);
      phone.setQueryData(POINTER_KEY, { id: 'p-1', name: 'My program', status: 'draft', submitted_at: null });
      phone.setQueryData(TREE_KEY, tree);
      enqueue(phone, MUTATION_KEYS.saveDraftTree, { tree: buildSnapshot(tree), rev });
      await givesUp();

      const qc = relaunch(phone);
      const noDraftOnTheServer = vi.fn(async () => null);
      const pointer = new QueryObserver(qc, { queryKey: POINTER_KEY, queryFn: noDraftOnTheServer, staleTime: Infinity });
      const stop = pointer.subscribe(() => {});
      await resumeMutationsAndReconcileDrafts(qc);
      await givesUp();
      stop();

      expect(noDraftOnTheServer).not.toHaveBeenCalled();
      expect(qc.getQueryData(POINTER_KEY)).toMatchObject({ id: 'p-1' });
      expect(qc.getQueryData(TREE_KEY)).toEqual(tree);
      expect(api.saved.size).toBe(0);
    });

    it('opened without a network, the tree goes into the queue: paused, which is what the device stores', async () => {
      const { api, phone, tree, rev } = await savedOnThisDeviceOnly();
      goOffline();
      const qc = relaunch(phone);

      await resumeMutationsAndReconcileDrafts(qc);
      await pass();

      expect(api.requests).toHaveLength(6);
      const stored = JSON.parse(JSON.stringify(dehydrate(qc))).mutations;
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        mutationKey: MUTATION_KEYS.saveDraftTree,
        scope: { id: 'draft-tree' },
        state: { isPaused: true, variables: { tree: buildSnapshot(tree), rev } },
      });

      api.down = false;
      comeBackOnline();
      await qc.resumePausedMutations();
      await pass();

      expect(api.saved.get('p-1')).toEqual(buildSnapshot(tree));
      expect(qc.getQueryData(TREE_KEY)).toEqual(markSynced(tree));
    });
  });

  it('the answer to one save says nothing about an edit made after it', async () => {
    const api = fakeDraftApi();
    const qc = offlineQueue();
    draftOpen(qc);
    const first = deferred();
    api.hold = first.promise;
    const one = edit(qc, { name: 'First edit' });
    await pass();

    // The second edit is made while the first save is out.
    const two = edit(qc, { name: 'Second edit' });
    await pass();
    const second = deferred();
    api.hold = second.promise;
    first.release();
    await pass();

    expect(one.save.state.status).toBe('success');
    expect(api.saved.get('p-1').program.name).toBe('First edit');
    // The database does not have the second edit: the tree is still ahead.
    expect(qc.getQueryData(TREE_KEY)).toEqual(two.tree);
    expect(unsyncedRev(qc.getQueryData(TREE_KEY))).toBe(two.rev);

    second.release();
    await pass();

    expect(api.saved.get('p-1').program.name).toBe('Second edit');
    expect(qc.getQueryData(TREE_KEY)).toEqual(markSynced(two.tree));
  });

  describe('a snapshot the database turned down', () => {
    it('stays on the device, marked, and is not sent again by itself', async () => {
      const api = fakeDraftApi();
      api.refuse = EXERCISE_UNAVAILABLE;
      const qc = offlineQueue();
      draftOpen(qc);

      const { save, tree } = edit(qc, { name: 'Off-season, rewritten' });
      await pass();

      expect(save.state.status).toBe('error');
      expect(api.requests).toHaveLength(1);
      expect(qc.getQueryData(TREE_KEY)).toEqual(tree);
      expect(pushToast.mock.calls).toEqual([[EXERCISE_GONE, { kind: 'error' }]]);

      // Reconnect, return to the app: the same tree would get the same answer.
      await resumeMutationsAndReconcileDrafts(qc);
      await resumeMutationsAndReconcileDrafts(qc);
      await pass();

      expect(api.requests).toHaveLength(1);
      expect(pushToast).toHaveBeenCalledTimes(1);
      expect(qc.getQueryData(TREE_KEY)).toEqual(tree);
      expect(staleReads(qc)).toEqual([]);
    });

    it('goes out again with the athlete\'s next edit', async () => {
      const api = fakeDraftApi();
      api.refuse = EXERCISE_UNAVAILABLE;
      const qc = offlineQueue();
      draftOpen(qc);
      edit(qc, { name: 'Off-season, rewritten' });
      await pass();

      // The exercise is removed from the draft.
      api.refuse = null;
      const fixed = edit(qc, { weeks: [] });
      await pass();

      expect(api.saved.get('p-1')).toEqual(buildSnapshot(fixed.tree));
      expect(api.saved.get('p-1').program.name).toBe('Off-season, rewritten');
      expect(qc.getQueryData(TREE_KEY)).toEqual(markSynced(fixed.tree));
    });

    it('is tried once more after a relaunch, and said again if the answer is the same', async () => {
      const api = fakeDraftApi();
      api.refuse = EXERCISE_UNAVAILABLE;
      const phone = offlineQueue();
      draftOpen(phone);
      const { tree } = edit(phone, { name: 'Off-season, rewritten' });
      await pass();

      const qc = relaunch(phone);
      await resumeMutationsAndReconcileDrafts(qc);
      await pass();
      await resumeMutationsAndReconcileDrafts(qc);
      await pass();

      expect(api.requests).toHaveLength(2);
      expect(pushToast.mock.calls).toEqual([
        [EXERCISE_GONE, { kind: 'error' }],
        [EXERCISE_GONE, { kind: 'error' }],
      ]);
      expect(qc.getQueryData(TREE_KEY)).toEqual(tree);
    });

    it('a submission it carried is taken back on the device: a submitted draft could not be corrected', async () => {
      const api = fakeDraftApi();
      api.refuse = EXERCISE_UNAVAILABLE;
      const qc = offlineQueue();
      draftOpen(qc);

      // `submit`: the stamp on the pointer and on the tree.
      const stamp = '2026-10-13T10:00:00.000Z';
      qc.setQueryData(POINTER_KEY, (mine) => ({ ...mine, submitted_at: stamp }));
      const { tree, rev } = edit(qc, { submitted_at: stamp });
      await pass();

      expect(api.requests[0].program.submitted_at).toBe(stamp);
      expect(qc.getQueryData(TREE_KEY)).toEqual({ ...tree, submitted_at: null });
      expect(unsyncedRev(qc.getQueryData(TREE_KEY))).toBe(rev);
      expect(qc.getQueryData(POINTER_KEY).submitted_at).toBeNull();
    });

    it('for any other reason is kept the same way, with the plain message', async () => {
      const api = fakeDraftApi();
      api.refuse = { code: '23514', details: null, hint: null, message: 'new row violates check constraint' };
      const qc = offlineQueue();
      draftOpen(qc);

      const { tree } = edit(qc, { name: 'Off-season, rewritten' });
      await pass();
      await resumeMutationsAndReconcileDrafts(qc);
      await pass();

      expect(api.requests).toHaveLength(1);
      expect(qc.getQueryData(TREE_KEY)).toEqual(tree);
      expect(pushToast.mock.calls).toEqual([[COULD_NOT_SYNC, { kind: 'error' }]]);
    });
  });

  it('a submission that got no answer is not taken back: it is sent again, though the draft can no longer be edited', async () => {
    const stamp = '2026-10-13T10:00:00.000Z';
    const { api, phone, tree } = await savedOnThisDeviceOnly({ submitted_at: stamp });
    expect(phone.getQueryData(TREE_KEY).submitted_at).toBe(stamp);

    api.down = false;
    await resumeMutationsAndReconcileDrafts(phone);
    await pass();

    expect(api.saved.get('p-1').program.submitted_at).toBe(stamp);
    expect(phone.getQueryData(TREE_KEY)).toEqual(markSynced(tree));
  });

  it('a draft the coach approved in the meantime is the server\'s: the marker goes, and both caches are read again', async () => {
    const api = fakeDraftApi();
    api.refuse = DRAFT_NOT_EDITABLE;
    const qc = offlineQueue();
    draftOpen(qc);

    edit(qc, { name: 'Off-season, rewritten' });
    await pass();

    expect(isUnsyncedDraft(qc.getQueryData(TREE_KEY))).toBe(false);
    expect(hasUnsyncedDraft(qc)).toBe(false);
    expect(staleReads(qc)).toEqual([POINTER_KEY, TREE_KEY]);
    expect(pushToast).not.toHaveBeenCalled();
    // Nothing is left to send.
    await resumeMutationsAndReconcileDrafts(qc);
    await pass();
    expect(api.requests).toHaveLength(1);
  });

  it('a save queued by a build that set no marker: when it fails for good, the tree gets one and is sent again', async () => {
    const api = fakeDraftApi();
    api.down = true;
    const qc = offlineQueue();
    draftOpen(qc, { name: 'Edited by the build before' });
    const tree = qc.getQueryData(TREE_KEY);
    enqueue(qc, MUTATION_KEYS.saveDraftTree, { tree: buildSnapshot(tree) });
    await givesUp();

    expect(isUnsyncedDraft(qc.getQueryData(TREE_KEY))).toBe(true);
    expect(markSynced(qc.getQueryData(TREE_KEY))).toEqual(tree);

    api.down = false;
    await resumeMutationsAndReconcileDrafts(qc);
    await pass();

    expect(api.saved.get('p-1')).toEqual(buildSnapshot(tree));
    expect(qc.getQueryData(TREE_KEY)).toEqual(tree);
  });

  it('a failed save of a tree the athlete has edited since changes nothing: the later save decides', async () => {
    const api = fakeDraftApi();
    const qc = offlineQueue();
    draftOpen(qc);
    const first = deferred();
    api.hold = first.promise;
    const stamp = '2026-10-13T10:00:00.000Z';
    edit(qc, { name: 'First edit' });
    await pass();
    const two = edit(qc, { name: 'Second edit', submitted_at: stamp });
    await pass();

    // The first save is turned down; the second, queued behind it, is accepted.
    api.hold = null;
    api.refuse = EXERCISE_UNAVAILABLE;
    const second = deferred();
    first.release();
    api.hold = second.promise;
    await pass();
    // Between the two answers: the tree is the second edit, submission included.
    expect(qc.getQueryData(TREE_KEY)).toEqual(two.tree);

    api.refuse = null;
    second.release();
    await pass();

    expect(api.saved.get('p-1').program).toMatchObject({ name: 'Second edit', submitted_at: stamp });
    expect(qc.getQueryData(TREE_KEY)).toEqual(markSynced(two.tree));
  });

  it('nothing is sent, and nothing read, while nobody is signed in', async () => {
    const { api, phone, tree } = await savedOnThisDeviceOnly();
    api.down = false;
    signedOut();

    await resumeMutationsAndReconcileDrafts(phone);
    await pass();

    expect(api.requests).toHaveLength(6);
    expect(phone.getQueryData(TREE_KEY)).toEqual(tree);
    expect(staleReads(phone)).toEqual([]);
  });
});

describe('resumeMutationsAndReconcileDrafts and the session', () => {
  afterEach(() => {
    supabase.from.mockReset();
    answer = null;
  });

  // A queue as a reload leaves it: written offline, paused, the device back
  // online — on a client nothing is mounted on, so only the helper replays it.
  async function pausedQueue() {
    const api = fakeSetLogsApi();
    onlineManager.setOnline(false);
    const qc = offlineQueue();
    const first = enqueue(qc, MUTATION_KEYS.toggleDone, { logId: 'l-1', done: true });
    const second = enqueue(qc, MUTATION_KEYS.setRpe, { logId: 'l-1', rpe: 8 });
    await new Promise((r) => setTimeout(r, 0));
    onlineManager.setOnline(true);
    return { api, qc, first, second };
  }

  it('replays nothing without a session: the queue stays paused, the drafts are not re-read', async () => {
    const { api, qc, first, second } = await pausedQueue();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    signedOut();

    await resumeMutationsAndReconcileDrafts(qc);

    expect(api.attempts).toHaveLength(0);
    expect(first.state).toMatchObject({ status: 'pending', isPaused: true });
    expect(second.state).toMatchObject({ status: 'pending', isPaused: true });
    expect(dehydrate(qc).mutations).toHaveLength(2);
    // An anonymous read of `my-draft` answers "no draft".
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('replays it, in order, once there is one', async () => {
    const { api, qc, first, second } = await pausedQueue();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    signedOut();
    await resumeMutationsAndReconcileDrafts(qc);

    signedIn();
    await resumeMutationsAndReconcileDrafts(qc);

    await vi.waitFor(() => expect(second.state.status).toBe('success'));
    expect(first.state.status).toBe('success');
    expect(api.attempts).toHaveLength(2);
    expect(api.attempts.every((a) => a.bearer === 'athlete-jwt')).toBe(true);
    expect(api.table.get('l-1')).toMatchObject({ done: true, rpe: 8 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['my-draft'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['draft-tree'] });
  });
});
