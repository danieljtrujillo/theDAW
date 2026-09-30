"""
Tests for the persistent Claude Code session engine.

``backend/modules/assistant/claude_session.py`` keeps ONE ``claude`` child per
conversation with stdin held open, so every turn after the first reuses the
same process (and the same MCP children). These tests drive that engine against
``tests/fixtures/fake_claude_cli.py`` — a real subprocess speaking the real
NDJSON stream-json protocol — so the spawn/stdin/stdout/interrupt paths are
exercised for real; only the argv that selects the binary is monkeypatched.

Async behavior is driven with ``asyncio.run`` inside plain pytest functions so
the suite needs no pytest-asyncio / anyio plugin configuration (same convention
as ``tests/test_assistant_stream_lock.py``).
"""

import asyncio
import json
import logging
import os
import signal
import subprocess
import sys
from pathlib import Path

import pytest

from backend.modules.assistant import claude_session as cs

FAKE_CLI = Path(__file__).parent / "fixtures" / "fake_claude_cli.py"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def use_fake_cli(monkeypatch, mode: str, log_path: Path | None = None) -> None:
    """Point the engine's spawn at the scripted fake CLI."""
    monkeypatch.setenv("FAKE_CLI_MODE", mode)
    if log_path is not None:
        monkeypatch.setenv("FAKE_CLI_LOG", str(log_path))
    else:
        monkeypatch.delenv("FAKE_CLI_LOG", raising=False)
    monkeypatch.setattr(
        cs,
        "build_spawn_argv",
        lambda base_args: [sys.executable, "-u", str(FAKE_CLI)],
    )


def run(body) -> None:
    """Run an async test body, always tearing every session down afterwards."""

    async def wrapper():
        try:
            await body()
        finally:
            await cs.kill_all()

    asyncio.run(wrapper())


def frames(lines: list[str]) -> list[dict]:
    """Decode the ``data:`` SSE lines of a turn into frame dicts."""
    out = []
    for line in lines:
        if line.startswith("data: "):
            out.append(json.loads(line[len("data: ") :].strip()))
    return out


def types(lines: list[str]) -> list[str]:
    return [frame["type"] for frame in frames(lines)]


async def run_turn(conversation_id: str, text: str, **kwargs) -> list[str]:
    """Drive one full turn to completion and return its raw SSE lines."""
    lines: list[str] = []
    agen = cs.stream_turn(
        conversation_id,
        prompt_ndjson_line=cs.build_user_ndjson_line(text),
        model=kwargs.pop("model", "claude-test"),
        effort=kwargs.pop("effort", "high"),
        permission_mode=kwargs.pop("permission_mode", "ask"),
        port=kwargs.pop("port", 0),
        **kwargs,
    )
    async for line in agen:
        lines.append(line)
    return lines


async def wait_for_frame(lines: list[str], frame_type: str, timeout: float = 20.0):
    """Poll a growing SSE line list until a frame of ``frame_type`` shows up."""
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        for frame in frames(list(lines)):
            if frame["type"] == frame_type:
                return frame
        await asyncio.sleep(0.02)
    raise AssertionError(f"no {frame_type!r} frame within {timeout}s: {lines}")


def log_payloads(log_path: Path) -> list[dict]:
    if not log_path.exists():
        return []
    out = []
    for line in log_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


# ---------------------------------------------------------------------------
# Spawn arguments (contract C5)
# ---------------------------------------------------------------------------
def test_build_base_args_omits_skip_permissions_and_max_turns():
    args = cs.build_base_args("claude-test", "high", "ask")
    assert "--dangerously-skip-permissions" not in args
    assert "--max-turns" not in args


def test_build_base_args_includes_every_c5_flag_in_order():
    args = cs.build_base_args("claude-test", "high", "ask")
    assert args[:4] == ["--model", "claude-test", "--effort", "high"]
    expected_tail = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-prompt-tool",
        "stdio",
        "--permission-prompts",
        "host",
        "--permission-mode",
        "default",
        "--setting-sources",
        "project,local",
        "--allowedTools",
        *cs.ALLOWED_TOOLS,
    ]
    assert args[4:] == expected_tail


def test_build_base_args_drops_the_user_settings_source():
    # The user's ~/.claude/settings.json sets permissions.defaultMode =
    # bypassPermissions (plus ~290 Bash allow rules). The CLI applies USER-level
    # settings BEFORE consulting the host permission prompt, so in Ask mode a
    # Bash call ran with NO control_request while mcp__thedaw__* still bubbled.
    # Dropping the `user` source makes the app-side policy authoritative.
    args = cs.build_base_args("m", "high", "ask")
    assert "--setting-sources" in args
    sources = args[args.index("--setting-sources") + 1]
    assert sources == "project,local"
    assert "user" not in sources.split(",")
    # project/local stay, so repo-scoped settings still apply.
    assert sources.split(",") == ["project", "local"]


@pytest.mark.parametrize("mode", ["ask", "accept_edits", "readonly", "trusted"])
def test_user_settings_source_is_dropped_in_every_permission_mode(mode):
    args = cs.build_base_args("m", "high", mode)
    assert args[args.index("--setting-sources") + 1] == "project,local"


def test_build_base_args_includes_fallback_model_only_when_given():
    assert "--fallback-model" not in cs.build_base_args("m", "high", "ask")
    args = cs.build_base_args("m", "high", "ask", fallback_model="m2")
    assert args[4:6] == ["--fallback-model", "m2"]


@pytest.mark.parametrize(
    "mode,cli_mode",
    [
        # G5 audit item 1 (CRITICAL): every mode maps to the CLI's "default"
        # -- never acceptEdits/bypassPermissions, which make the CLI
        # auto-approve tools itself with no control_request, bypassing
        # decide() (and its self-modify rule) entirely.
        ("ask", "default"),
        ("accept_edits", "default"),
        ("readonly", "default"),
        ("trusted", "default"),
    ],
)
def test_build_base_args_maps_permission_mode(mode, cli_mode):
    args = cs.build_base_args("m", "high", mode)
    assert args[args.index("--permission-mode") + 1] == cli_mode


def test_build_base_args_rejects_unknown_effort():
    args = cs.build_base_args("m", "bogus", "ask")
    assert args[2:4] == ["--effort", cs.DEFAULT_EFFORT]


