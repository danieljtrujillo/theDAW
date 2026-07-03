import { Response as ExpressResponse } from "express";

// ===========================================================================
// Active session registry — MCP relay bridge
// ===========================================================================
//
// When the Claude Code CLI runs with the vst-foundry MCP server attached, that
// server calls back into THIS process to invoke browser-side tools. Every live
// SSE chat connection that may relay tools is registered here, keyed by the
// session id we also hand to the MCP server. The relay endpoints use it to
//   (a) push a `client_tool_call` frame to the correct browser, and
//   (b) resolve the matching pending promise when the browser returns a result.
export interface PendingToolCall {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
export interface ActiveSession {
  sseRes: ExpressResponse;
  pending: Map<string, PendingToolCall>;
}
export const activeSessions = new Map<string, ActiveSession>();

// Shared MCP/browser tool-relay timeout. A single source of truth so the Claude
// MCP relay (/api/mcp-relay/call), the direct-API agentic loop
// (awaitBrowserToolResult), and the stdio relay child (mcp-server.cjs) all wait
// the SAME amount of time for a browser tool result. Raised from the old 30s on
// the Claude relay so a slow canvas op (large reads / screenshots) does not time
// out mid-turn. Keep mcp-server.cjs:RELAY_TIMEOUT_MS aligned to this value.
export const RELAY_TIMEOUT_MS = 120_000;

// Server-side waiter timeout for /api/mcp-relay/call. Kept STRICTLY below the
// client socket timeout (mcp-server.cjs RELAY_TIMEOUT_MS = 120000) so the server
// resolves+responds first on a true non-response. If they were equal, the client
// could destroy the socket the same instant the server fires its timer, and the
// bare setTimeout would then call res.json() on a destroyed socket -> uncaught
// ERR_STREAM_DESTROYED. The waiter responses are also guarded against a
// writableEnded socket (see the route below).
export const RELAY_SERVER_TIMEOUT_MS = 115_000;
