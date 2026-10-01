"""Unit tests for backend.modules.lyria.sidecar, backend.modules.lyria.router,
and the Lyria provider status block in backend.modules.storage.router (T07 /
batch 12, plus the T07 audit follow-up).

Covers:
  * INT-001 -- a bare TCP listener on the sidecar's port must not be adopted
    as "our sidecar" without an identity check against Lyria's own
    `/api/settings/status` response shape.
  * INT-003 -- `ensure_running()` must not hold `_state_lock` while running
    `npm install`, so `stop()`/`probe()` are never blocked behind it.
  * INT-004 -- the storage router's Lyria provider status must treat a
    confirmed-listening sidecar as "ready" even when static prerequisite
    checks (key/deps/etc.) currently report issues.
  * Audit item 1 -- stop() called while ensure_running() is mid-install or
    mid-Popen must prevent that spawn from completing, or it orphans a Node
    process holding the port.
  * Audit item 2 -- the identity check must ignore HTTP_PROXY/system proxy
    settings; our own loopback sidecar must never be routed through a proxy.
  * Audit item 3 -- `_ensure_deps` (called both by ensure_running() and by
    the Install button's `_install_worker`) must serialize its node_modules
    check + `npm install` call so two callers never install concurrently.
  * Audit item 4 -- the router's /url, /status, /start routes must offload
    their blocking sidecar calls via `asyncio.to_thread`.
  * Audit item 5 -- an adopted listener that isn't our own spawned process
    must not be reported as "mock"/"live"; its cost mode is unknown.
  * Audit item 6 -- a "ready" (listening) sidecar in live mode with no key
    configured must still surface the key warning in its summary.
  * Audit item 7 -- concurrent ensure_running() callers must install once and
    spawn once.

Re-audit follow-up (round 2):
  * Item 1 -- router.py's /stop, POST /key, and /url's owns_process() call
    must also be offloaded via asyncio.to_thread (stop() can taskkill+wait
    for ~10s worst case).
  * Item 2 -- the identity check must not raise for a non-HTTP listener (an
    SSH-style banner raises http.client.HTTPException, not OSError/URLError).
  * Item 3 -- a stop() during the readiness wait must abort immediately, not
    be silently ignored until the 90s deadline.
  * Item 5 -- ensure_running() must wait for an in-progress stop() to finish
    tearing down the previous process before probing/adopting.
  * Item 6 -- the network identity probe must run OUTSIDE _state_lock.
  * Item 8 -- concurrency tests use a Barrier for determinism and assert
    real lock contention, not just call counts.

Provider keys (both providers):
  * `_child_env` puts ONE key in GEMINI_API_KEY / OPENROUTER_API_KEY for every
    checkout, and the rest of the ordered list (env, then the Lyria card) in
    the numbered _2 .. _10 slots only for a checkout whose server/keys.ts reads
    them. The assistant's pool adds its first Gemini key when nothing else has
    one, and everything else only once the user shares it. No value is logged.
  * The key file is written atomically (a crash mid-write keeps every key),
    keeps a single-key ``key`` field an older build reads, migrates the legacy
    single-Gemini file on read and backs it up before rewriting it.
  * The AI_PROVIDER decision table: only-gemini, only-openrouter, both,
    neither, and a preference the user set.
  * The /keys routes' shapes and validation, and that no response body carries
    key material.
  * Every route that changes state refuses a foreign page and a LAN caller
    without the launch or pairing token; include_mock is loopback-only.
  * restart() replaces a Lyria adopted from an earlier session with a child
    that has the current keys, and refuses one from another folder.
  * Install clones the latest commit of the Lyria repo's default branch;
    opening Lyria runs the checkout as it is; Update fast-forwards a clean
    checkout to the latest and restarts Lyria, and leaves one with local
    changes, its own branch or its own commits alone, saying why. What a
    checkout reads (server/keys.ts, numberedEnvValues per variable) is read
    from the checkout itself.

No real npm/node process is spawned -- `_ensure_deps` and `subprocess.Popen`
are monkeypatched. A throwaway `http.server` (or raw TCP listener, for the
non-HTTP-banner case) stands in for "something listening on the port" to
exercise the identity check without the real Lyria checkout.
"""

from __future__ import annotations

import asyncio
import hashlib
import http.server
import io
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from contextlib import contextmanager
from types import SimpleNamespace
from typing import Iterator

import pytest

from backend.modules.lyria import sidecar
from tests.timing_bounds import prompt_seconds


@pytest.fixture(autouse=True)
def _reset_sidecar_module_state(tmp_path, monkeypatch):
    """The sidecar tracks its child process/URL/stop-request in module
    globals, which persist across tests in the same process. Reset them
    around every test so one test's fake spawned process can't leak into the
    next test's "is anything running" checks.

    Every file the sidecar writes is moved under tmp_path too: the key file
    and its copy (probe() reads them, and a read writes back what another
    build changed), the pending-install record, and the sidecar log a spawn
    appends to. No test writes into the checkout's data/."""
    monkeypatch.setattr(sidecar, "_KEY_FILE", tmp_path / "lyria_gemini_key.json")
    monkeypatch.setattr(
        sidecar, "_KEY_FILE_BACKUP", tmp_path / "lyria_gemini_key.json.bak"
    )
    monkeypatch.setattr(
        sidecar, "_DEPS_PENDING_FILE", tmp_path / "lyria_deps_pending.json"
    )
    monkeypatch.setattr(
        sidecar, "_CHECKOUT_RECORD_FILE", tmp_path / "lyria_checkout.json"
    )
    monkeypatch.setattr(
        sidecar, "SIDECAR_LOG_PATH", tmp_path / "logs" / "lyria-sidecar.log"
    )
    monkeypatch.setattr(sidecar, "_verify_state", dict(sidecar._verify_state))
    sidecar._proc = None
    sidecar._resolved_url = None
    sidecar._stop_requested = False
    sidecar._stopping.clear()
    yield
    sidecar._proc = None
    sidecar._resolved_url = None
    sidecar._stop_requested = False
    sidecar._stopping.clear()


@pytest.fixture(autouse=True)
def _sidecar_log_in_tmp(tmp_path, monkeypatch):
    """SIDECAR_LOG_PATH is fixed at import to the checkout's
    data/logs/lyria-sidecar.log, and the install/spawn paths these tests drive
    open it, so a run created that file in whichever checkout ran the suite
    (the user's app tree included). Every test here logs to its own tmp file."""
    monkeypatch.setattr(sidecar, "SIDECAR_LOG_PATH", tmp_path / "lyria-sidecar.log")


# ---------------------------------------------------------------------------
# Throwaway HTTP servers used to fake "something is listening on the port"
# ---------------------------------------------------------------------------