# ---------------------------------------------------------------------------
# Per-session MCP config
# ---------------------------------------------------------------------------
def test_write_mcp_config_registers_thedaw_relay_server(tmp_path):
    path = tmp_path / "mcp.json"
    assert cs.write_mcp_config("relay-1", str(path), port=8600, extra_servers={})
    config = json.loads(path.read_text(encoding="utf-8"))
    thedaw = config["mcpServers"]["thedaw"]
    assert thedaw["command"] == sys.executable
    assert thedaw["args"][0].endswith("thedaw_mcp_server.py")
    assert thedaw["args"][1:] == ["8600", "relay-1"]


def test_write_mcp_config_merges_extra_servers(tmp_path):
    path = tmp_path / "mcp.json"
    extra = {"underfit": {"command": "node", "args": ["x.cjs"]}}
    assert cs.write_mcp_config("relay-2", str(path), port=1, extra_servers=extra)
    config = json.loads(path.read_text(encoding="utf-8"))
    assert set(config["mcpServers"]) == {"thedaw", "underfit"}
    assert config["mcpServers"]["underfit"]["command"] == "node"


def test_write_mcp_config_merges_env_extra_config_file(tmp_path, monkeypatch):
    extra_file = tmp_path / "extra.json"
    extra_file.write_text(
        json.dumps({"mcpServers": {"fromenv": {"command": "x"}}}), encoding="utf-8"
    )
    monkeypatch.setenv("THEDAW_ASSISTANT_EXTRA_MCP_CONFIG", str(extra_file))
    path = tmp_path / "mcp.json"
    assert cs.write_mcp_config("relay-3", str(path), port=1, extra_servers={})
    config = json.loads(path.read_text(encoding="utf-8"))
    assert set(config["mcpServers"]) == {"thedaw", "fromenv"}


# ---------------------------------------------------------------------------
# One persistent child per conversation
# ---------------------------------------------------------------------------
def test_one_child_serves_two_turns_with_a_single_init(monkeypatch):
    use_fake_cli(monkeypatch, "basic")

    async def body():
        first = await run_turn("conv-persist", "one")
        session = cs.sessions["conv-persist"]
        proc_after_first = session.proc
        second = await run_turn("conv-persist", "two")

        assert types(first).count("done") == 1
        assert types(second).count("done") == 1
        # The whole point: ONE child, so exactly ONE system/init across turns.
        assert (types(first) + types(second)).count("session_id") == 1
        assert cs.sessions["conv-persist"].proc is proc_after_first
        assert len(cs.sessions) == 1
        assert proc_after_first.returncode is None

    run(body)


def test_done_frame_carries_usage_cost_and_duration(monkeypatch):
    use_fake_cli(monkeypatch, "basic")

    async def body():
        lines = await run_turn("conv-usage", "hi")
        done = [f for f in frames(lines) if f["type"] == "done"][0]
        assert done["usage"]["input_tokens"] == 11
        assert done["usage"]["cache_read_input_tokens"] == 3
        assert done["totalCostUsd"] == 0.0001
        assert done["durationMs"] == 12
        assert done["isError"] is False

    run(body)


def test_session_id_is_recorded_as_resumable(monkeypatch):
    use_fake_cli(monkeypatch, "basic")

    async def body():
        lines = await run_turn("conv-sid", "hi")
        sid = [f for f in frames(lines) if f["type"] == "session_id"][0]["sessionId"]
        assert sid in cs.known_claude_sessions
        assert cs.sid_to_conversation[sid] == "conv-sid"
        assert cs.sessions["conv-sid"].claude_session_id == sid

    run(body)


# ---------------------------------------------------------------------------
# Stale `result` draining (turn-generation FIFO + clamp)
# ---------------------------------------------------------------------------
def test_handle_stdout_line_drains_stale_result_and_clamps():
    async def body():
        session = cs.ClaudeSession(
            proc=None, relay_id="r", conversation_id="c", model="m", effort="high"
        )
        session.active_queue = asyncio.Queue()
        session.busy = True
        session.turn_gen = 2
        session.result_gen = 0  # a previous turn never consumed its result

        result = {"type": "result", "usage": {}, "is_error": False}
        await cs.handle_stdout_line(session, result, json.dumps(result))
        # First result belongs to the older generation -> drained, turn stays busy.
        assert session.result_gen == 1
        assert session.busy is True
        assert session.active_queue.empty()

        await cs.handle_stdout_line(session, result, json.dumps(result))
        assert session.result_gen == 2
        assert session.busy is False

        # A trailing result can never push the FIFO past the turn counter.
        session.busy = True
        await cs.handle_stdout_line(session, result, json.dumps(result))
        assert session.result_gen == 2

    asyncio.run(body())


def test_stale_result_is_drained_and_the_next_turn_still_completes(monkeypatch):
    use_fake_cli(monkeypatch, "stale_first")

    async def body():
        first = await asyncio.wait_for(run_turn("conv-stale", "one"), timeout=30)
        assert types(first).count("done") == 1
        # Without the resultGen clamp the duplicate result from turn 1 would
        # make turn 2's own result look stale and hang the turn forever.
        second = await asyncio.wait_for(run_turn("conv-stale", "two"), timeout=30)
        assert types(second).count("done") == 1

    run(body)


# ---------------------------------------------------------------------------
# control_request / control_response
# ---------------------------------------------------------------------------
def test_control_request_is_forwarded_and_answer_control_writes_exact_json(
    monkeypatch, tmp_path
):
    log_path = tmp_path / "cli.log"
    use_fake_cli(monkeypatch, "control", log_path)

    async def body():
        lines: list[str] = []

        async def consume():
            async for line in cs.stream_turn(
                "conv-ctl",
                prompt_ndjson_line=cs.build_user_ndjson_line("do it"),
                model="claude-test",
                effort="high",
                permission_mode="ask",
                port=0,
            ):
                lines.append(line)

        task = asyncio.create_task(consume())
        frame = await wait_for_frame(lines, "control_request")
        assert frame["request"]["subtype"] == "can_use_tool"
        assert frame["request"]["tool_name"] == "Bash"
        request_id = frame["requestId"]
        assert request_id in cs.sessions["conv-ctl"].pending_controls
        # The bubble names the key its pending entry lives under, so the browser
        # answers under THAT id even when it reached this session by another one.
        assert frame["conversationId"] == "conv-ctl"

        assert cs.answer_control("conv-ctl", request_id, {"behavior": "allow"}) is True
        # Answering it clears the pending entry, so a second answer is rejected.
        assert cs.answer_control("conv-ctl", request_id, {"behavior": "allow"}) is False

        await asyncio.wait_for(task, timeout=30)
        assert types(lines).count("done") == 1

        assert {
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": {"behavior": "allow"},
            },
        } in log_payloads(log_path)

    run(body)


