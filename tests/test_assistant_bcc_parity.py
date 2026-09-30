"""
BCC parity for the assistant backend (plan P-20260919-assistant-foundry-parity).

Covers the three things the VST Foundry's red orb serves that theDAW's assistant
backend did not:

  1. ``GET /api/assistant/providers`` surfaces the Claude Code provider FIRST,
     labelled ``BCC (Better Claude Code)``.
  2. ``GET /api/assistant/models/claude`` fetches the catalog LIVE from
     Anthropic (api key -> env OAuth token -> the Claude Code login file), with
     pagination, a 10-minute in-process cache, the Foundry's ``[1m]`` variants
     appended, and a fall back to the static catalog on ANY failure.
  3. ``POST /api/assistant/context-usage`` asks the live CLI for its real
     context-window usage over a ``get_context_usage`` control request.

Nothing here touches the network or the real ``~/.claude/.credentials.json``:
``httpx.AsyncClient`` is replaced with a recording fake for the duration of a
test, and ``assistant_routes.CLAUDE_CREDENTIALS_PATH`` is pointed at a tmp file.
The routes themselves are driven for real through ``httpx.ASGITransport``.

Async bodies run under ``asyncio.run`` inside plain pytest functions, the same
convention as ``tests/test_assistant_routes_claude.py``.
"""

from types import SimpleNamespace
import asyncio
import json
import logging
import time

import httpx
import pytest
from fastapi import FastAPI

from backend import assistant_routes as ar
from backend.modules.assistant import claude_session as cs

# The Foundry's catalog, read from
# VST-Foundry-UI/VST-UI-FOUNDRY/server/claude-bridge.ts (CLAUDE_MODELS, ~L51-66
# and CLAUDE_DEFAULT_MODEL, L32). Never written from memory - see the repo HARD
# RULE on model catalogs.
FOUNDRY_BASE_IDS = (
    "claude-fable-5",
    "claude-sonnet-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
)
FOUNDRY_1M_IDS = (
    "claude-sonnet-5[1m]",
    "claude-opus-4-8[1m]",
    "claude-opus-4-7[1m]",
    "claude-opus-4-6[1m]",
    "claude-sonnet-4-6[1m]",
)
FOUNDRY_DEFAULT_MODEL = "claude-opus-4-8"

# Obvious fakes. A token must never reach a response body or a log line.
FAKE_API_KEY = "sk-ant-FAKE-KEY-DO-NOT-LOG-0001"
FAKE_ENV_TOKEN = "sk-ant-oat-FAKE-ENV-TOKEN-0002"
FAKE_FILE_TOKEN = "sk-ant-oat-FAKE-FILE-TOKEN-0003"


# ---------------------------------------------------------------------------
# App / client
# ---------------------------------------------------------------------------
def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(ar.router)
    return app


APP = _make_app()

# Captured BEFORE any test swaps httpx.AsyncClient for the recording fake, so
# the harness keeps talking to the app while the code under test talks to the
# fake.
_REAL_ASYNC_CLIENT = httpx.AsyncClient


def client() -> httpx.AsyncClient:
    return _REAL_ASYNC_CLIENT(
        transport=httpx.ASGITransport(app=APP), base_url="http://test"
    )


def run(body, timeout: float = 20.0) -> None:
    async def wrapper():
        await asyncio.wait_for(body(), timeout)

    asyncio.run(wrapper())


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------
class _FakeResponse:
    def __init__(self, status_code: int, payload, *, bad_json: bool = False):
        self.status_code = status_code
        self._payload = payload
        self._bad_json = bad_json
        self.text = "" if bad_json else json.dumps(payload)

    def json(self):
        if self._bad_json:
            raise ValueError("Expecting value: line 1 column 1 (char 0)")
        return self._payload


def install_fake_anthropic(monkeypatch, pages, *, error=None) -> list[dict]:
    """Replace ``httpx.AsyncClient`` with a recorder that serves ``pages``.

    Returns the list every GET is appended to, so a test can assert on the URL,
    the headers that were actually sent, and the pagination cursor.
    """
    calls: list[dict] = []

    class _FakeClient:
        def __init__(self, *args, **kwargs):
            self.init_kwargs = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return False

        async def get(self, url, headers=None, params=None):
            calls.append(
                {
                    "url": url,
                    "headers": dict(headers or {}),
                    "params": dict(params or {}),
                }
            )
            if error is not None:
                raise error
            index = min(len(calls) - 1, len(pages) - 1)
            return pages[index]

    monkeypatch.setattr(ar.httpx, "AsyncClient", _FakeClient)
    return calls


