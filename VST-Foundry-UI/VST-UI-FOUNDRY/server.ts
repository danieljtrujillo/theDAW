import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";

import { PORT } from "./server/config";
import { appendLog } from "./server/logging";
import { loadAppCfg } from "./server/persistence";
import { startSDProcess, stopSDProcess } from "./server/sd";
import { killAllClaudeSessions } from "./server/claude-bridge";
import { registerRoutes } from "./server/routes";

// Re-exported so the SSRF regression tests (src/server.ssrf.test.ts) can import
// the guard helpers straight from the entry module (their original home).
export { isPrivateIp, assertPublicUrl } from "./server/net";

// Exported so tests (supertest) can drive the configured app without listening.
export const app = express();

// Parse large JSON bodies for state updates and screenshots
app.use(express.json({ limit: "50mb" }));

// Conservative security response headers. Deliberately does NOT set script-src
// (would break Vite dev + Monaco) or frame-ancestors (would break Foundry's
// theDAW sidecar embedding) — CustomCode already runs in sandboxed iframes, so
// these low-risk directives add hardening without breaking anything.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "object-src 'none'; base-uri 'self'");
  next();
});

// Register every HTTP route + CORS middleware in the original order. Must run
// BEFORE setupStaticAndVite so the API routes take precedence over the Vite /
// static catch-all.
registerRoutes(app, { shutdown });

// ===========================================================================
// Vite middleware / production static serving
// ===========================================================================

const setupStaticAndVite = async () => {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        // When embedded in theDAW (DISABLE_HMR=true) nobody live-edits this
        // source, so turn HMR off entirely. This stops Vite from opening the
        // HMR WebSocket whose unreachable retries otherwise flood the browser
        // console with ERR_CONNECTION_REFUSED. Standalone dev keeps HMR on but
        // on a per-instance port (PORT+1) so multiple Foundry instances never
        // collide on the fixed default (24678).
        hmr: process.env.DISABLE_HMR === "true" ? false : { port: PORT + 1 },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.use((req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }
};

// ===========================================================================
// Process error handlers + graceful shutdown
// ===========================================================================

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[WARN] Unhandled promise rejection:", reason);
  appendLog(`[WARN] Unhandled rejection: ${String(reason)}`);
});

let httpServer: ReturnType<typeof app.listen> | null = null;

function shutdown(signal: string) {
  console.log(`\n[Server] Received ${signal}, shutting down gracefully...`);
  killAllClaudeSessions();
  stopSDProcess();
  if (httpServer) {
    const server = httpServer;
    httpServer = null;
    server.close((err) => {
      if (err) console.error("[Server] Error during shutdown:", err);
      else console.log("[Server] HTTP server closed.");
      process.exit(err ? 1 : 0);
    });
    server.closeAllConnections?.();
    server.closeIdleConnections?.();
    // Force-exit after 10 s if connections linger
    setTimeout(() => {
      console.error("[Server] Graceful shutdown timed out, forcing exit.");
      process.exit(1);
    }, 10_000).unref();
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Skip startup when imported by tests (Vitest sets NODE_ENV=test); supertest
// drives the exported `app` directly, so no port bind / SD auto-start needed.
if (process.env.NODE_ENV !== "test")
  setupStaticAndVite()
  .then(() => {
    httpServer = app.listen(PORT, "127.0.0.1", () => {
      console.log(
        `[Fullstack Server] Running on http://localhost:${PORT} in ${process.env.NODE_ENV || "development"} mode.`,
      );
      // Auto-start SD instances where autoStart is enabled in config
      const autoStartCfg = loadAppCfg();
      let autoStarted = false;
      for (const t of ["a1111", "comfyui"] as const) {
        if (autoStartCfg.sd[t].autoStart && autoStartCfg.sd[t].execPath) {
          if (autoStarted) {
            console.log(`[autoStart] Warning: both a1111 and comfyui have autoStart=true; only one can run at a time. Skipping ${t}.`);
            appendLog(`[autoStart] Skipping ${t} — only one SD instance can run at a time`);
            continue;
          }
          const result = startSDProcess(t, autoStartCfg);
          console.log(`[autoStart] ${t}: ${result.message}`);
          appendLog(`[autoStart] ${t}: ${result.message}`);
          if (result.success) autoStarted = true;
        }
      }
    });

    // No overall request/response timeout — a chat turn can legitimately run for
    // many minutes (long agentic tool sequences). Node's defaults (requestTimeout
    // 300s; socket timeout) must never abort a live SSE turn. headersTimeout is
    // left at default (it only bounds header receipt). Localhost-only bind.
    httpServer.requestTimeout = 0;
    httpServer.timeout = 0;

    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[Server] Port ${PORT} is already in use. Stop the existing process and try again.`);
      } else {
        console.error("[Server] HTTP server error:", err);
      }
      process.exit(1);
    });
  })
  .catch((err) => {
    console.error("[Server] Failed to start:", err);
    process.exit(1);
  });
