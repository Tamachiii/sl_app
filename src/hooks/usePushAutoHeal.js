import { useEffect } from 'react';
import {
  getActivePushSubscription,
  isPushResumable,
  isPushSupported,
  pushPermission,
  reconcilePushSubscription,
  resumePushSubscription,
} from '../lib/pushNotifications';
import { useAuth } from './useAuth';

// How often this device's subscription is written to the database again when
// nothing says it has to be.
export const HEAL_EVERY_MS = 60 * 60 * 1000;
// How long after an attempt that failed the next one is made.
export const HEAL_RETRY_MS = 5 * 60 * 1000;
// localStorage: `{ userId, endpoint, at, ok, code? }` — the last attempt made
// from this device: for which account, about which address of the device, when,
// whether the database took it, and — when it did not — the code of what
// failed (lib/pushNotifications.js). Stored, not kept in memory: iOS closes an
// installed app behind the lock screen, and "once on load" would be once per
// unlock again.
export const HEAL_STAMP_KEY = 'sl_push_heal';

function readStamp() {
  try {
    const stamp = JSON.parse(localStorage.getItem(HEAL_STAMP_KEY));
    return stamp && typeof stamp === 'object' && Number.isFinite(stamp.at) ? stamp : null;
  } catch {
    return null;
  }
}

function writeStamp(stamp) {
  try {
    localStorage.setItem(HEAL_STAMP_KEY, JSON.stringify(stamp));
  } catch {
    // Storage full or refused: the next return to the app heals again.
  }
}

// The address the push service gave this device, read from the browser — no
// request. Null when notifications are off here.
async function deviceEndpoint() {
  if (!isPushSupported() || pushPermission() !== 'granted') return null;
  try {
    return (await getActivePushSubscription())?.endpoint ?? null;
  } catch {
    return null;
  }
}

// Whether a request is due for this user. Within the hour after a heal only
// two things call for another: the push service gave the device a new address
// (the worker re-subscribes on `pushsubscriptionchange`, but it is this page
// that knows who is signed in and can write the row), and the account signed
// out of this device and is back — its notifications left with it, and are to
// come back with it.
async function isDue(userId) {
  const stamp = readStamp();
  if (!stamp || stamp.userId !== userId) return true;
  const age = Date.now() - stamp.at;
  // A clock that was set back is not a reason to wait.
  if (age < 0) return true;
  if (!stamp.ok) return age >= HEAL_RETRY_MS;
  if (age >= HEAL_EVERY_MS) return true;
  if (isPushResumable(userId)) return true;
  const endpoint = await deviceEndpoint();
  return endpoint !== null && endpoint !== stamp.endpoint;
}

/**
 * What this device last told the database about the subscription it holds
 * NOW, for this account: `{ ok: true }` when the database took it,
 * `{ ok: false, code }` when it did not — `code` is the one of
 * lib/pushNotifications.js. Null when the stamp is about another account or
 * another address, or the device holds no subscription: nothing was said.
 *
 * For the notification toggle (`usePushSubscription`), which is mounted long
 * after the look was made: a registration the database refuses for good is a
 * reason it can print, and "registered from here an hour ago" is what is left
 * to go by when the database cannot be asked.
 */
export async function lastHeal(userId) {
  const stamp = readStamp();
  if (!userId || !stamp || stamp.userId !== userId) return null;
  const endpoint = await deviceEndpoint();
  if (endpoint === null || stamp.endpoint !== endpoint) return null;
  if (stamp.ok) return { ok: true, code: '' };
  return { ok: false, code: typeof stamp.code === 'string' && stamp.code !== '' ? stamp.code : 'generic' };
}

/**
 * The device was registered for this account by something else than a look of
 * this file — the toggle. Written down as a look that succeeded: the next one
 * has nothing to send for an hour, and the device remembers it is registered.
 */
export async function noteHealed(userId) {
  const endpoint = await deviceEndpoint();
  if (userId && endpoint !== null) writeStamp({ userId, endpoint, at: Date.now(), ok: true });
}

// The users a heal is under way for: two events in the same moment — the load
// and the page becoming visible — are one request.
const healing = new Set();

async function heal(userId) {
  // Nothing can be sent, and a failure here would only delay the next try.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  if (healing.has(userId)) return;
  healing.add(userId);
  try {
    if (!(await isDue(userId))) return;
    // The subscription the device holds is registered for this account — or,
    // when it holds none because this account signed out of it with
    // notifications on, they are switched on again. False twice: notifications
    // are off on this device, nothing was sent, and there is nothing to space
    // out.
    if ((await reconcilePushSubscription(userId)) || (await resumePushSubscription(userId))) {
      writeStamp({ userId, endpoint: await deviceEndpoint(), at: Date.now(), ok: true });
    }
  } catch (error) {
    // Best-effort: nobody is told now, nothing is thrown. But the attempt is
    // noted, with what failed. With its time, so that a network that does not
    // answer is not asked again at every unlock; with its code and the address
    // it was about, so that the failure is not lost — `lastHeal` hands it to
    // the toggle. It used to be caught and forgotten, and the toggle of a
    // device the database refused went on saying "on".
    const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'generic';
    writeStamp({ userId, endpoint: await deviceEndpoint(), at: Date.now(), ok: false, code });
  } finally {
    healing.delete(userId);
  }
}

/**
 * App-wide Web Push self-healing. For any signed-in user (coach or student),
 * reconcile the device's live push subscription with the DB so a rotated
 * endpoint — which silently ends delivery once send-push reaps the stale row —
 * heals without the user having to re-toggle from settings, and so a
 * subscription the previous account left on a shared device moves to the
 * account that is signed in on it now.
 *
 * It looks on load and whenever the tab regains focus, and it WRITES at most
 * once an hour (HEAL_EVERY_MS): an athlete unlocks the phone after every rest,
 * and each unlock used to be an upsert. Three things are not made to wait for
 * the hour: another account on this device, an address that is no longer the
 * one last written, and an account that is back on a device it signed out of
 * with notifications on. A write that failed is tried again after
 * HEAL_RETRY_MS.
 *
 * Role-agnostic and best-effort, and it never prompts. reconcilePushSubscription
 * registers only a subscription the browser already holds;
 * resumePushSubscription asks the browser for one only for an account that had
 * one here when it signed out, and only while the permission still stands. An
 * account that never switched notifications on, on this device, is never
 * enrolled by a look.
 */
export function usePushAutoHeal() {
  const { user } = useAuth();
  const userId = user?.id;

  useEffect(() => {
    if (!userId) return undefined;
    heal(userId);
    function onVisibility() {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') heal(userId);
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [userId]);
}
