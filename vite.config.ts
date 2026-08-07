import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Glassy is a static, backend-free PWA: the app shell precaches so it boots
// offline. The one exception is `/vision/**` (MediaPipe wasm + detector
// model, ~18-19MB combined) — those are opt-in-only and use Workbox
// *runtime* caching instead of precaching; see the `runtimeCaching` entry
// below for the full reasoning.
//
// Bump this when the shipped detector model or wasm runtime changes *without*
// their filenames changing (today's model path,
// `/vision/efficientdet_lite0_float16.tflite`, is unhashed — see
// scripts/fetch-vision-assets.mjs). CacheFirst matches on URL only, so a
// same-URL swap would otherwise be served stale forever; bumping this string
// gives Workbox a new cache to populate and abandons the old one (which
// `maxAgeSeconds`/`purgeOnQuotaError` below eventually reclaim). The
// permanent fix is a hashed/versioned filename, which is out of this file's
// remit (scripts/fetch-vision-assets.mjs and src/vision/ObjectDetector.ts).
const VISION_CACHE_NAME = 'glassy-vision-assets-v1';

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
        // itself.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        // The MediaPipe wasm runtime and detector model are ~18-19MB and are
        // only ever fetched by users who opt into detection. Precaching them
        // would force that download on EVERY install, including people who
        // never turn it on.
        globIgnores: ['**/vision/**'],
        // Safety net, not the primary guard (that's globIgnores above): none
        // of the app-shell's .wasm/.tflite vision binaries match the
        // extension list in globPatterns, but the two small MediaPipe glue
        // .js files under vision/wasm/ would if globIgnores were ever
        // loosened or removed. Set comfortably above the current largest
        // chunk (~410KB, dominated by pixi.js) but far below the vision
        // binaries (7-12MB each), so a future mistake here makes
        // workbox-build silently drop the oversized file from the precache
        // manifest (a build-time warning) instead of quietly ballooning the
        // install to ~19MB.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        // Runtime caching, not precaching, for /vision/*: cache on first
        // fetch (i.e. the first time a user opts into detection) and serve
        // from Cache Storage thereafter, so the 18-19MB download is paid for
        // once by people who opted in and then survives — including the
        // HTTP cache eviction iOS is known to do aggressively for PWAs that
        // haven't been opened in a while. CacheFirst: once a `/vision/*`
        // response is cached, never re-check the network for it.
        //
        // The model is fetched by ObjectDetector.ts via a plain (non-Range)
        // `fetch()` + `response.body.getReader()` for streaming progress, and
        // the wasm glue is loaded via classic-worker `importScripts()` — no
        // Range requests are ever issued against `/vision/*`, so no
        // RangeRequestsPlugin is needed here. A cached Response served by
        // CacheFirst still carries its original `Content-Length` header and a
        // fully readable body stream (the Cache API stores the whole
        // response verbatim), so `fetchModelWithProgress`'s progress
        // reporting keeps working unchanged on a cache hit — it just
        // resolves fast instead of trickling in over the network. If a
        // future response somehow lacks Content-Length, that function
        // already degrades to indeterminate progress rather than fabricating
        // a percentage; nothing here changes that.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/vision/'),
            handler: 'CacheFirst',
            options: {
              cacheName: VISION_CACHE_NAME,
              cacheableResponse: {
                statuses: [0, 200],
              },
              expiration: {
                // A handful of files ever live under /vision/ (two wasm
                // variants x {.js,.wasm}, the detector model, the pre-bundled
                // worker script) — headroom above that, not an invitation to
                // grow unbounded.
                maxEntries: 10,
                // Long-lived by design (see CacheFirst reasoning above), but
                // not literally forever: this is the safety net if
                // VISION_CACHE_NAME is ever swapped without deleting the
                // model, or nobody remembers to bump it. 180 days
                // comfortably outlives any realistic gap between app opens.
                maxAgeSeconds: 60 * 60 * 24 * 180,
                purgeOnQuotaError: true,
              },
            },
          },
        ],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
    }),
  ],
});
