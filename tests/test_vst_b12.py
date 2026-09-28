"""T03 VST BACKEND — batch 12 fixes.

LAN2: ``POST /api/vst/live/session`` refuses a non-loopback caller with 409 —
the native host it spawns binds a loopback-only WebSocket, so a LAN caller
could never reach the session it asked for, only exhaust process slots.

R5-2: the live-session ``plugin_path`` is policed by
``backend.modules.vst.path_policy`` (built, and unit-tested, by an earlier
ticket but never wired in) — only a path inside a scanned VST3 root is
accepted; UNC/network paths are rejected before touching the filesystem.

VST-003: ``scanner.scan_roots_signature`` fingerprints every ``.vst3`` bundle
under a root, at any nesting depth, not just the root's immediate children.

VST-001: coverage for two pieces of existing, previously-untested behaviour —
the single-thread VST host funnel (``backend.modules.vst.host.on_host_thread``)
and VST3 bundle-binary resolution (``backend.modules.vst.scanner._resolve_bundle_binary``).

Audit follow-up (same day):

1. LAN2's loopback check is meaningless unless it is judged on the address
   uvicorn's ``ProxyHeadersMiddleware`` substitutes in from a trusted proxy's
   ``X-Forwarded-For`` — otherwise every caller through the Vite dev proxy
   (which always connects to this backend from loopback itself, regardless of
   where the original browser request came from) reads as loopback. These
   tests wrap the router directly in ``ProxyHeadersMiddleware`` to prove the
   route's own logic is correct against that middleware's contract. (Correction
   from an earlier pass of this report: ``ProxyHeadersMiddleware`` IS already
   installed and trusting 127.0.0.1 in ``backend/run.py`` today — that is
   ``uvicorn.run``'s own default, ``proxy_headers=True`` +
   ``forwarded_allow_ips="127.0.0.1"``, not something that file has to opt
   into.)
2. R5-2's containment check is extended to ``/load``, ``/process-file`` and
   ``/open-editor``, which each took a browser-supplied ``plugin_path`` and
   checked only ``exists()``.
4. The loopback check itself is hardened: exact-string matching is replaced
   with ``ipaddress.ip_address(host).is_loopback``.

Re-audit follow-up (same day, second pass):

1. ``/open-editor`` keys its session files (preset/rect/size/pid) and
   ``_editor_procs`` on the RESOLVED plugin path, but ``/editor-rect``,
   ``/editor-size``, ``/editor-result`` and ``_editor_alive`` still hashed
   whatever raw ``plugin_path`` string the caller sent — a forward-slash,
   different-case, or junction/symlink form of the same path the browser
   happens to send on a later call misses the session entirely. Fixed with
   one shared helper, ``_canonical_plugin_key``, used by all five editor
   routes; the read/update routes never 403 or refuse a lookup over policy,
   they just use the same key ``/open-editor`` already resolved.
2. The two comments above (and in ``frontend/vite.config.ts``) that claimed
   ``backend/run.py`` needed a change for XFF to take effect were wrong —
   corrected in place.
3. ``/scan/{path}`` could list plugins from ANY directory, including ones
   ``/load``/``/process-file``/``/open-editor``/``/live/session`` would then
   refuse — it is now policed by the same containment check (403 outside
   ``path_policy.allowed_roots()``).
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.modules.vst import host as vst_host  # noqa: E402
from backend.modules.vst import live_host as lh  # noqa: E402
from backend.modules.vst import path_policy  # noqa: E402
from backend.modules.vst import scanner  # noqa: E402
from backend.modules.vst import router as vst_router  # noqa: E402
from backend.lib import launch_token  # noqa: E402
from backend.lib.known_paths import is_remote_or_device_path  # noqa: E402

# Backslash spellings and NT object-manager prefixes only mean something to
# Windows. Elsewhere they are inert characters in a filename: nothing resolves
# them, nothing reaches a network through them, and a 404 is the right answer,
# so these cases have nothing to assert off Windows.
_WINDOWS_ONLY = pytest.mark.skipif(
    sys.platform != "win32",
    reason="backslash path spellings and NT object-manager prefixes are Windows-only",
)

FAKE_HOST = Path(__file__).resolve().parent / "fake_vst_host.py"


# ---------------------------------------------------------------------------
# Fixtures shared by the LAN2 / R5-2 sections
# ---------------------------------------------------------------------------


@pytest.fixture
def vst3_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An allowed VST3 root, wired into both the scanner and the policy.

    ``path_policy.allowed_roots`` is patched directly (the same thing
    ``tests/test_vst_path_policy.py`` does) so this works regardless of
    which of the two names ``check_plugin_path`` resolves ``_default_vst3_dirs``
    through.
    """
    root = tmp_path / "VST3"
    root.mkdir()
    monkeypatch.setattr(scanner, "_default_vst3_dirs", lambda: [root])
    monkeypatch.setattr(path_policy, "allowed_roots", lambda: [root.resolve()])
    # A /scan call saves the scan cache. Unpatched, that is
    # backend/modules/vst/vst3_scan_cache.json in the tree running the suite,
    # and a run in the app's own tree replaced the user's real cache (every
    # probed plugin name and category) with this empty tmp root's.
    cache = tmp_path / "vst3_scan_cache.json"
    monkeypatch.setattr(scanner, "_cache_path", lambda: cache)
    # The editor routes save each plugin's window rect and size under
    # data/vst_presets, the same folder as the user's plugin state; left
    # unpatched, the loopback /editor-rect tests wrote Ozone11_*.rect.json
    # into the checkout running the suite.
    monkeypatch.setattr(vst_router, "_PRESET_DIR", tmp_path / "vst_presets")
    return root


@pytest.fixture
def plugin_file(vst3_root: Path) -> Path:
    path = vst3_root / "Ozone 11.vst3"
    path.write_bytes(b"not a real plugin, only the path is validated")
    return path


@pytest.fixture
def fake_host_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(lh.HOST_ENV_VAR, str(FAKE_HOST))


@pytest.fixture
def manager(tmp_path: Path, fake_host_env: None):
    mgr = lh.LiveSessionManager(root=tmp_path / "vst_live", spawn_timeout=20.0)
    try:
        yield mgr
    finally:
        mgr.kill_all()


