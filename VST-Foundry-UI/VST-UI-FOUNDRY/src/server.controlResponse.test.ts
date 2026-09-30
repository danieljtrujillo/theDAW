// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { app } from "../server";
import { claudeSessions, claudeControlWaiters } from "../server/claude-bridge";
import type { ClaudeSession } from "../server/claude-bridge";

// M1 regression: POST /api/assistant/control-response must (1) look up the
// pending tool/input and compute selfModifyPath BEFORE writing anything to
// the CLI's stdin, and (2) strip `updatedPermissions` from what's actually
// forwarded to the CLI whenever a can_use_tool prompt is being answered — the
// server's own sessionAllow is the ONLY place a standing "always allow" rule
// may live; the CLI must never get one of its own.

function makeFakeSession(conversationId: string): ClaudeSession & { proc: any } {
  const stdinWrite = vi.fn();
  return {
    proc: {
      exitCode: null,
      killed: false,
      stdin: { destroyed: false, write: stdinWrite },
    },
    relayId: "relay-" + conversationId,
    conversationId,
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
    turnGen: 0,
    resultGen: 0,
    stallTimer: null,
    idleWaiters: [],
  } as unknown as ClaudeSession & { proc: any };
}

function writtenResponseBody(stdinWrite: ReturnType<typeof vi.fn>): any {
  expect(stdinWrite).toHaveBeenCalledTimes(1);
  const line = stdinWrite.mock.calls[0][0] as string;
  const payload = JSON.parse(line.trim());
  return payload.response.response;
}

