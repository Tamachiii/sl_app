// What this device remembers of the signed-in account's profile: its role and
// its name.
//
// The role decides which half of the app opens, and it lives in the database
// (`profiles.role`) — a request. An installed app is opened in a gym without
// signal: there the request cannot be made, and without a role the launch has
// nowhere to go. So the last row read from the database is kept here, and a
// launch starts from it.
//
// It is a copy for the screen. Nothing is allowed because of it: every policy
// of the database asks the row itself.

export const PROFILE_CACHE_KEY = 'sl_profile_cache';

const ROLES = new Set(['coach', 'student']);

/**
 * The profile this device knows for `userId`: `{ id, role, full_name }`, or
 * null. One account is remembered, the last one read — what is stored for
 * another account is not this one's and is not returned.
 */
export function readCachedProfile(userId) {
  if (!userId) return null;
  try {
    const stored = JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY));
    if (!stored || typeof stored !== 'object' || stored.id !== userId) return null;
    if (!ROLES.has(stored.role)) return null;
    return {
      id: stored.id,
      role: stored.role,
      full_name: typeof stored.full_name === 'string' ? stored.full_name : '',
    };
  } catch {
    // No storage, or something else under the key.
    return null;
  }
}

/** Remember a row of `profiles` as it was just read or written. */
export function writeCachedProfile(profile) {
  if (!profile?.id || !ROLES.has(profile.role)) return;
  try {
    localStorage.setItem(
      PROFILE_CACHE_KEY,
      JSON.stringify({ id: profile.id, role: profile.role, full_name: profile.full_name ?? '' }),
    );
  } catch {
    // Storage full or refused: the next launch asks the database.
  }
}

/** Nobody is signed in on this device any more. */
export function forgetCachedProfile() {
  try {
    localStorage.removeItem(PROFILE_CACHE_KEY);
  } catch {
    // No storage: nothing was stored.
  }
}
