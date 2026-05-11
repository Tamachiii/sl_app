// Web Push helpers — owns the PushManager.subscribe handshake, syncs the
// subscription into the `push_subscriptions` table, and exposes high-level
// `enablePush` / `disablePush` for the StudentProfile toggle.
//
// Everything here is iOS-PWA-aware: PushManager is only available on
// iOS 16.4+ for an installed (home-screen) PWA. `isPushSupported` reflects
// that — the Profile toggle is hidden on environments that won't grant a
// subscription.

import { supabase } from './supabase';

export const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || '';

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

// Idempotent: if there's already a subscription, reuses it.
async function ensurePushSubscription() {
  const reg = await getRegistration();
  if (!reg) throw new Error('Service worker not ready');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }
  return sub;
}

// Public entry: ensure permission + subscription + a row in
// push_subscriptions for the current user. Returns the persisted row.
export async function enablePush(userId) {
  if (!isPushSupported()) throw new Error('Push not supported on this device');
  if (!userId) throw new Error('Not signed in');

  if (Notification.permission === 'default') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notification permission denied');
  } else if (Notification.permission === 'denied') {
    throw new Error('Notifications are blocked in your browser settings');
  }

  const sub = await ensurePushSubscription();
  const row = subscriptionToRow(sub);

  // Endpoint is UNIQUE — UPSERT so re-enabling on the same device just
  // refreshes last_seen_at without trying to INSERT a duplicate.
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : null;
  const { data, error } = await supabase
    .from('push_subscriptions')
    .upsert(
      {
        user_id: userId,
        endpoint: row.endpoint,
        p256dh: row.p256dh,
        auth: row.auth,
        user_agent: userAgent,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'endpoint' },
    )
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Reverse of enablePush. Removes the row first so we never end up with a
// dangling subscription if the unsubscribe call fails (we can always
// reconcile from the device later).
export async function disablePush(userId) {
  if (!userId) return;
  const sub = await getActivePushSubscription();
  if (sub) {
    const { endpoint } = sub;
    await supabase.from('push_subscriptions').delete().eq('user_id', userId).eq('endpoint', endpoint);
    try {
      await sub.unsubscribe();
    } catch {
      // Best-effort.
    }
  } else {
    await supabase.from('push_subscriptions').delete().eq('user_id', userId);
  }
}

// True if (a) the browser has an active subscription, AND (b) the
// matching row exists in push_subscriptions. Both must be in sync.
export async function isPushEnabled(userId) {
  if (!isPushSupported() || !userId) return false;
  if (pushPermission() !== 'granted') return false;
  const sub = await getActivePushSubscription();
  if (!sub) return false;
  const { data } = await supabase
    .from('push_subscriptions')
    .select('id')
    .eq('user_id', userId)
    .eq('endpoint', sub.endpoint)
    .maybeSingle();
  return !!data;
}
