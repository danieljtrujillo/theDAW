"""The web launcher never moves theDAW to a new browser origin.

The launchers stop only theDAW's own stale listeners (``backend.ports
--free``). Whatever is still on 5173 after that belongs to someone else --
another project's Vite, or theDAW from another folder. A browser keeps
theDAW's saved settings and its microphone and MIDI permissions per origin,
and the port is part of the origin, so starting the web UI on 5174 opened the
app with every setting at its default and said so only in a console that had
already been minimized. The stack now stops before anything starts and names
the program holding the port; the other program is left running.
"""

from __future__ import annotations

import io
import os
import socket
from contextlib import closing
from pathlib import Path

import pytest

from backend import _devstack, ports


class _StackStarted(Exception):
    """Raised by the stand-in spawner: the stack started a child process."""


@pytest.fixture(autouse=True)
def _restore_frontend_port():
    yield
    _devstack._use_frontend_port(ports.FRONTEND_PORT)


@pytest.fixture
def held_port():
    """A port another program (this test process) is listening on."""
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as srv:
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        yield srv.getsockname()[1]


@pytest.fixture
def unused_port() -> int:
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def test_a_held_web_ui_port_stops_the_stack_before_anything_starts(
    held_port: int, monkeypatch: pytest.MonkeyPatch
):
    """The launch sequence with another program on the web UI's port: nothing
    is spawned, the console is NOT minimized, the one line names the program,
    and main() exits non-zero so theDAW.bat's "press any key" keeps it on
    screen."""
    monkeypatch.setattr(ports, "FRONTEND_PORT", held_port)
    lines: list[str] = []
    minimized: list[bool] = []

    def spawn(cmd, cwd=None, env=None):
        raise _StackStarted(cmd)

    monkeypatch.setattr(_devstack, "_spawn", spawn)
    monkeypatch.setattr(_devstack, "_emit", lambda tag, line: lines.append(line))
    monkeypatch.setattr(_devstack, "_minimize_console", lambda: minimized.append(True))
    monkeypatch.setattr(_devstack, "_enable_ansi", lambda: True)

    try:
        rc = _devstack.main()
    except _StackStarted as started:
        pytest.fail(f"the stack started {started.args[0]!r} on a new origin")

    assert rc != 0
    assert minimized == [], "the console was hidden behind the only message"
    said = "\n".join(lines)
    assert "cannot start" in said
    assert str(held_port) in said
    assert f"pid {os.getpid()}" in said
    assert "saved settings" in said


def test_the_blocker_is_none_when_the_web_ui_port_is_free(
    unused_port: int, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(ports, "FRONTEND_PORT", unused_port)
    assert _devstack._frontend_blocker() is None


def test_an_unreadable_process_table_still_stops_with_a_reason(
    held_port: int, monkeypatch: pytest.MonkeyPatch
):
    """The listening table can be unreadable (no rights). The port is still
    taken, so the stack still stops, and the sentence says what it can."""
    monkeypatch.setattr(ports, "FRONTEND_PORT", held_port)
    monkeypatch.setattr(_devstack.ports, "holders", lambda wanted: [])
    reason = _devstack._frontend_blocker()
    assert reason is not None
    assert "cannot see which program" in reason
    reason.encode("ascii")


def test_the_preferred_port_keeps_the_dev_script():
    assert _devstack._frontend_command(ports.FRONTEND_PORT) == "npm run dev"


def test_another_port_runs_vite_with_that_port_only():
    cmd = _devstack._frontend_command(5174)
    assert "--port=5174" in cmd
    # Not appended to the dev script, which already carries --port=5173.
    assert "npm run dev" not in cmd
    assert "5173" not in cmd


def test_the_browser_and_readiness_probe_follow_the_chosen_port():
    _devstack._use_frontend_port(5176)
    assert _devstack._frontend_port == 5176
    assert _devstack.FRONTEND_URL == "http://localhost:5176"


def test_the_backend_child_is_told_which_port_the_web_ui_took(monkeypatch):
    """The backend advertises the web UI's address to other devices
    (GET /api/network/lan), so it has to learn the port the launcher serves it
    on."""

    class _Proc:
        pid = 4242

        def __init__(self) -> None:
            self.stdout = io.StringIO("")

        def poll(self):
            return None

        def wait(self) -> int:
            return 0

    spawns: list[dict] = []

    def record(cmd, cwd=None, env=None):
        spawns.append(dict(env or {}))
        return _Proc()

    monkeypatch.setattr(_devstack, "_spawn", record)
    monkeypatch.setattr(_devstack, "_emit", lambda tag, line: None)
    _devstack._use_frontend_port(5179)
    _devstack._shutdown.clear()
    try:
        _devstack._run_backend([])
    finally:
        _devstack._shutdown.clear()

    assert spawns, "the backend was never spawned"
    assert spawns[0].get("theDAW_FRONTEND_PORT") == "5179"


def test_the_web_launcher_waits_for_a_key_after_the_stack_stops():
    """main() returning is what puts the reason on screen for good: theDAW.bat
    goes to :stopped, which pauses, after backend._devstack exits."""
    bat = (Path(__file__).resolve().parent.parent / "theDAW.bat").read_text(
        encoding="utf-8"
    )
    web = bat.index("python -m backend._devstack")
    label = bat.index("\n:stopped\n")
    assert bat.index("goto :stopped", web) < label
    assert "pause" in bat[label : label + 200]
