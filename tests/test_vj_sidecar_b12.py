"""Unit tests for backend.modules.vj.sidecar identity check (T30 / batch 12).

Covers the same INT-001 shape as tests/test_lyria_b12.py: a bare TCP
listener on the sidecar's port must not be adopted as "our sidecar" without
an identity check. VJ-9000 has no backend API route of its own (it is a
pure static SPA -- see the module docstring), so the identity check is
against two things it really does serve:

  * ``GET /piz_compressed.exr`` -> 200 with a non-``text/html`` Content-Type.
    This asset lives in ``VJ-9000/public/piz_compressed.exr`` and Vite
    serves everything under ``public/`` at the site root (in both ``vite``
    dev and ``vite preview``), so it is reachable at ``/piz_compressed.exr``
    either way. Verified directly against the real VJ-9000 checkout's
    ``public/`` directory (and its ``index.html`` / ``vite.config.ts``,
    for the other markers below). An
    ``Accept: application/octet-stream`` header is sent on both the HEAD
    and the GET-fallback request, and any ``text/html`` response is treated
    as a miss regardless of status -- Vite's dev-server SPA fallback
    (``htmlFallbackMiddleware``) answers ANY missing path with 200
    text/html (the real index page) when no/loose Accept header is present,
    so a bare HEAD/GET against a nonexistent path on ANY Vite SPA dev
    server would otherwise look identical to a real match. This was proven
    against a real Vite 6.4.2 template server in the T30 re-audit.
  * ``GET /`` HTML carries ``/src/main.tsx`` (a plain ``vite`` dev server,
    unbundled source, served at ``/``) or ``/vj-app/assets/`` (the served
    ``dist/`` was produced by ``vite build``, which sets ``base: '/vj-app/'``
    for EVERY build in ``VJ-9000/vite.config.ts`` -- baked into the built
    HTML/JS at build time). ``vite preview`` itself always serves at root
    ``/`` (it resolves its own config with ``command: 'serve'``, so its own
    ``base`` is ``/``), but it serves that already-built HTML byte-for-byte,
    so the ``/vj-app/assets/`` marker still shows up in its response body.

The ``<title>My Google AI Studio App</title>`` marker used by an earlier
revision of this check is deliberately NOT required: it is the stock
AI Studio scaffold title shared by other local AI-Studio-generated
projects, and the field most likely to be renamed by a user.

No real npm/node/vite process is spawned -- throwaway ``http.server``
instances (and, for the raw-banner test, a bare TCP listener) stand in for
"something listening on the port" to exercise the identity check without
the real VJ-9000 checkout.
"""

from __future__ import annotations

import http.server
import socket
import threading
import time
from contextlib import contextmanager
from typing import Iterator

import pytest

from backend.modules.vj import sidecar


# ---------------------------------------------------------------------------
# Throwaway HTTP servers used to fake "something is listening on the port"
# ---------------------------------------------------------------------------


_VJ_DEV_HTML = (
    b'<!doctype html>\n<html lang="en">\n<head>\n'
    b'<meta charset="UTF-8" />\n'
    b"<title>My Google AI Studio App</title>\n</head>\n<body>\n"
    b'<div id="root"></div>\n'
    b'<script type="module" src="/src/main.tsx"></script>\n'
    b"</body>\n</html>\n"
)

_VJ_PREVIEW_HTML = (
    b'<!doctype html>\n<html lang="en">\n<head>\n'
    b'<meta charset="UTF-8" />\n'
    b"<title>My Google AI Studio App</title>\n"
    b'<script type="module" crossorigin src="/vj-app/assets/index-ntbRocgr.js"></script>\n'
    b'<link rel="stylesheet" crossorigin href="/vj-app/assets/index-Crv0ZJ54.css">\n'
    b"</head>\n<body>\n"
    b'<div id="root"></div>\n'
    b"</body>\n</html>\n"
)

_FAKE_EXR_BYTES = b"\x76\x2f\x31\x01" + b"\x00" * 32  # arbitrary stand-in bytes


