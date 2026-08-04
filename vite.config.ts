import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Glassy is a static, backend-free PWA: everything precaches into the app
// shell so it boots offline, and there is nothing resembling a network API
// to add runtime caching for.
export default defineConfig({
  base: '/',
  build: {
    target: 'es2022',
  },
  server: {
    host: true,
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      // `null`, not 'auto': main.ts registers via `virtual:pwa-register` so a
      // registration failure can be caught explicitly instead of surfacing as
      // an unhandled rejection. 'auto' would double-register.
      injectRegister: null,
      // No dev-mode service worker: it only ever gets in the way of the
      // dev server's own HMR/live reload, and `npm run dev` must stay fast.
      devOptions: {
        enabled: false,
      },
      manifest: {
        name: 'Glassy',
        short_name: 'Glassy',
        description:
          'A tiny endless-runner rendered above your car window. Passenger use only — do not use while driving.',
        display: 'standalone',
        orientation: 'landscape',
        background_color: '#05060a',
        theme_color: '#05060a',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // App shell only — js/css/html plus the icon set and the manifest
        // itself. No wildcards onto anything network-shaped: there is no
        // backend, so runtimeCaching would just be dead config.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
    }),
  ],
});
