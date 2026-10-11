// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_BODY_BYTES,
  admitInternalRequest,
  bearerToken,
  checkBearer,
  checkSecret,
  readBody,
  timingSafeEqual,
} from './auth.js';

// The gate of the internal Edge Functions (send-push today). The functions
// are Deno; this module is not, so that it can be run here: what is tested is
// the code the function runs, on the Request the runtime hands it.

const SECRET = '5f2b7c1e9a4d4e0c8b6a3f1d2c7e9b0a5f2b7c1e9a4d4e0c8b6a3f1d2c7e9b0a';
const URL = 'http://functions.invalid/functions/v1/send-push';

const silent = () => ({ warn: vi.fn(), error: vi.fn() });
const logged = (log) => [...log.warn.mock.calls, ...log.error.mock.calls].flat().join('\n');

function post(body, headers = {}) {
  return new Request(URL, { method: 'POST', headers, body });
}

const authorized = (body, headers = {}) => post(body, { authorization: `Bearer ${SECRET}`, ...headers });

// A body that arrives in pieces, with no Content-Length: what a chunked
// request looks like. `pulled` counts the pieces the reader asked for.
function streamed(chunks, headers = {}) {
  const state = { pulled: 0, canceled: false };
  const body = new ReadableStream({
    pull(controller) {
      if (state.pulled === chunks.length) return controller.close();
      controller.enqueue(chunks[state.pulled]);
      state.pulled += 1;
      return undefined;
    },
    cancel() { state.canceled = true; },
  }, { highWaterMark: 0 });
  const request = new Request(URL, { method: 'POST', headers, body, duplex: 'half' });
  return { request, state };
}

const bytes = (n, fill = 0x61) => new Uint8Array(n).fill(fill);
const admit = (request, options = {}) => admitInternalRequest(request, {
  name: 'send-push', bearer: SECRET, log: silent(), ...options,
});

describe('timingSafeEqual', () => {
  it('says whether two strings are the same', () => {
    expect(timingSafeEqual(SECRET, SECRET)).toBe(true);
    expect(timingSafeEqual('', '')).toBe(true);
    expect(timingSafeEqual('clé-ü-密', 'clé-ü-密')).toBe(true);

    expect(timingSafeEqual(`x${SECRET.slice(1)}`, SECRET)).toBe(false);   // first character
    expect(timingSafeEqual(`${SECRET.slice(0, -1)}x`, SECRET)).toBe(false); // last character
    expect(timingSafeEqual(SECRET.toUpperCase(), SECRET)).toBe(false);
    expect(timingSafeEqual(SECRET.slice(0, -1), SECRET)).toBe(false);      // a prefix
    expect(timingSafeEqual(`${SECRET}a`, SECRET)).toBe(false);             // the secret, and more
    expect(timingSafeEqual(SECRET + SECRET, SECRET)).toBe(false);          // the secret, twice
    expect(timingSafeEqual('', SECRET)).toBe(false);
    expect(timingSafeEqual(SECRET, '')).toBe(false);
    expect(timingSafeEqual('clé', 'cle')).toBe(false);
  });

  // The property that `===` does not have. Timing cannot be asserted in a
  // test, the amount of work can: every character of what was presented is
  // read, once, wherever the first difference is and however long the secret.
  it('reads all of what was presented, wherever the first difference is', () => {
    const reads = (presented, expected) => {
      const spy = { length: presented.length, charCodeAt: vi.fn((i) => presented.charCodeAt(i)) };
      const result = timingSafeEqual(spy, expected);
      return { result, count: spy.charCodeAt.mock.calls.length };
    };
    const length = SECRET.length;

    expect(reads(SECRET, SECRET)).toEqual({ result: true, count: length });
    expect(reads(`x${SECRET.slice(1)}`, SECRET)).toEqual({ result: false, count: length });
    expect(reads(`${SECRET.slice(0, -1)}x`, SECRET)).toEqual({ result: false, count: length });
    expect(reads('x'.repeat(length), SECRET)).toEqual({ result: false, count: length });
    // The work follows the length of what came in, never the secret's.
    expect(reads('abc', SECRET)).toEqual({ result: false, count: 3 });
    expect(reads('abc', 'a much longer secret than that')).toEqual({ result: false, count: 3 });
    expect(reads(`${SECRET}${SECRET}`, SECRET)).toEqual({ result: false, count: 2 * length });
  });
});

