"""The app lifespan must not outlive its persistent ``claude`` children.

``backend/modules/assistant/claude_session.py`` keeps ONE long-lived ``claude``
child per conversation, and each of those owns a stdio MCP child of its own.
Nothing used to kill them when the backend went down, so every restart left a
tree of orphans holding the machine's RAM until reboot. ``_on_shutdown`` now
calls ``kill_all()``.

The second half of this file covers the other end of the same wiring: those
children announce themselves with ``[claude_session]`` INFO lines, and under a
plain ``uvicorn backend.server:app`` nobody configured a console handler for
the app's own loggers, so the announcements went nowhere. Only
``backend/run.py`` (the theDAW.bat path) did.

The startup half of the lifespan is stubbed in the in-process tests: it warms
torch and runs every module's startup hook, which spawns real sidecars — none
of which this file is about.
"""

from __future__ import annotations

import asyncio
import logging
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import server
from backend.modules.assistant import claude_session as cs

PROJECT_ROOT = Path(__file__).resolve().parents[1]
FAKE_CLI = Path(__file__).parent / "fixtures" / "fake_claude_cli.py"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def use_fake_cli(monkeypatch) -> None:
    """Point the engine's spawn at the scripted fake CLI (same convention as
    ``tests/test_assistant_claude_session.py``)."""
    monkeypatch.setenv("FAKE_CLI_MODE", "basic")
    monkeypatch.delenv("FAKE_CLI_LOG", raising=False)
    monkeypatch.setattr(
        cs,
        "build_spawn_argv",
        lambda base_args: [sys.executable, "-u", str(FAKE_CLI)],
    )


def stub_startup(monkeypatch) -> None:
    """Keep the real ``_on_shutdown`` but skip ``_on_startup``."""

    async def _noop() -> None:
        return None

    monkeypatch.setattr(server, "_on_startup", _noop)


@pytest.fixture(autouse=True)
def sidecar_stops(monkeypatch) -> list[bool]:
    """The real ``_on_shutdown`` ends with ``teardown.stop_all_sidecars``,
    which also stops the magenta engine and the other sidecars this checkout
    started; run from the app tree, those are the running app's. A recorder
    stands in for it, so a test run leaves the user's engines alone and still
    sees that shutdown reached the sidecar stop."""
    stopped: list[bool] = []
    monkeypatch.setattr(
        "backend.core.teardown.stop_all_sidecars", lambda: stopped.append(True)
    )
    return stopped


@pytest.fixture(autouse=True)
def no_leaked_sessions():
    """A test that fails mid-way must not leave a child behind for the next."""
    yield
    if cs.sessions:
        asyncio.run(cs.kill_all())


async def _spawn_fake_session(conversation_id: str) -> cs.ClaudeSession:
    return await cs.spawn(
        conversation_id,
        model="claude-test",
        effort="high",
        permission_mode="ask",
        port=0,
    )


# ---------------------------------------------------------------------------
# F1a — the shutdown hook
# ---------------------------------------------------------------------------
def test_app_shutdown_kills_every_persistent_claude_child(monkeypatch, sidecar_stops):
    use_fake_cli(monkeypatch)
    stub_startup(monkeypatch)

    with TestClient(server.app) as client:
        session = client.portal.call(_spawn_fake_session, "conv-shutdown")
        proc = session.proc
        assert cs.sessions["conv-shutdown"] is session
        assert proc.returncode is None

    assert cs.sessions == {}
    assert proc.returncode is not None
    assert sidecar_stops == [True]


def test_app_shutdown_is_safe_with_no_sessions(monkeypatch, sidecar_stops):
    stub_startup(monkeypatch)

    with TestClient(server.app):
        pass

    assert cs.sessions == {}
    assert sidecar_stops == [True]


