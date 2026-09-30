"""
DEPRECATED — the pre-T07 Claude Code CLI spawn paths, preserved verbatim.

Moved out of ``backend/assistant_routes.py`` by
``orchestration/plans/P-20260915-bcc-assistant.md`` (ticket T07), which replaced
the per-turn spawn/respawn model with the persistent session engine in
``backend/modules/assistant/claude_session.py``.

NOTHING here is wired into the running app any more. It is kept because the
project rule is "never delete, move to deprecated/", and because
``tests/test_assistant_stream_lock.py`` still pins the concurrency behaviour of
the old dispatcher (per-session stream lock, drain-on-disconnect handoff,
shared byte budget) so that history stays verifiable.

The code below is byte-for-byte the code that used to live in
``assistant_routes.py`` — including ``--dangerously-skip-permissions`` and
``--max-turns``, both of which the live path no longer uses (the flag is a
permission bypass the new policy layer replaces; ``--max-turns`` does not exist
on Claude Code CLI 2.1.261, see ``orchestration/lint/claude-help-2.1.261.txt``).
Only the import header is new.
"""

import asyncio
import json
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import Request

from backend.assistant_routes import (
    PROJECT_CWD,
    UNDERFIT_MCP_CONFIG,
    ChatRequest,
    _build_prompt,
    _claude_fallback_model,
    _resolve_claude_effort,
    _resolve_claude_mode,
    _resolve_claude_model,
    _resolve_claude_session_id,
    _sse_frame,
    _stable_audio_skill_bootstrapped_sessions,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Claude Code CLI discovery (superseded by claude_session.find_claude_cmd)
# ---------------------------------------------------------------------------
def _find_claude_cmd() -> str:
    """Auto-detect the Claude Code CLI binary from PATH or common install locations."""
    env_override = os.environ.get("CLAUDE_CODE_PATH", "").strip()
    if env_override and Path(env_override).exists():
        return env_override
    import shutil
    import sys

    candidates = ["claude.cmd", "claude"] if sys.platform == "win32" else ["claude"]
    for name in candidates:
        found = shutil.which(name)
        if found:
            return found
    if sys.platform == "win32":
        npm_path = Path(os.environ.get("APPDATA", "")) / "npm" / "claude.cmd"
        if npm_path.exists():
            return str(npm_path)
    return "claude.cmd" if __import__("sys").platform == "win32" else "claude"


CLAUDE_CMD = _find_claude_cmd()


# ---------------------------------------------------------------------------
# Old per-turn limits
# ---------------------------------------------------------------------------
KEEPALIVE_INTERVAL = 15.0
CLAUDE_MAX_TURNS = 25
CLAUDE_TIMEOUT_S = 900  # 15 minutes
CLAUDE_MAX_STDOUT_BYTES = 10_485_760  # 10 MB safety limit
CLAUDE_CRASH_WINDOW_S = 60.0
CLAUDE_CRASH_THRESHOLD = 3


# ---------------------------------------------------------------------------
# Claude Code CLI — process management for persistent/interactive modes
# ---------------------------------------------------------------------------

# Running persistent/interactive processes keyed by session_id
_claude_processes: dict[str, asyncio.subprocess.Process] = {}
_claude_process_configs: dict[str, tuple[str, str]] = {}
# Crash timestamps per session_id for backoff detection
_claude_crash_log: dict[str, list[float]] = {}

# Per-session stream lock — serializes turns so two coroutines never read the
# same process.stdout StreamReader concurrently (which raises "readuntil()
# called while another coroutine is already waiting"). A second message for the
# same session QUEUES and runs after the current turn completes.
_claude_stream_locks: dict[str, asyncio.Lock] = {}
# Detached drain tasks keyed by STABLE session id. A client disconnect reaches us
# as CancelledError (Starlette runs stream_response in a collapsing task group
# beside listen_for_disconnect and cancels it on http.disconnect) and anyio
# re-delivers that cancellation on every event-loop tick, so a turn can never
# await its own drain. _stream_claude_persistent therefore hands the turn's
# remaining stdout to a detached task registered here; _stream_claude pops the
# entry and transfers lock-release ownership to that task, so a queued turn
# cannot read stdout until the drain finishes. The entry is the exactly-once
# handoff token.
_claude_drain_tasks: dict[str, asyncio.Task] = {}
# Separate strong references so a detached drain is never garbage collected
# mid-execution: the handoff entry above is popped by the dispatcher as the
# cancellation unwinds, i.e. well before the drain completes. Tasks remove
# themselves here when they finish.
_claude_drain_task_refs: set[asyncio.Task] = set()


class _ByteBudget:
    """
    Mutable running stdout byte count for one turn.

    Shared by the live read loop, the inline drain and any detached drain so the
    CLAUDE_MAX_STDOUT_BYTES cap stays correct across handoffs. A plain int passed
    by value would reset the budget every time work moved to another coroutine
    (cancellation during the inline drain loses that drain's progress entirely),
    letting a turn read well past the cap.
    """

    __slots__ = ("total",)

    def __init__(self, total: int = 0) -> None:
        self.total = total


def _release_quietly(lock: asyncio.Lock) -> None:
    """
    Release a stream lock without ever raising.

    Called directly and from a Task done-callback, where an exception would be
    swallowed by the event loop and leak the lock forever.
    """
    try:
        lock.release()
    except RuntimeError:
        logger.warning(
            "[AssistantChat] Stream lock was already released; ignoring double release"
        )


def _claude_should_refuse_restart(session_id: str) -> bool:
    """Return True if the session has crashed >= CLAUDE_CRASH_THRESHOLD times within the window."""
    now = time.monotonic()
    timestamps = _claude_crash_log.get(session_id, [])
    # Prune old entries
    timestamps = [t for t in timestamps if now - t < CLAUDE_CRASH_WINDOW_S]
    _claude_crash_log[session_id] = timestamps
    return len(timestamps) >= CLAUDE_CRASH_THRESHOLD


def _claude_record_crash(session_id: str) -> None:
    """Record a crash timestamp for a session."""
    _claude_crash_log.setdefault(session_id, []).append(time.monotonic())


def _claude_base_cmd_args(req: ChatRequest) -> list[str]:
    """Build common CLI args shared across all Claude modes."""
    args = [
        "cmd",
        "/c",
        CLAUDE_CMD,
        "--print",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--max-turns",
        str(CLAUDE_MAX_TURNS),
        "--dangerously-skip-permissions",
    ]
    model = _resolve_claude_model(req)
    effort = _resolve_claude_effort(req)
    args.extend(["--model", model, "--effort", effort])
    fallback = _claude_fallback_model(model)
    if fallback:
        args.extend(["--fallback-model", fallback])
    # Underfit tab assistant: attach the underfit LoRA-trainer MCP (21 tools)
    # ONLY for that orb's requests, so its Claude session can drive training via
    # the dashboard API while other assistant/coding sessions stay unaffected.
    if getattr(req, "assistantProfile", None) == "underfit" and os.path.isfile(
        UNDERFIT_MCP_CONFIG
    ):
        args.extend(["--mcp-config", UNDERFIT_MCP_CONFIG])
    return args


async def _terminate_claude_process(process: asyncio.subprocess.Process) -> None:
    """Gracefully terminate a Claude CLI process."""
    if process.returncode is not None:
        return
    try:
        process.terminate()
        await asyncio.wait_for(process.wait(), timeout=5.0)
    except (asyncio.TimeoutError, ProcessLookupError):
        try:
            process.kill()
        except ProcessLookupError:
            pass


async def _claude_exit_detail(process: asyncio.subprocess.Process) -> str:
    """Return a concise Claude CLI exit detail without blocking the stream forever."""
    try:
        await asyncio.wait_for(process.wait(), timeout=2.0)
    except asyncio.TimeoutError:
        return "Claude Code closed stdout but the process did not exit within 2s."

    stderr_output = ""
    if process.stderr is not None:
        try:
            stderr_bytes = await asyncio.wait_for(process.stderr.read(), timeout=1.0)
            stderr_output = stderr_bytes.decode("utf-8", errors="replace").strip()
        except asyncio.TimeoutError:
            stderr_output = "stderr read timed out"

    detail = f"Claude Code exited with code {process.returncode}."
    if stderr_output:
        detail += f" stderr: {stderr_output[:1000]}"
    return detail


def _parse_claude_event(data: dict) -> list[dict]:
    """
    Parse a stream-json event from Claude CLI into SSE frames.

    Returns a list of SSE-ready dicts (may be empty).
    """
    frames: list[dict] = []
    msg_type = data.get("type", "")

    if msg_type == "stream_event" and isinstance(data.get("event"), dict):
        return _parse_claude_event(data["event"])

    if msg_type == "assistant":
        # Full/partial assistant message — text was already streamed via
        # content_block_delta, so only extract tool_use blocks here to
        # avoid doubling the displayed text.
        message = data.get("message", data)
        content_blocks = message.get("content", data.get("content", []))
        for block in content_blocks:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use":
                frames.append(
                    {
                        "type": "function_call",
                        "name": block.get("name", ""),
                        "id": block.get("id", ""),
                        "input": block.get("input", {}),
                    }
                )

    elif msg_type == "content_block_delta":
        delta = data.get("delta", {})
        if delta.get("type") == "text_delta":
            text = delta.get("text", "")
            if text:
                frames.append({"type": "text_delta", "delta": text})

    elif msg_type == "tool_result":
        frames.append(
            {
                "type": "function_result",
                "tool_use_id": data.get("tool_use_id", ""),
                "content": data.get("content", ""),
            }
        )

    elif msg_type == "system":
        subtype = data.get("subtype", "")
        if subtype == "init":
            session_id = data.get("session_id", "")
            tools = data.get("tools") or []
            mcp_servers = data.get("mcp_servers") or []
            detail = []
            if tools:
                detail.append(f"{len(tools)} tools")
            if mcp_servers:
                detail.append(f"{len(mcp_servers)} MCP servers")
            if session_id:
                frames.append(
                    {
                        "type": "status",
                        "message": "Claude Code session initialized"
                        + (f" ({', '.join(detail)})" if detail else ""),
                        "session_id": session_id,
                    }
                )

    elif msg_type == "result":
        usage = data.get("usage", {})
        session_id = data.get("session_id", "")
        done_frame: dict = {
            "type": "done",
            "usage": {
                "prompt_tokens": usage.get("input_tokens", 0),
                "completion_tokens": usage.get("output_tokens", 0),
            },
        }
        if session_id:
            done_frame["session_id"] = session_id
        frames.append(done_frame)

    return frames


# ---------------------------------------------------------------------------
# Claude Code CLI — oneshot & resume modes (spawn-per-message)
# ---------------------------------------------------------------------------


async def _stream_claude_spawn(req: ChatRequest, request: Request):
    """
    Stream Claude Code CLI for oneshot and resume modes.

    Spawns a new process per message. For resume mode, passes --resume or
    --session-id to maintain conversation continuity. Prompt is piped via
    stdin (not as a CLI argument) to avoid shell escaping issues.
    """
    mode = _resolve_claude_mode(req)
    model = _resolve_claude_model(req)
    effort = _resolve_claude_effort(req)
    session_id = req.claudeSessionId or req.conversationId

    cmd_args = _claude_base_cmd_args(req)

    if mode == "resume":
        if session_id:
            cmd_args.extend(["--resume", session_id])
        else:
            session_id = str(uuid.uuid4())
            cmd_args.extend(["--session-id", session_id])
            yield _sse_frame(
                {
                    "type": "status",
                    "message": f"new Claude Code session: {session_id}",
                    "session_id": session_id,
                }
            )

    prompt = _build_prompt(req.messages, req.staged_attachments or [])
    if not prompt:
        yield _sse_frame(
            {"type": "error", "error": "No prompt content found in messages"}
        )
        return

    yield _sse_frame(
        {
            "type": "status",
            "message": f"thinking ({mode}, model={model}, effort={effort})...",
        }
    )

    process = None
    try:
        process = await asyncio.create_subprocess_exec(
            *cmd_args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=10
            * 1024
            * 1024,  # 10 MB — avoids ValueError on long Claude JSON lines
            cwd=PROJECT_CWD,
        )

        if process.stdout is None:
            yield _sse_frame(
                {"type": "error", "error": "Failed to capture Claude CLI stdout"}
            )
            return

        # Pipe prompt via stdin and close
        if process.stdin is not None:
            process.stdin.write(prompt.encode("utf-8"))
            process.stdin.close()
            if req.skill_bootstrap_session_id:
                _stable_audio_skill_bootstrapped_sessions.add(
                    req.skill_bootstrap_session_id
                )

        last_keepalive = time.monotonic()
        start_time = time.monotonic()
        total_bytes_read = 0

        while True:
            # Check client disconnect
            if await request.is_disconnected():
                logger.info(
                    "[AssistantChat] Client disconnected, terminating Claude process"
                )
                await _terminate_claude_process(process)
                return

            # Check timeout
            elapsed = time.monotonic() - start_time
            if elapsed > CLAUDE_TIMEOUT_S:
                logger.warning(
                    "[AssistantChat] Claude stream timed out after %ds", int(elapsed)
                )
                yield _sse_frame(
                    {
                        "type": "error",
                        "error": f"Claude stream timed out after {int(elapsed)}s",
                    }
                )
                await _terminate_claude_process(process)
                break

            # Read a line with timeout for keepalive
            try:
                line_bytes = await asyncio.wait_for(
                    process.stdout.readline(),
                    timeout=KEEPALIVE_INTERVAL,
                )
            except asyncio.TimeoutError:
                yield ": ping\n\n"
                last_keepalive = time.monotonic()
                continue

            if not line_bytes:
                break  # EOF

            total_bytes_read += len(line_bytes)
            if total_bytes_read > CLAUDE_MAX_STDOUT_BYTES:
                logger.warning(
                    "[AssistantChat] Claude stdout exceeded %d bytes, terminating",
                    CLAUDE_MAX_STDOUT_BYTES,
                )
                yield _sse_frame(
                    {
                        "type": "error",
                        "error": "Claude output exceeded 10MB safety limit",
                    }
                )
                await _terminate_claude_process(process)
                break

            line = line_bytes.decode("utf-8", errors="replace").strip()
            if not line:
                continue

            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                logger.debug(
                    "[AssistantChat] Non-JSON line from Claude CLI: %s", line[:200]
                )
                continue

            # Parse and emit SSE frames
            for frame in _parse_claude_event(data):
                yield _sse_frame(frame)
                if frame.get("type") == "done":
                    return

            # Keepalive
            now = time.monotonic()
            if now - last_keepalive > KEEPALIVE_INTERVAL:
                yield ": ping\n\n"
                last_keepalive = now

        # Process ended without a result event
        await process.wait()

        stderr_output = ""
        if process.stderr:
            stderr_bytes = await process.stderr.read()
            stderr_output = stderr_bytes.decode("utf-8", errors="replace").strip()

        if process.returncode != 0 and stderr_output:
            logger.error(
                "[AssistantChat] Claude CLI exited with code %d: %s",
                process.returncode,
                stderr_output[:500],
            )
            yield _sse_frame(
                {"type": "error", "error": f"Claude CLI error: {stderr_output[:500]}"}
            )
            return

        done_frame: dict = {
            "type": "done",
            "usage": {"prompt_tokens": 0, "completion_tokens": 0},
        }
        if session_id:
            done_frame["session_id"] = session_id
        yield _sse_frame(done_frame)

    except asyncio.CancelledError:
        logger.info("[AssistantChat] Claude spawn stream cancelled")
        if process and process.returncode is None:
            await _terminate_claude_process(process)
        raise

    except Exception as exc:
        logger.exception("[AssistantChat] Error in Claude spawn stream")
        yield _sse_frame({"type": "error", "error": str(exc)})
        yield _sse_frame(
            {"type": "done", "usage": {"prompt_tokens": 0, "completion_tokens": 0}}
        )

    finally:
        if process and process.returncode is None:
            await _terminate_claude_process(process)


# ---------------------------------------------------------------------------
# Claude Code CLI — persistent & interactive modes (long-lived process)
# ---------------------------------------------------------------------------


async def _drain_claude_turn(
    process: asyncio.subprocess.Process,
    session_id: str,
    start_time: float,
    budget: _ByteBudget,
) -> None:
    """
    Consume and discard a persistent turn's remaining stdout after the client
    disconnected mid-turn.

    Reads with the same keepalive/timeout/EOF/byte-cap rules as the live loop
    but yields nothing, so the next QUEUED turn never reads this turn's leftover
    frames. Returns when the turn's ``result``/``done`` event is seen (process
    kept alive for the next message) or a terminal condition triggers
    (timeout/EOF/byte cap — the dead or stuck process is cleaned up so the next
    turn respawns).
    """
    if process.stdout is None:
        return

    while True:
        # Honor the same wall-clock timeout as the live loop.
        elapsed = time.monotonic() - start_time
        if elapsed > CLAUDE_TIMEOUT_S:
            logger.warning(
                "[AssistantChat] Drain after disconnect timed out after %ds "
                "(session=%s); killing stuck process",
                int(elapsed),
                session_id,
            )
            await _terminate_claude_process(process)
            _claude_processes.pop(session_id, None)
            _claude_process_configs.pop(session_id, None)
            _stable_audio_skill_bootstrapped_sessions.discard(session_id)
            _claude_record_crash(session_id)
            return

        try:
            line_bytes = await asyncio.wait_for(
                process.stdout.readline(),
                timeout=KEEPALIVE_INTERVAL,
            )
        except asyncio.TimeoutError:
            continue

        if not line_bytes:
            # EOF — process died mid-turn; clean up so the next turn respawns.
            detail = await _claude_exit_detail(process)
            logger.warning(
                "[AssistantChat] Claude persistent process EOF while draining "
                "after disconnect (session=%s): %s",
                session_id,
                detail,
            )
            _claude_record_crash(session_id)
            _claude_processes.pop(session_id, None)
            _claude_process_configs.pop(session_id, None)
            _stable_audio_skill_bootstrapped_sessions.discard(session_id)
            return

        budget.total += len(line_bytes)
        if budget.total > CLAUDE_MAX_STDOUT_BYTES:
            logger.warning(
                "[AssistantChat] Claude persistent stdout exceeded %d bytes "
                "while draining after disconnect (session=%s)",
                CLAUDE_MAX_STDOUT_BYTES,
                session_id,
            )
            await _terminate_claude_process(process)
            _claude_processes.pop(session_id, None)
            _claude_process_configs.pop(session_id, None)
            _stable_audio_skill_bootstrapped_sessions.discard(session_id)
            return

        line = line_bytes.decode("utf-8", errors="replace").strip()
        if not line:
            continue

        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue

        # Discard the frames, but watch for this turn's completion so we stop
        # draining and leave the process alive for the next message.
        if any(frame.get("type") == "done" for frame in _parse_claude_event(data)):
            logger.info(
                "[AssistantChat] Drained turn to completion after disconnect "
                "(session=%s); process kept alive for next message",
                session_id,
            )
            return


async def _drain_claude_turn_detached(
    process: asyncio.subprocess.Process,
    session_id: str,
    start_time: float,
    budget: _ByteBudget,
) -> None:
    """
    Detached-task wrapper around :func:`_drain_claude_turn` that never raises.

    Runs OUTSIDE the request's cancel scope, because Starlette cancels the
    request task on disconnect and anyio re-delivers that cancellation on every
    event-loop tick — an awaited drain inside the request makes zero progress.
    The dispatcher transfers lock-release ownership to this task via a done
    callback, so the task must always reach "done": every exception is logged and
    swallowed, including CancelledError at loop shutdown. The drain itself stays
    bounded by CLAUDE_TIMEOUT_S / EOF / the byte cap, so it always terminates.
    """
    try:
        await _drain_claude_turn(process, session_id, start_time, budget)
    except asyncio.CancelledError:
        logger.info(
            "[AssistantChat] Detached drain cancelled before completing (session=%s)",
            session_id,
        )
    except Exception:
        logger.exception(
            "[AssistantChat] Detached drain failed (session=%s)", session_id
        )


def _handoff_claude_drain(
    req: ChatRequest,
    process: Optional[asyncio.subprocess.Process],
    session_id: str,
    start_time: float,
    budget: _ByteBudget,
    turn_completed: bool,
    trigger: str,
) -> None:
    """
    Hand an abandoned turn's remaining stdout to a detached drain task.

    FULLY SYNCHRONOUS on purpose: it is called from both the ``CancelledError``
    and the ``GeneratorExit`` paths of :func:`_stream_claude_persistent`, and
    awaiting in either is impossible (anyio re-cancels every tick) or illegal
    (an async generator may not yield/await while closing). :func:`_stream_claude`
    pops the registered entry in its ``finally`` and transfers lock-release
    ownership to the task, so a queued turn cannot read stdout until it finishes.

    No-ops unless a drain is actually needed and safe:
      * the turn already reached ``done`` — nothing left to read;
      * no stable id — an anonymous session shares nothing with a later request
        (this also keeps _claude_drain_tasks keyed like _claude_stream_locks);
      * process gone/exited, or stdout already at EOF;
      * the registered process for this session is no longer THIS process —
        another coroutine already cleaned up or respawned it, so draining would
        record a duplicate crash and re-pop someone else's entry.
    """
    if turn_completed:
        return

    drain_key = req.claudeSessionId or req.conversationId
    if not drain_key:
        return

    if (
        process is None
        or process.returncode is not None
        or process.stdout is None
        or process.stdout.at_eof()
        or _claude_processes.get(session_id) is not process
    ):
        return

    coro = _drain_claude_turn_detached(process, session_id, start_time, budget)
    try:
        drain_task = asyncio.create_task(coro)
    except RuntimeError:
        # Loop is closing — no drain is possible. Do NOT register, so the
        # dispatcher releases the lock normally instead of leaking it.
        coro.close()  # never-awaited coroutine would warn otherwise
        logger.warning(
            "[AssistantChat] Could not start detached drain after %s (session=%s)",
            trigger,
            session_id,
        )
        return

    logger.info(
        "[AssistantChat] Handed turn stdout to detached drain after %s (session=%s)",
        trigger,
        session_id,
    )
    _claude_drain_tasks[drain_key] = drain_task
    # Anchor a strong reference until the task finishes; the handoff entry above
    # is popped by the dispatcher as this turn unwinds, well before the drain
    # completes.
    _claude_drain_task_refs.add(drain_task)
    drain_task.add_done_callback(_claude_drain_task_refs.discard)


async def _stream_claude_persistent(req: ChatRequest, request: Request):
    """
    Stream Claude Code CLI for persistent and interactive modes.

    Keeps a single process alive across multiple messages. Messages are
    sent as JSON lines to stdin. The process stays running between requests.
    """
    mode = _resolve_claude_mode(req)
    session_id = _resolve_claude_session_id(req)

    # Check crash backoff
    if _claude_should_refuse_restart(session_id):
        yield _sse_frame(
            {
                "type": "error",
                "error": f"Session {session_id} crashed {CLAUDE_CRASH_THRESHOLD}+ times "
                f"in {int(CLAUDE_CRASH_WINDOW_S)}s. Refusing restart. "
                "Try a new session or switch to oneshot mode.",
            }
        )
        yield _sse_frame(
            {"type": "done", "usage": {"prompt_tokens": 0, "completion_tokens": 0}}
        )
        return

    # Get or create persistent process
    process = _claude_processes.get(session_id)
    desired_model = _resolve_claude_model(req)
    desired_effort = _resolve_claude_effort(req)
    desired_config = (desired_model, desired_effort)

    if process is not None and process.returncode is None:
        current_config = _claude_process_configs.get(session_id)
        if current_config != desired_config:
            yield _sse_frame(
                {
                    "type": "status",
                    "message": f"restarting Claude Code for model={desired_model}, effort={desired_effort}",
                    "session_id": session_id,
                }
            )
            await _terminate_claude_process(process)
            _claude_processes.pop(session_id, None)
            _claude_process_configs.pop(session_id, None)
            _stable_audio_skill_bootstrapped_sessions.discard(session_id)
            process = None

    if process is None or process.returncode is not None:
        # Need a new process
        if process is not None and process.returncode is not None:
            logger.info(
                "[AssistantChat] Claude persistent process for %s died (rc=%d), respawning",
                session_id,
                process.returncode,
            )
            _claude_record_crash(session_id)
            _claude_processes.pop(session_id, None)
            _claude_process_configs.pop(session_id, None)
            _stable_audio_skill_bootstrapped_sessions.discard(session_id)

        cmd_args = [
            "cmd",
            "/c",
            CLAUDE_CMD,
            "--print",
            "--output-format",
            "stream-json",
            "--include-partial-messages",
            "--input-format",
            "stream-json",
            "--max-turns",
            str(CLAUDE_MAX_TURNS),
            "--dangerously-skip-permissions",
            "--verbose",
        ]
        if req.claude_resume_existing:
            cmd_args.extend(["--resume", session_id])
        else:
            cmd_args.extend(["--session-id", session_id])
        # Both app-facing "interactive" and "persistent" modes use Claude Code's
        # supported programmatic stream-json path. A true TTY interactive session
        # cannot be driven safely through browser SSE, but this keeps one Claude
        # Code process alive with MCPs/skills/agents loaded and stdin open.

        model = desired_model
        effort = desired_effort
        if model:
            cmd_args.extend(["--model", model, "--effort", effort])
            fb = _claude_fallback_model(model)
            if fb:
                cmd_args.extend(["--fallback-model", fb])

        process = await asyncio.create_subprocess_exec(
            *cmd_args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=10
            * 1024
            * 1024,  # 10 MB — avoids ValueError on long Claude JSON lines
            cwd=PROJECT_CWD,
        )
        _claude_processes[session_id] = process
        _claude_process_configs[session_id] = desired_config

        yield _sse_frame(
            {
                "type": "status",
                "message": f"{'resumed' if req.claude_resume_existing else 'spawned'} {mode} process (model={model}, effort={effort}, session={session_id})",
                "session_id": session_id,
            }
        )

    if process.stdout is None or process.stdin is None:
        yield _sse_frame(
            {"type": "error", "error": "Failed to capture Claude CLI stdio"}
        )
        return

    # Build and send the user message as a JSON line
    prompt = _build_prompt(req.messages, req.staged_attachments or [])
    if not prompt:
        yield _sse_frame(
            {"type": "error", "error": "No prompt content found in messages"}
        )
        return

    user_payload = {
        "type": "user",
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": prompt}],
        },
    }
    message_line = json.dumps(user_payload) + "\n"

    try:
        process.stdin.write(message_line.encode("utf-8"))
        await process.stdin.drain()
        if req.skill_bootstrap_session_id:
            _stable_audio_skill_bootstrapped_sessions.add(
                req.skill_bootstrap_session_id
            )
    except (BrokenPipeError, ConnectionResetError, OSError) as exc:
        logger.error(
            "[AssistantChat] Failed to write to Claude persistent stdin: %s", exc
        )
        _claude_record_crash(session_id)
        _claude_processes.pop(session_id, None)
        _claude_process_configs.pop(session_id, None)
        yield _sse_frame(
            {"type": "error", "error": f"Claude process stdin broken: {exc}"}
        )
        yield _sse_frame(
            {
                "type": "done",
                "usage": {"prompt_tokens": 0, "completion_tokens": 0},
                "session_id": session_id,
            }
        )
        return

    # Turn state is initialized BEFORE the try below so that every yield after
    # the prompt was written to stdin — including the "thinking..." status — is
    # covered by the GeneratorExit/CancelledError handoff handlers. A close or
    # disconnect landing on that status yield would otherwise abandon a turn whose
    # prompt Claude has already received, leaving its frames unread and offsetting
    # every later turn in the session by one.
    start_time = time.monotonic()
    last_keepalive = time.monotonic()
    # Mutable so inline/detached drains share one running total (see _ByteBudget).
    budget = _ByteBudget()
    # True once this turn's `result`/`done` has been seen, i.e. nothing is left to
    # drain. Initialized here so the handoff handlers always see a bound value;
    # set to True (before the `done` frame is yielded) at the two sites in the loop.
    turn_completed = False

    model = desired_model
    effort = desired_effort

    try:
        yield _sse_frame(
            {
                "type": "status",
                "message": f"thinking ({mode}, model={model}, effort={effort})...",
            }
        )

        # Read stdout lines until we get a result event for this turn
        while True:
            # Check client disconnect
            if await request.is_disconnected():
                logger.info(
                    "[AssistantChat] Client disconnected during persistent "
                    "stream (session=%s); draining turn before returning",
                    session_id,
                )
                # Don't kill the process — it stays alive for future messages.
                # But we MUST consume this turn's stdout to completion first;
                # otherwise the next QUEUED turn would read this abandoned
                # turn's leftover frames and mis-detect its own `done`.
                await _drain_claude_turn(process, session_id, start_time, budget)
                return

            # Check timeout
            elapsed = time.monotonic() - start_time
            if elapsed > CLAUDE_TIMEOUT_S:
                logger.warning(
                    "[AssistantChat] Claude persistent stream timed out after %ds",
                    int(elapsed),
                )
                yield _sse_frame(
                    {
                        "type": "error",
                        "error": f"Claude stream timed out after {int(elapsed)}s",
                    }
                )
                # Kill the process on timeout — it's stuck
                await _terminate_claude_process(process)
                _claude_processes.pop(session_id, None)
                _claude_process_configs.pop(session_id, None)
                _stable_audio_skill_bootstrapped_sessions.discard(session_id)
                _claude_record_crash(session_id)
                break

            # Read with keepalive timeout
            try:
                line_bytes = await asyncio.wait_for(
                    process.stdout.readline(),
                    timeout=KEEPALIVE_INTERVAL,
                )
            except asyncio.TimeoutError:
                yield ": ping\n\n"
                last_keepalive = time.monotonic()
                continue

            if not line_bytes:
                # EOF — process died
                detail = await _claude_exit_detail(process)
                logger.warning(
                    "[AssistantChat] Claude persistent process EOF (session=%s): %s",
                    session_id,
                    detail,
                )
                _claude_record_crash(session_id)
                _claude_processes.pop(session_id, None)
                _claude_process_configs.pop(session_id, None)
                _stable_audio_skill_bootstrapped_sessions.discard(session_id)
                yield _sse_frame({"type": "error", "error": detail})
                break

            budget.total += len(line_bytes)
            if budget.total > CLAUDE_MAX_STDOUT_BYTES:
                logger.warning(
                    "[AssistantChat] Claude persistent stdout exceeded %d bytes",
                    CLAUDE_MAX_STDOUT_BYTES,
                )
                yield _sse_frame(
                    {
                        "type": "error",
                        "error": "Claude output exceeded 10MB safety limit",
                    }
                )
                await _terminate_claude_process(process)
                _claude_processes.pop(session_id, None)
                _claude_process_configs.pop(session_id, None)
                _stable_audio_skill_bootstrapped_sessions.discard(session_id)
                break

            line = line_bytes.decode("utf-8", errors="replace").strip()
            if not line:
                continue

            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                logger.debug(
                    "[AssistantChat] Non-JSON line from Claude persistent: %s",
                    line[:200],
                )
                continue

            # Parse and emit SSE frames. Mark the turn complete BEFORE yielding
            # so a GeneratorExit at that yield does not trigger a pointless drain.
            parsed_frames = _parse_claude_event(data)
            if any(frame.get("type") == "done" for frame in parsed_frames):
                turn_completed = True
            for frame in parsed_frames:
                yield _sse_frame(frame)
                if frame.get("type") == "done":
                    # Turn complete — process stays alive for next message
                    return

            # Keepalive
            now = time.monotonic()
            if now - last_keepalive > KEEPALIVE_INTERVAL:
                yield ": ping\n\n"
                last_keepalive = now

        # Fell through without a result event (EOF/timeout/byte cap already
        # handled the process). Nothing is left worth draining.
        turn_completed = True
        yield _sse_frame(
            {
                "type": "done",
                "usage": {"prompt_tokens": 0, "completion_tokens": 0},
                "session_id": session_id,
            }
        )

    except GeneratorExit:
        # The consumer closed us (aclose, or GC of the response generator) while
        # we were suspended at a yield. Starlette's collapsing task group cancels
        # stream_response at WHATEVER await it is on — if that is `await send(...)`
        # on a full or stalled socket rather than our readline(), CancelledError is
        # raised in ITS frame, not ours, and we are finalized later via
        # GeneratorExit. That does not reach the CancelledError handler below, so
        # without this branch no drain is created and the dispatcher releases the
        # lock with this turn's stdout unread.
        logger.info(
            "[AssistantChat] Claude persistent stream closed (session=%s)",
            session_id,
        )
        _handoff_claude_drain(
            req, process, session_id, start_time, budget, turn_completed, "close"
        )
        raise

    except asyncio.CancelledError:
        logger.info(
            "[AssistantChat] Claude persistent stream cancelled (session=%s)",
            session_id,
        )
        # Don't kill the process on cancel — it persists.
        #
        # This is the DOMINANT disconnect path in production: Starlette cancels
        # stream_response when http.disconnect arrives, so we land here rather
        # than in the polled is_disconnected() branch. anyio re-delivers that
        # cancellation every event-loop tick, so we cannot await the drain here —
        # do SYNCHRONOUS work only and hand the rest of this turn's stdout to a
        # detached task. _stream_claude transfers lock-release ownership to it so
        # the next queued turn cannot read stdout until the drain finishes.
        #
        _handoff_claude_drain(
            req, process, session_id, start_time, budget, turn_completed, "cancellation"
        )
        raise

    except Exception as exc:
        logger.exception(
            "[AssistantChat] Error in Claude persistent stream (session=%s)", session_id
        )
        _claude_record_crash(session_id)
        _claude_processes.pop(session_id, None)
        _claude_process_configs.pop(session_id, None)
        _stable_audio_skill_bootstrapped_sessions.discard(session_id)
        yield _sse_frame({"type": "error", "error": str(exc)})
        yield _sse_frame(
            {
                "type": "done",
                "usage": {"prompt_tokens": 0, "completion_tokens": 0},
                "session_id": session_id,
            }
        )


