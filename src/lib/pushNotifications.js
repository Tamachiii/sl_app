// Web Push helpers — owns the PushManager.subscribe handshake, registers the
// subscription in the `push_subscriptions` table, and exposes high-level
// `enablePush` / `disablePush` for the notification toggles (StudentProfile,
// UserMenu).
//
// Everything here is iOS-PWA-aware: PushManager is only available on
// iOS 16.4+ for an installed (home-screen) PWA. `isPushSupported` reflects
// that — the Profile toggle is hidden on environments that won't grant a
// subscription.
//
// WHOSE A DEVICE IS. A browser holds ONE push subscription for the app,
// whoever is signed in, and `push_subscriptions` holds one row per endpoint.
// The row is written by `claim_push_subscription` (migration
// 2026_10_13_13_ensure_claim_rpcs.sql), which gives the device to the account
// that calls: a new row, the caller's own refreshed, or the row of the account
// that used this device before — taken over on the proof of the two keys only
// this browser holds. The app used to upsert the row itself, under policies
// that let an account write its own rows only: on a shared device the second
// account was refused, and the device went on receiving the first one's
// notifications.

import { supabase } from './supabase';
import { isNetworkError } from './networkErrors';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || '';

// `navigator.onLine === false` is the reliable half of that property: no
// network interface at all.
const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

export function isPushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    typeof Notification !== 'undefined' &&
    !!VAPID_PUBLIC_KEY
  );
}

export function pushPermission() {
  if (typeof Notification === 'undefined') return 'denied';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

// Thrown errors carry a stable `.code` so the UI can localize the message
// instead of surfacing the raw English string — or, as it used to for an
// answer of the database, an SQLSTATE the dictionaries have no words for.
//   'unsupported'        no push on this browser
//   'not_signed_in'      nobody is signed in, or the request left without a session
//   'permission_denied'  notifications are blocked, or the prompt was declined
//   'sw_not_ready'       no service worker registration
//   'offline'            the request got no answer
//   'endpoint_refused'   the browser's push service is not one the database
//                        accepts (push_subscriptions_endpoint_known_push_service)
//   'keys_mismatch'      another account holds this endpoint under other keys
//   'generic'            anything else
// `cause` is what was caught, for whoever debugs.
function pushError(message, code, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause !== undefined) err.cause = cause;
  return err;
}

// The words of each code: the i18n key a toggle shows. The first five are in
// the dictionaries; the others are this package's fragment
// (i18n/fragments/core-push-identity.*). A code that is not listed — a new
// one, or something that is not a code of this file at all — reads as
// 'generic': a toggle never shows a key instead of a sentence.
export const PUSH_ERROR_KEYS = Object.freeze({
  unsupported: 'common.pushError.unsupported',
  not_signed_in: 'common.pushError.not_signed_in',
  permission_denied: 'common.pushError.permission_denied',
  sw_not_ready: 'common.pushError.sw_not_ready',
  generic: 'common.pushError.generic',
  offline: 'pushIdentity.offline',
  endpoint_refused: 'pushIdentity.endpoint_refused',
});

/** The i18n key of an error code of this file; '' for no error. */
export function pushErrorKey(code) {
  if (!code) return '';
  const known = typeof code === 'string' && Object.prototype.hasOwnProperty.call(PUSH_ERROR_KEYS, code);
  return known ? PUSH_ERROR_KEYS[code] : PUSH_ERROR_KEYS.generic;
}

// The CHECK on push_subscriptions.endpoint: an address at a known push
// service (migration 2026_10_13_15_push_plumbing.sql). A write it refuses is
// 23514 and names it.
const ENDPOINT_RULE = 'push_subscriptions_endpoint_known_push_service';

// What supabase-js handed back for a request about this device's row, as an
// error with a code of this file.
function refusal(error) {
  let code = 'generic';
  if (isNetworkError(error)) {
    code = 'offline';
  } else if (error?.code === '23514' && String(error.message || '').includes(ENDPOINT_RULE)) {
    code = 'endpoint_refused';
  } else if (error?.code === '42501') {
    // `not authorized` of the function, or `permission denied` for a request
    // that left with the anonymous key: no session went with it.
    code = 'not_signed_in';
  } else if (error?.message === 'endpoint_keys_mismatch') {
    code = 'keys_mismatch';
  }
  return pushError(error?.message || 'The push subscription could not be written', code, error);
}

