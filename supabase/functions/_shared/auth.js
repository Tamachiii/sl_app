// The gate of an INTERNAL Edge Function: one that only the project itself
// calls — a database trigger, through pg_net — and that is therefore deployed
// with `verify_jwt = false` (supabase/config.toml), because its caller has no
// user JWT to show. With the gateway's check off, the internet reaches the
// function directly, and this file is all that stands in front of it:
//
//   POST only         no OPTIONS, no Access-Control-* header. Nothing in a
//                     browser calls an internal function, so a browser gets
//                     no permission to.
//   a shared bearer   `Authorization: Bearer <secret>`, compared in constant
//                     time. The database keeps the same value in the vault.
//   a small body      read up to a limit and no further.
//   a JSON object     anything else is a 400 before the function sees it.
//
// RUNTIME-NEUTRAL ON PURPOSE. No `Deno.*`, no `jsr:` or `npm:` import: only
// web standards (Request, Response, streams, TextDecoder), which the Edge
// runtime and Node both have. Deno is not installed where the tests run, so
// what a function DECIDES lives in a module like this one, under vitest
// (auth.test.js), and its index.ts only reads the environment and wires
// things together. Dependencies come in as arguments.

/**
 * What an internal function accepts as a request body, in bytes. The push
 * services take a message of 4096 bytes (the size RFC 8030 has them support),
 * so a request that carries one message, a user id and a few options is well
 * under twice that.
 */
export const MAX_BODY_BYTES = 8 * 1024;

/**
 * Whether two strings are the same, in a time that does not depend on WHERE
 * they differ. `===` stops at the first character that differs, so the time
 * it takes says how long the matching prefix is; measured often enough, that
 * gives a secret away one character at a time.
 *
 * The loop runs once over `presented` — what the caller sent, which the
 * caller already knows — whatever `expected` holds, so neither the content
 * nor the length of the secret shows in the timing.
 *
 * @param {string} presented  what came in
 * @param {string} expected   the secret
 * @returns {boolean}
 */
export function timingSafeEqual(presented, expected) {
  let diff = presented.length ^ expected.length;
  for (let i = 0; i < presented.length; i += 1) {
    // An empty `expected` reads NaN here, and `x ^ NaN` is `x`.
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i % expected.length);
  }
  return diff === 0;
}

/**
 * The token of an `Authorization: Bearer <token>` header, or null when the
 * header is absent or of another scheme. The scheme is case-insensitive
 * (RFC 9110); the token is not.
 *
 * @param {string | null | undefined} authorization
 * @returns {string | null}
 */
export function bearerToken(authorization) {
  if (typeof authorization !== 'string') return null;
  return /^bearer +(.+)$/i.exec(authorization)?.[1] ?? null;
}

/**
 * Judges a secret a caller presented against the function's own copy.
 *
 *   'unset'    the function has no secret: nobody can be let in
 *   'missing'  nothing was presented
 *   'wrong'    something was presented and it is not the secret
 *   'ok'
 *
 * @param {string | null | undefined} presented  the value, as received
 * @param {string | null | undefined} secret     the function's own copy
 * @returns {'ok' | 'unset' | 'missing' | 'wrong'}
 */
export function checkSecret(presented, secret) {
  // First, and whatever was presented: with an empty secret, an empty value
  // would otherwise be "equal" to it.
  if (typeof secret !== 'string' || secret === '') return 'unset';
  if (typeof presented !== 'string' || presented === '') return 'missing';
  return timingSafeEqual(presented, secret) ? 'ok' : 'wrong';
}

/**
 * The same judgement on an `Authorization: Bearer <secret>` header.
 *
 * @param {string | null | undefined} authorization  the header, as received
 * @param {string | null | undefined} secret         the function's own copy
 * @returns {'ok' | 'unset' | 'missing' | 'wrong'}
 */
export function checkBearer(authorization, secret) {
  return checkSecret(bearerToken(authorization), secret);
}

/**
 * The body of a request, or null when it is larger than `maxBytes`.
 *
 * Content-Length is believed when it says "too large" — nothing is read then
 * — and never when it says "small enough": a chunked body has none, and a
 * caller can declare any number. The stream is counted as it is read, and
 * dropped at the first byte over.
 *
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Promise<Uint8Array | null>}
 */
export async function readBody(request, maxBytes) {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > maxBytes) return null;
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * A refusal. Plain text that starts with the function's name, so that
 * whoever reads the answer can tell the function's own refusal from the
 * gateway's — which means the function was deployed with JWT verification on
 * (docs/runbook/30-edge-functions.md).
 *
 * No Access-Control-* header, here or anywhere: see the top of the file.
 *
 * @param {string} name
 * @param {number} status
 * @param {string} text
 * @param {Record<string, string>} [headers]
 * @returns {{ response: Response, body: null }}
 */
function refuse(name, status, text, headers = {}) {
  return {
    response: new Response(`${name}: ${text}`, {
      status,
      headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
    }),
    body: null,
  };
}

/**
 * Lets a request into an internal function, or answers it.
 *
 *   405  not a POST (a CORS preflight is an OPTIONS: it ends here)
 *   500  the function has no secret — it refuses everyone, and says so in
 *        its log, because a 401 would send the owner looking at the caller
 *   401  no bearer, or not the right one
 *   413  body over `maxBodyBytes`
 *   400  body that is not a JSON object
 *
 * The bearer is judged before a single byte of the body is read. What was
 * presented is never logged.
 *
 * `name` is the function's name: it starts every refusal and every log line.
 * `bearer` is the shared secret, the project's INTERNAL_BEARER.
 *
 * @param {Request} request
 * @param {{
 *   name: string,
 *   bearer: string | null | undefined,
 *   maxBodyBytes?: number,
 *   log?: { warn: (message: string) => void, error: (message: string) => void },
 * }} options
 * @returns {Promise<{ response: Response, body: null } | { response: null, body: Record<string, unknown> }>}
 *   `response` when the request is refused — return it as it is; otherwise
 *   `body`, the parsed JSON object.
 */
export async function admitInternalRequest(request, {
  name,
  bearer,
  maxBodyBytes = MAX_BODY_BYTES,
  log = console,
}) {
  if (request.method !== 'POST') {
    return refuse(name, 405, 'method not allowed', { allow: 'POST' });
  }

  const verdict = checkBearer(request.headers.get('authorization'), bearer);
  if (verdict === 'unset') {
    log.error(`${name}: INTERNAL_BEARER is not set, every call is refused`);
    return refuse(name, 500, 'not configured');
  }
  if (verdict !== 'ok') {
    log.warn(`${name}: refused, ${verdict === 'missing' ? 'no bearer' : 'wrong bearer'}`);
    return refuse(name, 401, 'unauthorized', { 'www-authenticate': 'Bearer' });
  }

  // From here on the caller is the project itself, and it does not read the
  // answer (a trigger queues the call and moves on): the log line is the
  // only trace of a refusal.
  const bytes = await readBody(request, maxBodyBytes);
  if (bytes === null) {
    log.warn(`${name}: refused, body over ${maxBodyBytes} bytes`);
    return refuse(name, 413, 'payload too large');
  }

  let body;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    body = null;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    log.warn(`${name}: refused, body is not a JSON object`);
    return refuse(name, 400, 'bad request');
  }
  return { response: null, body };
}