def page(models, *, has_more=False, last_id=None, status=200, bad_json=False):
    payload = {
        "data": [
            {"id": mid, "display_name": name, "type": "model"} for mid, name in models
        ],
        "has_more": has_more,
        "first_id": models[0][0] if models else None,
        "last_id": last_id or (models[-1][0] if models else None),
    }
    return _FakeResponse(status, payload, bad_json=bad_json)


def write_credentials(tmp_path, monkeypatch, token: str, *, expires_at=None):
    """Point the module at a tmp login file holding ``token``."""
    path = tmp_path / ".credentials.json"
    oauth = {"accessToken": token}
    if expires_at is not None:
        oauth["expiresAt"] = expires_at
    path.write_text(json.dumps({"claudeAiOauth": oauth}), encoding="utf-8")
    monkeypatch.setattr(ar, "CLAUDE_CREDENTIALS_PATH", path)
    return path


@pytest.fixture(autouse=True)
def _isolate_claude_model_state(monkeypatch, tmp_path):
    """No cached list, no env credential, no real login file."""
    ar._CLAUDE_LIVE_MODELS_CACHE.update({"models": None, "fetched_at": 0.0})
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN", raising=False)
    monkeypatch.setattr(ar, "CLAUDE_CREDENTIALS_PATH", tmp_path / "absent.json")
    yield
    ar._CLAUDE_LIVE_MODELS_CACHE.update({"models": None, "fetched_at": 0.0})
    cs.sessions.clear()


# ---------------------------------------------------------------------------
# (1) Provider catalog: BCC first, with the Foundry's label.
# ---------------------------------------------------------------------------
def test_providers_route_surfaces_bcc_first_with_the_foundry_label():
    async def body():
        async with client() as http:
            resp = await http.get("/api/assistant/providers")
        assert resp.status_code == 200, resp.text
        providers = resp.json()["providers"]
        assert providers[0]["id"] == "claude"
        assert providers[0]["label"] == "BCC (Better Claude Code)"
        assert providers[0]["default_model"] == FOUNDRY_DEFAULT_MODEL
        # Every other provider is still listed, exactly once.
        ids = [p["id"] for p in providers]
        assert len(ids) == len(set(ids))
        for pid in ar.PROVIDERS:
            assert pid in ids

    run(body)


# ---------------------------------------------------------------------------
# (2) Static catalog: everything the Foundry has, nothing removed.
# ---------------------------------------------------------------------------
def test_static_catalog_holds_every_foundry_model_and_keeps_the_old_ones():
    ids = [m["id"] for m in ar.CLAUDE_MODELS]
    for foundry_id in FOUNDRY_BASE_IDS:
        assert foundry_id in ids, f"{foundry_id} is missing from CLAUDE_MODELS"
    # Pre-existing entries survive (repo HARD RULE 1: never remove a model).
    for kept in ("claude-fable-5", "sonnet", "opus", "haiku"):
        assert kept in ids
    assert len(ids) == len(set(ids))
    assert ar.CLAUDE_DEFAULT_MODEL == FOUNDRY_DEFAULT_MODEL


def test_static_models_route_appends_the_foundry_1m_variants():
    async def body():
        async with client() as http:
            resp = await http.get("/api/assistant/models/claude")
        assert resp.status_code == 200, resp.text
        payload = resp.json()
        assert payload["source"] == "static"
        # Today's shape is unchanged.
        assert set(payload) >= {
            "models",
            "model_ids",
            "modes",
            "note",
            "error",
            "source",
        }
        assert payload["error"] is None
        assert payload["modes"]
        ids = payload["model_ids"]
        assert ids == [m["id"] for m in payload["models"]]
        # The [1m] ids come after the base ids, in the Foundry's order.
        assert ids[-len(FOUNDRY_1M_IDS) :] == list(FOUNDRY_1M_IDS)
        by_id = {m["id"]: m for m in payload["models"]}
        assert by_id["claude-opus-4-8[1m]"]["name"] == "Claude Opus 4.8 (1M context)"
        assert (
            by_id["claude-opus-4-8[1m]"]["capabilities"]
            == by_id["claude-opus-4-8"]["capabilities"]
        )
        # No [1m] variant for a base id the Foundry does not give one.
        assert "claude-fable-5[1m]" not in ids
        assert "claude-haiku-4-5[1m]" not in ids

    run(body)