// Nothing can be sent, and supabase-js would first wait — half a minute, when
// the access token has expired — for a token refresh that cannot be made
// either.
const noNetwork = () => pushError('No network: the push subscription was not written', 'offline');

// Convert a Base64-URL VAPID public key into the Uint8Array PushManager
// wants for applicationServerKey. Standard incantation.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

// Pull keys out of the PushSubscription's serialized form. The spec
// returns ArrayBuffers in the JSON; we re-encode to base64url for storage.
function subscriptionToRow(subscription) {
  const json = subscription.toJSON();
  return {
    endpoint: json.endpoint,
    p256dh: json.keys?.p256dh,
    auth: json.keys?.auth,
  };
}

async function getRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg || null;
}

export async function getActivePushSubscription() {
  const reg = await getRegistration();
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

// Ask the browser for a subscription. It asks its push service in turn, so it
// fails without a network — with a DOMException, whose numeric `code` is not a
// code of this file.
async function subscribe(reg) {
  try {
    return await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  } catch (error) {
    let code = 'generic';
    if (error?.name === 'NotAllowedError') code = 'permission_denied';
    else if (isOffline()) code = 'offline';
    throw pushError(error?.message || 'The browser gave no push subscription', code, error);
  }
}

// Idempotent: if there's already a subscription, reuses it.
async function ensurePushSubscription() {
  const reg = await getRegistration();
  if (!reg) throw pushError('Service worker not ready', 'sw_not_ready');
  return (await reg.pushManager.getSubscription()) ?? subscribe(reg);
}

// Register this device's subscription for the account that is signed in:
// `claim_push_subscription` answers `{ subscription_id, outcome }`, with
// `outcome` one of 'created', 'refreshed' (the caller's own row) or 'rehomed'
// (the row of the account that used this device before). The account is the
// one of the request's session — the function asks, nothing is sent.
async function claimSubscription(sub) {
  if (isOffline()) throw noNetwork();
  const row = subscriptionToRow(sub);
  let data = null;
  let error = null;
  try {
    ({ data, error } = await supabase.rpc('claim_push_subscription', {
      p_endpoint: row.endpoint,
      p_p256dh: row.p256dh,
      p_auth: row.auth,
      p_user_agent: typeof navigator !== 'undefined' ? navigator.userAgent || null : null,
    }));
  } catch (thrown) {
    error = thrown;
  }
  if (error) throw refusal(error);
  return data;
}

/**
 * Public entry: ensure permission + subscription, and register the device for
 * the account that is signed in. Returns what `claim_push_subscription`
 * answered (`{ subscription_id, outcome }`). Throws an error with a `.code` of
 * this file for everything that stops it — the toggle shows the sentence of
 * that code.
 *
 * The device moves with its keys: when another account holds this endpoint
 * (the previous user of a shared phone), the row becomes the caller's and that
 * account receives nothing on this device any more.
 */
export async function enablePush(userId) {
  if (!isPushSupported()) throw pushError('Push not supported on this device', 'unsupported');
  if (!userId) throw pushError('Not signed in', 'not_signed_in');

  if (Notification.permission === 'denied') {
    throw pushError('Notifications are blocked in your browser settings', 'permission_denied');
  }
  // Before the prompt: a permission is not asked for when nothing can be done
  // with it — the browser needs its push service, and the row the database.
  if (isOffline()) throw noNetwork();
  if (Notification.permission === 'default') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw pushError('Notification permission denied', 'permission_denied');
  }

  const sub = await ensurePushSubscription();
  try {
    return await claimSubscription(sub);
  } catch (error) {
    if (error.code !== 'keys_mismatch') throw error;
    // Another account holds this address under keys that are not this
    // browser's: a row somebody wrote without holding the subscription. It
    // cannot be taken over, and it must not keep this device from being
    // registered — the browser gives the address up (the push service then
    // answers 410 for it, and send-push drops that row) and takes a new one.
    return claimSubscription(await renewPushSubscription(sub));
  }
}

