"""Batch-12 T02 security fixes.

SEC-001: genai-proxy's local-origin check trusted headers -- ``Origin`` AND
``Sec-Fetch-Site`` -- that a non-browser LAN client is free to forge (the
first fix here only distrusted a *missing* Sec-Fetch-Site; the independent
audit found a bare LAN script could just send
``Sec-Fetch-Site: same-origin`` itself and get through regardless). The
extra check is now header-blind: a non-loopback caller must carry the
desktop shell's launch token, a valid LAN pairing token
(``backend/lib/pairing.py``), or an already-validated opt-in
``theDAW_PROXY_TOKEN``.

Pairing token: a phone reaching this backend over a plain ``http://<lan-ip>``
share link is not a secure context, so its browser sends no ``Sec-Fetch-*``
headers at all -- indistinguishable from a script on headers alone. The
pairing token is the phone's real secret: minted once, persisted, handed out
only over a loopback-or-launch-token-gated route, and carried by the phone as
``X-TheDAW-Pair``.

ITW security P1: project save with ``embed_audio``, ``/save-session`` and
``/export/audio`` chain into an arbitrary file write/read from LAN; plugin
reveal opens a native file-manager window. All refuse a non-loopback caller
that doesn't carry the launch token, the same way ``places/router.py``'s
``/record`` tells the desktop shell apart from anyone else -- loopback
callers (this machine's own UI) are unaffected. The three project routes
additionally accept the LAN pairing token (the phone legitimately uses them);
plugin reveal does not -- pairing never unlocks it.

SEC-003: ``GanFile.extract`` and the plugin runtime's asset server both used a
string-prefix check (``str(dest).startswith(str(out))``) to keep a .gan's
entries inside its extraction directory. A sibling directory that merely
shares the same string prefix (``out=".../plugins/foo"``,
``dest=".../plugins/foobar/evil.txt"``) passed that check although it is
outside ``out``. Both now use ``Path.is_relative_to`` on the resolved paths.

CORS: ``allow_origins=["*"]`` with credentials let any web page's JS read a
credentialed response. The middleware now only credentials loopback origins
(any port) and the packaged app's own custom scheme.
"""

from __future__ import annotations

import json
import threading
import zipfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from backend.lib import cross_site, known_paths, launch_token, pairing
from backend.lib import paths as backend_paths
from backend.modules.genaiproxy import access
from backend.modules.plugin import router as plugin_router
from backend.modules.plugin.gan_file import GanFile
from backend.modules.plugin.gan_manifest import GanManifest
from backend.modules.project import media_access
from backend.modules.project import router as project_router
from backend.modules.project.router import router as project_api

REPO = Path(__file__).resolve().parents[1]


def _request(headers: dict[str, str], client: tuple[str, int] | None) -> Request:
    scope: dict[str, object] = {
        "type": "http",
        "headers": [
            (k.lower().encode("latin-1"), v.encode("latin-1"))
            for k, v in headers.items()
        ],
    }
    if client is not None:
        scope["client"] = client
    return Request(scope)


# ---------------------------------------------------------------------------
# SEC-001 -- backend/modules/genaiproxy/access.py
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _no_proxy_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(access.TOKEN_ENV, raising=False)
    monkeypatch.delenv(launch_token.ENV_VAR, raising=False)