# ---------------------------------------------------------------------------
# (3) Live fetch: credentials, pagination, cache, capabilities, fallback.
# ---------------------------------------------------------------------------
def test_live_models_are_fetched_with_an_api_key_and_paginated(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", FAKE_API_KEY)
    calls = install_fake_anthropic(
        monkeypatch,
        [
            page(
                [("claude-opus-4-8", "Claude Opus 4.8")],
                has_more=True,
                last_id="claude-opus-4-8",
            ),
            page([("claude-zzz-test-1", "Claude ZZZ Test 1")]),
        ],
    )

    async def body():
        async with client() as http:
            resp = await http.get("/api/assistant/models/claude")
        assert resp.status_code == 200, resp.text
        payload = resp.json()
        assert payload["source"] == "live"
        # Both pages, in order, with display_name as the name.
        assert payload["model_ids"][:2] == ["claude-opus-4-8", "claude-zzz-test-1"]
        by_id = {m["id"]: m for m in payload["models"]}
        assert by_id["claude-zzz-test-1"]["name"] == "Claude ZZZ Test 1"
        # Capabilities come from the existing prefix-matching helper; an id that
        # matches nothing gets that helper's default.
        assert "reasoning" in by_id["claude-opus-4-8"]["capabilities"]
        assert by_id["claude-zzz-test-1"]["capabilities"] == ["tools", "vision", "code"]
        # [1m] only for a base id that is actually in the list.
        assert "claude-opus-4-8[1m]" in payload["model_ids"]
        assert "claude-sonnet-5[1m]" not in payload["model_ids"]
        assert "claude-zzz-test-1[1m]" not in payload["model_ids"]

        # Two pages: the second carries the cursor, the first does not.
        assert len(calls) == 2
        assert calls[0]["url"] == "https://api.anthropic.com/v1/models"
        assert "after_id" not in calls[0]["params"]
        assert calls[1]["params"]["after_id"] == "claude-opus-4-8"
        # An api key goes in x-api-key, with no OAuth headers.
        assert calls[0]["headers"]["x-api-key"] == FAKE_API_KEY
        assert calls[0]["headers"]["anthropic-version"] == "2023-06-01"
        assert "Authorization" not in calls[0]["headers"]
        assert FAKE_API_KEY not in resp.text

    run(body)


def test_live_model_list_is_cached_in_process(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", FAKE_API_KEY)
    calls = install_fake_anthropic(
        monkeypatch, [page([("claude-opus-4-8", "Claude Opus 4.8")])]
    )

    async def body():
        async with client() as http:
            first = await http.get("/api/assistant/models/claude")
            second = await http.get("/api/assistant/models/claude")
        assert first.json()["models"] == second.json()["models"]
        assert second.json()["source"] == "live"
        assert len(calls) == 1, "the cached list must not be re-fetched"

        # The cache expires after 10 minutes.
        assert ar.CLAUDE_LIVE_MODELS_TTL_S == 600.0
        ar._CLAUDE_LIVE_MODELS_CACHE["fetched_at"] = time.time() - 601.0
        async with client() as http:
            await http.get("/api/assistant/models/claude")
        assert len(calls) == 2

    run(body)


def test_live_fetch_uses_the_env_oauth_token_when_there_is_no_api_key(monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", FAKE_ENV_TOKEN)
    calls = install_fake_anthropic(
        monkeypatch, [page([("claude-opus-4-8", "Claude Opus 4.8")])]
    )

    async def body():
        async with client() as http:
            resp = await http.get("/api/assistant/models/claude")
        assert resp.json()["source"] == "live"
        headers = calls[0]["headers"]
        assert headers["Authorization"] == f"Bearer {FAKE_ENV_TOKEN}"
        assert headers["anthropic-beta"] == "oauth-2025-04-20"
        assert "x-api-key" not in headers
        assert FAKE_ENV_TOKEN not in resp.text

    run(body)


def test_live_fetch_falls_back_to_the_claude_code_login_file(
    monkeypatch, tmp_path, caplog
):
    write_credentials(
        tmp_path,
        monkeypatch,
        FAKE_FILE_TOKEN,
        expires_at=int((time.time() + 3600) * 1000),
    )
    calls = install_fake_anthropic(
        monkeypatch, [page([("claude-opus-4-8", "Claude Opus 4.8")])]
    )

    async def body():
        with caplog.at_level(logging.DEBUG):
            async with client() as http:
                resp = await http.get("/api/assistant/models/claude")
        assert resp.json()["source"] == "live"
        assert calls[0]["headers"]["Authorization"] == f"Bearer {FAKE_FILE_TOKEN}"
        assert calls[0]["headers"]["anthropic-beta"] == "oauth-2025-04-20"
        # The credential never reaches the response or the log.
        assert FAKE_FILE_TOKEN not in resp.text
        assert FAKE_FILE_TOKEN not in caplog.text

    run(body)


def test_an_expired_login_file_is_skipped(monkeypatch, tmp_path, caplog):
    write_credentials(
        tmp_path,
        monkeypatch,
        FAKE_FILE_TOKEN,
        expires_at=int((time.time() - 60) * 1000),
    )
    calls = install_fake_anthropic(
        monkeypatch, [page([("claude-opus-4-8", "Claude Opus 4.8")])]
    )

    async def body():
        with caplog.at_level(logging.DEBUG):
            async with client() as http:
                resp = await http.get("/api/assistant/models/claude")
        assert resp.json()["source"] == "static"
        assert calls == [], "an expired token must not be sent"
        assert FAKE_FILE_TOKEN not in resp.text
        assert FAKE_FILE_TOKEN not in caplog.text

    run(body)


def test_a_login_file_without_an_expiry_is_still_used(monkeypatch, tmp_path):
    write_credentials(tmp_path, monkeypatch, FAKE_FILE_TOKEN)
    calls = install_fake_anthropic(
        monkeypatch, [page([("claude-opus-4-8", "Claude Opus 4.8")])]
    )

    async def body():
        async with client() as http:
            resp = await http.get("/api/assistant/models/claude")
        assert resp.json()["source"] == "live"
        assert calls[0]["headers"]["Authorization"] == f"Bearer {FAKE_FILE_TOKEN}"

    run(body)


@pytest.mark.parametrize(
    "kind",
    ["no_credential", "http_error", "timeout", "bad_json", "empty"],
)
def test_any_live_failure_falls_back_to_the_static_catalog(monkeypatch, kind, caplog):
    if kind != "no_credential":
        monkeypatch.setenv("ANTHROPIC_API_KEY", FAKE_API_KEY)
    if kind == "http_error":
        install_fake_anthropic(monkeypatch, [page([], status=500)])
    elif kind == "timeout":
        install_fake_anthropic(
            monkeypatch, [], error=httpx.ReadTimeout("timed out", request=None)
        )
    elif kind == "bad_json":
        install_fake_anthropic(monkeypatch, [page([("x", "X")], bad_json=True)])
    elif kind == "empty":
        install_fake_anthropic(monkeypatch, [page([])])

    async def body():
        with caplog.at_level(logging.DEBUG):
            async with client() as http:
                resp = await http.get("/api/assistant/models/claude")
        assert resp.status_code == 200, resp.text
        payload = resp.json()
        assert payload["source"] == "static"
        assert payload["error"] is None
        assert payload["model_ids"][: len(FOUNDRY_BASE_IDS)] == list(FOUNDRY_BASE_IDS)
        assert FAKE_API_KEY not in resp.text
        assert FAKE_API_KEY not in caplog.text
        # A failure is NOT cached: the next request tries again.
        assert ar._CLAUDE_LIVE_MODELS_CACHE["models"] is None

    run(body)


# ---------------------------------------------------------------------------
# (4) _resolve_claude_model: the Foundry's resolveClaudeModel semantics.
# ---------------------------------------------------------------------------
def _resolve(model):
    return ar._resolve_claude_model(ar.ChatRequest(messages=[], model=model))


@pytest.mark.parametrize(
    "model, expected",
    [
        (None, FOUNDRY_DEFAULT_MODEL),
        ("", FOUNDRY_DEFAULT_MODEL),
        ("   ", FOUNDRY_DEFAULT_MODEL),
        ("claude-code-interactive", FOUNDRY_DEFAULT_MODEL),
        # An id in the list passes through, [1m] variants included.
        ("claude-opus-4-7", "claude-opus-4-7"),
        ("claude-sonnet-4-6", "claude-sonnet-4-6"),
        ("claude-opus-4-8[1m]", "claude-opus-4-8[1m]"),
        # Family aliases map to the newest non-[1m] id of that family.
        ("opus", "claude-opus-4-8"),
        ("sonnet", "claude-sonnet-5"),
        ("haiku", "claude-haiku-4-5"),
        # A stale pinned id maps to the newest id of its family.
        ("claude-opus-4-1-20250805", "claude-opus-4-8"),
        ("claude-sonnet-3-5-20241022", "claude-sonnet-5"),
        # Anything else falls back to the default.
        ("gpt-5-turbo", FOUNDRY_DEFAULT_MODEL),
    ],
)
def test_resolve_claude_model_against_the_static_catalog(model, expected):
    assert _resolve(model) == expected


def test_resolve_claude_model_prefers_a_warm_live_list():
    ar._CLAUDE_LIVE_MODELS_CACHE.update(
        {
            "models": [
                {"id": "claude-sonnet-7-testonly", "name": "S7", "capabilities": []},
                {"id": "claude-sonnet-6-testonly", "name": "S6", "capabilities": []},
                {"id": "claude-opus-4-8", "name": "O48", "capabilities": []},
            ],
            "fetched_at": time.time(),
        }
    )
    # An id in the live list passes through.
    assert _resolve("claude-sonnet-6-testonly") == "claude-sonnet-6-testonly"
    # A family alias maps to the newest of that family IN THE LIVE LIST.
    assert _resolve("sonnet") == "claude-sonnet-7-testonly"
    # Appended [1m] variants of live base ids resolve too.
    assert _resolve("claude-opus-4-8[1m]") == "claude-opus-4-8[1m]"
    # No haiku in the live list -> the default.
    assert _resolve("haiku") == FOUNDRY_DEFAULT_MODEL


def test_every_model_the_list_can_return_has_a_live_fallback():
    ids = [m["id"] for m in ar.CLAUDE_MODELS]
    listed = set(ids)
    for mid in ids:
        fallback = ar._claude_fallback_model(mid)
        if mid.startswith("claude-opus") or mid == "opus":
            assert fallback is not None, f"{mid} has no fallback"
        if fallback is not None and fallback.startswith("claude-"):
            assert fallback in listed, f"{mid} falls back to a dead id {fallback}"
        assert fallback != mid


# ---------------------------------------------------------------------------
# (5) POST /context-usage
# ---------------------------------------------------------------------------
def install_control_answer(monkeypatch, answer, seen=None):
    async def fake_send_control_request(conversation_id, request, *a, **kw):
        if seen is not None:
            seen.append((conversation_id, request))
        return answer

    monkeypatch.setattr(cs, "send_control_request", fake_send_control_request)


def register_session(conversation_id: str) -> None:
    # The route reads the session's own key back (it may have found the session
    # through the Claude session id), so the stand-in carries one.
    cs.sessions[conversation_id] = SimpleNamespace(conversation_id=conversation_id)


def test_context_usage_returns_the_clis_reading(monkeypatch):
    seen: list = []
    install_control_answer(
        monkeypatch,
        {
            "subtype": "success",
            "request_id": "req_1",
            "response": {"totalTokens": 41000, "maxTokens": 200000, "percentage": 20.5},
        },
        seen,
    )
    register_session("conv-ctx")

    async def body():
        async with client() as http:
            resp = await http.post(
                "/api/assistant/context-usage", json={"conversationId": "conv-ctx"}
            )
        assert resp.status_code == 200, resp.text
        assert resp.json() == {
            "ok": True,
            "usage": {"totalTokens": 41000, "maxTokens": 200000, "percentage": 20.5},
        }
        assert seen == [("conv-ctx", {"subtype": "get_context_usage"})]

    run(body)


def test_context_usage_accepts_snake_case_and_a_fraction_percentage(monkeypatch):
    install_control_answer(
        monkeypatch,
        {
            "subtype": "success",
            "response": {"total_tokens": 8000, "max_tokens": 200000, "percentage": 0.4},
        },
    )
    register_session("conv-frac")

    async def body():
        async with client() as http:
            resp = await http.post(
                "/api/assistant/context-usage", json={"conversationId": "conv-frac"}
            )
        assert resp.status_code == 200, resp.text
        assert resp.json()["usage"] == {
            "totalTokens": 8000,
            "maxTokens": 200000,
            "percentage": 40.0,
        }

    run(body)


def test_context_usage_404s_for_an_unknown_conversation(monkeypatch):
    install_control_answer(monkeypatch, None)

    async def body():
        async with client() as http:
            resp = await http.post(
                "/api/assistant/context-usage", json={"conversationId": "nope"}
            )
        assert resp.status_code == 404

    run(body)


@pytest.mark.parametrize(
    "answer",
    [
        None,
        {"subtype": "error", "response": {"percentage": 12}},
        {"subtype": "success", "response": {}},
        {"subtype": "success", "response": {"percentage": "lots"}},
        {"subtype": "success"},
    ],
)
def test_context_usage_504s_when_the_cli_does_not_answer_usefully(monkeypatch, answer):
    install_control_answer(monkeypatch, answer)
    register_session("conv-mute")

    async def body():
        async with client() as http:
            resp = await http.post(
                "/api/assistant/context-usage", json={"conversationId": "conv-mute"}
            )
        assert resp.status_code == 504, resp.text
        payload = resp.json()
        assert payload["ok"] is False
        assert payload["error"]

    run(body)
