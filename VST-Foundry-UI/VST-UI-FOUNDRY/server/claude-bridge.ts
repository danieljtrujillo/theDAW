import express, { Response as ExpressResponse } from "express";
import path from "path";
import os from "os";
import fs from "fs";
import { spawn, ChildProcess, execSync } from "child_process";
import { randomUUID } from "crypto";
import { PORT, setCorsOrigin } from "./config";
import { appendLog } from "./logging";
import { killProc } from "./proc";
import { activeSessions, ActiveSession } from "./relay";
import {
  Frame,
  ChatMessage,
  buildSystemInstruction,
  extractText,
  normalizeRole,
  screenshotBase64,
} from "./tools";

// Claude session ids THIS sidecar process has created (captured from the CLI's
// system/init session_id). The orb persists its claudeSessionId in the browser,
// so after a sidecar restart it sends an id the CLI no longer knows — passing
// that to --resume fails the entire turn with "No conversation found with
// session ID". We only --resume ids in this set; an unknown id falls back to a
// fresh full-history turn (which works) instead of erroring.
const knownClaudeSessions = new Set<string>();

// ===========================================================================
// Claude Code constants
// ===========================================================================

export const CLAUDE_DEFAULT_MODEL = "claude-opus-4-8";
const CLAUDE_DEFAULT_EFFORT = "max";
const CLAUDE_VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// REMOVED: --max-turns. The installed claude CLI (v2.1.195) has NO --max-turns
// flag (verified via `claude --help`); passing it was silently ignored. The
// modern CLI runs an agentic turn to completion on its own — the required
// behavior (the agent takes as many turns/actions as a complex task needs).
// Kept commented for provenance; do NOT reintroduce a turn cap.
// const CLAUDE_MAX_TURNS = 25;

// Full model ids passed EXACTLY to `--model` (incl. the `[1m]` 1M-context
// variants the CLI binary accepts). CLI aliases ("opus"/"sonnet") are NOT
// reliable on this machine ("sonnet" fell back to a stale default and 404'd),
// so we enumerate full ids. Newest-first WITHIN each family so
// resolveClaudeModel's family fallback maps a stale/alias value to the latest
// non-1m full id. Fable 5 (claude-fable-5) is CURRENT (July 2026) — the old
// Fable was discontinued; Fable 5 supersedes it. Sonnet 5 is the newest Sonnet
// (claude-sonnet-5). Never write ids from memory (training is stale; see the
// repo HARD RULE on model catalogs).
const CLAUDE_MODELS = [
  // Current
  { id: "claude-fable-5",    label: "Claude Fable 5" },
  { id: "claude-sonnet-5",   label: "Claude Sonnet 5" },
  { id: "claude-opus-4-8",   label: "Claude Opus 4.8" },
  { id: "claude-opus-4-7",   label: "Claude Opus 4.7" },
  { id: "claude-opus-4-6",   label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5",  label: "Claude Haiku 4.5" },
  // 1M context (CLI accepts the [1m] suffix)
  { id: "claude-sonnet-5[1m]",   label: "Claude Sonnet 5 (1M context)" },
  { id: "claude-opus-4-8[1m]",   label: "Claude Opus 4.8 (1M context)" },
  { id: "claude-opus-4-7[1m]",   label: "Claude Opus 4.7 (1M context)" },
  { id: "claude-opus-4-6[1m]",   label: "Claude Opus 4.6 (1M context)" },
  { id: "claude-sonnet-4-6[1m]", label: "Claude Sonnet 4.6 (1M context)" },
];

export function fetchClaudeModels() { return Promise.resolve(CLAUDE_MODELS); }

// ===========================================================================
// Helpers — Claude CLI discovery / process management
// ===========================================================================

function findClaudeCmd(): string {
  const envOverride = (process.env.CLAUDE_CMD || "").trim();
  if (envOverride && fs.existsSync(envOverride)) return envOverride;
  if (envOverride) return envOverride;
  if (process.platform === "win32") {
    const npmPath = path.join(process.env.APPDATA || "", "npm", "claude.cmd");
    if (fs.existsSync(npmPath)) return npmPath;
    return "claude.cmd";
  }
  return "claude";
}

const CLAUDE_CMD = findClaudeCmd();
const PROJECT_CWD = process.cwd();

// Platform-conditional spawn of the `claude` CLI. On Windows the CLI is a .cmd
// shim, so it must run via `cmd.exe /c`; elsewhere it is invoked directly.
function spawnClaudeCli(args: string[], opts?: { cwd?: string }): ChildProcess {
  const spawnOpts: any = {
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  };
  return process.platform === "win32"
    ? spawn("cmd.exe", ["/c", CLAUDE_CMD, ...args], spawnOpts)
    : spawn(CLAUDE_CMD, args, spawnOpts);
}

// Normalize the requested model to a full id the CLI accepts (pass full ids
// like "claude-sonnet-4-6" to --model).
// CLI aliases ("opus"/"sonnet") are unreliable here — "sonnet" fell
// back to a stale default and 404'd. So: pass through ids in our shipped list,
// map any family alias ("sonnet") or stale pinned id ("claude-opus-4-1-...") to
// the newest full id in that family, and fall back to the default otherwise.
// Last line before --model, so the CLI never receives a dead model id.
function resolveClaudeModel(model?: string): string {
  const m = (model || "").trim();
  if (!m || m.startsWith("claude-code-")) return CLAUDE_DEFAULT_MODEL;
  const ids = CLAUDE_MODELS.map((x) => x.id);
  if (ids.includes(m)) return m;
  const fam = /(?:^|claude-)(opus|sonnet|haiku)/i.exec(m)?.[1]?.toLowerCase();
  if (fam) {
    const match = ids.find((id) => id.startsWith(`claude-${fam}`));
    if (match) return match;
  }
  return CLAUDE_DEFAULT_MODEL;
}

function resolveClaudeEffort(effort?: string): string {
  const e = (effort || CLAUDE_DEFAULT_EFFORT).trim().toLowerCase();
  return CLAUDE_VALID_EFFORTS.includes(e) ? e : CLAUDE_DEFAULT_EFFORT;
}

function isUuidLike(id?: string): boolean {
  return !!id && /^[a-fA-F0-9-]{8,64}$/.test(id);
}

// ===========================================================================
// Streamer 3 — Claude Code CLI (PERSISTENT per-conversation session, stream-json I/O)
// ===========================================================================

// Normalize a tool_result's polymorphic `content` (string | [{text}] | other)
// into a display string. Ported verbatim from BCC (resolveToolResultText).
function resolveToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => c?.text ?? "").join("\n");
  return JSON.stringify(content ?? "");
}

