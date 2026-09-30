// Compile-time constants injected by Vite `define` (see frontend/buildInfo.config.ts).
// Absent outside a Vite build (e.g. tsx test runs) — read them only behind a
// `typeof __APP_BUILD_SHA__ !== 'undefined'` guard; lib/buildInfo.ts does.
declare const __APP_BUILD_SHA__: string;
declare const __APP_BUILD_TIME__: string;
