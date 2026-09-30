// @vitest-environment node
import { EventEmitter } from "events";
import { describe, it, expect, vi, beforeEach } from "vitest";

// B1 / m1 regression tests for server/claude-bridge.ts. child_process's
// `spawn` is mocked for this whole file — every test here exercises real
// claude-bridge.ts code paths (buildClaudeBaseArgs, respawnClaudeSession,
// setClaudeSessionPermissionMode, handleClaudeStdoutLine, finishClaudeTurn)
// but must never actually launch the `claude` CLI or any other process/app.
function makeFakeChildProcess(): any {
  const proc: any = new EventEmitter();
  proc.pid = Math.floor(Math.random() * 100000) + 1;
  proc.exitCode = null;
  proc.killed = false;
  proc.stdin = { write: vi.fn(), end: vi.fn(), destroyed: false };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

const spawnMock = vi.fn(() => makeFakeChildProcess());

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => (spawnMock as (...a: unknown[]) => unknown)(...args),
  execSync: vi.fn(),
}));

const {
  buildClaudeBaseArgs,
  setClaudeSessionPermissionMode,
  respawnClaudeSession,
  handleClaudeStdoutLine,
  finishClaudeTurn,
  streamClaude,
  claudeSessions,
} = await import("../server/claude-bridge");
type ClaudeSessionT = import("../server/claude-bridge").ClaudeSession;
import { ALLOWED_TOOLS } from "../server/permissions";

function makeFakeSession(overrides: Partial<ClaudeSessionT> = {}): ClaudeSessionT {
  const proc = makeFakeChildProcess();
  return {
    proc,
    relayId: "relay-1",
    conversationId: "conv-1",
    claudeSessionId: null,
    mcpConfigPath: "",
    mcpConfigWritten: false,
    model: "claude-opus-4-8",
    effort: "max",
    permissionMode: "ask",
    pendingPermissionMode: null,
    sessionAllow: new Set<string>(),
    denyCounts: new Map<string, number>(),
    pendingToolRequests: new Map<string, { toolName: string; toolInput: unknown }>(),
    activeSse: null,
    stdoutBuf: "",
    stderr: "",
    busy: false,
    lastActivity: Date.now(),
    relayEntry: { sseRes: null as any, pending: new Map() },
    aliasedSids: new Set<string>(),
    turnResolver: null,
    firstTurnPending: false,
    interruptSeq: 0,
    heartbeat: null,
    turnGen: 1,
    resultGen: 1,
    stallTimer: null,
    idleWaiters: [],
    ...overrides,
  } as unknown as ClaudeSessionT;
}

beforeEach(() => {
  spawnMock.mockClear();
});

describe("B1 — buildClaudeBaseArgs", () => {
  const MODES = ["ask", "accept_edits", "readonly", "trusted"] as const;
  // CRITICAL (G5 audit item 1): every policy mode maps to the CLI's "default"
  // --permission-mode, never acceptEdits/bypassPermissions — those make the
  // CLI auto-approve tools ITSELF with no control_request at all, so
  // decide() (and its self-modify rule) never runs. See CLI_PERMISSION_MODES'
  // comment in server/permissions.ts for the live-proof detail.
  const CLI_MODE: Record<(typeof MODES)[number], string> = {
    ask: "default",
    accept_edits: "default",
    readonly: "default",
    trusted: "default",
  };

  it.each(MODES)("mode=%s: carries every required permission flag and never the skip flag", (mode) => {
    const args = buildClaudeBaseArgs("claude-opus-4-8", "max", mode);

    expect(args).not.toContain("--dangerously-skip-permissions");

    expect(args).toContain("--permission-prompt-tool");
    expect(args[args.indexOf("--permission-prompt-tool") + 1]).toBe("stdio");

    expect(args).toContain("--permission-prompts");
    expect(args[args.indexOf("--permission-prompts") + 1]).toBe("host");

    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe(CLI_MODE[mode]);

    expect(args).toContain("--setting-sources");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("project,local");

    expect(args).toContain("--allowedTools");
    const at = args.indexOf("--allowedTools");
    expect(args.slice(at + 1, at + 1 + ALLOWED_TOOLS.length)).toEqual(ALLOWED_TOOLS);
  });

  it("never emits --dangerously-skip-permissions for any mode, ever", () => {
    for (const mode of MODES) {
      expect(buildClaudeBaseArgs("claude-opus-4-8", "max", mode)).not.toContain(
        "--dangerously-skip-permissions",
      );
    }
  });
});