def test_answer_control_rejects_unknown_conversation_and_request(monkeypatch):
    use_fake_cli(monkeypatch, "basic")

    async def body():
        assert cs.answer_control("nope", "req_1", {"behavior": "allow"}) is False
        await run_turn("conv-unknown", "hi")
        assert (
            cs.answer_control("conv-unknown", "req_1", {"behavior": "allow"}) is False
        )

    run(body)


def test_pending_control_auto_denies_after_the_timeout(monkeypatch, tmp_path):
    log_path = tmp_path / "cli.log"
    use_fake_cli(monkeypatch, "control", log_path)
    monkeypatch.setattr(cs, "PENDING_CONTROL_TIMEOUT_S", 0.2)

    async def body():
        # Nobody ever answers: the engine must deny on its own so the CLI
        # (blocked on stdin) can finish the turn instead of wedging.
        lines = await asyncio.wait_for(run_turn("conv-deny", "do it"), timeout=30)
        assert types(lines).count("done") == 1
        assert not cs.sessions["conv-deny"].pending_controls

        denials = [
            payload
            for payload in log_payloads(log_path)
            if payload.get("type") == "control_response"
        ]
        assert denials
        assert denials[0]["response"]["response"] == {
            "behavior": "deny",
            "message": cs.AUTO_DENY_MESSAGE,
        }
        assert cs.AUTO_DENY_MESSAGE == "No answer from the user within 3 minutes."

    run(body)


def test_policy_hook_answering_a_control_request_emits_no_frame(monkeypatch, tmp_path):
    log_path = tmp_path / "cli.log"
    use_fake_cli(monkeypatch, "control", log_path)

    seen: list[dict] = []

    async def hook(session, request):
        seen.append(request)
        return {"behavior": "allow"}

    async def body():
        lines = await asyncio.wait_for(
            run_turn("conv-hook", "do it", on_control_request=hook), timeout=30
        )
        assert seen and seen[0]["tool_name"] == "Bash"
        # Auto-answered: the browser never sees a permission bubble.
        assert "control_request" not in types(lines)
        assert types(lines).count("done") == 1
        assert not cs.sessions["conv-hook"].pending_controls
        responses = [
            payload
            for payload in log_payloads(log_path)
            if payload.get("type") == "control_response"
        ]
        assert responses[0]["response"]["response"] == {"behavior": "allow"}

    run(body)


def test_policy_hook_returning_none_emits_the_frame_for_the_user(monkeypatch):
    use_fake_cli(monkeypatch, "control")

    async def hook(session, request):
        return None

    async def body():
        lines: list[str] = []

        async def consume():
            async for line in cs.stream_turn(
                "conv-ask",
                prompt_ndjson_line=cs.build_user_ndjson_line("do it"),
                model="claude-test",
                effort="high",
                permission_mode="ask",
                port=0,
                on_control_request=hook,
            ):
                lines.append(line)

        task = asyncio.create_task(consume())
        frame = await wait_for_frame(lines, "control_request")
        assert "policy" not in frame
        assert cs.answer_control("conv-ask", frame["requestId"], {"behavior": "allow"})
        await asyncio.wait_for(task, timeout=30)

    run(body)


def test_policy_hook_can_attach_a_policy_to_the_emitted_frame(monkeypatch):
    use_fake_cli(monkeypatch, "control")
    policy = {"kind": "shell", "selfModify": False, "decision": "ask"}

    async def hook(session, request):
        return {"policy": policy}

    async def body():
        lines: list[str] = []

        async def consume():
            async for line in cs.stream_turn(
                "conv-policy",
                prompt_ndjson_line=cs.build_user_ndjson_line("do it"),
                model="claude-test",
                effort="high",
                permission_mode="ask",
                port=0,
                on_control_request=hook,
            ):
                lines.append(line)

        task = asyncio.create_task(consume())
        frame = await wait_for_frame(lines, "control_request")
        assert frame["policy"] == policy
        assert cs.answer_control(
            "conv-policy", frame["requestId"], {"behavior": "deny", "message": "no"}
        )
        await asyncio.wait_for(task, timeout=30)

    run(body)


# ---------------------------------------------------------------------------
# Interrupt on client disconnect — the child must survive
# ---------------------------------------------------------------------------
def test_client_disconnect_interrupts_the_turn_but_keeps_the_child(
    monkeypatch, tmp_path
):
    log_path = tmp_path / "cli.log"
    use_fake_cli(monkeypatch, "control", log_path)

    async def body():
        lines: list[str] = []

        async def consume():
            async for line in cs.stream_turn(
                "conv-int",
                prompt_ndjson_line=cs.build_user_ndjson_line("long one"),
                model="claude-test",
                effort="high",
                permission_mode="ask",
                port=0,
            ):
                lines.append(line)

        task = asyncio.create_task(consume())
        await wait_for_frame(lines, "control_request")
        session = cs.sessions["conv-int"]

        task.cancel()  # client disconnected mid-turn
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0.3)

        interrupts = [
            payload
            for payload in log_payloads(log_path)
            if payload.get("type") == "control_request"
            and payload.get("request", {}).get("subtype") == "interrupt"
        ]
        assert interrupts, log_payloads(log_path)
        # Child kept warm, session idle again, result FIFO resynced.
        assert session.proc.returncode is None
        assert cs.sessions["conv-int"] is session
        assert session.busy is False
        assert session.result_gen == session.turn_gen

    run(body)


def test_interrupt_helper_writes_a_control_request(monkeypatch, tmp_path):
    log_path = tmp_path / "cli.log"
    use_fake_cli(monkeypatch, "basic", log_path)

    async def body():
        await run_turn("conv-int2", "hi")
        assert cs.interrupt("conv-int2") is True
        assert cs.interrupt("missing") is False
        await asyncio.sleep(0.3)
        subtypes = [
            payload.get("request", {}).get("subtype")
            for payload in log_payloads(log_path)
            if payload.get("type") == "control_request"
        ]
        assert "interrupt" in subtypes

    run(body)


# ---------------------------------------------------------------------------
# Inactivity stall watchdog
# ---------------------------------------------------------------------------
def test_stall_watchdog_ends_a_silent_turn(monkeypatch):
    use_fake_cli(monkeypatch, "silent")
    monkeypatch.setattr(cs, "TURN_STALL_S", 0.4)
    monkeypatch.setattr(cs, "HEARTBEAT_S", 0.1)

    async def body():
        lines = await asyncio.wait_for(run_turn("conv-stall", "hi"), timeout=30)
        assert any(line.startswith(": ping ") for line in lines)
        errors = [f for f in frames(lines) if f["type"] == "error"]
        assert errors and "stalled" in errors[0]["message"]
        assert types(lines).count("done") == 1
        assert cs.sessions["conv-stall"].busy is False

    run(body)


