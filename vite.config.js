import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { makeBuildId, buildMetaTag } from './src/lib/buildInfo.js';

// Every build writes its id into index.html, as <meta name="sl-build">. The
// page reads it back as BUILD_ID (src/lib/buildInfo.js, which also says what
// an id is). It is in the HTML and NOT in a bundle on purpose: a constant that
// changes with every build, inlined into the entry chunk, would rename every
// chunk that imports the entry, and a deploy that changed nothing would make
// every device download the whole app again.
function buildIdInIndexHtml() {
  const id = makeBuildId({ env: process.env });
  return {
    name: 'sl-build-id',
    transformIndexHtml: () => [buildMetaTag(id)],
  };
}

export default defineConfig({
  base: '/sl_app/',
  plugins: [
    react(),
    tailwindcss(),
    buildIdInIndexHtml(),
    VitePWA({
      // `injectManifest` so we can ship a custom service worker (src/sw.js)
      // that handles `push` + `notificationclick` for the rest-timer
      // notification. Workbox still precaches the app shell — see src/sw.js.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      // The page registers the worker itself (src/lib/appUpdate.js, started by
      // src/main.jsx) and decides when a new one takes over. 'prompt' is the
      // plugin's name for "a new worker waits to be told"; `injectRegister:
      // false` keeps the plugin from adding a registration of its own to
      // index.html now that nothing imports `virtual:pwa-register`.
      registerType: 'prompt',
      injectRegister: false,
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
        // An INSTALLED iOS web app colours its status-bar / Dynamic Island
        // strip from the manifest, not from index.html's `theme-color` metas —
        // the metas only govern in-browser tabs. A manifest is static, so this
        // single value cannot follow the in-app theme toggle: it is ink-900
        // because the app is dark-first. A coach running the light theme gets
        // a dark strip and splash, which is the deliberate trade of the two.
        theme_color: '#111110',
        background_color: '#111110',
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
    // supabase/tests/** is the DATABASE suite: it needs a real Postgres and
    // its own config (vitest.db.config.js, `npm run test:db`), not jsdom.
    // docs/** is the DOCS suite (vitest.docs.config.js, `npm run test:docs`):
    // run by the integrator and CI once the docs of a wave are folded, never
    // by a feature package, which must not fail on a doc it does not own.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', 'supabase/tests/**', 'docs/**'],
  },
});
