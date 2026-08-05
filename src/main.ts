/**
 * Bootstrap. Deliberately tiny: find the UI root, build the app, start it.
 * Every recoverable failure below degrades instead of crashing.
 */

// MUST be imported before anything touches Pixi. By default Pixi generates
// shader-sync code with `new Function()`, which our Content-Security-Policy
// forbids (script-src has no 'unsafe-eval' — see nginx-security-headers.conf).
// This module swaps in runtime polyfills instead, so the CSP stays strict
// rather than being weakened to accommodate the renderer.
import 'pixi.js/unsafe-eval';
import { registerSW } from 'virtual:pwa-register';
import { createApp } from './app/App.ts';
import { DOM_IDS } from './types.ts';

/**
 * Registered explicitly rather than via the plugin's auto-injected snippet, so
 * that a failure — offline first load, a blocked SW scope, a locked-down
 * browser profile — is caught here instead of escaping as an unhandled
 * rejection. Offline support is a nicety; the game must run without it.
 */
function registerServiceWorker(): void {
  try {
    registerSW({
      immediate: true,
      onRegisterError(err: unknown) {
        console.warn('[glassy] service worker registration failed; running without offline support', err);
      },
    });
  } catch (err) {
    console.warn('[glassy] service worker unavailable', err);
  }
}

async function boot(): Promise<void> {
  const root = document.getElementById(DOM_IDS.ui);
  if (!root) {
    console.error('[glassy] missing #%s — cannot boot', DOM_IDS.ui);
    return;
  }

  try {
    const app = await createApp(root);
    await app.start();
  } catch (err) {
    // Nothing recoverable is left, but the user must not face a blank screen.
    console.error('[glassy] fatal boot failure', err);
    root.textContent = 'Glassy could not start on this device.';
  }
}

registerServiceWorker();
void boot();
