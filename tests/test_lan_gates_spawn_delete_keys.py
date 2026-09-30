"""Routes that spawn a program, reveal a key or push work into the browser
answer this machine only.

The backend binds 0.0.0.0, and ``refuse_cross_site`` tells a foreign web page
from theDAW's own UI by headers a page cannot set. A script on the LAN sends no
such headers and passed it. These routes now hold to
``require_loopback_or_launch_token`` (``backend/lib/cross_site.py``): the TCP
peer must be loopback, or the request must carry the desktop shell's launch
token. Each test here is one LAN caller refused and one loopback caller passed:

* ``POST /api/assistant/chat`` with the ``claude`` provider spawns the Claude
  Code CLI on this machine (and, in ``trusted`` mode, lets it run anything).
  The hosted providers stay open to a paired device.
* ``GET /api/assistant/keys/{provider}/raw`` returns the stored keys in the
  clear; ``/ingest`` and the two DELETE routes change the pool.
* ``POST /api/mcp-relay/call`` pushes a tool call into the user's browser for
  any session id the body names.
* ``GET /api/lyria/url`` used to run ``ensure_running`` (npm install and a
  Node spawn) for whoever asked. It is a read now; ``POST /start`` spawns,
  behind the change gate the other Lyria routes use, and the read kicks the
  background warm-up only for a caller that gate would pass.

The library bulk-delete gate is proved in ``test_library_bulk_delete.py``,
the admin router's in ``test_admin_routes.py`` and the underfit assistant
start's background thread in ``test_underfit_assistant_sidecar.py``.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import assistant_routes as ar
from backend.lib import launch_token, pairing
from backend.modules.assistant import mcp_relay
from backend.modules.lyria import router as lyria_router
from backend.modules.lyria import sidecar as lyria_sidecar

LAN_PEER = ("10.20.30.40", 51000)
LOOPBACK_PEER = ("127.0.0.1", 51000)
SHELL_TOKEN = "s3cret-launch"


@pytest.fixture(autouse=True)
def _no_tokens(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """No launch token unless a test sets one, and a pairing-token file of
    the test's own, so no test reads the persisted one."""
    monkeypatch.delenv(launch_token.ENV_VAR, raising=False)
    monkeypatch.setattr(pairing, "_TOKEN_FILE", tmp_path / "pairing_token.txt")
    monkeypatch.setattr(pairing, "_cached", None)


# ---------------------------------------------------------------------------
# POST /api/assistant/chat, provider "claude"
# ---------------------------------------------------------------------------


def _assistant_app() -> FastAPI:
    app = FastAPI()
    app.include_router(ar.router)
    return app