describe("B1 — respawn on permission-mode change", () => {
  it("setClaudeSessionPermissionMode respawns the child in place when the session is idle", () => {
    const session = makeFakeSession({ permissionMode: "ask", busy: false });
    const oldProc = session.proc;
    spawnMock.mockClear();

    const ok = setClaudeSessionPermissionMode(session, "trusted");

    expect(ok).toBe(true);
    // Two spawn() calls are expected: the new CLI child, plus killProc's
    // taskkill for the old one (Windows) — assert on the FIRST (the CLI
    // spawn), not the total count.
    expect(spawnMock).toHaveBeenCalled();
    expect(session.proc).not.toBe(oldProc); // swapped -> respawned
    expect(session.permissionMode).toBe("trusted");
  });

  it("defers the respawn (never swaps the child, never mutates permissionMode) while the session is busy", () => {
    const session = makeFakeSession({ permissionMode: "ask", busy: true });
    const oldProc = session.proc;
    spawnMock.mockClear();

    const ok = setClaudeSessionPermissionMode(session, "trusted");

    expect(ok).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(session.proc).toBe(oldProc); // NOT respawned yet
    // Single-writer invariant: only respawnClaudeSession may write
    // permissionMode, so it must still read the OLD (running) value.
    expect(session.permissionMode).toBe("ask");
  });

  it("is a no-op (no respawn) when asked to set the mode it is already in", () => {
    const session = makeFakeSession({ permissionMode: "trusted", busy: false });
    spawnMock.mockClear();

    const ok = setClaudeSessionPermissionMode(session, "trusted");

    expect(ok).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects an unrecognized mode without touching the session", () => {
    const session = makeFakeSession({ permissionMode: "ask", busy: false });
    spawnMock.mockClear();

    const ok = setClaudeSessionPermissionMode(session, "not-a-real-mode");

    expect(ok).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(session.permissionMode).toBe("ask");
  });

  it("respawnClaudeSession's spawn args carry the NEW mode's flags", () => {
    const session = makeFakeSession({ permissionMode: "ask", busy: false });
    spawnMock.mockClear();

    respawnClaudeSession(session, session.model, session.effort, "readonly");

    // Two spawn() calls: the new CLI child (first) + killProc's taskkill for
    // the old one (Windows, second) — assert against the first.
    expect(spawnMock).toHaveBeenCalled();
    const spawnArgs = spawnMock.mock.calls[0] as unknown[];
    // Windows spawns via `cmd.exe /c <claude> ...args`; the CLI's own args are
    // whatever comes after the claude binary token.
    const argv = spawnArgs[1] as string[];
    expect(argv).toContain("--permission-mode");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("default"); // readonly -> "default"
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(session.permissionMode).toBe("readonly");
  });

  it("G5 item 4: a mode change deferred while busy is stored (not just logged) and applied by finishClaudeTurn", () => {
    const session = makeFakeSession({ permissionMode: "ask", busy: true });
    const oldProc = session.proc;
    spawnMock.mockClear();

    const ok = setClaudeSessionPermissionMode(session, "trusted");
    expect(ok).toBe(true);
    expect(session.pendingPermissionMode).toBe("trusted"); // stored, not applied yet
    expect(session.proc).toBe(oldProc);
    expect(session.permissionMode).toBe("ask");
    expect(spawnMock).not.toHaveBeenCalled();

    // The turn ends -> finishClaudeTurn must apply the deferred change on its
    // own, independent of any client request resending "trusted".
    finishClaudeTurn(session, { viaClose: false });

    expect(spawnMock).toHaveBeenCalled();
    expect(session.proc).not.toBe(oldProc);
    expect(session.permissionMode).toBe("trusted");
    expect(session.pendingPermissionMode).toBeNull();
  });

  it("finishClaudeTurn is a no-op respawn-wise when there is no deferred mode change", () => {
    const session = makeFakeSession({ permissionMode: "ask", busy: true });
    const oldProc = session.proc;
    spawnMock.mockClear();

    finishClaudeTurn(session, { viaClose: false });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(session.proc).toBe(oldProc);
    expect(session.permissionMode).toBe("ask");
  });
});