function* parseClaudeEvent(data: any): Generator<Frame> {
  const t = data?.type;

  // Partial-message stream events nest the real event under `event`.
  if (t === "stream_event" && data.event && typeof data.event === "object") {
    yield* parseClaudeEvent(data.event);
    return;
  }

  if (t === "system" && data.subtype === "init") {
    if (data.session_id) yield { type: "session_id", sessionId: data.session_id };
    // Surface the CLI's ACTUAL model (may differ from the requested alias) so
    // the orb can show what's really running (BCC reads this from init too).
    if (data.model) yield { type: "model", model: String(data.model) };
    return;
  }

  if (t === "assistant") {
    // Text + thinking stream via content_block_delta (below). Here we surface
    // ONLY tool_use blocks — DISPLAY-ONLY frames the orb renders as tool bubbles
    // (BCC parity). These are DISTINCT from the MCP relay's `client_tool_call`
    // (tc_ id) frames, which remain the authoritative EXECUTION channel for
    // canvas tools. The orb never EXECUTES a `tool_use` frame (it only renders
    // it), so this cannot re-introduce the old duplicate-execution / "Unknown
    // tool" flashes that motivated dropping these before. Claude's internal
    // tools (Read/Bash/Edit/Task/…) now show up too, exactly like in BCC.
    // `parent_tool_use_id` marks events from a SUB-AGENT (a Task/Agent spawn).
    // BCC routes these into a separate nested transcript so they never pollute
    // the main turn. We tag the frame with `parentToolId` so the orb can nest
    // the sub-agent's tools under its Task card instead of the main list.
    const parentToolId = typeof data.parent_tool_use_id === "string" ? data.parent_tool_use_id : "";
    const content = data.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "tool_use") {
          yield {
            type: "tool_use",
            toolId: block.id || "",
            name: block.name || "tool",
            inputJson: JSON.stringify(block.input ?? {}),
            parentToolId,
          };
        } else if (block?.type === "redacted_thinking") {
          // Redacted reasoning has no thinking_delta to stream — surface a
          // placeholder so the user knows the model reasoned here (BCC parity).
          yield { type: "thinking", text: "\n[reasoning redacted]\n" };
        }
      }
    }
    return;
  }

  if (t === "user") {
    // Tool RESULTS come back as a `user` message whose content carries
    // tool_result blocks. Surface them DISPLAY-ONLY so the orb can pair each
    // result with its tool_use bubble (BCC parity). `content` is polymorphic.
    // `parent_tool_use_id` (sub-agent) is tagged so the result nests correctly.
    const parentToolId = typeof data.parent_tool_use_id === "string" ? data.parent_tool_use_id : "";
    const content = data.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "tool_result") {
          yield {
            type: "tool_result",
            toolId: block.tool_use_id || "",
            content: resolveToolResultText(block.content),
            isError: !!block.is_error,
            parentToolId,
          };
        }
      }
    }
    return;
  }

  if (t === "control_request") {
    // The CLI is asking the USER something: AskUserQuestion (multiple choice) or
    // a `can_use_tool` permission prompt. Forward it verbatim so the orb can
    // render a question card and POST the answer back as a control_response
    // (see POST /api/assistant/control-response). The CLI is BLOCKED on stdin
    // until we reply — the turn stays busy meanwhile, so this must reach the
    // live SSE mid-turn.
    yield {
      type: "control_request",
      requestId: String(data.request_id ?? ""),
      request: data.request ?? {},
    };
    return;
  }

  if (t === "control_cancel_request") {
    // The CLI retracted a pending prompt (already answered / superseded).
    yield { type: "control_cancel", requestId: String(data.request_id ?? "") };
    return;
  }

  if (t === "content_block_delta") {
    const d = data.delta || {};
    if (d.type === "text_delta" && d.text) {
      yield { type: "text_delta", text: d.text };
    } else if (d.type === "thinking_delta" && d.thinking) {
      yield { type: "thinking", text: d.thinking };
    }
    return;
  }

  if (t === "result") {
    // Surface the full per-turn accounting BCC shows: token usage (incl. cache),
    // cumulative session cost (total_cost_usd — the orb deltas it per turn),
    // wall-clock duration, and whether the turn ERRORED (is_error). Previously
    // only bare in/out tokens survived and the orb dropped even those.
    const u = data.usage || {};
    yield {
      type: "done",
      usage: {
        input_tokens: u.input_tokens || 0,
        output_tokens: u.output_tokens || 0,
        cache_read_input_tokens: u.cache_read_input_tokens || 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
      },
      totalCostUsd: typeof data.total_cost_usd === "number" ? data.total_cost_usd : undefined,
      durationMs: typeof data.duration_ms === "number" ? data.duration_ms : undefined,
      isError: !!data.is_error,
      numTurns: typeof data.num_turns === "number" ? data.num_turns : undefined,
    };
    return;
  }
}

function buildClaudePrompt(messages: ChatMessage[], appState: any, resume: boolean): string {
  const sys = buildSystemInstruction(appState);
  let bodyText: string;
  if (resume) {
    const lastUser = [...messages].reverse().find((m) => normalizeRole(m.role) === "user");
    bodyText = lastUser ? extractText(lastUser.content) : "";
  } else {
    bodyText = messages
      .map((m) => `${normalizeRole(m.role)}: ${extractText(m.content)}`)
      .join("\n\n");
  }
  return `${sys}\n\n---\n\n${bodyText}`;
}

