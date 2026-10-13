import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import {
  AuthNotReadyError,
  isAuthNotReady,
  isNetworkError,
  isDatabaseBusy,
  isTransientError,
  mutationRetry,
  mutationRetryDelay,
  rankTransientFailure,
  MAX_TRANSIENT_RETRIES,
  TRANSIENT_RETRY_CAP_MS,
  AUTH_WAIT_CAP_MS,
} from './networkErrors';

// The errors classified here are MADE BY supabase-js, not written by hand: the
// client is the real one and only `fetch` is ours. What matters is the shape
// postgrest-js gives a request that got no answer — an object with an EMPTY
// code — and a hand-written fixture would only repeat what this file believes
// that shape to be. `.invalid` never resolves (RFC 2606).
let respond = null;
const wire = createClient('https://postgrest.invalid', 'anon-key', {
  accessToken: async () => 'athlete-jwt',
  global: { fetch: (input, init) => respond(input, init) },
});

// The error of a set tick (`update … select().single()`) when `fetch` does this.
async function errorOfAWrite(fetchDoes) {
  respond = fetchDoes;
  const { error } = await wire.from('set_logs').update({ done: true }).eq('id', 'l-1').select().single();
  return error;
}

const rejects = (error) => () => Promise.reject(error);
const answers = (status, body, type = 'application/json') => () =>
  Promise.resolve(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': type },
    }),
  );
const postgrest = (status, code, message = 'nope') =>
  answers(status, { code, details: null, hint: null, message });

describe('a request that got no answer', () => {
  it.each([
    ['Chrome without a network', rejects(new TypeError('Failed to fetch'))],
    ['Safari', rejects(new TypeError('Load failed'))],
    ['Firefox', rejects(new TypeError('NetworkError when attempting to fetch resource.'))],
    // WebKit words some failures in the language of the phone: the message
    // cannot be what decides.
    ['Safari on a French iPhone', rejects(new TypeError('La connexion Internet semble interrompue.'))],
    ['Safari, connection cut mid-answer', rejects(new TypeError('La connexion réseau a été perdue.'))],
    ['a request that was aborted', rejects(new DOMException('The operation was aborted.', 'AbortError'))],
    // A captive portal answers 200 with its own page.
    ['a page where JSON was expected', answers(200, '<html><body>Welcome to GymWifi</body></html>', 'text/html')],
    ['a gateway page', answers(502, '<html><body><h1>502 Bad Gateway</h1></body></html>', 'text/html')],
    ['the gateway in JSON', answers(503, { message: 'name resolution failed' })],
    ['a rate limit', answers(429, { message: 'API rate limit exceeded' })],
  ])('%s is a network error', async (_name, fetchDoes) => {
    const error = await errorOfAWrite(fetchDoes);

    expect(error).toBeTruthy();
    expect(isNetworkError(error)).toBe(true);
    expect(isTransientError(error)).toBe(true);
    expect(isDatabaseBusy(error)).toBe(false);
    expect(mutationRetry(0, error)).toBe(true);
  });

  it('is an object with an empty code, as postgrest-js hands it back', async () => {
    const error = await errorOfAWrite(rejects(new TypeError('Failed to fetch')));

    expect(error.code).toBe('');
    expect(error.message).toBe('TypeError: Failed to fetch');
  });

  it.each([
    ['a failed fetch, thrown as it is', new TypeError('Failed to fetch')],
    ['a failed fetch in Node', new TypeError('fetch failed')],
    ['auth-js, when the token endpoint did not answer', Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 })],
    ['an Edge Function that did not answer', Object.assign(new Error('Failed to send a request to the Edge Function'), { name: 'FunctionsFetchError' })],
    // A DOMException has a numeric `code` (23 here): not a code of the database.
    ['a timeout', new DOMException('The operation timed out.', 'TimeoutError')],
    ['an abort in Node, which gives it a code', Object.assign(new Error('This operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })],
  ])('%s is one as well', (_name, error) => {
    expect(isNetworkError(error)).toBe(true);
  });
});

describe('a request the database answered', () => {
  it.each([
    ['the row is not there for this user (RLS on an update)', postgrest(406, 'PGRST116')],
    ['a policy refused the insert', postgrest(403, '42501')],
    ['a duplicate', postgrest(409, '23505')],
    ['a CHECK constraint', postgrest(400, '23514')],
    ['a foreign key', postgrest(409, '23503')],
    ['a trigger raised', postgrest(400, 'P0001', 'this session still has 3 logged set(s)')],
    ['an expired token', postgrest(401, 'PGRST301', 'JWT expired')],
    ['a function the database does not have', postgrest(404, 'PGRST202')],
  ])('%s is a refusal: not a network error, and not sent again', async (_name, fetchDoes) => {
    const error = await errorOfAWrite(fetchDoes);

    expect(error.code).toBeTruthy();
    expect(isNetworkError(error)).toBe(false);
    expect(isTransientError(error)).toBe(false);
    expect(mutationRetry(0, error)).toBe(false);
  });

  it.each([
    ['PostgREST is rebuilding its schema cache', postgrest(503, 'PGRST002')],
    ['PostgREST lost its database', postgrest(503, 'PGRST000')],
    ['PostgREST cannot connect', postgrest(503, 'PGRST001')],
    ['no pooled connection in time', postgrest(504, 'PGRST003')],
    ['too many connections', postgrest(500, '53300')],
    ['the server is starting up', postgrest(500, '57P03')],
    ['the server is shutting down', postgrest(500, '57P01')],
    ['a connection failure', postgrest(500, '08006')],
    ['a statement timeout', postgrest(500, '57014')],
    ['a lock timeout', postgrest(500, '55P03')],
    ['a deadlock', postgrest(500, '40P01')],
    ['a serialization failure', postgrest(500, '40001')],
  ])('"not now" is not "no": %s is sent again', async (_name, fetchDoes) => {
    const error = await errorOfAWrite(fetchDoes);

    expect(isDatabaseBusy(error)).toBe(true);
    expect(isNetworkError(error)).toBe(false);
    expect(isTransientError(error)).toBe(true);
    expect(mutationRetry(0, error)).toBe(true);
  });
});

describe('what is neither', () => {
  it('a bug in the app is not a network error', () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'id')");

    expect(isNetworkError(bug)).toBe(false);
    expect(isNetworkError(new Error('No mutationFn found'))).toBe(false);
    expect(mutationRetry(0, bug)).toBe(false);
  });

  it('a sentinel the app throws with a code of its own is a refusal', () => {
    const sentinel = Object.assign(new Error('program has logged sets'), { code: 'PROGRAM_HAS_LOGGED_SETS' });

    expect(isTransientError(sentinel)).toBe(false);
    expect(mutationRetry(0, sentinel)).toBe(false);
  });

  it('nothing at all is not an error of any kind', () => {
    for (const nothing of [null, undefined, '', 'Failed to fetch', 0]) {
      expect(isNetworkError(nothing)).toBe(false);
      expect(isDatabaseBusy(nothing)).toBe(false);
      expect(isAuthNotReady(nothing)).toBe(false);
      expect(mutationRetry(0, nothing)).toBe(false);
    }
  });
});