def test_stall_watchdog_does_not_fire_while_output_keeps_arriving(monkeypatch):
    use_fake_cli(monkeypatch, "chatty")
    monkeypatch.setattr(cs, "TURN_STALL_S", 0.4)

    async def body():
        # 6 deltas 0.1s apart = 0.6s total, longer than the 0.4s stall window,
        # but never 0.4s of silence -> the watchdog must stay quiet.
        lines = await asyncio.wait_for(run_turn("conv-chatty", "hi"), timeout=30)
        assert "error" not in types(lines)
        assert types(lines).count("text_delta") == 6
        assert types(lines).count("done") == 1

    run(body)


# ---------------------------------------------------------------------------
# Queueing, respawn, teardown
# ---------------------------------------------------------------------------
def test_second_turn_queues_behind_a_busy_turn(monkeypatch):
    use_fake_cli(monkeypatch, "control")

    async def body():
        first: list[str] = []

        async def consume():
            async for line in cs.stream_turn(
                "conv-queue",
                prompt_ndjson_line=cs.build_user_ndjson_line("one"),
                model="claude-test",
                effort="high",
                permission_mode="ask",
                port=0,
            ):
                first.append(line)

        task = asyncio.create_task(consume())
        frame = await wait_for_frame(first, "control_request")

        second: list[str] = []

        async def consume_second():
            async for line in cs.stream_turn(
                "conv-queue",
                prompt_ndjson_line=cs.build_user_ndjson_line("two"),
                model="claude-test",
                effort="high",
                permission_mode="ask",
                port=0,
            ):
                second.append(line)

        queued = asyncio.create_task(consume_second())
        status = await wait_for_frame(second, "status")
        assert "Queued" in status["message"]
        assert cs.sessions["conv-queue"].idle_waiters

        cs.answer_control("conv-queue", frame["requestId"], {"behavior": "allow"})
        await asyncio.wait_for(task, timeout=30)

        second_request = await wait_for_frame(second, "control_request")
        cs.answer_control(
            "conv-queue", second_request["requestId"], {"behavior": "allow"}
        )
        await asyncio.wait_for(queued, timeout=30)
        assert types(second).count("done") == 1
        assert len(cs.sessions) == 1

    run(body)


def test_model_change_respawns_the_child_in_place(monkeypatch):
    use_fake_cli(monkeypatch, "basic")

    async def body():
        await run_turn("conv-swap", "one", model="model-a")
        session = cs.sessions["conv-swap"]
        old_proc = session.proc
        await run_turn("conv-swap", "two", model="model-b")
        assert cs.sessions["conv-swap"] is session
        assert session.proc is not old_proc
        assert session.model == "model-b"
        assert session.result_gen == session.turn_gen
        await asyncio.sleep(0.2)
        assert old_proc.returncode is not None

    run(body)


def test_teardown_kills_the_child_and_drops_every_registration(monkeypatch):
    use_fake_cli(monkeypatch, "basic")

    async def body():
        lines = await run_turn("conv-down", "hi")
        sid = [f for f in frames(lines) if f["type"] == "session_id"][0]["sessionId"]
        session = cs.sessions["conv-down"]
        config_path = Path(session.mcp_config_path)
        assert config_path.exists()

        await cs.teardown("conv-down", kill=True)
        assert "conv-down" not in cs.sessions
        assert sid not in cs.sid_to_conversation
        assert not config_path.exists()
        assert session.proc.returncode is not None

    run(body)


def test_lru_cap_reaps_the_oldest_idle_session(monkeypatch):
    use_fake_cli(monkeypatch, "basic")
    monkeypatch.setattr(cs, "MAX_SESSIONS", 2)

    async def body():
        await run_turn("conv-lru-1", "hi")
        await run_turn("conv-lru-2", "hi")
        assert len(cs.sessions) == 2
        await run_turn("conv-lru-3", "hi")
        assert len(cs.sessions) <= 2
        assert "conv-lru-1" not in cs.sessions
        assert "conv-lru-3" in cs.sessions

    run(body)


def test_stream_turn_mints_a_conversation_id_when_missing(monkeypatch):
    use_fake_cli(monkeypatch, "basic")

    async def body():
        lines = await run_turn("", "hi")
        minted = [f for f in frames(lines) if f["type"] == "conversationId"]
        assert minted and minted[0]["conversationId"]
        assert minted[0]["conversationId"] in cs.sessions

    run(body)


def test_kill_all_tears_down_every_session(monkeypatch):
    use_fake_cli(monkeypatch, "basic")

    async def body():
        await run_turn("conv-a", "hi")
        await run_turn("conv-b", "hi")
        procs = [session.proc for session in cs.sessions.values()]
        await cs.kill_all()
        assert cs.sessions == {}
        for proc in procs:
            assert proc.returncode is not None

    run(body)


# ---------------------------------------------------------------------------
# Lifecycle logging — the live-proof grep targets
# ---------------------------------------------------------------------------
def _lifecycle_lines(caplog, prefix: str) -> list[str]:
    """
    Match on the FULL ``[claude_session] <verb>`` prefix, never a bare substring:
    "spawned persistent child" is a substring of "respawned persistent child",
    so a loose grep double-counts respawns as spawns.
    """
    return [
        record.getMessage()
        for record in caplog.records
        if record.levelno == logging.INFO
        and record.getMessage().startswith(f"[claude_session] {prefix}")
    ]


def test_spawn_respawn_and_teardown_each_log_exactly_once(monkeypatch, caplog):
    use_fake_cli(monkeypatch, "basic")

    async def body():
        with caplog.at_level(logging.INFO, logger=cs.logger.name):
            await run_turn("conv-log", "one", model="model-a")
            pid = cs.sessions["conv-log"].proc.pid
            await run_turn("conv-log", "two", model="model-b")  # model change
            new_pid = cs.sessions["conv-log"].proc.pid
            await cs.teardown("conv-log", kill=True)

        spawned = _lifecycle_lines(caplog, "spawned persistent child conv=conv-log")
        respawned = _lifecycle_lines(caplog, "respawned persistent child conv=conv-log")
        torn = _lifecycle_lines(caplog, "torn down conv=conv-log")

        assert len(spawned) == 1, spawned
        assert len(respawned) == 1, respawned
        assert len(torn) == 1, torn
        assert f"pid={pid}" in spawned[0]
        assert "resume=False" in spawned[0]
        assert f"pid={new_pid}" in respawned[0]
        assert "resume=" in respawned[0]
        assert "kill=True" in torn[0]

    run(body)