class _PathAwareHandler(http.server.BaseHTTPRequestHandler):
    """Base handler: serves ``root_html`` at ``/`` and, when ``serve_exr`` is
    True, a non-html 200 on ``/piz_compressed.exr`` (HEAD and GET); any
    other path 404s. Subclasses set the two class attributes."""

    root_html: bytes = b""
    serve_exr: bool = False

    def log_message(self, *args: object) -> None:  # noqa: D102 - silence test logs
        pass

    def _send_exr(self, *, with_body: bool) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(_FAKE_EXR_BYTES)))
        self.end_headers()
        if with_body:
            self.wfile.write(_FAKE_EXR_BYTES)

    def _send_root(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(self.root_html)))
        self.end_headers()
        self.wfile.write(self.root_html)

    def _send_404(self) -> None:
        body = b"not found"
        self.send_response(404)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_HEAD(self) -> None:  # noqa: N802 - stdlib method name
        if self.path == "/piz_compressed.exr" and self.serve_exr:
            self._send_exr(with_body=False)
        else:
            self.send_response(404)
            self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/piz_compressed.exr":
            if self.serve_exr:
                self._send_exr(with_body=True)
            else:
                self._send_404()
        elif self.path == "/":
            self._send_root()
        else:
            self._send_404()


class _VJDevLikeHandler(_PathAwareHandler):
    """Answers like VJ-9000's own dev server (``vite --port``): dev index
    at ``/`` and the real ``/piz_compressed.exr`` asset (non-html type)."""

    root_html = _VJ_DEV_HTML
    serve_exr = True


class _VJPreviewLikeHandler(_PathAwareHandler):
    """Answers like VJ-9000's own preview server (``vite preview``,
    serving the ``base: '/vj-app/'`` build): preview index at ``/`` and the
    real ``/piz_compressed.exr`` asset (non-html type)."""

    root_html = _VJ_PREVIEW_HTML
    serve_exr = True


class _TemplateWithoutExrHandler(_PathAwareHandler):
    """The stock AI Studio scaffold index (title/root/main.tsx all match --
    other local AI-Studio-generated projects share this exact template) but
    with NO ``/piz_compressed.exr`` at all (real 404) -- must be rejected."""

    root_html = _VJ_DEV_HTML
    serve_exr = False


class _UnrelatedHandler(_PathAwareHandler):
    """Some other dev server that happens to be listening on the port."""

    root_html = b"<html><head><title>Not VJ</title></head><body>hi</body></html>"
    serve_exr = False


class _AlwaysHtmlFallbackHandler(http.server.BaseHTTPRequestHandler):
    """Simulates a SPA dev/static server whose fallback middleware answers
    EVERY path -- including an actually missing ``/piz_compressed.exr`` --
    with 200 ``text/html`` (the real index page), ignoring any Accept
    header entirely. Real Vite (``htmlFallbackMiddleware``) does this when
    no/loose Accept header is present; this handler represents the class of
    SPA servers that do it unconditionally regardless of Accept (finding 1,
    T30 re-audit -- proven against a real Vite 6.4.2 template server)."""

    def log_message(self, *args: object) -> None:  # noqa: D102
        pass

    def do_HEAD(self) -> None:  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(_VJ_DEV_HTML)))
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(_VJ_DEV_HTML)))
        self.end_headers()
        self.wfile.write(_VJ_DEV_HTML)


class _ExrHeadMethodNotAllowedHandler(_PathAwareHandler):
    """HEAD on the exr asset answers 405 (method not supported); GET
    answers correctly with a real non-html asset. The HEAD->GET fallback
    must trigger here (finding 3 positive case)."""

    root_html = _VJ_DEV_HTML
    serve_exr = True

    def do_HEAD(self) -> None:  # noqa: N802
        if self.path == "/piz_compressed.exr":
            self.send_response(405)
            self.send_header("Allow", "GET")
            self.send_header("Content-Length", "0")
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()