// =============================================================================
// Streamer 3 — Claude Code CLI: PERSISTENT per-conversation session.
// -----------------------------------------------------------------------------
// ONE long-lived `claude` child PER conversationId, spawned once with
//   -p --input-format stream-json --output-format stream-json --verbose
//   --include-partial-messages
// and then kept alive across turns. Each user turn is a single NDJSON line
// written to the SAME stdin (NO stdin.end() between turns); turn completion is
// the real `{"type":"result"}` event (mapped to a `done` frame by
// parseClaudeEvent), with a child-`close` fallback. The vst-foundry MCP child
// (mcp-server.cjs) therefore lives for the whole conversation instead of being
// re-spawned and killed every message — which is what made MCP "disconnect"
// every turn on the old per-message path.
//
// The old per-message streamClaude is preserved verbatim in
//   deprecated/streamClaude-per-message-20260628.ts.txt
// and the full prior server.ts in  server.ts.bak-persist-20260628 .
// =============================================================================

const MAX_CLAUDE_SESSIONS = 8; // live persistent children cap (LRU-reaped above this)
const CLAUDE_SESSION_IDLE_MS = 15 * 60 * 1000; // reap a session idle longer than this
const CLAUDE_REAP_INTERVAL_MS = 60 * 1000; // idle-reaper tick
const CLAUDE_HEARTBEAT_MS = 15 * 1000; // SSE keepalive comment cadence during a turn
// Inactivity (NOT total-duration) watchdog for a busy turn. Re-armed on EVERY
// stdout frame, so a productive long task (which streams frames continuously)
// NEVER trips it — only a genuine upstream stall with no output for this long
// does, letting the wedged turn self-heal so its session can be reaped.
const CLAUDE_TURN_STALL_MS = 300_000; // 5 min of stdout silence while busy

// One persistent Claude CLI child per conversation. `relayEntry` is the SAME
// object stored in `activeSessions` under `relayId` (and aliased under Claude's
// session_id) so the MCP relay endpoints resolve in-turn tool calls; its
// `sseRes` is re-pointed at the current turn's response on every turn.
interface ClaudeSession {
  proc: ChildProcess;
  relayId: string;
  conversationId: string;
  claudeSessionId: string | null;
  mcpConfigPath: string;
  mcpConfigWritten: boolean;
  model: string;
  effort: string;
  activeSse: ExpressResponse | null;
  stdoutBuf: string;
  stderr: string;
  busy: boolean;
  lastActivity: number;
  relayEntry: ActiveSession;
  aliasedSids: Set<string>;
  turnResolver: (() => void) | null;
  firstTurnPending: boolean;
  interruptSeq: number;
  heartbeat: ReturnType<typeof setInterval> | null;
  // Turn generation token (FIX 2). `turnGen` is bumped at the START of every turn;
  // `resultGen` is bumped each time a `result`-derived `done` frame is consumed.
  // A `result` legitimately ends the turn only when resultGen === turnGen while
  // busy; a stale `result` from an interrupted/superseded turn satisfies
  // resultGen < turnGen and is DRAINED as a no-op so it cannot end the NEXT turn.
  turnGen: number;
  resultGen: number;
  // Inactivity watchdog (FIX 3): re-armed on every stdout frame while busy. Fires
  // only on a true upstream stall (no stdout for CLAUDE_TURN_STALL_MS), never on a
  // productive long task (those emit frames regularly).
  stallTimer: ReturnType<typeof setTimeout> | null;
  // FIFO turn queue (BCC parity). A turn that arrives while this session is busy is
  // NOT rejected with 409 (BCC never does that — sending mid-turn just queues the
  // message). Instead the route parks here and is released, in arrival order, the
  // moment the in-flight turn finishes. Each entry is a one-shot resolver for a
  // route awaiting its slot.
  idleWaiters: Array<() => void>;
}

// Release every route parked behind a busy turn (BCC parity: one turn at a time,
// queued not rejected). Called wherever a turn ends and `busy` drops to false.
// Resolvers fire in arrival order; the first to re-check `busy` claims the slot
// (synchronously, before any await), so the rest re-park behind the new turn.
function releaseClaudeIdleWaiters(session: ClaudeSession): void {
  if (!session.idleWaiters.length) return;
  const waiters = session.idleWaiters;
  session.idleWaiters = [];
  for (const wake of waiters) {
    try { wake(); } catch {}
  }
}

export const claudeSessions = new Map<string, ClaudeSession>();
// Secondary index: Claude's own session_id -> our conversationId key. Lets a
// turn that arrives with only a claudeSessionId (e.g. conversationId lost) still
// resolve its live persistent session.
const claudeSidToConversation = new Map<string, string>();

function isClaudeProcAlive(proc: ChildProcess): boolean {
  return proc.exitCode === null && !proc.killed && !!proc.stdin && !proc.stdin.destroyed;
}

// Base CLI args (no resume / no mcp-config). EXACT set + order from the proven
// per-message path — do NOT reorder or drop -p/--verbose/--include-partial-messages.
function buildClaudeBaseArgs(useModel: string, useEffort: string): string[] {
  const cmdArgs = [
    "--model", useModel,
    "--dangerously-skip-permissions",
    "--permission-prompt-tool", "stdio",
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  if (CLAUDE_VALID_EFFORTS.includes(useEffort)) cmdArgs.push("--effort", useEffort);
  // No --max-turns: the CLI has no such flag (v2.1.195) and must run the agentic
  // turn to completion — the agent takes as many tool steps as the task needs.
  return cmdArgs;
}

function writeClaudeMcpConfig(relayId: string, mcpConfigPath: string): boolean {
  try {
    const mcpConfig = {
      mcpServers: {
        "vst-foundry": {
          command: "node",
          args: [path.join(process.cwd(), "mcp-server.cjs"), String(PORT), relayId],
          env: {},
        },
      },
    };
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));
    return true;
  } catch (e: any) {
    appendLog(`[MCP] Failed to write mcp-config for ${relayId}: ${e?.message || e}`);
    return false;
  }
}

function writeFrameToActiveSse(session: ClaudeSession, frame: Frame): void {
  const res = session.activeSse;
  if (!res || res.writableEnded) return;
  try {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  } catch (e: any) {
    appendLog(`[Claude] SSE write failed conv=${session.conversationId}: ${e?.message || e}`);
  }
}

