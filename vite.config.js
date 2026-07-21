import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/sl_app/',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // `injectManifest` so we can ship a custom service worker (src/sw.js)
      // that handles `push` + `notificationclick` for the rest-timer
      // notification. Workbox still precaches the app shell — see src/sw.js.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      registerType: 'autoUpdate',
      includeAssets: [
        'favicon.svg',
        'apple-touch-icon.png',
        'icon-192.png',
        'icon-512.png',
        'icon-512-maskable.png',
      ],
      manifest: {
        name: 'Street Lifting Coach',
        short_name: 'SL Coach',
        start_url: '/sl_app/',
        scope: '/sl_app/',
        display: 'standalone',
        theme_color: '#f9fafb',
        background_color: '#f9fafb',
        icons: [
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        // Static assets only — no Supabase REST/Storage runtime caching.
        // The React Query persisted cache (IndexedDB) is the source of truth
        // for offline reads; runtime caching of authed API responses risks
        // serving cross-user data on shared devices. Runtime caching for
        // Google Fonts is wired up directly in src/sw.js.
        //
        // '**/*.js' deliberately precaches EVERY lazy route chunk, including
        // the tree for the role this device will never use. That is the price
        // of both roles working offline straight after install — a student who
        // installs at home and first opens the app in a basement gym has no
        // second chance to fetch a chunk. Narrowing this to per-role chunks
        // would trade a one-time download for an offline dead-end.
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
      },
      devOptions: {
        // Disabled in dev so HMR isn't fighting a service worker.
        enabled: false,
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'router': ['react-router-dom'],
          'query': ['@tanstack/react-query'],
          'supabase': ['@supabase/supabase-js'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.js',
    // Harness-created git worktrees under .claude/ contain a full copy of
    // the repo; without this exclude vitest runs every suite twice and the
    // copies fail on a second React instance.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
  },
});