describe("POST /api/assistant/control-response", () => {
  let conversationId: string;
  let session: ClaudeSession & { proc: any };

  beforeEach(() => {
    conversationId = "conv-" + Math.random().toString(36).slice(2);
    session = makeFakeSession(conversationId);
    claudeSessions.set(conversationId, session);
  });

  it("ordinary 'always allow': strips updatedPermissions from what reaches the CLI, but records session-allow server-side", async () => {
    session.pendingToolRequests.set("req1", { toolName: "Bash", toolInput: { command: "ls" } });

    const res = await request(app)
      .post("/api/assistant/control-response")
      .send({
        conversationId,
        requestId: "req1",
        response: { behavior: "allow", updatedInput: { command: "ls" }, updatedPermissions: ["Bash"] },
      });

    expect(res.status).toBe(200);
    const forwarded = writtenResponseBody(session.proc.stdin.write);
    expect(forwarded.behavior).toBe("allow");
    expect(forwarded).not.toHaveProperty("updatedPermissions");

    // The server's own sessionAllow IS where the standing rule lives.
    expect(session.sessionAllow.has("Bash")).toBe(true);
  });

  it("self-modify 'always allow': strips updatedPermissions from the CLI AND never records session-allow server-side", async () => {
    session.pendingToolRequests.set("req2", {
      toolName: "Edit",
      toolInput: { file_path: "server/routes.ts" },
    });

    const res = await request(app)
      .post("/api/assistant/control-response")
      .send({
        conversationId,
        requestId: "req2",
        response: {
          behavior: "allow",
          updatedInput: { file_path: "server/routes.ts" },
          updatedPermissions: ["Edit"],
        },
      });

    expect(res.status).toBe(200);
    const forwarded = writtenResponseBody(session.proc.stdin.write);
    expect(forwarded.behavior).toBe("allow");
    expect(forwarded).not.toHaveProperty("updatedPermissions");

    // permissions.ts's self-modify rule: NEVER remembered for the session,
    // regardless of what the client asked for.
    expect(session.sessionAllow.has("Edit")).toBe(false);
  });

  it("a plain 'allow once' (no updatedPermissions) passes its response through unchanged and does not record session-allow", async () => {
    session.pendingToolRequests.set("req3", { toolName: "Write", toolInput: { file_path: "src/App.tsx" } });

    const res = await request(app)
      .post("/api/assistant/control-response")
      .send({
        conversationId,
        requestId: "req3",
        response: { behavior: "allow", updatedInput: { file_path: "src/App.tsx" } },
      });

    expect(res.status).toBe(200);
    const forwarded = writtenResponseBody(session.proc.stdin.write);
    expect(forwarded).toEqual({ behavior: "allow", updatedInput: { file_path: "src/App.tsx" } });
    expect(session.sessionAllow.has("Write")).toBe(false);
  });

  it("an AskUserQuestion answer (WITH its live pending entry) passes through, minus any updatedPermissions-shaped field", async () => {
    // G5 round 4 item 3: claude-bridge.ts's forwarding loop now tracks EVERY
    // bubbled control_request, AskUserQuestion included — a genuine
    // AskUserQuestion answer therefore DOES have a pending entry, recognized
    // server-side by toolName "AskUserQuestion" (never from client input).
    session.pendingToolRequests.set("req4", { toolName: "AskUserQuestion", toolInput: {} });

    const res = await request(app)
      .post("/api/assistant/control-response")
      .send({
        conversationId,
        requestId: "req4",
        response: { behavior: "allow", updatedInput: { questions: [], answers: [] } },
      });

    expect(res.status).toBe(200);
    const forwarded = writtenResponseBody(session.proc.stdin.write);
    expect(forwarded).toEqual({ behavior: "allow", updatedInput: { questions: [], answers: [] } });
    // Never policy-recorded: AskUserQuestion is not a permission decision.
    expect(session.sessionAllow.size).toBe(0);
  });

  it("G5 round 4 item 3 (MAJOR): a STALE/replayed requestId with no live pending entry is refused with 404, never reaches the CLI", async () => {
    // No session.pendingToolRequests entry -- matches Python's
    // assistant_routes.py, which 404s when pending_controls has no entry for
    // this requestId, regardless of what shape the client's response is in.
    // A prior version fell back to a client-controlled shape heuristic here,
    // which a crafted payload (updatedInput shaped like an AskUserQuestion
    // answer, PLUS updatedPermissions) could spoof to slip through unstripped.
    const res = await request(app)
      .post("/api/assistant/control-response")
      .send({
        conversationId,
        requestId: "req5-stale",
        response: {
          behavior: "allow",
          updatedInput: { command: "ls" },
          updatedPermissions: ["Bash"],
        },
      });

    expect(res.status).toBe(404);
    expect(session.proc.stdin.write).not.toHaveBeenCalled();
  });

  it("G5 round 4 item 3: a REPLAYED POST for an already-answered requestId is refused with 404 (the exact replay attack)", async () => {
    session.pendingToolRequests.set("req-replay", { toolName: "Bash", toolInput: { command: "ls" } });

    const first = await request(app)
      .post("/api/assistant/control-response")
      .send({
        conversationId,
        requestId: "req-replay",
        response: { behavior: "allow", updatedInput: { command: "ls" } },
      });
    expect(first.status).toBe(200);
    expect(session.proc.stdin.write).toHaveBeenCalledTimes(1);

    // The SAME requestId, replayed with a malicious payload this time.
    const replay = await request(app)
      .post("/api/assistant/control-response")
      .send({
        conversationId,
        requestId: "req-replay",
        response: {
          behavior: "allow",
          updatedInput: { questions: [], answers: [] },
          updatedPermissions: ["Bash"],
        },
      });

    expect(replay.status).toBe(404);
    // Still exactly one write -- the replay never reached the CLI at all.
    expect(session.proc.stdin.write).toHaveBeenCalledTimes(1);
  });

  it("G5 round 3 item 3: pending proves can_use_tool, so it wins even when updatedInput is shaped like an AskUserQuestion answer", async () => {
    // A pending entry PROVES this is a can_use_tool answer (AskUserQuestion
    // never gets one) — that proof must win over a client-supplied
    // updatedInput that happens to carry questions/answers keys. A prior
    // version OR'd the shape check in unconditionally and let
    // updatedPermissions slip through here.
    session.pendingToolRequests.set("req6", { toolName: "Bash", toolInput: { command: "ls" } });

    const res = await request(app)
      .post("/api/assistant/control-response")
      .send({
        conversationId,
        requestId: "req6",
        response: {
          behavior: "allow",
          updatedInput: { questions: [], answers: [] },
          updatedPermissions: ["Bash"],
        },
      });

    expect(res.status).toBe(200);
    const forwarded = writtenResponseBody(session.proc.stdin.write);
    expect(forwarded).not.toHaveProperty("updatedPermissions");
    expect(forwarded).toEqual({ behavior: "allow", updatedInput: { questions: [], answers: [] } });
  });

  it("G5 round 4 item 4 (MINOR): the allowlist drops ANY unrecognized field, not just updatedPermissions by name", async () => {
    // Proves this is truly an allowlist, not a blacklist that only knows
    // about one specific key -- a hypothetical NEW permission-carrying field
    // the CLI grows later is excluded by default too.
    session.pendingToolRequests.set("req-allowlist", { toolName: "Bash", toolInput: { command: "ls" } });

    const res = await request(app)
      .post("/api/assistant/control-response")
      .send({
        conversationId,
        requestId: "req-allowlist",
        response: {
          behavior: "allow",
          updatedInput: { command: "ls" },
          message: "fyi",
          someFutureField: { grantsStandingAccess: true },
        },
      });

    expect(res.status).toBe(200);
    const forwarded = writtenResponseBody(session.proc.stdin.write);
    expect(forwarded).toEqual({ behavior: "allow", updatedInput: { command: "ls" }, message: "fyi" });
    expect(forwarded).not.toHaveProperty("someFutureField");
  });

  it("G5 round 5 item 4 (MINOR): an unrecognized behavior VALUE is refused with 400, never reaches the CLI, and the pending entry survives for a retry", async () => {
    // The key allowlist (previous test) only filters WHICH fields forward --
    // it never checked the VALUE of `behavior` itself. An arbitrary string
    // here would have been written verbatim to the CLI's stdin and
    // interpolated unescaped into the server's own appendLog call.
    session.pendingToolRequests.set("req-bad-behavior", {
      toolName: "Bash",
      toolInput: { command: "ls" },
    });

    const res = await request(app)
      .post("/api/assistant/control-response")
      .send({
        conversationId,
        requestId: "req-bad-behavior",
        response: { behavior: "bypassPermissions", updatedInput: { command: "ls" } },
      });

    expect(res.status).toBe(400);
    expect(session.proc.stdin.write).not.toHaveBeenCalled();
    expect(session.sessionAllow.size).toBe(0);
    // Re-inserted, not permanently consumed -- a corrected retry for the
    // SAME requestId must still find a live pending entry.
    expect(session.pendingToolRequests.has("req-bad-behavior")).toBe(true);

    const retry = await request(app)
      .post("/api/assistant/control-response")
      .send({
        conversationId,
        requestId: "req-bad-behavior",
        response: { behavior: "allow", updatedInput: { command: "ls" } },
      });
    expect(retry.status).toBe(200);
    expect(session.proc.stdin.write).toHaveBeenCalledTimes(1);
  });

  it("G5 round 5 item 4 (MINOR): a missing behavior is also refused with 400", async () => {
    session.pendingToolRequests.set("req-missing-behavior", {
      toolName: "Bash",
      toolInput: { command: "ls" },
    });

    const res = await request(app)
      .post("/api/assistant/control-response")
      .send({
        conversationId,
        requestId: "req-missing-behavior",
        response: { updatedInput: { command: "ls" } },
      });

    expect(res.status).toBe(400);
    expect(session.proc.stdin.write).not.toHaveBeenCalled();
  });

  it("G5 round 5 item 5 (MINOR): a stdin write failure re-inserts the pending entry so the SAME requestId can be answered again", async () => {
    session.pendingToolRequests.set("req-write-fails", {
      toolName: "Bash",
      toolInput: { command: "ls" },
    });
    // Simulate a transient EPIPE on the first write only.
    session.proc.stdin.write = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("EPIPE");
      })
      .mockImplementationOnce(() => true);

    const failed = await request(app)
      .post("/api/assistant/control-response")
      .send({
        conversationId,
        requestId: "req-write-fails",
        response: { behavior: "allow", updatedInput: { command: "ls" } },
      });

    expect(failed.status).toBe(500);
    expect(session.pendingToolRequests.has("req-write-fails")).toBe(true);

    // A retry for the SAME requestId must find the entry still live, not 404.
    const retry = await request(app)
      .post("/api/assistant/control-response")
      .send({
        conversationId,
        requestId: "req-write-fails",
        response: { behavior: "allow", updatedInput: { command: "ls" } },
      });

    expect(retry.status).toBe(200);
    expect(session.proc.stdin.write).toHaveBeenCalledTimes(2);
  });
});