// SSE keepalive: an EventSource-ignored comment line written periodically while a
// turn is in flight, so a long silent thinking/tool phase never looks idle. Has
// no overall timeout to fight (httpServer.timeout/requestTimeout are 0) — this is
// belt-and-suspenders for the core product path.
function stopClaudeHeartbeat(session: ClaudeSession): void {
  if (session.heartbeat) {
    clearInterval(session.heartbeat);
    session.heartbeat = null;
  }
}

function startClaudeHeartbeat(session: ClaudeSession): void {
  stopClaudeHeartbeat(session);
  session.heartbeat = setInterval(() => {
    const res = session.activeSse;
    if (!res || res.writableEnded) return;
    try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
  }, CLAUDE_HEARTBEAT_MS);
}

// Inactivity watchdog (FIX 3). Clears any prior timer. While a turn is busy this
// is re-armed on every stdout frame, so it only fires when the upstream model
// truly stalls (no stdout for CLAUDE_TURN_STALL_MS). On fire: interrupt the
// wedged turn and finish it (viaStall) so the SSE closes, the awaiting route
// returns, and the session drops to idle and becomes reapable. Does NOT cap a
// productive long task — those stream frames and keep re-arming the timer.
function clearClaudeStallWatchdog(session: ClaudeSession): void {
  if (session.stallTimer) {
    clearTimeout(session.stallTimer);
    session.stallTimer = null;
  }
}

function armClaudeStallWatchdog(session: ClaudeSession): void {
  clearClaudeStallWatchdog(session);
  session.stallTimer = setTimeout(() => {
    session.stallTimer = null;
    if (!session.busy) return;
    appendLog(
      `[Claude] turn STALL self-heal conv=${session.conversationId} ` +
        `(no stdout for ${Math.round(CLAUDE_TURN_STALL_MS / 1000)}s while busy) — interrupting + finishing`,
    );
    writeClaudeInterrupt(session);
    finishClaudeTurn(session, { viaClose: true, viaStall: true });
  }, CLAUDE_TURN_STALL_MS);
}

// End the in-flight turn: optionally emit a synthetic done (only when the child
// died without a `result`), detach the SSE, mark idle, end the response, and
// release the route awaiting turn completion. Does NOT kill the child.
function finishClaudeTurn(
  session: ClaudeSession,
  opts: { viaClose: boolean; exitCode?: number | null; viaStall?: boolean },
): void {
  if (!session.busy && !opts.viaClose) return;
  stopClaudeHeartbeat(session);
  clearClaudeStallWatchdog(session);
  if (opts.viaStall) {
    writeFrameToActiveSse(session, {
      type: "error",
      message: "The turn stalled (no output for several minutes) and was ended so the assistant can continue.",
    });
  }
  const res = session.activeSse;
  if (opts.viaClose && res && !res.writableEnded) {
    const code = opts.exitCode;
    if (code && code !== 0 && session.stderr.trim()) {
      writeFrameToActiveSse(session, {
        type: "error",
        message: `Claude CLI exited with code ${code}: ${session.stderr.slice(0, 500)}`,
      });
    }
    writeFrameToActiveSse(session, { type: "done" });
  }
  session.activeSse = null;
  session.busy = false;
  session.lastActivity = Date.now();
  // FIX 8: this turn ended WITHOUT consuming a matching `result` (close/stall).
  // Resync the result FIFO so the NEXT turn's `result` matches (mirrors
  // respawnClaudeSession); otherwise resultGen lags turnGen forever and every
  // subsequent result is drained as stale -> cascading 5-min hangs. The
  // result-driven end (viaClose:false) already had resultGen === turnGen.
  if (opts.viaClose) session.resultGen = session.turnGen;
  const resolver = session.turnResolver;
  session.turnResolver = null;
  if (res && !res.writableEnded) {
    try { res.end(); } catch {}
  }
  if (resolver) resolver();
  // BCC parity: the slot just freed — wake the next queued turn (if any).
  releaseClaudeIdleWaiters(session);
}

// Interrupt the running turn over stdin (control_request) — the BCC clear/stop
// mechanism. We do NOT kill the child; it stays warm for the next turn.
function writeClaudeInterrupt(session: ClaudeSession): void {
  try {
    const requestId = `int_${++session.interruptSeq}`;
    const payload = { type: "control_request", request_id: requestId, request: { subtype: "interrupt" } };
    session.proc.stdin?.write(JSON.stringify(payload) + "\n");
    appendLog(`[Claude] sent interrupt ${requestId} conv=${session.conversationId}`);
  } catch (e: any) {
    appendLog(`[Claude] failed to write interrupt conv=${session.conversationId}: ${e?.message || e}`);
  }
}

// Route ONE parsed stdout line's frames to the live SSE. Captures Claude's
// session_id (for --resume + tool-result aliasing) and treats the `done` frame
// (derived from the real `result` event) as authoritative turn-end.
// Pending UI-INITIATED control requests (get_context_usage / set_permission_mode)
// awaiting the CLI's control_response, keyed by the request_id we minted. Mirrors
// BCC's controlResolvers map; resolved from the stdout handler below.
export const claudeControlWaiters = new Map<string, { resolve: (v: any) => void; timer: NodeJS.Timeout }>();