class _ExrHead404Handler(_PathAwareHandler):
    """HEAD on the exr asset answers a genuine 404 (not 405/501) -- even
    though GET would succeed with a real asset if it were tried, the
    fallback must NOT trigger for a plain 404 (finding 3 negative case)."""

    root_html = _VJ_DEV_HTML
    serve_exr = True  # GET would succeed if (wrongly) reached

    def do_HEAD(self) -> None:  # noqa: N802
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()


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
def _run_raw_banner_server(
    banner: bytes = b"SSH-2.0-OpenSSH_9.6\r\n",
) -> Iterator[int]:
    """A bare TCP listener that sends a non-HTTP banner and closes -- e.g.
    an SSH server that happens to be squatting on the port. Used to prove
    the identity probe returns False instead of raising (finding 6)."""
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    srv.listen(5)
    port = srv.getsockname()[1]
    stop = threading.Event()

    def _serve() -> None:
        srv.settimeout(0.2)
        while not stop.is_set():
            try:
                conn, _addr = srv.accept()
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
        stop.set()
        thread.join(timeout=5.0)
        srv.close()


# ---------------------------------------------------------------------------
# INT-001 shape -- identity check: exr + own-asset markers
# ---------------------------------------------------------------------------


def test_is_vj_server_true_for_matching_dev_index():
    with _run_server(_VJDevLikeHandler) as port:
        assert sidecar._is_vj_server(port) is True


def test_is_vj_server_true_for_matching_preview_index():
    with _run_server(_VJPreviewLikeHandler) as port:
        assert sidecar._is_vj_server(port) is True


def test_is_vj_server_false_for_unrelated_listener():
    with _run_server(_UnrelatedHandler) as port:
        assert sidecar._is_vj_server(port) is False


def test_is_vj_server_false_for_template_without_exr():
    """The stock AI Studio template (title/root/main.tsx all present) but
    without the VJ-9000-specific exr asset must be rejected -- the root
    markers alone are not sufficient."""
    with _run_server(_TemplateWithoutExrHandler) as port:
        assert sidecar._is_vj_server(port) is False


def test_is_vj_server_false_when_nothing_listening():
    # Port 1 is a privileged, essentially-never-bound port on every platform.
    assert sidecar._is_vj_server(1) is False


# ---------------------------------------------------------------------------
# Finding 1: SPA html-fallback must not be mistaken for the real exr asset
# ---------------------------------------------------------------------------


def test_is_vj_server_false_for_spa_html_fallback_everywhere():
    """A SPA fallback server that answers 200 text/html (the index page)
    for literally every path -- including /piz_compressed.exr -- must be
    rejected even though the root markers (title/root/main.tsx) all match.
    This is exactly the false-positive a real Vite 6.4.2 dev server
    produced in the T30 re-audit before the Content-Type gate was added."""
    with _run_server(_AlwaysHtmlFallbackHandler) as port:
        assert sidecar._is_vj_server(port) is False


def test_is_vj_server_true_when_exr_has_non_html_content_type():
    """A real, non-html-typed exr response (as VJ-9000 itself serves it)
    still passes -- the html-fallback gate doesn't reject legitimate
    matches."""
    with _run_server(_VJDevLikeHandler) as port:
        assert sidecar._is_vj_server(port) is True


# ---------------------------------------------------------------------------
# Finding 3: HEAD->GET fallback only on HTTPError 405/501
# ---------------------------------------------------------------------------


def test_is_vj_server_true_via_head_405_get_fallback():
    """HEAD answering 405 (method not supported) must fall back to GET,
    which succeeds. A real VJ-9000 instance (`vite` dev or `vite preview`)
    does NOT actually do this -- both answer HEAD on a static asset with a
    normal 200 (verified against node_modules/vite/dist/node/chunks/dep-*.js)
    -- this fake exists purely to prove the fallback logic itself works for
    a hypothetical non-Vite static server that might reject HEAD."""
    with _run_server(_ExrHeadMethodNotAllowedHandler) as port:
        assert sidecar._is_vj_server(port) is True