describe("m1 — pendingToolRequests cleanup", () => {
  it("control_cancel_request removes the matching pending tool request", () => {
    const session = makeFakeSession({ permissionMode: "ask" });

    handleClaudeStdoutLine(
      session,
      {
        type: "control_request",
        request_id: "req1",
        request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } },
      },
      "",
    );
    expect(session.pendingToolRequests.has("req1")).toBe(true);

    handleClaudeStdoutLine(session, { type: "control_cancel_request", request_id: "req1" }, "");
    expect(session.pendingToolRequests.has("req1")).toBe(false);
  });

  it("control_cancel_request for an unknown/already-consumed requestId is a harmless no-op", () => {
    const session = makeFakeSession({ permissionMode: "ask" });
    expect(() =>
      handleClaudeStdoutLine(session, { type: "control_cancel_request", request_id: "never-existed" }, ""),
    ).not.toThrow();
    expect(session.pendingToolRequests.size).toBe(0);
  });

  it("finishClaudeTurn clears every pending tool request when the turn ends", () => {
    const session = makeFakeSession({ permissionMode: "ask", busy: true });
    session.pendingToolRequests.set("req-a", { toolName: "Bash", toolInput: {} });
    session.pendingToolRequests.set("req-b", { toolName: "Write", toolInput: {} });
    expect(session.pendingToolRequests.size).toBe(2);

    finishClaudeTurn(session, { viaClose: false });

    expect(session.pendingToolRequests.size).toBe(0);
  });

  it("an 'ask'-verdict can_use_tool request is remembered as pending; an auto-decided one is not", () => {
    const session = makeFakeSession({ permissionMode: "trusted" }); // trusted -> auto-allow for a plain edit
    handleClaudeStdoutLine(
      session,
      {
        type: "control_request",
        request_id: "req-auto",
        request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "src/App.tsx" } },
      },
      "",
    );
    // Trusted mode auto-allows a non-self-surface edit — never bubbles, so
    // nothing should be remembered as pending for it.
    expect(session.pendingToolRequests.has("req-auto")).toBe(false);

    handleClaudeStdoutLine(
      session,
      {
        type: "control_request",
        request_id: "req-ask",
        request: { subtype: "can_use_tool", tool_name: "Edit", input: { file_path: "server/routes.ts" } },
      },
      "",
    );
    // A self-modify edit still bubbles even in trusted mode -> IS pending.
    expect(session.pendingToolRequests.has("req-ask")).toBe(true);
  });
});