function handleClaudeStdoutLine(session: ClaudeSession, data: any, rawLine: string): void {
  const rawType = data?.type;
  // A control_response FROM the CLI answers a UI-initiated control_request
  // (get_context_usage etc.). Match it to its pending waiter by request_id and
  // resolve — it does NOT belong to the turn's SSE stream. (The answer we send
  // TO the CLI for can_use_tool/AskUserQuestion is a separate outbound write.)
  if (rawType === "control_response") {
    const rid = data.response?.request_id;
    const waiter = rid ? claudeControlWaiters.get(rid) : undefined;
    if (waiter) {
      claudeControlWaiters.delete(rid);
      clearTimeout(waiter.timer);
      waiter.resolve(data.response);
    }
    return;
  }
  const innerType = rawType === "stream_event" && data.event ? data.event.type : rawType;
  if (innerType === "result" || innerType === "error" || innerType === "assistant" || innerType === "system") {
    appendLog(`[Claude raw ${innerType}] ${rawLine.slice(0, 700)}`);
  }
  for (const frame of parseClaudeEvent(data)) {
    if (frame.type === "session_id") {
      const sid = (frame as any).sessionId as string | undefined;
      if (sid) {
        knownClaudeSessions.add(sid);
        session.claudeSessionId = sid;
        claudeSidToConversation.set(sid, session.conversationId);
        if (!session.aliasedSids.has(sid)) {
          session.aliasedSids.add(sid);
          // Alias the relay entry under Claude's session_id for the LIFE of the
          // session: the browser POSTs tool results keyed by session_id, but the
          // relay registers the channel under relayId. Without this every tool
          // call times out -> empty turn -> the "completed adjustments" fallback.
          activeSessions.set(sid, session.relayEntry);
          appendLog(`[Claude] aliased relay ${session.relayId} -> ${sid} (tool-result routing)`);
        }
      }
      writeFrameToActiveSse(session, frame); // orb stores claudeSessionId for --resume
      continue;
    }
    if (frame.type === "error") {
      appendLog(`[Claude] error frame: ${(frame as any).message}`);
      writeFrameToActiveSse(session, frame);
      continue;
    }
    if (frame.type === "done") {
      // FIX 2: the `done` frame derives from the CLI's `result` event, which
      // carries no turn identity. Match it FIFO against the turn generation:
      // consume one result generation, and only end the turn if this result
      // belongs to the CURRENT busy turn (resultGen === turnGen). A result from
      // an interrupted/superseded turn (resultGen < turnGen) is DRAINED — we do
      // NOT write to the newer turn's SSE and do NOT resolve its await.
      // Clamp so resultGen can never exceed turnGen: if the CLI emits a trailing
      // `result` after an interrupt (unconfirmed CLI semantics), it must simply
      // drain without pushing the FIFO ahead of the turn counter — otherwise the
      // next real turn's result would appear stale and hang. Safe whether or not
      // such a trailing result is ever emitted.
      session.resultGen = Math.min(session.resultGen + 1, session.turnGen);
      if (session.busy && session.resultGen === session.turnGen) {
        writeFrameToActiveSse(session, frame);
        finishClaudeTurn(session, { viaClose: false }); // authoritative result-driven turn-end
      } else {
        appendLog(
          `[Claude] draining stale result conv=${session.conversationId} ` +
            `resultGen=${session.resultGen} turnGen=${session.turnGen} busy=${session.busy}`,
        );
      }
      continue;
    }
    if (frame.type === "control_request") {
      const r: any = (frame as any).request || {};
      appendLog(
        `[Claude] control_request id=${(frame as any).requestId} ` +
          `subtype=${r.subtype} tool=${r.tool_name} conv=${session.conversationId}`,
      );
      writeFrameToActiveSse(session, frame);
      continue;
    }
    writeFrameToActiveSse(session, frame);
  }
}

// Attach stdout/stderr/error/close handlers to a child. Every handler carries a
// stale-proc guard (`session.proc !== proc`) so a respawned session's OLD child
// handlers no-op. Called once per child (create + respawn).
function attachClaudeHandlers(session: ClaudeSession): void {
  const proc = session.proc;
  proc.on("error", (err) => {
    if (session.proc !== proc) return;
    appendLog(`[Claude CLI] spawn error conv=${session.conversationId}: ${err.message}`);
    // A failed spawn otherwise leaves the turn hanging until the stall watchdog
    // (~5 min). Surface the error, end the turn, and drop the session so the next
    // turn respawns a fresh child.
    writeFrameToActiveSse(session, { type: "error", message: `Claude CLI failed to start: ${err.message}` });
    if (session.busy) finishClaudeTurn(session, { viaClose: true });
    teardownClaudeSession(session.conversationId, false);
  });
  proc.stdout?.on("data", (chunk: Buffer) => {
    if (session.proc !== proc) return; // stale-proc guard
    if (session.busy) armClaudeStallWatchdog(session); // FIX 3: reset inactivity watchdog on every frame
    session.stdoutBuf += chunk.toString();
    let nl: number;
    while ((nl = session.stdoutBuf.indexOf("\n")) !== -1) {
      const line = session.stdoutBuf.slice(0, nl).trim();
      session.stdoutBuf = session.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let data: any;
      try { data = JSON.parse(line); } catch { continue; }
      try { handleClaudeStdoutLine(session, data, line); }
      catch (e: any) { appendLog(`[Claude] stdout handler threw conv=${session.conversationId}: ${e?.message || e}`); }
    }
  });
  proc.stderr?.on("data", (c: Buffer) => {
    if (session.proc !== proc) return;
    session.stderr = (session.stderr + c.toString()).slice(-4000);
  });
  proc.on("close", (code) => {
    if (session.proc !== proc) return; // a respawn replaced this child — ignore its death
    appendLog(`[Claude] child closed conv=${session.conversationId} code=${code} busy=${session.busy}`);
    if (session.busy) finishClaudeTurn(session, { viaClose: true, exitCode: code }); // close-fallback turn-end
    teardownClaudeSession(session.conversationId, false); // already dead — don't re-kill
  });
}

// Reap the least-recently-used IDLE session(s) to keep under the cap. Never
// reaps a busy session (an active turn); allows a brief overflow instead.
function reapLruClaudeSessionsIfNeeded(): void {
  while (claudeSessions.size >= MAX_CLAUDE_SESSIONS) {
    let oldest: ClaudeSession | null = null;
    for (const s of claudeSessions.values()) {
      if (s.busy) continue;
      if (!oldest || s.lastActivity < oldest.lastActivity) oldest = s;
    }
    if (!oldest) break; // every session busy — tolerate overflow rather than kill an active turn
    appendLog(`[Claude] LRU-reaping idle session conv=${oldest.conversationId} (cap ${MAX_CLAUDE_SESSIONS})`);
    teardownClaudeSession(oldest.conversationId, true);
  }
}