@pytest.fixture
def client(manager, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """The real router mounted at /api/vst, backed by the test manager.

    Starlette's ``TestClient`` reports its TCP peer as ``testclient`` by
    default, not a loopback address; ``client=`` overrides that so tests
    against this fixture exercise the "legitimate local caller" path rather
    than tripping the LAN2 loopback gate.
    """
    monkeypatch.setattr(lh, "_MANAGER", manager, raising=False)
    app = FastAPI()
    app.include_router(vst_router.router, prefix="/api/vst")
    return TestClient(app, client=("127.0.0.1", 51000))


def _session_payload(plugin: Path, **overrides) -> dict:
    payload = {
        "chain_entry_id": "entry-1",
        "plugin_path": str(plugin),
        "sample_rate": 48000,
        "block_size": 512,
        "channels": 2,
    }
    payload.update(overrides)
    return payload


# ---------------------------------------------------------------------------
# LAN2 — /live/session is loopback-only
# ---------------------------------------------------------------------------


def test_live_session_from_a_lan_caller_is_403(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(lh, "_MANAGER", manager, raising=False)
    app = FastAPI()
    app.include_router(vst_router.router, prefix="/api/vst")
    lan_client = TestClient(app, client=("10.20.30.40", 51234))

    response = lan_client.post(
        "/api/vst/live/session", json=_session_payload(plugin_file)
    )

    assert response.status_code == 403
    # No session was created for the rejected caller.
    assert manager.list() == []


def test_live_session_from_loopback_ipv4_is_accepted(
    client: TestClient, plugin_file: Path, manager
) -> None:
    response = client.post("/api/vst/live/session", json=_session_payload(plugin_file))

    assert response.status_code == 200, response.text
    assert manager.list()[0].alive


def test_live_session_from_loopback_ipv6_is_accepted(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(lh, "_MANAGER", manager, raising=False)
    app = FastAPI()
    app.include_router(vst_router.router, prefix="/api/vst")
    v6_client = TestClient(app, client=("::1", 51234))

    response = v6_client.post(
        "/api/vst/live/session",
        json=_session_payload(plugin_file, chain_entry_id="entry-v6"),
    )

    assert response.status_code == 200, response.text


# ---------------------------------------------------------------------------
# R5-2 — plugin_path is policed by path_policy
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    [
        "\\\\server\\share\\x.vst3",
        "//server/share/x.vst3",
    ],
)
def test_create_rejects_a_unc_plugin_path(manager, raw: str) -> None:
    with pytest.raises(lh.LiveHostError) as excinfo:
        manager.create(
            chain_entry_id="entry-unc",
            plugin_path=raw,
            sample_rate=48000,
            block_size=512,
            channels=2,
        )
    assert excinfo.value.status_code == 400


def test_create_rejects_a_plugin_path_outside_the_allowed_roots(
    manager, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # An allowed root exists, but the plugin handed to create() lives
    # somewhere else entirely (a stand-in for a browser-supplied path that
    # was never one of the scanned directories).
    allowed = tmp_path / "VST3"
    allowed.mkdir()
    monkeypatch.setattr(scanner, "_default_vst3_dirs", lambda: [allowed])
    monkeypatch.setattr(path_policy, "allowed_roots", lambda: [allowed.resolve()])

    outside = tmp_path / "elsewhere" / "Escape.vst3"
    outside.parent.mkdir(parents=True)
    outside.write_bytes(b"not a real plugin")

    with pytest.raises(lh.LiveHostError) as excinfo:
        manager.create(
            chain_entry_id="entry-outside",
            plugin_path=str(outside),
            sample_rate=48000,
            block_size=512,
            channels=2,
        )
    assert excinfo.value.status_code == 403


def test_create_accepts_a_plugin_path_inside_an_allowed_root(
    manager, plugin_file: Path
) -> None:
    session = manager.create(
        chain_entry_id="entry-allowed",
        plugin_path=str(plugin_file),
        sample_rate=48000,
        block_size=512,
        channels=2,
    )
    assert session.plugin_path == str(plugin_file.resolve())


# ---------------------------------------------------------------------------
# VST-003 — scan_roots_signature covers nested bundle directories
# ---------------------------------------------------------------------------


def test_scan_roots_signature_changes_when_a_nested_bundle_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "VST3"
    nested_dir = root / "VendorA" / "SubVendor"
    nested_dir.mkdir(parents=True)
    bundle = nested_dir / "Plugin.vst3"
    bundle.mkdir()
    (bundle / "Contents").mkdir()
    monkeypatch.setattr(scanner, "_default_vst3_dirs", lambda: [root])

    before = scanner.scan_roots_signature()

    # Touch only the bundle two levels below root; neither the root's own
    # mtime nor its immediate child's mtime changes.
    future = time.time() + 120
    os.utime(bundle, (future, future))

    after = scanner.scan_roots_signature()

    assert before != after


def test_scan_roots_signature_is_stable_when_nothing_changed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "VST3"
    bundle = root / "Vendor" / "Plugin.vst3"
    bundle.mkdir(parents=True)
    monkeypatch.setattr(scanner, "_default_vst3_dirs", lambda: [root])

    assert scanner.scan_roots_signature() == scanner.scan_roots_signature()


# ---------------------------------------------------------------------------
# VST-001 — the host funnel (existing behaviour, previously untested)
# ---------------------------------------------------------------------------


def test_on_host_thread_serializes_calls_onto_one_dedicated_thread() -> None:
    @vst_host.on_host_thread
    def current_thread_name() -> str:
        return threading.current_thread().name

    first = current_thread_name()
    second = current_thread_name()

    assert first == second
    assert first.startswith(vst_host._HOST_THREAD_PREFIX)
    assert threading.current_thread().name != first


def test_on_host_thread_calls_from_within_the_funnel_run_inline() -> None:
    """A funnelled call made from the funnel's own thread must not
    re-dispatch to itself — the executor has exactly one worker, so
    re-dispatching would deadlock waiting on the very call that is blocking
    it."""

    @vst_host.on_host_thread
    def inner() -> str:
        return threading.current_thread().name

    @vst_host.on_host_thread
    def outer() -> str:
        return inner()

    result = outer()

    assert result.startswith(vst_host._HOST_THREAD_PREFIX)


# ---------------------------------------------------------------------------
# VST-001 — VST3 bundle-binary resolution (existing behaviour, previously
# untested)
# ---------------------------------------------------------------------------


def test_resolve_bundle_binary_finds_the_exact_named_module(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(scanner.platform, "system", lambda: "Windows")
    monkeypatch.setattr(scanner, "_arch_dirs", lambda: ("x86_64-win",))

    bundle = tmp_path / "Plugin.vst3"
    arch_dir = bundle / "Contents" / "x86_64-win"
    arch_dir.mkdir(parents=True)
    exact = arch_dir / "Plugin.vst3"
    exact.write_bytes(b"binary")

    assert scanner._resolve_bundle_binary(bundle) == exact


def test_resolve_bundle_binary_falls_back_to_any_module_in_the_arch_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(scanner.platform, "system", lambda: "Windows")
    monkeypatch.setattr(scanner, "_arch_dirs", lambda: ("x86_64-win",))

    bundle = tmp_path / "Plugin.vst3"
    arch_dir = bundle / "Contents" / "x86_64-win"
    arch_dir.mkdir(parents=True)
    odd = arch_dir / "SomethingElse.vst3"
    odd.write_bytes(b"binary")

    assert scanner._resolve_bundle_binary(bundle) == odd


def test_resolve_bundle_binary_prefers_earlier_arch_dirs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(scanner.platform, "system", lambda: "Windows")
    monkeypatch.setattr(scanner, "_arch_dirs", lambda: ("arm64-win", "x86_64-win"))

    bundle = tmp_path / "Plugin.vst3"
    x64 = bundle / "Contents" / "x86_64-win"
    x64.mkdir(parents=True)
    (x64 / "Plugin.vst3").write_bytes(b"binary")
    arm = bundle / "Contents" / "arm64-win"
    arm.mkdir(parents=True)
    arm_binary = arm / "Plugin.vst3"
    arm_binary.write_bytes(b"binary")

    assert scanner._resolve_bundle_binary(bundle) == arm_binary


def test_resolve_bundle_binary_returns_none_for_no_supported_architecture(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(scanner.platform, "system", lambda: "Windows")
    monkeypatch.setattr(scanner, "_arch_dirs", lambda: ("x86_64-win",))

    bundle = tmp_path / "Plugin.vst3"
    (bundle / "Contents" / "arm64-win").mkdir(parents=True)

    assert scanner._resolve_bundle_binary(bundle) is None


def test_resolve_bundle_binary_on_macos_returns_the_bundle_itself(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(scanner.platform, "system", lambda: "Darwin")

    bundle = tmp_path / "Plugin.vst3"
    bundle.mkdir()

    assert scanner._resolve_bundle_binary(bundle) == bundle


# ---------------------------------------------------------------------------
# Audit follow-up item 1 — LAN2 must judge the address uvicorn's
# ProxyHeadersMiddleware substitutes in from a trusted proxy's
# X-Forwarded-For, not the proxy's own (always-loopback) peer address.
# ---------------------------------------------------------------------------


def _proxied_client(
    monkeypatch: pytest.MonkeyPatch,
    manager,
    peer: tuple[str, int] = ("127.0.0.1", 59999),
) -> TestClient:
    """The router wrapped in uvicorn's own ``ProxyHeadersMiddleware``, trusting
    only 127.0.0.1 (the default, and what ``backend/run.py`` would need to
    pass as ``forwarded_allow_ips``).
    """
    monkeypatch.setattr(lh, "_MANAGER", manager, raising=False)
    app = FastAPI()
    app.include_router(vst_router.router, prefix="/api/vst")
    wrapped = ProxyHeadersMiddleware(app, trusted_hosts="127.0.0.1")
    return TestClient(wrapped, client=peer)


def test_live_session_xff_lan_address_from_a_trusted_proxy_is_403(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    proxied = _proxied_client(monkeypatch, manager)

    response = proxied.post(
        "/api/vst/live/session",
        json=_session_payload(plugin_file),
        headers={"X-Forwarded-For": "10.0.0.5"},
    )

    assert response.status_code == 403
    assert manager.list() == []


def test_live_session_xff_loopback_ipv4_from_a_trusted_proxy_is_accepted(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    proxied = _proxied_client(monkeypatch, manager)

    response = proxied.post(
        "/api/vst/live/session",
        json=_session_payload(plugin_file),
        headers={"X-Forwarded-For": "127.0.0.1"},
    )

    assert response.status_code == 200, response.text


def test_live_session_xff_loopback_ipv6_from_a_trusted_proxy_is_accepted(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    proxied = _proxied_client(monkeypatch, manager)

    response = proxied.post(
        "/api/vst/live/session",
        json=_session_payload(plugin_file, chain_entry_id="entry-xff-v6"),
        headers={"X-Forwarded-For": "::1"},
    )

    assert response.status_code == 200, response.text


def test_live_session_ignores_a_spoofed_xff_from_an_untrusted_peer(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A direct caller cannot forge loopback by sending the header itself —
    ``ProxyHeadersMiddleware`` only honours ``X-Forwarded-For`` from a
    trusted peer, and ``10.20.30.40`` is not one.
    """
    proxied = _proxied_client(monkeypatch, manager, peer=("10.20.30.40", 51234))

    response = proxied.post(
        "/api/vst/live/session",
        json=_session_payload(plugin_file),
        headers={"X-Forwarded-For": "127.0.0.1"},
    )

    assert response.status_code == 403


# ---------------------------------------------------------------------------
# Audit follow-up item 4 — loopback determination is a real IP-address check
# ---------------------------------------------------------------------------


class _StubClient:
    def __init__(self, host: str) -> None:
        self.host = host


class _StubRequest:
    """A ``Request`` stand-in exposing only what ``_caller_is_loopback``
    reads (``request.client.host``) — enough to exercise ``_require_loopback``
    without going through a real ASGI connection."""

    def __init__(self, host: str | None) -> None:
        self.client = _StubClient(host) if host is not None else None


@pytest.mark.parametrize(
    ("host", "expected"),
    [
        ("127.0.0.1", True),
        ("::1", True),
        ("[::1]", True),  # a bracketed peer must not be refused (item 2)
        ("::ffff:127.0.0.1", True),
        ("10.0.0.5", False),
        ("::ffff:10.0.0.5", False),
        ("testclient", False),
        ("localhost", False),
        ("", False),
        ("   ", False),
        (None, False),  # no TCP peer at all (request.client is None)
    ],
)
def test_require_loopback_judges_the_real_peer_ip(
    host: str | None, expected: bool
) -> None:
    """Former coverage for the now-removed ``_is_loopback_host`` — that
    function was production dead code (its only non-definition reference was
    this test), so this exercises the actual production gate,
    ``_require_loopback``, against a stub ``Request`` instead."""
    request = _StubRequest(host)
    if expected:
        vst_router._require_loopback(request)  # must not raise
    else:
        with pytest.raises(HTTPException) as excinfo:
            vst_router._require_loopback(request)
        assert excinfo.value.status_code == 403


# ---------------------------------------------------------------------------
# Audit follow-up item 2 — /load, /process-file, /open-editor are policed by
# path_policy the same way /live/session already is.
# ---------------------------------------------------------------------------


def test_load_rejects_a_plugin_path_outside_the_allowed_roots(
    client: TestClient, vst3_root: Path, tmp_path: Path
) -> None:
    outside = tmp_path / "elsewhere" / "Escape.vst3"
    outside.parent.mkdir(parents=True)
    outside.write_bytes(b"not a real plugin")

    response = client.post(
        "/api/vst/load", json={"plugin_path": str(outside), "instance_id": "i1"}
    )

    assert response.status_code == 403


def test_load_rejects_a_unc_plugin_path(client: TestClient, vst3_root: Path) -> None:
    response = client.post(
        "/api/vst/load",
        json={"plugin_path": "\\\\server\\share\\x.vst3", "instance_id": "i1"},
    )

    assert response.status_code == 400


def test_load_rejects_a_dotdot_escape(client: TestClient, vst3_root: Path) -> None:
    escape = str(vst3_root / ".." / "Escape.vst3")

    response = client.post(
        "/api/vst/load", json={"plugin_path": escape, "instance_id": "i1"}
    )

    assert response.status_code == 403


def test_load_accepts_a_plugin_path_inside_the_allowed_root(
    client: TestClient, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Proves containment does not block the legitimate path — the actual
    pedalboard load is faked out, since ``plugin_file`` is not a real VST3.
    """
    calls: list[str] = []

    class _FakeInstance:
        instance_id = "i1"
        plugin_name = "Fake"
        plugin_path = str(plugin_file.resolve())
        parameters: dict = {}

    def fake_load_plugin(path: str, instance_id: str):
        calls.append(path)
        return _FakeInstance()

    monkeypatch.setattr(vst_router, "load_plugin", fake_load_plugin)

    response = client.post(
        "/api/vst/load", json={"plugin_path": str(plugin_file), "instance_id": "i1"}
    )

    assert response.status_code == 200, response.text
    assert calls == [str(plugin_file.resolve())]


def test_process_file_rejects_a_plugin_path_outside_the_allowed_roots(
    client: TestClient, vst3_root: Path, tmp_path: Path
) -> None:
    outside = tmp_path / "elsewhere" / "Escape.vst3"
    outside.parent.mkdir(parents=True)
    outside.write_bytes(b"not a real plugin")

    response = client.post(
        "/api/vst/process-file",
        files={"audio": ("in.wav", b"not really audio", "audio/wav")},
        data={"plugin_path": str(outside)},
    )

    assert response.status_code == 403


def test_process_file_rejects_a_unc_plugin_path(
    client: TestClient, vst3_root: Path
) -> None:
    response = client.post(
        "/api/vst/process-file",
        files={"audio": ("in.wav", b"not really audio", "audio/wav")},
        data={"plugin_path": "//server/share/x.vst3"},
    )

    assert response.status_code == 400


def test_process_file_rejects_a_dotdot_escape(
    client: TestClient, vst3_root: Path
) -> None:
    escape = str(vst3_root / ".." / "Escape.vst3")

    response = client.post(
        "/api/vst/process-file",
        files={"audio": ("in.wav", b"not really audio", "audio/wav")},
        data={"plugin_path": escape},
    )

    assert response.status_code == 403


def test_open_editor_rejects_a_plugin_path_outside_the_allowed_roots(
    client: TestClient, vst3_root: Path, tmp_path: Path
) -> None:
    outside = tmp_path / "elsewhere" / "Escape.vst3"
    outside.parent.mkdir(parents=True)
    outside.write_bytes(b"not a real plugin")

    response = client.post("/api/vst/open-editor", json={"plugin_path": str(outside)})

    assert response.status_code == 403


def test_open_editor_rejects_a_unc_plugin_path(
    client: TestClient, vst3_root: Path
) -> None:
    response = client.post(
        "/api/vst/open-editor",
        json={"plugin_path": "\\\\server\\share\\x.vst3"},
    )

    assert response.status_code == 400


def test_open_editor_rejects_a_dotdot_escape(
    client: TestClient, vst3_root: Path
) -> None:
    escape = str(vst3_root / ".." / "Escape.vst3")

    response = client.post("/api/vst/open-editor", json={"plugin_path": escape})

    assert response.status_code == 403


def test_open_editor_accepts_a_plugin_path_inside_the_allowed_root(
    client: TestClient, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(vst_router, "_PRESET_DIR", plugin_file.parent / "presets")

    class _FakeProc:
        pid = 4242

    monkeypatch.setattr(vst_router.subprocess, "Popen", lambda *a, **k: _FakeProc())

    response = client.post(
        "/api/vst/open-editor", json={"plugin_path": str(plugin_file)}
    )

    assert response.status_code == 200, response.text


# ---------------------------------------------------------------------------
# Re-audit item 1 — every editor route hashes the same canonical key,
# regardless of slash style.
# ---------------------------------------------------------------------------


@_WINDOWS_ONLY
def test_editor_routes_agree_on_a_session_opened_with_a_different_slash_style(
    client: TestClient, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Open with the native (backslash, on Windows) form; poll every other
    editor route with the forward-slash form of the SAME path. All four must
    find the session ``/open-editor`` started, not report it missing.
    """
    monkeypatch.setattr(vst_router, "_PRESET_DIR", plugin_file.parent / "presets")

    class _FakeProc:
        pid = 4242

        def poll(self) -> int | None:
            return None

    monkeypatch.setattr(vst_router.subprocess, "Popen", lambda *a, **k: _FakeProc())

    native = str(plugin_file)
    forward_slash = native.replace("\\", "/")
    assert forward_slash != native, "the fixture path has no backslash to vary"

    opened = client.post("/api/vst/open-editor", json={"plugin_path": native})
    assert opened.status_code == 200, opened.text

    result = client.get("/api/vst/editor-result", params={"plugin_path": forward_slash})
    assert result.status_code == 200
    assert result.json()["status"] == "launching", (
        "editor-result did not find the session opened with the native path "
        "form — it hashed a different key for the forward-slash form"
    )

    size = client.get("/api/vst/editor-size", params={"plugin_path": forward_slash})
    assert size.status_code == 200
    # {"status": "none"} is correct here (the fake sidecar never wrote a size
    # file); the point of this assertion is that both slash forms compute the
    # exact same on-disk key, not merely that neither call raised.
    assert vst_router._size_path(native) == vst_router._size_path(forward_slash)
    assert size.json() == {"status": "none"}

    rect = client.post(
        "/api/vst/editor-rect",
        json={"plugin_path": forward_slash, "x": 1, "y": 2, "w": 3, "h": 4},
    )
    assert rect.status_code == 200, rect.text
    # The rect file the forward-slash call wrote must be the SAME file the
    # native-path form would compute — proving one shared key, not merely
    # "both calls happened to succeed".
    assert vst_router._rect_path(native) == vst_router._rect_path(forward_slash)
    assert vst_router._rect_path(native).is_file()


def test_canonical_plugin_key_normalizes_slash_style(tmp_path: Path) -> None:
    native = str(tmp_path / "Sub" / "Plugin.vst3")
    forward_slash = native.replace("\\", "/")

    assert vst_router._canonical_plugin_key(native) == vst_router._canonical_plugin_key(
        forward_slash
    )


def test_canonical_plugin_key_never_raises_on_an_out_of_policy_path() -> None:
    """A read/update editor route must not 403 or crash over policy — it just
    needs a stable key, even for an input path_policy would reject outright.
    """
    key = vst_router._canonical_plugin_key("\\\\server\\share\\x.vst3")
    assert isinstance(key, str)
    assert key  # did not blow up, produced something to hash


# ---------------------------------------------------------------------------
# Re-audit item 3 — /scan/{path} is policed the same way the load routes are
# ---------------------------------------------------------------------------


def test_scan_custom_rejects_a_directory_outside_the_allowed_roots(
    client: TestClient, vst3_root: Path, tmp_path: Path
) -> None:
    outside = tmp_path / "elsewhere"
    outside.mkdir()

    response = client.get(f"/api/vst/scan/{outside}")

    assert response.status_code == 403


def test_scan_custom_rejects_a_unc_directory(
    client: TestClient, vst3_root: Path
) -> None:
    response = client.get("/api/vst/scan/\\\\server\\share")

    assert response.status_code == 400


def test_scan_custom_rejects_a_dotdot_escape(
    client: TestClient, vst3_root: Path
) -> None:
    escape = str(vst3_root / "..")

    response = client.get(f"/api/vst/scan/{escape}")

    assert response.status_code == 403


def test_scan_custom_accepts_a_directory_inside_the_allowed_root(
    client: TestClient, vst3_root: Path
) -> None:
    sub = vst3_root / "Vendor"
    sub.mkdir()

    response = client.get(f"/api/vst/scan/{sub}")

    assert response.status_code == 200, response.text
    assert response.json()["plugins"] == []


def test_scan_custom_with_zero_allowed_roots_gives_an_actionable_message(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No standard VST3 directory exists on this machine at all — the
    "0 allowed VST3 directories" phrasing is meaningless to a user; this must
    say what to do instead.
    """
    monkeypatch.setattr(path_policy, "allowed_roots", lambda: [])
    somewhere = tmp_path / "anywhere"
    somewhere.mkdir()

    response = client.get(f"/api/vst/scan/{somewhere}")

    assert response.status_code == 403
    detail = response.json()["detail"]
    assert "0 allowed" not in detail
    assert "install a vst3 plugin" in detail.lower()


# ---------------------------------------------------------------------------
# Re-audit item 3 — GET /live/sessions, GET /live/session/{id} and DELETE
# /live/session/{id} are loopback-gated too, not just POST /live/session.
# ---------------------------------------------------------------------------


def test_list_live_sessions_from_a_lan_caller_is_403(
    manager, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(lh, "_MANAGER", manager, raising=False)
    app = FastAPI()
    app.include_router(vst_router.router, prefix="/api/vst")
    lan_client = TestClient(app, client=("10.20.30.40", 51234))

    response = lan_client.get("/api/vst/live/sessions")

    assert response.status_code == 403


def test_list_live_sessions_from_loopback_is_accepted(client: TestClient) -> None:
    response = client.get("/api/vst/live/sessions")

    assert response.status_code == 200, response.text


def test_get_live_session_from_a_lan_caller_is_403(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(lh, "_MANAGER", manager, raising=False)
    app = FastAPI()
    app.include_router(vst_router.router, prefix="/api/vst")
    loopback = TestClient(app, client=("127.0.0.1", 51000))
    created = loopback.post(
        "/api/vst/live/session", json=_session_payload(plugin_file)
    ).json()

    lan_client = TestClient(app, client=("10.20.30.40", 51234))
    response = lan_client.get(f"/api/vst/live/session/{created['session_id']}")

    assert response.status_code == 403


def test_get_live_session_from_loopback_is_accepted(
    client: TestClient, plugin_file: Path
) -> None:
    created = client.post(
        "/api/vst/live/session", json=_session_payload(plugin_file)
    ).json()

    response = client.get(f"/api/vst/live/session/{created['session_id']}")

    assert response.status_code == 200, response.text


def test_delete_live_session_from_a_lan_caller_is_403_and_does_not_delete(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(lh, "_MANAGER", manager, raising=False)
    app = FastAPI()
    app.include_router(vst_router.router, prefix="/api/vst")
    loopback = TestClient(app, client=("127.0.0.1", 51000))
    created = loopback.post(
        "/api/vst/live/session", json=_session_payload(plugin_file)
    ).json()

    lan_client = TestClient(app, client=("10.20.30.40", 51234))
    response = lan_client.delete(f"/api/vst/live/session/{created['session_id']}")

    assert response.status_code == 403
    # The LAN caller did not kill the plugin host mid-performance.
    assert any(s.session_id == created["session_id"] for s in manager.list())


def test_delete_live_session_from_loopback_is_accepted(
    client: TestClient, plugin_file: Path
) -> None:
    created = client.post(
        "/api/vst/live/session", json=_session_payload(plugin_file)
    ).json()

    response = client.delete(f"/api/vst/live/session/{created['session_id']}")

    assert response.status_code == 200, response.text


# ---------------------------------------------------------------------------
# Re-audit item 4 — scan_roots_signature counts a Windows/Linux bundle once
# ---------------------------------------------------------------------------


def test_scan_roots_signature_counts_each_bundle_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A Windows/Linux bundle's inner module (``Contents/<arch>/Plugin.vst3``)
    matches the same ``*.vst3`` pattern as the bundle directory itself; the
    signature must not walk into it and count the plugin twice.
    """
    root = tmp_path / "VST3"
    bundle = root / "Vendor" / "Plugin.vst3"
    arch_dir = bundle / "Contents" / "x86_64-win"
    arch_dir.mkdir(parents=True)
    (arch_dir / "Plugin.vst3").write_bytes(b"binary")
    monkeypatch.setattr(scanner, "_default_vst3_dirs", lambda: [root])

    sig = scanner.scan_roots_signature()

    # One entry for the root, one for the bundle — never a second one for
    # the module inside it.
    assert sig.count("|") == 1
    assert str(bundle) in sig
    assert str(arch_dir / "Plugin.vst3") not in sig


# ---------------------------------------------------------------------------
# Second re-audit item 1 — /open-editor and /editor-rect close=true are
# gated by require_loopback_or_launch_token, not just LAN2's _require_loopback
# ---------------------------------------------------------------------------


def _lan_client(monkeypatch: pytest.MonkeyPatch, manager) -> TestClient:
    monkeypatch.setattr(lh, "_MANAGER", manager, raising=False)
    app = FastAPI()
    app.include_router(vst_router.router, prefix="/api/vst")
    return TestClient(app, client=("10.20.30.40", 51234))


def test_open_editor_from_a_lan_caller_is_403_and_spawns_nothing(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(vst_router, "_PRESET_DIR", plugin_file.parent / "presets")
    spawned: list[object] = []
    monkeypatch.setattr(
        vst_router.subprocess, "Popen", lambda *a, **k: spawned.append(1)
    )
    lan_client = _lan_client(monkeypatch, manager)

    response = lan_client.post(
        "/api/vst/open-editor", json={"plugin_path": str(plugin_file)}
    )

    assert response.status_code == 403
    assert spawned == [], "a LAN caller must not spawn a plugin-editor sidecar"


def test_open_editor_from_loopback_is_accepted(
    client: TestClient, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(vst_router, "_PRESET_DIR", plugin_file.parent / "presets")

    class _FakeProc:
        pid = 4242

    monkeypatch.setattr(vst_router.subprocess, "Popen", lambda *a, **k: _FakeProc())

    response = client.post(
        "/api/vst/open-editor", json={"plugin_path": str(plugin_file)}
    )

    assert response.status_code == 200, response.text


def test_open_editor_from_a_lan_caller_with_the_launch_token_is_accepted(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """require_loopback_or_launch_token, not a bare loopback check — the
    desktop shell itself may call this from a non-loopback-looking peer, and
    must still get through on the launch token alone."""
    monkeypatch.setattr(vst_router, "_PRESET_DIR", plugin_file.parent / "presets")

    class _FakeProc:
        pid = 4242

    monkeypatch.setattr(vst_router.subprocess, "Popen", lambda *a, **k: _FakeProc())
    monkeypatch.setenv(launch_token.ENV_VAR, "the-real-token")
    lan_client = _lan_client(monkeypatch, manager)

    response = lan_client.post(
        "/api/vst/open-editor",
        json={"plugin_path": str(plugin_file)},
        headers={launch_token.HEADER: "the-real-token"},
    )

    assert response.status_code == 200, response.text


def test_editor_rect_close_from_a_lan_caller_is_403_and_writes_no_file(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lan_client = _lan_client(monkeypatch, manager)

    response = lan_client.post(
        "/api/vst/editor-rect",
        json={"plugin_path": str(plugin_file), "close": True},
    )

    assert response.status_code == 403
    assert not vst_router._rect_path(str(plugin_file)).exists()


def test_editor_rect_close_from_loopback_is_accepted(
    client: TestClient, plugin_file: Path
) -> None:
    response = client.post(
        "/api/vst/editor-rect",
        json={"plugin_path": str(plugin_file), "close": True},
    )

    assert response.status_code == 200, response.text
    assert vst_router._rect_path(str(plugin_file)).is_file()


def test_editor_rect_non_close_from_a_lan_caller_is_403_and_writes_no_file(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """T03 batch-12 fix: a plain viewport move/resize writes the same rect
    file ``win_embed.py`` uses to ``SetWindowPos`` and clip the embedded
    window, so it must be gated exactly like close=true -- a LAN caller must
    not be able to shove an open editor offscreen via this branch."""
    lan_client = _lan_client(monkeypatch, manager)

    response = lan_client.post(
        "/api/vst/editor-rect",
        json={"plugin_path": str(plugin_file), "x": 1, "y": 2, "w": 3, "h": 4},
    )

    assert response.status_code == 403
    assert not vst_router._rect_path(str(plugin_file)).exists()


def test_editor_rect_non_close_from_loopback_is_accepted(
    client: TestClient, plugin_file: Path
) -> None:
    response = client.post(
        "/api/vst/editor-rect",
        json={"plugin_path": str(plugin_file), "x": 1, "y": 2, "w": 3, "h": 4},
    )

    assert response.status_code == 200, response.text
    assert vst_router._rect_path(str(plugin_file)).is_file()


# ---------------------------------------------------------------------------
# T03 batch-12, fifth-audit MAJOR #2 — /load, /process, /process-file,
# /scan and /scan/{path} are LAN-reachable and must be loopback-gated.
# ---------------------------------------------------------------------------


def test_load_from_a_lan_caller_is_403_and_loads_nothing(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[str] = []
    monkeypatch.setattr(
        vst_router, "load_plugin", lambda path, instance_id: calls.append(path)
    )
    lan_client = _lan_client(monkeypatch, manager)

    response = lan_client.post(
        "/api/vst/load", json={"plugin_path": str(plugin_file), "instance_id": "i1"}
    )

    assert response.status_code == 403
    assert calls == [], "a LAN caller must not initialize a plugin instance"


def test_process_from_a_lan_caller_is_403(
    manager, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[object] = []
    monkeypatch.setattr(vst_router, "process_chain", lambda *a, **k: calls.append(1))
    lan_client = _lan_client(monkeypatch, manager)

    response = lan_client.post(
        "/api/vst/process",
        json={"instance_ids": ["i1"], "audio_path": "C:/does/not/matter.wav"},
    )

    assert response.status_code == 403
    assert calls == [], "a LAN caller must not run the VST processing chain"


def test_process_file_from_a_lan_caller_is_403(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lan_client = _lan_client(monkeypatch, manager)

    response = lan_client.post(
        "/api/vst/process-file",
        files={"audio": ("in.wav", b"not really audio", "audio/wav")},
        data={"plugin_path": str(plugin_file)},
    )

    assert response.status_code == 403


def test_scan_from_a_lan_caller_is_403(
    manager, vst3_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lan_client = _lan_client(monkeypatch, manager)

    response = lan_client.get("/api/vst/scan")

    assert response.status_code == 403


def test_scan_from_loopback_is_accepted(client: TestClient, vst3_root: Path) -> None:
    response = client.get("/api/vst/scan?enrich=false")

    assert response.status_code == 200, response.text


def test_a_scan_in_this_suite_never_writes_the_apps_own_scan_cache(
    client: TestClient, vst3_root: Path, tmp_path: Path
) -> None:
    """The sequence a developer runs: the app has scanned (its cache sits
    beside scanner.py), then the suite runs a /scan. The suite's scan must
    land in its own tmp cache and leave the app's cache as it was."""
    real = Path(scanner.__file__).parent / scanner._CACHE_FILENAME
    before = real.stat().st_mtime_ns if real.exists() else None

    response = client.get("/api/vst/scan?enrich=false")

    assert response.status_code == 200, response.text
    after = real.stat().st_mtime_ns if real.exists() else None
    assert after == before, "the suite rewrote backend/modules/vst's scan cache"
    assert (tmp_path / "vst3_scan_cache.json").is_file()


def test_scan_custom_from_a_lan_caller_is_403(
    manager, vst3_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sub = vst3_root / "Vendor"
    sub.mkdir()
    lan_client = _lan_client(monkeypatch, manager)

    response = lan_client.get(f"/api/vst/scan/{sub}")

    assert response.status_code == 403


# ---------------------------------------------------------------------------
# T03 batch-12, fifth-audit MAJOR #3 — /process's audio_path/output_path are
# policed by the same known_paths remote/device check every other
# path-taking route in this repo applies.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    [
        "\\\\server\\share\\in.wav",
        "//server/share/in.wav",
    ],
)
def test_process_rejects_a_unc_audio_path(client: TestClient, raw: str) -> None:
    response = client.post(
        "/api/vst/process", json={"instance_ids": ["i1"], "audio_path": raw}
    )

    assert response.status_code == 400


def test_process_rejects_a_unc_output_path(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src = tmp_path / "in.wav"
    src.write_bytes(b"not really audio")

    def _must_not_run(*a, **k):
        raise AssertionError("output_path must be rejected before processing")

    monkeypatch.setattr(vst_router, "process_chain", _must_not_run)

    response = client.post(
        "/api/vst/process",
        json={
            "instance_ids": ["i1"],
            "audio_path": str(src),
            "output_path": "\\\\server\\share\\out.wav",
        },
    )

    assert response.status_code == 400


# ---------------------------------------------------------------------------
# T03 batch-12, fifth-audit MINOR #4 — GET /live/host is gated like every
# other /live/* route.
# ---------------------------------------------------------------------------


def test_live_host_from_a_lan_caller_is_403(
    manager, monkeypatch: pytest.MonkeyPatch
) -> None:
    lan_client = _lan_client(monkeypatch, manager)

    response = lan_client.get("/api/vst/live/host")

    assert response.status_code == 403


def test_live_host_from_loopback_is_accepted(client: TestClient) -> None:
    response = client.get("/api/vst/live/host")

    assert response.status_code == 200, response.text


# ---------------------------------------------------------------------------
# T03 batch-12, fifth-audit MINOR #5 — _is_loopback_host is removed;
# coverage moved to test_require_loopback_judges_the_real_peer_ip above.
# ---------------------------------------------------------------------------


def test_is_loopback_host_no_longer_exists() -> None:
    """Confirms the dead code from MINOR #5 is actually gone, not just
    untested."""
    assert not hasattr(vst_router, "_is_loopback_host")


# ---------------------------------------------------------------------------
# T03 batch-12, fifth-audit MINOR #6 — path_policy.root_contains is the one
# public containment predicate; router.py no longer has its own copy.
# ---------------------------------------------------------------------------


def test_within_an_allowed_root_no_longer_exists() -> None:
    assert not hasattr(vst_router, "_within_an_allowed_root")


def test_root_contains_is_public_and_case_insensitive_on_this_platform(
    tmp_path: Path,
) -> None:
    root = tmp_path / "VST3"
    root.mkdir()
    inside = root / "Vendor" / "Plugin.vst3"

    assert path_policy.root_contains(root, inside) is True
    if sys.platform == "win32":
        assert path_policy.root_contains(Path(str(root).upper()), inside) is True


# ---------------------------------------------------------------------------
# T03 batch-12, fifth-audit MINOR #7 — the scan-signature walk prunes a
# directory it has already visited (a Windows junction cycling back to an
# ancestor), instead of recursing without bound.
# ---------------------------------------------------------------------------


def _make_junction(link: Path, target: Path) -> bool:
    """``mklink /J`` under ``cmd``; returns False (skip the test) when
    junction creation is unavailable on this machine/user account rather
    than failing the whole suite over an environment gap."""
    if sys.platform != "win32":
        return False
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True,
        text=True,
    )
    return result.returncode == 0 and link.is_dir()


def test_walk_vst3_paths_prunes_a_junction_cycling_back_to_an_ancestor(
    tmp_path: Path,
) -> None:
    root = tmp_path / "VST3"
    (root / "Vendor").mkdir(parents=True)
    plugin = root / "Vendor" / "Plugin.vst3"
    plugin.mkdir()
    (plugin / "marker").write_text("x")

    junction = root / "Vendor" / "loop-back"
    if not _make_junction(junction, root):
        pytest.skip("junction creation unavailable on this machine/account")

    try:
        found = scanner._walk_vst3_paths(root)
    finally:
        # A junction is a reparse point, not a real subtree: remove the link
        # itself, never its target's contents.
        try:
            junction.rmdir()
        except OSError:
            pass

    assert found == [plugin]


def test_walk_vst3_paths_prunes_a_junction_cycling_back_to_a_sibling(
    tmp_path: Path,
) -> None:
    root = tmp_path / "VST3"
    (root / "A").mkdir(parents=True)
    (root / "B").mkdir(parents=True)
    plugin = root / "A" / "Plugin.vst3"
    plugin.mkdir()

    junction = root / "B" / "loop-to-a"
    if not _make_junction(junction, root / "A"):
        pytest.skip("junction creation unavailable on this machine/account")

    try:
        found = scanner._walk_vst3_paths(root)
    finally:
        try:
            junction.rmdir()
        except OSError:
            pass

    assert found == [plugin]


# ---------------------------------------------------------------------------
# T03 batch-12, sixth-audit MAJOR #1 -- /process's remote/device guard is
# judged against the RESOLVED path too, not just the raw text, so an NT
# object-manager prefix (``\??\UNC\...``, ``\??\GLOBALROOT\Device\...``)
# cannot walk straight through it and reach the network or an unintended
# device.
# ---------------------------------------------------------------------------


@_WINDOWS_ONLY
def test_is_remote_or_device_path_misses_the_raw_nt_unc_prefix() -> None:
    """Documents WHY the raw-text check alone (the pre-fix guard) was
    insufficient: an NT object-manager UNC prefix has only ONE leading
    backslash, so the raw text does not match, and only resolving it reveals
    the real (rejectable) UNC path underneath."""
    raw = r"\??\UNC\localhost\C$\Windows\win.ini"
    assert is_remote_or_device_path(raw) is False
    resolved = str(Path(raw).resolve(strict=False))
    assert is_remote_or_device_path(resolved) is True


@_WINDOWS_ONLY
@pytest.mark.parametrize(
    "raw",
    [
        r"\??\UNC\localhost\C$\Windows\win.ini",
        r"\??\GLOBALROOT\Device\HarddiskVolume999\Windows\win.ini",
    ],
)
def test_process_rejects_an_nt_object_manager_audio_path(
    client: TestClient, raw: str
) -> None:
    response = client.post(
        "/api/vst/process", json={"instance_ids": ["i1"], "audio_path": raw}
    )

    assert response.status_code == 400


@pytest.mark.parametrize(
    "raw",
    [
        r"\??\UNC\localhost\C$\Windows\win.ini",
        r"\??\GLOBALROOT\Device\HarddiskVolume999\Windows\win.ini",
    ],
)
def test_process_rejects_an_nt_object_manager_output_path(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, raw: str
) -> None:
    src = tmp_path / "in.wav"
    src.write_bytes(b"not really audio")

    def _must_not_run(*a, **k):
        raise AssertionError("output_path must be rejected before processing")

    monkeypatch.setattr(vst_router, "process_chain", _must_not_run)

    response = client.post(
        "/api/vst/process",
        json={
            "instance_ids": ["i1"],
            "audio_path": str(src),
            "output_path": raw,
        },
    )

    assert response.status_code == 400


# ---------------------------------------------------------------------------
# T03 batch-12, sixth-audit MAJOR #2 -- PUT /param/{instance_id} is gated
# like every other state-changing VST route.
# ---------------------------------------------------------------------------


def test_set_param_from_a_lan_caller_is_403_and_does_not_mutate(
    manager, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[tuple[str, float]] = []

    class _FakeInstance:
        def set_parameter(self, name: str, value: float) -> None:
            calls.append((name, value))

    monkeypatch.setattr(vst_router, "get_instance", lambda instance_id: _FakeInstance())
    lan_client = _lan_client(monkeypatch, manager)

    response = lan_client.put(
        "/api/vst/param/inst-1", json={"name": "gain", "value": 0.99}
    )

    assert response.status_code == 403
    assert calls == [], "a LAN caller must not mutate a loaded plugin's parameters"


def test_set_param_from_loopback_is_accepted(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[tuple[str, float]] = []

    class _FakeInstance:
        parameters = {"gain": {"value": 0.99, "raw_value": 0.99, "label": ""}}

        def set_parameter(self, name: str, value: float) -> None:
            calls.append((name, value))

    monkeypatch.setattr(vst_router, "get_instance", lambda instance_id: _FakeInstance())

    response = client.put("/api/vst/param/inst-1", json={"name": "gain", "value": 0.99})

    assert response.status_code == 200, response.text
    assert calls == [("gain", 0.99)]


# ---------------------------------------------------------------------------
# T03 batch-12, sixth-audit MAJOR #3 -- DELETE /unload/{instance_id} is
# gated like every other state-changing VST route.
# ---------------------------------------------------------------------------


def test_unload_from_a_lan_caller_is_403_and_does_not_unload(
    manager, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[str] = []
    monkeypatch.setattr(
        vst_router, "unload_plugin", lambda instance_id: calls.append(instance_id)
    )
    lan_client = _lan_client(monkeypatch, manager)

    response = lan_client.delete("/api/vst/unload/inst-1")

    assert response.status_code == 403
    assert calls == [], "a LAN caller must not unload a plugin instance"


def test_unload_from_loopback_is_accepted(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[str] = []
    monkeypatch.setattr(
        vst_router, "unload_plugin", lambda instance_id: calls.append(instance_id)
    )

    response = client.delete("/api/vst/unload/inst-1")

    assert response.status_code == 200, response.text
    assert calls == ["inst-1"]


# ---------------------------------------------------------------------------
# T03 batch-12, sixth-audit MAJOR #4 -- GET /plugins is gated: it leaks
# absolute plugin paths and the instance ids MAJOR #2/#3 need to target.
# ---------------------------------------------------------------------------


def test_get_loaded_plugins_from_a_lan_caller_is_403(
    manager, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        vst_router,
        "list_instances",
        lambda: [{"instance_id": "inst-1", "plugin_path": "C:/secret/Plugin.vst3"}],
    )
    lan_client = _lan_client(monkeypatch, manager)

    response = lan_client.get("/api/vst/plugins")

    assert response.status_code == 403


def test_get_loaded_plugins_from_loopback_is_accepted(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        vst_router,
        "list_instances",
        lambda: [{"instance_id": "inst-1", "plugin_path": "C:/secret/Plugin.vst3"}],
    )

    response = client.get("/api/vst/plugins")

    assert response.status_code == 200, response.text
    assert response.json() == [
        {"instance_id": "inst-1", "plugin_path": "C:/secret/Plugin.vst3"}
    ]


# ---------------------------------------------------------------------------
# T03 batch-12, sixth-audit MINOR #5 -- GET /editor-size and GET
# /editor-result are gated: a LAN caller who guesses a plugin path must not
# be able to poll or disturb another session's editor state.
# ---------------------------------------------------------------------------


def test_editor_size_from_a_lan_caller_is_403(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lan_client = _lan_client(monkeypatch, manager)

    response = lan_client.get(
        "/api/vst/editor-size", params={"plugin_path": str(plugin_file)}
    )

    assert response.status_code == 403


def test_editor_size_from_loopback_is_accepted(
    client: TestClient, plugin_file: Path
) -> None:
    response = client.get(
        "/api/vst/editor-size", params={"plugin_path": str(plugin_file)}
    )

    assert response.status_code == 200, response.text
    assert response.json() == {"status": "none"}


def test_editor_result_from_a_lan_caller_is_403(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lan_client = _lan_client(monkeypatch, manager)

    response = lan_client.get(
        "/api/vst/editor-result", params={"plugin_path": str(plugin_file)}
    )

    assert response.status_code == 403


def test_editor_result_from_loopback_is_accepted(
    client: TestClient, plugin_file: Path
) -> None:
    response = client.get(
        "/api/vst/editor-result", params={"plugin_path": str(plugin_file)}
    )

    assert response.status_code == 200, response.text
    assert response.json() == {"status": "none"}


# ---------------------------------------------------------------------------
# T03 batch-12, sixth-audit MINOR #6 -- scanner._dir_identity rejects an
# st_ino of 0 (some filesystems report it for every entry) so it can never
# be mistaken for a real, poisoning identity.
# ---------------------------------------------------------------------------


def test_dir_identity_returns_none_for_a_zero_inode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_stat = Path.stat

    class _FakeStat:
        st_dev = 1
        st_ino = 0

    def _fake_stat(self, *a, **k):
        if self == tmp_path:
            return _FakeStat()
        return real_stat(self, *a, **k)

    monkeypatch.setattr(Path, "stat", _fake_stat)

    assert scanner._dir_identity(tmp_path) is None


# ---------------------------------------------------------------------------
# T03 batch-12, seventh-audit N4 -- the VST router carries refuse_cross_site
# router-wide, matching backup/places/project/storage.
# ---------------------------------------------------------------------------


def test_scan_from_a_cross_site_page_is_refused(
    client: TestClient, vst3_root: Path
) -> None:
    """A foreign page's GET (a CORS-simple request CORS cannot stop from
    executing) must not reach /scan -- it would trigger a full filesystem
    walk on the user's behalf."""
    response = client.get(
        "/api/vst/scan?enrich=false",
        headers={
            "origin": "http://evil.example.com",
            "sec-fetch-site": "cross-site",
        },
    )

    assert response.status_code == 403


def test_scan_from_a_bare_client_with_no_browser_headers_is_unaffected(
    client: TestClient, vst3_root: Path
) -> None:
    """A non-browser caller sending none of Sec-Fetch-Site/Origin/Referer
    passes refuse_cross_site unchanged (backend/lib/cross_site.py:46-49) --
    this router's own callers are all the frontend UI, but the router-level
    dependency must not regress a bare client."""
    response = client.get("/api/vst/scan?enrich=false")

    assert response.status_code == 200, response.text


# ---------------------------------------------------------------------------
# T03 batch-12, seventh-audit N3 -- GET /param/{instance_id} is gated like
# its write half, PUT /param/{instance_id}.
# ---------------------------------------------------------------------------


def test_get_param_from_a_lan_caller_is_403(
    manager, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _FakeInstance:
        parameters = {"gain": {"value": 0.5, "raw_value": 0.5, "label": ""}}

    monkeypatch.setattr(vst_router, "get_instance", lambda instance_id: _FakeInstance())
    lan_client = _lan_client(monkeypatch, manager)

    response = lan_client.get("/api/vst/param/inst-1")

    assert response.status_code == 403


def test_get_param_from_loopback_is_accepted(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _FakeInstance:
        parameters = {"gain": {"value": 0.5, "raw_value": 0.5, "label": ""}}

    monkeypatch.setattr(vst_router, "get_instance", lambda instance_id: _FakeInstance())

    response = client.get("/api/vst/param/inst-1")

    assert response.status_code == 200, response.text
    assert response.json() == {
        "instance_id": "inst-1",
        "parameters": {"gain": {"value": 0.5, "raw_value": 0.5, "label": ""}},
    }
