"""Security regressions for the two routes that hand out things worth stealing.

SEC-002: ``GET /api/project/clip-audio`` took an absolute path and streamed it,
so any browser tab or LAN device could read audio anywhere on the machine.
SEC-001: ``/api/genai-proxy`` injected the user's ``GEMINI_API_KEY`` into
whatever anyone asked it to forward.

Both routes stay reachable from the local UI, the phone companion and the
headset, so each case here pairs the refusal with the legitimate call that must
still work.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.lib import pairing
from backend.modules.genaiproxy import router as proxy_router
from backend.modules.project import media_access
from backend.modules.project.router import router as project_api


# ---------------------------------------------------------------------------
# SEC-002 -- /api/project/clip-audio containment
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _isolated_pairing_token(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Every test gets its own pairing-token file and a cleared in-process
    cache, so minting one in one test never leaks into another and none of
    them ever touch the real persisted token."""
    monkeypatch.setattr(pairing, "_TOKEN_FILE", tmp_path / "pairing_token.txt")
    monkeypatch.setattr(pairing, "_cached", None)


@pytest.fixture()
def media_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A generations root with one clip in it, and one secret outside it."""
    root = tmp_path / "generations"
    (root / "sub").mkdir(parents=True)
    clip = root / "sub" / "clip.wav"
    clip.write_bytes(b"RIFF....WAVEfmt clip-bytes")

    outside = tmp_path / "private"
    outside.mkdir()
    secret = outside / "secret.wav"
    secret.write_bytes(b"RIFF....WAVEfmt secret-bytes")

    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(root))
    monkeypatch.delenv("theDAW_MEDIA_ROOTS", raising=False)
    # Keep the session-root registry out of the repo's data dir, and empty, so
    # containment is judged only by what this test grants.
    monkeypatch.setattr(
        media_access, "_ROOTS_STATE", tmp_path / "clip_audio_roots.json"
    )
    monkeypatch.setattr(media_access, "_session_roots", [])
    return {"root": root, "clip": clip, "outside": outside, "secret": secret}


@pytest.fixture()
def project_client() -> TestClient:
    """This machine's own UI: a loopback caller, unaffected by the ``/clip-
    audio`` auth gate item 3 added (``require_loopback_launch_or_pairing_
    token``). Starlette's ``TestClient`` peer defaults to a non-loopback
    stand-in host, so every test in this file that expects a route's
    CONTAINMENT answer (200/404/400/403-outside-roots), rather than its
    AUTH answer, needs an explicit loopback peer -- same as
    ``tests/test_security_b12.py``'s ``client=("127.0.0.1", 51000))`` calls."""
    app = FastAPI()
    app.include_router(project_api, prefix="/api/project")
    return TestClient(app, client=("127.0.0.1", 51000))


@pytest.fixture()
def lan_project_client() -> TestClient:
    """A non-loopback LAN peer with no pairing token -- proves the auth gate
    itself, as opposed to containment."""
    app = FastAPI()
    app.include_router(project_api, prefix="/api/project")
    return TestClient(app, client=("10.20.30.40", 51000))


def _clip_audio(
    client: TestClient, path: str | Path, *, headers: dict[str, str] | None = None
):
    return client.get(
        "/api/project/clip-audio", params={"path": str(path)}, headers=headers
    )


def test_in_root_clip_still_serves(project_client, media_env):
    resp = _clip_audio(project_client, media_env["clip"])
    assert resp.status_code == 200
    assert resp.content == b"RIFF....WAVEfmt clip-bytes"


def test_lan_caller_without_a_pairing_token_is_refused(lan_project_client, media_env):
    """Item 3: a bare LAN caller with no ``Origin``/``Referer``/``Sec-Fetch-
    Site`` and no pairing token used to pass straight through to the
    containment check -- ``/clip-audio`` was the only route on this router
    with no auth gate at all. Refused before it even reaches containment."""
    resp = _clip_audio(lan_project_client, media_env["clip"])
    assert resp.status_code == 403
    assert "desktop shell" in resp.json()["detail"] or "paired" in resp.json()["detail"]