describe("m3 — policy {reason, selfModifyPath} forwarded on the 'ask' frame", () => {
  function makeFakeSse() {
    return { write: vi.fn(), writableEnded: false } as unknown as ClaudeSessionT["activeSse"];
  }

  it("a self-modify ask carries policy.selfModifyPath and policy.reason to the SSE frame", () => {
    const activeSse = makeFakeSse();
    const session = makeFakeSession({ permissionMode: "ask", activeSse });

    handleClaudeStdoutLine(
      session,
      {
        type: "control_request",
        request_id: "req-sm",
        request: { subtype: "can_use_tool", tool_name: "Edit", input: { file_path: "server/routes.ts" } },
      },
      "",
    );

    const write = (activeSse as any).write as ReturnType<typeof vi.fn>;
    expect(write).toHaveBeenCalledTimes(1);
    const line = write.mock.calls[0][0] as string;
    const frame = JSON.parse(line.replace(/^data: /, "").trim());
    expect(frame.type).toBe("control_request");
    expect(frame.policy).toBeDefined();
    expect(frame.policy.selfModifyPath).toBe("server/routes.ts");
    expect(typeof frame.policy.reason).toBe("string");
    expect(frame.policy.reason).toMatch(/assistant's own surface/i);
  });

  it("an ordinary (non-self-modify) ask also carries a policy object, with selfModifyPath null", () => {
    const activeSse = makeFakeSse();
    const session = makeFakeSession({ permissionMode: "ask", activeSse });

    handleClaudeStdoutLine(
      session,
      {
        type: "control_request",
        request_id: "req-ord",
        request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } },
      },
      "",
    );

    const write = (activeSse as any).write as ReturnType<typeof vi.fn>;
    const line = write.mock.calls[0][0] as string;
    const frame = JSON.parse(line.replace(/^data: /, "").trim());
    expect(frame.policy).toBeDefined();
    expect(frame.policy.selfModifyPath).toBeNull();
  });
});

function makeFakeReqRes() {
  const written: string[] = [];
  const req: any = { headers: {} };
  const res: any = {
    writableEnded: false,
    setHeader: vi.fn(),
    write: vi.fn((chunk: string) => {
      written.push(chunk);
      return true;
    }),
    end: vi.fn(() => {
      res.writableEnded = true;
    }),
    on: vi.fn(),
    flushHeaders: vi.fn(),
  };
  return { req, res, written };
}

describe("G5 item 5 + streamClaude dispatch-time respawn", () => {
  // Registers a pre-built session directly (bypassing spawn/createClaudeSession)
  // so streamClaude sees it as an already-live conversation via
  // resolveLiveClaudeSession.
  function registerLiveSession(mode: import("../server/permissions").PermissionMode): ClaudeSessionT {
    const session = makeFakeSession({ permissionMode: mode, busy: false });
    claudeSessions.set(session.conversationId, session);
    return session;
  }

  it("item 5: an OMITTED permissionMode keeps the existing session's OWN mode (never resets to DEFAULT_PERMISSION_MODE)", () => {
    const session = registerLiveSession("readonly");
    const { req, res } = makeFakeReqRes();
    spawnMock.mockClear();

    void streamClaude({
      req,
      res,
      messages: [],
      conversationId: session.conversationId,
      permissionMode: undefined, // <- omitted, exactly like routes.ts now passes through
    }).catch(() => {});

    expect(session.permissionMode).toBe("readonly"); // NOT reset to "trusted"
    expect(spawnMock).not.toHaveBeenCalled(); // no respawn triggered
    finishClaudeTurn(session, { viaClose: true }); // release timers
  });

  it("dispatch-time respawn: a turn arriving with a DIFFERENT explicit mode respawns the child", () => {
    const session = registerLiveSession("readonly");
    const { req, res } = makeFakeReqRes();
    spawnMock.mockClear();

    void streamClaude({
      req,
      res,
      messages: [],
      conversationId: session.conversationId,
      permissionMode: "trusted",
    }).catch(() => {});

    expect(session.permissionMode).toBe("trusted");
    expect(spawnMock).toHaveBeenCalled();
    finishClaudeTurn(session, { viaClose: true });
  });

  it("dispatch-time respawn: a turn arriving with the SAME explicit mode does not respawn", () => {
    const session = registerLiveSession("trusted");
    const { req, res } = makeFakeReqRes();
    spawnMock.mockClear();

    void streamClaude({
      req,
      res,
      messages: [],
      conversationId: session.conversationId,
      permissionMode: "trusted",
    }).catch(() => {});

    expect(session.permissionMode).toBe("trusted");
    expect(spawnMock).not.toHaveBeenCalled();
    finishClaudeTurn(session, { viaClose: true });
  });
});