@pytest.fixture
def claude_stream(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Everything after the gate replaced by recorders: the RAG lookup, the
    skill block, attachment staging and the Claude stream itself."""
    streamed: list[str] = []

    async def fake_stream(req, request):
        streamed.append(req.conversationId or "")
        yield "data: ok\n\n"

    monkeypatch.setitem(
        sys.modules,
        "backend.rag",
        types.SimpleNamespace(retrieve=lambda q, n: [], format_context=lambda c: ""),
    )
    monkeypatch.setattr(ar, "_stable_audio_skill_system_block", lambda: "")
    monkeypatch.setattr(ar, "_stage_attachments", lambda attachments, sid: [])
    monkeypatch.setattr(ar, "_stream_claude", fake_stream)
    return streamed


def _chat(provider: str, mode: str | None = None) -> dict:
    body: dict = {
        "provider": provider,
        "conversationId": "conv-gate",
        "messages": [{"role": "user", "content": "hello"}],
    }
    if mode is not None:
        body["claude_permission_mode"] = mode
    return body


def test_a_lan_caller_cannot_start_a_claude_session(claude_stream: list[str]):
    lan = TestClient(_assistant_app(), client=LAN_PEER)
    response = lan.post("/api/assistant/chat", json=_chat("claude", "trusted"))
    assert response.status_code == 403
    assert "computer running theDAW" in response.json()["detail"]
    assert claude_stream == []


def test_a_lan_caller_cannot_drive_a_claude_session(claude_stream: list[str]):
    """Answering a permission bubble, switching the mode (which respawns the
    child) and interrupting a turn act on the same child."""
    lan = TestClient(_assistant_app(), client=LAN_PEER)
    who = {"conversationId": "conv-gate"}
    assert (
        lan.post(
            "/api/assistant/permission-mode", json={**who, "mode": "trusted"}
        ).status_code
        == 403
    )
    assert (
        lan.post(
            "/api/assistant/control-response",
            json={**who, "requestId": "r1", "response": {"behavior": "allow"}},
        ).status_code
        == 403
    )
    assert lan.post("/api/assistant/interrupt", json=who).status_code == 403
    assert lan.post("/api/assistant/context-usage", json=who).status_code == 403


def test_this_machines_ui_and_the_desktop_shell_still_get_claude(
    claude_stream: list[str], monkeypatch: pytest.MonkeyPatch
):
    local = TestClient(_assistant_app(), client=LOOPBACK_PEER)
    response = local.post("/api/assistant/chat", json=_chat("claude", "trusted"))
    assert response.status_code == 200
    assert response.text == "data: ok\n\n"
    assert claude_stream == ["conv-gate"]

    monkeypatch.setenv(launch_token.ENV_VAR, SHELL_TOKEN)
    shell = TestClient(_assistant_app(), client=LAN_PEER)
    response = shell.post(
        "/api/assistant/chat",
        json=_chat("claude"),
        headers={launch_token.HEADER: SHELL_TOKEN},
    )
    assert response.status_code == 200
    assert claude_stream == ["conv-gate", "conv-gate"]


def test_a_paired_device_still_reaches_the_hosted_providers(
    claude_stream: list[str], monkeypatch: pytest.MonkeyPatch
):
    """The gate is on the Claude provider, which runs a program here; a
    hosted provider calls an API with the user's key and stays reachable."""
    opened: list[str] = []

    async def fake_openai(req, request, provider):
        opened.append(provider)
        yield "data: ok\n\n"

    monkeypatch.setattr(ar, "_stream_openai_compat", fake_openai)
    provider = next(p for p in ar.PROVIDERS if p != "claude")
    lan = TestClient(_assistant_app(), client=LAN_PEER)
    response = lan.post("/api/assistant/chat", json=_chat(provider))
    assert response.status_code == 200
    assert opened == [provider]
    assert claude_stream == []


# ---------------------------------------------------------------------------
# The key pool: /keys/{provider}/raw, /ingest and the two DELETE routes
# ---------------------------------------------------------------------------


@pytest.fixture
def pool(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """A key pool that records every change and holds one key."""
    changes: list[str] = []
    entry = types.SimpleNamespace(key="sk-live-1234567890")
    monkeypatch.setattr(ar.key_pool, "get_raw_keys", lambda provider: [entry.key])
    monkeypatch.setattr(ar.key_pool, "get_pool_status", lambda provider: {"count": 1})
    monkeypatch.setattr(
        ar.key_pool, "ingest_keys", lambda provider, raw: changes.append("ingest") or 1
    )
    monkeypatch.setattr(
        ar.key_pool, "remove_key", lambda provider, key: changes.append("remove")
    )
    monkeypatch.setattr(
        ar.key_pool, "clear_provider", lambda provider: changes.append("clear")
    )
    monkeypatch.setattr(ar.key_pool, "_pools", {"openai": [entry]})
    return changes


def test_a_lan_caller_cannot_read_or_change_the_key_pool(pool: list[str]):
    lan = TestClient(_assistant_app(), client=LAN_PEER)
    key_hash = ar._key_id("sk-live-1234567890")
    assert lan.get("/api/assistant/keys/openai/raw").status_code == 403
    assert (
        lan.post("/api/assistant/keys/openai/ingest", json={"keys": "sk-x"}).status_code
        == 403
    )
    assert lan.delete(f"/api/assistant/keys/openai/{key_hash}").status_code == 403
    assert lan.delete("/api/assistant/keys/openai").status_code == 403
    assert pool == []
    # The status routes answer counts, never a key, and stay open.
    assert lan.get("/api/assistant/keys/openai").status_code == 200


def test_this_machines_ui_still_syncs_and_edits_the_key_pool(pool: list[str]):
    local = TestClient(_assistant_app(), client=LOOPBACK_PEER)
    key_hash = ar._key_id("sk-live-1234567890")
    raw = local.get("/api/assistant/keys/openai/raw")
    assert raw.status_code == 200
    assert raw.json()["keys"] == ["sk-live-1234567890"]
    assert (
        local.post(
            "/api/assistant/keys/openai/ingest", json={"keys": "sk-x"}
        ).status_code
        == 200
    )
    assert local.delete(f"/api/assistant/keys/openai/{key_hash}").json()["removed"]
    assert local.delete("/api/assistant/keys/openai").json()["cleared"]
    assert pool == ["ingest", "remove", "clear"]


# ---------------------------------------------------------------------------
# POST /api/mcp-relay/call
# ---------------------------------------------------------------------------


def _relay_app(monkeypatch: pytest.MonkeyPatch) -> tuple[FastAPI, list[str]]:
    pushed: list[str] = []
    registry = mcp_relay.RelayRegistry()

    async def record_push(session_key, name, args=None):
        pushed.append(name)
        return "done"

    monkeypatch.setattr(registry, "push_client_tool_call", record_push)
    monkeypatch.setattr(mcp_relay, "registry", registry)
    app = FastAPI()
    app.include_router(mcp_relay.router)
    return app, pushed


def test_a_lan_caller_cannot_push_a_tool_call_into_the_browser(
    monkeypatch: pytest.MonkeyPatch,
):
    app, pushed = _relay_app(monkeypatch)
    lan = TestClient(app, client=LAN_PEER)
    response = lan.post(
        "/api/mcp-relay/call",
        json={"sessionId": "relay-1", "name": "navigate", "args": {"tab": "edit"}},
    )
    assert response.status_code == 403
    assert pushed == []


def test_the_stdio_child_on_this_machine_still_relays(monkeypatch: pytest.MonkeyPatch):
    """thedaw_mcp_server.py posts to 127.0.0.1 with no headers beyond the
    content type: a loopback peer, which is all the gate asks."""
    app, pushed = _relay_app(monkeypatch)
    local = TestClient(app, client=LOOPBACK_PEER)
    response = local.post(
        "/api/mcp-relay/call",
        json={"sessionId": "relay-1", "name": "navigate", "args": {"tab": "edit"}},
    )
    assert response.status_code == 200
    assert response.json() == {"ok": True, "result": "done"}
    assert pushed == ["navigate"]


# ---------------------------------------------------------------------------
# GET /api/lyria/url reads; POST /api/lyria/start spawns, behind the gate
# ---------------------------------------------------------------------------


@pytest.fixture
def lyria(monkeypatch: pytest.MonkeyPatch) -> dict:
    """A Lyria that is not running, a checkout that exists (so the warm-up
    would fire), and a spawn that records its calls."""
    state = {"spawns": 0, "running": None}

    def fake_ensure_running(**kwargs):
        state["spawns"] += 1
        return "http://127.0.0.1:5188"

    monkeypatch.delenv("theDAW_LYRIA_NO_AUTO_SPAWN", raising=False)
    monkeypatch.setattr(lyria_router, "_auto_spawn_started", False)
    monkeypatch.setattr(lyria_sidecar, "project_present", lambda cfg=None: True)
    monkeypatch.setattr(lyria_sidecar, "ensure_running", fake_ensure_running)
    monkeypatch.setattr(lyria_sidecar, "running_url", lambda: state["running"])
    monkeypatch.setattr(
        lyria_sidecar,
        "resolve_config",
        lambda: lyria_sidecar.LyriaConfig(
            project_path=lyria_sidecar.DEFAULT_PROJECT_PATH,
            port=5188,
            npm_path="npm",
            mock=True,
        ),
    )
    monkeypatch.setattr(lyria_sidecar, "detect_lan_ip", lambda: None)
    monkeypatch.setattr(lyria_sidecar, "owns_process", lambda: True)
    monkeypatch.setattr(lyria_sidecar, "checkout_state", lambda: {"state": "clean"})
    return state


def _lyria_app() -> FastAPI:
    app = FastAPI()
    app.include_router(lyria_router.router, prefix="/api/lyria")
    return app


def test_a_lan_caller_reading_the_lyria_url_starts_nothing(lyria: dict):
    lan = TestClient(_lyria_app(), client=LAN_PEER)
    response = lan.get("/api/lyria/url")
    assert response.status_code == 503
    assert response.json()["detail"] == lyria_router.NOT_RUNNING_DETAIL
    assert lan.get("/api/lyria/status").status_code == 200
    assert lyria_router._auto_spawn_started is False
    assert lan.post("/api/lyria/start").status_code == 403
    assert lyria["spawns"] == 0


def test_a_lan_caller_can_still_read_a_running_lyria(lyria: dict):
    """The read stays a read for everyone: a phone on the LAN that follows the
    mobile URL needs it."""
    lyria["running"] = "http://127.0.0.1:5188"
    lan = TestClient(_lyria_app(), client=LAN_PEER)
    response = lan.get("/api/lyria/url")
    assert response.status_code == 200
    assert response.json()["url"] == "http://127.0.0.1:5188"
    assert lyria["spawns"] == 0


def test_this_machines_ui_starts_lyria_through_start_and_the_warm_up(lyria: dict):
    local = TestClient(_lyria_app(), client=LOOPBACK_PEER)
    # The panel's first read: not running yet, and the warm-up is kicked for
    # a caller the change gate would pass.
    assert local.get("/api/lyria/url").status_code == 503
    assert lyria_router._auto_spawn_started is True
    started = local.post("/api/lyria/start")
    assert started.status_code == 200
    assert started.json() == {"ok": True, "url": "http://127.0.0.1:5188"}
    assert lyria["spawns"] >= 1
    lyria["running"] = "http://127.0.0.1:5188"
    ready = local.get("/api/lyria/url")
    assert ready.status_code == 200
    assert ready.json()["mode"] == "mock"