def test_a_failed_reap_is_logged_and_shutdown_still_completes(monkeypatch, caplog):
    """A reap that raises must not be swallowed silently: the orphaned claude
    tree it leaves behind is exactly what the warning exists to reveal. The
    rest of shutdown (sidecar teardown) must still run."""
    stub_startup(monkeypatch)

    async def _boom() -> None:
        raise RuntimeError("reap exploded")

    monkeypatch.setattr(cs, "kill_all", _boom)
    sidecars_stopped: list[bool] = []
    monkeypatch.setattr(
        "backend.core.teardown.stop_all_sidecars",
        lambda: sidecars_stopped.append(True),
    )

    with caplog.at_level(logging.WARNING, logger=server.logger.name):
        with TestClient(server.app):
            pass

    warnings = [
        record
        for record in caplog.records
        if record.name == server.logger.name
        and record.levelno == logging.WARNING
        and record.getMessage() == "shutdown: claude_session.kill_all failed"
    ]
    assert len(warnings) == 1, [r.getMessage() for r in caplog.records]
    assert warnings[0].exc_info is not None
    assert "reap exploded" in str(warnings[0].exc_info[1])
    assert sidecars_stopped == [True]


# ---------------------------------------------------------------------------
# F1b — the lifecycle lines reach a handler
# ---------------------------------------------------------------------------
def test_spawn_line_is_logged_at_info_under_the_app(monkeypatch, caplog):
    use_fake_cli(monkeypatch)
    stub_startup(monkeypatch)

    with caplog.at_level(logging.INFO, logger=cs.logger.name):
        with TestClient(server.app) as client:
            client.portal.call(_spawn_fake_session, "conv-log-line")

    spawned = [
        record.getMessage()
        for record in caplog.records
        if record.levelno == logging.INFO
        and record.getMessage().startswith(
            "[claude_session] spawned persistent child conv=conv-log-line"
        )
    ]
    assert len(spawned) == 1, spawned


#: Imports the app exactly as ``uvicorn backend.server:app`` would — no
#: ``backend/run.py``, which is the only place that used to configure the root
#: logger — then emits one lifecycle-shaped line on the assistant's logger.
_CONSOLE_PROBE = """
import backend.server  # noqa: F401
from backend.modules.assistant import claude_session

claude_session.logger.info("[claude_session] probe conv=%s pid=%s", "c1", 4242)
"""


def test_assistant_info_lines_reach_the_console_without_run_py():
    """A subprocess, because the test runner has its own log handlers on root;
    an in-process check would pass on pytest's capture rather than on ours."""
    proc = subprocess.run(
        [sys.executable, "-c", _CONSOLE_PROBE],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert proc.returncode == 0, f"probe failed:\n{proc.stderr[-2000:]}"
    combined = proc.stderr + proc.stdout
    assert "[claude_session] probe conv=c1 pid=4242" in combined, (
        "the assistant's INFO lifecycle lines never reached the console:\n"
        f"{combined[-2000:]}"
    )


def test_console_logging_installs_exactly_one_handler():
    """Idempotent: the import already ran it, and ``_on_startup`` runs it again
    to survive a logging reconfiguration. Neither may duplicate the handler."""
    root = logging.getLogger()

    def ours() -> list[logging.Handler]:
        return [
            handler
            for handler in root.handlers
            if getattr(handler, server.CONSOLE_LOG_MARKER, False)
        ]

    before = len(ours())
    server._configure_console_logging()
    server._configure_console_logging()
    assert len(ours()) == before
    assert before <= 1


def test_console_logging_yields_to_an_existing_console_handler():
    """``backend/run.py`` configures the root logger before importing the app.
    The app must then keep its hands off, or every line prints twice."""
    root = logging.getLogger()
    existing = logging.StreamHandler(sys.stderr)
    ours_before = [
        handler
        for handler in root.handlers
        if getattr(handler, server.CONSOLE_LOG_MARKER, False)
    ]
    for handler in ours_before:
        root.removeHandler(handler)
    root.addHandler(existing)
    try:
        server._configure_console_logging()
        added = [
            handler
            for handler in root.handlers
            if getattr(handler, server.CONSOLE_LOG_MARKER, False)
        ]
        assert added == []
    finally:
        root.removeHandler(existing)
        for handler in ours_before:
            root.addHandler(handler)
