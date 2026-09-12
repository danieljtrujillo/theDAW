// Resolution base for URLs that must reach the backend over real HTTP.
//
// In the browser and Docker the app is served over http(s), so relative URLs
// and window.location.origin work everywhere. In the packaged Electron app the
// renderer origin is the custom scheme app://. — its protocol handler proxies
// /api/* to the backend, but anything that needs a genuine http origin (the VJ
// iframe and its ?api= param, WebSockets, LAN/share/QR links shown to phones)
// breaks when composed from app://. These helpers give those call sites the
// backend's real http origin instead.
//
// The host is the LITERAL 127.0.0.1, never 'localhost', and must stay that
// way: backend/run.py binds 0.0.0.0 — IPv4 only — while Chromium prefers ::1
// for 'localhost' on Windows 11, so a 'localhost' URL reaches nothing at all
// with the backend running (issue #144). Same value as the packaged proxy's
// BACKEND_BASE in electron-ui/main/index.ts.

export const PACKAGED_BACKEND_HTTP_BASE = 'http://127.0.0.1:8600';

/** True when the page itself is served over http(s) (browser dev, Docker). */
export const isHttpOrigin = (): boolean =>
  window.location.protocol === 'http:' || window.location.protocol === 'https:';

/** An http(s) origin that reaches the backend from THIS machine. */
export const backendHttpBase = (): string =>
  isHttpOrigin() ? window.location.origin : PACKAGED_BACKEND_HTTP_BASE;

/** The http port this app is reachable on for LAN devices (phone QR links). */
export const lanReachablePort = (): string =>
  isHttpOrigin() ? window.location.port : '8600';
