/// <reference lib="webworker" />

// Custom service worker for sl_app. Replaces the generated workbox SW
// (see vite.config.js: strategies: 'injectManifest', srcDir: 'src'). The
// generated SW only knew how to precache the app shell; this one adds:
//
//   • `push`             — show the notification of a push: "Rest done" from
//                          the dispatch-rest-push Edge Function, and the
//                          events send-push fans out (feedback, chat, …).
//   • `notificationclick` — bring the app to the front on the page the payload
//                          names, without moving a window that is there already.
//   • `pushsubscriptionchange` — subscribe again when the push service retires
//                          the subscription.
//   • `install` / `activate` / `message` — a new worker waits until a page
//                          tells it to take over.
//
// What the worker does on `push`, `notificationclick`, `install`, `activate`
// and `message` is in src/lib/swHandlers.js, where it is tested; this file
// only wires those handlers to the events.
//
// Precaching, navigateFallback, and Google-Fonts runtime caching are kept
// identical to the previous generateSW config so offline behavior is
// unchanged.

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { CacheFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import {
  handleInstall,
  handleActivate,
  handleMessage,
  handlePush,
  handleNotificationClick,
} from './lib/swHandlers';

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

// A push that arrives and a notification that is tapped: src/lib/swHandlers.js
// ("Notifications"). The rule the first of these two lines must keep: EVERY
// PUSH SHOWS A NOTIFICATION. Do not put a condition in front of `handlePush`,
// and do not make it return early for an app that is open — a push that shows
// nothing costs the device its subscription.
self.addEventListener('push', (event) => handlePush(self, event));
self.addEventListener('notificationclick', (event) => handleNotificationClick(self, event));

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

// Lifecycle: a new worker installs next to the one serving the app and WAITS.
// It takes over when a page sends `{ type: 'SKIP_WAITING' }`, which the page
// does once no write is pending, no rest timer runs and nothing is being typed
// (src/lib/appUpdate.js + components/ui/UpdatePrompt). Do not put a bare
// `self.skipWaiting()` back in `install`: the pages reload when the worker
// changes, and that reload would land in the middle of a set.
// The handlers — and the one case in which a worker still takes over by
// itself — are in src/lib/swHandlers.js, where they are tested.
self.addEventListener('install', (event) => handleInstall(self, event));
self.addEventListener('activate', (event) => handleActivate(self, event));
self.addEventListener('message', (event) => handleMessage(self, event));