def test_is_vj_server_false_on_head_404_no_fallback():
    """HEAD answering a genuine 404 must NOT fall back to GET, even though
    GET would (wrongly, in this fake) succeed -- a 404 means the asset
    really isn't there, not "try again with a different method"."""
    with _run_server(_ExrHead404Handler) as port:
        assert sidecar._is_vj_server(port) is False


def test_is_vj_server_false_on_head_timeout_no_fallback():
    """A HEAD that times out (hung/slow listener) must NOT fall back to
    GET either -- only HTTPError 405/501 triggers the fallback. Uses a
    ThreadingHTTPServer (so the hung HEAD handler running on its own thread
    can't wedge the server against accepting/serving a would-be GET) and
    records every HTTP method actually received, then asserts GET was
    never attempted -- not just that this fake happens to reject it."""
    recorded_methods: list[str] = []

    class _RecordingHangHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args: object) -> None:  # noqa: D102
            pass

        def do_HEAD(self) -> None:  # noqa: N802
            recorded_methods.append("HEAD")
            if self.path == "/piz_compressed.exr":
                time.sleep(3)  # longer than the 1.0s client-side timeout
            else:
                self.send_response(404)
                self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            recorded_methods.append("GET")
            # Would succeed if (wrongly) reached -- proves the fallback
            # didn't fire, not just that this fake happens to reject GET.
            if self.path == "/piz_compressed.exr":
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(_FAKE_EXR_BYTES)))
                self.end_headers()
                self.wfile.write(_FAKE_EXR_BYTES)
            elif self.path == "/":
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(_VJ_DEV_HTML)))
                self.end_headers()
                self.wfile.write(_VJ_DEV_HTML)
            else:
                self.send_response(404)
                self.end_headers()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _RecordingHangHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        assert sidecar._is_vj_server(port) is False
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5.0)

    assert recorded_methods == ["HEAD"]
    assert "GET" not in recorded_methods


# ---------------------------------------------------------------------------
# Finding 6: a non-HTTP listener (e.g. an SSH banner) must not raise
# ---------------------------------------------------------------------------


def test_is_vj_server_false_for_raw_banner_listener():
    """Same class of bug the Lyria audit found: a bare TCP listener that
    speaks a non-HTTP protocol must make identity False, not blow up with
    an unhandled http.client exception."""
    with _run_raw_banner_server() as port:
        assert sidecar._is_vj_server(port) is False


# ---------------------------------------------------------------------------
# The identity probe must ignore HTTP_PROXY / http_proxy
# ---------------------------------------------------------------------------


def test_is_vj_server_ignores_http_proxy_env(monkeypatch):
    """A system/corporate proxy pointed at an unreachable address must not
    make the loopback identity probe fail -- it must never be consulted."""
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9")
    monkeypatch.setenv("http_proxy", "http://127.0.0.1:9")
    with _run_server(_VJDevLikeHandler) as port:
        assert sidecar._is_vj_server(port) is True


# ---------------------------------------------------------------------------
# probe() / ensure_running() -- adoption behaviour
# ---------------------------------------------------------------------------


def test_probe_reports_not_listening_when_port_held_by_unrelated_process(
    monkeypatch,
):
    monkeypatch.setenv("theDAW_VJ_DEV", "1")  # force the dev/port-based branch
    with _run_server(_UnrelatedHandler) as port:
        monkeypatch.setenv("theDAW_VJ_PORT", str(port))
        out = sidecar.probe()
        assert out["listening"] is False
        assert any("already in use" in issue for issue in out["issues"])


def test_probe_reports_listening_when_identity_confirmed(monkeypatch):
    monkeypatch.setenv("theDAW_VJ_DEV", "1")
    with _run_server(_VJDevLikeHandler) as port:
        monkeypatch.setenv("theDAW_VJ_PORT", str(port))
        out = sidecar.probe()
        assert out["listening"] is True
        assert not any("already in use" in issue for issue in out["issues"])


