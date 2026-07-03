import express, { Response as ExpressResponse } from "express";

// Shared server port + CORS origin allow-list. Extracted verbatim from server.ts
// so the app-assembly entry, the Claude bridge, and the route handlers can all
// share the same PORT and CORS helpers without a circular import.
export const PORT = Number(process.env.THEDAW_FOUNDRY_PORT || process.env.PORT || 5472);

// ===========================================================================
// CORS origin allow-list — block drive-by cross-site requests (security)
// ===========================================================================
// The browser UI is served same-origin from this port. The Claude MCP relay
// (mcp-server.cjs) and other server-to-server callers send NO Origin header, so
// we allow no-Origin requests (never a cross-site browser attack) plus this
// app's own origin, and reject any other browser Origin. This closes the
// "any website you visit can drive localhost" hole WITHOUT touching the Claude
// provider — its relay reaches us only via no-Origin calls.
export const ALLOWED_ORIGINS = new Set<string>([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);
for (const o of (process.env.FOUNDRY_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)) {
  ALLOWED_ORIGINS.add(o);
}
export function isAllowedOrigin(origin?: string): boolean {
  // No Origin header = non-browser / same-origin navigation; not a CSRF vector.
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin);
}
// Echo the caller's own Origin (never "*") when allowed. Used by SSE handlers.
export function setCorsOrigin(req: express.Request, res: ExpressResponse): void {
  const origin = req.headers.origin as string | undefined;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
}
// Full CORS header set for a middleware/route. Returns false if the browser
// Origin is disallowed (caller should respond 403).
export function applyCors(req: express.Request, res: ExpressResponse): boolean {
  if (!isAllowedOrigin(req.headers.origin as string | undefined)) return false;
  setCorsOrigin(req, res);
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  return true;
}
