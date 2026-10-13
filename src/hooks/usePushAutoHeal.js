import { useEffect } from 'react';
import {
  getActivePushSubscription,
  isPushSupported,
  pushPermission,
  reconcilePushSubscription,
} from '../lib/pushNotifications';
import { useAuth } from './useAuth';

// How often this device's subscription is written to the database again when
// nothing says it has to be.
export const HEAL_EVERY_MS = 60 * 60 * 1000;
// How long after an attempt that failed the next one is made.
export const HEAL_RETRY_MS = 5 * 60 * 1000;
// localStorage: `{ userId, endpoint, at, ok }` — the last attempt made from
// this device. Stored, not kept in memory: iOS closes an installed app behind
// the lock screen, and "once on load" would be once per unlock again.
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
// one thing calls for another: the push service gave the device a new address
// (the worker re-subscribes on `pushsubscriptionchange`, but it is this page
// that knows who is signed in and can write the row).
async function isDue(userId) {
  const stamp = readStamp();
  if (!stamp || stamp.userId !== userId) return true;
  const age = Date.now() - stamp.at;
  // A clock that was set back is not a reason to wait.
  if (age < 0) return true;
  if (!stamp.ok) return age >= HEAL_RETRY_MS;
  if (age >= HEAL_EVERY_MS) return true;
  const endpoint = await deviceEndpoint();
  return endpoint !== null && endpoint !== stamp.endpoint;
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
    // False: notifications are off on this device, nothing was sent, and there
    // is nothing to space out.
    if (await reconcilePushSubscription(userId)) {
      writeStamp({ userId, endpoint: await deviceEndpoint(), at: Date.now(), ok: true });
    }
  } catch {
    // Best-effort. The attempt is noted so that a network that does not answer
    // is not asked again at every unlock.
    writeStamp({ userId, endpoint: null, at: Date.now(), ok: false });
  } finally {
    healing.delete(userId);
  }
}

/**
 * App-wide Web Push self-healing. For any signed-in user (coach or student),
 * reconcile the device's live push subscription with the DB so a rotated
 * endpoint — which silently ends delivery once send-push reaps the stale row —
 * heals without the user having to re-toggle from settings.
 *
 * It looks on load and whenever the tab regains focus, and it WRITES at most
 * once an hour (HEAL_EVERY_MS): an athlete unlocks the phone after every rest,
 * and each unlock used to be an upsert. Two things are not made to wait for
 * the hour: another account on this device, and an address that is no longer
 * the one last written. A write that failed is tried again after
 * HEAL_RETRY_MS.
 *
 * Role-agnostic and best-effort: reconcilePushSubscription is UPSERT-only and
 * permission-gated, so this never subscribes, prompts, or enables push for a
 * user who didn't already opt in on this device.
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