def test_ensure_running_raises_instead_of_adopting_unrelated_listener(monkeypatch):
    # Reset the module-global `_proc` through monkeypatch -- this test
    # relies on there being no live child of ours (which would route
    # through the "own child" branch instead) -- so it doesn't leak state
    # into/from other tests (monkeypatch restores the pre-test value on
    # teardown).
    monkeypatch.setattr(sidecar, "_proc", None)
    monkeypatch.setenv("theDAW_VJ_DEV", "1")
    with _run_server(_UnrelatedHandler) as port:
        monkeypatch.setenv("theDAW_VJ_PORT", str(port))
        with pytest.raises(RuntimeError, match="already in use"):
            sidecar.ensure_running(wait_for_ready=False)


def test_ensure_running_adopts_confirmed_vj_listener(monkeypatch):
    # This test sets the module-global `_resolved_url` via a successful
    # adopt -- reset it (and `_proc`, so it takes the no-live-child adopt
    # branch) through monkeypatch so it doesn't leak into other tests
    # (monkeypatch restores the pre-test value on teardown).
    monkeypatch.setattr(sidecar, "_resolved_url", None)
    monkeypatch.setattr(sidecar, "_proc", None)
    monkeypatch.setenv("theDAW_VJ_DEV", "1")
    with _run_server(_VJPreviewLikeHandler) as port:
        monkeypatch.setenv("theDAW_VJ_PORT", str(port))
        url = sidecar.ensure_running(wait_for_ready=False)
        assert url == f"http://localhost:{port}"


# ---------------------------------------------------------------------------
# Finding 2: ensure_running must not treat its own live child as "another
# process" on a transient identity-check miss during startup
# ---------------------------------------------------------------------------


def test_ensure_running_does_not_reject_own_live_child_as_foreign(monkeypatch):
    monkeypatch.setattr(sidecar, "_resolved_url", None)
    monkeypatch.setattr(sidecar, "_proc", None)
    monkeypatch.setattr(sidecar, "PORT_READY_TIMEOUT_SEC", 0.3)
    monkeypatch.setattr(sidecar, "PORT_POLL_INTERVAL_SEC", 0.05)

    class _FakeAliveProc:
        def poll(self) -> None:
            return None  # still running

        returncode = None

    monkeypatch.setattr(sidecar, "_proc", _FakeAliveProc())
    monkeypatch.setenv("theDAW_VJ_DEV", "1")
    with _run_server(_UnrelatedHandler) as port:
        monkeypatch.setenv("theDAW_VJ_PORT", str(port))
        # Must NOT raise "already in use by another process" about our own
        # child -- it should fall through to _await_ready and time out with
        # the "did not answer as VJ-9000" diagnosis instead.
        with pytest.raises(RuntimeError, match="did not answer as VJ-9000"):
            sidecar.ensure_running(wait_for_ready=True)


# ---------------------------------------------------------------------------
# Finding 3 (again, at the ensure_running level) + finding 4: distinct
# timeout messages, and the deadline is honoured before each network probe
# ---------------------------------------------------------------------------


def test_await_ready_reports_port_opened_but_not_confirmed(monkeypatch):
    """When something IS listening on the port for the whole wait window but
    never answers as VJ-9000, the timeout message must say so and name the
    missing marker -- not blame npm-install/vite startup."""
    monkeypatch.setattr(sidecar, "_resolved_url", None)
    monkeypatch.setattr(sidecar, "_proc", None)
    monkeypatch.setattr(sidecar, "PORT_READY_TIMEOUT_SEC", 0.3)
    monkeypatch.setattr(sidecar, "PORT_POLL_INTERVAL_SEC", 0.05)
    with _run_server(_UnrelatedHandler) as port:
        cfg = sidecar.VJConfig(
            project_path=sidecar.DEFAULT_PROJECT_PATH,
            port=port,
            npm_path="npm",
            node_path="node",
            dev_mode=True,
        )
        with pytest.raises(RuntimeError, match="opened port .* but did not answer"):
            sidecar._await_ready(cfg, f"http://localhost:{port}")