// Spawn a fresh persistent child for a conversation. Writes a per-session MCP
// config (stable relayId for the session's life) and keeps --strict-mcp-config.
function createClaudeSession(
  conversationId: string,
  useModel: string,
  useEffort: string,
  claudeSessionId: string | undefined,
  res: ExpressResponse,
): ClaudeSession {
  reapLruClaudeSessionsIfNeeded();
  const relayId = randomUUID();
  const mcpConfigPath = path.join(os.tmpdir(), `vst-mcp-${relayId}.json`);
  const cmdArgs = buildClaudeBaseArgs(useModel, useEffort);
  // Only resume an id THIS process created (a stale orb id 404s the whole turn).
  const resume = isUuidLike(claudeSessionId) && knownClaudeSessions.has(claudeSessionId!);
  if (resume) cmdArgs.push("--resume", claudeSessionId!);
  const mcpConfigWritten = writeClaudeMcpConfig(relayId, mcpConfigPath);
  if (mcpConfigWritten) {
    cmdArgs.push("--mcp-config", mcpConfigPath);
    // Restrict the spawn to ONLY the vst-foundry relay server — without this the
    // CLI boots every global/user MCP server too (boot storm => flapping).
    cmdArgs.push("--strict-mcp-config");
  }
  appendLog(
    `[Claude] spawn persistent child conv=${conversationId} relay=${relayId} ` +
      `model=${useModel} effort=${useEffort} resume=${resume} args=${cmdArgs.join(" ")}`,
  );
  const proc = spawnClaudeCli(cmdArgs, { cwd: PROJECT_CWD });
  const relayEntry: ActiveSession = { sseRes: res, pending: new Map() };
  activeSessions.set(relayId, relayEntry);
  const session: ClaudeSession = {
    proc,
    relayId,
    conversationId,
    claudeSessionId: resume ? claudeSessionId! : null,
    mcpConfigPath,
    mcpConfigWritten,
    model: useModel,
    effort: useEffort,
    activeSse: res,
    stdoutBuf: "",
    stderr: "",
    busy: false,
    lastActivity: Date.now(),
    relayEntry,
    aliasedSids: new Set<string>(),
    turnResolver: null,
    firstTurnPending: !resume, // resumed child already has context — send only the new turn
    interruptSeq: 0,
    heartbeat: null,
    turnGen: 0,
    resultGen: 0,
    stallTimer: null,
    idleWaiters: [],
  };
  if (resume && claudeSessionId) claudeSidToConversation.set(claudeSessionId, conversationId);
  claudeSessions.set(conversationId, session);
  // FIX 5: when resuming a KNOWN Claude session_id, pre-register the relay alias
  // immediately (don't wait for the system/init session_id frame). The browser
  // POSTs tool results keyed by session_id; without the alias an in-turn tool
  // call before that frame arrives would not resolve.
  if (resume && claudeSessionId) {
    activeSessions.set(claudeSessionId, relayEntry);
    session.aliasedSids.add(claudeSessionId);
    appendLog(`[Claude] pre-aliased relay ${relayId} -> ${claudeSessionId} (resume path)`);
  }
  attachClaudeHandlers(session);
  return session;
}

// Respawn a session's child in place (model/effort change). Ports BCC switchModel:
// set session.proc = newProc BEFORE killing the old one so the old child's late
// handlers no-op. relayId + mcpConfigPath are reused, so the relay aliasing and
// pending map stay valid across the swap.
function respawnClaudeSession(session: ClaudeSession, useModel: string, useEffort: string): void {
  const oldProc = session.proc;
  const sid = session.claudeSessionId;
  const canResume = !!sid && isUuidLike(sid) && knownClaudeSessions.has(sid);
  const cmdArgs = buildClaudeBaseArgs(useModel, useEffort);
  if (canResume) cmdArgs.push("--resume", sid!);
  if (session.mcpConfigWritten) {
    cmdArgs.push("--mcp-config", session.mcpConfigPath);
    cmdArgs.push("--strict-mcp-config");
  }
  appendLog(
    `[Claude] respawn child conv=${session.conversationId} ` +
      `model=${session.model}->${useModel} effort=${session.effort}->${useEffort} resume=${canResume}`,
  );
  const newProc = spawnClaudeCli(cmdArgs, { cwd: PROJECT_CWD });
  session.proc = newProc; // swap BEFORE kill so old handlers are stale-guarded
  session.model = useModel;
  session.effort = useEffort;
  session.stdoutBuf = "";
  session.stderr = "";
  session.firstTurnPending = !canResume; // resumed => context restored by the CLI
  // FIX 2: the old child is about to be killed; any unconsumed `result` it owed
  // (e.g. an interrupted prior turn) is dropped by the stale-proc guard and will
  // never increment resultGen. Resync so the next turn's result FIFO-matches.
  session.resultGen = session.turnGen;
  attachClaudeHandlers(session);
  killProc(oldProc);
}

// Resolve a live session by conversationId (preferred) or Claude session_id
// (fallback index). Drops + tears down a dead child so the caller respawns.
export function resolveLiveClaudeSession(conversationId?: string, claudeSessionId?: string): ClaudeSession | undefined {
  let session: ClaudeSession | undefined;
  if (conversationId) session = claudeSessions.get(conversationId);
  if (!session && claudeSessionId) {
    const cid = claudeSidToConversation.get(claudeSessionId);
    if (cid) session = claudeSessions.get(cid);
  }
  if (session && !isClaudeProcAlive(session.proc)) {
    appendLog(`[Claude] discarding dead session conv=${session.conversationId}`);
    teardownClaudeSession(session.conversationId, true);
    return undefined;
  }
  return session;
}

