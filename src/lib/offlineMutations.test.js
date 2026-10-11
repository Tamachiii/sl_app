import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, onlineManager } from '@tanstack/react-query';
import { createClient } from '@supabase/supabase-js';

vi.mock('./supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./toast', () => ({ pushToast: vi.fn() }));

import { supabase } from './supabase';
import {
  MUTATION_KEYS,
  MUTATION_FNS,
  patchForDone,
  patchForFailed,
  patchForSkipped,
  registerOfflineMutationDefaults,
  hasUnsyncedDraftSave,
} from './offlineMutations';

const fakeQc = (mutations) => ({ getMutationCache: () => ({ getAll: () => mutations }) });
const draftSave = (state) => ({ options: { mutationKey: ['draft-tree', 'save'] }, state });

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
let answer = null;
const wire = createClient('https://postgrest.invalid', 'anon-key', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: (input, init) => answer(input, init) },
});

function fakeConfirmationsApi({ existing = [], lockedSessionIds = [], refuseInsert = null } = {}) {
  const rows = new Map(existing.map((row) => [row.session_id, { ...row }]));
  const api = { rows, requests: [], writes: 0 };
  let minted = 0;
  const reply = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

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

  describe('hasUnsyncedDraftSave (guards the resume-time reconcile)', () => {
    it('is false with no draft saves', () => {
      expect(hasUnsyncedDraftSave(fakeQc([]))).toBe(false);
      expect(hasUnsyncedDraftSave(fakeQc([
        { options: { mutationKey: ['set-log', 'toggle-done'] }, state: { status: 'error', isPaused: false } },
      ]))).toBe(false);
    });
    it('is true while a draft save is errored, pending, or paused', () => {
      expect(hasUnsyncedDraftSave(fakeQc([draftSave({ status: 'error', isPaused: false })]))).toBe(true);
      expect(hasUnsyncedDraftSave(fakeQc([draftSave({ status: 'pending', isPaused: false })]))).toBe(true);
      expect(hasUnsyncedDraftSave(fakeQc([draftSave({ status: 'idle', isPaused: true })]))).toBe(true);
    });
    it('is false once every draft save succeeded (safe to reconcile)', () => {
      expect(hasUnsyncedDraftSave(fakeQc([draftSave({ status: 'success', isPaused: false })]))).toBe(false);
    });
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
  function enqueue(qc, mutationKey, variables) {
    const mutation = qc.getMutationCache().build(qc, {
      mutationKey,
      ...qc.getMutationDefaults(mutationKey),
    });
    mutation.execute(variables).catch(() => {});
    return mutation;
  }
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