describe('bearerToken', () => {
  it('reads the token of a Bearer header', () => {
    expect(bearerToken(`Bearer ${SECRET}`)).toBe(SECRET);
    expect(bearerToken(`bearer ${SECRET}`)).toBe(SECRET);
    expect(bearerToken(`BEARER   ${SECRET}`)).toBe(SECRET);
    expect(bearerToken('Bearer a b')).toBe('a b');
  });

  it('finds none in anything else', () => {
    for (const header of [null, undefined, '', 'Bearer', 'Bearer ', SECRET, `Basic ${SECRET}`, `Bearer${SECRET}`, ` Bearer ${SECRET}`]) {
      expect(bearerToken(header), JSON.stringify(header)).toBeNull();
    }
  });
});

describe('checkBearer', () => {
  it('accepts the secret, and only the secret', () => {
    expect(checkBearer(`Bearer ${SECRET}`, SECRET)).toBe('ok');
    expect(checkBearer(`bearer ${SECRET}`, SECRET)).toBe('ok');

    expect(checkBearer(`Bearer ${SECRET.slice(0, -1)}`, SECRET)).toBe('wrong');
    expect(checkBearer(`Bearer ${SECRET}0`, SECRET)).toBe('wrong');
    expect(checkBearer(`Bearer ${SECRET.toUpperCase()}`, SECRET)).toBe('wrong');
    expect(checkBearer(`Bearer ${SECRET} ${SECRET}`, SECRET)).toBe('wrong');
    expect(checkBearer('Bearer undefined', SECRET)).toBe('wrong');
    expect(checkBearer('Bearer null', SECRET)).toBe('wrong');
  });

  it('tells a request with no bearer from one with the wrong bearer', () => {
    for (const header of [null, undefined, '', 'Bearer', `Basic ${SECRET}`, SECRET]) {
      expect(checkBearer(header, SECRET), JSON.stringify(header)).toBe('missing');
    }
  });

  // The deployed function compared against `Bearer ${INTERNAL_BEARER}`: with
  // the variable missing, that string is "Bearer undefined" — a bearer anyone
  // can type. An unset secret lets nobody in, whatever they present.
  it('lets nobody in when the function has no secret', () => {
    for (const secret of [undefined, null, '']) {
      for (const header of [null, '', 'Bearer', 'Bearer ', 'Bearer undefined', 'Bearer null', `Bearer ${SECRET}`]) {
        expect(checkBearer(header, secret), `${JSON.stringify(header)} against ${JSON.stringify(secret)}`).toBe('unset');
      }
    }
  });
});

// The same judgement without the `Bearer ` in front: for a function that
// takes the secret in a header of its own.
describe('checkSecret', () => {
  it('judges a bare value the way checkBearer judges a header', () => {
    expect(checkSecret(SECRET, SECRET)).toBe('ok');
    expect(checkSecret(`${SECRET}0`, SECRET)).toBe('wrong');
    expect(checkSecret(`Bearer ${SECRET}`, SECRET)).toBe('wrong');
    for (const presented of [null, undefined, '']) expect(checkSecret(presented, SECRET)).toBe('missing');
    for (const secret of [null, undefined, '']) {
      for (const presented of [null, '', 'undefined', SECRET]) expect(checkSecret(presented, secret)).toBe('unset');
    }
  });
});

describe('readBody', () => {
  it('returns the bytes of a body within the limit', async () => {
    expect(await readBody(post('{"a":1}'), 100)).toEqual(new TextEncoder().encode('{"a":1}'));
    expect(await readBody(post(bytes(100)), 100)).toHaveLength(100);
    expect(await readBody(post(undefined), 100)).toHaveLength(0);
    const pieces = streamed([bytes(40), bytes(40), bytes(20)]);
    expect(await readBody(pieces.request, 100)).toHaveLength(100);
  });

  it('returns null for one byte over', async () => {
    expect(await readBody(post(bytes(101)), 100)).toBeNull();
  });

  it('does not read a body that declares itself too large', async () => {
    const { request, state } = streamed([bytes(10)], { 'content-length': '101' });
    expect(await readBody(request, 100)).toBeNull();
    expect(state.pulled).toBe(0);
    expect(request.bodyUsed).toBe(false);
  });

  // Content-Length is the caller's word. Absent (chunked) or lying, the
  // stream is counted, and left at the first piece that goes over.
  it('counts a body that declares nothing, or less than it sends, and stops reading at the limit', async () => {
    const pieces = Array.from({ length: 50 }, () => bytes(30));

    const chunked = streamed(pieces);
    expect(await readBody(chunked.request, 100)).toBeNull();
    expect(chunked.state.pulled).toBe(4); // 120 bytes: the fourth piece is the one over
    expect(chunked.state.canceled).toBe(true);

    const lying = streamed(pieces, { 'content-length': '12' });
    expect(await readBody(lying.request, 100)).toBeNull();
    expect(lying.state.pulled).toBe(4);
    expect(lying.state.canceled).toBe(true);
  });
});