describe("POST /api/assistant/control-request — G5 round 4 item 2 (MAJOR): subtype allowlist", () => {
  let conversationId: string;
  let session: ClaudeSession & { proc: any };

  beforeEach(() => {
    conversationId = "conv-" + Math.random().toString(36).slice(2);
    session = makeFakeSession(conversationId);
    claudeSessions.set(conversationId, session);
  });

  it("rejects an unsupported subtype with 400 and never writes to the CLI's stdin", async () => {
    const res = await request(app)
      .post("/api/assistant/control-request")
      .send({ conversationId, request: { subtype: "some_other_subtype" } });

    expect(res.status).toBe(400);
    expect(session.proc.stdin.write).not.toHaveBeenCalled();
  });

  it("rejects the exact bypass payload (set_permission_mode -> bypassPermissions) with 400, never reaching the CLI", async () => {
    const res = await request(app)
      .post("/api/assistant/control-request")
      .send({
        conversationId,
        request: { subtype: "set_permission_mode", mode: "bypassPermissions" },
      });

    expect(res.status).toBe(400);
    expect(session.proc.stdin.write).not.toHaveBeenCalled();
  });

  it("still allows the orb's own get_context_usage subtype", async () => {
    // supertest/superagent does not actually dispatch the request until the
    // Test object is consumed (awaited or .then()'d) — kick it off now so it
    // races concurrently with the poll below instead of only starting once
    // we `await` it (which would happen after the poll already gave up).
    const donePromise = request(app)
      .post("/api/assistant/control-request")
      .send({ conversationId, request: { subtype: "get_context_usage" } })
      .then((r) => r);

    await vi.waitFor(
      () => {
        if (session.proc.stdin.write.mock.calls.length === 0) throw new Error("not written yet");
      },
      { timeout: 8000, interval: 20 },
    );
    const written = JSON.parse(session.proc.stdin.write.mock.calls[0][0] as string);
    const requestId = written.request_id as string;
    const waiter = claudeControlWaiters.get(requestId);
    expect(waiter).toBeDefined();
    waiter!.resolve({ subtype: "success", request_id: requestId, response: { percentage: 0.1 } });

    const res = await donePromise;
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  }, 15000);
});
