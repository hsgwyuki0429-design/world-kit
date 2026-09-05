/// <reference types="vite/client" />

/** Injected by vite from package.json so the evidence bundle records a real build id. */
declare const __APP_VERSION__: string;

/**
 * Injected by vite: the commit the bundle was built from.
 *
 * Read through `typeof` so Node — where vite's `define` never runs — sees `undefined` and the
 * evidence records `unknown` rather than throwing.
 */
declare const __BUILD_COMMIT__: string;