describe('admitInternalRequest', () => {
  const VALID = JSON.stringify({ user_id: '00000000-0000-0000-0000-000000000000', payload: { title: 'Hello' } });

  it('lets in a POST that carries the secret and a JSON object, and hands the object over', async () => {
    const admitted = await admit(authorized(VALID));
    expect(admitted.response).toBeNull();
    expect(admitted.body).toEqual({ user_id: '00000000-0000-0000-0000-000000000000', payload: { title: 'Hello' } });
  });

  it('answers 401 without a bearer, in words that name the function', async () => {
    const log = silent();
    const { response, body } = await admit(post(VALID), { log });
    expect(body).toBeNull();
    expect(response.status).toBe(401);
    // The runbook's check tells this answer from the gateway's by its text.
    expect(await response.text()).toBe('send-push: unauthorized');
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(log.warn).toHaveBeenCalledWith('send-push: refused, no bearer');
  });

  it('answers 401 to a wrong bearer, and logs neither what was presented nor the secret', async () => {
    const presented = `${SECRET.slice(0, -4)}beef`;
    const log = silent();
    const { response } = await admit(post(VALID, { authorization: `Bearer ${presented}` }), { log });
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('send-push: unauthorized');
    expect(log.warn).toHaveBeenCalledWith('send-push: refused, wrong bearer');
    expect(logged(log)).not.toContain(presented);
    expect(logged(log)).not.toContain(SECRET);
    expect(logged(log)).not.toContain(SECRET.slice(0, 8));
  });

  it('refuses a bearer of another scheme, and the secret sent where it does not belong', async () => {
    for (const headers of [
      { authorization: `Basic ${SECRET}` },
      { authorization: SECRET },
      { apikey: SECRET },
      { 'x-internal-bearer': SECRET },
    ]) {
      expect((await admit(post(VALID, headers))).response.status, JSON.stringify(headers)).toBe(401);
    }
  });

  it('does not read the body of a request it does not know', async () => {
    const { request, state } = streamed([bytes(10)]);
    const { response } = await admit(request);
    expect(response.status).toBe(401);
    expect(state.pulled).toBe(0);
    // A wrong bearer with a body too large is a 401, not a 413.
    const big = post(bytes(MAX_BODY_BYTES + 1), { authorization: 'Bearer nope' });
    expect((await admit(big)).response.status).toBe(401);
    expect(big.bodyUsed).toBe(false);
  });

  it('answers 500 and lets nobody in while the function has no secret', async () => {
    for (const bearer of [undefined, null, '']) {
      for (const authorization of [null, 'Bearer', 'Bearer ', 'Bearer undefined', 'Bearer null', `Bearer ${SECRET}`]) {
        const log = silent();
        const headers = authorization === null ? {} : { authorization };
        const { response, body } = await admit(post(VALID, headers), { bearer, log });
        const where = `${JSON.stringify(authorization)} against ${JSON.stringify(bearer)}`;
        expect(body, where).toBeNull();
        expect(response.status, where).toBe(500);
        expect(await response.text()).toBe('send-push: not configured');
        expect(log.error).toHaveBeenCalledWith('send-push: INTERNAL_BEARER is not set, every call is refused');
      }
    }
  });

  it('accepts POST only: a preflight gets no permission', async () => {
    const preflight = new Request(URL, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://tamachiii.github.io',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    const others = ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE'].map((method) => new Request(URL, {
      method, headers: { authorization: `Bearer ${SECRET}` },
    }));
    for (const request of [preflight, ...others]) {
      const { response, body } = await admit(request);
      expect(body, request.method).toBeNull();
      expect(response.status, request.method).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
      expect(await response.text()).toBe('send-push: method not allowed');
    }
  });

  it('answers 413 to a body over the limit, declared or not', async () => {
    const log = silent();
    const declared = await admit(authorized(bytes(101)), { maxBodyBytes: 100, log });
    expect(declared.body).toBeNull();
    expect(declared.response.status).toBe(413);
    expect(await declared.response.text()).toBe('send-push: payload too large');
    expect(log.warn).toHaveBeenCalledWith('send-push: refused, body over 100 bytes');

    const chunked = streamed(Array.from({ length: 50 }, () => bytes(30)), { authorization: `Bearer ${SECRET}` });
    expect((await admit(chunked.request, { maxBodyBytes: 100 })).response.status).toBe(413);
    expect(chunked.state.pulled).toBe(4);
  });

  it('limits a body to 8 kB unless told otherwise, counted in bytes', async () => {
    expect(MAX_BODY_BYTES).toBe(8192);
    const padded = (size, char = 'a') => {
      const empty = JSON.stringify({ user_id: 'u', payload: { body: '' } });
      const width = new TextEncoder().encode(char).length;
      return JSON.stringify({ user_id: 'u', payload: { body: char.repeat((size - empty.length) / width) } });
    };
    const size = (text) => new TextEncoder().encode(text).length;

    const atLimit = padded(MAX_BODY_BYTES);
    expect(size(atLimit)).toBe(MAX_BODY_BYTES);
    expect((await admit(authorized(atLimit))).response).toBeNull();

    const over = padded(MAX_BODY_BYTES + 1);
    expect(size(over)).toBe(MAX_BODY_BYTES + 1);
    expect((await admit(authorized(over))).response.status).toBe(413);

    // Half as many characters as the limit, three bytes each.
    const wide = padded(MAX_BODY_BYTES + 1024 + 2, '密');
    expect(wide.length).toBeLessThan(MAX_BODY_BYTES / 2);
    expect(size(wide)).toBeGreaterThan(MAX_BODY_BYTES);
    expect((await admit(authorized(wide))).response.status).toBe(413);
  });

  it('answers 400 to a body that is not a JSON object', async () => {
    const notObjects = ['', 'not json', '{"user_id":', '[]', '[{"user_id":"u"}]', '"text"', '42', 'true', 'null'];
    for (const text of notObjects) {
      const log = silent();
      const { response, body } = await admit(authorized(text), { log });
      expect(body, JSON.stringify(text)).toBeNull();
      expect(response.status, JSON.stringify(text)).toBe(400);
      expect(await response.text()).toBe('send-push: bad request');
      expect(log.warn).toHaveBeenCalledWith('send-push: refused, body is not a JSON object');
    }
    // Bytes that are not UTF-8.
    const latin1 = Uint8Array.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xe9, 0x22, 0x7d]); // {"a":"é"} in Latin-1
    expect((await admit(authorized(latin1))).response.status).toBe(400);
  });

  // send-push used to answer every request, refusals included, with
  // `Access-Control-Allow-Origin: *`. Its only caller is the database.
  it('never sends a CORS header, whatever the answer', async () => {
    const origin = { origin: 'https://tamachiii.github.io' };
    const answers = await Promise.all([
      admit(new Request(URL, { method: 'OPTIONS', headers: { ...origin, 'access-control-request-method': 'POST' } })),
      admit(new Request(URL, { headers: origin })),
      admit(post(VALID, origin)),
      admit(post(VALID, { ...origin, authorization: 'Bearer nope' })),
      admit(post(VALID, origin), { bearer: '' }),
      admit(authorized(bytes(101), origin), { maxBodyBytes: 100 }),
      admit(authorized('nope', origin)),
    ]);
    expect(answers.map(({ response }) => response.status)).toEqual([405, 405, 401, 401, 500, 413, 400]);
    for (const { response } of answers) {
      const names = [...response.headers.keys()];
      expect(names.filter((name) => name.startsWith('access-control-')), `HTTP ${response.status}`).toEqual([]);
      expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    }
  });

  it('names the function it guards in every refusal and every log line', async () => {
    const log = silent();
    const { response } = await admitInternalRequest(post(VALID), { name: 'invite-athlete', bearer: SECRET, log });
    expect(await response.text()).toBe('invite-athlete: unauthorized');
    expect(log.warn).toHaveBeenCalledWith('invite-athlete: refused, no bearer');
  });
});
