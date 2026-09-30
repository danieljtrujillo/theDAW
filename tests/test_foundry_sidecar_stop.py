"""The Foundry sidecar must never shut down a Foundry it did not spawn.

Regression for P-20260919-foundry-orb-F3: `stop()` used to POST /api/shutdown
to whatever answered on port 5472, so every pytest run (the module registers an
atexit hook at import) and every FastAPI TestClient lifespan shutdown killed the
user's live Foundry while they were chatting with it.
"""

from __future__ import annotations

import pytest

from backend.modules.foundry import sidecar


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    """No leftover ownership, and a poisoned network/process layer: any HTTP
    request or pid lookup these tests do not explicitly allow is a failure."""
    monkeypatch.setattr(sidecar, "_proc", None, raising=False)
    monkeypatch.setattr(sidecar, "_resolved_url", None, raising=False)
    yield
    sidecar._proc = None
    sidecar._resolved_url = None


class _Boom(AssertionError):
    pass


def _poison(monkeypatch, calls: list[str]) -> None:
    def _no_urlopen(*args, **kwargs):
        raise _Boom("stop() must not touch the network for a foreign Foundry")

    def _no_kill(pid, sig):
        raise _Boom("stop() must not signal a process it did not spawn")

    def _no_netstat(*args, **kwargs):
        raise _Boom("stop() must not enumerate the process table")

    monkeypatch.setattr(sidecar.urllib.request, "urlopen", _no_urlopen)
    monkeypatch.setattr(sidecar.os, "kill", _no_kill)
    monkeypatch.setattr(sidecar.subprocess, "run", _no_netstat)
    calls.clear()


def test_stop_without_a_spawn_sends_no_request_and_kills_nothing(monkeypatch):
    """The exact bug: a healthy foreign Foundry is serving on the port and we
    never spawned it. stop() must be a pure no-op."""
    calls: list[str] = []
    _poison(monkeypatch, calls)

    assert sidecar._proc is None
    assert sidecar.stop() is False


def test_stop_does_not_probe_the_port_when_we_spawned_nothing(monkeypatch):
    """Not even a health probe: no socket, no HTTP, nothing on the wire."""

    def _no_health(port, host="127.0.0.1"):
        raise _Boom("stop() must not probe a port it does not own")

    monkeypatch.setattr(sidecar, "_is_foundry_server", _no_health)
    monkeypatch.setattr(sidecar, "_port_is_listening", _no_health)
    monkeypatch.setattr(
        sidecar,
        "_request_foundry_shutdown",
        lambda port: pytest.fail("shutdown POST issued for a foreign Foundry"),
    )
    monkeypatch.setattr(
        sidecar,
        "_pid_listening_on_port",
        lambda port: pytest.fail("process table inspected for a foreign Foundry"),
    )

    assert sidecar.stop() is False


def test_atexit_hook_is_a_noop_when_we_spawned_nothing(monkeypatch):
    """Importing this module in any process (pytest does) registers
    `_atexit_stop`. It must not reach out to the port."""
    calls: list[str] = []
    _poison(monkeypatch, calls)

    sidecar._atexit_stop()  # must not raise, must not touch anything


def test_stop_forgets_a_reused_foreign_url_without_stopping_it(monkeypatch):
    calls: list[str] = []
    _poison(monkeypatch, calls)
    sidecar._resolved_url = "http://localhost:5472"

    assert sidecar.stop() is False
    assert sidecar._resolved_url is None


class _FakeProc:
    def __init__(self, pid: int = 4242) -> None:
        self.pid = pid
        self.terminated = False
        self._alive = True

    def poll(self):
        return None if self._alive else 0

    def terminate(self):
        self.terminated = True
        self._alive = False

    def wait(self, timeout=None):
        self._alive = False
        return 0

    def kill(self):
        self._alive = False


def test_stop_shuts_down_a_foundry_we_spawned(monkeypatch):
    """Ownership gate must not break the real path: our own child still gets
    the graceful /api/shutdown."""
    posted: list[int] = []
    alive = {"yes": True}

    monkeypatch.setattr(sidecar, "_proc", _FakeProc(), raising=False)
    monkeypatch.setattr(sidecar, "_is_foundry_server", lambda port: alive["yes"])

    def _shutdown(port):
        posted.append(port)
        alive["yes"] = False
        return True

    monkeypatch.setattr(sidecar, "_request_foundry_shutdown", _shutdown)

    assert sidecar.stop() is True
    assert posted == [sidecar.resolve_config().port]
    assert sidecar._proc is None


def test_stop_never_kills_a_listener_that_is_not_our_child(monkeypatch):
    """Our child is gone but something foreign holds the port: the fallback
    kill must not fire, because the listening pid is not the pid we spawned."""
    proc = _FakeProc(pid=4242)
    monkeypatch.setattr(sidecar, "_proc", proc, raising=False)
    monkeypatch.setattr(sidecar, "_is_foundry_server", lambda port: True)
    monkeypatch.setattr(sidecar, "_request_foundry_shutdown", lambda port: False)
    monkeypatch.setattr(
        sidecar, "_wait_until_not_foundry", lambda port, timeout=5.0: False
    )
    monkeypatch.setattr(sidecar, "_pid_listening_on_port", lambda port: 9999)

    killed: list[int] = []
    monkeypatch.setattr(
        sidecar, "_terminate_pid", lambda pid: killed.append(pid) or True
    )

    with pytest.raises(RuntimeError):
        sidecar.stop()
    assert killed == []


def test_ensure_running_reuses_a_healthy_foreign_foundry(monkeypatch):
    """A port already serving a healthy Foundry is REUSED, not recycled: no
    spawn, no shutdown, just its URL."""
    monkeypatch.setattr(sidecar, "_is_foundry_server", lambda port: True)
    monkeypatch.setattr(
        sidecar.subprocess,
        "Popen",
        lambda *a, **k: pytest.fail("spawned a second Foundry on a live port"),
    )

    url = sidecar.ensure_running()
    assert url == f"http://localhost:{sidecar.resolve_config().port}"
    assert sidecar._proc is None