def test_teardown_of_an_unknown_conversation_logs_nothing(monkeypatch, caplog):
    use_fake_cli(monkeypatch, "basic")

    async def body():
        with caplog.at_level(logging.INFO, logger=cs.logger.name):
            await cs.teardown("never-existed", kill=True)
        assert _lifecycle_lines(caplog, "torn down conv=never-existed") == []

    run(body)


# ---------------------------------------------------------------------------
# Review rework — Section A
# ---------------------------------------------------------------------------
def track_spawns(monkeypatch) -> tuple[list, list]:
    """Record every child actually spawned, and the argv it was spawned with."""
    procs: list = []
    arg_sets: list[list[str]] = []
    original = cs._spawn_proc

    async def tracking(args):
        arg_sets.append(list(args))
        proc = await original(args)
        procs.append(proc)
        return proc

    monkeypatch.setattr(cs, "_spawn_proc", tracking)
    return procs, arg_sets


def new_session(**kwargs) -> cs.ClaudeSession:
    session = cs.ClaudeSession(
        proc=None, relay_id="r", conversation_id="c", model="m", effort="high", **kwargs
    )
    session.active_queue = asyncio.Queue()
    session.busy = True
    session.turn_gen = 1
    return session


def drain(session: cs.ClaudeSession) -> list[dict]:
    out = []
    while not session.active_queue.empty():
        raw = session.active_queue.get_nowait()
        out.append(json.loads(raw[len("data: ") :].strip()))
    return out


# A1 — per-conversation creation/claim lock
def test_concurrent_first_turns_spawn_exactly_one_child(monkeypatch):
    use_fake_cli(monkeypatch, "basic")
    procs, _ = track_spawns(monkeypatch)

    async def body():
        first: list[str] = []
        second: list[str] = []

        async def consume(sink):
            async for line in cs.stream_turn(
                "conv-race",
                prompt_ndjson_line=cs.build_user_ndjson_line("hi"),
                model="claude-test",
                effort="high",
                permission_mode="ask",
                port=0,
            ):
                sink.append(line)

        await asyncio.wait_for(
            asyncio.gather(consume(first), consume(second)), timeout=40
        )
        # Without the creation lock both turns spawn, the second overwrites
        # sessions[cid] and the first child is orphaned forever.
        assert len(procs) == 1, [p.pid for p in procs]
        assert len(cs.sessions) == 1
        assert types(first).count("done") == 1
        assert types(second).count("done") == 1
        # One child => one system/init across both turns.
        assert (types(first) + types(second)).count("session_id") == 1

    run(body)

    for proc in procs:
        assert proc.returncode is not None, "orphaned child survived kill_all"


# A2 — a failed mcp-config must fail CLOSED
def test_failed_mcp_config_still_spawns_strict_and_warns(monkeypatch):
    use_fake_cli(monkeypatch, "basic")
    _, arg_sets = track_spawns(monkeypatch)
    monkeypatch.setattr(cs, "write_mcp_config", lambda *a, **k: False)

    async def body():
        lines = await run_turn("conv-nomcp", "hi")
        # Never boot the user's global MCP set just because our temp write died.
        assert "--strict-mcp-config" in arg_sets[0]
        errors = [f for f in frames(lines) if f["type"] == "error"]
        assert errors, types(lines)
        assert "thedaw relay unavailable for this turn" in errors[0]["message"]
        assert types(lines).count("done") == 1

    run(body)


def test_spawn_always_passes_strict_mcp_config(monkeypatch):
    use_fake_cli(monkeypatch, "basic")
    _, arg_sets = track_spawns(monkeypatch)

    async def body():
        await run_turn("conv-strict", "hi")
        assert "--strict-mcp-config" in arg_sets[0]
        assert "--mcp-config" in arg_sets[0]

    run(body)


# A3 — control_cancel_request clears the pending control
def test_control_cancel_clears_the_pending_control():
    async def body():
        session = new_session()
        await cs._handle_control_request(
            session,
            {
                "type": "control_request",
                "requestId": "req_1",
                "request": {"subtype": "can_use_tool", "tool_name": "Bash"},
            },
        )
        assert "req_1" in session.pending_controls
        task = session.pending_controls["req_1"]["task"]

        cancel = {"type": "control_cancel_request", "request_id": "req_1"}
        await cs.handle_stdout_line(session, cancel, json.dumps(cancel))

        assert "req_1" not in session.pending_controls
        await asyncio.sleep(0)
        assert task.cancelled() or task.done()
        assert "control_cancel" in [f["type"] for f in drain(session)]

    asyncio.run(body())


# A4 — no cross-turn auto-deny writes after interrupt / stall
def test_interrupting_a_turn_clears_pending_controls():
    async def body():
        session = new_session()
        await cs._handle_control_request(
            session,
            {
                "type": "control_request",
                "requestId": "req_1",
                "request": {"subtype": "can_use_tool", "tool_name": "Bash"},
            },
        )
        task = session.pending_controls["req_1"]["task"]
        cs._interrupt_active_turn(session, session.active_queue)
        assert session.pending_controls == {}
        await asyncio.sleep(0)
        assert task.cancelled() or task.done()

    asyncio.run(body())


def test_stalling_a_turn_clears_pending_controls():
    async def body():
        session = new_session()
        await cs._handle_control_request(
            session,
            {
                "type": "control_request",
                "requestId": "req_1",
                "request": {"subtype": "can_use_tool", "tool_name": "Bash"},
            },
        )
        task = session.pending_controls["req_1"]["task"]
        cs._finish_turn(session, via_close=True, via_stall=True)
        assert session.pending_controls == {}
        await asyncio.sleep(0)
        assert task.cancelled() or task.done()

    asyncio.run(body())


# A5 — a hanging policy hook must not wedge the turn
def test_hanging_policy_hook_times_out_and_asks_the_user(monkeypatch):
    use_fake_cli(monkeypatch, "control")
    monkeypatch.setattr(cs, "CONTROL_HOOK_TIMEOUT_S", 0.2)

    async def hook(session, request):
        await asyncio.sleep(60)
        return {"behavior": "allow"}

    async def body():
        lines: list[str] = []

        async def consume():
            async for line in cs.stream_turn(
                "conv-hang",
                prompt_ndjson_line=cs.build_user_ndjson_line("do it"),
                model="claude-test",
                effort="high",
                permission_mode="ask",
                port=0,
                on_control_request=hook,
            ):
                lines.append(line)

        task = asyncio.create_task(consume())
        # Hook timed out -> treated as None -> the user is asked.
        frame = await wait_for_frame(lines, "control_request")
        assert cs.answer_control("conv-hang", frame["requestId"], {"behavior": "allow"})
        await asyncio.wait_for(task, timeout=30)
        assert types(lines).count("done") == 1

    run(body)