describe('AuthNotReadyError', () => {
  it('is recognised, and is neither a network error nor a refusal', () => {
    const error = new AuthNotReadyError();

    expect(error).toBeInstanceOf(Error);
    expect(isAuthNotReady(error)).toBe(true);
    expect(isNetworkError(error)).toBe(false);
    expect(isTransientError(error)).toBe(false);
  });

  it('is still recognised after the JSON the persister stores a failure reason as', () => {
    const stored = JSON.parse(JSON.stringify(new AuthNotReadyError()));

    expect(stored).not.toBeInstanceOf(Error);
    expect(isAuthNotReady(stored)).toBe(true);
    expect(isNetworkError(stored)).toBe(false);
  });
});

describe('the retry policy of the queued writes', () => {
  const noAnswer = () => ({ message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' });

  it('a write that got no answer is sent again five times, further and further apart', () => {
    expect(MAX_TRANSIENT_RETRIES).toBe(5);
    const waits = [];
    let failures = 0;
    for (;;) {
      const error = noAnswer();
      if (!mutationRetry(failures, error)) break;
      waits.push(mutationRetryDelay(failures, error));
      failures += 1;
    }

    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(Math.max(...waits)).toBeLessThanOrEqual(TRANSIENT_RETRY_CAP_MS);
  });

  it('a write waiting for a session is asked again for ever, never further apart than the cap', () => {
    const error = new AuthNotReadyError();

    for (const failures of [0, 1, 5, 6, 50, 5000]) {
      expect(mutationRetry(failures, error)).toBe(true);
    }
    expect([0, 1, 2, 3, 4, 5, 60, 5000].map((n) => mutationRetryDelay(n, error))).toEqual([
      1000,
      2000,
      4000,
      8000,
      AUTH_WAIT_CAP_MS,
      AUTH_WAIT_CAP_MS,
      AUTH_WAIT_CAP_MS,
      AUTH_WAIT_CAP_MS,
    ]);
  });

  it('the waits for a session do not count against the five: a ranked failure is judged on its rank', () => {
    // Forty failures so far according to React Query — thirty-nine of them
    // waits for a session. For the network this is the first one.
    const first = rankTransientFailure(noAnswer(), 1);
    expect(mutationRetry(40, first)).toBe(true);
    expect(mutationRetryDelay(40, first)).toBe(1000);

    const fifth = rankTransientFailure(noAnswer(), 5);
    expect(mutationRetry(44, fifth)).toBe(true);
    expect(mutationRetryDelay(44, fifth)).toBe(16000);

    const sixth = rankTransientFailure(noAnswer(), 6);
    expect(mutationRetry(45, sixth)).toBe(false);
  });

  it('a refusal is never sent again, whatever came before', () => {
    const refusal = { code: '42501', details: null, hint: null, message: 'permission denied for table set_logs' };

    expect(mutationRetry(0, refusal)).toBe(false);
    expect(mutationRetry(3, rankTransientFailure(refusal, 1))).toBe(false);
  });
});
