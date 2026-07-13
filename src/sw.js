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
precacheAndRoute(self.__WB_MANIFEST || []);

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
      // navigate. Hash route changes don't trigger navigation, so we post
      // a message and the page can react if it wants.
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

// Lifecycle: ship updates immediately so a fresh deploy never serves
// a stale SW + stale page bundle pair.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