def test_paired_lan_caller_can_still_read_an_in_root_clip(
    lan_project_client, media_env
):
    """The phone companion is the legitimate non-loopback caller ``/clip-
    audio`` exists to serve: a valid pairing token must still get the clip,
    proving item 3's gate authenticates rather than simply locking the
    route to loopback."""
    token = pairing.get_token()
    resp = _clip_audio(
        lan_project_client, media_env["clip"], headers={pairing.HEADER: token}
    )
    assert resp.status_code == 200
    assert resp.content == b"RIFF....WAVEfmt clip-bytes"


def test_dotdot_traversal_is_refused(project_client, media_env):
    # Resolves to ../private/secret.wav, i.e. outside the root it starts in.
    traversal = media_env["root"] / "sub" / ".." / ".." / "private" / "secret.wav"
    resp = _clip_audio(project_client, traversal)
    assert resp.status_code == 403
    assert b"secret-bytes" not in resp.content


def test_absolute_path_outside_roots_is_refused(project_client, media_env):
    resp = _clip_audio(project_client, media_env["secret"])
    assert resp.status_code == 403


def test_refusal_does_not_leak_the_filesystem(project_client, media_env):
    """Same answer whether the target exists or not, and no resolved path in it."""
    real = _clip_audio(project_client, media_env["secret"])
    missing = _clip_audio(project_client, media_env["outside"] / "nope.wav")
    assert real.status_code == missing.status_code == 403
    assert real.json() == missing.json()
    assert str(media_env["outside"]) not in real.text


def test_symlink_out_of_root_is_refused(project_client, media_env):
    link = media_env["root"] / "escape.wav"
    try:
        link.symlink_to(media_env["secret"])
    except (OSError, NotImplementedError) as e:  # Windows without developer mode
        pytest.skip(f"cannot create a symlink here: {e}")
    resp = _clip_audio(project_client, link)
    assert resp.status_code == 403
    assert b"secret-bytes" not in resp.content


def test_missing_file_inside_root_is_404(project_client, media_env):
    resp = _clip_audio(project_client, media_env["root"] / "gone.wav")
    assert resp.status_code == 404


def test_non_audio_inside_root_is_rejected(project_client, media_env):
    doc = media_env["root"] / "notes.txt"
    doc.write_text("not audio", encoding="utf-8")
    resp = _clip_audio(project_client, doc)
    assert resp.status_code == 400


def test_opened_project_folder_becomes_servable(project_client, media_env):
    """A .tasmo may link samples from anywhere; opening it is the consent."""
    sample = media_env["outside"] / "linked.wav"
    sample.write_bytes(b"linked-bytes")
    assert _clip_audio(project_client, sample).status_code == 403

    media_access.register_paths([str(sample)])
    resp = _clip_audio(project_client, sample)
    assert resp.status_code == 200
    assert resp.content == b"linked-bytes"


def test_registration_refuses_a_filesystem_root(media_env, tmp_path):
    anchor = Path(tmp_path.anchor)
    assert media_access.register_root(anchor) is False
    assert media_access.register_root(Path.home()) is False
    assert media_access.resolve_media_path(str(media_env["secret"])) is None


# ---------------------------------------------------------------------------
# SEC-001 -- /api/genai-proxy access gate
# ---------------------------------------------------------------------------

_GENERATE = "/api/genai-proxy/v1beta/models/gemini-3.5-flash:generateContent"


class _FakeResponse:
    status_code = 200
    content = b'{"candidates":[]}'
    headers = {"content-type": "application/json"}


class _FakeClient:
    """Stands in for httpx so a forwarded call is observable and a blocked one
    provably never reaches Google."""

    calls: list[dict] = []

    def __init__(self, *_args, **_kwargs) -> None:
        pass

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, *_exc) -> bool:
        return False

    async def request(self, **kwargs) -> _FakeResponse:
        _FakeClient.calls.append(kwargs)
        return _FakeResponse()


@pytest.fixture()
def proxy_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("GEMINI_API_KEY", "server-side-key")
    monkeypatch.delenv(proxy_router.access.TOKEN_ENV, raising=False)
    monkeypatch.setattr(proxy_router.httpx, "AsyncClient", _FakeClient)
    _FakeClient.calls = []
    app = FastAPI()
    app.include_router(proxy_router.router, prefix="/api/genai-proxy")
    return TestClient(app)