# A6 — a failed spawn is an error frame, not an exception
def test_spawn_failure_yields_an_error_frame(monkeypatch):
    use_fake_cli(monkeypatch, "basic")

    async def boom(args):
        raise OSError("no such binary: claude.cmd")

    monkeypatch.setattr(cs, "_spawn_proc", boom)

    async def body():
        lines = await run_turn("conv-boom", "hi")
        errors = [f for f in frames(lines) if f["type"] == "error"]
        assert errors, types(lines)
        assert "no such binary" in errors[0]["message"]
        done = [f for f in frames(lines) if f["type"] == "done"][0]
        assert done["isError"] is True
        assert "conv-boom" not in cs.sessions

    run(body)


# A7 — never write to a dead child
def test_writes_to_a_dead_child_are_refused(monkeypatch):
    use_fake_cli(monkeypatch, "basic")

    async def body():
        await run_turn("conv-dead", "hi")
        session = cs.sessions["conv-dead"]
        assert cs.interrupt("conv-dead") is True
        await cs._kill_proc(session.proc)
        assert cs.interrupt("conv-dead") is False
        assert cs._write_stdin(session, {"type": "noop"}) is False

    run(body)


# A8 — nothing may shadow the thedaw relay entry
def test_env_extra_config_cannot_replace_the_thedaw_relay(tmp_path, monkeypatch):
    extra_file = tmp_path / "extra.json"
    extra_file.write_text(
        json.dumps({"mcpServers": {"thedaw": {"command": "evil"}}}), encoding="utf-8"
    )
    monkeypatch.setenv("THEDAW_ASSISTANT_EXTRA_MCP_CONFIG", str(extra_file))
    path = tmp_path / "mcp.json"
    assert cs.write_mcp_config(
        "relay-9",
        str(path),
        port=1,
        extra_servers={"thedaw": {"command": "also-evil"}},
    )
    config = json.loads(path.read_text(encoding="utf-8"))
    assert config["mcpServers"]["thedaw"]["command"] == sys.executable
    assert config["mcpServers"]["thedaw"]["args"][1:] == ["1", "relay-9"]


# A2/A6 interaction — a failed spawn must not leak its per-session config
def test_failed_spawn_does_not_leak_its_mcp_config(monkeypatch):
    use_fake_cli(monkeypatch, "basic")
    written: list[str] = []
    original = cs.write_mcp_config

    def recording(relay_id, path, **kwargs):
        written.append(path)
        return original(relay_id, path, **kwargs)

    monkeypatch.setattr(cs, "write_mcp_config", recording)

    async def boom(args):
        raise OSError("spawn refused")

    monkeypatch.setattr(cs, "_spawn_proc", boom)

    async def body():
        await run_turn("conv-leak", "hi")
        assert written, "no per-session config was written"
        # No session owns this file, so teardown will never unlink it.
        for path in written:
            assert not Path(path).exists(), f"leaked temp config {path}"

    run(body)