describe("G5 round 3 item 2 (MAJOR): unguarded deferred respawn orphans a child on close/error", () => {
  it("finishClaudeTurn does NOT respawn when childDied:true, even with a deferred mode change pending", () => {
    const session = makeFakeSession({ permissionMode: "ask", busy: true });
    session.pendingPermissionMode = "trusted";
    const oldProc = session.proc;
    spawnMock.mockClear();

    finishClaudeTurn(session, { viaClose: true, childDied: true });

    expect(spawnMock).not.toHaveBeenCalled(); // no new child spawned
    expect(session.proc).toBe(oldProc); // never swapped
    expect(session.permissionMode).toBe("ask"); // deferred change dropped, not silently applied
    expect(session.pendingPermissionMode).toBeNull();
  });

  it("finishClaudeTurn STILL respawns for a deferred mode change when the turn ended normally (childDied unset)", () => {
    // Sanity check the guard is scoped correctly: the ordinary (non-death)
    // path from the existing G5 item 4 coverage must keep working.
    const session = makeFakeSession({ permissionMode: "ask", busy: true });
    session.pendingPermissionMode = "trusted";
    const oldProc = session.proc;
    spawnMock.mockClear();

    finishClaudeTurn(session, { viaClose: false });

    expect(spawnMock).toHaveBeenCalled();
    expect(session.proc).not.toBe(oldProc);
    expect(session.permissionMode).toBe("trusted");
  });

  it("end-to-end: a child that closes mid-turn with a deferred mode change leaves no orphan CLI process", () => {
    const { req, res } = makeFakeReqRes();
    spawnMock.mockClear();

    // Real session creation path (streamClaude -> createClaudeSession),
    // attaching the REAL close/error handlers to the mocked child.
    void streamClaude({ req, res, messages: [], conversationId: "conv-orphan-close", permissionMode: "ask" }).catch(() => {});

    const session = claudeSessions.get("conv-orphan-close")!;
    expect(session).toBeDefined();
    expect(session.busy).toBe(true);

    // A mode change arrives while the turn is busy -> deferred.
    const ok = setClaudeSessionPermissionMode(session, "trusted");
    expect(ok).toBe(true);
    expect(session.pendingPermissionMode).toBe("trusted");

    const cliSpawnsBeforeClose = spawnMock.mock.calls.filter((c: any) => c[0] === "cmd.exe").length;
    expect(cliSpawnsBeforeClose).toBe(1); // just the initial createClaudeSession spawn

    // The child dies mid-turn (crash / killed externally).
    session.proc.emit("close", 1);

    // No orphan: the session is torn down (removed from the registry)...
    expect(claudeSessions.has("conv-orphan-close")).toBe(false);
    // ...and critically, NO second "claude.cmd" child was spawned that the
    // doKill=false teardown above would then have abandoned unreachably.
    const cliSpawnsAfterClose = spawnMock.mock.calls.filter((c: any) => c[0] === "cmd.exe").length;
    expect(cliSpawnsAfterClose).toBe(1); // unchanged — no respawn happened
  });

  it("end-to-end: a spawn error with a deferred mode change leaves no orphan CLI process", () => {
    const { req, res } = makeFakeReqRes();
    spawnMock.mockClear();

    void streamClaude({ req, res, messages: [], conversationId: "conv-orphan-error", permissionMode: "ask" }).catch(() => {});

    const session = claudeSessions.get("conv-orphan-error")!;
    expect(session).toBeDefined();

    setClaudeSessionPermissionMode(session, "trusted");
    expect(session.pendingPermissionMode).toBe("trusted");

    const cliSpawnsBeforeError = spawnMock.mock.calls.filter((c: any) => c[0] === "cmd.exe").length;

    session.proc.emit("error", new Error("spawn EPERM"));

    expect(claudeSessions.has("conv-orphan-error")).toBe(false);
    const cliSpawnsAfterError = spawnMock.mock.calls.filter((c: any) => c[0] === "cmd.exe").length;
    expect(cliSpawnsAfterError).toBe(cliSpawnsBeforeError); // no respawn -> no orphan
  });
});