// A new address and new keys from the push service. Only on the user's own
// tap: see `enablePush`.
async function renewPushSubscription(sub) {
  const reg = await getRegistration();
  if (!reg) throw pushError('Service worker not ready', 'sw_not_ready');
  try {
    await sub.unsubscribe();
  } catch (error) {
    throw pushError(error?.message || 'The browser kept its push subscription', isOffline() ? 'offline' : 'generic', error);
  }
  return subscribe(reg);
}

/**
 * Self-heal DB↔device drift: tell the database which subscription this device
 * holds, for the account that is signed in on it. Two things drift.
 *
 * The ADDRESS: the push service can rotate a subscription's endpoint. The
 * service worker re-subscribes (`pushsubscriptionchange`, where the browser
 * has that event — iOS does not), but it has no session and writes nothing;
 * send-push then reaps the old (410) row, silently ending delivery even though
 * the browser holds a fresh, valid subscription. The page is what knows who is
 * signed in: it registers the CURRENT endpoint, whatever the worker did.
 *
 * The ACCOUNT: a subscription the previous user of this device left behind — a
 * session that went away, a sign-out that could not reach the browser's push
 * service, an app deployed before a sign-out released the device — moves to
 * the account that is signed in now. That account's notifications arrive
 * here, and the other one's stop.
 *
 * Both through `claim_push_subscription`, like `enablePush`. Permission-gated,
 * and it never subscribes, prompts or renews: it registers a subscription the
 * browser already holds, which only exists because `enablePush` created one on
 * this device. No-ops (returns false) when unsupported, permission isn't
 * granted, or there's no live sub. Throws, with a `.code`, when the database
 * could not be told — `usePushAutoHeal` writes that down.
 */
export async function reconcilePushSubscription(userId) {
  if (!isPushSupported() || !userId) return false;
  if (pushPermission() !== 'granted') return false;
  const sub = await getActivePushSubscription();
  if (!sub) return false;
  await claimSubscription(sub);
  return true;
}

/**
 * Reverse of enablePush: the row goes, and the browser gives its subscription
 * up. The row first, so we never end up with a dangling subscription if the
 * unsubscribe call fails (we can always reconcile from the device later).
 *
 * Either one is enough for this device to stop receiving — without a row
 * nothing is sent to it, without a subscription the push service refuses what
 * is sent (and send-push then drops the row). So it throws, with a `.code`,
 * only when NEITHER happened: the toggle must not say "off" for a device that
 * still receives.
 */
export async function disablePush(userId) {
  if (!userId) return;
  const sub = await getActivePushSubscription();
  if (!sub) {
    if (isOffline()) throw noNetwork();
    const { error } = await supabase.from('push_subscriptions').delete().eq('user_id', userId);
    if (error) throw refusal(error);
    return;
  }

  let failure = null;
  if (isOffline()) {
    failure = noNetwork();
  } else {
    const { error } = await supabase
      .from('push_subscriptions')
      .delete()
      .eq('user_id', userId)
      .eq('endpoint', sub.endpoint);
    if (error) failure = refusal(error);
  }
  let unsubscribed = false;
  try {
    await sub.unsubscribe();
    unsubscribed = true;
  } catch {
    // Best-effort.
  }
  if (failure && !unsubscribed) throw failure;
}

/**
 * True if (a) the browser has an active subscription, AND (b) the matching
 * row exists in push_subscriptions for this user. Both must be in sync.
 *
 * (a) is read from the browser. (b) is a request: when it gets no answer this
 * throws, with a `.code` — "could not ask" is not "off".
 */
export async function isPushEnabled(userId) {
  if (!isPushSupported() || !userId) return false;
  if (pushPermission() !== 'granted') return false;
  const sub = await getActivePushSubscription();
  if (!sub) return false;
  if (isOffline()) throw noNetwork();
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('id')
    .eq('user_id', userId)
    .eq('endpoint', sub.endpoint)
    .maybeSingle();
  if (error) throw refusal(error);
  return !!data;
}