# ---------------------------------------------------------------------------
# Claude Code CLI — dispatcher
# ---------------------------------------------------------------------------


async def _stream_claude(req: ChatRequest, request: Request):
    """Dispatch to the appropriate Claude streaming strategy."""
    mode = _resolve_claude_mode(req)

    if mode in ("oneshot", "resume"):
        async for frame in _stream_claude_spawn(req, request):
            yield frame
    elif mode in ("persistent", "interactive"):
        # Serialize turns for one session ONLY on a stable id. The uuid fallback
        # in _resolve_claude_session_id() is not idempotent, so keying on it
        # would give every anonymous request a throwaway lock and leak one Lock
        # per request. When neither id is present nothing is shared across
        # requests (each such call spawns/uses its own process keyed the same
        # way downstream), so we run WITHOUT a lock and never insert into
        # _claude_stream_locks.
        #
        # In practice the /chat entrypoint always assigns req.conversationId
        # before routing here, so the no-lock branch is unreachable from HTTP and
        # remains a defensive guard for direct/internal callers.
        #
        # Locks are intentionally NEVER evicted: popping one while a queued
        # waiter still references the old Lock object would let the next request
        # create a second Lock for the same session and destroy serialization.
        # Growth is one Lock per conversation for the process lifetime, bounded
        # the same way _claude_processes already is — accepted residual.
        stable_id = req.claudeSessionId or req.conversationId
        if not stable_id:
            async for frame in _stream_claude_persistent(req, request):
                yield frame
            return

        # Queue overlapping messages for the same session: the second request
        # awaits this lock and runs after the current turn finishes, so only one
        # coroutine ever reads the process's stdout at a time.
        lock = _claude_stream_locks.setdefault(stable_id, asyncio.Lock())

        # If a turn is already in flight, tell the client it is queued and keep
        # the SSE connection warm with pings while we wait for the lock.
        if lock.locked():
            yield _sse_frame(
                {"type": "status", "message": "queued behind the current turn"}
            )
        while True:
            try:
                await asyncio.wait_for(lock.acquire(), timeout=KEEPALIVE_INTERVAL)
                break
            except asyncio.TimeoutError:
                # Still waiting for the current turn. Abandon quietly if the
                # client has gone away; otherwise ping and retry. On 3.12 a
                # wait_for timeout cancels the pending acquire() without leaving
                # the lock acquired, so this loop never leaks the lock.
                if await request.is_disconnected():
                    return
                yield ": ping\n\n"

        # Explicit acquire/release (not `async with`) so the lock is released on
        # GeneratorExit (consumer aclose), CancelledError, and any exception
        # raised by the inner generator.
        inner_stream = _stream_claude_persistent(req, request)
        try:
            async for frame in inner_stream:
                yield frame
        finally:
            # Finalize the inner generator BEFORE consuming the handoff below.
            # On the aclose path CPython runs THIS finally first and finalizes the
            # inner generator only later (at GC), so without this its GeneratorExit
            # handoff would register an orphan entry AFTER we popped — releasing
            # the lock with the turn's stdout still unread, and leaving an entry
            # that would wrongly defer a LATER request's release. Awaiting during
            # GeneratorExit propagation is legal for an async generator (only
            # yielding is not). Errors here must never skip the release.
            try:
                await inner_stream.aclose()
            except (Exception, asyncio.CancelledError):
                logger.debug(
                    "[AssistantChat] Error closing persistent stream (session=%s)",
                    stable_id,
                    exc_info=True,
                )

            # If this turn was abandoned mid-read (client disconnect), it handed
            # its remaining stdout to a detached drain task. Transfer release
            # ownership to that task so the next QUEUED turn cannot start reading
            # until the drain has finished — releasing here would reintroduce the
            # concurrent-reader RuntimeError this lock exists to prevent.
            #
            # Exactly-once: this request held the lock, so no other request for
            # this session could have been inside the persistent generator; any
            # entry present now belongs to THIS request, and pop() consumes it.
            drain_task = _claude_drain_tasks.pop(stable_id, None)
            if drain_task is not None and not drain_task.done():
                drain_task.add_done_callback(
                    lambda _task, _lock=lock: _release_quietly(_lock)
                )
            else:
                _release_quietly(lock)
    else:
        yield _sse_frame({"type": "error", "error": f"Unknown claudeMode: {mode}"})
        yield _sse_frame(
            {"type": "done", "usage": {"prompt_tokens": 0, "completion_tokens": 0}}
        )