@pytest.fixture(autouse=True)
def _isolated_pairing_token(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Every test gets its own pairing-token file and a cleared in-process
    cache, so minting one in one test never leaks into another and none of
    them ever touch the real persisted token."""
    monkeypatch.setattr(pairing, "_TOKEN_FILE", tmp_path / "pairing_token.txt")
    monkeypatch.setattr(pairing, "_cached", None)


def test_lan_forged_local_origin_without_sec_fetch_site_is_denied() -> None:
    """The exact SEC-001 shape: a non-browser LAN script sends no
    Sec-Fetch-Site at all and forges a loopback-looking Origin.

    ``is_local_origin`` alone still says yes (it is shared with
    ``refuse_cross_site`` and must not change for every other caller); the
    extra SEC-001 gate lives in ``denial_reason``."""
    req = _request({"origin": "http://127.0.0.1:5173"}, client=("10.20.30.40", 51000))
    assert access.is_local_origin(req) is True
    assert access.denial_reason(req) is not None


def test_loopback_caller_without_sec_fetch_site_is_still_allowed() -> None:
    """A real caller on this machine (e.g. a native process) has no browser
    headers either, but its TCP peer really is loopback."""
    req = _request({"origin": "http://127.0.0.1:5173"}, client=("127.0.0.1", 51000))
    assert access.denial_reason(req) is None


def test_ipv6_loopback_caller_without_sec_fetch_site_is_allowed() -> None:
    """Behind Vite's xfwd dev proxy a local browser's TCP peer, as this
    backend sees it, can be reported as ``::1``."""
    req = _request({"origin": "http://127.0.0.1:5173"}, client=("::1", 51000))
    assert access.denial_reason(req) is None


def test_ipv4_mapped_ipv6_loopback_caller_without_sec_fetch_site_is_allowed() -> None:
    req = _request(
        {"origin": "http://127.0.0.1:5173"}, client=("::ffff:127.0.0.1", 51000)
    )
    assert access.denial_reason(req) is None


def test_lan_caller_with_the_launch_token_is_allowed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(launch_token.ENV_VAR, "s3cret-launch")
    req = _request(
        {
            "origin": "http://127.0.0.1:5173",
            launch_token.HEADER: "s3cret-launch",
        },
        client=("10.20.30.40", 51000),
    )
    assert access.denial_reason(req) is None


def test_lan_caller_with_a_wrong_launch_token_is_still_denied(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(launch_token.ENV_VAR, "s3cret-launch")
    req = _request(
        {
            "origin": "http://127.0.0.1:5173",
            launch_token.HEADER: "not-it",
        },
        client=("10.20.30.40", 51000),
    )
    assert access.denial_reason(req) is not None


def test_phone_with_no_sec_fetch_site_and_no_token_is_refused() -> None:
    """The truthful phone shape: a plain http://<lan-ip> share link is not a
    secure context, so the phone's browser sends Origin but no Sec-Fetch-*
    headers at all."""
    req = _request(
        {"origin": "http://192.168.1.50:8600"}, client=("192.168.1.50", 51000)
    )
    assert access.denial_reason(req) is not None


def test_phone_with_a_valid_pairing_header_is_allowed() -> None:
    token = pairing.get_token()
    req = _request(
        {"origin": "http://192.168.1.50:8600", pairing.HEADER: token},
        client=("192.168.1.50", 51000),
    )
    assert access.denial_reason(req) is None


def test_phone_with_a_wrong_pairing_header_is_refused() -> None:
    pairing.get_token()
    req = _request(
        {"origin": "http://192.168.1.50:8600", pairing.HEADER: "not-it"},
        client=("192.168.1.50", 51000),
    )
    assert access.denial_reason(req) is not None


def test_configured_proxy_token_still_works_standalone_for_a_lan_caller(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """theDAW_PROXY_TOKEN is documented as a standalone secret for a hostile
    LAN; SEC-001 must not force a second, unrelated (and browser-unreachable)
    launch token on top of it."""
    monkeypatch.setenv(access.TOKEN_ENV, "proxy-secret")
    req = _request(
        {
            "origin": "http://127.0.0.1:5173",
            access.TOKEN_HEADER: "proxy-secret",
        },
        client=("10.20.30.40", 51000),
    )
    assert access.denial_reason(req) is None


def test_real_browser_same_site_traffic_from_loopback_is_unaffected() -> None:
    """Vite's dev server and this API are cross-port but same-machine, so a
    real ``Sec-Fetch-Site: same-site`` request from it always has a loopback
    TCP peer -- that peer, not the (forgeable) header, is what this now
    allows through."""
    req = _request(
        {"origin": "http://127.0.0.1:5173", "sec-fetch-site": "same-site"},
        client=("127.0.0.1", 51000),
    )
    assert access.denial_reason(req) is None


def test_forged_sec_fetch_site_from_a_lan_peer_without_a_token_is_refused() -> None:
    """SEC-001, the audit finding: a bare LAN script can set
    ``Sec-Fetch-Site: same-origin`` (or any other value) itself -- headers are
    never trusted to exempt a non-loopback caller from needing a real token."""
    for site in ("same-origin", "none", "same-site"):
        req = _request(
            {"origin": "http://127.0.0.1:5173", "sec-fetch-site": site},
            client=("10.20.30.40", 51000),
        )
        assert access.denial_reason(req) is not None, site


def test_cross_site_is_still_refused_outright() -> None:
    req = _request(
        {"origin": "http://127.0.0.1:5173", "sec-fetch-site": "cross-site"},
        client=("127.0.0.1", 51000),
    )
    assert access.denial_reason(req) is not None


# ---------------------------------------------------------------------------
# Consumer cleanup -- caller_is_loopback is a real public name now
# ---------------------------------------------------------------------------


def test_caller_is_loopback_is_importable_under_its_public_name() -> None:
    """It is imported across module boundaries by backend/lib/cross_site.py
    and backend/modules/project/router.py, so the leading underscore was a
    lie. Both real importers must resolve the SAME function object."""
    from backend.lib import cross_site as cross_site_module
    from backend.modules.genaiproxy.access import caller_is_loopback
    from backend.modules.project import router as project_router_module

    assert cross_site_module.caller_is_loopback is caller_is_loopback
    assert project_router_module.caller_is_loopback is caller_is_loopback

    req = _request({}, client=("127.0.0.1", 51000))
    assert caller_is_loopback(req) is True


# ---------------------------------------------------------------------------
# ITW security P1 -- shared loopback-or-launch-token gate
# ---------------------------------------------------------------------------


def test_gate_allows_loopback_without_a_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(launch_token.ENV_VAR, raising=False)
    req = _request({}, client=("127.0.0.1", 51000))
    cross_site.require_loopback_or_launch_token(req)  # must not raise


def test_gate_allows_ipv6_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(launch_token.ENV_VAR, raising=False)
    req = _request({}, client=("::1", 51000))
    cross_site.require_loopback_or_launch_token(req)  # must not raise


def test_gate_allows_ipv4_mapped_ipv6_loopback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A dual-stack socket can report an IPv4 peer as ``::ffff:127.0.0.1``,
    e.g. behind Vite's xfwd dev proxy."""
    monkeypatch.delenv(launch_token.ENV_VAR, raising=False)
    req = _request({}, client=("::ffff:127.0.0.1", 51000))
    cross_site.require_loopback_or_launch_token(req)  # must not raise


def test_gate_refuses_a_non_ip_peer_even_named_localhost() -> None:
    """A non-IP host is not an address at all -- only a real loopback IP
    counts, never a hostname string."""
    req = _request({}, client=("localhost", 51000))
    with pytest.raises(Exception) as exc_info:
        cross_site.require_loopback_or_launch_token(req)
    assert getattr(exc_info.value, "status_code", None) == 403


def test_gate_refuses_a_lan_caller_without_the_token() -> None:
    req = _request({}, client=("10.20.30.40", 51000))
    with pytest.raises(Exception) as exc_info:
        cross_site.require_loopback_or_launch_token(req)
    assert getattr(exc_info.value, "status_code", None) == 403


def test_gate_allows_a_lan_caller_with_the_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(launch_token.ENV_VAR, "s3cret-launch")
    req = _request(
        {launch_token.HEADER: "s3cret-launch"}, client=("10.20.30.40", 51000)
    )
    cross_site.require_loopback_or_launch_token(req)  # must not raise


def test_strict_gate_refuses_a_lan_caller_with_only_a_pairing_token() -> None:
    """A route gated by the plain ``require_loopback_or_launch_token`` (e.g.
    plugin ``/reveal``) is not unlocked by pairing."""
    token = pairing.get_token()
    req = _request({pairing.HEADER: token}, client=("10.20.30.40", 51000))
    with pytest.raises(Exception) as exc_info:
        cross_site.require_loopback_or_launch_token(req)
    assert getattr(exc_info.value, "status_code", None) == 403


# ---------------------------------------------------------------------------
# ITW security P1 -- loopback-or-launch-or-pairing-token gate
# ---------------------------------------------------------------------------


def test_pairing_gate_allows_loopback_without_a_token() -> None:
    req = _request({}, client=("127.0.0.1", 51000))
    cross_site.require_loopback_launch_or_pairing_token(req)  # must not raise


def test_pairing_gate_allows_a_lan_caller_with_the_launch_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(launch_token.ENV_VAR, "s3cret-launch")
    req = _request(
        {launch_token.HEADER: "s3cret-launch"}, client=("10.20.30.40", 51000)
    )
    cross_site.require_loopback_launch_or_pairing_token(req)  # must not raise


def test_pairing_gate_allows_a_lan_caller_with_the_pairing_token() -> None:
    token = pairing.get_token()
    req = _request({pairing.HEADER: token}, client=("10.20.30.40", 51000))
    cross_site.require_loopback_launch_or_pairing_token(req)  # must not raise


def test_pairing_gate_refuses_a_lan_caller_with_a_wrong_pairing_token() -> None:
    pairing.get_token()
    req = _request({pairing.HEADER: "not-it"}, client=("10.20.30.40", 51000))
    with pytest.raises(Exception) as exc_info:
        cross_site.require_loopback_launch_or_pairing_token(req)
    assert getattr(exc_info.value, "status_code", None) == 403


def test_pairing_gate_refuses_a_lan_caller_with_no_token_at_all() -> None:
    req = _request({}, client=("10.20.30.40", 51000))
    with pytest.raises(Exception) as exc_info:
        cross_site.require_loopback_launch_or_pairing_token(req)
    assert getattr(exc_info.value, "status_code", None) == 403


# ---------------------------------------------------------------------------
# backend/lib/pairing.py
# ---------------------------------------------------------------------------


def test_get_token_persists_across_a_cold_cache(tmp_path: Path) -> None:
    first = pairing.get_token()
    pairing._cached = None  # simulate a fresh process re-reading the file
    second = pairing.get_token()
    assert first == second
    assert pairing._TOKEN_FILE.read_text(encoding="utf-8").strip() == first


def test_get_token_recovers_from_a_non_utf8_token_file() -> None:
    """A corrupt token file must not wedge pairing permanently (every request
    carrying the header 500ing, and the recovery route -- GET
    /api/pairing/token -- 500ing right along with it): mint and persist a
    fresh token instead of raising."""
    pairing._TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    pairing._TOKEN_FILE.write_bytes(b"\xff\xfe\x00\xff not valid utf-8")
    token = pairing.get_token()
    assert token
    assert pairing._TOKEN_FILE.read_text(encoding="utf-8").strip() == token


def test_get_token_falls_back_to_in_memory_when_persisting_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The self-heal in the read path does not cover the write that follows
    it: a directory sitting where the file should be, or a read-only file,
    still raised PermissionError/OSError straight out of get_token(). Must
    fail open (an in-memory token for this process) instead."""

    def _boom(_token: str) -> None:
        raise OSError("simulated: read-only file")

    monkeypatch.setattr(pairing, "_write", _boom)
    token = pairing.get_token()
    assert token
    # Consistent within the process even though nothing was persisted.
    assert pairing.get_token() == token
    assert not pairing._TOKEN_FILE.exists()


def test_regenerate_token_falls_back_to_in_memory_when_persisting_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """MINOR: get_token() fails open on a write failure, but regenerate_token()
    called ``_write`` bare -- the same unwritable-file condition that
    get_token() tolerates would 500 the recovery route instead."""

    def _boom(_token: str) -> None:
        raise OSError("simulated: read-only file")

    monkeypatch.setattr(pairing, "_write", _boom)
    token = pairing.regenerate_token()
    assert token
    # The in-memory cache still updated even though nothing was persisted.
    assert pairing.get_token() == token
    req = _request({pairing.HEADER: token}, client=None)
    assert pairing.header_matches(req) is True


def test_get_token_falls_back_when_a_directory_sits_where_the_file_should_be() -> None:
    pairing._TOKEN_FILE.mkdir(parents=True, exist_ok=True)
    token = pairing.get_token()
    assert token
    assert pairing.get_token() == token


def test_regenerate_token_changes_the_token_and_invalidates_the_old_one() -> None:
    old = pairing.get_token()
    new = pairing.regenerate_token()
    assert new != old
    req_old = _request({pairing.HEADER: old}, client=None)
    req_new = _request({pairing.HEADER: new}, client=None)
    assert pairing.header_matches(req_old) is False
    assert pairing.header_matches(req_new) is True


def test_pairing_write_chmods_the_token_file_owner_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """MINOR: atomic_write's ``mode`` parameter is opt-in -- pairing._write is
    the one caller that passes ``mode=0o600`` for this secret."""
    import os
    import stat

    dest = tmp_path / "pairing_token.txt"
    monkeypatch.setattr(pairing, "_TOKEN_FILE", dest)
    pairing._write("s3cret-token")
    if os.name != "nt":
        mode = stat.S_IMODE(dest.stat().st_mode)
        assert mode == 0o600
    else:
        # Windows has no POSIX multi-user ACL -- atomic.py's own comment
        # says so -- so only confirm the mode parameter reached chmod
        # without raising, i.e. the file exists and is readable.
        assert dest.is_file()


def test_atomic_write_default_mode_does_not_restrict_other_callers(
    tmp_path: Path,
) -> None:
    """MINOR follow-up: before the ``mode`` parameter existed, EVERY
    atomic_write caller got chmod(0o600) applied for pairing's sake alone --
    recent_projects.json, module configs, etc. Confirms a caller that does
    not pass ``mode`` gets none applied (POSIX: default umask-derived mode,
    not 0o600)."""
    import os

    from backend.lib.atomic import atomic_write

    if os.name == "nt":
        pytest.skip("POSIX mode bits are not meaningful on Windows")
    import stat

    dest = tmp_path / "recent_projects.json"
    atomic_write(dest, "[]")
    mode = stat.S_IMODE(dest.stat().st_mode)
    assert mode != 0o600


def test_atomic_write_leaves_no_leftover_temp_on_a_mid_write_failure(
    tmp_path: Path,
) -> None:
    """MINOR regression: ``created`` was set AFTER the write in both
    non-``mode`` branches, so a write that creates the temp file and then
    fails mid-write (here: a surrogate codepoint that ``encoding="ascii"``
    cannot encode) left the temp sibling behind instead of being cleaned up
    by the ``except`` handler. No monkeypatching -- ``Path.write_text``
    really raises here."""
    from backend.lib.atomic import atomic_write

    dest = tmp_path / "settings.json"
    with pytest.raises(UnicodeEncodeError):
        atomic_write(dest, "ok-\udcff", encoding="ascii")

    assert not dest.exists()
    leftovers = list(tmp_path.glob(".settings.json.*.tmp"))
    assert leftovers == []


def test_header_matches_requires_the_exact_token() -> None:
    token = pairing.get_token()
    assert (
        pairing.header_matches(_request({pairing.HEADER: token}, client=None)) is True
    )
    assert (
        pairing.header_matches(_request({pairing.HEADER: "nope"}, client=None)) is False
    )
    assert pairing.header_matches(_request({}, client=None)) is False


# ---------------------------------------------------------------------------
# GET /api/pairing/token
# ---------------------------------------------------------------------------


def test_pairing_token_route_refuses_a_lan_caller(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(launch_token.ENV_VAR, raising=False)
    client = TestClient(_pairing_only_app(), client=("10.20.30.40", 51000))
    resp = client.get("/api/pairing/token")
    assert resp.status_code == 403


def test_pairing_token_route_answers_the_desktop_shell_over_loopback() -> None:
    client = TestClient(_pairing_only_app(), client=("127.0.0.1", 51000))
    resp = client.get("/api/pairing/token")
    assert resp.status_code == 200
    assert resp.json()["token"] == pairing.get_token()


def test_pairing_regenerate_route_refuses_a_lan_caller(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(launch_token.ENV_VAR, raising=False)
    client = TestClient(_pairing_only_app(), client=("10.20.30.40", 51000))
    resp = client.post("/api/pairing/token/regenerate")
    assert resp.status_code == 403


def test_pairing_regenerate_route_issues_a_new_token_over_loopback() -> None:
    old = pairing.get_token()
    client = TestClient(_pairing_only_app(), client=("127.0.0.1", 51000))
    resp = client.post("/api/pairing/token/regenerate")
    assert resp.status_code == 200
    new = resp.json()["token"]
    assert new != old
    assert pairing.get_token() == new


def test_pairing_regenerate_route_invalidates_the_old_token() -> None:
    old = pairing.get_token()
    client = TestClient(_pairing_only_app(), client=("127.0.0.1", 51000))
    client.post("/api/pairing/token/regenerate")
    old_req = _request({pairing.HEADER: old}, client=None)
    assert pairing.header_matches(old_req) is False


def test_pairing_token_route_refuses_a_csrf_page_even_from_loopback() -> None:
    """MAJOR CSRF finding: a page the user's desktop browser visits has a
    LOOPBACK TCP peer (it's the user's own machine), so the launch-token gate
    alone passes it -- refuse_cross_site is what tells a foreign page apart
    from theDAW's own UI, same shape a browser sends for a real cross-site
    request (Origin present, no preflight needed for a simple GET)."""
    client = TestClient(_pairing_only_app(), client=("127.0.0.1", 51000))
    resp = client.get("/api/pairing/token", headers={"origin": "https://evil.example"})
    assert resp.status_code == 403


def test_pairing_regenerate_route_refuses_a_csrf_page_even_from_loopback() -> None:
    """The exploitable half: a simple cross-site POST with
    Content-Type: text/plain needs no CORS preflight, so without
    refuse_cross_site this silently rotates the token and un-pairs every
    phone -- repeatably, from any page the user has open."""
    old = pairing.get_token()
    client = TestClient(_pairing_only_app(), client=("127.0.0.1", 51000))
    resp = client.post(
        "/api/pairing/token/regenerate",
        headers={"origin": "https://evil.example", "content-type": "text/plain"},
    )
    assert resp.status_code == 403
    assert pairing.get_token() == old


def test_pairing_routes_still_answer_every_legitimate_caller(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Vite dev, the packaged app, same-origin, and the native shell (no
    browser headers at all) must all still pass -- refuse_cross_site is not a
    blanket loopback-only restriction."""
    monkeypatch.delenv(launch_token.ENV_VAR, raising=False)
    for headers in (
        {"origin": "http://127.0.0.1:5173"},
        {"origin": "app://."},
        {"sec-fetch-site": "same-origin"},
        {},  # the native desktop shell: no browser headers at all
    ):
        client = TestClient(_pairing_only_app(), client=("127.0.0.1", 51000))
        resp = client.get("/api/pairing/token", headers=headers)
        assert resp.status_code == 200, headers


def _pairing_only_app() -> FastAPI:
    """A minimal app carrying just the pairing routes, so this suite does not
    need the full ``backend.server`` app (heavy imports, module loading) to
    exercise them -- mirrors the routes registered in ``backend/server.py``."""
    from fastapi import Depends

    app = FastAPI()

    @app.get(
        "/api/pairing/token",
        dependencies=[
            Depends(cross_site.refuse_cross_site),
            Depends(cross_site.require_loopback_or_launch_token),
        ],
    )
    def _token() -> dict:
        return {"token": pairing.get_token()}

    @app.post(
        "/api/pairing/token/regenerate",
        dependencies=[
            Depends(cross_site.refuse_cross_site),
            Depends(cross_site.require_loopback_or_launch_token),
        ],
    )
    def _regenerate() -> dict:
        return {"token": pairing.regenerate_token()}

    return app


# ---------------------------------------------------------------------------
# ITW security P1 -- POST /api/project/save with embed_audio
# ---------------------------------------------------------------------------


@pytest.fixture()
def project_client() -> TestClient:
    app = FastAPI()
    app.include_router(project_api, prefix="/api/project")
    return TestClient(app, client=("10.20.30.40", 51000))


def test_save_without_embed_audio_from_the_lan_without_a_token_is_refused(
    project_client: TestClient, tmp_path: Path
) -> None:
    """CRITICAL: the gate used to sit inside ``if req.embed_audio:`` only, so
    link mode (``embed_audio=False``) was wide open to any unauthenticated LAN
    caller -- a caller-named file write plus, via ``_register_project_media``,
    a caller-body-controlled ``/clip-audio`` allowlist widening. Both checks
    now cover ``/save`` unconditionally."""
    resp = project_client.post(
        "/api/project/save",
        json={
            "project": {},
            "path": str(tmp_path / "song.tasmo"),
            "embed_audio": False,
        },
    )
    assert resp.status_code == 403
    assert not (tmp_path / "song.tasmo").exists()


def test_save_without_embed_audio_from_the_phone_with_a_pairing_token_inside_the_root_is_unaffected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A legitimately authorized phone caller must still be able to link-save
    -- the fix gates the route, it does not remove the feature."""
    projects = _known_project_roots(tmp_path, monkeypatch)
    token = pairing.get_token()
    client = TestClient(FastAPI(), client=("10.20.30.40", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.post(
        "/api/project/save",
        json={
            "project": {},
            "path": str(projects / "song.tasmo"),
            "embed_audio": False,
        },
        headers={pairing.HEADER: token},
    )
    assert resp.status_code != 403
    assert (projects / "song.tasmo").is_file()


def test_save_without_embed_audio_does_not_widen_clip_audio_for_an_unauthenticated_lan_caller(
    project_client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The exact ITW P1 chain the third audit demonstrated: a refused ``/save``
    must never reach ``_register_project_media`` -> ``media_access.register_paths``
    -> ``register_root``, which would otherwise permanently widen the
    ``/clip-audio`` allowlist to whatever folder the request body named."""
    monkeypatch.setattr(
        media_access, "_ROOTS_STATE", tmp_path / "clip_audio_roots.json"
    )
    monkeypatch.setattr(media_access, "_session_roots", [])
    widened = tmp_path / "windows-temp"
    widened.mkdir()
    resp = project_client.post(
        "/api/project/save",
        json={
            "project": {
                "project_name": "Pwn",
                "tracks": [
                    {
                        "id": "t1",
                        "name": "V",
                        "type": "audio",
                        "clips": [
                            {
                                "id": "c1",
                                "name": "V",
                                "clip_type": "audio",
                                "track_id": "t1",
                                "start_time": 0.0,
                                "end_time": 1.0,
                                "audio_file": str(widened / "pwn.wav"),
                            }
                        ],
                    }
                ],
            },
            "path": str(widened / "pwn.tasmo"),
            "embed_audio": False,
        },
    )
    assert resp.status_code == 403
    assert media_access._session_roots == []


def test_save_with_embed_audio_from_the_lan_without_a_token_is_refused(
    project_client: TestClient, tmp_path: Path
) -> None:
    resp = project_client.post(
        "/api/project/save",
        json={"project": {}, "path": str(tmp_path / "song.tasmo"), "embed_audio": True},
    )
    assert resp.status_code == 403


def test_save_with_embed_audio_from_loopback_is_unaffected(tmp_path: Path) -> None:
    client = TestClient(FastAPI(), client=("127.0.0.1", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.post(
        "/api/project/save",
        json={"project": {}, "path": str(tmp_path / "song.tasmo"), "embed_audio": True},
    )
    assert resp.status_code != 403


def test_save_with_embed_audio_from_the_lan_with_the_token_is_unaffected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    projects = _known_project_roots(tmp_path, monkeypatch)
    monkeypatch.setenv(launch_token.ENV_VAR, "s3cret-launch")
    client = TestClient(FastAPI(), client=("10.20.30.40", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.post(
        "/api/project/save",
        json={
            "project": {},
            "path": str(projects / "song.tasmo"),
            "embed_audio": True,
        },
        headers={launch_token.HEADER: "s3cret-launch"},
    )
    assert resp.status_code != 403


def test_save_with_embed_audio_from_the_phone_with_a_pairing_token_inside_the_root_is_unaffected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """MAJOR follow-up: /save's embed_audio branch got the authn gate but not
    the known-root check -- /save-session's own docstring claimed parity with
    /save that did not actually exist. Now it does."""
    projects = _known_project_roots(tmp_path, monkeypatch)
    token = pairing.get_token()
    client = TestClient(FastAPI(), client=("10.20.30.40", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.post(
        "/api/project/save",
        json={
            "project": {},
            "path": str(projects / "song.tasmo"),
            "embed_audio": True,
        },
        headers={pairing.HEADER: token},
    )
    assert resp.status_code != 403


def test_save_with_embed_audio_from_the_phone_outside_the_root_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _known_project_roots(tmp_path, monkeypatch)
    outside = tmp_path / "outside" / "evil.tasmo"
    token = pairing.get_token()
    client = TestClient(FastAPI(), client=("10.20.30.40", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.post(
        "/api/project/save",
        json={"project": {}, "path": str(outside), "embed_audio": True},
        headers={pairing.HEADER: token},
    )
    assert resp.status_code == 403
    assert not outside.exists()


def test_save_with_embed_audio_from_loopback_outside_the_root_is_still_unaffected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _known_project_roots(tmp_path, monkeypatch)
    outside = tmp_path / "outside" / "song.tasmo"
    client = TestClient(FastAPI(), client=("127.0.0.1", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.post(
        "/api/project/save",
        json={"project": {}, "path": str(outside), "embed_audio": True},
    )
    assert resp.status_code != 403


def _known_project_roots(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Points ``known_paths.projects_dir()`` and ``paths.library_root()`` at
    two disjoint folders under ``tmp_path``, and returns the projects root.

    Also redirects every piece of persisted, cross-test-shared app state this
    module can touch -- ``media_access``'s session-root allowlist and its
    on-disk mirror, and the project router's recent-files list -- into
    ``tmp_path``. Without this, a save/load/save-session test that reaches
    ``media_access.register_root`` calls the real ``_persist()`` against the
    live ``data/clip_audio_roots.json`` and ``data/media_roots.json`` (and the
    live ``data/recent_projects.json`` via the recent-files list), same as two
    tests already did individually before this was hoisted; a whole run of
    this file previously left dozens of pytest temp-dir paths in those files
    on disk."""
    projects = tmp_path / "known-projects"
    library = tmp_path / "known-library"
    monkeypatch.setattr(known_paths, "projects_dir", lambda: projects)
    monkeypatch.setattr(backend_paths, "library_root", lambda: library)
    monkeypatch.setattr(
        media_access, "_ROOTS_STATE", tmp_path / "clip_audio_roots.json"
    )
    monkeypatch.setattr(media_access, "_session_roots", [])
    monkeypatch.setattr(project_router, "_RECENT_PATH", tmp_path / "recent.json")
    monkeypatch.setattr(project_router, "_recent_files", [])
    monkeypatch.setattr(project_router, "_recent_seen", None)
    return projects


@pytest.fixture(autouse=True)
def _isolated_media_and_recent_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Safety net, autouse for every test in this file: redirects
    ``media_access``'s session-root allowlist (and its on-disk mirror), the
    project router's recent-files list and the known-paths registry into
    this test's own ``tmp_path`` before the test body runs, so a test that
    reaches ``media_access.register_root`` -- directly, or indirectly via
    ``/save``/``/load``/``/save-session`` -- can never touch the real
    ``data/clip_audio_roots.json``, ``data/media_roots.json``,
    ``data/recent_projects.json`` or ``data/known_paths.json`` (the recent
    list records every saved or opened file there), even if it forgets to call
    ``_known_project_roots`` itself. ``_known_project_roots`` re-applies the
    same patches (redundant but harmless -- same test, same ``tmp_path``,
    same ``monkeypatch`` instance) when a test also needs
    ``known_paths.projects_dir()``/``paths.library_root()`` redirected."""
    monkeypatch.setattr(
        media_access, "_ROOTS_STATE", tmp_path / "clip_audio_roots.json"
    )
    monkeypatch.setattr(media_access, "_session_roots", [])
    monkeypatch.setattr(media_access, "_needs_write", False)
    monkeypatch.setattr(project_router, "_RECENT_PATH", tmp_path / "recent.json")
    monkeypatch.setattr(project_router, "_recent_files", [])
    monkeypatch.setattr(project_router, "_recent_seen", None)
    monkeypatch.setattr(known_paths, "_STORE_PATH", tmp_path / "known_paths.json")
    monkeypatch.setattr(known_paths, "_GRANTS", {})


# ---------------------------------------------------------------------------
# CRITICAL -- POST /api/project/load
# ---------------------------------------------------------------------------


def test_load_from_the_lan_without_a_token_is_refused(
    project_client: TestClient, tmp_path: Path
) -> None:
    """CRITICAL: /load had the identical write/read exposure as /save's
    embed_audio branch (an arbitrary-path read plus _register_project_media
    widening /clip-audio) but no gate and no Request param at all."""
    resp = project_client.post(
        "/api/project/load", json={"path": str(tmp_path / "song.tasmo")}
    )
    assert resp.status_code == 403


def test_load_from_loopback_is_unaffected(tmp_path: Path) -> None:
    """Loopback reaches the real handler -- a missing .tasmo answers 404, not
    the gate's 403."""
    client = TestClient(FastAPI(), client=("127.0.0.1", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.post("/api/project/load", json={"path": str(tmp_path / "song.tasmo")})
    assert resp.status_code == 404


def test_load_from_the_phone_with_a_pairing_token_inside_the_root_is_unaffected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    projects = _known_project_roots(tmp_path, monkeypatch)
    token = pairing.get_token()
    client = TestClient(FastAPI(), client=("10.20.30.40", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.post(
        "/api/project/load",
        json={"path": str(projects / "gone.tasmo")},
        headers={pairing.HEADER: token},
    )
    assert resp.status_code == 404  # reaches the real handler, not the gate


def test_load_from_the_phone_outside_the_root_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _known_project_roots(tmp_path, monkeypatch)
    outside = tmp_path / "outside" / "evil.tasmo"
    token = pairing.get_token()
    client = TestClient(FastAPI(), client=("10.20.30.40", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.post(
        "/api/project/load",
        json={"path": str(outside)},
        headers={pairing.HEADER: token},
    )
    assert resp.status_code == 403


def test_load_does_not_widen_clip_audio_for_an_unauthenticated_lan_caller(
    project_client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A refused /load must never reach _register_project_media."""
    monkeypatch.setattr(
        media_access, "_ROOTS_STATE", tmp_path / "clip_audio_roots.json"
    )
    monkeypatch.setattr(media_access, "_session_roots", [])
    resp = project_client.post(
        "/api/project/load", json={"path": str(tmp_path / "song.tasmo")}
    )
    assert resp.status_code == 403
    assert media_access._session_roots == []


# ---------------------------------------------------------------------------
# ITW security P1 -- POST /api/project/save-session
# ---------------------------------------------------------------------------


def test_save_session_from_the_lan_without_a_token_is_refused(tmp_path: Path) -> None:
    client = TestClient(FastAPI(), client=("10.20.30.40", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.post(
        "/api/project/save-session",
        data={"project": "{}", "path": str(tmp_path / "song.tasmo")},
    )
    assert resp.status_code == 403


def test_save_session_from_loopback_is_unaffected(tmp_path: Path) -> None:
    client = TestClient(FastAPI(), client=("127.0.0.1", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.post(
        "/api/project/save-session",
        data={"project": "{}", "path": str(tmp_path / "song.tasmo")},
    )
    assert resp.status_code != 403


def test_save_session_from_the_phone_with_a_pairing_token_inside_the_root_is_unaffected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    projects = _known_project_roots(tmp_path, monkeypatch)
    token = pairing.get_token()
    client = TestClient(FastAPI(), client=("10.20.30.40", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.post(
        "/api/project/save-session",
        data={"project": "{}", "path": str(projects / "song.tasmo")},
        headers={pairing.HEADER: token},
    )
    assert resp.status_code != 403


def test_save_session_from_the_phone_outside_the_root_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Item 7: authentication (the pairing token) is not authorization -- a
    paired phone still can't name an arbitrary path."""
    _known_project_roots(tmp_path, monkeypatch)
    outside = tmp_path / "outside" / "evil.tasmo"
    token = pairing.get_token()
    client = TestClient(FastAPI(), client=("10.20.30.40", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.post(
        "/api/project/save-session",
        data={"project": "{}", "path": str(outside)},
        headers={pairing.HEADER: token},
    )
    assert resp.status_code == 403
    assert not outside.exists()


def test_save_session_from_loopback_outside_the_root_is_still_unaffected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The containment check only applies to a non-loopback caller."""
    _known_project_roots(tmp_path, monkeypatch)
    outside = tmp_path / "outside" / "song.tasmo"
    client = TestClient(FastAPI(), client=("127.0.0.1", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.post(
        "/api/project/save-session",
        data={"project": "{}", "path": str(outside)},
    )
    assert resp.status_code != 403


def test_save_session_refuses_a_cross_site_caller_even_from_loopback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """CRITICAL: /save-session takes multipart/form-data, a CORS-simple
    request reachable from a plain <form> on any website with no preflight.
    The caller's TCP peer is then the user's OWN browser (loopback), so
    require_loopback_launch_or_pairing_token alone never sees the attack --
    only refuse_cross_site (which reads Sec-Fetch-Site/Origin/Referer, none
    of which page script can set) does. Demonstrated shape: an Origin from an
    attacker site, Sec-Fetch-Site: cross-site, peer 127.0.0.1."""
    projects = _known_project_roots(tmp_path, monkeypatch)
    target = projects / "song.tasmo"
    client = TestClient(FastAPI(), client=("127.0.0.1", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.post(
        "/api/project/save-session",
        data={"project": "{}", "path": str(target)},
        headers={
            "origin": "https://evil.example",
            "sec-fetch-site": "cross-site",
        },
    )
    assert resp.status_code == 403
    assert not target.exists()


def test_save_session_same_site_loopback_traffic_is_unaffected_by_the_csrf_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """theDAW's own UI, loaded from loopback, must still be able to save."""
    projects = _known_project_roots(tmp_path, monkeypatch)
    target = projects / "song.tasmo"
    client = TestClient(FastAPI(), client=("127.0.0.1", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.post(
        "/api/project/save-session",
        data={"project": "{}", "path": str(target)},
        headers={
            "origin": "http://127.0.0.1:5173",
            "sec-fetch-site": "same-origin",
        },
    )
    assert resp.status_code != 403


# ---------------------------------------------------------------------------
# ITW security P1 -- POST /api/project/export/audio
# ---------------------------------------------------------------------------


def test_export_audio_from_the_lan_without_a_token_is_refused(tmp_path: Path) -> None:
    client = TestClient(FastAPI(), client=("10.20.30.40", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.post(
        "/api/project/export/audio",
        json={"path": str(tmp_path / "song.tasmo"), "output_dir": str(tmp_path)},
    )
    assert resp.status_code == 403


def test_export_audio_from_loopback_is_unaffected(tmp_path: Path) -> None:
    """Loopback reaches the real handler -- a missing .tasmo answers 404, not
    the gate's 403."""
    client = TestClient(FastAPI(), client=("127.0.0.1", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.post(
        "/api/project/export/audio",
        json={"path": str(tmp_path / "song.tasmo"), "output_dir": str(tmp_path)},
    )
    assert resp.status_code == 404


def test_export_audio_from_the_phone_with_a_pairing_token_inside_the_root_is_unaffected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    projects = _known_project_roots(tmp_path, monkeypatch)
    token = pairing.get_token()
    client = TestClient(FastAPI(), client=("10.20.30.40", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.post(
        "/api/project/export/audio",
        json={"path": str(projects / "song.tasmo"), "output_dir": str(projects)},
        headers={pairing.HEADER: token},
    )
    assert resp.status_code == 404  # reaches the real handler; source is missing


def test_export_audio_from_the_phone_with_an_outside_source_path_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    projects = _known_project_roots(tmp_path, monkeypatch)
    outside_source = tmp_path / "outside" / "secret.tasmo"
    token = pairing.get_token()
    client = TestClient(FastAPI(), client=("10.20.30.40", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.post(
        "/api/project/export/audio",
        json={"path": str(outside_source), "output_dir": str(projects)},
        headers={pairing.HEADER: token},
    )
    assert resp.status_code == 403


def test_export_audio_from_the_phone_with_an_outside_output_dir_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The arbitrary-write half of item 7: an attacker-chosen output_dir
    outside any known root must be refused even with a valid pairing token."""
    projects = _known_project_roots(tmp_path, monkeypatch)
    outside_output = tmp_path / "outside"
    token = pairing.get_token()
    client = TestClient(FastAPI(), client=("10.20.30.40", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.post(
        "/api/project/export/audio",
        json={"path": str(projects / "song.tasmo"), "output_dir": str(outside_output)},
        headers={pairing.HEADER: token},
    )
    assert resp.status_code == 403


def test_export_audio_from_loopback_outside_any_root_is_still_unaffected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _known_project_roots(tmp_path, monkeypatch)
    outside = tmp_path / "outside"
    client = TestClient(FastAPI(), client=("127.0.0.1", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.post(
        "/api/project/export/audio",
        json={"path": str(outside / "song.tasmo"), "output_dir": str(outside)},
    )
    assert resp.status_code == 404  # reaches the real handler, not the gate


# ---------------------------------------------------------------------------
# NOTE-turned-fix -- GET /api/project/info and GET /api/project/list-audio
# ---------------------------------------------------------------------------


def test_info_from_the_lan_without_a_token_is_an_existence_oracle_no_longer(
    tmp_path: Path,
) -> None:
    """Before the fix, a missing path 404s and an existing non-.tasmo file
    500s (uncaught BadZipFile) -- an exists/does-not-exist oracle for any
    path from any LAN caller. Both now answer the SAME 403 the gate gives
    every other unauthenticated LAN call on this router."""
    real = tmp_path / "exists.tasmo"
    real.write_bytes(b"not actually a zip")
    missing = tmp_path / "does-not-exist.tasmo"

    client = TestClient(FastAPI(), client=("10.20.30.40", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp_real = client.get("/api/project/info", params={"path": str(real)})
    resp_missing = client.get("/api/project/info", params={"path": str(missing)})
    assert resp_real.status_code == 403
    assert resp_missing.status_code == 403


def test_info_from_loopback_catches_bad_zip_file_instead_of_500ing(
    tmp_path: Path,
) -> None:
    bad = tmp_path / "corrupt.tasmo"
    bad.write_bytes(b"not actually a zip")
    client = TestClient(FastAPI(), client=("127.0.0.1", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.get("/api/project/info", params={"path": str(bad)})
    assert resp.status_code == 400


def test_info_from_loopback_missing_file_is_404_not_the_gate(tmp_path: Path) -> None:
    client = TestClient(FastAPI(), client=("127.0.0.1", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.get(
        "/api/project/info", params={"path": str(tmp_path / "gone.tasmo")}
    )
    assert resp.status_code == 404


def test_list_audio_from_the_lan_without_a_token_is_refused(tmp_path: Path) -> None:
    client = TestClient(FastAPI(), client=("10.20.30.40", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.get(
        "/api/project/list-audio", params={"path": str(tmp_path / "song.tasmo")}
    )
    assert resp.status_code == 403


def test_list_audio_from_loopback_catches_bad_zip_file_instead_of_500ing(
    tmp_path: Path,
) -> None:
    bad = tmp_path / "corrupt.tasmo"
    bad.write_bytes(b"not actually a zip")
    client = TestClient(FastAPI(), client=("127.0.0.1", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.get("/api/project/list-audio", params={"path": str(bad)})
    assert resp.status_code == 400


def test_list_audio_from_the_phone_with_a_pairing_token_inside_the_root_is_unaffected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    projects = _known_project_roots(tmp_path, monkeypatch)
    token = pairing.get_token()
    client = TestClient(FastAPI(), client=("10.20.30.40", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    resp = client.get(
        "/api/project/list-audio",
        params={"path": str(projects / "gone.tasmo")},
        headers={pairing.HEADER: token},
    )
    assert resp.status_code == 404  # reaches the real handler, not the gate


# ---------------------------------------------------------------------------
# ITW security P1 -- POST /api/plugin/reveal
# ---------------------------------------------------------------------------


@pytest.fixture()
def plugin_client() -> TestClient:
    app = FastAPI()
    app.include_router(plugin_router.router, prefix="/api/plugin")
    return TestClient(app, client=("10.20.30.40", 51000))


def test_reveal_from_the_lan_without_a_token_is_refused(
    plugin_client: TestClient, tmp_path: Path
) -> None:
    resp = plugin_client.post(
        "/api/plugin/reveal", json={"path": str(tmp_path / "nope.gan")}
    )
    assert resp.status_code == 403


def test_reveal_from_loopback_is_unaffected(tmp_path: Path) -> None:
    """Loopback callers reach the real handler -- a missing path answers 404,
    not the gate's 403."""
    client = TestClient(FastAPI(), client=("127.0.0.1", 51000))
    client.app.include_router(plugin_router.router, prefix="/api/plugin")
    resp = client.post("/api/plugin/reveal", json={"path": str(tmp_path / "nope.gan")})
    assert resp.status_code == 404


def test_reveal_from_the_lan_with_the_token_is_unaffected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(launch_token.ENV_VAR, "s3cret-launch")
    client = TestClient(FastAPI(), client=("10.20.30.40", 51000))
    client.app.include_router(plugin_router.router, prefix="/api/plugin")
    resp = client.post(
        "/api/plugin/reveal",
        json={"path": str(tmp_path / "nope.gan")},
        headers={launch_token.HEADER: "s3cret-launch"},
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# SEC-003 -- GanFile.extract path containment
# ---------------------------------------------------------------------------


def _write_gan(path: Path, entry_name: str, data: bytes = b"payload") -> None:
    manifest = GanManifest(id="plugin-x").model_dump()
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr(entry_name, data)


def test_extract_rejects_a_sibling_prefix_escape(tmp_path: Path) -> None:
    """``out`` is ``.../plugins/plugin-x``; the crafted entry resolves to
    ``.../plugins/plugin-xEVIL/secret.txt`` -- a different, sibling
    directory that merely shares ``out``'s string prefix."""
    gan_path = tmp_path / "plugin.gan"
    _write_gan(gan_path, "../plugin-xEVIL/secret.txt", data=b"stolen")

    out = tmp_path / "plugins" / "plugin-x"
    GanFile.extract(str(gan_path), str(out))

    escape_target = tmp_path / "plugins" / "plugin-xEVIL" / "secret.txt"
    assert not escape_target.exists()
    assert b"stolen" not in b"".join(
        p.read_bytes() for p in out.rglob("*") if p.is_file()
    )


def test_extract_still_writes_legitimate_entries(tmp_path: Path) -> None:
    gan_path = tmp_path / "plugin.gan"
    _write_gan(gan_path, "index.html", data=b"<html></html>")

    out = tmp_path / "plugins" / "plugin-x"
    GanFile.extract(str(gan_path), str(out))

    assert (out / "index.html").read_bytes() == b"<html></html>"


# ---------------------------------------------------------------------------
# MAJOR follow-up -- TasmoFile.extract_audio's reported paths
# ---------------------------------------------------------------------------


def test_extract_audio_reports_the_real_extracted_path_not_a_hand_built_one(
    tmp_path: Path,
) -> None:
    """zf.extract() sanitizes '..' in the member name (lands inside `out`),
    but the old code re-joined the RAW name onto `out` for its return value.
    media_access.register_paths resolves what it's given, collapsing that
    '..' back out of `out` entirely -- allowlisting a folder outside the
    validated root for /clip-audio to serve from."""
    from backend.modules.project.tasmo_file import TasmoFile

    tasmo = tmp_path / "song.tasmo"
    with zipfile.ZipFile(tasmo, "w") as zf:
        zf.writestr("manifest.json", "{}")
        zf.writestr("audio/../../evil/secret.wav", b"stolen")

    out = tmp_path / "out"
    extracted = TasmoFile.extract_audio(str(tasmo), str(out))

    assert len(extracted) == 1
    resolved = Path(extracted[0]).resolve()
    out_resolved = out.resolve()
    assert resolved == out_resolved or resolved.is_relative_to(out_resolved), (
        resolved,
        out_resolved,
    )
    assert resolved.read_bytes() == b"stolen"


# ---------------------------------------------------------------------------
# The real app, lifespan included
# ---------------------------------------------------------------------------


def _checkout_state() -> dict[str, tuple[int, int]]:
    """Every file under the checkout's data/ and logs/, with its size and
    mtime: what a test that starts the real app must leave as it found."""
    state: dict[str, tuple[int, int]] = {}
    for top in (REPO / "data", REPO / "logs"):
        if not top.is_dir():
            continue
        for path in top.rglob("*"):
            if path.is_file():
                st = path.stat()
                state[str(path.relative_to(REPO))] = (st.st_size, st.st_mtime_ns)
    return state


#: Threads the startup hooks leave running after the lifespan has started:
#: the bundled plugin build, the underfit update check and the two lineage
#: cache warmers (each opens the library store). Joined before the fixture
#: compares data/ and before its patches are undone: a warmer that outlived
#: the test opened the store at the checkout's data/generations.
_STARTUP_WRITERS = (
    # The library opens off the startup (library.router.start_opening); one
    # that outlived the test would publish its store after the fixture's
    # patches were undone.
    "library-open",
    "plugin-bundled",
    "underfit-update-check",
    "lineagescale-warm",
    "lineagescale-explore-warm",
)


def _stop_no_sidecars() -> None:
    """Stands in for core/teardown.stop_all_sidecars under ``real_app``. The
    real one also stops the magenta engine and the other sidecars this
    checkout started; run from the app tree, those are the running app's."""


@pytest.fixture
def real_app(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[FastAPI]:
    """backend.server's app, set up by :func:`real_app_context`."""
    with real_app_context(tmp_path, monkeypatch) as app:
        yield app


@contextmanager
def real_app_context(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[FastAPI]:
    """backend.server's app with every data folder its lifespan writes moved
    into tmp_path. The startup reads and migrates settings.json, opens the
    library database, builds the bundled plugins into data/plugins, caches the
    underfit update check and runs every other module's startup hook; run
    as-is from a checkout, all of that landed in the checkout's own data/
    (the live app's, from the app tree). The settings and library stores are
    process-wide and may already point at data/ from an earlier test, so both
    are dropped and rebuilt under the redirected folders; the plugin folder
    and the update-check file are module constants fixed at import, so they
    are moved by hand. The shutdown's sidecar sweep is replaced (see
    ``_stop_no_sidecars``). Fails when data/ or logs/ changed anyway."""
    from backend.core import teardown
    from backend.modules.library import router as library_router
    from backend.modules.lineagescale import explore as lineage_explore
    from backend.modules.lineagescale import router as lineage_router
    from backend.modules.settings import router as settings_router
    from backend.modules.underfit import updater as underfit_updater
    from backend.server import app

    data = tmp_path / "app-data"
    data.mkdir()
    monkeypatch.setenv("theDAW_DATA_DIR", str(data))
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path / "app-generations"))
    monkeypatch.setenv("theDAW_SETTINGS_PATH", str(data / "settings.json"))
    # The dashboard is a separate process; a test has no use for one.
    monkeypatch.setenv("theDAW_UNDERFIT_NO_AUTO_SPAWN", "1")
    monkeypatch.setattr(teardown, "stop_all_sidecars", _stop_no_sidecars)
    monkeypatch.setattr(settings_router, "_store", None)
    monkeypatch.setattr(library_router, "_store", None)
    monkeypatch.setattr(plugin_router, "GAN_DIR", data / "plugins")
    monkeypatch.setattr(plugin_router, "RUNTIME_DIR", data / "plugins" / "_runtime")
    monkeypatch.setattr(underfit_updater, "_STATE", data / "underfit_update.json")
    # The warmers sleep before they start (20 s and 5 s) so a real start is
    # not slowed; the fixture joins them, so they start at once here.
    monkeypatch.setattr(lineage_explore, "WARM_DELAY_SEC", 0.0)
    monkeypatch.setattr(lineage_router, "WARM_DELAY_SEC", 0.0)
    before = _checkout_state()
    try:
        yield app
    finally:
        for thread in threading.enumerate():
            if thread.name in _STARTUP_WRITERS:
                thread.join(timeout=120)
        database = getattr(library_router._store, "db", None)
        if database is not None:
            database.close()
    assert _checkout_state() == before


def test_the_real_app_starts_without_touching_the_checkout_data(
    real_app: FastAPI, tmp_path: Path
) -> None:
    """The startup writes the redirected settings file; the checkout's data/
    is compared by the fixture after the lifespan has run."""
    with TestClient(real_app, client=("127.0.0.1", 51000)) as client:
        assert client.get("/api/build-info").status_code == 200
    assert (tmp_path / "app-data" / "settings.json").is_file()


# ---------------------------------------------------------------------------
# CSRF -- the real GET /api/pairing/token and POST .../regenerate wiring
# ---------------------------------------------------------------------------


def test_real_pairing_routes_refuse_a_csrf_page_from_loopback(
    real_app: FastAPI,
) -> None:
    """Proves the actual routes registered in backend/server.py carry
    refuse_cross_site, not just the mirror above."""
    with TestClient(real_app, client=("127.0.0.1", 51000)) as client:
        get_resp = client.get(
            "/api/pairing/token", headers={"origin": "https://evil.example"}
        )
        assert get_resp.status_code == 403

        old = pairing.get_token()
        post_resp = client.post(
            "/api/pairing/token/regenerate",
            headers={"origin": "https://evil.example", "content-type": "text/plain"},
        )
        assert post_resp.status_code == 403
        assert pairing.get_token() == old


def test_real_pairing_route_answers_the_desktop_shell_over_loopback(
    real_app: FastAPI,
) -> None:
    with TestClient(real_app, client=("127.0.0.1", 51000)) as client:
        resp = client.get("/api/pairing/token")
        assert resp.status_code == 200
        assert resp.json()["token"] == pairing.get_token()


# ---------------------------------------------------------------------------
# CORS -- backend/server.py
# ---------------------------------------------------------------------------


def test_cors_loopback_dev_origin_allowed_without_credentials(
    real_app: FastAPI,
) -> None:
    with TestClient(real_app) as client:
        resp = client.options(
            "/api/build-info",
            headers={
                "origin": "http://127.0.0.1:5173",
                "access-control-request-method": "GET",
            },
        )
        assert (
            resp.headers.get("access-control-allow-origin") == "http://127.0.0.1:5173"
        )
        # Nothing here uses cookies or any other ambient credential; a
        # response must never be marked eligible for a credentialed read.
        assert "access-control-allow-credentials" not in {
            k.lower() for k in resp.headers
        }


def test_cors_packaged_app_exact_origin(real_app: FastAPI) -> None:
    with TestClient(real_app) as client:
        resp = client.options(
            "/api/build-info",
            headers={
                "origin": "app://.",
                "access-control-request-method": "GET",
            },
        )
        assert resp.headers.get("access-control-allow-origin") == "app://."


def test_cors_refuses_an_app_scheme_host_the_packaged_app_never_uses(
    real_app: FastAPI,
) -> None:
    """The renderer's ``scheme: 'app'`` registration has no host, so
    ``app://.`` is the only origin it can ever produce -- a bare
    ``app://.*`` would also match ``app://evil``, which that scheme can
    never actually emit but a forged Origin header could still claim."""
    with TestClient(real_app) as client:
        resp = client.options(
            "/api/build-info",
            headers={
                "origin": "app://evil",
                "access-control-request-method": "GET",
            },
        )
        assert "access-control-allow-origin" not in {k.lower() for k in resp.headers}


def test_cors_refuses_a_remote_site_origin(real_app: FastAPI) -> None:
    with TestClient(real_app) as client:
        resp = client.options(
            "/api/build-info",
            headers={
                "origin": "https://evil.example",
                "access-control-request-method": "GET",
            },
        )
        assert "access-control-allow-origin" not in {k.lower() for k in resp.headers}


def test_serve_runtime_rejects_a_sibling_prefix_escape(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(plugin_router, "RUNTIME_DIR", tmp_path / "runtime")
    plugin_dir = tmp_path / "runtime" / "plugin-x"
    plugin_dir.mkdir(parents=True)
    (plugin_dir / "index.html").write_text("<html></html>", encoding="utf-8")

    evil_dir = tmp_path / "runtime" / "plugin-xEVIL"
    evil_dir.mkdir(parents=True)
    (evil_dir / "secret.txt").write_bytes(b"stolen")

    app = FastAPI()
    app.include_router(plugin_router.router, prefix="/api/plugin")
    client = TestClient(app)

    resp = client.get("/api/plugin/plugin-x/runtime/..%2Fplugin-xEVIL%2Fsecret.txt")
    assert resp.status_code == 404
    assert b"stolen" not in resp.content