@pytest.fixture()
def proxy_client_loopback(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """Same as ``proxy_client``, but with a real loopback TCP peer -- what
    theDAW's own UI (dev Vite, the packaged app, a browser opened on this
    machine) actually looks like on the wire, unlike ``TestClient``'s default
    fake, non-loopback ``("testclient", 50000)`` peer (SEC-001)."""
    monkeypatch.setenv("GEMINI_API_KEY", "server-side-key")
    monkeypatch.delenv(proxy_router.access.TOKEN_ENV, raising=False)
    monkeypatch.setattr(proxy_router.httpx, "AsyncClient", _FakeClient)
    _FakeClient.calls = []
    app = FastAPI()
    app.include_router(proxy_router.router, prefix="/api/genai-proxy")
    return TestClient(app, client=("127.0.0.1", 51000))


def test_local_ui_origin_is_forwarded_with_the_server_key(proxy_client_loopback):
    """Real Vite-dev-to-API traffic: a loopback TCP peer (Electron/Chromium
    on this machine) plus the Sec-Fetch-Site a real browser attaches to a
    same-site, cross-port fetch (:5173 -> :8600)."""
    resp = proxy_client_loopback.post(
        _GENERATE,
        json={"contents": []},
        headers={"origin": "http://localhost:5173", "sec-fetch-site": "same-site"},
    )
    assert resp.status_code == 200
    assert len(_FakeClient.calls) == 1
    call = _FakeClient.calls[0]
    assert call["headers"]["x-goog-api-key"] == "server-side-key"
    assert "key" not in call["params"]


def test_local_ui_origin_from_a_lan_peer_without_a_token_is_refused(proxy_client):
    """SEC-001: the exact same Origin the local UI sends, but with no
    Sec-Fetch-Site and a TCP peer that is not this machine, must not spend
    the key -- that shape is indistinguishable from a bare script forging a
    local-looking Origin."""
    resp = proxy_client.post(
        _GENERATE,
        json={"contents": []},
        headers={"origin": "http://localhost:5173"},
    )
    assert resp.status_code == 403
    assert _FakeClient.calls == []


def test_packaged_app_is_forwarded(proxy_client_loopback):
    """The packaged app's own renderer always calls its own backend over
    loopback (electron-ui/main/index.ts: BACKEND_BASE = 'http://127.0.0.1:8600')."""
    resp = proxy_client_loopback.post(
        _GENERATE, json={"contents": []}, headers={"origin": "app://."}
    )
    assert resp.status_code == 200
    assert len(_FakeClient.calls) == 1


def test_phone_on_the_lan_with_no_token_is_refused(proxy_client):
    """The audit finding: a plain http://<lan-ip> share link is not a secure
    context, so the phone's real browser sends Origin but no Sec-Fetch-*
    headers at all -- and even when it did send Sec-Fetch-Site: same-origin,
    that header is exactly as forgeable by a bare LAN script as any other, so
    it is never trusted on its own to exempt a non-loopback caller."""
    resp = proxy_client.post(
        _GENERATE,
        json={"contents": []},
        headers={"origin": "http://192.168.1.50:8600"},
    )
    assert resp.status_code == 403
    assert _FakeClient.calls == []


def test_phone_on_the_lan_with_a_valid_pairing_header_is_forwarded(proxy_client):
    token = pairing.get_token()
    resp = proxy_client.post(
        _GENERATE,
        json={"contents": []},
        headers={"origin": "http://192.168.1.50:8600", pairing.HEADER: token},
    )
    assert resp.status_code == 200
    assert len(_FakeClient.calls) == 1


def test_forged_sec_fetch_site_from_the_lan_with_no_token_is_refused(proxy_client):
    """The audit's exact exploit shape: a bare LAN script sets
    Sec-Fetch-Site: same-origin itself. Without a real token this must still
    be refused -- Sec-Fetch-Site is never, by itself, trusted to exempt a
    non-loopback caller."""
    resp = proxy_client.post(
        _GENERATE,
        json={"contents": []},
        headers={"origin": "http://192.168.1.50:8600", "sec-fetch-site": "same-origin"},
    )
    assert resp.status_code == 403
    assert _FakeClient.calls == []


def test_a_browser_opened_directly_at_this_machines_loopback_address_is_forwarded(
    proxy_client_loopback,
):
    resp = proxy_client_loopback.post(
        _GENERATE,
        json={"contents": []},
        headers={"origin": "http://127.0.0.1:8600", "sec-fetch-site": "same-origin"},
    )
    assert resp.status_code == 200
    assert len(_FakeClient.calls) == 1


def test_remote_page_cannot_spend_the_key(proxy_client):
    resp = proxy_client.post(
        _GENERATE,
        json={"contents": []},
        headers={"origin": "https://evil.example"},
    )
    assert resp.status_code == 403
    assert _FakeClient.calls == []


def test_sandboxed_null_origin_cannot_spend_the_key(proxy_client):
    """A sandboxed iframe on a remote page sends an opaque origin; Sec-Fetch-Site
    is what separates it from the packaged app's own renderer."""
    resp = proxy_client.post(
        _GENERATE,
        json={"contents": []},
        headers={"origin": "null", "sec-fetch-site": "cross-site"},
    )
    assert resp.status_code == 403

    plain_null = proxy_client.post(
        _GENERATE, json={"contents": []}, headers={"origin": "null"}
    )
    assert plain_null.status_code == 403
    assert _FakeClient.calls == []


def test_cross_site_fetch_is_refused_even_with_a_local_origin_header(proxy_client):
    """Sec-Fetch-Site comes from the browser, not the page, so it outranks a
    forged Origin in a same-browser attack."""
    resp = proxy_client.post(
        _GENERATE,
        json={"contents": []},
        headers={"origin": "http://localhost:5173", "sec-fetch-site": "cross-site"},
    )
    assert resp.status_code == 403
    assert _FakeClient.calls == []


def test_packaged_renderer_same_origin_fetch_is_forwarded(proxy_client_loopback):
    """The app:// renderer may report an opaque origin; same-origin is enough
    to satisfy ``is_local_origin`` -- and the packaged app's own window
    always reaches this backend over its real loopback TCP connection
    (electron-ui/main/index.ts: BACKEND_BASE = 'http://127.0.0.1:8600'), which
    is what SEC-001's header-blind check actually relies on now."""
    resp = proxy_client_loopback.post(
        _GENERATE,
        json={"contents": []},
        headers={"origin": "null", "sec-fetch-site": "same-origin"},
    )
    assert resp.status_code == 200
    assert len(_FakeClient.calls) == 1


def test_client_supplied_key_never_overrides_the_server_key(proxy_client_loopback):
    resp = proxy_client_loopback.post(
        f"{_GENERATE}?key=attacker-key",
        json={"contents": []},
        headers={
            "origin": "http://localhost:5173",
            "sec-fetch-site": "same-site",
            "authorization": "Bearer nope",
        },
    )
    assert resp.status_code == 200
    call = _FakeClient.calls[0]
    assert call["params"] == {}
    assert "authorization" not in {k.lower() for k in call["headers"]}


def test_client_supplied_key_from_a_lan_peer_without_a_token_is_still_refused(
    proxy_client,
):
    resp = proxy_client.post(
        f"{_GENERATE}?key=attacker-key",
        json={"contents": []},
        headers={"origin": "http://localhost:5173", "authorization": "Bearer nope"},
    )
    assert resp.status_code == 403
    assert _FakeClient.calls == []


def test_off_surface_paths_are_refused(proxy_client):
    for path in (
        "/api/genai-proxy/v1beta/tunedModels",
        "/api/genai-proxy/v1beta/corpora/x:query",
        "/api/genai-proxy/download/storage/v1/b/bucket/o/object",
    ):
        resp = proxy_client.post(
            path, json={}, headers={"origin": "http://localhost:5173"}
        )
        assert resp.status_code == 403, path
    assert _FakeClient.calls == []


def test_token_is_required_once_configured(proxy_client, monkeypatch):
    monkeypatch.setenv(proxy_router.access.TOKEN_ENV, "s3cret")

    blocked = proxy_client.post(
        _GENERATE, json={"contents": []}, headers={"origin": "http://localhost:5173"}
    )
    assert blocked.status_code == 403
    assert _FakeClient.calls == []

    allowed = proxy_client.post(
        _GENERATE,
        json={"contents": []},
        headers={
            "origin": "http://localhost:5173",
            proxy_router.access.TOKEN_HEADER: "s3cret",
        },
    )
    assert allowed.status_code == 200
    assert len(_FakeClient.calls) == 1
    # The hop token is ours, not Google's: it must not travel upstream.
    assert proxy_router.access.TOKEN_QUERY not in _FakeClient.calls[0]["params"]
