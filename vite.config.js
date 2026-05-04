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
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Street Lifting Coach',
        short_name: 'SL Coach',
        start_url: '/sl_app/',
        scope: '/sl_app/',
        display: 'standalone',
        theme_color: '#f9fafb',
        background_color: '#f9fafb',
        icons: [
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        // Static assets only — no Supabase REST/Storage runtime caching.
        // The React Query persisted cache (IndexedDB) is the source of truth
        // for offline reads; runtime caching of authed API responses risks
        // serving cross-user data on shared devices.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-stylesheets' },
          },
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.gstatic.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
        navigateFallback: '/sl_app/index.html',
        cleanupOutdatedCaches: true,
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
  },
});