// Fully dispose a session: (optionally) kill the child, unlink its MCP config,
// clear pending tool timers, and drop ALL relay registrations (relayId + every
// aliased session_id). Idempotent.
export function teardownClaudeSession(conversationId: string, doKill: boolean): void {
  const session = claudeSessions.get(conversationId);
  if (!session) return;
  claudeSessions.delete(conversationId);
  stopClaudeHeartbeat(session);
  clearClaudeStallWatchdog(session); // FIX 3
  if (doKill) { try { killProc(session.proc); } catch {} }
  if (session.mcpConfigWritten) {
    try { fs.unlinkSync(session.mcpConfigPath); } catch {}
  }
  for (const p of session.relayEntry.pending.values()) clearTimeout(p.timer);
  activeSessions.delete(session.relayId);
  for (const sid of session.aliasedSids) {
    activeSessions.delete(sid);
    claudeSidToConversation.delete(sid);
  }
  if (session.turnResolver) {
    const r = session.turnResolver;
    session.turnResolver = null;
    r();
  }
  // Wake any routes parked behind this (now-gone) session so they re-resolve and
  // create a fresh child instead of hanging forever in the idle wait.
  session.busy = false;
  releaseClaudeIdleWaiters(session);
  appendLog(`[Claude] torn down session conv=${conversationId} relay=${session.relayId} kill=${doKill}`);
}

// Graceful (async killProc) teardown of every session — used on shutdown().
export function killAllClaudeSessions(): void {
  for (const cid of Array.from(claudeSessions.keys())) teardownClaudeSession(cid, true);
}

// Synchronous kill of every child — for process 'exit' (async taskkill won't run
// then). Mirrors the SD sync-kill pattern.
function killAllClaudeSessionsSync(): void {
  for (const session of claudeSessions.values()) {
    try {
      if (process.platform === "win32" && session.proc.pid) {
        execSync(`taskkill /PID ${session.proc.pid} /T /F`, { stdio: "ignore" });
      } else {
        session.proc.kill("SIGKILL");
      }
    } catch {}
    // FIX 4: the async teardownClaudeSession (which unlinks the per-session MCP
    // config) does NOT run on process 'exit', so remove the temp file here too,
    // otherwise os.tmpdir()/vst-mcp-<relayId>.json leaks on every hard exit.
    if (session.mcpConfigWritten) {
      try { fs.unlinkSync(session.mcpConfigPath); } catch {}
    }
  }
}
process.on("exit", killAllClaudeSessionsSync);

// Idle reaper: kill sessions idle beyond CLAUDE_SESSION_IDLE_MS (never busy ones).
const claudeIdleReaper = setInterval(() => {
  const now = Date.now();
  for (const [cid, session] of claudeSessions) {
    if (!session.busy && now - session.lastActivity > CLAUDE_SESSION_IDLE_MS) {
      appendLog(`[Claude] reaping idle session conv=${cid} idleMs=${now - session.lastActivity}`);
      teardownClaudeSession(cid, true);
    }
  }
}, CLAUDE_REAP_INTERVAL_MS);
claudeIdleReaper.unref();

