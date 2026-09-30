import express, { Express } from "express";
import path from "path";
import os from "os";
import fs from "fs";
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { applyCors, setCorsOrigin } from "./config";
import { appendLog, getRecentLogs, readLogTailLines, LOG_PATH, LOG_RING_SIZE } from "./logging";
import { loadAppCfg, saveAppCfg, mergeAppCfg } from "./persistence";
import { TEXTURES_DIR, SESSION_PATH } from "./paths";
import { activeSessions, RELAY_SERVER_TIMEOUT_MS } from "./relay";
import { scrapeUrl } from "./net";
import {
  PROVIDERS,
  streamOpenAICompat,
  streamAnthropic,
  fetchProviderModels,
  fallbackModels,
} from "./providers";
import {
  streamClaude,
  CLAUDE_DEFAULT_MODEL,
  fetchClaudeModels,
  claudeSessions,
  teardownClaudeSession,
  resolveLiveClaudeSession,
  claudeControlWaiters,
  setClaudeSessionPermissionMode,
  recordClaudePermissionAnswer,
  takeClaudePendingToolRequest,
  PROJECT_CWD,
} from "./claude-bridge";
import { normalizePermissionMode, selfModifyPath, PERMISSION_MODES } from "./permissions";
import {
  startSDProcess,
  stopSDProcess,
  getSdProcess,
  generateViaA1111,
  generateViaComfyUI,
  generateViaDallE,
  generateViaGemini,
  generateViaOpenRouter,
  saveImagesToFiles,
  GenParams,
} from "./sd";
import { registerExtractRoutes } from "./extract";
import { registerOpenRouterRoutes } from "./features/openrouter/catalog";

// ---------- /api/assistant/transcribe: local Whisper STT via faster-whisper ----------
// Raw audio body (audio/*) → temp file → spawn stt/transcribe.py → return its
// clean stdout transcript. The global express.json() parser only matches
// application/json, so an audio/* body passes through untouched to the raw
// parser below. PYTHON_CMD/THEDAW_PYTHON_CMD override the interpreter; on Windows
// the launcher `py -3.10` is preferred since faster-whisper is installed there.
const STT_DIR = path.join(os.tmpdir(), "vst-foundry-stt");
const STT_SCRIPT = path.join(process.cwd(), "stt", "transcribe.py");
const STT_PYTHON_CMD =
  process.env.THEDAW_PYTHON_CMD ||
  process.env.PYTHON_CMD ||
  (process.platform === "win32" ? "py" : "python3");
const STT_PYTHON_ARGS =
  process.env.THEDAW_PYTHON_CMD || process.env.PYTHON_CMD
    ? []
    : process.platform === "win32"
      ? ["-3.10"]
      : [];

// ---------------------------------------------------------------------------
// Real canvas screenshot — server-side OS capture.
//
// The browser's old captureCanvasScreenshot redrew elements onto an in-memory
// 2D canvas (canvasMockup.ts) and so could NEVER show CustomCode (sandboxed
// iframes) — which is most of a real design. The server runs on the same
// machine, so it can grab true composited pixels of the theDAW window via a
// DPI-aware PowerShell capture: exactly what the user sees, iframes included,
// with no browser permission prompt or user gesture. Windows-only by design
// (the app's target platform); non-win32 returns a clear error so the browser
// falls back to the (now live-data) mockup.
// ---------------------------------------------------------------------------
// PrintWindow + PW_RENDERFULLCONTENT (flag 2) renders the TARGET window's own
// content into the bitmap even when it is occluded or on another monitor —
// unlike CopyFromScreen, which grabs whatever pixels are visually on top. The
// flag is mandatory for Chromium/Electron/DirectComposition windows (theDAW),
// which render blank under plain PrintWindow.
const WIN_CAPTURE_PS = `
Add-Type @"
using System;using System.Runtime.InteropServices;
public class VstCap{
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
 public struct RECT{public int Left,Top,Right,Bottom;}
}
"@ -ReferencedAssemblies System.Drawing
[VstCap]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Drawing
$p = Get-Process | Where-Object { $_.MainWindowTitle -match 'theDAW' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Error 'theDAW window not found'; exit 1 }
$h = $p.MainWindowHandle
$r = New-Object VstCap+RECT
[VstCap]::GetWindowRect($h,[ref]$r) | Out-Null
$w=$r.Right-$r.Left; $ht=$r.Bottom-$r.Top
if ($w -lt 1) { $w=1 }
if ($ht -lt 1) { $ht=1 }
$bmp = New-Object System.Drawing.Bitmap $w,$ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [VstCap]::PrintWindow($h,$hdc,2)
$g.ReleaseHdc($hdc); $g.Dispose()
$bmp.Save($env:VSTSHOT_OUT,[System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("{0}x{1}" -f $w,$ht)
`;