def test_await_ready_reports_plain_timeout_when_port_never_opens(monkeypatch):
    """When nothing ever listens on the port, the original 'didn't open
    port ... npm-install or vite startup hang' message still applies."""
    monkeypatch.setattr(sidecar, "_resolved_url", None)
    monkeypatch.setattr(sidecar, "_proc", None)
    monkeypatch.setattr(sidecar, "PORT_READY_TIMEOUT_SEC", 0.3)
    monkeypatch.setattr(sidecar, "PORT_POLL_INTERVAL_SEC", 0.05)
    cfg = sidecar.VJConfig(
        project_path=sidecar.DEFAULT_PROJECT_PATH,
        port=1,  # nothing ever listens here
        npm_path="npm",
        node_path="node",
        dev_mode=True,
    )
    with pytest.raises(RuntimeError, match="npm-install or vite startup hang"):
        sidecar._await_ready(cfg, "http://localhost:1")


def test_await_ready_skips_identity_probe_once_deadline_passed_after_listen_check(
    monkeypatch,
):
    """The deadline is re-checked immediately before the expensive identity
    probe (_is_vj_server can issue up to two 1.0s-timeout HTTP requests) --
    not just at the top of the loop -- so a hung/slow listener discovered
    right as the deadline expires can't push _state_lock's hold time (this
    runs inside ensure_running's `with _state_lock:`) further past
    PORT_READY_TIMEOUT_SEC than that one probe would already have cost."""
    monkeypatch.setattr(sidecar, "_resolved_url", None)
    monkeypatch.setattr(sidecar, "_proc", None)
    monkeypatch.setattr(sidecar, "PORT_READY_TIMEOUT_SEC", 0.05)
    monkeypatch.setattr(sidecar, "PORT_POLL_INTERVAL_SEC", 0.01)

    def _slow_listening_check(port: int, host: str = "127.0.0.1") -> bool:
        # Eats the whole deadline budget by itself, so by the time we'd be
        # about to call _is_vj_server the deadline has already passed.
        time.sleep(0.1)
        return True

    calls: list[int] = []

    def _spy_is_vj_server(port: int) -> bool:
        calls.append(port)
        return False

    monkeypatch.setattr(sidecar, "_port_is_listening", _slow_listening_check)
    monkeypatch.setattr(sidecar, "_is_vj_server", _spy_is_vj_server)

    cfg = sidecar.VJConfig(
        project_path=sidecar.DEFAULT_PROJECT_PATH,
        port=12345,
        npm_path="npm",
        node_path="node",
        dev_mode=True,
    )
    with pytest.raises(RuntimeError, match="opened port .* but did not answer"):
        sidecar._await_ready(cfg, "http://localhost:12345")
    assert calls == []


# ---------------------------------------------------------------------------
# Finding 1 (re-audit): spawn VJ-9000's vite directly, never rely on a
# second --port flag overriding the npm `dev` script's hardcoded --port=3000
# ---------------------------------------------------------------------------


def test_vite_spawn_cmd_dev_never_contains_banned_port_3000():
    """VJ-9000's package.json `dev` script is `vite --port=3000
    --host=0.0.0.0` -- port 3000 is banned on this machine. The spawn
    command must invoke vite directly with a single --port flag, never via
    `npm run dev -- --port ...` (which would carry the literal string
    "3000" from that script, however harmless the CLI's own dedup
    behavior happens to be for the currently-vendored vite version)."""
    cfg = sidecar.VJConfig(
        project_path=sidecar.DEFAULT_PROJECT_PATH,
        port=5187,
        npm_path="npm",
        node_path="node",
        dev_mode=True,
    )
    cmd = sidecar._vite_spawn_cmd(cfg, preview=False)
    assert "3000" not in cmd
    assert "npm" not in cmd[0].lower()
    assert cmd[0] == "node"
    assert str(sidecar._vite_bin_js(cfg.project_path)) in cmd
    assert "--port" in cmd
    assert cmd[cmd.index("--port") + 1] == "5187"
    assert cmd.count("--port") == 1


