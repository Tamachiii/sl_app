/// <reference lib="webworker" />

// Custom service worker for sl_app. Replaces the generated workbox SW
// (see vite.config.js: strategies: 'injectManifest', srcDir: 'src'). The
// generated SW only knew how to precache the app shell; this one adds:
//
//   • `push`             — render the rest-timer "Rest done" notification
//                          delivered by the dispatch-rest-push Edge Function.
//   • `notificationclick` — focus the existing student session tab if open,
//                          otherwise open the deep link from the payload.
//
// Precaching, navigateFallback, and Google-Fonts runtime caching are kept
// identical to the previous generateSW config so offline behavior is
// unchanged.

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { CacheFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

cleanupOutdatedCaches();

// vite-plugin-pwa injects the precache manifest here at build time.
//
// manifest.webmanifest is deliberately excluded. iOS reads it when the app is
// added to the home screen, and an installed app takes its status-bar colour
// from `theme_color` — but a precached copy meant Safari asked THIS worker for
// the manifest and got the stale one back, so a theme_color change never
// reached iOS even after removing and re-adding the app. It has to come off
// the network. Nothing offline depends on it: the manifest matters at install
// time, and iOS keeps its own copy afterwards.
precacheAndRoute(
  (self.__WB_MANIFEST || []).filter((entry) => {
    const url = typeof entry === 'string' ? entry : entry?.url ?? '';
    return !url.endsWith('manifest.webmanifest');
  }),
);

// SPA navigateFallback — every page route resolves to the precached
// index.html so deep links survive offline cold loads.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/sl_app/index.html')));

// Google Fonts — same runtime caching the previous workbox config had.
registerRoute(
  ({ url }) => url.origin === 'https://fonts.googleapis.com',
  new StaleWhileRevalidate({ cacheName: 'google-fonts-stylesheets' }),
);
registerRoute(
  ({ url }) => url.origin === 'https://fonts.gstatic.com',
  new CacheFirst({
    cacheName: 'google-fonts-webfonts',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 }),
    ],
  }),
);

// ============================================================
// Push notifications (Web Push protocol). Payloads are JSON of the
// shape produced by the dispatch-rest-push Edge Function:
//
//   { title, body, tag?, data?: { url? } }
//
// `tag` is used so a second push for the same logical event (e.g. a
// stale notification still showing when a new rest starts) replaces the
// first one instead of stacking.
// ============================================================

// VAPID public key, injected at build time (see deploy.yml passing
// VITE_VAPID_PUBLIC_KEY into the build). Needed so the SW can re-subscribe
// itself when the push service rotates the endpoint (pushsubscriptionchange).
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || '';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { title: 'SL Coach', body: event.data.text() };
    }
  }
  const title = data.title || 'SL Coach';
  const options = {
    body: data.body || '',
    icon: '/sl_app/icon-192.png',
    badge: '/sl_app/icon-192.png',
    tag: data.tag || 'sl-coach',
    data: data.data || {},
    // Vibrate pattern as a backup for browsers that honor it from SW.
    vibrate: [200, 100, 200],
    renotify: true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // HashRouter URLs include /#/...; the deep link in the payload comes
  // from the Edge Function fully qualified (e.g. /sl_app/#/student/session/<id>).
  const target = (event.notification.data && event.notification.data.url) || '/sl_app/';
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // If the app is already open in some window, focus it and try to
      // navigate. A hash-only change doesn't count as a navigation, so an
      // already-open tab may stay on the page it was on — focus is the part
      // that's guaranteed.
      for (const client of allClients) {
        try {
          await client.focus();
          if ('navigate' in client && client.url !== target) {
            try {
              await client.navigate(target);
            } catch {
              // Cross-origin navigate may throw; the focus above is enough.
            }
          }
          return;
        } catch {
          // Try the next one.
        }
      }
      // No window was open — pop one.
      if (self.clients.openWindow) {
        await self.clients.openWindow(target);
      }
    })(),
  );
});

// Endpoint rotation self-heal: the push service can retire a subscription and
// fire this event asking us to re-subscribe. Re-subscribe with the same VAPID
// key so the device keeps a LIVE subscription; the app syncs the new endpoint
// into push_subscriptions on its next focus (usePushAutoHeal → reconcile).
// Best-effort — a failure just means the user re-toggles from settings.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const existingKey = event.oldSubscription?.options?.applicationServerKey;
        const applicationServerKey =
          existingKey || (VAPID_PUBLIC_KEY ? urlBase64ToUint8Array(VAPID_PUBLIC_KEY) : null);
        if (!applicationServerKey) return;
        await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
      } catch {
        // Best-effort; reconcile-on-focus or a manual re-toggle will recover.
      }
    })(),
  );
});

// Lifecycle: ship updates immediately so a fresh deploy never serves
// a stale SW + stale page bundle pair.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