# ---------------------------------------------------------------------------
# Audit V1 / V5 rework
# ---------------------------------------------------------------------------
def force_kill(procs: list) -> None:
    """Kill any tracked child still alive — an orphan is invisible to kill_all."""
    for proc in procs:
        if proc.returncode is not None:
            continue
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True
            )
        else:
            try:
                os.kill(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def start_turn(conversation_id: str, sink: list, text: str, hook=None, **kwargs):
    async def drive():
        async for line in cs.stream_turn(
            conversation_id,
            prompt_ndjson_line=cs.build_user_ndjson_line(text),
            model=kwargs.get("model", "claude-test"),
            effort="high",
            permission_mode="ask",
            port=0,
            on_control_request=hook,
        ):
            sink.append(line)
            if kwargs.get("yield_per_item"):
                # Starlette awaits send() per chunk, handing the loop to other
                # tasks between frames; mimic that.
                await asyncio.sleep(0)

    return asyncio.create_task(drive())


async def allow_hook(session, request):
    return {"behavior": "allow"}


def user_order(log_path: Path) -> list[str]:
    return [
        payload["message"]["content"]
        for payload in log_payloads(log_path)
        if payload.get("type") == "user"
    ]


# V1-1 — the creation lock must never split
def test_child_death_with_a_queued_turn_never_splits_the_lock(monkeypatch):
    use_fake_cli(monkeypatch, "control")
    procs: list = []

    async def body():
        entered = asyncio.Event()
        release = asyncio.Event()
        original = cs._spawn_proc
        calls = {"n": 0}

        async def gated(args):
            calls["n"] += 1
            if calls["n"] == 2:  # queued B respawning after A's child died
                entered.set()
                await release.wait()
            proc = await original(args)
            procs.append(proc)
            return proc

        monkeypatch.setattr(cs, "_spawn_proc", gated)
        a_lines: list[str] = []
        b_lines: list[str] = []
        c_lines: list[str] = []

        a = start_turn("conv-split", a_lines, "A")  # blocks on its bubble
        await wait_for_frame(a_lines, "control_request")
        b = start_turn("conv-split", b_lines, "B", allow_hook)
        await wait_for_frame(b_lines, "status")  # B is queued behind A

        await cs._kill_proc(cs.sessions["conv-split"].proc)  # A's child dies
        await asyncio.wait_for(entered.wait(), 20)  # B is mid-spawn
        c = start_turn("conv-split", c_lines, "C", allow_hook)
        await asyncio.sleep(0.5)  # a split lock lets C spawn a second child here
        release.set()
        await asyncio.wait_for(asyncio.gather(a, b, c), 40)

        live = [proc for proc in procs if proc.returncode is None]
        assert len(live) == 1, [proc.pid for proc in live]
        assert cs.sessions["conv-split"].proc is live[0]
        assert types(b_lines).count("done") == 1
        assert types(c_lines).count("done") == 1

    try:
        run(body)
    finally:
        force_kill(procs)


def test_teardown_never_drops_a_lock_a_turn_is_still_using():
    async def body():
        lock = cs._conversation_lock("conv-keep")
        cs.sessions["conv-keep"] = cs.ClaudeSession(
            proc=None,
            relay_id="r-keep",
            conversation_id="conv-keep",
            model="m",
            effort="high",
        )
        # release() clears the flag BEFORE the woken waiter runs, so an
        # "unlocked" lock can still have a turn about to take it.
        await cs.teardown("conv-keep", kill=False)
        assert cs._conversation_lock("conv-keep") is lock

    run(body)


def test_claim_locks_do_not_accumulate_after_turns_complete(monkeypatch):
    use_fake_cli(monkeypatch, "basic")

    async def body():
        await run_turn("conv-tidy", "one")
        await run_turn("conv-tidy", "two")
        assert "conv-tidy" not in cs._conversation_locks

    run(body)


def test_stdin_write_failure_tears_down_before_waking_queued_turns(monkeypatch):
    use_fake_cli(monkeypatch, "basic")
    procs, _ = track_spawns(monkeypatch)

    async def body():
        gate = asyncio.Event()
        original_write = cs._write_stdin_line
        calls = {"n": 0}

        async def flaky_write(session, line):
            calls["n"] += 1
            if calls["n"] == 1:
                await gate.wait()
                raise BrokenPipeError("simulated broken stdin")
            await original_write(session, line)

        monkeypatch.setattr(cs, "_write_stdin_line", flaky_write)
        a_lines: list[str] = []
        b_lines: list[str] = []
        a = start_turn("conv-pipe", a_lines, "A", yield_per_item=True)
        await asyncio.sleep(0.3)  # A has claimed and is inside its write
        b = start_turn("conv-pipe", b_lines, "B", yield_per_item=True)
        await wait_for_frame(b_lines, "status")
        first_proc = cs.sessions["conv-pipe"].proc
        gate.set()
        await asyncio.wait_for(asyncio.gather(a, b), 40)

        assert "error" in types(a_lines)
        b_done = [f for f in frames(b_lines) if f["type"] == "done"][0]
        # B must run on a FRESH child, not claim the dying one and be killed.
        assert b_done["usage"]["input_tokens"] == 11, b_done
        assert cs.sessions["conv-pipe"].proc is not first_proc
        assert len([p for p in procs if p.returncode is None]) == 1

    try:
        run(body)
    finally:
        force_kill(procs)


# V1-3 — fail-closed config is per relay and cleaned up
def test_fail_closed_config_is_per_relay_and_removed_on_teardown(monkeypatch):
    use_fake_cli(monkeypatch, "basic")
    _, arg_sets = track_spawns(monkeypatch)
    monkeypatch.setattr(cs, "write_mcp_config", lambda *a, **k: False)

    async def body():
        await run_turn("conv-fc-1", "hi")
        await run_turn("conv-fc-2", "hi")
        first = cs.sessions["conv-fc-1"]
        second = cs.sessions["conv-fc-2"]
        path_one = Path(arg_sets[0][arg_sets[0].index("--mcp-config") + 1])
        path_two = Path(arg_sets[1][arg_sets[1].index("--mcp-config") + 1])
        assert path_one.name == f"thedaw-mcp-empty-{first.relay_id}.json"
        assert path_two.name == f"thedaw-mcp-empty-{second.relay_id}.json"
        assert path_one != path_two
        assert json.loads(path_one.read_text(encoding="utf-8")) == {"mcpServers": {}}

        await cs.teardown("conv-fc-1", kill=True)
        assert not path_one.exists()
        assert path_two.exists()
        await cs.teardown("conv-fc-2", kill=True)
        assert not path_two.exists()

    run(body)


# V1-4 — respawn retries the config
def test_respawn_retries_the_mcp_config_and_warns_again_on_failure(monkeypatch):
    use_fake_cli(monkeypatch, "basic")
    _, arg_sets = track_spawns(monkeypatch)
    attempts = {"n": 0}

    def always_fails(*args, **kwargs):
        attempts["n"] += 1
        return False

    monkeypatch.setattr(cs, "write_mcp_config", always_fails)

    async def body():
        first = await run_turn("conv-rs", "one", model="model-a")
        second = await run_turn("conv-rs", "two", model="model-b")  # respawn
        warning = cs.MCP_UNAVAILABLE_MESSAGE
        assert [f["message"] for f in frames(first) if f["type"] == "error"] == [
            warning
        ]
        assert [f["message"] for f in frames(second) if f["type"] == "error"] == [
            warning
        ]
        assert attempts["n"] == 2  # spawn + the respawn retry
        assert "--strict-mcp-config" in arg_sets[1]

    run(body)


def test_respawn_recovers_the_mcp_config_when_the_retry_succeeds(monkeypatch):
    use_fake_cli(monkeypatch, "basic")
    _, arg_sets = track_spawns(monkeypatch)
    original = cs.write_mcp_config
    state = {"ok": False}

    def flaky(relay_id, path, **kwargs):
        if not state["ok"]:
            return False
        return original(relay_id, path, **kwargs)

    monkeypatch.setattr(cs, "write_mcp_config", flaky)

    async def body():
        await run_turn("conv-rec", "one", model="model-a")
        state["ok"] = True
        second = await run_turn("conv-rec", "two", model="model-b")  # respawn
        session = cs.sessions["conv-rec"]
        assert "error" not in types(second)
        assert session.mcp_config_written is True
        respawn_args = arg_sets[1]
        assert respawn_args[respawn_args.index("--mcp-config") + 1] == (
            session.mcp_config_path
        )
        assert "--strict-mcp-config" in respawn_args

    run(body)


# V1-5 — queued turns keep arrival order across heartbeats
def test_three_queued_turns_run_in_arrival_order_across_heartbeats(
    monkeypatch, tmp_path
):
    log_path = tmp_path / "cli.log"
    use_fake_cli(monkeypatch, "control", log_path)
    monkeypatch.setattr(cs, "HEARTBEAT_S", 1.0)

    async def body():
        loop = asyncio.get_running_loop()
        a_lines: list[str] = []
        b_lines: list[str] = []
        c_lines: list[str] = []
        d_lines: list[str] = []
        a = start_turn("conv-fifo", a_lines, "A")
        a_request = await wait_for_frame(a_lines, "control_request")
        b = start_turn("conv-fifo", b_lines, "B", allow_hook)
        await wait_for_frame(b_lines, "status")
        b_parked_at = loop.time()
        await asyncio.sleep(0.3)
        c = start_turn("conv-fifo", c_lines, "C", allow_hook)
        await wait_for_frame(c_lines, "status")
        await asyncio.sleep(0.3)
        d = start_turn("conv-fifo", d_lines, "D", allow_hook)
        await wait_for_frame(d_lines, "status")
        # Release AFTER B's first heartbeat (~+1.0s) but BEFORE C's (~+1.3s):
        # a waiter that re-queues itself on each heartbeat is now behind C and D.
        await asyncio.sleep(max(0.0, b_parked_at + 1.15 - loop.time()))
        assert cs.answer_control(
            "conv-fifo", a_request["requestId"], {"behavior": "allow"}
        )
        await asyncio.wait_for(asyncio.gather(a, b, c, d), 40)
        assert user_order(log_path) == ["A", "B", "C", "D"]

    run(body)


# V1-7 — any spawn failure is an error frame, and never leaks the config
def test_non_os_spawn_errors_become_an_error_frame_without_leaking(monkeypatch):
    use_fake_cli(monkeypatch, "basic")
    written: list[str] = []
    original = cs.write_mcp_config

    def recording(relay_id, path, **kwargs):
        written.append(path)
        return original(relay_id, path, **kwargs)

    monkeypatch.setattr(cs, "write_mcp_config", recording)

    async def unsupported(args):
        raise NotImplementedError("subprocesses are not supported on this loop")

    monkeypatch.setattr(cs, "_spawn_proc", unsupported)

    async def body():
        lines = await run_turn("conv-nie", "hi")
        errors = [f for f in frames(lines) if f["type"] == "error"]
        assert errors and "not supported" in errors[0]["message"]
        done = [f for f in frames(lines) if f["type"] == "done"][0]
        assert done["isError"] is True
        assert "conv-nie" not in cs.sessions
        assert written
        for path in written:
            assert not Path(path).exists(), f"leaked temp config {path}"

    run(body)


# V5-5 — kill_all tears sessions down concurrently
def test_kill_all_kills_every_session_concurrently(monkeypatch):
    use_fake_cli(monkeypatch, "basic")
    original_kill = cs._kill_proc
    state = {"in_flight": 0, "peak": 0}

    async def slow_kill(proc):
        state["in_flight"] += 1
        state["peak"] = max(state["peak"], state["in_flight"])
        try:
            await asyncio.sleep(0.6)
            await original_kill(proc)
        finally:
            state["in_flight"] -= 1

    async def body():
        for index in range(5):
            await run_turn(f"conv-many-{index}", "hi")
        procs = [session.proc for session in cs.sessions.values()]
        monkeypatch.setattr(cs, "_kill_proc", slow_kill)
        loop = asyncio.get_running_loop()
        started = loop.time()
        await cs.kill_all()
        elapsed = loop.time() - started
        # Sequential would be >= 5 x 0.6s = 3.0s; concurrent is ~one kill.
        assert state["peak"] == 5, state
        assert elapsed < 2.0, elapsed
        assert cs.sessions == {}
        assert cs._conversation_locks == {}
        for proc in procs:
            assert proc.returncode is not None

    run(body)


def test_claim_lock_lives_until_the_last_claimant_leaves():
    async def body():
        cs._enter_claim("conv-rc")
        cs._enter_claim("conv-rc")
        lock = cs._conversation_lock("conv-rc")
        cs._exit_claim("conv-rc")
        # One turn is still resolving/parked: it must keep sharing this lock.
        assert cs._conversation_locks.get("conv-rc") is lock
        cs._exit_claim("conv-rc")
        assert "conv-rc" not in cs._conversation_locks

    run(body)


def test_claim_exit_never_drops_a_held_lock():
    async def body():
        cs._enter_claim("conv-held")
        lock = cs._conversation_lock("conv-held")
        await lock.acquire()
        try:
            cs._exit_claim("conv-held")
            assert cs._conversation_locks.get("conv-held") is lock
        finally:
            lock.release()

    run(body)


def test_parked_turn_self_heals_when_its_wake_is_lost(monkeypatch):
    use_fake_cli(monkeypatch, "control")
    monkeypatch.setattr(cs, "HEARTBEAT_S", 0.2)

    async def body():
        a_lines: list[str] = []
        b_lines: list[str] = []
        a = start_turn("conv-heal", a_lines, "A")
        a_request = await wait_for_frame(a_lines, "control_request")
        b = start_turn("conv-heal", b_lines, "B", allow_hook)
        await wait_for_frame(b_lines, "status")
        # Lose B's wake-up: A will finish without anyone resolving B's waiter.
        cs.sessions["conv-heal"].idle_waiters.clear()
        assert cs.answer_control(
            "conv-heal", a_request["requestId"], {"behavior": "allow"}
        )
        await asyncio.wait_for(asyncio.gather(a, b), 20)
        assert types(b_lines).count("done") == 1

    run(body)


def test_kill_all_during_an_in_flight_spawn_does_not_split_the_lock(monkeypatch):
    use_fake_cli(monkeypatch, "basic")
    procs: list = []

    async def body():
        entered = asyncio.Event()
        release = asyncio.Event()
        original = cs._spawn_proc
        calls = {"n": 0}

        async def gated(args):
            calls["n"] += 1
            if calls["n"] == 1:  # P's spawn, held open inside the lock
                entered.set()
                await release.wait()
            proc = await original(args)
            procs.append(proc)
            return proc

        monkeypatch.setattr(cs, "_spawn_proc", gated)
        p_lines: list[str] = []
        n_lines: list[str] = []
        p = start_turn("conv-kmid", p_lines, "P")
        await asyncio.wait_for(entered.wait(), 20)  # P holds the lock, mid-spawn
        await cs.kill_all()  # must not drop a lock an in-flight claim holds
        n = start_turn("conv-kmid", n_lines, "N")
        await asyncio.sleep(0.5)  # a dropped lock lets N spawn a second child
        release.set()
        await asyncio.wait_for(asyncio.gather(p, n), 40)

        live = [proc for proc in procs if proc.returncode is None]
        assert len(live) == 1, [proc.pid for proc in live]
        assert types(p_lines).count("done") == 1
        assert types(n_lines).count("done") == 1

    try:
        run(body)
    finally:
        force_kill(procs)


def test_kill_all_drops_locks_no_turn_is_using():
    async def body():
        # An idle entry can outlive its turns (e.g. _exit_claim declining to
        # drop a lock that was still held); kill_all must not carry it over to
        # the next loop, where a bound asyncio.Lock would be unusable.
        cs._conversation_lock("conv-idle-lock")
        await cs.kill_all()
        assert "conv-idle-lock" not in cs._conversation_locks

    run(body)