def test_vite_spawn_cmd_preview_never_contains_banned_port_3000():
    cfg = sidecar.VJConfig(
        project_path=sidecar.DEFAULT_PROJECT_PATH,
        port=5187,
        npm_path="npm",
        node_path="node",
        dev_mode=False,
    )
    cmd = sidecar._vite_spawn_cmd(cfg, preview=True)
    assert "3000" not in cmd
    assert "npm" not in cmd[0].lower()
    assert cmd[0] == "node"
    assert str(sidecar._vite_bin_js(cfg.project_path)) in cmd
    assert "preview" in cmd
    assert cmd.count("--port") == 1
    assert cmd[cmd.index("--port") + 1] == "5187"


def test_vite_bin_js_path_is_under_node_modules_vite_bin():
    cfg = sidecar.VJConfig(
        project_path=sidecar.DEFAULT_PROJECT_PATH,
        port=5187,
        npm_path="npm",
        node_path="node",
        dev_mode=True,
    )
    vite_js = sidecar._vite_bin_js(cfg.project_path)
    assert vite_js == cfg.project_path / "node_modules" / "vite" / "bin" / "vite.js"


# ---------------------------------------------------------------------------
# Finding 2 (re-audit): probe() reports "starting", not "already in use by
# another process", while our own child is alive but not answering yet
# ---------------------------------------------------------------------------


def test_probe_reports_starting_not_in_use_for_own_unconfirmed_child(monkeypatch):
    class _FakeAliveProc:
        def poll(self) -> None:
            return None  # still running

        returncode = None

    monkeypatch.setattr(sidecar, "_proc", _FakeAliveProc())
    monkeypatch.setattr(sidecar, "_resolved_url", None)
    monkeypatch.setenv("theDAW_VJ_DEV", "1")
    with _run_server(_UnrelatedHandler) as port:
        monkeypatch.setenv("theDAW_VJ_PORT", str(port))
        out = sidecar.probe()
        assert out["listening"] is False
        assert out["process_alive"] is True
        assert not any("already in use" in issue for issue in out["issues"])
        assert any("starting" in issue.lower() for issue in out["issues"])


# ---------------------------------------------------------------------------
# Findings 1 & 2 (5th T30 audit round): theDAW_VJ_PORT is validated, never
# passed straight through to the spawned vite argv
# ---------------------------------------------------------------------------


def test_resolve_config_refuses_banned_port_3000(monkeypatch):
    monkeypatch.setenv("theDAW_VJ_PORT", "3000")
    cfg = sidecar.resolve_config()
    assert cfg.port != 3000
    assert cfg.port == sidecar.DEFAULT_PORT


def test_resolve_config_refuses_banned_port_3000_with_surrounding_whitespace(
    monkeypatch,
):
    monkeypatch.setenv("theDAW_VJ_PORT", " 3000 ")
    cfg = sidecar.resolve_config()
    assert cfg.port != 3000
    assert cfg.port == sidecar.DEFAULT_PORT


@pytest.mark.parametrize("bad_port", ["0", "-1", "70000"])
def test_resolve_config_refuses_out_of_range_port(monkeypatch, bad_port):
    monkeypatch.setenv("theDAW_VJ_PORT", bad_port)
    cfg = sidecar.resolve_config()
    assert cfg.port == sidecar.DEFAULT_PORT


def test_resolve_config_accepts_a_valid_non_banned_port(monkeypatch):
    monkeypatch.setenv("theDAW_VJ_PORT", "6234")
    cfg = sidecar.resolve_config()
    assert cfg.port == 6234


def test_resolve_config_falls_back_to_default_on_malformed_port(monkeypatch):
    monkeypatch.setenv("theDAW_VJ_PORT", "not-a-port")
    cfg = sidecar.resolve_config()
    assert cfg.port == sidecar.DEFAULT_PORT


def test_vite_spawn_cmd_never_contains_3000_even_if_env_was_banned(monkeypatch):
    """End-to-end: even if theDAW_VJ_PORT=3000 was requested, the resolved
    config (and therefore the spawn argv) never carries it."""
    monkeypatch.setenv("theDAW_VJ_PORT", "3000")
    cfg = sidecar.resolve_config()
    cmd = sidecar._vite_spawn_cmd(cfg, preview=False)
    assert "3000" not in cmd