// One chat turn over the persistent session. Owns the SSE/HTTP lifecycle for the
// Claude path (status/headers/close). Resolves when the turn ends (real `result`,
// child close, or mid-turn interrupt). NEVER calls stdin.end(); NEVER kills the
// child except via explicit teardown (reap / close endpoint / dead-child).
export async function streamClaude(opts: {
  req: express.Request;
  res: ExpressResponse;
  messages: ChatMessage[];
  model?: string;
  conversationId?: string;
  claudeSessionId?: string;
  effort?: string;
  appState?: any;
  screenshot?: string;
}): Promise<void> {
  const { req, res, messages, appState, screenshot } = opts;
  const useModel = resolveClaudeModel(opts.model);
  const useEffort = resolveClaudeEffort(opts.effort);
  let conversationId = (opts.conversationId || "").trim();
  const claudeSessionId = opts.claudeSessionId;

  const sseWrite = (frame: Frame) => {
    if (res.writableEnded) return;
    try { res.write(`data: ${JSON.stringify(frame)}\n\n`); } catch {}
  };

  let session = resolveLiveClaudeSession(conversationId || undefined, claudeSessionId);
  if (session) conversationId = session.conversationId;

  // Open the SSE stream immediately — even if we're about to queue behind a busy
  // turn, the client must get response headers so its fetch resolves and starts
  // reading (otherwise it would time out waiting for headers).
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  setCorsOrigin(req, res);
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof (res as any).flushHeaders === "function") (res as any).flushHeaders();

  // Ensure a conversation key; announce a freshly minted one so the orb adopts it
  // and routes subsequent turns to THIS persistent session.
  if (!conversationId) {
    conversationId = randomUUID();
    sseWrite({ type: "conversationId", conversationId });
    appendLog(`[Claude] minted conversationId=${conversationId} (none supplied by client)`);
  }

  // BCC PARITY: one turn at a time per conversation, but a concurrent turn is
  // QUEUED, not rejected. BCC never returns 409 — sending while a turn runs just
  // hands the message to the live CLI, which serializes it after the current turn.
  // We mirror that: park this route in the session's FIFO idle-waiter list and
  // resume (in arrival order) the moment the in-flight turn finishes, keeping the
  // SSE alive with pings so the client never times out while waiting.
  if (session && session.busy) {
    sseWrite({ type: "status", message: "Queued — finishing the current turn first…" });
    appendLog(`[Claude] queued turn behind busy conv=${conversationId} (BCC-style serialize)`);
    const queuedPing = setInterval(() => {
      if (res.writableEnded) return;
      try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
    }, CLAUDE_HEARTBEAT_MS);
    try {
      while (session && session.busy) {
        await new Promise<void>((resolve) => session!.idleWaiters.push(resolve));
        if (res.writableEnded) {
          // Client gave up while queued — stop waiting; nothing was submitted.
          appendLog(`[Claude] queued client disconnected before its slot conv=${conversationId}`);
          return;
        }
        // The session may have been torn down (child died) while we waited; the
        // create-on-`!session` path below spins up a fresh child if so.
        session = resolveLiveClaudeSession(conversationId || undefined, claudeSessionId);
      }
    } finally {
      clearInterval(queuedPing);
    }
  }

  // Model/effort switch on a live session -> respawn (resume keeps context).
  if (session && (session.model !== useModel || session.effort !== useEffort)) {
    respawnClaudeSession(session, useModel, useEffort);
  }

  // Create the persistent child on first contact for this conversation.
  if (!session) {
    session = createClaudeSession(conversationId, useModel, useEffort, claudeSessionId, res);
  }

  const stdin = session.proc.stdin;
  if (!stdin || !session.proc.stdout) {
    teardownClaudeSession(conversationId, true);
    sseWrite({ type: "error", message: "Failed to capture Claude CLI stdio" });
    sseWrite({ type: "done" });
    if (!res.writableEnded) res.end();
    return;
  }

  // Per-turn wiring: re-point the live SSE channel AND the MCP relay's sseRes
  // (shared by reference) at THIS response so in-turn tool calls reach the
  // current browser connection.
  session.activeSse = res;
  session.relayEntry.sseRes = res;
  session.busy = true;
  // FIX 2: open a new turn generation. The trailing `result` of this turn will
  // FIFO-match resultGen === turnGen; a stale `result` from a prior interrupted
  // turn (lower generation) is drained in handleClaudeStdoutLine's `done` branch.
  session.turnGen++;
  const myGen = session.turnGen;
  session.lastActivity = Date.now();
  startClaudeHeartbeat(session); // keepalive for long silent thinking/tool phases
  armClaudeStallWatchdog(session); // FIX 3: inactivity watchdog (re-armed on every stdout frame)

  // Mid-turn client disconnect -> interrupt the running turn (control_request),
  // do NOT kill the child; it stays warm for the next turn.
  let closeHandled = false;
  const onClose = () => {
    if (closeHandled) return;
    closeHandled = true;
    const s = session!;
    if (s.busy && s.activeSse === res) {
      appendLog(`[Claude] SSE closed mid-turn conv=${conversationId} — interrupting (child kept)`);
      stopClaudeHeartbeat(s);
      clearClaudeStallWatchdog(s); // FIX 3
      writeClaudeInterrupt(s);
      s.activeSse = null;
      s.busy = false;
      s.lastActivity = Date.now();
      // FIX 8: interrupted turn ends WITHOUT a consumed `result` — resync the
      // result FIFO so the next turn's `result` matches (mirrors respawn/finish).
      s.resultGen = s.turnGen;
      const r = s.turnResolver;
      s.turnResolver = null;
      if (r) r();
      // BCC parity: a queued turn may be waiting behind this interrupted one.
      releaseClaudeIdleWaiters(s);
    }
  };
  // Listen ONLY on res "close" (the real client/SSE disconnect). Do NOT listen on
  // req "close": Node fires it the instant the POST body is fully received (request
  // COMPLETE, not disconnect), which tripped ~1ms into every turn and self-interrupted
  // the Claude CLI -> zero frames streamed -> client 150s timeout. res "close" only
  // fires on an actual connection close; the s.busy/activeSse guard ignores normal end.
  res.on("close", onClose);

  // First turn on a fresh (non-resumed) child seeds the system instruction +
  // full transcript; every later turn on the SAME warm child sends ONLY the new
  // user message (the child remembers the rest).
  let content: string;
  if (session.firstTurnPending) {
    content = buildClaudePrompt(messages, appState, false);
    session.firstTurnPending = false;
  } else {
    const lastUser = [...messages].reverse().find((m) => normalizeRole(m.role) === "user");
    content = lastUser ? extractText(lastUser.content) : "";
  }

  if (!content.trim()) {
    const anyUser = messages.some((m) => normalizeRole(m.role) === "user" && extractText(m.content).trim());
    if (!anyUser) {
      sseWrite({ type: "error", message: "No prompt content found in messages" });
      finishClaudeTurn(session, { viaClose: false });
      res.removeListener("close", onClose);
      return;
    }
    const lastUser = [...messages].reverse().find((m) => normalizeRole(m.role) === "user");
    content = lastUser ? extractText(lastUser.content) : content;
  }

  // Image attach — BCC method: write to a temp file and reference BY PATH
  // (inline base64 content blocks are rejected by the CLI).
  let promptToSend = content;
  if (screenshot) {
    try {
      const mt = /^data:(image\/[a-zA-Z0-9.+-]+);base64,/.exec(screenshot)?.[1] || "image/png";
      const ext = mt.includes("jpeg") ? "jpg" : mt.includes("webp") ? "webp" : mt.includes("gif") ? "gif" : "png";
      const pasteDir = path.join(os.tmpdir(), "vst-foundry-pastes");
      fs.mkdirSync(pasteDir, { recursive: true });
      const imgPath = path.join(pasteDir, `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
      fs.writeFileSync(imgPath, Buffer.from(screenshotBase64(screenshot), "base64"));
      promptToSend = `${content}\n\n[The user attached an image. Read it with your Read tool at this absolute path: ${imgPath}]`;
      appendLog(`[Claude] wrote attached image to ${imgPath} (${mt}) — referencing by path (BCC method)`);
    } catch (e: any) {
      appendLog(`[Claude] failed to persist attached image: ${e?.message || e}`);
    }
  }

  // Arm turn completion BEFORE writing stdin so a fast `result` cannot race us.
  const turnComplete = new Promise<void>((resolve) => { session!.turnResolver = resolve; });

  try {
    const userPayload = { type: "user", message: { role: "user", content: promptToSend }, parent_tool_use_id: null };
    // NDJSON user turn on the SHARED stdin — NO stdin.end() (child stays alive).
    stdin.write(JSON.stringify(userPayload) + "\n");
    appendLog(
      `[Claude] wrote user turn conv=${conversationId} relay=${session.relayId} ` +
        `gen=${myGen} model=${useModel} effort=${useEffort} len=${promptToSend.length}`,
    );
  } catch (e: any) {
    appendLog(`[Claude] failed to write user turn conv=${conversationId}: ${e?.message || e}`);
    sseWrite({ type: "error", message: `Failed to write to Claude CLI: ${e?.message || e}` });
    finishClaudeTurn(session, { viaClose: false });
    res.removeListener("close", onClose);
    teardownClaudeSession(conversationId, true); // child likely dead — respawn next turn
    return;
  }

  await turnComplete;
  res.removeListener("close", onClose);
}