class _LyriaLikeHandler(http.server.BaseHTTPRequestHandler):
    """Answers /api/settings/status exactly like the real Lyria server does."""

    def log_message(self, *args: object) -> None:  # silence test logs
        pass

    def do_GET(self) -> None:  # stdlib method name
        if self.path == "/api/settings/status":
            body = json.dumps(
                {
                    "geminiServerKey": False,
                    "openRouterServerKey": False,
                    "defaultProvider": "gemini",
                }
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()


class _UnrelatedHandler(http.server.BaseHTTPRequestHandler):
    """Some other dev server that happens to be listening on the port."""

    def log_message(self, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        body = b"<html>not lyria</html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@contextmanager
def _run_server(
    handler: type[http.server.BaseHTTPRequestHandler],
) -> Iterator[int]:
    server = http.server.HTTPServer(("127.0.0.1", 0), handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield port
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5.0)


@contextmanager
def _run_raw_banner_listener(
    banner: bytes = b"SSH-2.0-OpenSSH_9.6\r\n",
) -> Iterator[int]:
    """A raw TCP listener that sends a non-HTTP banner on connect, like SSH.
    http.client raises http.client.HTTPException (BadStatusLine) parsing
    this as an HTTP response -- a different exception hierarchy than
    OSError/URLError."""
    server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server_sock.bind(("127.0.0.1", 0))
    server_sock.listen(5)
    server_sock.settimeout(0.2)
    port = server_sock.getsockname()[1]
    stop_flag = threading.Event()

    def _serve() -> None:
        while not stop_flag.is_set():
            try:
                conn, _addr = server_sock.accept()
            except socket.timeout:
                continue
            try:
                conn.sendall(banner)
            except OSError:
                pass
            finally:
                conn.close()

    thread = threading.Thread(target=_serve, daemon=True)
    thread.start()
    try:
        yield port
    finally:
        stop_flag.set()
        thread.join(timeout=5.0)
        server_sock.close()


# ---------------------------------------------------------------------------
# INT-001 -- identity check
# ---------------------------------------------------------------------------


def test_is_lyria_server_true_for_matching_settings_status():
    with _run_server(_LyriaLikeHandler) as port:
        assert sidecar._is_lyria_server(port) is True


def test_is_lyria_server_false_for_unrelated_listener():
    with _run_server(_UnrelatedHandler) as port:
        assert sidecar._is_lyria_server(port) is False


def test_is_lyria_server_false_when_nothing_listening():
    # Port 1 is a privileged, essentially-never-bound port on every platform.
    assert sidecar._is_lyria_server(1) is False


# ---------------------------------------------------------------------------
# Re-audit item 2 -- identity check must not raise for a non-HTTP listener
# ---------------------------------------------------------------------------


def test_is_lyria_server_false_for_non_http_banner_listener():
    """An SSH-style banner (or any non-HTTP protocol) makes http.client raise
    http.client.HTTPException parsing it as an HTTP response -- a different
    exception hierarchy than OSError/URLError. Uncaught, that would propagate
    out of probe()/ensure_running() as an unhandled 500 instead of the
    intended "port in use" 503."""
    with _run_raw_banner_listener() as port:
        assert sidecar._is_lyria_server(port) is False


def test_probe_does_not_raise_for_non_http_banner_listener(monkeypatch):
    with _run_raw_banner_listener() as port:
        monkeypatch.setenv("theDAW_LYRIA_PORT", str(port))
        out = sidecar.probe()  # must not raise
        assert out["listening"] is False
        assert any("already in use" in issue for issue in out["issues"])


def test_ensure_running_raises_runtimeerror_not_httpexception_for_banner_listener(
    monkeypatch,
):
    with _run_raw_banner_listener() as port:
        monkeypatch.setenv("theDAW_LYRIA_PORT", str(port))
        with pytest.raises(RuntimeError, match="already in use"):
            sidecar.ensure_running(wait_for_ready=False)


def test_probe_reports_not_listening_when_port_held_by_unrelated_process(
    monkeypatch,
):
    with _run_server(_UnrelatedHandler) as port:
        monkeypatch.setenv("theDAW_LYRIA_PORT", str(port))
        out = sidecar.probe()
        assert out["listening"] is False
        assert any("already in use" in issue for issue in out["issues"])


def test_probe_reports_listening_when_identity_confirmed(monkeypatch):
    with _run_server(_LyriaLikeHandler) as port:
        monkeypatch.setenv("theDAW_LYRIA_PORT", str(port))
        out = sidecar.probe()
        assert out["listening"] is True
        assert not any("already in use" in issue for issue in out["issues"])


def test_ensure_running_raises_instead_of_adopting_unrelated_listener(monkeypatch):
    with _run_server(_UnrelatedHandler) as port:
        monkeypatch.setenv("theDAW_LYRIA_PORT", str(port))
        with pytest.raises(RuntimeError, match="already in use"):
            sidecar.ensure_running(wait_for_ready=False)


def test_ensure_running_adopts_confirmed_lyria_listener(monkeypatch):
    with _run_server(_LyriaLikeHandler) as port:
        monkeypatch.setenv("theDAW_LYRIA_PORT", str(port))
        url = sidecar.ensure_running(wait_for_ready=False)
        assert url == f"http://127.0.0.1:{port}"


# ---------------------------------------------------------------------------
# INT-003 -- npm install must not hold _state_lock
# ---------------------------------------------------------------------------


def test_ensure_deps_does_not_block_stop_or_probe(monkeypatch, tmp_path):
    """While the (fake, slow) npm install runs, stop() and probe() -- which
    only need _state_lock -- must return promptly instead of queueing behind
    the install. Before the INT-003 fix, ensure_running() held _state_lock
    for the entire `_ensure_deps` call, so stop() would block for the full
    install duration."""
    project = tmp_path / "lyria-project"
    project.mkdir()
    (project / "package.json").write_text("{}", encoding="utf-8")

    monkeypatch.setenv("theDAW_LYRIA_PROJECT", str(project))
    monkeypatch.setenv("theDAW_LYRIA_PORT", "0")  # never actually listening

    install_started = threading.Event()
    release_install = threading.Event()

    def _slow_ensure_deps(cfg: sidecar.LyriaConfig) -> None:
        install_started.set()
        release_install.wait(timeout=5.0)

    def _fake_popen(*args: object, **kwargs: object):
        raise FileNotFoundError("no real npm in this test")

    monkeypatch.setattr(sidecar, "_ensure_deps", _slow_ensure_deps)
    monkeypatch.setattr(sidecar.subprocess, "Popen", _fake_popen)

    # Force port 0 to never "listen" for the duration of this test.
    monkeypatch.setattr(
        sidecar, "_port_is_listening", lambda port, host="127.0.0.1": False
    )

    result: dict = {}

    def _run_ensure_running() -> None:
        try:
            sidecar.ensure_running(wait_for_ready=False)
        except Exception as exc:  # captured for the assertion below
            result["error"] = exc

    thread = threading.Thread(target=_run_ensure_running, daemon=True)
    thread.start()
    try:
        assert install_started.wait(timeout=5.0), "install never started"

        start = time.monotonic()
        with sidecar._state_lock:
            pass  # acquiring it proves it isn't held by the in-progress install
        elapsed = time.monotonic() - start
        assert elapsed < prompt_seconds(1.0), (
            f"_state_lock was held for {elapsed:.2f}s -- npm install is still "
            "blocking it (INT-003 regression)"
        )

        # probe() must also return promptly (it takes _state_lock nowhere
        # directly, but this proves the module isn't deadlocked either way).
        out = sidecar.probe()
        assert isinstance(out, dict)
    finally:
        release_install.set()
        thread.join(timeout=5.0)
        assert not thread.is_alive()


# ---------------------------------------------------------------------------
# INT-004 -- storage router "ready" must honour a confirmed-listening sidecar
# ---------------------------------------------------------------------------


def test_lyria_provider_status_ready_when_listening_despite_issues(monkeypatch):
    from backend.modules.storage import router

    def _fake_probe():
        return {
            "project_path": "/fake/lyria",
            "issues": [
                "GEMINI_API_KEY is not set: live mode cannot generate without it."
            ],
            "missing": ["key"],
            "install": {},
            "gemini_key": False,
            "gemini_key_source": "none",
            "listening": True,
            # We spawned this process ourselves -- its cost mode IS what
            # theDAW's own LYRIA_MOCK setting says.
            "process_alive": True,
            "repo": sidecar.LYRIA_REPO,
            "repo_url": sidecar.LYRIA_REPO_URL,
            "git": True,
            "node": True,
            "npm": True,
            "installable": True,
        }

    monkeypatch.setattr(sidecar, "probe", _fake_probe)
    monkeypatch.setattr(sidecar, "is_mock", lambda: True)

    status = router._lyria_provider_status()
    assert status["state"] == "ready"
    assert status["active"] is True
    assert status["lyria"]["listening"] is True
    assert "Mock mode" in status["summary"]


def test_lyria_provider_status_not_ready_when_not_listening_and_issues(monkeypatch):
    from backend.modules.storage import router

    def _fake_probe():
        return {
            "project_path": "/fake/lyria",
            "issues": [
                "GEMINI_API_KEY is not set: live mode cannot generate without it."
            ],
            "missing": ["key"],
            "install": {},
            "gemini_key": False,
            "gemini_key_source": "none",
            "listening": False,
            "repo": sidecar.LYRIA_REPO,
            "repo_url": sidecar.LYRIA_REPO_URL,
            "git": True,
            "node": True,
            "npm": True,
            "installable": True,
        }

    monkeypatch.setattr(sidecar, "probe", _fake_probe)
    monkeypatch.setattr(sidecar, "is_mock", lambda: True)

    status = router._lyria_provider_status()
    assert status["state"] == "needs_setup"
    assert status["active"] is False


# ---------------------------------------------------------------------------
# Audit item 1 -- stop() mid-install/mid-spawn must not orphan a process
# ---------------------------------------------------------------------------


def test_stop_mid_install_prevents_orphan_process(monkeypatch, tmp_path):
    """stop() called while ensure_running() is still inside `_ensure_deps`
    (before _proc exists) must prevent the pending spawn from ever calling
    Popen -- otherwise stop()'s "_proc is None" early return has nothing to
    kill, and the install completes into an orphaned Node process moments
    later with nothing left tracking it."""
    project = tmp_path / "lyria-project-stop"
    project.mkdir()
    (project / "package.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("theDAW_LYRIA_PROJECT", str(project))
    monkeypatch.setenv("theDAW_LYRIA_PORT", "0")
    monkeypatch.setattr(
        sidecar, "_port_is_listening", lambda port, host="127.0.0.1": False
    )

    install_started = threading.Event()
    release_install = threading.Event()
    popen_called = threading.Event()

    def _slow_ensure_deps(cfg: sidecar.LyriaConfig) -> None:
        install_started.set()
        release_install.wait(timeout=5.0)

    def _fake_popen(*args: object, **kwargs: object):
        popen_called.set()
        raise RuntimeError("Popen must not run once stop() fired mid-install")

    monkeypatch.setattr(sidecar, "_ensure_deps", _slow_ensure_deps)
    monkeypatch.setattr(sidecar.subprocess, "Popen", _fake_popen)

    result: dict = {}

    def _run() -> None:
        try:
            sidecar.ensure_running(wait_for_ready=False)
        except Exception as exc:  # captured for the assertion below
            result["error"] = exc

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    try:
        assert install_started.wait(timeout=5.0), "install never started"

        # Nothing is running yet, so stop() has nothing to physically kill --
        # but it must still flag the in-flight spawn to abort.
        assert sidecar.stop() is False

        release_install.set()
        thread.join(timeout=5.0)
        assert not thread.is_alive()
    finally:
        release_install.set()

    assert not popen_called.is_set(), (
        "ensure_running() called Popen after stop() was requested mid-install "
        "-- this orphans a Node process (item 1 regression)"
    )
    assert isinstance(result.get("error"), RuntimeError)
    assert str(result["error"]) == "stopped"
    assert sidecar._proc is None


def test_ensure_running_terminates_process_spawned_during_a_stop_race(
    monkeypatch, tmp_path
):
    """Covers the narrower window: stop() arrives during the Popen() call
    itself, after _ensure_deps already returned. The freshly-spawned process
    must be terminated immediately rather than handed off to module state."""
    project = tmp_path / "lyria-project-stop-race"
    project.mkdir()
    (project / "package.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("theDAW_LYRIA_PROJECT", str(project))
    monkeypatch.setenv("theDAW_LYRIA_PORT", "0")
    monkeypatch.setattr(
        sidecar, "_port_is_listening", lambda port, host="127.0.0.1": False
    )
    monkeypatch.setattr(sidecar, "_ensure_deps", lambda cfg: None)

    terminated: dict = {}

    class _FakeProc:
        pid = 999999

        def poll(self) -> None:
            return None

    def _terminate_stub(proc: object) -> None:
        terminated["proc"] = proc

    def _fake_popen(*args: object, **kwargs: object) -> _FakeProc:
        # Simulate stop() racing in exactly during Popen() -- the only way to
        # deterministically hit this window in a unit test.
        sidecar._stop_requested = True
        return _FakeProc()

    monkeypatch.setattr(sidecar.subprocess, "Popen", _fake_popen)
    monkeypatch.setattr(sidecar, "_terminate_proc", _terminate_stub)

    with pytest.raises(RuntimeError, match="stopped"):
        sidecar.ensure_running(wait_for_ready=False)

    assert isinstance(terminated.get("proc"), _FakeProc)
    assert sidecar._proc is None
    # The flag is consumed (read-and-cleared) by the check that caught it.
    assert sidecar._stop_requested is False


# ---------------------------------------------------------------------------
# Audit item 2 -- identity check must ignore HTTP_PROXY
# ---------------------------------------------------------------------------


def test_is_lyria_server_ignores_http_proxy_env(monkeypatch):
    with _run_server(_LyriaLikeHandler) as port:
        # Point the proxy at a closed loopback port. If _is_lyria_server
        # honoured it (plain urllib.request.urlopen does, by default), the
        # identity check would fail even though the real server answers
        # directly at 127.0.0.1:<port>.
        monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1/")
        monkeypatch.setenv("http_proxy", "http://127.0.0.1:1/")
        assert sidecar._is_lyria_server(port) is True


# ---------------------------------------------------------------------------
# Re-audit item 3 -- stop() during the readiness wait must abort immediately
# ---------------------------------------------------------------------------


def test_stop_during_readiness_wait_aborts_immediately(monkeypatch, tmp_path):
    """Before the fix, a stop() that arrives while ensure_running() is
    polling for the port to open was silently ignored until the (here,
    shortened) readiness deadline, which then raised a misleading
    "npm-install or server startup hang" message for what was actually a
    deliberate stop."""
    project = tmp_path / "lyria-project-wait-stop"
    project.mkdir()
    (project / "package.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("theDAW_LYRIA_PROJECT", str(project))
    monkeypatch.setenv("theDAW_LYRIA_PORT", "0")
    monkeypatch.setattr(sidecar, "_ensure_deps", lambda cfg: None)
    monkeypatch.setattr(
        sidecar, "_port_is_listening", lambda port, host="127.0.0.1": False
    )
    monkeypatch.setattr(sidecar, "PORT_READY_TIMEOUT_SEC", 5.0)
    monkeypatch.setattr(sidecar, "PORT_POLL_INTERVAL_SEC", 0.05)
    monkeypatch.setattr(sidecar, "_terminate_proc", lambda proc: None)

    class _FakeProc:
        pid = 424242

        def poll(self) -> None:
            return None  # never exits on its own

    monkeypatch.setattr(sidecar.subprocess, "Popen", lambda *a, **k: _FakeProc())

    result: dict = {}

    def _run() -> None:
        try:
            sidecar.ensure_running(wait_for_ready=True)
        except Exception as exc:  # captured for the assertion below
            result["error"] = exc

    thread = threading.Thread(target=_run, daemon=True)
    start = time.monotonic()
    thread.start()
    # Poll for _proc to actually be assigned (round-4 item 5) instead of a
    # blind sleep -- a fixed sleep is inherently racy: too short and stop()
    # fires before _proc exists (testing a different code path entirely),
    # too long and it pads every run.
    poll_deadline = time.monotonic() + 5.0
    while sidecar._proc is None and time.monotonic() < poll_deadline:
        time.sleep(0.01)
    assert sidecar._proc is not None, "ensure_running() never assigned _proc"
    sidecar.stop()
    thread.join(timeout=5.0)
    elapsed = time.monotonic() - start

    assert not thread.is_alive()
    assert elapsed < prompt_seconds(2.0), (
        f"ensure_running() took {elapsed:.2f}s -- a stop() during the "
        "readiness wait wasn't honoured promptly (item 3 regression)"
    )
    assert isinstance(result.get("error"), RuntimeError)
    assert str(result["error"]) == "stopped"


# ---------------------------------------------------------------------------
# Re-audit item 5 -- ensure_running() must wait for an in-progress stop()
# ---------------------------------------------------------------------------


def test_ensure_running_waits_for_stop_to_finish_before_adopting(monkeypatch):
    """While stop() is mid-teardown (_stopping set), a concurrent
    ensure_running() must not immediately adopt whatever still answers on
    the port -- it could be the dying server that stop() is killing right
    now."""
    release_terminate = threading.Event()
    terminate_started = threading.Event()

    class _FakeProc:
        pid = 777

        def poll(self) -> None:
            return None

    def _slow_terminate(proc: object) -> None:
        terminate_started.set()
        release_terminate.wait(timeout=5.0)

    monkeypatch.setattr(sidecar, "_terminate_proc", _slow_terminate)
    monkeypatch.setattr(
        sidecar, "_port_is_listening", lambda port, host="127.0.0.1": True
    )
    monkeypatch.setattr(sidecar, "_is_lyria_server", lambda port: True)

    sidecar._proc = _FakeProc()

    stop_thread = threading.Thread(target=sidecar.stop, daemon=True)
    stop_thread.start()
    assert terminate_started.wait(timeout=5.0)
    assert sidecar._stopping.is_set()

    result: dict = {}

    def _run() -> None:
        result["url"] = sidecar.ensure_running(wait_for_ready=False)

    ensure_thread = threading.Thread(target=_run, daemon=True)
    ensure_thread.start()

    # ensure_running() must still be blocked in _wait_while_stopping, not
    # already returned with an adopted (and about-to-die) URL. Poll for a
    # bounded window instead of a bare sleep-then-assert-elapsed: a fixed
    # `time.sleep(N)` followed by `elapsed >= N` is flaky by construction --
    # sleep() is a minimum, not exact, and on Windows can measure back as
    # microseconds under N (observed: 0.29699999999s < 0.3s), so the
    # assertion itself flakes independently of the behavior under test. The
    # state we actually care about -- "still blocked, _stopping still set"
    # -- is asserted directly below instead of inferred from wall-clock time.
    still_blocked_deadline = time.monotonic() + 2.0
    while (
        ensure_thread.is_alive()
        and sidecar._stopping.is_set()
        and time.monotonic() < still_blocked_deadline
    ):
        time.sleep(0.01)
    assert sidecar._stopping.is_set(), (
        "test setup broke: stop() finished tearing down before the poll "
        "window elapsed -- increase still_blocked_deadline or check "
        "release_terminate wasn't set early"
    )
    assert ensure_thread.is_alive(), (
        "ensure_running() returned while stop() was still mid-teardown -- it "
        "adopted a server that is being killed right now (item 5 regression)"
    )

    release_terminate.set()
    stop_thread.join(timeout=5.0)
    ensure_thread.join(timeout=5.0)

    assert not ensure_thread.is_alive()
    assert "url" in result


# ---------------------------------------------------------------------------
# Round-4 item 1 -- a `confirmed` result racing a stop() must be rejected
# ---------------------------------------------------------------------------


def test_probe_adoption_guarded_rejects_confirmation_racing_a_stop(monkeypatch):
    """Reproduces the exact race: stop() fires between the identity probe
    (inside _probe_adoption) and the guard's decision to trust its
    `confirmed` result. The first confirmation must be rejected because
    _stopping is set by the time the guard checks it; only once stop()
    finishes (_stopping clears) does the guard re-probe -- and by then the
    port has actually stopped listening (the dying server has exited)."""
    port_calls: list[int] = []
    identity_calls: list[int] = []

    def _fake_port_is_listening(port: int, host: str = "127.0.0.1") -> bool:
        port_calls.append(1)
        # Only the first probe still finds the (about to die) server
        # listening; by the second probe (after _wait_while_stopping
        # releases) it has actually exited.
        return len(port_calls) == 1

    def _fake_is_lyria_server(port: int) -> bool:
        identity_calls.append(1)
        # Simulate stop() landing exactly after this probe answered True but
        # before the guard's _stopping re-check.
        sidecar._stopping.set()
        return True

    monkeypatch.setattr(sidecar, "_port_is_listening", _fake_port_is_listening)
    monkeypatch.setattr(sidecar, "_is_lyria_server", _fake_is_lyria_server)

    def _clear_stopping_shortly() -> None:
        time.sleep(0.1)
        sidecar._stopping.clear()

    threading.Thread(target=_clear_stopping_shortly, daemon=True).start()

    cfg = sidecar.resolve_config()
    confirmed, collision = sidecar._probe_adoption_guarded(cfg)

    assert identity_calls == [1], "the racing confirmation must not be re-trusted"
    assert len(port_calls) == 2, "the guard must re-probe after the race is caught"
    assert confirmed is False
    assert collision is False


def test_ensure_running_does_not_adopt_dying_server_racing_a_stop(
    monkeypatch, tmp_path
):
    """End-to-end version of the race above: ensure_running() itself must
    not return the URL of a server that answered the identity probe right as
    stop() started tearing it down -- it must fall through to spawning its
    own process instead."""
    project = tmp_path / "lyria-project-race-stop"
    project.mkdir()
    (project / "package.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("theDAW_LYRIA_PROJECT", str(project))
    monkeypatch.setenv("theDAW_LYRIA_PORT", "0")
    monkeypatch.setattr(sidecar, "_ensure_deps", lambda cfg: None)

    port_calls: list[int] = []
    identity_calls: list[int] = []

    def _fake_port_is_listening(port: int, host: str = "127.0.0.1") -> bool:
        port_calls.append(1)
        return len(port_calls) == 1

    def _fake_is_lyria_server(port: int) -> bool:
        identity_calls.append(1)
        sidecar._stopping.set()
        return True

    monkeypatch.setattr(sidecar, "_port_is_listening", _fake_port_is_listening)
    monkeypatch.setattr(sidecar, "_is_lyria_server", _fake_is_lyria_server)

    def _clear_stopping_shortly() -> None:
        time.sleep(0.1)
        sidecar._stopping.clear()

    threading.Thread(target=_clear_stopping_shortly, daemon=True).start()

    class _FakeProc:
        pid = 55555

        def poll(self) -> None:
            return None

    monkeypatch.setattr(sidecar.subprocess, "Popen", lambda *a, **k: _FakeProc())

    url = sidecar.ensure_running(wait_for_ready=False)

    assert identity_calls == [1], "must not have trusted the racing confirmation"
    assert url == "http://127.0.0.1:0"
    assert sidecar._proc is not None, "must have gone on to spawn its own process"


# ---------------------------------------------------------------------------
# Round-4 item 3 -- an identity-check failure on OUR OWN live process is
# "not ready yet", not a port collision
# ---------------------------------------------------------------------------


def test_ensure_running_treats_own_child_warmup_as_not_ready(monkeypatch):
    """A slow fake child WE ALREADY OWN (as if spawned by an earlier
    ensure_running() call that returned before readiness): the port is bound
    (TCP accepts) before the identity endpoint is actually answering
    correctly yet, as can happen while Vite/Express finish startup. Because
    owns_process() is True, a failed identity check on this fresh call's
    adoption probe must NOT raise a "port already in use by another process"
    collision -- it must fall straight through to the readiness wait
    (proc_alive is already True, so no re-spawn is attempted either) and
    succeed once the child finishes starting up."""
    monkeypatch.setenv("theDAW_LYRIA_PORT", "0")
    monkeypatch.setattr(sidecar, "PORT_READY_TIMEOUT_SEC", 5.0)
    monkeypatch.setattr(sidecar, "PORT_POLL_INTERVAL_SEC", 0.05)

    class _FakeProc:
        pid = 909090

        def poll(self) -> None:
            return None

    sidecar._proc = _FakeProc()  # as if spawned by an earlier call

    # The port is "listening" (TCP-wise) the whole time, but the identity
    # endpoint only starts answering correctly after a short simulated
    # warm-up.
    warmup_deadline = time.monotonic() + 0.3
    monkeypatch.setattr(
        sidecar, "_port_is_listening", lambda port, host="127.0.0.1": True
    )
    monkeypatch.setattr(
        sidecar,
        "_is_lyria_server",
        lambda port: time.monotonic() >= warmup_deadline,
    )

    url = sidecar.ensure_running(wait_for_ready=True)

    assert url == "http://127.0.0.1:0"


def test_probe_does_not_report_collision_for_own_child_warming_up(
    monkeypatch, tmp_path
):
    """Same scenario via probe(): while we own a live child that hasn't
    finished starting up yet, probe() must not report the port-collision
    issue against our own process."""
    monkeypatch.setenv("theDAW_LYRIA_PORT", "0")

    class _FakeProc:
        pid = 909091

        def poll(self) -> None:
            return None

    sidecar._proc = _FakeProc()

    monkeypatch.setattr(
        sidecar, "_port_is_listening", lambda port, host="127.0.0.1": True
    )
    monkeypatch.setattr(sidecar, "_is_lyria_server", lambda port: False)

    out = sidecar.probe()

    assert out["listening"] is False
    assert not any("already in use" in issue for issue in out["issues"])


# ---------------------------------------------------------------------------
# Re-audit item 6 -- the network identity probe must run OUTSIDE _state_lock
# ---------------------------------------------------------------------------


def test_probe_adoption_runs_outside_state_lock(monkeypatch):
    probe_started = threading.Event()
    release_probe = threading.Event()

    def _slow_is_lyria_server(port: int) -> bool:
        probe_started.set()
        release_probe.wait(timeout=5.0)
        return True

    monkeypatch.setattr(
        sidecar, "_port_is_listening", lambda port, host="127.0.0.1": True
    )
    monkeypatch.setattr(sidecar, "_is_lyria_server", _slow_is_lyria_server)
    monkeypatch.setenv("theDAW_LYRIA_PORT", "0")

    result: dict = {}

    def _run() -> None:
        result["url"] = sidecar.ensure_running(wait_for_ready=False)

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    try:
        assert probe_started.wait(timeout=5.0)
        start = time.monotonic()
        with sidecar._state_lock:
            pass  # must acquire immediately -- proves the probe holds no lock
        elapsed = time.monotonic() - start
        assert elapsed < prompt_seconds(0.5), (
            f"_state_lock was held for {elapsed:.2f}s while the network "
            "identity probe was still running (item 6 regression)"
        )
    finally:
        release_probe.set()
        thread.join(timeout=5.0)


# ---------------------------------------------------------------------------
# Audit item 3 -- _ensure_deps must serialize against concurrent callers
# ---------------------------------------------------------------------------


def test_ensure_deps_serializes_concurrent_direct_calls(monkeypatch, tmp_path):
    """Simulates the Install button's `_install_worker` racing a second,
    independent `_ensure_deps` call (as ensure_running()'s spawn path would
    make) for the same project directory. Before the fix, neither caller
    took a lock around the node_modules check + npm install, so both could
    see node_modules missing and both run `npm install` concurrently."""
    project = tmp_path / "lyria-project-race"
    project.mkdir()
    monkeypatch.setenv("theDAW_LYRIA_PROJECT", str(project))

    install_calls: list[list[str]] = []
    call_lock = threading.Lock()
    first_call_started = threading.Event()
    release_first_call = threading.Event()
    node_modules = project / "node_modules"
    lock_held_during_install = threading.Event()

    def _fake_subprocess_call(cmd: list[str], **kwargs: object) -> int:
        with call_lock:
            install_calls.append(cmd)
            is_first = len(install_calls) == 1
        if is_first:
            # Real contention proof (item 8): _spawn_lock must actually be
            # engaged right now, not just "no one happened to race in".
            if sidecar._spawn_lock.locked():
                lock_held_during_install.set()
            first_call_started.set()
            release_first_call.wait(timeout=5.0)
        node_modules.mkdir(exist_ok=True)
        return 0

    monkeypatch.setattr(sidecar.subprocess, "call", _fake_subprocess_call)

    cfg = sidecar.resolve_config()
    results: list[str] = []
    start_barrier = threading.Barrier(2, timeout=5.0)

    def _run() -> None:
        start_barrier.wait()
        sidecar._ensure_deps(cfg)
        results.append("done")

    t1 = threading.Thread(target=_run, daemon=True)
    t2 = threading.Thread(target=_run, daemon=True)
    # Both threads pass the barrier at (as close as possible to) the same
    # instant, so which one wins _spawn_lock is genuine contention rather
    # than one thread simply being started well before the other.
    t1.start()
    t2.start()
    assert first_call_started.wait(timeout=5.0)
    assert lock_held_during_install.is_set(), (
        "no real _spawn_lock contention was observed"
    )

    # The second thread must be blocked on _spawn_lock here -- node_modules
    # doesn't exist yet, so without the lock it would ALSO invoke
    # subprocess.call concurrently.
    time.sleep(0.3)
    with call_lock:
        assert len(install_calls) == 1, (
            f"expected exactly 1 npm install call while the first is still "
            f"running, got {len(install_calls)} (item 3 regression)"
        )

    release_first_call.set()
    t1.join(timeout=5.0)
    t2.join(timeout=5.0)

    assert results == ["done", "done"]
    with call_lock:
        # t2 must see node_modules now exists (created by t1) and return
        # without calling npm install again.
        assert len(install_calls) == 1


# ---------------------------------------------------------------------------
# Audit item 4 -- lyria/router.py routes must offload to a thread
# ---------------------------------------------------------------------------


def _fake_config() -> sidecar.LyriaConfig:
    return sidecar.LyriaConfig(
        project_path=sidecar.DEFAULT_PROJECT_PATH,
        port=5188,
        npm_path="npm",
        mock=True,
    )


def _loopback_request():
    """This machine's own UI asking: the peer the read routes take."""
    from starlette.requests import Request

    return Request({"type": "http", "headers": [], "client": ("127.0.0.1", 51000)})


def test_url_route_offloads_running_url_via_to_thread(monkeypatch):
    """GET /url reads the running URL and never calls ensure_running: the
    spawn moved behind POST /start."""
    from backend.modules.lyria import router as lyria_router

    calls: list[object] = []

    async def _recording_to_thread(fn, *args, **kwargs):
        calls.append(fn)
        return fn(*args, **kwargs)

    def _never_spawn(**k):
        raise AssertionError("GET /url must not spawn")

    monkeypatch.setattr(lyria_router.asyncio, "to_thread", _recording_to_thread)
    monkeypatch.setattr(lyria_router, "_maybe_auto_spawn", lambda: None)
    monkeypatch.setattr(sidecar, "ensure_running", _never_spawn)
    monkeypatch.setattr(sidecar, "running_url", lambda: "http://127.0.0.1:5188")
    monkeypatch.setattr(sidecar, "resolve_config", _fake_config)
    monkeypatch.setattr(sidecar, "detect_lan_ip", lambda: None)
    monkeypatch.setattr(sidecar, "owns_process", lambda: True)

    result = asyncio.run(lyria_router.url(_loopback_request()))

    assert sidecar.running_url in calls
    assert result["url"] == "http://127.0.0.1:5188"


def test_status_route_offloads_probe_via_to_thread(monkeypatch):
    from backend.modules.lyria import router as lyria_router

    calls: list[object] = []

    async def _recording_to_thread(fn, *args, **kwargs):
        calls.append(fn)
        return fn(*args, **kwargs)

    monkeypatch.setattr(lyria_router.asyncio, "to_thread", _recording_to_thread)
    monkeypatch.setattr(lyria_router, "_maybe_auto_spawn", lambda: None)
    monkeypatch.setattr(sidecar, "probe", lambda: {"issues": [], "listening": True})

    result = asyncio.run(lyria_router.status(_loopback_request()))

    assert sidecar.probe in calls
    assert result["ok"] is True


def test_start_route_offloads_ensure_running_via_to_thread(monkeypatch):
    from backend.modules.lyria import router as lyria_router

    calls: list[object] = []

    async def _recording_to_thread(fn, *args, **kwargs):
        calls.append(fn)
        return fn(*args, **kwargs)

    monkeypatch.setattr(lyria_router.asyncio, "to_thread", _recording_to_thread)
    monkeypatch.setattr(sidecar, "ensure_running", lambda **k: "http://127.0.0.1:5188")

    result = asyncio.run(lyria_router.start())

    assert sidecar.ensure_running in calls
    assert result == {"ok": True, "url": "http://127.0.0.1:5188"}


# ---------------------------------------------------------------------------
# Re-audit item 1 -- /stop, POST /key, and /url's owns_process() must also
# offload to a thread (stop() can taskkill+wait for ~10s worst case)
# ---------------------------------------------------------------------------


def test_stop_route_offloads_sidecar_stop_via_to_thread(monkeypatch):
    from backend.modules.lyria import router as lyria_router

    calls: list[object] = []

    async def _recording_to_thread(fn, *args, **kwargs):
        calls.append(fn)
        return fn(*args, **kwargs)

    monkeypatch.setattr(lyria_router.asyncio, "to_thread", _recording_to_thread)
    monkeypatch.setattr(sidecar, "stop", lambda: True)

    result = asyncio.run(lyria_router.stop())

    assert sidecar.stop in calls
    assert result == {"ok": True, "stopped": True}


def test_key_post_route_offloads_sidecar_stop_via_to_thread(monkeypatch):
    from backend.modules.lyria import router as lyria_router

    calls: list[object] = []

    async def _recording_to_thread(fn, *args, **kwargs):
        calls.append(fn)
        return fn(*args, **kwargs)

    monkeypatch.setattr(lyria_router.asyncio, "to_thread", _recording_to_thread)
    monkeypatch.setattr(sidecar, "set_gemini_key", lambda key: None)
    monkeypatch.setattr(sidecar, "stop", lambda: True)
    monkeypatch.setattr(sidecar, "gemini_key", lambda: ("sk-abc123", "file"))

    result = asyncio.run(lyria_router.set_key(key="sk-abc123456"))

    assert sidecar.stop in calls
    assert result["restarted"] is True


def test_url_route_offloads_owns_process_via_to_thread(monkeypatch):
    from backend.modules.lyria import router as lyria_router

    calls: list[object] = []

    async def _recording_to_thread(fn, *args, **kwargs):
        calls.append(fn)
        return fn(*args, **kwargs)

    monkeypatch.setattr(lyria_router.asyncio, "to_thread", _recording_to_thread)
    monkeypatch.setattr(lyria_router, "_maybe_auto_spawn", lambda: None)
    monkeypatch.setattr(sidecar, "running_url", lambda: "http://127.0.0.1:5188")
    monkeypatch.setattr(sidecar, "resolve_config", _fake_config)
    monkeypatch.setattr(sidecar, "detect_lan_ip", lambda: None)
    monkeypatch.setattr(sidecar, "owns_process", lambda: True)

    result = asyncio.run(lyria_router.url(_loopback_request()))

    assert sidecar.owns_process in calls
    assert result["mode"] == "mock"


# ---------------------------------------------------------------------------
# Audit item 5 -- an adopted-but-not-owned listener must not claim mock/live
# ---------------------------------------------------------------------------


def test_url_route_reports_external_when_not_owned(monkeypatch):
    from backend.modules.lyria import router as lyria_router

    async def _identity_to_thread(fn, *args, **kwargs):
        return fn(*args, **kwargs)

    monkeypatch.setattr(lyria_router.asyncio, "to_thread", _identity_to_thread)
    monkeypatch.setattr(lyria_router, "_maybe_auto_spawn", lambda: None)
    monkeypatch.setattr(sidecar, "running_url", lambda: "http://127.0.0.1:5188")
    monkeypatch.setattr(sidecar, "resolve_config", _fake_config)
    monkeypatch.setattr(sidecar, "detect_lan_ip", lambda: None)
    monkeypatch.setattr(sidecar, "owns_process", lambda: False)

    result = asyncio.run(lyria_router.url(_loopback_request()))

    assert result["mode"] == "external"
    assert result["mock"] is None
    assert result["external"] is True


def test_url_route_reports_mock_mode_when_owned(monkeypatch):
    from backend.modules.lyria import router as lyria_router

    async def _identity_to_thread(fn, *args, **kwargs):
        return fn(*args, **kwargs)

    monkeypatch.setattr(lyria_router.asyncio, "to_thread", _identity_to_thread)
    monkeypatch.setattr(lyria_router, "_maybe_auto_spawn", lambda: None)
    monkeypatch.setattr(sidecar, "running_url", lambda: "http://127.0.0.1:5188")
    monkeypatch.setattr(sidecar, "resolve_config", _fake_config)
    monkeypatch.setattr(sidecar, "detect_lan_ip", lambda: None)
    monkeypatch.setattr(sidecar, "owns_process", lambda: True)

    result = asyncio.run(lyria_router.url(_loopback_request()))

    assert result["mode"] == "mock"
    assert result["mock"] is True
    assert result["external"] is False


def test_owns_process_false_for_adopted_listener(monkeypatch):
    with _run_server(_LyriaLikeHandler) as port:
        monkeypatch.setenv("theDAW_LYRIA_PORT", str(port))
        # No _proc handle -- ensure_running() would adopt this listener
        # (INT-001), but the module never spawned it.
        assert sidecar.owns_process() is False


def test_lyria_provider_status_external_process_does_not_claim_mock(monkeypatch):
    from backend.modules.storage import router

    def _fake_probe():
        return {
            "project_path": "/fake/lyria",
            "issues": [],
            "missing": [],
            "install": {},
            "gemini_key": True,
            "gemini_key_source": "env",
            "listening": True,
            "process_alive": False,  # confirmed listening, but NOT our _proc
            "repo": sidecar.LYRIA_REPO,
            "repo_url": sidecar.LYRIA_REPO_URL,
            "git": True,
            "node": True,
            "npm": True,
            "installable": True,
        }

    monkeypatch.setattr(sidecar, "probe", _fake_probe)
    monkeypatch.setattr(sidecar, "is_mock", lambda: True)

    status = router._lyria_provider_status()
    assert status["state"] == "ready"
    assert "Mock mode" not in status["summary"]
    assert "Live mode" not in status["summary"]
    assert "unknown" in status["summary"].lower()
    assert status["lyria"]["external"] is True
    assert "external" in status["models"][0]["reason"].lower()


# ---------------------------------------------------------------------------
# Audit item 6 -- ready + live mode + no key must still warn in the summary
# ---------------------------------------------------------------------------


def test_lyria_provider_status_warns_missing_key_in_live_mode_when_ready(
    monkeypatch,
):
    from backend.modules.storage import router

    def _fake_probe():
        return {
            "project_path": "/fake/lyria",
            "issues": [],
            "missing": ["key"],
            "install": {},
            "gemini_key": False,
            "gemini_key_source": "none",
            "listening": True,
            "process_alive": True,
            "repo": sidecar.LYRIA_REPO,
            "repo_url": sidecar.LYRIA_REPO_URL,
            "git": True,
            "node": True,
            "npm": True,
            "installable": True,
        }

    monkeypatch.setattr(sidecar, "probe", _fake_probe)
    monkeypatch.setattr(sidecar, "is_mock", lambda: False)  # live mode

    status = router._lyria_provider_status()
    assert status["state"] == "ready"
    assert "Live mode" in status["summary"]
    assert "GEMINI_API_KEY is not set" in status["summary"]


# ---------------------------------------------------------------------------
# Audit item 7 -- concurrent ensure_running() installs once, spawns once
# ---------------------------------------------------------------------------


def test_concurrent_ensure_running_installs_once_and_spawns_once(monkeypatch, tmp_path):
    project = tmp_path / "lyria-project-concurrent"
    project.mkdir()
    (project / "package.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("theDAW_LYRIA_PROJECT", str(project))
    monkeypatch.setenv("theDAW_LYRIA_PORT", "0")
    monkeypatch.setattr(
        sidecar, "_port_is_listening", lambda port, host="127.0.0.1": False
    )

    ensure_deps_calls: list[int] = []
    popen_calls: list[int] = []
    call_lock = threading.Lock()
    lock_held_during_install = threading.Event()

    def _fake_ensure_deps(cfg: sidecar.LyriaConfig) -> None:
        with call_lock:
            ensure_deps_calls.append(1)
        # Real contention proof (item 8): _run_lock must actually be engaged
        # right now -- not just "the other threads happened not to race in".
        if sidecar._run_lock.locked():
            lock_held_during_install.set()
        # Give other threads a chance to race in while this "install" runs.
        time.sleep(0.2)

    class _FakeProc:
        pid = 12345

        def poll(self) -> None:
            return None

    def _fake_popen(*args: object, **kwargs: object) -> _FakeProc:
        with call_lock:
            popen_calls.append(1)
        return _FakeProc()

    monkeypatch.setattr(sidecar, "_ensure_deps", _fake_ensure_deps)
    monkeypatch.setattr(sidecar.subprocess, "Popen", _fake_popen)

    n = 3
    start_barrier = threading.Barrier(n, timeout=5.0)
    results: list[object] = []
    results_lock = threading.Lock()

    def _run() -> None:
        # All callers reach ensure_running() at (as close as possible to)
        # the same instant, so "only one install, one spawn" reflects real
        # contention on _run_lock/_spawn_lock rather than lucky timing.
        start_barrier.wait()
        try:
            url = sidecar.ensure_running(wait_for_ready=False)
        except Exception as exc:  # captured for the assertion below
            url = exc
        with results_lock:
            results.append(url)

    threads = [threading.Thread(target=_run, daemon=True) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5.0)

    assert len(ensure_deps_calls) == 1, (
        f"expected exactly 1 _ensure_deps call, got {len(ensure_deps_calls)}"
    )
    assert len(popen_calls) == 1, (
        f"expected exactly 1 Popen call, got {len(popen_calls)}"
    )
    assert lock_held_during_install.is_set(), (
        "no real _run_lock contention was observed"
    )
    assert results == ["http://127.0.0.1:0"] * n


# ---------------------------------------------------------------------------
# Provider keys -- one key per variable for every checkout, the rest of the
# ordered list in the numbered _2 .. _10 slots only for a checkout whose
# server/keys.ts reads them, and the assistant's pool only when shared.
# ---------------------------------------------------------------------------


_KEY_VARS = ("GEMINI_API_KEY", "OPENROUTER_API_KEY")
_NUMBERED = tuple(f"{var}_{n}" for var in _KEY_VARS for n in range(2, 12))


@pytest.fixture
def lyria_keys(tmp_path, monkeypatch):
    """Isolate the key file, the provider environment variables (numbered
    slots included) and the assistant's key pool, so these tests never read
    or write the real ones."""
    from backend.key_pool import key_pool

    path = tmp_path / "lyria_gemini_key.json"
    monkeypatch.setattr(sidecar, "_KEY_FILE", path)
    monkeypatch.setattr(
        sidecar, "_KEY_FILE_BACKUP", tmp_path / "lyria_gemini_key.json.bak"
    )
    monkeypatch.setattr(
        sidecar, "_DEPS_PENDING_FILE", tmp_path / "lyria_deps_pending.json"
    )
    monkeypatch.setattr(
        sidecar, "_CHECKOUT_RECORD_FILE", tmp_path / "lyria_checkout.json"
    )
    for var in (*_KEY_VARS, *_NUMBERED, "AI_PROVIDER", "theDAW_LYRIA_PROJECT"):
        monkeypatch.delenv(var, raising=False)
    pools: dict[str, list[str]] = {}
    monkeypatch.setattr(
        key_pool, "get_raw_keys", lambda provider: list(pools.get(provider, []))
    )
    return SimpleNamespace(path=path, backup=sidecar._KEY_FILE_BACKUP, pools=pools)


# The package.json of the Lyria repo (its name and version at 192032e), which a
# checkout has to carry before the sidecar hands it keys (verify_checkout).
_LYRIA_PACKAGE_JSON = '{"name": "lyria-3-pro", "version": "0.0.0"}\n'


def _old_checkout(root) -> object:
    """A Lyria checkout from before server/keys.ts, shaped like the user's own
    lyria/ at 192032e: server.ts reads GEMINI_API_KEY as ONE key."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "package.json").write_text(_LYRIA_PACKAGE_JSON, encoding="utf-8")
    (root / "server.ts").write_text(
        "const key = clientKey || process.env.GEMINI_API_KEY;\n"
        "return clientKey || process.env.OPENROUTER_API_KEY;\n",
        encoding="utf-8",
    )
    return root


def _list_checkout(root) -> object:
    """A checkout shaped like the Lyria repo's head at ef8b16f: server/keys.ts
    defines numberedEnvValues with its default max of 10, and server.ts reads
    the numbered slots of both provider variables with it (the lines are
    those of that commit's server/keys.ts:60 and server.ts:9, :60-:71)."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "package.json").write_text(_LYRIA_PACKAGE_JSON, encoding="utf-8")
    (root / "server").mkdir(exist_ok=True)
    (root / "server" / "keys.ts").write_text(
        "export function numberedEnvValues(env: NodeJS.ProcessEnv, prefix: "
        "string, max = 10): string[] {\n",
        encoding="utf-8",
    )
    (root / "server.ts").write_text(
        "import { resolveKeys, numberedEnvValues, withKeyFailover, "
        'AllKeysFailedError } from "./server/keys";\n'
        "    env: process.env.GEMINI_API_KEY,\n"
        "    numberedEnv: numberedEnvValues(process.env, 'GEMINI_API_KEY'),\n"
        "    env: process.env.OPENROUTER_API_KEY,\n"
        "    numberedEnv: numberedEnvValues(process.env, 'OPENROUTER_API_KEY'),\n",
        encoding="utf-8",
    )
    return root


def _cfg(project) -> sidecar.LyriaConfig:
    return sidecar.LyriaConfig(
        project_path=project, port=5188, npm_path="npm", mock=True
    )


def _key_slots(env: dict[str, str]) -> dict[str, str]:
    return {k: v for k, v in env.items() if k in _KEY_VARS or k in _NUMBERED}


def test_old_checkout_gets_exactly_one_key_per_variable(
    lyria_keys, tmp_path, monkeypatch
):
    """The sequence that broke every live request on an older install: keys
    from the environment AND the Lyria card, then a spawn from a checkout
    without server/keys.ts. Each variable must hold ONE key -- a comma list is
    sent to Google as a single invalid key -- and no numbered slot is set."""
    monkeypatch.setenv("GEMINI_API_KEY", "env-g1, env-g2")
    monkeypatch.setenv("OPENROUTER_API_KEY", "env-o1")
    sidecar.add_key("gemini", "file-g1")
    sidecar.add_key("openrouter", "file-o1")
    project = _old_checkout(tmp_path / "old")

    assert sidecar.checkout_reads_key_lists(project) is False
    env = sidecar._child_env(_cfg(project))

    assert _key_slots(env) == {
        "GEMINI_API_KEY": "env-g1",
        "OPENROUTER_API_KEY": "env-o1",
    }


def test_list_checkout_gets_the_first_key_then_numbered_slots(
    lyria_keys, tmp_path, monkeypatch
):
    """A checkout with server/keys.ts reads GEMINI_API_KEY plus _2.._10, so
    the ordered list (env, then the card) goes there, de-duplicated, with the
    unnumbered variable still holding a single key."""
    monkeypatch.setenv("GEMINI_API_KEY", "env-g1, env-g2")
    monkeypatch.setenv("OPENROUTER_API_KEY", "env-o1")
    sidecar.add_key("gemini", "file-g1")
    sidecar.add_key("gemini", "env-g1")  # already in the env: appears once
    sidecar.add_key("openrouter", "file-o1")
    project = _list_checkout(tmp_path / "lists")

    assert sidecar.checkout_reads_key_lists(project) is True
    env = sidecar._child_env(_cfg(project))

    assert _key_slots(env) == {
        "GEMINI_API_KEY": "env-g1",
        "GEMINI_API_KEY_2": "env-g2",
        "GEMINI_API_KEY_3": "file-g1",
        "OPENROUTER_API_KEY": "env-o1",
        "OPENROUTER_API_KEY_2": "file-o1",
    }


def test_list_checkout_takes_at_most_ten_keys(lyria_keys, tmp_path, caplog):
    """numberedEnvValues stops at _10, so an eleventh key has no slot. The log
    line says how many were handed out of how many are held."""
    for n in range(1, 13):
        sidecar.add_key("gemini", f"gemini-key-{n:02d}")
    project = _list_checkout(tmp_path / "lists")

    with caplog.at_level("INFO"):
        env = sidecar._child_env(_cfg(project))

    assert env["GEMINI_API_KEY"] == "gemini-key-01"
    assert env["GEMINI_API_KEY_10"] == "gemini-key-10"
    assert "GEMINI_API_KEY_11" not in env
    assert "gemini=10/12" in caplog.text


def test_inherited_numbered_slots_are_folded_in_and_cleared(
    lyria_keys, tmp_path, monkeypatch
):
    """A GEMINI_API_KEY_2 set in the shell is one of the environment's keys:
    a list-reading checkout still gets it (in its list position), and an old
    checkout gets nothing numbered, not even the inherited value."""
    monkeypatch.setenv("GEMINI_API_KEY", "shell-g1")
    monkeypatch.setenv("GEMINI_API_KEY_2", "shell-g2")
    monkeypatch.setenv("OPENROUTER_API_KEY_7", "shell-o7")
    sidecar.add_key("gemini", "file-g1")

    assert sidecar.env_keys("gemini") == ["shell-g1", "shell-g2"]
    listed = sidecar._child_env(_cfg(_list_checkout(tmp_path / "lists")))
    assert _key_slots(listed) == {
        "GEMINI_API_KEY": "shell-g1",
        "GEMINI_API_KEY_2": "shell-g2",
        "GEMINI_API_KEY_3": "file-g1",
        "OPENROUTER_API_KEY": "shell-o7",
    }
    old = sidecar._child_env(_cfg(_old_checkout(tmp_path / "old")))
    assert _key_slots(old) == {
        "GEMINI_API_KEY": "shell-g1",
        "OPENROUTER_API_KEY": "shell-o7",
    }


def test_pool_keys_stay_with_the_assistant_until_the_user_shares_them(
    lyria_keys, tmp_path
):
    """The assistant's pool is filled; nothing else is. The child gets the
    pool's FIRST Gemini key and nothing from OpenRouter, as theDAW has always
    handed it. A key saved in the card replaces that fallback. Only after the
    user turns on the pool switch do every pooled Gemini, OpenRouter and
    openrouter-free key follow, and turning it off takes them back."""
    lyria_keys.pools["gemini"] = ["pool-g1", "pool-g2"]
    lyria_keys.pools["openrouter"] = ["pool-o1"]
    lyria_keys.pools["openrouter-free"] = ["pool-of1", "pool-o1"]
    project = _list_checkout(tmp_path / "lists")

    assert _key_slots(sidecar._child_env(_cfg(project))) == {
        "GEMINI_API_KEY": "pool-g1"
    }

    sidecar.add_key("gemini", "file-g1")
    assert _key_slots(sidecar._child_env(_cfg(project))) == {
        "GEMINI_API_KEY": "file-g1"
    }

    assert sidecar.set_pool_shared(True) is True
    assert _key_slots(sidecar._child_env(_cfg(project))) == {
        "GEMINI_API_KEY": "file-g1",
        "GEMINI_API_KEY_2": "pool-g1",
        "GEMINI_API_KEY_3": "pool-g2",
        "OPENROUTER_API_KEY": "pool-o1",
        "OPENROUTER_API_KEY_2": "pool-of1",
    }

    assert sidecar.set_pool_shared(False) is False
    assert _key_slots(sidecar._child_env(_cfg(project))) == {
        "GEMINI_API_KEY": "file-g1"
    }


def test_a_hand_edited_share_flag_that_is_not_true_does_not_share(lyria_keys):
    lyria_keys.path.write_text(
        json.dumps({"version": 2, "providers": {}, "share_pool": "yes"}),
        encoding="utf-8",
    )
    lyria_keys.pools["openrouter"] = ["pool-o1"]
    assert sidecar.pool_shared() is False
    assert sidecar.resolved_keys("openrouter") == ([], "none")


def test_child_env_drops_blanks_and_unsets_a_provider_with_no_keys(
    lyria_keys, tmp_path, monkeypatch
):
    monkeypatch.setenv("GEMINI_API_KEY", "  ,  ")
    monkeypatch.setenv("OPENROUTER_API_KEY", "env-o1,,env-o2\nenv-o3")

    old = sidecar._child_env(_cfg(_old_checkout(tmp_path / "old")))
    listed = sidecar._child_env(_cfg(_list_checkout(tmp_path / "lists")))

    # A whitespace-only inherited value must not reach the child as a "key".
    assert "GEMINI_API_KEY" not in old and "GEMINI_API_KEY" not in listed
    assert _key_slots(old) == {"OPENROUTER_API_KEY": "env-o1"}
    assert _key_slots(listed) == {
        "OPENROUTER_API_KEY": "env-o1",
        "OPENROUTER_API_KEY_2": "env-o2",
        "OPENROUTER_API_KEY_3": "env-o3",
    }


def test_child_env_never_logs_key_values(lyria_keys, tmp_path, monkeypatch, caplog):
    monkeypatch.setenv("GEMINI_API_KEY", "secret-gemini-value,secret-gemini-two")
    monkeypatch.setenv("OPENROUTER_API_KEY", "secret-openrouter-value")
    with caplog.at_level("DEBUG"):
        sidecar._child_env(_cfg(_list_checkout(tmp_path / "lists")))
    assert "secret-gemini-value" not in caplog.text
    assert "secret-gemini-two" not in caplog.text
    assert "secret-openrouter-value" not in caplog.text


def test_legacy_single_gemini_key_file_migrates_on_read(lyria_keys):
    """The old single-key file keeps working: its key becomes the FIRST
    Gemini entry, so the key the user already saved is still tried first."""
    lyria_keys.path.write_text(json.dumps({"key": "legacy-g1"}), encoding="utf-8")

    assert sidecar.stored_keys("gemini") == ["legacy-g1"]
    assert sidecar.stored_keys("openrouter") == []
    assert sidecar.gemini_key() == ("legacy-g1", "file")


def test_migration_backs_the_legacy_file_up_before_rewriting_it(lyria_keys):
    lyria_keys.path.write_text(json.dumps({"key": "legacy-g1"}), encoding="utf-8")

    sidecar.add_key("gemini", "added-g2")

    written = json.loads(lyria_keys.path.read_text(encoding="utf-8"))
    assert written["providers"]["gemini"] == ["legacy-g1", "added-g2"]
    assert written["providers"]["openrouter"] == []
    assert written["version"] == sidecar._KEY_FILE_VERSION
    assert written["share_pool"] is False
    # The user's original file is not simply gone.
    assert json.loads(lyria_keys.backup.read_text(encoding="utf-8")) == {
        "key": "legacy-g1"
    }


def _main_build_gemini_key(path) -> str:
    """What an older theDAW build reads from the key file -- the expression in
    upstream/main:backend/modules/lyria/sidecar.py gemini_key():
    ``json.loads(_GEMINI_KEY_FILE.read_text(encoding="utf-8")).get("key")``."""
    return (json.loads(path.read_text(encoding="utf-8")).get("key") or "").strip()


def _main_build_set_key(path, key: str) -> None:
    """upstream/main's set_gemini_key: it replaces the whole file."""
    path.write_text(json.dumps({"key": key.strip()}), encoding="utf-8")


def test_an_older_build_still_finds_the_gemini_key_after_this_build_writes(
    lyria_keys,
):
    """main saved a Gemini key; this build adds an OpenRouter key (rewriting
    the file in the per-provider shape); the user opens an older build again.
    That build must still find the Gemini key it saved. Then the older build
    saves a new key over the file, and this build reads it back."""
    _main_build_set_key(lyria_keys.path, "main-g1")

    sidecar.add_key("openrouter", "this-o1")
    assert _main_build_gemini_key(lyria_keys.path) == "main-g1"

    sidecar.remove_key("gemini", 0)
    assert "key" not in json.loads(lyria_keys.path.read_text(encoding="utf-8"))
    sidecar.add_key("gemini", "this-g2")
    assert _main_build_gemini_key(lyria_keys.path) == "this-g2"

    _main_build_set_key(lyria_keys.path, "main-g3")
    # main's key goes first; the keys this build saved stay behind it.
    assert sidecar.stored_keys("gemini") == ["main-g3", "this-g2"]
    assert sidecar.stored_keys("openrouter") == ["this-o1"]
    assert sidecar.gemini_key() == ("main-g3", "file")


def _main_build(path, monkeypatch) -> object:
    """upstream/main's own Lyria sidecar module (a verbatim copy in
    tests/fixtures/main_851f6a0), its key file pointed at ``path``. Listed in
    sys.modules while the test runs, as an import would: its dataclasses look
    their module up there."""
    import importlib.util
    from pathlib import Path

    source = Path(__file__).parent / "fixtures" / "main_851f6a0" / "lyria_sidecar.py"
    spec = importlib.util.spec_from_file_location("lyria_sidecar_main_851f6a0", source)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    module._GEMINI_KEY_FILE = path
    return module


def test_keys_saved_here_survive_main_saving_and_clearing_its_key(
    lyria_keys, monkeypatch
):
    """The user keeps two Gemini keys, an OpenRouter key, a provider choice
    and the pool share in this build, then runs main. main's POST /key wrote
    ``{"key": ...}`` over the whole file, so every other key and choice was
    gone when this build opened again; main's DELETE /key unlinked the file,
    OpenRouter key and all. Both now land on the keys this build keeps."""
    sidecar.add_key("gemini", "this-g1")
    sidecar.add_key("gemini", "this-g2")
    sidecar.add_key("openrouter", "this-o1")
    sidecar.set_provider_preference("openrouter")
    sidecar.set_pool_shared(True)

    main = _main_build(lyria_keys.path, monkeypatch)
    assert main.gemini_key() == ("this-g1", "file")
    main.set_gemini_key("main-g3")

    assert sidecar.stored_keys("gemini") == ["main-g3", "this-g1", "this-g2"]
    assert sidecar.stored_keys("openrouter") == ["this-o1"]
    assert sidecar.provider_preference() == "openrouter"
    assert sidecar.pool_shared() is True

    # This build writes again; main still reads the key it saved.
    sidecar.add_key("openrouter", "this-o2")
    assert main.gemini_key() == ("main-g3", "file")

    # main forgets its key: every Gemini key goes, as this build's own
    # DELETE /api/lyria/key does, and nothing else does.
    assert main.clear_gemini_key() is True
    assert sidecar.stored_keys("gemini") == []
    assert sidecar.stored_keys("openrouter") == ["this-o1", "this-o2"]
    assert sidecar.provider_preference() == "openrouter"

    sidecar.add_key("gemini", "this-g4")
    assert main.gemini_key() == ("this-g4", "file")
    assert sidecar.stored_keys("openrouter") == ["this-o1", "this-o2"]


def test_gemini_keys_main_deleted_stay_deleted_when_main_saves_a_new_one(
    lyria_keys, monkeypatch
):
    """The user saves two Gemini keys here, deletes the Gemini key in main
    (main unlinks the file), opens this build, then saves a fresh key in main.
    The two deleted keys came back behind the fresh one: the copy beside the
    key file still held them, and main's fresh file read as "main saved over
    this build's keys"."""
    sidecar.add_key("gemini", "revoked-1")
    sidecar.add_key("gemini", "revoked-2")
    sidecar.add_key("openrouter", "this-o1")

    main = _main_build(lyria_keys.path, monkeypatch)
    assert main.clear_gemini_key() is True
    assert sidecar.stored_keys("gemini") == []

    main.set_gemini_key("fresh")
    assert sidecar.stored_keys("gemini") == ["fresh"]
    assert sidecar.stored_keys("openrouter") == ["this-o1"]
    assert sidecar.gemini_key() == ("fresh", "file")

    # This build writes again; main still reads the key it saved.
    sidecar.add_key("openrouter", "this-o2")
    assert main.gemini_key() == ("fresh", "file")
    assert sidecar.stored_keys("gemini") == ["fresh"]


def _build_8039b45(path, monkeypatch) -> object:
    """8039b45's own Lyria sidecar module (a verbatim copy in
    tests/fixtures/pr207_8039b45), its key file pointed at ``path``: the first
    multi-key build, which writes the whole per-provider store over the key
    file in place, without ``key`` or ``share_pool``."""
    import importlib.util
    from pathlib import Path

    source = Path(__file__).parent / "fixtures" / "pr207_8039b45" / "lyria_sidecar.py"
    spec = importlib.util.spec_from_file_location("lyria_sidecar_8039b45", source)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    module._KEY_FILE = path
    module._KEY_FILE_BACKUP = path.with_name(path.name + ".8039b45.bak")
    return module


@pytest.fixture
def builds(lyria_keys, monkeypatch):
    """The three builds that write data/lyria_gemini_key.json, all pointed at
    one key file: main (851f6a0), 8039b45, and this build (``sidecar``)."""
    return SimpleNamespace(
        main=_main_build(lyria_keys.path, monkeypatch),
        old=_build_8039b45(lyria_keys.path, monkeypatch),
        path=lyria_keys.path,
        copy=lyria_keys.path.with_name("lyria_provider_keys.json"),
    )


def _this_build_state() -> dict:
    return {
        "gemini": sidecar.stored_keys("gemini"),
        "openrouter": sidecar.stored_keys("openrouter"),
        "preference": sidecar.provider_preference(),
        "share": sidecar.pool_shared(),
    }


def _assert_every_build_agrees(builds) -> None:
    """After this build has read the files: main finds the first Gemini key,
    8039b45 finds every list and the preference, and the copy's record
    matches the key file, so the next read is this build's own write."""
    state = _this_build_state()
    first = state["gemini"][0] if state["gemini"] else None
    assert builds.main.gemini_key() == ((first, "file") if first else (None, "none"))
    for provider in ("gemini", "openrouter"):
        assert builds.old.stored_keys(provider) == state[provider], provider
    assert builds.old.provider_preference() == state["preference"]
    copy = json.loads(builds.copy.read_text(encoding="utf-8"))
    digest = hashlib.sha256(builds.path.read_bytes()).hexdigest()
    assert copy["key_file"]["sha256"] == digest


def _this_build_saves_everything() -> None:
    sidecar.add_key("gemini", "this-g1")
    sidecar.add_key("gemini", "this-g2")
    sidecar.add_key("openrouter", "this-o1")
    sidecar.set_provider_preference("openrouter")
    sidecar.set_pool_shared(True)


def test_main_deletes_then_saves_without_this_build_opening_between(builds):
    """This build -> main DELETE -> main POST -> this build. main unlinked the
    file and wrote a fresh one; this build never saw the missing file. The
    fresh file has a new identity, which only a delete produces, so the
    deleted Gemini keys stay deleted and everything else stays."""
    _this_build_saves_everything()

    assert builds.main.clear_gemini_key() is True
    builds.main.set_gemini_key("fresh")

    assert _this_build_state() == {
        "gemini": ["fresh"],
        "openrouter": ["this-o1"],
        "preference": "openrouter",
        "share": True,
    }
    _assert_every_build_agrees(builds)


def test_main_saves_twice_without_this_build_opening_between(builds):
    """This build -> main POST x2 -> this build. main's second key replaced
    its first, as it does in main; the keys main never saw stay behind it."""
    _this_build_saves_everything()

    builds.main.set_gemini_key("main-x")
    builds.main.set_gemini_key("main-y")

    assert _this_build_state()["gemini"] == ["main-y", "this-g1", "this-g2"]
    assert _this_build_state()["openrouter"] == ["this-o1"]
    _assert_every_build_agrees(builds)


def test_main_saves_and_this_build_reading_hands_8039b45_every_list(builds):
    """This build -> main POST -> this build reads only (the Settings card
    opens) -> 8039b45. The read writes main's key back into the full store,
    so 8039b45 opens on every list instead of main's one key."""
    _this_build_saves_everything()
    builds.main.set_gemini_key("main-x")

    assert sidecar.stored_keys("gemini") == ["main-x", "this-g1", "this-g2"]

    assert builds.old.stored_keys("gemini") == ["main-x", "this-g1", "this-g2"]
    assert builds.old.stored_keys("openrouter") == ["this-o1"]
    assert builds.main.gemini_key() == ("main-x", "file")


def test_8039b45_edits_after_this_build_replace_its_lists(builds):
    """This build -> 8039b45 (removes the OpenRouter key, adds a Gemini key,
    clears the preference) -> this build. 8039b45 read every list, so what it
    wrote is the user's decision; the pool switch, which 8039b45 does not
    know, stays."""
    _this_build_saves_everything()

    assert builds.old.stored_keys("openrouter") == ["this-o1"]
    assert builds.old.remove_key("openrouter", 0) is True
    builds.old.add_key("gemini", "old-g3")
    builds.old.set_provider_preference(None)

    assert _this_build_state() == {
        "gemini": ["this-g1", "this-g2", "old-g3"],
        "openrouter": [],
        "preference": None,
        "share": True,
    }
    _assert_every_build_agrees(builds)


def test_8039b45_clearing_every_key_stays_cleared(builds):
    """This build -> 8039b45 (removes every key) -> this build. The keys stay
    gone, the preference 8039b45 read and wrote back stays, and so does the
    pool switch, which 8039b45 has no field for: its store without
    ``share_pool`` is not the user turning sharing off."""
    _this_build_saves_everything()

    builds.old.clear_gemini_key()
    assert builds.old.remove_key("openrouter", 0) is True

    assert _this_build_state() == {
        "gemini": [],
        "openrouter": [],
        "preference": "openrouter",
        "share": True,
    }
    _assert_every_build_agrees(builds)


def test_main_resaves_a_key_this_build_holds_then_8039b45_edits(builds):
    """This build -> main POST of this build's first Gemini key (the key
    main's card shows) -> 8039b45 (adds an OpenRouter key) -> this build.
    8039b45 opened on main's one key, which this build also holds, so the one
    key the two share proves nothing: 8039b45 never saw the other keys or the
    preference, and they stay behind what it wrote."""
    _this_build_saves_everything()
    assert builds.main.gemini_key() == ("this-g1", "file")
    builds.main.set_gemini_key("this-g1")

    assert builds.old.stored_keys("gemini") == ["this-g1"]
    assert builds.old.stored_keys("openrouter") == []
    builds.old.add_key("openrouter", "old-o5")

    assert _this_build_state() == {
        "gemini": ["this-g1", "this-g2"],
        "openrouter": ["old-o5", "this-o1"],
        "preference": "openrouter",
        "share": True,
    }
    _assert_every_build_agrees(builds)


def test_main_resaves_a_key_this_build_holds_then_8039b45_picks_a_provider(builds):
    """This build -> main POST of a Gemini key this build holds -> 8039b45
    (picks Gemini as the provider, touching no key) -> this build. The
    provider 8039b45 picked wins; the keys it never saw stay."""
    _this_build_saves_everything()
    builds.main.set_gemini_key("this-g2")

    assert builds.old.stored_keys("gemini") == ["this-g2"]
    builds.old.set_provider_preference("gemini")

    assert _this_build_state() == {
        "gemini": ["this-g2", "this-g1"],
        "openrouter": ["this-o1"],
        "preference": "gemini",
        "share": True,
    }
    _assert_every_build_agrees(builds)


def test_8039b45_removing_the_second_gemini_key_sticks(builds):
    """This build (two Gemini keys, OpenRouter preferred) -> 8039b45 (removes
    the second Gemini key) -> this build. What 8039b45 wrote shares only the
    first Gemini key with this build's store, as a write made from main's
    file would, but it carries the preference, which main's file has no
    field for: 8039b45 read this build's store, and the removal stands."""
    sidecar.add_key("gemini", "this-g1")
    sidecar.add_key("gemini", "this-g2")
    sidecar.set_provider_preference("openrouter")
    sidecar.set_pool_shared(True)

    assert builds.old.stored_keys("gemini") == ["this-g1", "this-g2"]
    assert builds.old.remove_key("gemini", 1) is True

    assert _this_build_state() == {
        "gemini": ["this-g1"],
        "openrouter": [],
        "preference": "openrouter",
        "share": True,
    }
    _assert_every_build_agrees(builds)


def test_main_deletes_then_resaves_a_key_this_build_held(builds):
    """This build -> main DELETE -> main POST of this build's second Gemini
    key -> this build. main's DELETE forgot every Gemini key, as this build's
    own DELETE does; the key main saved again is the one Gemini key left, and
    nothing else changes."""
    _this_build_saves_everything()

    assert builds.main.clear_gemini_key() is True
    builds.main.set_gemini_key("this-g2")

    assert _this_build_state() == {
        "gemini": ["this-g2"],
        "openrouter": ["this-o1"],
        "preference": "openrouter",
        "share": True,
    }
    _assert_every_build_agrees(builds)


def test_main_deletes_and_resaves_then_8039b45_edits_before_this_build_opens(
    builds,
):
    """This build -> main DELETE -> main POST -> 8039b45 (adds an OpenRouter
    key to main's one key) -> this build. The delete forgot the Gemini keys;
    main's fresh key, 8039b45's key and this build's OpenRouter key, the
    preference and the pool switch all stay."""
    _this_build_saves_everything()
    assert builds.main.clear_gemini_key() is True
    builds.main.set_gemini_key("fresh")

    assert builds.old.stored_keys("gemini") == ["fresh"]
    builds.old.add_key("openrouter", "old-o5")

    assert _this_build_state() == {
        "gemini": ["fresh"],
        "openrouter": ["old-o5", "this-o1"],
        "preference": "openrouter",
        "share": True,
    }
    _assert_every_build_agrees(builds)


def test_main_then_8039b45_then_this_build_on_a_folder_this_build_never_wrote(
    builds,
):
    """main POST -> 8039b45 (adds an OpenRouter key) -> this build, with no
    copy beside the key file. 8039b45's store is the whole story; this
    build's first read writes main's ``key`` back into it."""
    builds.main.set_gemini_key("main-x")
    builds.old.add_key("openrouter", "old-o1")
    assert builds.main.gemini_key() == (None, "none")

    assert _this_build_state() == {
        "gemini": ["main-x"],
        "openrouter": ["old-o1"],
        "preference": None,
        "share": False,
    }
    _assert_every_build_agrees(builds)


def test_main_saves_then_8039b45_edits_before_this_build_opens(builds):
    """This build -> main POST -> 8039b45 (adds an OpenRouter key) -> this
    build. 8039b45 opened on main's one key, so it never saw this build's
    other keys or its preference and could not have removed them: they stay
    behind what 8039b45 wrote."""
    _this_build_saves_everything()
    builds.main.set_gemini_key("main-x")

    assert builds.old.stored_keys("gemini") == ["main-x"]
    builds.old.add_key("openrouter", "old-o5")

    assert _this_build_state() == {
        "gemini": ["main-x", "this-g1", "this-g2"],
        "openrouter": ["old-o5", "this-o1"],
        "preference": "openrouter",
        "share": True,
    }
    _assert_every_build_agrees(builds)


def test_main_deletes_then_8039b45_saves_before_this_build_opens(builds):
    """This build -> main DELETE -> 8039b45 (adds an OpenRouter key to the
    empty store it opened on) -> this build. main's delete forgets the Gemini
    keys; the OpenRouter key this build held stays behind 8039b45's."""
    _this_build_saves_everything()
    assert builds.main.clear_gemini_key() is True

    builds.old.add_key("openrouter", "old-o7")

    assert _this_build_state() == {
        "gemini": [],
        "openrouter": ["old-o7", "this-o1"],
        "preference": "openrouter",
        "share": True,
    }
    _assert_every_build_agrees(builds)


def test_8039b45_edits_then_main_saves_before_this_build_opens(builds):
    """This build -> 8039b45 (adds a Gemini key) -> main POST -> this build.
    main wrote its one key over 8039b45's whole store in place, so 8039b45's
    edit exists in no file any more: this build keeps the store it last
    wrote and puts main's key first. Nothing this build saved is lost."""
    _this_build_saves_everything()
    builds.old.add_key("gemini", "old-g3")

    builds.main.set_gemini_key("main-x")

    assert _this_build_state() == {
        "gemini": ["main-x", "this-g1", "this-g2"],
        "openrouter": ["this-o1"],
        "preference": "openrouter",
        "share": True,
    }
    _assert_every_build_agrees(builds)


def test_8039b45_first_then_this_build_then_main(builds):
    """8039b45 -> this build -> main POST -> this build, on a data folder
    this build never wrote. 8039b45's store has no ``key``, so main found no
    Gemini key in it; this build's first read writes it back, and main then
    finds the first Gemini key and saves over it."""
    builds.old.add_key("gemini", "old-g1")
    builds.old.add_key("openrouter", "old-o1")
    assert builds.main.gemini_key() == (None, "none")

    assert sidecar.stored_keys("gemini") == ["old-g1"]
    assert builds.main.gemini_key() == ("old-g1", "file")
    _assert_every_build_agrees(builds)

    builds.main.set_gemini_key("main-x")

    assert _this_build_state()["gemini"] == ["main-x", "old-g1"]
    assert _this_build_state()["openrouter"] == ["old-o1"]
    _assert_every_build_agrees(builds)


def test_main_first_then_this_build_then_8039b45_then_main_deletes(builds):
    """main POST -> this build (adds an OpenRouter key) -> 8039b45 (adds a
    Gemini key) -> main DELETE -> this build."""
    builds.main.set_gemini_key("main-x")
    sidecar.add_key("openrouter", "this-o1")
    assert builds.old.stored_keys("gemini") == ["main-x"]
    builds.old.add_key("gemini", "old-g2")
    assert sidecar.stored_keys("gemini") == ["main-x", "old-g2"]

    assert builds.main.clear_gemini_key() is True

    assert _this_build_state()["gemini"] == []
    assert _this_build_state()["openrouter"] == ["this-o1"]
    _assert_every_build_agrees(builds)


def test_a_key_file_with_no_file_index_still_reconciles(builds, monkeypatch):
    """A filesystem that reports no file index (FAT: st_ino 0) cannot show a
    delete-then-save, so main's fresh key goes first and the rest stay; no
    key is lost."""
    monkeypatch.setattr(sidecar, "_file_identity", lambda path: None)
    _this_build_saves_everything()

    assert builds.main.clear_gemini_key() is True
    builds.main.set_gemini_key("fresh")

    assert _this_build_state()["gemini"] == ["fresh", "this-g1", "this-g2"]
    assert _this_build_state()["openrouter"] == ["this-o1"]


class _TornWriter:
    """A file whose write() lands half its data and then fails, the way a
    crash or a full disk leaves a file mid-write."""

    def __init__(self, real) -> None:
        self._real = real

    def write(self, data):
        self._real.write(data[: len(data) // 2])
        self._real.flush()
        raise OSError(28, "No space left on device")

    def __enter__(self):
        return self

    def __exit__(self, *exc: object) -> None:
        self._real.close()

    def __getattr__(self, name: str):
        return getattr(self._real, name)


def test_a_crash_mid_write_keeps_every_saved_key(lyria_keys, monkeypatch):
    """Two keys are saved; the third save dies halfway through writing the
    file. The file must still hold the first two -- a torn file reads as
    "nothing stored", and the next save would write that over every key."""

    sidecar.add_key("gemini", "saved-g1")
    sidecar.add_key("openrouter", "saved-o1")
    before = lyria_keys.path.read_bytes()

    real_open = io.open

    def _torn_open(file, mode="r", *args, **kwargs):
        handle = real_open(file, mode, *args, **kwargs)
        return _TornWriter(handle) if "w" in mode else handle

    monkeypatch.setattr(io, "open", _torn_open)
    with pytest.raises(OSError):
        sidecar.add_key("gemini", "lost-g2")
    monkeypatch.setattr(io, "open", real_open)

    assert lyria_keys.path.read_bytes() == before
    assert sidecar.stored_keys("gemini") == ["saved-g1"]
    assert sidecar.stored_keys("openrouter") == ["saved-o1"]
    # No temp file is left beside it.
    assert [
        p.name for p in lyria_keys.path.parent.iterdir() if p.name.endswith(".tmp")
    ] == []


def test_add_remove_and_preference_round_trip(lyria_keys):
    sidecar.add_key("gemini", "g1")
    sidecar.add_key("gemini", "g2")
    sidecar.add_key("gemini", "g1")  # already present -- no duplicate
    sidecar.add_key("openrouter", "o1")
    assert sidecar.stored_keys("gemini") == ["g1", "g2"]

    assert sidecar.remove_key("gemini", 0) is True
    assert sidecar.stored_keys("gemini") == ["g2"]
    assert sidecar.remove_key("gemini", 5) is False
    # Forgetting a Gemini key leaves the OpenRouter list alone.
    assert sidecar.stored_keys("openrouter") == ["o1"]

    assert sidecar.set_provider_preference("OpenRouter") == "openrouter"
    assert sidecar.provider_preference() == "openrouter"
    assert sidecar.set_provider_preference("") is None
    assert sidecar.provider_preference() is None
    with pytest.raises(ValueError):
        sidecar.set_provider_preference("anthropic")
    with pytest.raises(ValueError):
        sidecar.add_key("anthropic", "nope")


def test_compat_set_and_clear_gemini_key(lyria_keys):
    """POST /key appends rather than replacing (a second key is a fallback,
    not a correction), and DELETE /key forgets only the Gemini list."""
    sidecar.set_gemini_key("g1")
    sidecar.set_gemini_key("g2")
    sidecar.add_key("openrouter", "o1")
    assert sidecar.stored_keys("gemini") == ["g1", "g2"]

    assert sidecar.clear_gemini_key() is True
    assert sidecar.stored_keys("gemini") == []
    assert sidecar.stored_keys("openrouter") == ["o1"]
    assert sidecar.clear_gemini_key() is False


@pytest.mark.parametrize(
    "gemini,openrouter,stored_pref,env_pref,expected",
    [
        (["g1"], [], None, None, "gemini"),
        ([], ["o1"], None, None, "openrouter"),
        # Both reachable: leave the child's own default alone.
        (["g1"], ["o1"], None, None, None),
        ([], [], None, None, None),
        # A preference the user set in theDAW wins over the key-count rule...
        ([], ["o1"], "gemini", None, "gemini"),
        (["g1"], ["o1"], "openrouter", None, "openrouter"),
        # ...and over an ambient AI_PROVIDER, which itself beats the rule.
        ([], ["o1"], "gemini", "openrouter", "gemini"),
        (["g1"], [], None, "openrouter", "openrouter"),
    ],
)
def test_child_env_ai_provider_decision_table(
    lyria_keys,
    tmp_path,
    monkeypatch,
    gemini,
    openrouter,
    stored_pref,
    env_pref,
    expected,
):
    if gemini:
        monkeypatch.setenv("GEMINI_API_KEY", ",".join(gemini))
    if openrouter:
        monkeypatch.setenv("OPENROUTER_API_KEY", ",".join(openrouter))
    if env_pref:
        monkeypatch.setenv("AI_PROVIDER", env_pref)
    if stored_pref:
        sidecar.set_provider_preference(stored_pref)

    env = sidecar._child_env(_cfg(_old_checkout(tmp_path / "old")))

    assert env.get("AI_PROVIDER") == expected


def test_probe_key_issue_only_fires_when_both_providers_are_empty(
    lyria_keys, monkeypatch, tmp_path
):
    monkeypatch.setenv("theDAW_LYRIA_PROJECT", str(tmp_path))
    monkeypatch.setenv("theDAW_LYRIA_MOCK", "0")  # live mode
    monkeypatch.setattr(
        sidecar, "_port_is_listening", lambda port, host="127.0.0.1": False
    )

    out = sidecar.probe()
    assert "key" in out["missing"]
    assert any("Gemini or OpenRouter key" in issue for issue in out["issues"])
    assert out["reads_key_lists"] is False
    assert out["compat"] == {
        "keys_ts": False,
        "key_slots": {"GEMINI_API_KEY": 1, "OPENROUTER_API_KEY": 1},
        "reads_key_lists": False,
    }
    assert "pinned_commit" not in out

    # An OpenRouter key alone is enough to generate -- no key issue.
    monkeypatch.setenv("OPENROUTER_API_KEY", "o1")
    out = sidecar.probe()
    assert "key" not in out["missing"]
    assert not any("OpenRouter key is set" in issue for issue in out["issues"])
    assert out["openrouter_key"] is True
    assert out["openrouter_key_source"] == "env"
    assert out["gemini_keys"] == 0
    assert out["openrouter_keys"] == 1
    assert out["provider_preference"] is None


def test_key_summary_reports_counts_and_sources_only(lyria_keys, monkeypatch, tmp_path):
    monkeypatch.setenv("theDAW_LYRIA_PROJECT", str(_old_checkout(tmp_path / "old")))
    monkeypatch.setenv("GEMINI_API_KEY", "env-g1,env-g2")
    sidecar.add_key("gemini", "file-g1")
    sidecar.add_key("openrouter", "file-o1")
    lyria_keys.pools["openrouter"] = ["pool-o1"]
    sidecar.set_provider_preference("openrouter")

    summary = sidecar.key_summary()

    assert summary["providers"]["gemini"] == {
        "count": 3,
        # An old checkout reads one key per provider.
        "handed": 1,
        "key_slots": 1,
        "source": "env",
        "configured": True,
        "env": 2,
        "stored": 1,
        "pool": 0,
        "pool_available": 0,
    }
    # The pooled OpenRouter key is not the child's until the pool is shared.
    assert summary["providers"]["openrouter"]["count"] == 1
    assert summary["providers"]["openrouter"]["pool"] == 0
    assert summary["providers"]["openrouter"]["pool_available"] == 1
    assert summary["providers"]["openrouter"]["source"] == "file"
    assert summary["provider_preference"] == "openrouter"
    assert summary["share_pool"] is False
    assert summary["reads_key_lists"] is False
    assert summary["key_limit"] == 1
    assert "env-g1" not in json.dumps(summary)

    monkeypatch.setenv("theDAW_LYRIA_PROJECT", str(_list_checkout(tmp_path / "lists")))
    sidecar.set_pool_shared(True)
    shared = sidecar.key_summary()
    assert shared["providers"]["gemini"]["handed"] == 3
    assert shared["providers"]["openrouter"]["count"] == 2
    assert shared["providers"]["openrouter"]["pool"] == 1
    assert shared["reads_key_lists"] is True
    assert shared["key_limit"] == sidecar.CHILD_KEY_LIMIT


# ---------------------------------------------------------------------------
# The /keys routes: shapes, validation, sidecar restart, and no key material
# ---------------------------------------------------------------------------


def _recording_to_thread_factory(calls: list[object]):
    async def _recording_to_thread(fn, *args, **kwargs):
        calls.append(fn)
        return fn(*args, **kwargs)

    return _recording_to_thread


@pytest.fixture
def keys_router(lyria_keys, monkeypatch):
    """The Lyria router with its blocking calls recorded and sidecar.stop()
    faked, so no real process teardown is attempted. adopted_running() is
    faked too: the real one would probe port 5188, where the user's own Lyria
    may be running."""
    from backend.modules.lyria import router as lyria_router

    calls: list[object] = []
    monkeypatch.setattr(
        lyria_router.asyncio, "to_thread", _recording_to_thread_factory(calls)
    )
    monkeypatch.setattr(sidecar, "stop", lambda: True)
    monkeypatch.setattr(sidecar, "adopted_running", lambda: False)
    return SimpleNamespace(module=lyria_router, calls=calls, keys=lyria_keys)


def test_keys_get_route_returns_counts_and_offloads_to_thread(keys_router, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "env-g1")
    result = asyncio.run(keys_router.module.keys_status())

    assert sidecar.key_summary in keys_router.calls
    assert result["providers"]["gemini"]["count"] == 1
    assert result["providers"]["gemini"]["source"] == "env"
    assert result["providers"]["openrouter"]["count"] == 0
    assert result["provider_preference"] is None
    assert "env-g1" not in json.dumps(result)


def test_keys_post_route_appends_stops_the_sidecar_and_hides_the_value(keys_router):
    result = asyncio.run(
        keys_router.module.add_provider_key(
            provider="openrouter", key="sk-or-v1-secret-value"
        )
    )

    assert sidecar.stored_keys("openrouter") == ["sk-or-v1-secret-value"]
    assert sidecar.stop in keys_router.calls
    assert result["ok"] is True
    assert result["restarted"] is True
    assert result["external_running"] is False
    assert result["providers"]["openrouter"]["count"] == 1
    assert result["providers"]["openrouter"]["source"] == "file"
    assert result["providers"]["openrouter"]["stored"] == 1
    assert "secret" not in json.dumps(result)


def test_key_change_reports_an_adopted_lyria_that_keeps_its_old_keys(
    keys_router, monkeypatch
):
    """stop() cannot end a Lyria this process did not spawn, so a key change
    must say that one is still running with the old keys."""
    monkeypatch.setattr(sidecar, "stop", lambda: False)
    monkeypatch.setattr(sidecar, "adopted_running", lambda: True)

    result = asyncio.run(
        keys_router.module.add_provider_key(provider="gemini", key="gemini-new-key")
    )

    assert result["restarted"] is False
    assert result["external_running"] is True


def test_keys_post_route_rejects_a_bad_provider_and_a_short_key(keys_router):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as bad_provider:
        asyncio.run(
            keys_router.module.add_provider_key(
                provider="anthropic", key="sk-123456789"
            )
        )
    assert bad_provider.value.status_code == 400

    with pytest.raises(HTTPException) as short:
        asyncio.run(keys_router.module.add_provider_key(provider="gemini", key="tiny"))
    assert short.value.status_code == 400
    assert sidecar.stored_keys("gemini") == []


def test_keys_delete_route_removes_by_position(keys_router):
    from fastapi import HTTPException

    sidecar.add_key("gemini", "g1-value")
    sidecar.add_key("gemini", "g2-value")

    result = asyncio.run(
        keys_router.module.remove_provider_key(provider="gemini", index=0)
    )
    assert sidecar.stored_keys("gemini") == ["g2-value"]
    assert result["providers"]["gemini"]["stored"] == 1
    assert sidecar.stop in keys_router.calls
    assert "g2-value" not in json.dumps(result)

    with pytest.raises(HTTPException) as gone:
        asyncio.run(keys_router.module.remove_provider_key(provider="gemini", index=9))
    assert gone.value.status_code == 404
    with pytest.raises(HTTPException) as bad_provider:
        asyncio.run(keys_router.module.remove_provider_key(provider="nope", index=0))
    assert bad_provider.value.status_code == 400


def test_keys_provider_route_sets_and_clears_the_preference(keys_router):
    from fastapi import HTTPException

    result = asyncio.run(keys_router.module.set_key_provider(provider="openrouter"))
    assert result["provider_preference"] == "openrouter"
    assert sidecar.stop in keys_router.calls

    cleared = asyncio.run(keys_router.module.set_key_provider(provider=""))
    assert cleared["provider_preference"] is None

    with pytest.raises(HTTPException) as bad:
        asyncio.run(keys_router.module.set_key_provider(provider="anthropic"))
    assert bad.value.status_code == 400


def test_keys_pool_route_turns_sharing_on_and_off(keys_router):
    keys_router.keys.pools["openrouter"] = ["pool-o1"]

    on = asyncio.run(keys_router.module.set_key_pool(share=True))
    assert on["share_pool"] is True
    assert on["providers"]["openrouter"]["pool"] == 1
    assert sidecar.stop in keys_router.calls

    off = asyncio.run(keys_router.module.set_key_pool(share=False))
    assert off["share_pool"] is False
    assert off["providers"]["openrouter"]["pool"] == 0


def test_legacy_key_routes_still_work_and_append(keys_router):
    """GET/POST/DELETE /key keep their shape; POST now appends so an older
    client adding a second key gains a fallback instead of losing the first."""
    first = asyncio.run(keys_router.module.set_key(key="gemini-key-one"))
    second = asyncio.run(keys_router.module.set_key(key="gemini-key-two"))

    assert first["configured"] is True
    assert second["source"] == "file"
    assert second["restarted"] is True
    assert sidecar.stored_keys("gemini") == ["gemini-key-one", "gemini-key-two"]
    # The legacy body carries a 6-character hint, never the key itself.
    assert "gemini-key-one" not in json.dumps(first)
    assert "gemini-key-two" not in json.dumps(second)

    status = asyncio.run(keys_router.module.key_status())
    assert status["configured"] is True
    assert status["source"] == "file"
    assert "gemini-key-one" not in json.dumps(status)

    cleared = asyncio.run(keys_router.module.clear_key())
    assert cleared["removed"] is True
    assert cleared["configured"] is False
    # Forgetting a key stops the sidecar like every other key change.
    assert cleared["restarted"] is True
    assert sidecar.stop in keys_router.calls
    assert sidecar.stored_keys("gemini") == []


# ---------------------------------------------------------------------------
# The gate: every route that changes something refuses a foreign page and a
# LAN caller without the launch or pairing token
# ---------------------------------------------------------------------------


_LAN = ("192.168.1.50", 50000)
_LOOPBACK = ("127.0.0.1", 50000)
_PAIRING_TOKEN = "test-pairing-token"

# (method, path, json body) for every route that changes state.
_CHANGING_ROUTES = [
    ("POST", "/api/lyria/keys", {"provider": "gemini", "key": "lan-attacker-key"}),
    ("DELETE", "/api/lyria/keys", {"provider": "gemini", "index": 0}),
    ("POST", "/api/lyria/keys/provider", {"provider": "openrouter"}),
    ("POST", "/api/lyria/keys/pool", {"share": True}),
    ("POST", "/api/lyria/key", {"key": "lan-attacker-key"}),
    ("DELETE", "/api/lyria/key", None),
    ("POST", "/api/lyria/import-new", {"include_mock": True}),
    ("POST", "/api/lyria/install", None),
    ("POST", "/api/lyria/start", None),
    ("POST", "/api/lyria/stop", None),
    ("POST", "/api/lyria/restart", None),
    ("POST", "/api/lyria/update", None),
]


@pytest.fixture
def gated_app(lyria_keys, monkeypatch):
    """The real router mounted the way backend/modules/loader.py mounts it,
    with every sidecar action that would touch a process faked and recorded."""
    from fastapi import FastAPI

    from backend.lib import pairing
    from backend.modules.lyria import importer
    from backend.modules.lyria import router as lyria_router

    actions: list[str] = []
    sync_calls: list[bool] = []

    async def _fake_sync(include_mock: bool = False) -> dict:
        sync_calls.append(include_mock)
        return {"imported": [], "skipped": 0}

    def _record(name: str, value: object):
        def _action(*args: object, **kwargs: object):
            actions.append(name)
            return value

        return _action

    monkeypatch.setattr(importer, "sync_generations", _fake_sync)
    monkeypatch.setattr(sidecar, "stop", _record("stop", False))
    monkeypatch.setattr(sidecar, "adopted_running", lambda: False)
    monkeypatch.setattr(
        sidecar, "start_install", _record("install", {"status": "done"})
    )
    monkeypatch.setattr(
        sidecar, "ensure_running", _record("start", "http://127.0.0.1:5188")
    )
    monkeypatch.setattr(sidecar, "restart", _record("restart", "http://127.0.0.1:5188"))
    monkeypatch.setattr(
        sidecar, "start_update", _record("update", {"status": "running"})
    )
    monkeypatch.setattr(sidecar, "owns_process", lambda: True)
    monkeypatch.setattr(pairing, "get_token", lambda: _PAIRING_TOKEN)
    monkeypatch.delenv("THEDAW_LAUNCH_TOKEN", raising=False)

    app = FastAPI()
    app.include_router(lyria_router.router, prefix="/api/lyria")
    return SimpleNamespace(
        app=app, actions=actions, sync_calls=sync_calls, keys=lyria_keys
    )


def _client(app, peer):
    from fastapi.testclient import TestClient

    return TestClient(app, client=peer)


def test_a_lan_device_cannot_change_keys_or_drive_the_sidecar(gated_app):
    """The user saved keys on this machine; a device on the LAN then sends
    every changing request with no token. Each one is refused, the saved keys
    and settings are untouched, and nothing was started, stopped or imported."""
    sidecar.add_key("gemini", "users-own-gemini")
    sidecar.add_key("openrouter", "users-own-openrouter")
    before = gated_app.keys.path.read_bytes()

    lan = _client(gated_app.app, _LAN)
    for method, path, body in _CHANGING_ROUTES:
        resp = lan.request(method, path, json=body)
        assert resp.status_code == 403, (method, path, resp.status_code, resp.text)

    assert gated_app.keys.path.read_bytes() == before
    assert gated_app.actions == []
    assert gated_app.sync_calls == []


def test_a_foreign_page_on_this_machine_is_refused(gated_app):
    """A page the user's own browser visits is a loopback caller too: the
    cross-site check is what stops it."""
    sidecar.add_key("gemini", "users-own-gemini")
    local = _client(gated_app.app, _LOOPBACK)

    resp = local.request(
        "DELETE",
        "/api/lyria/keys",
        json={"provider": "gemini", "index": 0},
        headers={"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"},
    )

    assert resp.status_code == 403
    assert sidecar.stored_keys("gemini") == ["users-own-gemini"]


def test_this_machine_and_a_paired_phone_still_get_through(gated_app):
    local = _client(gated_app.app, _LOOPBACK)
    resp = local.post(
        "/api/lyria/keys", json={"provider": "gemini", "key": "local-gemini-key"}
    )
    assert resp.status_code == 200, resp.text
    assert sidecar.stored_keys("gemini") == ["local-gemini-key"]

    phone = _client(gated_app.app, _LAN)
    resp = phone.post(
        "/api/lyria/keys",
        json={"provider": "openrouter", "key": "phone-openrouter-key"},
        headers={"X-TheDAW-Pair": _PAIRING_TOKEN},
    )
    assert resp.status_code == 200, resp.text
    assert sidecar.stored_keys("openrouter") == ["phone-openrouter-key"]

    resp = phone.post(
        "/api/lyria/keys/pool",
        json={"share": True},
        headers={"X-TheDAW-Pair": "wrong-token"},
    )
    assert resp.status_code == 403
    assert sidecar.pool_shared() is False


def test_include_mock_is_honoured_only_for_this_machine(gated_app):
    """A paired phone asking for mock imports gets a normal import: only a
    caller on this machine can put the sidecar's sine waves in the library."""
    phone = _client(gated_app.app, _LAN)
    resp = phone.post(
        "/api/lyria/import-new",
        json={"include_mock": True},
        headers={"X-TheDAW-Pair": _PAIRING_TOKEN},
    )
    assert resp.status_code == 200, resp.text

    local = _client(gated_app.app, _LOOPBACK)
    assert (
        local.post("/api/lyria/import-new", json={"include_mock": True}).status_code
        == 200
    )
    assert local.post("/api/lyria/import-new", json={}).status_code == 200

    assert gated_app.sync_calls == [False, True, False]


def test_restart_route_maps_a_refusal_to_409_and_a_failed_start_to_503(
    gated_app, monkeypatch
):
    local = _client(gated_app.app, _LOOPBACK)

    def _refuse():
        raise sidecar.RestartRefused("The Lyria on port 5188 runs from elsewhere.")

    monkeypatch.setattr(sidecar, "restart", _refuse)
    resp = local.post("/api/lyria/restart")
    assert resp.status_code == 409
    assert "runs from elsewhere" in resp.json()["detail"]

    def _fail():
        raise RuntimeError("Lyria sidecar exited before becoming ready (rc=1).")

    monkeypatch.setattr(sidecar, "restart", _fail)
    resp = local.post("/api/lyria/restart")
    assert resp.status_code == 503


# ---------------------------------------------------------------------------
# An adopted Lyria -- one an earlier session left on the port -- is replaced
# with a child that has the current keys
# ---------------------------------------------------------------------------


_FAKE_LYRIA = r"""
import http.server, json, os, sys

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path != "/api/settings/status":
            self.send_response(404)
            self.end_headers()
            return
        body = json.dumps({
            "geminiServerKey": bool(os.environ.get("GEMINI_API_KEY")),
            "openRouterServerKey": bool(os.environ.get("OPENROUTER_API_KEY")),
            "defaultProvider": "gemini",
            "testGeminiKey": os.environ.get("GEMINI_API_KEY", ""),
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
"""


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _status(port: int) -> dict:

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(f"http://127.0.0.1:{port}/api/settings/status", timeout=2) as r:
        return json.loads(r.read())


def _start_fake_lyria(script, port: int, cwd, env: dict[str, str]):

    proc = subprocess.Popen(
        [sys.executable, str(script), str(port)],
        cwd=str(cwd),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if sidecar._port_is_listening(port) and sidecar._is_lyria_server(port):
            return proc
        time.sleep(0.1)
    proc.kill()
    raise AssertionError("the fake Lyria never came up")


@pytest.fixture
def stale_lyria(lyria_keys, tmp_path, monkeypatch):
    """A fake Lyria started the way an earlier backend session would have:
    from the checkout, with that session's key in its environment. This
    process holds no handle to it."""

    project = _old_checkout(tmp_path / "lyria")
    script = tmp_path / "fake_lyria.py"
    script.write_text(_FAKE_LYRIA, encoding="utf-8")
    port = _free_port()
    monkeypatch.setenv("theDAW_LYRIA_PORT", str(port))
    monkeypatch.setenv("theDAW_LYRIA_PROJECT", str(project))
    monkeypatch.setattr(sidecar, "_ensure_deps", lambda cfg: None)
    started: list[subprocess.Popen] = []

    def _launch(cwd, env_overrides: dict[str, str]):
        env = {**os.environ, **env_overrides}
        proc = _start_fake_lyria(script, port, cwd, env)
        started.append(proc)
        return proc

    real_popen = subprocess.Popen

    def _popen(cmd, *args, **kwargs):
        # ensure_running's `npm run dev` becomes the fake server, started
        # from the checkout with the environment theDAW built for it. Every
        # other command (taskkill, git) runs for real.
        if list(cmd)[-2:] == ["run", "dev"]:
            proc = real_popen(
                [sys.executable, str(script), str(port)],
                cwd=kwargs.get("cwd"),
                env=kwargs.get("env"),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            started.append(proc)
            return proc
        return real_popen(cmd, *args, **kwargs)

    monkeypatch.setattr(sidecar.subprocess, "Popen", _popen)
    ns = SimpleNamespace(project=project, port=port, launch=_launch, started=started)
    yield ns
    sidecar.stop()
    for proc in started:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)


def test_restart_replaces_an_adopted_lyria_with_the_current_keys(stale_lyria):
    """An earlier session's Lyria is still on the port with its key. The user
    saves a new key: the key change cannot stop what this process did not
    spawn. Restart ends the adopted process and starts a child that reads
    the new key."""
    stale = stale_lyria.launch(
        stale_lyria.project, {"GEMINI_API_KEY": "earlier-session-key"}
    )
    assert _status(stale_lyria.port)["testGeminiKey"] == "earlier-session-key"

    sidecar.add_key("gemini", "current-gemini-key")
    assert sidecar.stop() is False
    assert sidecar.adopted_running() is True
    assert sidecar.ensure_running() == f"http://127.0.0.1:{stale_lyria.port}"
    assert sidecar.owns_process() is False

    assert sidecar.restart() == f"http://127.0.0.1:{stale_lyria.port}"

    stale.wait(timeout=10)
    assert stale.poll() is not None
    assert sidecar.owns_process() is True
    assert sidecar.adopted_running() is False
    assert _status(stale_lyria.port)["testGeminiKey"] == "current-gemini-key"


def test_restart_refuses_a_lyria_that_runs_from_another_folder(stale_lyria, tmp_path):
    elsewhere = tmp_path / "someone-elses-lyria"
    elsewhere.mkdir()
    other = stale_lyria.launch(elsewhere, {"GEMINI_API_KEY": "not-ours"})

    with pytest.raises(sidecar.RestartRefused) as refused:
        sidecar.restart()

    assert "someone-elses-lyria" in str(refused.value)
    assert other.poll() is None
    assert _status(stale_lyria.port)["testGeminiKey"] == "not-ours"


def test_restart_refuses_a_port_held_by_something_that_is_not_lyria(
    lyria_keys, monkeypatch
):
    with _run_server(_UnrelatedHandler) as port:
        monkeypatch.setenv("theDAW_LYRIA_PORT", str(port))
        with pytest.raises(sidecar.RestartRefused):
            sidecar.stop_adopted()
        assert sidecar._port_is_listening(port)


# ---------------------------------------------------------------------------
# The latest commit: Install clones it, Update fast-forwards a clean checkout
# to it, and what a checkout reads is decided from the checkout itself.
# Local repos stand in for GitHub.
# ---------------------------------------------------------------------------


def _git(*args: str, cwd=None) -> str:

    out = subprocess.run(
        [
            "git",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "user.name=test",
            "-c",
            "core.autocrlf=false",
            *args,
        ],
        cwd=None if cwd is None else str(cwd),
        capture_output=True,
        text=True,
        check=True,
    )
    return out.stdout.strip()


@pytest.fixture
def upstream(tmp_path):
    """An upstream Lyria repo on branch main: A is the old shape (no
    server/keys.ts; its server.ts reads one key per provider, the two lines
    of the user's own checkout at 192032e), B the key-list shape, C a later
    commit on top of B and the default branch's head."""
    repo = tmp_path / "upstream"
    repo.mkdir()
    _git("init", "-q", "-b", "main", str(repo))
    (repo / "package.json").write_text('{"name": "lyria-3-pro"}\n', encoding="utf-8")
    (repo / "server.ts").write_text(
        "const key = clientKey || process.env.GEMINI_API_KEY;\n"
        "return clientKey || process.env.OPENROUTER_API_KEY;\n",
        encoding="utf-8",
    )
    _git("add", "-A", cwd=repo)
    _git("commit", "-q", "-m", "A: one key per provider", cwd=repo)
    a = _git("rev-parse", "HEAD", cwd=repo)
    _list_checkout(repo)
    (repo / "package.json").write_text('{"name": "lyria-3-pro"}\n', encoding="utf-8")
    _git("add", "-A", cwd=repo)
    _git("commit", "-q", "-m", "B: ordered key lists", cwd=repo)
    b = _git("rev-parse", "HEAD", cwd=repo)
    (repo / "README.md").write_text("later\n", encoding="utf-8")
    _git("add", "-A", cwd=repo)
    _git("commit", "-q", "-m", "C: later", cwd=repo)
    c = _git("rev-parse", "HEAD", cwd=repo)
    return SimpleNamespace(path=repo, uri=repo.as_uri(), a=a, b=b, c=c)


@pytest.fixture
def latest(upstream, lyria_keys, tmp_path, monkeypatch):
    """The sidecar pointed at the local upstream, with the project found by
    the default search (no theDAW_LYRIA_PROJECT), npm install recorded
    instead of run, and a fresh checkout and update state."""
    npm_runs: list[object] = []
    monkeypatch.setattr(sidecar, "LYRIA_REPO_URL", upstream.uri)
    monkeypatch.setattr(sidecar, "_run_npm_install", lambda cfg: npm_runs.append(cfg))
    monkeypatch.setattr(sidecar, "_checkout_state", dict(sidecar._checkout_state))
    monkeypatch.setattr(sidecar, "_update_state", dict(sidecar._update_state))
    monkeypatch.setenv("theDAW_LYRIA_PORT", str(_free_port()))
    return SimpleNamespace(upstream=upstream, npm_runs=npm_runs, root=tmp_path)


def _existing_install(latest_ns, commit: str, name: str = "lyria"):
    """A checkout the way theDAW's round-1 Install left it: a depth-1 fetch of
    one commit, detached, with node_modules installed."""
    checkout = latest_ns.root / name
    _git("init", "-q", str(checkout))
    _git("config", "core.autocrlf", "false", cwd=checkout)
    _git("fetch", "-q", "--depth", "1", latest_ns.upstream.uri, commit, cwd=checkout)
    _git("checkout", "-q", "--detach", commit, cwd=checkout)
    (checkout / "node_modules").mkdir()
    return checkout


def _clone_install(latest_ns, name: str = "lyria"):
    """A checkout the way Install leaves it now: a clone of the default
    branch, with node_modules installed."""
    checkout = latest_ns.root / name
    _git("clone", "-q", latest_ns.upstream.uri, str(checkout))
    _git("config", "core.autocrlf", "false", cwd=checkout)
    (checkout / "node_modules").mkdir()
    return checkout


def _capture_spawns(monkeypatch, checkout) -> list[dict[str, str]]:
    """Make ``checkout`` the default project and replace `npm run dev` with a
    stand-in that records each spawn's env and stays "alive"."""
    spawns: list[dict[str, str]] = []
    real_popen = subprocess.Popen

    def _popen(cmd, *args, **kwargs):
        if list(cmd)[-2:] != ["run", "dev"]:
            return real_popen(cmd, *args, **kwargs)  # git, for real
        spawns.append(dict(kwargs.get("env") or {}))
        return SimpleNamespace(poll=lambda: None, pid=0, returncode=None)

    monkeypatch.setattr(sidecar, "DEFAULT_PROJECT_PATH", checkout)
    monkeypatch.setattr(sidecar.subprocess, "Popen", _popen)
    return spawns


def _spawn_capturing_env(monkeypatch, checkout) -> dict[str, str]:
    """ensure_running(wait_for_ready=False) from ``checkout`` as the default
    project; returns the env the child was spawned with."""
    spawns = _capture_spawns(monkeypatch, checkout)
    sidecar.ensure_running(wait_for_ready=False)
    return spawns[-1] if spawns else {}


def _run_update() -> dict:
    """Press Update and wait for the background job to finish."""
    sidecar.start_update()
    deadline = time.monotonic() + 60.0
    while time.monotonic() < deadline:
        state = sidecar.update_status()
        if state["status"] in ("done", "error"):
            return state
        time.sleep(0.02)
    raise AssertionError(f"the update did not finish: {sidecar.update_status()}")


def _restartable(monkeypatch) -> list[str]:
    """Let the update job stop the stand-in child and start it again without
    a real process or port: stop() ends the stand-in, and the restart spawns
    another without waiting for a port."""
    events: list[str] = []
    real_ensure = sidecar.ensure_running
    monkeypatch.setattr(sidecar, "_terminate_proc", lambda proc: events.append("stop"))
    monkeypatch.setattr(sidecar, "stop_adopted", lambda: False)

    def _ensure(**kw):
        events.append("start")
        return real_ensure(wait_for_ready=False)

    monkeypatch.setattr(sidecar, "ensure_running", _ensure)
    return events


def test_opening_lyria_runs_the_checkout_as_it_is(latest, monkeypatch):
    """The user's Lyria was installed at an older commit (one key per
    provider). They save two Gemini keys and open the Lyria tab. Nothing is
    fetched and nothing moves; the child gets the one key that commit reads."""
    checkout = _existing_install(latest, latest.upstream.a)
    sidecar.add_key("gemini", "gemini-one")
    sidecar.add_key("gemini", "gemini-two")
    fetches: list[list[str]] = []
    real_git_run = sidecar._git_run

    def _counting(git, args, cwd, timeout=60.0):
        if "fetch" in args or "ls-remote" in args:
            fetches.append(args)
        return real_git_run(git, args, cwd, timeout)

    monkeypatch.setattr(sidecar, "_git_run", _counting)

    env = _spawn_capturing_env(monkeypatch, checkout)

    assert _git("rev-parse", "HEAD", cwd=checkout) == latest.upstream.a
    assert fetches == []
    assert env["GEMINI_API_KEY"] == "gemini-one"
    assert "GEMINI_API_KEY_2" not in env


def test_update_moves_an_old_install_to_the_latest_and_restarts_it_with_lists(
    latest, monkeypatch
):
    """Same user, Lyria running from the old commit. They press Update in the
    Lyria panel: the running child is stopped, the checkout moves to the
    latest commit (C, not B), their generations survive, and Lyria starts
    again, now handed both keys because the new checkout reads lists."""
    checkout = _existing_install(latest, latest.upstream.a)
    (checkout / "generations").mkdir()
    (checkout / "generations" / "song.wav").write_bytes(b"RIFF user audio")
    sidecar.add_key("gemini", "gemini-one")
    sidecar.add_key("gemini", "gemini-two")
    spawns = _capture_spawns(monkeypatch, checkout)
    sidecar.ensure_running(wait_for_ready=False)
    assert "GEMINI_API_KEY_2" not in spawns[-1]
    events = _restartable(monkeypatch)

    job = _run_update()

    assert job["status"] == "done", job
    assert job["restarted"] is True
    assert events == ["stop", "start"]
    assert _git("rev-parse", "HEAD", cwd=checkout) == latest.upstream.c
    state = sidecar.checkout_state()
    assert state["state"] == "updated"
    assert state["commit"] == latest.upstream.c
    assert state["latest"] == latest.upstream.c
    assert job["message"] == (
        f"Updated Lyria from {latest.upstream.a[:7]} to {latest.upstream.c[:7]}."
    )
    assert (checkout / "generations" / "song.wav").read_bytes() == b"RIFF user audio"
    assert len(spawns) == 2
    assert spawns[-1]["GEMINI_API_KEY"] == "gemini-one"
    assert spawns[-1]["GEMINI_API_KEY_2"] == "gemini-two"
    # package.json did not change between the two commits.
    assert latest.npm_runs == []


def test_an_update_whose_restart_fails_says_so_and_that_lyria_is_stopped(
    latest, monkeypatch
):
    """Lyria runs from an old install; Update moves the checkout, but the
    restart fails (another program took the port meanwhile). The job ends in
    an error that says what moved and why Lyria is not back, and marks Lyria
    as stopped so the panel reloads instead of framing a dead server."""
    checkout = _existing_install(latest, latest.upstream.a)
    _capture_spawns(monkeypatch, checkout)
    sidecar.ensure_running(wait_for_ready=False)
    monkeypatch.setattr(sidecar, "_terminate_proc", lambda proc: None)
    monkeypatch.setattr(sidecar, "stop_adopted", lambda: False)

    def _port_taken(**kw):
        raise RuntimeError("Port 5188 is already in use by another process.")

    monkeypatch.setattr(sidecar, "ensure_running", _port_taken)

    job = _run_update()

    assert job["status"] == "error"
    assert job["stopped"] is True
    assert job["restarted"] is False
    assert job["error"].startswith(
        f"Updated Lyria from {latest.upstream.a[:7]} to {latest.upstream.c[:7]}."
    )
    assert "did not start again: Port 5188 is already in use" in job["error"]
    assert _git("rev-parse", "HEAD", cwd=checkout) == latest.upstream.c

    # The next Update starts clean.
    again = _run_update()
    assert again["status"] == "done"
    assert again["stopped"] is False


def test_update_leaves_a_checkout_with_local_changes_alone_and_says_why(
    latest, monkeypatch
):
    checkout = _existing_install(latest, latest.upstream.a)
    (checkout / "server.ts").write_text("// my own edit\n", encoding="utf-8")
    spawns = _capture_spawns(monkeypatch, checkout)
    sidecar.ensure_running(wait_for_ready=False)
    events = _restartable(monkeypatch)

    job = _run_update()

    assert job["status"] == "done"
    assert job["restarted"] is False
    assert events == [], "a checkout that is not moved is not stopped either"
    assert _git("rev-parse", "HEAD", cwd=checkout) == latest.upstream.a
    assert (checkout / "server.ts").read_text(encoding="utf-8") == "// my own edit\n"
    state = sidecar.checkout_state()
    assert state["state"] == "dirty"
    assert "local changes" in state["reason"]
    assert job["message"] == state["reason"]
    assert len(spawns) == 1


def test_a_failed_fetch_leaves_the_checkout_as_it_is(latest, monkeypatch):
    checkout = _existing_install(latest, latest.upstream.a)
    monkeypatch.setattr(
        sidecar, "LYRIA_REPO_URL", (latest.root / "no-such-repo").as_uri()
    )

    state = sidecar._fast_forward_checkout(_cfg(checkout))

    assert state["state"] == "failed"
    assert state["commit"] == latest.upstream.a
    assert _git("rev-parse", "HEAD", cwd=checkout) == latest.upstream.a


def test_a_checkout_with_commits_of_its_own_is_never_moved(latest):
    """A developer's clone of the default branch: one commit of theirs on top
    of the latest (``newer``), then the same branch reset under an older
    commit with a commit of theirs (``diverged``). Neither is a fast-forward,
    so neither moves."""
    checkout = latest.root / "dev-lyria"
    _git("clone", "-q", latest.upstream.uri, str(checkout))
    (checkout / "mine.txt").write_text("mine\n", encoding="utf-8")
    _git("add", "-A", cwd=checkout)
    _git("commit", "-q", "-m", "mine", cwd=checkout)
    ahead = _git("rev-parse", "HEAD", cwd=checkout)

    state = sidecar._fast_forward_checkout(_cfg(checkout))
    assert state["state"] == "newer"
    assert _git("rev-parse", "HEAD", cwd=checkout) == ahead

    _git("reset", "-q", "--hard", latest.upstream.a, cwd=checkout)
    (checkout / "mine.txt").write_text("mine again\n", encoding="utf-8")
    _git("add", "-A", cwd=checkout)
    _git("commit", "-q", "-m", "mine again", cwd=checkout)
    forked = _git("rev-parse", "HEAD", cwd=checkout)

    state = sidecar._fast_forward_checkout(_cfg(checkout))
    assert state["state"] == "diverged"
    assert "fast-forward" in state["reason"]
    assert _git("rev-parse", "HEAD", cwd=checkout) == forked


def test_a_checkout_named_by_theDAW_LYRIA_PROJECT_is_not_moved(latest, monkeypatch):
    checkout = _existing_install(latest, latest.upstream.a)
    monkeypatch.setenv("theDAW_LYRIA_PROJECT", str(checkout))

    state = sidecar._fast_forward_checkout(sidecar.resolve_config())

    assert state["state"] == "managed"
    assert "theDAW_LYRIA_PROJECT" in state["reason"]
    assert _git("rev-parse", "HEAD", cwd=checkout) == latest.upstream.a


def _latest_with_a_new_dependency(latest_ns) -> str:
    """Add commit D to the upstream with a changed package.json."""
    upstream = latest_ns.upstream
    (upstream.path / "package.json").write_text(
        '{"name": "lyria-3-pro", "dependencies": {"new-dep": "1.0.0"}}\n',
        encoding="utf-8",
    )
    _git("commit", "-q", "-am", "D: new dependency", cwd=upstream.path)
    return _git("rev-parse", "HEAD", cwd=upstream.path)


def test_changed_dependencies_run_npm_install_after_the_move(latest):
    _latest_with_a_new_dependency(latest)
    checkout = _existing_install(latest, latest.upstream.a)

    state = sidecar._fast_forward_checkout(_cfg(checkout))

    assert state["state"] == "updated"
    assert len(latest.npm_runs) == 1
    assert sidecar.deps_pending(checkout) is False


def test_a_failed_npm_install_after_the_update_runs_again_on_the_next_start(
    latest, monkeypatch
):
    """The latest commit changes package.json. The user presses Update: the
    checkout moves and npm install fails (a network blip), so the panel shows
    the error. The user opens Lyria: node_modules (the old one) still exists,
    and npm install must run again before Lyria spawns against it."""
    head = _latest_with_a_new_dependency(latest)
    checkout = _existing_install(latest, latest.upstream.a)
    attempts: list[str] = []

    def _npm_install(cfg):
        attempts.append("npm install")
        if len(attempts) == 1:
            raise RuntimeError("npm install failed (rc=1)")

    monkeypatch.setattr(sidecar, "_run_npm_install", _npm_install)
    monkeypatch.setattr(sidecar, "DEFAULT_PROJECT_PATH", checkout)

    job = _run_update()

    assert job["status"] == "error"
    assert "npm install failed" in job["error"]
    assert _git("rev-parse", "HEAD", cwd=checkout) == head
    assert (checkout / "node_modules").is_dir()
    assert sidecar.deps_pending(checkout) is True
    assert sidecar.probe()["deps_installed"] is False

    env = _spawn_capturing_env(monkeypatch, checkout)  # the user opens Lyria

    assert attempts == ["npm install", "npm install"]
    assert sidecar.deps_pending(checkout) is False
    assert env, "Lyria spawned once the dependencies were installed"


def test_the_install_button_does_not_call_a_half_installed_checkout_done(
    latest, monkeypatch
):
    """Same failed install after an Update, then the Install button on the
    card: it must run npm install, not report "Already installed"."""
    _latest_with_a_new_dependency(latest)
    checkout = _existing_install(latest, latest.upstream.a)

    def _npm_fails(cfg):
        raise RuntimeError("npm install failed (rc=1)")

    monkeypatch.setattr(sidecar, "_run_npm_install", _npm_fails)
    monkeypatch.setattr(sidecar, "DEFAULT_PROJECT_PATH", checkout)
    assert _run_update()["status"] == "error"

    ran: list[object] = []
    monkeypatch.setattr(sidecar, "_run_npm_install", lambda cfg: ran.append(cfg))
    monkeypatch.setattr(sidecar, "_npm_path", lambda: "npm")
    monkeypatch.setattr(sidecar, "_node_path", lambda: "node")
    monkeypatch.setattr(sidecar, "_install_state", dict(sidecar._install_state))

    state = sidecar.start_install()
    assert not state.get("already_installed")
    for _ in range(200):
        if sidecar.install_status()["status"] in ("done", "error"):
            break
        time.sleep(0.02)
    assert sidecar.install_status()["status"] == "done"
    assert len(ran) == 1
    assert sidecar.deps_pending(checkout) is False


def test_a_move_git_refuses_leaves_no_install_pending(latest, monkeypatch):
    _latest_with_a_new_dependency(latest)
    checkout = _existing_install(latest, latest.upstream.a)
    real_git_run = sidecar._git_run

    def _refuse_checkout(git, args, cwd, timeout=60.0):
        if args[:1] == ["checkout"]:
            return subprocess.CompletedProcess(args, 1, "", "error: refused\n")
        return real_git_run(git, args, cwd, timeout)

    monkeypatch.setattr(sidecar, "_git_run", _refuse_checkout)
    state = sidecar._fast_forward_checkout(_cfg(checkout))

    assert state["state"] == "failed"
    assert _git("rev-parse", "HEAD", cwd=checkout) == latest.upstream.a
    assert sidecar.deps_pending(checkout) is False
    assert latest.npm_runs == []


def test_a_checkout_on_its_own_branch_is_left_alone_and_says_why(latest):
    """A developer's clean clone on a feature branch cut from an older
    commit: its working tree stays on that branch."""
    checkout = latest.root / "dev-lyria"
    _git("clone", "-q", latest.upstream.uri, str(checkout))
    _git("checkout", "-q", "-b", "my-feature", latest.upstream.a, cwd=checkout)

    state = sidecar._fast_forward_checkout(_cfg(checkout))

    assert state["state"] == "branch"
    assert "my-feature" in state["reason"]
    assert _git("rev-parse", "HEAD", cwd=checkout) == latest.upstream.a
    assert _git("symbolic-ref", "--short", "HEAD", cwd=checkout) == "my-feature"


def test_an_installed_clone_follows_each_new_commit_on_its_branch(latest):
    """Install clones the default branch. The upstream gains a commit; Update
    fast-forwards the branch to it (still on main, not detached), and the
    origin tracking ref follows, so git status in the checkout shows no local
    commits. A second Update with nothing new says so and changes nothing."""
    target = latest.root / "fresh" / "lyria"
    target.parent.mkdir()
    commit = sidecar._clone_latest("git", target, subprocess.DEVNULL)
    assert commit == latest.upstream.c
    (target / "node_modules").mkdir()
    upstream = latest.upstream.path
    (upstream / "CHANGES.md").write_text("new\n", encoding="utf-8")
    _git("add", "-A", cwd=upstream)
    _git("commit", "-q", "-m", "D: newer", cwd=upstream)
    newer = _git("rev-parse", "HEAD", cwd=upstream)

    state = sidecar._fast_forward_checkout(_cfg(target))

    assert state["state"] == "updated"
    assert _git("rev-parse", "HEAD", cwd=target) == newer
    assert _git("symbolic-ref", "--short", "HEAD", cwd=target) == "main"
    assert _git("rev-parse", "origin/main", cwd=target) == newer
    assert "ahead" not in _git("status", "-sb", cwd=target)

    again = sidecar._fast_forward_checkout(_cfg(target))
    assert again["state"] == "current"
    assert again["reason"] == f"Lyria is at the latest commit, {newer[:7]}."


def test_install_clones_the_latest_commit_of_the_default_branch(latest):
    target = latest.root / "fresh" / "lyria"
    target.parent.mkdir()

    commit = sidecar._clone_latest("git", target, subprocess.DEVNULL)

    assert commit == latest.upstream.c
    assert _git("rev-parse", "HEAD", cwd=target) == latest.upstream.c
    assert _git("symbolic-ref", "--short", "HEAD", cwd=target) == "main"
    assert (target / "server" / "keys.ts").is_file()
    assert sidecar.checkout_key_slots(target) == {
        "GEMINI_API_KEY": 10,
        "OPENROUTER_API_KEY": 10,
    }
    assert not (target.parent / ".lyria.install-staging").exists()


def test_a_failed_clone_leaves_nothing_behind(latest, monkeypatch):

    monkeypatch.setattr(
        sidecar, "LYRIA_REPO_URL", (latest.root / "no-such-repo").as_uri()
    )
    target = latest.root / "fresh" / "lyria"
    target.parent.mkdir()

    with pytest.raises(RuntimeError, match="git clone failed"):
        sidecar._clone_latest("git", target, subprocess.DEVNULL)

    assert not target.exists()
    assert not (target.parent / ".lyria.install-staging").exists()


def test_check_latest_says_an_update_is_waiting_and_asks_github_once(
    latest, monkeypatch
):
    """The Lyria panel opens on an old install and asks whether a newer
    commit exists: ls-remote answers C, which is not HEAD. Opening the panel
    again within ten minutes does not ask GitHub again."""
    checkout = _existing_install(latest, latest.upstream.a)
    monkeypatch.setattr(sidecar, "DEFAULT_PROJECT_PATH", checkout)
    asks: list[list[str]] = []
    real_git_run = sidecar._git_run

    def _counting(git, args, cwd, timeout=60.0):
        if "ls-remote" in args:
            asks.append(args)
        return real_git_run(git, args, cwd, timeout)

    monkeypatch.setattr(sidecar, "_git_run", _counting)

    first = sidecar.check_latest()
    assert first == {
        "head": latest.upstream.a,
        "latest": latest.upstream.c,
        "available": True,
    }
    assert _git("rev-parse", "HEAD", cwd=checkout) == latest.upstream.a
    second = sidecar.check_latest()
    assert second == first
    assert len(asks) == 1


def test_a_failed_check_is_not_asked_again_on_every_open(latest, monkeypatch):
    """GitHub cannot be reached: the first open asks and fails, and opening
    the panel again within ten minutes does not start another git ls-remote
    (each can wait out the fetch timeout). After ten minutes, or when forced,
    it asks again."""
    checkout = _existing_install(latest, latest.upstream.a)
    monkeypatch.setattr(sidecar, "DEFAULT_PROJECT_PATH", checkout)
    monkeypatch.setattr(
        sidecar, "LYRIA_REPO_URL", (latest.root / "unreachable").as_uri()
    )
    asks: list[list[str]] = []
    real_git_run = sidecar._git_run

    def _counting(git, args, cwd, timeout=60.0):
        if "ls-remote" in args:
            asks.append(args)
        return real_git_run(git, args, cwd, timeout)

    monkeypatch.setattr(sidecar, "_git_run", _counting)

    unanswered = {"head": latest.upstream.a, "latest": None, "available": False}
    assert sidecar.check_latest() == unanswered
    assert sidecar.check_latest() == unanswered
    assert len(asks) == 1

    sidecar._checkout_state["latest_checked_at"] -= sidecar.CHECKOUT_RETRY_SEC + 1
    assert sidecar.check_latest() == unanswered
    assert len(asks) == 2
    sidecar.check_latest(force=True)
    assert len(asks) == 3


def test_update_route_reports_the_job_and_refuses_without_a_checkout(
    latest, monkeypatch
):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.modules.lyria import router as lyria_router

    monkeypatch.setattr(sidecar, "DEFAULT_PROJECT_PATH", latest.root / "missing")
    app = FastAPI()
    app.include_router(lyria_router.router, prefix="/api/lyria")
    local = TestClient(app, client=_LOOPBACK)

    refused = local.post("/api/lyria/update")
    assert refused.status_code == 409
    assert "no Lyria checkout" in refused.json()["detail"]

    checkout = _existing_install(latest, latest.upstream.a)
    monkeypatch.setattr(sidecar, "DEFAULT_PROJECT_PATH", checkout)
    started = local.post("/api/lyria/update")
    assert started.status_code == 200, started.text
    deadline = time.monotonic() + 60.0
    while time.monotonic() < deadline:
        body = local.get("/api/lyria/update").json()
        if body["job"]["status"] in ("done", "error"):
            break
        time.sleep(0.02)
    assert body["job"]["status"] == "done", body
    assert body["checkout"]["state"] == "updated"
    assert body["compat"]["reads_key_lists"] is True
    assert _git("rev-parse", "HEAD", cwd=checkout) == latest.upstream.c


# ---------------------------------------------------------------------------
# What a checkout reads, from its own source
# ---------------------------------------------------------------------------


def test_key_slots_follow_what_each_variable_of_the_checkout_reads(tmp_path):
    """Three checkouts: one whose server.ts reads numbered Gemini slots with
    an explicit max of 3 and OpenRouter as one key; one that calls
    numberedEnvValues without server/keys.ts (a half-merged tree); and the
    old shape. Each gets exactly what it reads."""
    partial = tmp_path / "partial"
    (partial / "server").mkdir(parents=True)
    (partial / "package.json").write_text("{}", encoding="utf-8")
    (partial / "server" / "keys.ts").write_text(
        "export function numberedEnvValues(env: NodeJS.ProcessEnv, prefix: "
        "string, max = 10): string[] {\n",
        encoding="utf-8",
    )
    (partial / "server.ts").write_text(
        'numberedEnv: numberedEnvValues(process.env, "GEMINI_API_KEY", 3),\n'
        "return clientKey || process.env.OPENROUTER_API_KEY;\n",
        encoding="utf-8",
    )
    half = tmp_path / "half"
    half.mkdir()
    (half / "server.ts").write_text(
        "numberedEnv: numberedEnvValues(process.env, 'GEMINI_API_KEY'),\n",
        encoding="utf-8",
    )

    assert sidecar.checkout_key_slots(partial) == {
        "GEMINI_API_KEY": 3,
        "OPENROUTER_API_KEY": 1,
    }
    assert sidecar.checkout_key_slots(half) == {
        "GEMINI_API_KEY": 1,
        "OPENROUTER_API_KEY": 1,
    }
    assert sidecar.checkout_key_slots(_old_checkout(tmp_path / "old")) == {
        "GEMINI_API_KEY": 1,
        "OPENROUTER_API_KEY": 1,
    }


def test_child_env_hands_each_variable_only_the_keys_it_reads(lyria_keys, tmp_path):
    for n in range(1, 6):
        sidecar.add_key("gemini", f"gemini-key-{n}")
        sidecar.add_key("openrouter", f"openrouter-key-{n}")
    partial = tmp_path / "partial"
    (partial / "server").mkdir(parents=True)
    (partial / "package.json").write_text(_LYRIA_PACKAGE_JSON, encoding="utf-8")
    (partial / "server" / "keys.ts").write_text(
        "export function numberedEnvValues(env, prefix, max = 10) {\n",
        encoding="utf-8",
    )
    (partial / "server.ts").write_text(
        "numberedEnv: numberedEnvValues(process.env, 'GEMINI_API_KEY', 3),\n"
        "return clientKey || process.env.OPENROUTER_API_KEY;\n",
        encoding="utf-8",
    )

    env = sidecar._child_env(_cfg(partial))

    assert _key_slots(env) == {
        "GEMINI_API_KEY": "gemini-key-1",
        "GEMINI_API_KEY_2": "gemini-key-2",
        "GEMINI_API_KEY_3": "gemini-key-3",
        "OPENROUTER_API_KEY": "openrouter-key-1",
    }


# ---------------------------------------------------------------------------
# The check a checkout passes before it gets keys, and the record of the
# commit it is at
# ---------------------------------------------------------------------------


def _record() -> dict:
    return json.loads(sidecar._CHECKOUT_RECORD_FILE.read_text(encoding="utf-8"))


def test_both_shapes_of_the_lyria_repo_pass_the_check(lyria_keys, tmp_path):
    """The user's own checkout at 192032e (one key per provider, no
    server/keys.ts) and the repo's head with server/keys.ts both name the
    package and read both variables, so both get keys, with nothing to
    compare against before a first run."""
    for project in (_old_checkout(tmp_path / "old"), _list_checkout(tmp_path / "new")):
        check = sidecar.verify_checkout(project)
        assert check["ok"] is True, check
        assert check["reason"] == ""
        assert check["package_name"] == "lyria-3-pro"
        assert check["package_version"] == "0.0.0"
        assert check["floor_version"] is None
        assert check["slots"] == {
            "GEMINI_API_KEY": True,
            "OPENROUTER_API_KEY": True,
        }


def test_the_check_refuses_the_wrong_package_a_missing_slot_and_an_older_version(
    lyria_keys, tmp_path
):
    """Four checkouts that must not be handed keys, each with a reason the
    card can show: no package.json at all, a package of another name, a
    server that no longer reads OPENROUTER_API_KEY, and a package.json
    version below the one that last ran."""
    bare = tmp_path / "bare"
    bare.mkdir()
    (bare / "server.ts").write_text("process.env.GEMINI_API_KEY", encoding="utf-8")
    check = sidecar.verify_checkout(bare)
    assert check["ok"] is False
    assert "package.json cannot be read" in check["reason"]
    assert "hands it no keys" in check["reason"]

    other = _list_checkout(tmp_path / "other")
    (other / "package.json").write_text(
        '{"name": "some-other-app", "version": "9.9.9"}', encoding="utf-8"
    )
    check = sidecar.verify_checkout(other)
    assert check["ok"] is False
    assert "'some-other-app', not lyria-3-pro" in check["reason"]

    renamed = _list_checkout(tmp_path / "renamed")
    (renamed / "server.ts").write_text(
        (renamed / "server.ts")
        .read_text(encoding="utf-8")
        .replace("OPENROUTER_API_KEY", "OPENROUTER_TOKEN"),
        encoding="utf-8",
    )
    check = sidecar.verify_checkout(renamed)
    assert check["ok"] is False
    assert "does not read OPENROUTER_API_KEY" in check["reason"]
    assert check["slots"] == {"GEMINI_API_KEY": True, "OPENROUTER_API_KEY": False}

    older = _list_checkout(tmp_path / "older")
    (older / "package.json").write_text(
        '{"name": "lyria-3-pro", "version": "1.2.0"}', encoding="utf-8"
    )
    ran = {**sidecar._empty_record(), "ran_version": "1.10.0"}
    check = sidecar.verify_checkout(older, ran)
    assert check["ok"] is False
    assert "says version 1.2.0, older than 1.10.0" in check["reason"]
    assert "Press Update" in check["reason"]
    assert check["floor_version"] == "1.10.0"
    # At or above the floor passes: the same version, and a later one.
    for version in ("1.10.0", "1.10", "1.11.0-beta.1", "2.0.0"):
        (older / "package.json").write_text(
            f'{{"name": "lyria-3-pro", "version": "{version}"}}', encoding="utf-8"
        )
        assert sidecar.verify_checkout(older, ran)["ok"] is True, version
    # A floor with no version to compare against it is refused too.
    (older / "package.json").write_text('{"name": "lyria-3-pro"}', encoding="utf-8")
    check = sidecar.verify_checkout(older, ran)
    assert check["ok"] is False
    assert "has no version to compare with 1.10.0" in check["reason"]


def test_a_checkout_that_fails_the_check_is_handed_no_keys(
    lyria_keys, tmp_path, monkeypatch, caplog
):
    """Keys in the environment, in the Lyria card and in the shared pool,
    then a spawn from a checkout whose package.json names another package:
    the child's environment holds none of them, not even the inherited
    ones, the reason is logged (never a key), and verify_state carries it
    for /api/lyria/url."""
    monkeypatch.setenv("GEMINI_API_KEY", "env-gemini-secret")
    monkeypatch.setenv("GEMINI_API_KEY_2", "env-gemini-secret-two")
    monkeypatch.setenv("OPENROUTER_API_KEY", "env-openrouter-secret")
    sidecar.add_key("gemini", "file-gemini-secret")
    sidecar.add_key("openrouter", "file-openrouter-secret")
    lyria_keys.pools["gemini"] = ["pool-gemini-secret"]
    sidecar.set_pool_shared(True)
    project = _list_checkout(tmp_path / "impostor")
    (project / "package.json").write_text(
        '{"name": "not-lyria", "version": "0.0.0"}', encoding="utf-8"
    )

    with caplog.at_level("INFO"):
        env = sidecar._child_env(_cfg(project))

    assert _key_slots(env) == {}
    for value in (
        "env-gemini-secret",
        "env-gemini-secret-two",
        "env-openrouter-secret",
        "file-gemini-secret",
        "file-openrouter-secret",
        "pool-gemini-secret",
    ):
        assert value not in env.values()
    assert env["PORT"] == "5188" and env["LYRIA_MOCK"] == "1"
    assert "child keys withheld" in caplog.text
    assert "'not-lyria', not lyria-3-pro" in caplog.text
    assert "secret" not in caplog.text
    state = sidecar.verify_state()
    assert state["ok"] is False
    assert "'not-lyria', not lyria-3-pro" in state["reason"]

    # The same keys, a checkout that passes: every one of them is handed.
    env = sidecar._child_env(_cfg(_list_checkout(tmp_path / "real")))
    assert env["GEMINI_API_KEY"] == "env-gemini-secret"
    assert env["GEMINI_API_KEY_4"] == "pool-gemini-secret"
    assert env["OPENROUTER_API_KEY"] == "env-openrouter-secret"
    assert sidecar.verify_state()["ok"] is True


def test_install_records_the_commit_and_every_start_names_it(
    latest, monkeypatch, caplog
):
    """Install clones the latest commit: the record file holds that commit
    and the repo URL, and probe() reports both. Opening Lyria then logs the
    commit it starts from and records it as the last one that ran with keys,
    package version included, so the next check has its floor. A start from
    a checkout that fails the check leaves the floor alone."""
    target = latest.root / "lyria"
    monkeypatch.setattr(sidecar, "DEFAULT_PROJECT_PATH", target)
    monkeypatch.setattr(sidecar, "_ensure_deps", lambda cfg: None)
    with caplog.at_level("INFO"):
        sidecar.start_install()
        deadline = time.monotonic() + 60.0
        while time.monotonic() < deadline:
            if sidecar.install_status()["status"] in ("done", "error"):
                break
            time.sleep(0.02)
    assert sidecar.install_status()["status"] == "done", sidecar.install_status()
    record = _record()
    assert record["commit"] == latest.upstream.c
    assert record["commit_event"] == "install"
    assert record["repo_url"] == latest.upstream.uri
    assert record["ran_version"] is None
    assert f"at commit {latest.upstream.c}" in caplog.text
    status = sidecar.probe()
    assert status["checkout_record"]["commit"] == latest.upstream.c
    assert status["head"] == latest.upstream.c
    assert status["verify"]["ok"] is True

    (target / "package.json").write_text(
        '{"name": "lyria-3-pro", "version": "1.4.0"}\n', encoding="utf-8"
    )
    sidecar.add_key("gemini", "gemini-one")
    caplog.clear()
    with caplog.at_level("INFO"):
        env = _spawn_capturing_env(monkeypatch, target)
    assert env["GEMINI_API_KEY"] == "gemini-one"
    assert f"starting Lyria from {target} at commit {latest.upstream.c}" in caplog.text
    assert "package lyria-3-pro@1.4.0" in caplog.text
    record = _record()
    assert record["commit_event"] == "start"
    assert record["ran_commit"] == latest.upstream.c
    assert record["ran_version"] == "1.4.0"

    # The record survives what a backend restart forgets, and the floor it
    # holds refuses an older package.json on the next start: no keys, the
    # status says why, and the floor stays at 1.4.0.
    sidecar._proc = None
    (target / "package.json").write_text(
        '{"name": "lyria-3-pro", "version": "1.3.9"}\n', encoding="utf-8"
    )
    env = _spawn_capturing_env(monkeypatch, target)
    assert "GEMINI_API_KEY" not in env
    check = sidecar.probe()["verify"]
    assert check["ok"] is False
    assert "older than 1.4.0" in check["reason"]
    assert sidecar.verify_state()["ok"] is False
    assert _record()["ran_version"] == "1.4.0"


def test_head_is_read_from_the_git_folder_when_git_is_missing(latest, monkeypatch):
    """A machine that lost git after Install still names the commit: HEAD
    comes from .git itself, for a detached HEAD and for a branch, packed
    refs included."""
    checkout = _clone_install(latest)
    _git("pack-refs", "--all", cwd=checkout)
    monkeypatch.setattr(sidecar, "_git_path", lambda: None)
    assert sidecar.checkout_head(checkout) == latest.upstream.c
    _git("checkout", "-q", "--detach", latest.upstream.a, cwd=checkout)
    assert sidecar.checkout_head(checkout) == latest.upstream.a
    assert sidecar.checkout_head(latest.root / "nowhere") is None