// Register every HTTP route + CORS middleware in the EXACT original order. The
// global body parser and security-header middleware are registered by the entry
// (server.ts) BEFORE this runs; the Vite/static middleware is registered AFTER.
export function registerRoutes(app: Express, deps: { shutdown: (signal: string) => void }): void {
  const { shutdown } = deps;

  // ===========================================================================
  // CORS for assistant routes (cors package not bundled; set headers manually)
  // ===========================================================================
  app.use("/api/assistant", (req, res, next) => {
    if (!applyCors(req, res)) {
      res.status(403).json({ error: "Cross-origin request blocked" });
      return;
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // ===========================================================================
  // Routes
  // ===========================================================================

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ app: "vst-foundry", status: "ok", time: new Date().toISOString() });
  });

  app.post("/api/shutdown", (_req, res) => {
    res.json({ ok: true });
    setTimeout(() => shutdown("API shutdown"), 50);
  });

  // Provider catalog
  app.get("/api/assistant/providers", (req, res) => {
    const list = Object.entries(PROVIDERS).map(([id, cfg]) => ({
      id,
      label: cfg.label,
      requiresKey: cfg.requiresKey,
      isLocal: cfg.isLocal,
      defaultModel: cfg.defaultModel,
    }));
    // Claude Code (CLI-based) is always available; surface it first.
    list.unshift({
      id: "claude",
      label: "BCC (Better Claude Code)",
      requiresKey: false,
      isLocal: true,
      defaultModel: CLAUDE_DEFAULT_MODEL,
    });
    res.json(list);
  });

  // Model discovery
  app.get("/api/assistant/models/:provider", async (req, res) => {
    const provider = req.params.provider;
    const apiKey = typeof req.query.apiKey === "string" ? (req.query.apiKey as string) : undefined;

    if (provider === "claude") {
      res.json(await fetchClaudeModels());
      return;
    }

    const cfg = PROVIDERS[provider];
    if (!cfg) {
      res.json([]);
      return;
    }

    try {
      const models = await fetchProviderModels(provider, cfg, apiKey);
      res.json(models.length ? models : fallbackModels(provider, cfg));
    } catch {
      res.json(fallbackModels(provider, cfg));
    }
  });

  // Chat stream — SSE dispatcher
  app.post("/api/assistant/chat", async (req, res) => {
    const {
      messages = [],
      provider = "gemini",
      model,
      apiKey,
      conversationId,
      claudeSessionId,
      effort,
      claudeMode,
      permissionMode: rawPermissionMode,
      appState,
      screenshot,
    } = req.body || {};
    void claudeMode; // accepted from the orb but not used by the Claude CLI path
    // The orb's PermissionModeSelect dropdown (src/components/orb/useChatStream.ts)
    // sends its chosen mode with every turn. G5 audit item 5: an unknown or
    // MISSING value must NOT be forced to DEFAULT_PERMISSION_MODE here — for
    // an EXISTING session that would override the mode the user already set
    // for it with the fallback default on every turn that happens not to
    // resend one. Pass `undefined` through instead: streamClaude's own
    // dispatch (claude-bridge.ts) falls back to the LIVE session's current
    // mode first, and only reaches for DEFAULT_PERMISSION_MODE when there is
    // no session yet to have a mode of its own.
    const permissionMode = normalizePermissionMode(rawPermissionMode) ?? undefined;

    // Claude Code CLI path — a PERSISTENT per-conversation child (see streamClaude
    // above). It owns its own SSE/HTTP lifecycle (status / headers / close), so we
    // branch out BEFORE the shared SSE setup the direct-API providers use below.
    if (provider === "claude") {
      appendLog(
        `[chat] provider=claude model=${model} effort=${effort} permissionMode=${permissionMode} ` +
          `conv=${conversationId || "(new)"} msgs=${Array.isArray(messages) ? messages.length : 0} ` +
          `screenshotInBody=${screenshot ? `yes(len=${screenshot.length})` : "NO"}`,
      );
      await streamClaude({
        req,
        res,
        messages,
        model,
        conversationId,
        claudeSessionId,
        effort,
        permissionMode,
        appState,
        screenshot,
      });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    setCorsOrigin(req, res);
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof (res as any).flushHeaders === "function") (res as any).flushHeaders();

    const sse = (data: object) => {
      if (res.writableEnded) return;
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
    };

    const ac = new AbortController();
    res.on("close", () => ac.abort());

    // Direct-API providers (OpenAI-compat + Anthropic) loop agentically over tool
    // calls. They need a relay channel so the browser can post tool results back
    // (the Claude CLI path registers its own session inside streamClaude). Register
    // one here, keyed by a fresh id, and announce it as a `session_id` frame so the
    // orb's relayToolResult targets the right session. /api/mcp-relay/result then
    // resolves the matching pending promise and the stream loop continues.
    let toolSessionId: string | undefined;
    if (provider !== "claude" && (provider === "anthropic" || PROVIDERS[provider])) {
      toolSessionId = randomUUID();
      activeSessions.set(toolSessionId, { sseRes: res, pending: new Map() });
      sse({ type: "session_id", sessionId: toolSessionId });
    }

    try {
      let stream: AsyncGenerator<import("./tools").Frame> | null = null;

      if (provider === "anthropic") {
        stream = streamAnthropic({ messages, model, apiKey, appState, screenshot, signal: ac.signal, toolSessionId });
      } else if (PROVIDERS[provider]) {
        stream = streamOpenAICompat({ messages, provider, model, apiKey, appState, screenshot, signal: ac.signal, toolSessionId });
      } else {
        sse({ type: "error", message: `Unknown provider: ${provider}` });
        sse({ type: "done" });
        res.end();
        return;
      }

      for await (const frame of stream) {
        if (ac.signal.aborted) break;
        sse(frame);
      }
    } catch (error: any) {
      console.error("Error in /api/assistant/chat:", error);
      appendLog(`[chat] route catch: ${error?.message || String(error)}`);
      sse({ type: "error", message: error?.message || "An unexpected error occurred during the session." });
    } finally {
      // Tear down the relay session: clear any outstanding tool timers and drop it
      // from the registry so a closed SSE channel can't be written to later.
      if (toolSessionId) {
        const sess = activeSessions.get(toolSessionId);
        if (sess) {
          for (const p of sess.pending.values()) clearTimeout(p.timer);
          activeSessions.delete(toolSessionId);
        }
      }
      if (!res.writableEnded) res.end();
    }
  });

  // Explicitly dispose a persistent Claude session (orb "new chat" / unmount).
  // Kills the child, unlinks its MCP config, and drops all relay registrations.
  // Idempotent: a missing/unknown conversationId is a no-op.
  app.post("/api/assistant/session/close", (req, res) => {
    const conversationId = (req.body?.conversationId || "").trim();
    if (conversationId && claudeSessions.has(conversationId)) {
      teardownClaudeSession(conversationId, true);
      appendLog(`[Claude] session/close conv=${conversationId}`);
    }
    res.json({ ok: true });
  });

  // Set a live session's permission policy mode (src/components/orb/
  // PermissionModeSelect.tsx). Body: {conversationId?, claudeSessionId?, mode}.
  // 400 on an unrecognized mode, 404 when there's no live session to apply it
  // to (mirrors control-response's 409-for-"no live session" in spirit, but a
  // mode change targets a session that must already exist — nothing to queue
  // it against — so 404 is the closer fit).
  app.post("/api/assistant/permission-mode", (req, res) => {
    const { conversationId, claudeSessionId, mode } = req.body || {};
    const normalized = normalizePermissionMode(mode);
    if (!normalized) {
      res.status(400).json({
        ok: false,
        error: `mode must be one of: ${PERMISSION_MODES.join(", ")}`,
      });
      return;
    }
    const session = resolveLiveClaudeSession(
      typeof conversationId === "string" ? conversationId : undefined,
      typeof claudeSessionId === "string" ? claudeSessionId : undefined,
    );
    if (!session) {
      res.status(404).json({ ok: false, error: "No live Claude session for this conversation" });
      return;
    }
    setClaudeSessionPermissionMode(session, normalized);
    res.json({ ok: true, mode: normalized });
  });

  // Answer a live CLI control_request (AskUserQuestion / can_use_tool permission).
  // The CLI is BLOCKED on stdin until this arrives, so the answer must reach the
  // SAME persistent child that raised the request. Mirrors BCC's writeToSession:
  //   { type:"control_response", response:{ subtype:"success", request_id, response:<UI answer> } }\n
  // where <UI answer> is the orb's choice object — e.g. for AskUserQuestion:
  //   { behavior:"allow", updatedInput:{ questions, answers } }
  // or for a permission prompt: { behavior:"allow"|"deny", updatedInput?, message? }.
  app.post("/api/assistant/control-response", (req, res) => {
    const { conversationId, sessionId, requestId, response } = req.body || {};
    if (!requestId || typeof requestId !== "string") {
      res.status(400).json({ ok: false, error: "requestId (string) required" });
      return;
    }
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      res.status(400).json({ ok: false, error: "response (object) required" });
      return;
    }
    const session = resolveLiveClaudeSession(
      typeof conversationId === "string" ? conversationId : undefined,
      typeof sessionId === "string" ? sessionId : undefined,
    );
    if (!session || !session.proc.stdin || session.proc.stdin.destroyed) {
      res.status(409).json({ ok: false, error: "No live Claude session for this conversation" });
      return;
    }
    // G5 round 4 item 3 (MAJOR): require a LIVE pending entry for this
    // requestId — matches Python's assistant_routes.py, which 404s when
    // ``session.pending_controls.get(request_id)`` is None. A prior version
    // proceeded regardless (relying only on a client-controlled response
    // SHAPE to guess whether this was an AskUserQuestion answer), so a
    // replayed POST for an already-consumed requestId — `pending == null` —
    // fell back to that shape heuristic: send `updatedInput:{questions:[],
    // answers:[]}` plus `updatedPermissions` and it slipped through
    // unstripped. claude-bridge.ts's forwarding loop now tracks EVERY
    // bubbled control_request (both can_use_tool and AskUserQuestion, not
    // just the former — see its comment), so `pending` is non-null for any
    // requestId that is still awaiting an answer, of either kind.
    const pending = takeClaudePendingToolRequest(session, requestId);
    if (pending == null) {
      res.status(404).json({ ok: false, error: "unknown or already-answered requestId" });
      return;
    }
    const behavior = (response as Record<string, unknown>).behavior;
    // G5 round 5 item 4 (MINOR): validate the VALUE of `behavior`, not just
    // which keys are present. `behavior`/`message`/`updatedInput` is a KEY
    // allowlist (below) — it lets an arbitrary `behavior` STRING through
    // unchecked. That string is forwarded verbatim to the live CLI's stdin
    // (a `control_response` the CLI itself must validate, so this alone
    // isn't a CLI-side bypass) but is also interpolated unescaped into the
    // `appendLog` call below (`behavior=${behavior}`), letting a malicious
    // or buggy client forge arbitrary text into the server's own log
    // stream. Matches Python's identical guard at
    // `assistant_routes.py:1427` (`behavior not in ("allow", "deny")` ->
    // 400) — both prompt shapes (a permission bubble and an AskUserQuestion
    // submit) only ever legitimately send "allow" or "deny".
    if (behavior !== "allow" && behavior !== "deny") {
      // Re-insert the pending entry we already popped above (G5 round 5
      // item 5's fix applies here too) — an invalid-behavior request must
      // not permanently consume it, or a client that retries with a
      // corrected body 404s on an otherwise-still-live requestId.
      session.pendingToolRequests.set(requestId, pending);
      res.status(400).json({ ok: false, error: "response.behavior must be 'allow' or 'deny'" });
      return;
    }
    // AskUserQuestion's control_request carries tool_name "AskUserQuestion"
    // (see Transcript.tsx's own `control.toolName === "AskUserQuestion"`
    // check and claude-bridge.ts's tracking of it) — recognized here from
    // SERVER state now that every bubble is tracked, never from client input.
    const isAskUserQuestion = pending.toolName === "AskUserQuestion";
    const isSelfModify =
      !isAskUserQuestion &&
      selfModifyPath(pending.toolName, pending.toolInput as Record<string, unknown>, PROJECT_CWD) !== null;
    // G5 round 4 item 4 (MINOR): forward via an ALLOWLIST, not a
    // strip-one-key blacklist. `behavior`/`message`/`updatedInput` are the
    // entire vocabulary either answer shape ever legitimately uses — a
    // permission prompt: `{behavior, updatedInput?, message?}`; an
    // AskUserQuestion submit: `{behavior:"allow", updatedInput:{questions,
    // answers}}`. Anything else the client sends (`updatedPermissions`
    // included) is dropped unconditionally: the Foundry's OWN policy
    // (server/permissions.ts's sessionAllow, recorded below) is the single
    // source of truth for "allow this tool for the rest of the session" —
    // the CLI must never get a standing rule of its own (a second,
    // ungoverned enforcement path the server's mode changes, 3x-deny rule,
    // and self-modify's own never-remember rule could never reach again).
    // An allowlist also means a NEW permission-carrying field the CLI grows
    // later is excluded by default, not forwarded by default.
    const ALLOWED_CONTROL_RESPONSE_KEYS = new Set(["behavior", "message", "updatedInput"]);
    const forwardedResponse: Record<string, unknown> = Object.fromEntries(
      Object.entries(response as Record<string, unknown>).filter(([key]) => ALLOWED_CONTROL_RESPONSE_KEYS.has(key)),
    );
    let written = false;
    try {
      const payload = {
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response: forwardedResponse },
      };
      session.proc.stdin.write(JSON.stringify(payload) + "\n");
      written = true;
      appendLog(
        `[Claude] wrote control_response id=${requestId} conv=${session.conversationId} ` +
          `behavior=${behavior} droppedKeys=${Object.keys(response as object)
            .filter((k) => !ALLOWED_CONTROL_RESPONSE_KEYS.has(k))
            .join(",") || "none"}`,
      );
      // Feed the answer into the policy's session-allow / deny-count state so
      // "always allow" and the 3x-decline rule take effect on the NEXT
      // identical request. AskUserQuestion answers are not policy — never
      // recorded.
      if (!isAskUserQuestion && (behavior === "allow" || behavior === "deny")) {
        // "Always allow" sends `updatedPermissions`; "Allow once" / "Deny"
        // don't. Self-modify requests are NEVER remembered for the session,
        // no matter what the client sent — matches permissions.ts's own
        // self-modify rule (it always re-bubbles regardless of sessionAllow).
        const requestedRemember =
          behavior === "allow" &&
          Object.prototype.hasOwnProperty.call(response as object, "updatedPermissions");
        recordClaudePermissionAnswer(
          session,
          pending.toolName,
          pending.toolInput,
          behavior,
          requestedRemember && !isSelfModify,
        );
      }
      res.json({ ok: true });
    } catch (e: any) {
      // G5 round 5 item 5 (MINOR): the pending entry was already popped
      // above, before this write was attempted. If the write itself throws
      // (e.g. EPIPE on a closing-but-not-yet-torn-down stdin), the entry is
      // gone with nothing delivered — a client retry then 404s on
      // `takeClaudePendingToolRequest` above, and the CLI stays blocked on
      // that control_request's stdin answer forever, with no way for the
      // user to unblock it. Re-insert the entry so the SAME requestId can be
      // answered again -- but ONLY when the write never went out (written
      // is still false); once the CLI has the answer, a later throw (log
      // I/O, recordClaudePermissionAnswer, or res.json on a closed
      // socket) must not resurrect an already-delivered request (G5
      // batch-11 fixup, minor 3).
      if (!written) {
        session.pendingToolRequests.set(requestId, pending);
      }
      appendLog(`[Claude] control_response write failed id=${requestId}: ${e?.message || e}`);
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // G5 round 4 item 2 (MAJOR): the ONLY UI-initiated control request the orb
  // ever actually sends (src/components/orb/useChatStream.ts's
  // refreshContextUsage). This is an ALLOWLIST, not documentation of what the
  // CLI supports — accepting an arbitrary client-supplied subtype here let a
  // request body of {"subtype":"set_permission_mode","mode":"bypassPermissions"}
  // reach the live child's stdin verbatim (see below), which is the exact
  // failure class as the round-2 CRITICAL (CLI_PERMISSION_MODES bypass) but
  // through this sibling endpoint instead of /permission-mode: under
  // bypassPermissions the CLI stops emitting can_use_tool entirely, so
  // decide() (and its never-remember self-modify rule) never runs again for
  // the rest of that session. /permission-mode remains the ONLY legitimate
  // way to change a session's mode — it goes through setClaudeSessionPermissionMode,
  // which always sends the CLI "default" regardless of the app-level mode
  // (server/permissions.ts's CLI_PERMISSION_MODES). Add a subtype here ONLY
  // after confirming the orb actually sends it.
  const ALLOWED_UI_CONTROL_REQUEST_SUBTYPES = new Set(["get_context_usage"]);

  // UI-INITIATED control request to the CLI. Writes `{type:"control_request",
  // request_id, request}` to the persistent child's stdin (BCC's sendControl
  // → writeToSession) and awaits the matching control_response on stdout
  // (resolved by handleClaudeStdoutLine). Returns the CLI's response
  // envelope. Works BETWEEN turns (the child is persistent/idle).
  app.post("/api/assistant/control-request", async (req, res) => {
    const { conversationId, sessionId, request } = req.body || {};
    if (!request || typeof request !== "object" || typeof request.subtype !== "string") {
      res.status(400).json({ ok: false, error: "request.subtype (string) required" });
      return;
    }
    if (!ALLOWED_UI_CONTROL_REQUEST_SUBTYPES.has(request.subtype)) {
      res.status(400).json({
        ok: false,
        error: `unsupported control-request subtype ${JSON.stringify(request.subtype)}; allowed: ${Array.from(ALLOWED_UI_CONTROL_REQUEST_SUBTYPES).join(", ")}`,
      });
      return;
    }
    const session = resolveLiveClaudeSession(
      typeof conversationId === "string" ? conversationId : undefined,
      typeof sessionId === "string" ? sessionId : undefined,
    );
    if (!session || !session.proc.stdin || session.proc.stdin.destroyed) {
      res.status(409).json({ ok: false, error: "No live Claude session for this conversation" });
      return;
    }
    const requestId = "ui_" + randomUUID().replace(/-/g, "").slice(0, 24);
    const result = await new Promise<any>((resolve) => {
      const timer = setTimeout(() => {
        claudeControlWaiters.delete(requestId);
        resolve(null);
      }, 12000);
      claudeControlWaiters.set(requestId, { resolve, timer });
      try {
        session.proc.stdin!.write(JSON.stringify({ type: "control_request", request_id: requestId, request }) + "\n");
        appendLog(`[Claude] wrote control_request id=${requestId} subtype=${request.subtype} conv=${session.conversationId}`);
      } catch (e: any) {
        clearTimeout(timer);
        claudeControlWaiters.delete(requestId);
        resolve(null);
      }
    });
    if (result == null) {
      res.status(504).json({ ok: false, error: `control request '${request.subtype}' timed out` });
      return;
    }
    res.json({ ok: true, response: result });
  });

  app.post("/api/assistant/transcribe", express.raw({ type: "audio/*", limit: "25mb" }), (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.json({ ok: false, error: "no audio data received" });
      return;
    }
    const ct = String(req.headers["content-type"] ?? "audio/webm");
    const ext = ct.includes("wav")
      ? "wav"
      : ct.includes("ogg")
        ? "ogg"
        : ct.includes("mpeg") || ct.includes("mp3")
          ? "mp3"
          : ct.includes("mp4") || ct.includes("m4a")
            ? "m4a"
            : "webm";

    let file: string;
    try {
      fs.mkdirSync(STT_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      file = path.join(STT_DIR, `rec-${stamp}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
      fs.writeFileSync(file, req.body);
    } catch (error) {
      res.json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const cleanup = () => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* best effort */
      }
    };

    // The client may abort while faster-whisper is still running; a bare res.json()
    // on a destroyed socket would throw an uncaught error and crash the process.
    let clientGone = false;
    res.on("close", () => { clientGone = true; });
    const sendJson = (payload: any) => {
      if (clientGone || res.writableEnded) return;
      try { res.json(payload); } catch {}
    };

    execFile(
      STT_PYTHON_CMD,
      [...STT_PYTHON_ARGS, STT_SCRIPT, file],
      { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        cleanup();
        if (err) {
          const detail = (stderr || "").trim().split(/\r?\n/).slice(-3).join(" ") || err.message;
          appendLog(`[STT] transcription failed: ${detail}`);
          sendJson({ ok: false, error: `transcription failed: ${detail}` });
          return;
        }
        sendJson({ ok: true, text: stdout.trim() });
      },
    );
  });

  // ===========================================================================
  // CORS for all /api/* routes (data/SD/texture endpoints)
  // ===========================================================================
  app.use("/api", (req, res, next) => {
    if (!applyCors(req, res)) {
      res.status(403).json({ error: "Cross-origin request blocked" });
      return;
    }
    if (req.method === "OPTIONS") { res.sendStatus(204); return; }
    next();
  });

  // ===========================================================================
  // MCP relay endpoints — bridge Claude Code MCP tool calls to the browser
  // ===========================================================================
  //
  // Flow: Claude CLI invokes an MCP tool → mcp-server.cjs POSTs /api/mcp-relay/call
  // → server-side tools run here directly; browser-side tools are pushed to the
  // active SSE channel as a `client_tool_call` frame and the request blocks until
  // the browser POSTs /api/mcp-relay/result (or RELAY_TIMEOUT_MS elapses).

  app.post("/api/mcp-relay/call", async (req, res) => {
    const { sessionId, toolCallId, toolName, args } = req.body || {};
    const session = activeSessions.get(sessionId);
    if (!session) {
      res.json({ error: "No active session" });
      return;
    }

    // Server-side tools — handled here without a browser round-trip.
    if (toolName === "fetchWebPage") {
      try {
        const content = await scrapeUrl(args?.url || "");
        res.json({ result: content });
      } catch (e: any) {
        res.json({ error: e?.message || String(e) });
      }
      return;
    }

    // Browser-side tools — relay over SSE and await the result. Every response on
    // this socket is guarded: by the time the waiter fires, the client may already
    // have destroyed the socket (it times out at RELAY_TIMEOUT_MS, just above our
    // RELAY_SERVER_TIMEOUT_MS), so res.json() on a destroyed socket would throw an
    // uncaught ERR_STREAM_DESTROYED from a bare timer/callback.
    const sendRelayJson = (payload: any) => {
      if (!res.writableEnded) {
        try { res.json(payload); } catch {}
      }
    };
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        session.pending.delete(toolCallId);
        sendRelayJson({ error: `Tool call timed out after ${Math.round(RELAY_SERVER_TIMEOUT_MS / 1000)}s` });
        done();
      }, RELAY_SERVER_TIMEOUT_MS);

      session.pending.set(toolCallId, {
        resolve: (result: any) => {
          clearTimeout(timer);
          session.pending.delete(toolCallId);
          sendRelayJson(result);
          done();
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          session.pending.delete(toolCallId);
          sendRelayJson({ error: err.message });
          done();
        },
        timer,
      });

      // Emit client_tool_call to the browser over the live SSE channel.
      const sseData = JSON.stringify({ type: "client_tool_call", id: toolCallId, name: toolName, args: args || {} });
      try {
        session.sseRes.write(`data: ${sseData}\n\n`);
      } catch (e: any) {
        clearTimeout(timer);
        session.pending.delete(toolCallId);
        sendRelayJson({ error: `Failed to relay tool call: ${e?.message || e}` });
        done();
      }
    });
  });

  app.post("/api/mcp-relay/result", (req, res) => {
    const { sessionId, toolCallId, result, error, imageData } = req.body || {};
    const session = activeSessions.get(sessionId);
    if (!session) {
      res.json({ ok: false });
      return;
    }
    const pending = session.pending.get(toolCallId);
    if (!pending) {
      res.json({ ok: false });
      return;
    }
    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve(imageData ? { imageData } : { result });
    }
    res.json({ ok: true });
  });

  app.post("/api/screen-capture", async (_req, res) => {
    if (process.platform !== "win32") {
      res.status(501).json({ error: "Server screen capture is Windows-only" });
      return;
    }
    const outPath = path.join(os.tmpdir(), `vst-shot-${randomUUID()}.png`);
    try {
      const dims: string = await new Promise((resolve, reject) => {
        execFile(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WIN_CAPTURE_PS],
          { env: { ...process.env, VSTSHOT_OUT: outPath }, timeout: 30000, windowsHide: true, maxBuffer: 1 << 20 },
          (err, stdout) => (err ? reject(err) : resolve(String(stdout || "").trim()))
        );
      });
      const buf = fs.readFileSync(outPath);
      res.json({ dataUrl: `data:image/png;base64,${buf.toString("base64")}`, dims, bytes: buf.length });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    } finally {
      fs.unlink(outPath, () => {});
    }
  });

  // Serve texture files
  app.use("/textures", express.static(TEXTURES_DIR));

  // Config
  app.get("/api/config", (_req, res) => {
    res.json(loadAppCfg());
  });
  app.post("/api/config", (req, res) => {
    try {
      const merged = mergeAppCfg(req.body);
      saveAppCfg(merged);
      appendLog(`[Config] Settings saved (preferred=${merged.sd.preferred} a1111Port=${merged.sd.a1111.port} comfyPort=${merged.sd.comfyui.port})`);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // State persistence
  app.get("/api/state", (_req, res) => {
    if (!fs.existsSync(SESSION_PATH)) { res.json(null); return; }
    try { res.json(JSON.parse(fs.readFileSync(SESSION_PATH, "utf-8"))); return; }
    catch (e: any) {
      appendLog(`[State] primary session file corrupt (${e?.message || e}) — attempting .bak recovery`);
    }
    const bak = SESSION_PATH + ".bak";
    if (fs.existsSync(bak)) {
      try { res.json(JSON.parse(fs.readFileSync(bak, "utf-8"))); return; }
      catch (e: any) { appendLog(`[State] backup session file also corrupt (${e?.message || e})`); }
    }
    res.json(null);
  });
  app.post("/api/state", (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({ error: "Invalid or empty state payload" });
      return;
    }
    try {
      if (fs.existsSync(SESSION_PATH)) {
        try { fs.copyFileSync(SESSION_PATH, SESSION_PATH + ".bak"); } catch {}
      }
      const tmp = SESSION_PATH + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(body), "utf-8");
      fs.renameSync(tmp, SESSION_PATH);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Texture upload (base64 payload)
  app.post("/api/textures/upload", (req, res) => {
    try {
      const { dataUrl, name } = req.body || {};
      if (!dataUrl) { res.status(400).json({ error: "dataUrl required" }); return; }
      const matches = dataUrl.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
      if (!matches) { res.status(400).json({ error: "Invalid dataUrl" }); return; }
      const rawExt = matches[1].toLowerCase();
      if (!["png", "jpg", "jpeg", "gif", "webp"].includes(rawExt)) {
        res.status(400).json({ error: "Unsupported image type" }); return;
      }
      const ext = rawExt === "jpeg" ? "jpg" : rawExt;
      const id = randomUUID();
      const filename = `${id}.${ext}`;
      fs.writeFileSync(path.join(TEXTURES_DIR, filename), Buffer.from(matches[2], "base64"));
      res.json({ id, name: name || filename, url: `/textures/${filename}` });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Texture delete
  app.delete("/api/textures/:id", (req, res) => {
    const { id } = req.params;
    if (!id || id.includes("..") || id.includes("/") || id.includes("\\") || !/^[a-f0-9-]{36}$/i.test(id)) {
      res.status(400).json({ error: "Invalid id" }); return;
    }
    const files = fs.existsSync(TEXTURES_DIR) ? fs.readdirSync(TEXTURES_DIR) : [];
    const match = files.find((f) => f === id || f.startsWith(id + "."));
    if (match) {
      try { fs.unlinkSync(path.join(TEXTURES_DIR, match)); } catch {}
    }
    res.json({ success: true });
  });

  // List textures on disk
  app.get("/api/textures/list", (_req, res) => {
    if (!fs.existsSync(TEXTURES_DIR)) { res.json([]); return; }
    const files = fs.readdirSync(TEXTURES_DIR).filter((f) => /\.(png|jpg|jpeg|gif|webp)$/i.test(f));
    res.json(files.map((f) => ({ id: f.replace(/\.[^.]+$/, ""), name: f, url: `/textures/${f}` })));
  });

  // UI-element extraction (component extractor) — registered after the /api
  // CORS middleware above so it inherits the origin lock. See server/extract.ts.
  registerExtractRoutes(app);

  // Logs — recent in-memory ring buffer, optionally backfilled from disk
  app.get("/api/logs", (req, res) => {
    const requested = Math.min(parseInt(String(req.query.lines ?? "200"), 10) || 200, 1000);
    // Ring path: the in-memory ring holds at most LOG_RING_SIZE lines — clamp to it.
    const ring = getRecentLogs(Math.min(requested, LOG_RING_SIZE));
    if (ring.length < requested && fs.existsSync(LOG_PATH)) {
      try {
        const fromDisk = readLogTailLines(requested);
        const ringSet = new Set(ring);
        const merged = [...fromDisk.filter((l) => !ringSet.has(l)), ...ring];
        res.json({ lines: merged.slice(-requested) });
        return;
      } catch {}
    }
    res.json({ lines: ring });
  });

  // SD status
  app.get("/api/sd/status", (_req, res) => {
    const sd = getSdProcess();
    res.json({
      running: !!sd,
      type: sd?.type || null,
      port: sd?.port || null,
      startedAt: sd?.startedAt || null,
    });
  });

  // SD start
  app.post("/api/sd/start", (req, res) => {
    const cfg = loadAppCfg();
    const sdType = req.body?.sdType || cfg.sd.preferred;
    if (sdType !== "a1111" && sdType !== "comfyui") {
      res.status(400).json({ error: "Invalid sdType" }); return;
    }
    res.json(startSDProcess(sdType as "a1111" | "comfyui", cfg));
  });

  // SD stop
  app.post("/api/sd/stop", (_req, res) => {
    res.json(stopSDProcess());
  });

  // SD resources (models, VAEs, LoRAs, samplers)
  app.get("/api/sd/resources", async (req, res) => {
    const cfg = loadAppCfg();
    const sdType = (req.query.type as string) || cfg.sd.preferred;
    if (sdType !== "a1111" && sdType !== "comfyui") {
      res.status(400).json({ error: "Invalid type" }); return;
    }
    const port = sdType === "a1111" ? (cfg.sd.a1111.port || 7860) : (cfg.sd.comfyui.port || 8188);
    const modelDir = cfg.sd.modelLibraryDir;

    if (sdType === "a1111") {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 10_000);
      const [modR, vaeR, loraR, sampR] = await Promise.allSettled([
        fetch(`http://localhost:${port}/sdapi/v1/sd-models`, { signal: ac.signal }),
        fetch(`http://localhost:${port}/sdapi/v1/sd-vae`, { signal: ac.signal }),
        fetch(`http://localhost:${port}/sdapi/v1/loras`, { signal: ac.signal }),
        fetch(`http://localhost:${port}/sdapi/v1/samplers`, { signal: ac.signal }),
      ]);
      clearTimeout(t);
      const ok = (r: PromiseSettledResult<Response>) => r.status === "fulfilled" && r.value.ok;
      const models = ok(modR) ? (await (modR as any).value.json()).map((m: any) => ({ id: m.title, label: m.model_name || m.title })) : [];
      const vaes = ok(vaeR) ? (await (vaeR as any).value.json()).map((v: any) => ({ id: v.model_name, label: v.model_name })) : [];
      const loras = ok(loraR) ? (await (loraR as any).value.json()).map((l: any) => ({ id: l.name, label: l.name })) : [];
      const samplers = ok(sampR) ? (await (sampR as any).value.json()).map((s: any) => ({ id: s.name, label: s.name })) : [];
      res.json({ models, vaes, loras, samplers });
    } else {
      let models: any[] = [];
      if (modelDir && fs.existsSync(modelDir)) {
        models = fs.readdirSync(modelDir)
          .filter((f) => /\.(safetensors|ckpt|pt)$/i.test(f))
          .map((f) => ({ id: f, label: f.replace(/\.(safetensors|ckpt|pt)$/i, "") }));
      }
      res.json({ models, vaes: [], loras: [], samplers: [] });
    }
  });

  registerOpenRouterRoutes(app);

  // Generate textures
  app.post("/api/textures/generate", async (req, res) => {
    const params: GenParams = req.body || {};
    if (!params.prompt) { res.status(400).json({ error: "prompt required" }); return; }

    const cfg = loadAppCfg();
    let images: string[] = [];

    try {
      switch (params.provider) {
        case "a1111": images = await generateViaA1111(params, cfg); break;
        case "comfyui": images = await generateViaComfyUI(params, cfg); break;
        case "openai": case "dalle": images = await generateViaDallE(params); break;
        case "gemini": images = await generateViaGemini(params); break;
        case "openrouter": images = await generateViaOpenRouter(params); break;
        default:
          res.status(400).json({ error: `Unsupported image generation provider: ${params.provider}` });
          return;
      }

      if (!images.length) {
        res.status(500).json({ error: "No images returned from provider" });
        return;
      }

      const results = await saveImagesToFiles(images, params);
      res.json({ results });
    } catch (e: any) {
      appendLog(`[ERROR] generate via ${params.provider}: ${e.message}`);
      res.status(500).json({ error: e.message || String(e) });
    }
  });
}
