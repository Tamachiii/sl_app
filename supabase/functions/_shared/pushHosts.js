// The push services a device of this app can be registered at, and nothing
// else: the question a function asks before it sends anything to an address
// it read from `push_subscriptions`.
//
// A subscription is an address the browser was given by its maker's push
// service, and the functions POST to it. Without a rule on what that address
// may be, a row is a way to make them call any URL (review B3).
//
// THE SAME LIST IS IN THE DATABASE: the check constraint
// `push_subscriptions_endpoint_known_push_service` (migration
// 2026_10_13_15_push_plumbing, and schema.sql) is the expression below,
// character for character. A push service is added in both, in one commit,
// with its examples in supabase/tests/fixtures/push-endpoints.json —
// pushHosts.test.js holds this file to the constraint and to those examples.
//
//   fcm.googleapis.com                   Chrome, Edge, and every browser on Android
//   updates.push.services.mozilla.com    Firefox
//   <anything>.push.apple.com            Safari, and every browser on iOS
//   <anything>.notify.windows.com        the Edge of before Chromium
//
// The function is the second lock, not the first: the constraint was added
// NOT VALID where rows were in the way, the rows that predate it are still
// read, and a function does not go by what a table promises.
//
// RUNTIME-NEUTRAL, like every module of this folder: web standards only.
//
// (The names are handed out in one list at the end of the file: the CLI that
// uploads a function reads a quoted word after that keyword as a file to
// upload — ../deploy.test.js.)

// https, one of the four hosts, then a path. Lower case, no port, no user
// name: as the browser hands it over. Postgres reads the expression the same
// way (`endpoint ~ '<this>'`).
const PUSH_ENDPOINT_PATTERN = '^https://(fcm[.]googleapis[.]com|updates[.]push[.]services[.]mozilla[.]com|[a-z0-9.-]+[.]push[.]apple[.]com|[a-z0-9.-]+[.]notify[.]windows[.]com)/';

const PUSH_ENDPOINT = new RegExp(PUSH_ENDPOINT_PATTERN);

/**
 * Whether `endpoint` is an address at a known push service.
 *
 * Two readings must agree: the expression the database uses, on the text as
 * it is, and a URL parser's — which is what the HTTP client that sends the
 * push will go by. A text that passes the first and in which a parser finds
 * another host, a port or a user name is refused.
 *
 * @param {unknown} endpoint
 * @returns {boolean}
 */
function isPushEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || !PUSH_ENDPOINT.test(endpoint)) return false;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === 'https:'
    && url.username === ''
    && url.password === ''
    && url.port === ''
    && endpoint.startsWith(`https://${url.hostname}/`);
}

/**
 * The host of an endpoint, for a log line: enough to tell which push service
 * answered, and nothing of the path, which is the device's own address.
 *
 * @param {unknown} endpoint
 * @returns {string} the host, or `not-a-url`
 */
function pushHost(endpoint) {
  if (typeof endpoint !== 'string') return 'not-a-url';
  try {
    return new URL(endpoint).hostname || 'not-a-url';
  } catch {
    return 'not-a-url';
  }
}

export { PUSH_ENDPOINT_PATTERN, isPushEndpoint, pushHost };
