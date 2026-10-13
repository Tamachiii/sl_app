// The session as this device stores it, read without asking auth-js.
//
// supabase-js keeps the session of the signed-in account in localStorage,
// under `supabase.auth.storageKey` (`sb-<project ref>-auth-token`), and
// `auth.getSession()` is the door it offers to it. That door does more than
// read. When the access token has expired — an hour after the last refresh, so
// at most launches of an installed app — it first asks the server for a new
// one, and without a network that request is attempted for about 25 seconds
// before the call gives up. Start-up makes it twice (the client's own
// initialisation, then the call), and the answer after those 50 seconds is "no
// session", with an error next to it — although the session is still stored,
// and will be refreshed as soon as the network is back.
//
// So "who is signed in on this device" is read here, from the same place, at
// once. It is what the app shows and routes by. It is not what a request is
// sent with: the token of a request still comes from auth-js, and the database
// judges it.
//
// Two things in this file follow the library and are held to it by
// storedSession.test.js, which runs them against the real client: where the
// session is stored and in which shape, and what "no stored session" means to
// `getSession()`.

import { supabase } from './supabase';

// The key auth-js stores the session under. A client that does not say (a
// test's stand-in for lib/supabase) stores nothing this file could read.
function storageKey() {
  const key = supabase.auth?.storageKey;
  return typeof key === 'string' && key !== '' ? key : null;
}

/**
 * The user of the session this device stores, or null when it stores none —
 * the object auth-js would hand out as `session.user`. Synchronous, and no
 * request: it says who signed in here and has not signed out since, not that
 * the server still agrees.
 */
export function readStoredUser() {
  const key = storageKey();
  if (!key) return null;
  try {
    const session = JSON.parse(localStorage.getItem(key));
    if (!session || typeof session !== 'object') return null;
    // What auth-js itself asks of a stored session before it uses it.
    if (!('access_token' in session) || !('refresh_token' in session) || !('expires_at' in session)) return null;
    const { user } = session;
    return user && typeof user === 'object' && typeof user.id === 'string' && user.id !== '' ? user : null;
  } catch {
    // No storage, or something else under the key: nobody.
    return null;
  }
}

/**
 * True for the `storage` event of ANOTHER tab that removed the stored session,
 * or emptied the storage — a browser never sends the event to the tab that
 * made the change. It says what that tab did, not what the device stores by
 * the time the event arrives: ask `readStoredUser()` as well.
 */
export function isStoredSessionRemoval(event) {
  const key = storageKey();
  if (!key || !event || event.newValue != null) return false;
  // `key` is null when the whole storage was cleared.
  return event.key === key || event.key === null;
}

/**
 * Take the stored session off this device. The next `auth.getSession()` — of
 * this page or of the next launch — answers "no session".
 *
 * auth-js is not told, and so tells nobody: the other tabs of the app learn
 * it from the `storage` event alone (`isStoredSessionRemoval`).
 *
 * This is the sign-out of a device that cannot reach the server.
 * `auth.signOut()` removes the stored session only once the server has
 * answered the logout request (with any scope, `'local'` included): without a
 * network it returns an error and leaves the device signed in. The session
 * that stays behind on the server is of no use to anyone — the only copy of
 * its refresh token was the one removed here.
 */
export function forgetStoredSession() {
  const key = storageKey();
  if (!key) return;
  try {
    // The three entries auth-js removes when it signs out.
    for (const suffix of ['', '-code-verifier', '-user']) localStorage.removeItem(key + suffix);
  } catch {
    // No storage: nothing was stored.
  }
}
