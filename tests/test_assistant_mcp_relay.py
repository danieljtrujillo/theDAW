"""
Tests for the MCP relay registry, its FastAPI routes, and the shared tool
catalog (``backend/modules/assistant/``).

The relay is the execution boundary between the Claude Code CLI (via the stdio
``thedaw`` MCP server) and the browser: a tool call arrives over HTTP, is pushed
to the conversation's live SSE channel as a ``client_tool_call`` frame, and the
browser POSTs the result back. Nothing here spawns a CLI or a browser — the
"browser" is a fake writer callable that resolves (or ignores) the calls it sees.

Async behavior is driven with ``asyncio.run`` inside plain pytest functions so
the suite needs no pytest-asyncio / anyio plugin configuration (same convention
as tests/test_assistant_stream_lock.py).
"""

import asyncio
import json

import httpx
import pytest
from fastapi import FastAPI

from backend.modules.assistant import mcp_relay, tool_catalog
from backend.modules.assistant.mcp_relay import (
    RELAY_CLIENT_TIMEOUT_MS,
    RELAY_SERVER_TIMEOUT_MS,
    RelayError,
    RelayRegistry,
)
from backend.modules.assistant.tool_catalog import PROVIDER_TOOLS, thedaw_mcp_tools


# ---------------------------------------------------------------------------
# Fakes and helpers
# ---------------------------------------------------------------------------
class FakeBrowser:
    """A fake SSE channel that plays the role of the connected browser.

    Every frame written to it is recorded. When ``auto_result`` is set, the
    ``client_tool_call`` frames are answered immediately (in a task, the way a
    real browser answers out-of-band via POST /api/mcp-relay/result).
    """

    def __init__(self, registry, session_key, auto_result=None, is_error=False):
        self.registry = registry
        self.session_key = session_key
        self.auto_result = auto_result
        self.is_error = is_error
        self.frames = []
        self.closed = False

    def __call__(self, frame):
        if self.closed:
            raise RuntimeError("SSE channel already closed")
        self.frames.append(frame)
        if self.auto_result is None or frame.get("type") != "client_tool_call":
            return
        call_id = frame["callId"]
        asyncio.get_running_loop().call_soon(
            self.registry.resolve,
            self.session_key,
            call_id,
            self.auto_result,
            self.is_error,
        )


def _fast_registry():
    """A registry whose server-side waiter times out fast enough to test."""
    return RelayRegistry(server_timeout_ms=60)


# ---------------------------------------------------------------------------
# Timeout constants (C2: server 115s strictly below the client's 120s)
# ---------------------------------------------------------------------------
def test_relay_timeouts_are_exactly_the_contracted_values():
    assert RELAY_SERVER_TIMEOUT_MS == 115_000
    assert RELAY_CLIENT_TIMEOUT_MS == 120_000
    # The server MUST resolve first so the stdio child never destroys the socket
    # the same instant the server answers.
    assert RELAY_SERVER_TIMEOUT_MS < RELAY_CLIENT_TIMEOUT_MS


# ---------------------------------------------------------------------------
# Registry round-trip
# ---------------------------------------------------------------------------
def test_push_client_tool_call_round_trips_through_the_browser():
    registry = RelayRegistry()

    async def run():
        browser = FakeBrowser(registry, "relay-1", auto_result="tab switched")
        registry.register("relay-1", browser)
        return await registry.push_client_tool_call(
            "relay-1", "navigate", {"tab": "edit"}
        )

    result = asyncio.run(run())

    assert result == "tab switched"


def test_pushed_frame_matches_the_c1_client_tool_call_shape():
    registry = RelayRegistry()
    browser = FakeBrowser(registry, "relay-1", auto_result="ok")

    async def run():
        registry.register("relay-1", browser)
        await registry.push_client_tool_call("relay-1", "set_bpm", {"bpm": 128})

    asyncio.run(run())

    assert len(browser.frames) == 1
    frame = browser.frames[0]
    assert frame["type"] == "client_tool_call"
    assert frame["name"] == "set_bpm"
    assert frame["args"] == {"bpm": 128}
    assert isinstance(frame["callId"], str) and frame["callId"]
    # C1 (amended): the browser must be told which session key to post the
    # result back under, or a second conversation's channel can't be told apart.
    assert frame["sessionId"] == "relay-1"
    # The frame has to survive JSON serialization onto the SSE wire.
    assert json.loads(json.dumps(frame)) == frame


def test_pushed_frame_carries_the_session_key_that_was_used():
    """An aliased push must echo the ALIAS, so the browser posts it back verbatim."""
    registry = RelayRegistry()
    browser = FakeBrowser(registry, "sid-abc", auto_result="ok")

    async def run():
        registry.register("relay-1", browser)
        registry.alias("relay-1", "sid-abc")
        await registry.push_client_tool_call("sid-abc", "get_status", {})

    asyncio.run(run())

    assert browser.frames[0]["sessionId"] == "sid-abc"


def test_the_pushed_session_id_round_trips_back_through_the_result_route(monkeypatch):
    """The browser echoing frame.sessionId + frame.callId must resolve the call."""
    registry = RelayRegistry()
    app = _app(registry, monkeypatch)
    browser = FakeBrowser(registry, "relay-1")

    async def run():
        registry.register("relay-1", browser)
        registry.alias("relay-1", "sid-abc")
        task = asyncio.create_task(
            registry.push_client_tool_call("sid-abc", "get_status", {})
        )
        await asyncio.sleep(0)
        frame = browser.frames[0]
        async with _client(app) as client:
            response = await client.post(
                "/api/mcp-relay/result",
                json={
                    "sessionId": frame["sessionId"],
                    "callId": frame["callId"],
                    "result": "idle",
                },
            )
        return response.json(), await task

    body, result = asyncio.run(run())

    assert body == {"ok": True}
    assert result == "idle"


def test_each_call_gets_a_distinct_call_id():
    registry = RelayRegistry()
    browser = FakeBrowser(registry, "relay-1", auto_result="ok")

    async def run():
        registry.register("relay-1", browser)
        await registry.push_client_tool_call("relay-1", "get_status", {})
        await registry.push_client_tool_call("relay-1", "get_status", {})

    asyncio.run(run())

    call_ids = [f["callId"] for f in browser.frames]
    assert len(set(call_ids)) == 2


def test_browser_error_result_surfaces_as_a_relay_error():
    registry = RelayRegistry()

    async def run():
        browser = FakeBrowser(
            registry, "relay-1", auto_result="no such tab", is_error=True
        )
        registry.register("relay-1", browser)
        with pytest.raises(RelayError) as excinfo:
            await registry.push_client_tool_call("relay-1", "navigate", {"tab": "nope"})
        return str(excinfo.value)

    assert "no such tab" in asyncio.run(run())


# ---------------------------------------------------------------------------
# Session aliasing / lifecycle
# ---------------------------------------------------------------------------
def test_claude_session_id_alias_reaches_the_same_channel():
    registry = RelayRegistry()

    async def run():
        browser = FakeBrowser(registry, "sid-abc", auto_result="aliased")
        registry.register("relay-1", browser)
        registry.alias("relay-1", "sid-abc")
        return await registry.push_client_tool_call("sid-abc", "get_status", {})

    assert asyncio.run(run()) == "aliased"


def test_unregister_drops_the_relay_id_and_every_alias():
    registry = RelayRegistry()
    registry.register("relay-1", FakeBrowser(registry, "relay-1"))
    registry.alias("relay-1", "sid-abc")
    registry.alias("relay-1", "sid-def")

    registry.unregister("relay-1")

    assert registry.get("relay-1") is None
    assert registry.get("sid-abc") is None
    assert registry.get("sid-def") is None


def test_unregister_fails_calls_still_waiting_on_that_session():
    registry = RelayRegistry()

    async def run():
        browser = FakeBrowser(registry, "relay-1")  # never answers
        registry.register("relay-1", browser)
        task = asyncio.create_task(
            registry.push_client_tool_call("relay-1", "generate", {})
        )
        await asyncio.sleep(0)  # let the push register its pending call
        registry.unregister("relay-1")
        with pytest.raises(RelayError):
            await task

    asyncio.run(run())


def test_set_writer_repoints_the_channel_at_the_current_turn():
    registry = RelayRegistry()

    async def run():
        first = FakeBrowser(registry, "relay-1", auto_result="first")
        registry.register("relay-1", first)
        second = FakeBrowser(registry, "relay-1", auto_result="second")
        registry.set_writer("relay-1", second)
        result = await registry.push_client_tool_call("relay-1", "get_status", {})
        return result, first.frames, second.frames

    result, first_frames, second_frames = asyncio.run(run())

    assert result == "second"
    assert first_frames == []
    assert len(second_frames) == 1


# ---------------------------------------------------------------------------
# Failure modes: unknown session, closed SSE, timeout, stale result
# ---------------------------------------------------------------------------
def test_unknown_session_raises_instead_of_hanging():
    registry = RelayRegistry()

    async def run():
        with pytest.raises(RelayError) as excinfo:
            await registry.push_client_tool_call("nobody-home", "navigate", {})
        return str(excinfo.value)

    assert "nobody-home" in asyncio.run(run())


def test_detached_writer_is_treated_as_no_live_sse():
    registry = RelayRegistry()

    async def run():
        registry.register("relay-1", FakeBrowser(registry, "relay-1"))
        registry.set_writer("relay-1", None)
        with pytest.raises(RelayError):
            await registry.push_client_tool_call("relay-1", "navigate", {})

    asyncio.run(run())


def test_write_to_a_closed_sse_fails_the_call_and_leaves_nothing_pending():
    registry = RelayRegistry()
    browser = FakeBrowser(registry, "relay-1")
    browser.closed = True

    async def run():
        registry.register("relay-1", browser)
        with pytest.raises(RelayError):
            await registry.push_client_tool_call("relay-1", "navigate", {})
        return registry.get("relay-1")

    session = asyncio.run(run())

    assert session.pending == {}


def test_call_times_out_when_the_browser_never_answers():
    registry = _fast_registry()

    async def run():
        registry.register("relay-1", FakeBrowser(registry, "relay-1"))
        with pytest.raises(RelayError) as excinfo:
            await registry.push_client_tool_call("relay-1", "generate", {})
        return str(excinfo.value), registry.get("relay-1").pending

    message, pending = asyncio.run(run())

    assert "timed out" in message.lower()
    assert pending == {}, "a timed-out call must not leak a pending entry"


def test_result_for_an_unknown_call_is_ignored():
    registry = RelayRegistry()
    registry.register("relay-1", FakeBrowser(registry, "relay-1"))

    assert registry.resolve("relay-1", "no-such-call", "late", False) is False


def test_result_for_an_unknown_session_is_ignored():
    registry = RelayRegistry()

    assert registry.resolve("nobody-home", "call-1", "late", False) is False


def test_a_second_result_for_the_same_call_is_ignored():
    registry = RelayRegistry()

    async def run():
        browser = FakeBrowser(registry, "relay-1", auto_result="first")
        registry.register("relay-1", browser)
        result = await registry.push_client_tool_call("relay-1", "get_status", {})
        call_id = browser.frames[0]["callId"]
        return result, registry.resolve("relay-1", call_id, "second", False)

    result, replayed = asyncio.run(run())

    assert result == "first"
    assert replayed is False


def test_a_result_cannot_be_redirected_through_a_different_session():
    """callId must be pending for THAT session — not merely pending somewhere."""
    registry = RelayRegistry()

    async def run():
        victim = FakeBrowser(registry, "relay-victim")
        registry.register("relay-victim", victim)
        registry.register("relay-other", FakeBrowser(registry, "relay-other"))
        task = asyncio.create_task(
            registry.push_client_tool_call("relay-victim", "generate", {})
        )
        await asyncio.sleep(0)
        call_id = victim.frames[0]["callId"]
        hijacked = registry.resolve("relay-other", call_id, "spoofed", False)
        registry.unregister("relay-victim")
        with pytest.raises(RelayError):
            await task
        return hijacked

    assert asyncio.run(run()) is False


# ---------------------------------------------------------------------------
# HTTP surface (C2)
# ---------------------------------------------------------------------------
def _client(app):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://relay.test"
    )


def _app(registry, monkeypatch):
    monkeypatch.setattr(mcp_relay, "registry", registry)
    app = FastAPI()
    app.include_router(mcp_relay.router)
    return app


def test_post_call_relays_to_the_browser_and_returns_ok(monkeypatch):
    registry = RelayRegistry()
    app = _app(registry, monkeypatch)

    async def run():
        registry.register(
            "relay-1", FakeBrowser(registry, "relay-1", auto_result="now on EDIT")
        )
        async with _client(app) as client:
            response = await client.post(
                "/api/mcp-relay/call",
                json={
                    "sessionId": "relay-1",
                    "name": "navigate",
                    "args": {"tab": "edit"},
                },
            )
        return response.status_code, response.json()

    status, body = asyncio.run(run())

    assert status == 200
    assert body == {"ok": True, "result": "now on EDIT"}


def test_post_call_for_an_unknown_session_returns_ok_false(monkeypatch):
    registry = RelayRegistry()
    app = _app(registry, monkeypatch)

    async def run():
        async with _client(app) as client:
            response = await client.post(
                "/api/mcp-relay/call",
                json={"sessionId": "nobody-home", "name": "navigate", "args": {}},
            )
        return response.status_code, response.json()

    status, body = asyncio.run(run())

    assert status == 200
    assert body["ok"] is False
    assert body["error"]


def test_post_call_requires_a_tool_name(monkeypatch):
    registry = RelayRegistry()
    app = _app(registry, monkeypatch)

    async def run():
        registry.register("relay-1", FakeBrowser(registry, "relay-1"))
        async with _client(app) as client:
            response = await client.post(
                "/api/mcp-relay/call", json={"sessionId": "relay-1", "args": {}}
            )
        return response.json()

    body = asyncio.run(run())

    assert body["ok"] is False
    assert "name" in body["error"].lower()


def test_post_result_resolves_the_waiting_call(monkeypatch):
    registry = RelayRegistry()
    app = _app(registry, monkeypatch)
    browser = FakeBrowser(registry, "relay-1")

    async def run():
        registry.register("relay-1", browser)
        task = asyncio.create_task(
            registry.push_client_tool_call("relay-1", "editor_get_state", {})
        )
        await asyncio.sleep(0)
        call_id = browser.frames[0]["callId"]
        async with _client(app) as client:
            response = await client.post(
                "/api/mcp-relay/result",
                json={
                    "sessionId": "relay-1",
                    "callId": call_id,
                    "result": '{"tracks": 3}',
                },
            )
        return response.json(), await task

    body, result = asyncio.run(run())

    assert body == {"ok": True}
    assert result == '{"tracks": 3}'


def test_post_result_with_is_error_fails_the_call(monkeypatch):
    registry = RelayRegistry()
    app = _app(registry, monkeypatch)
    browser = FakeBrowser(registry, "relay-1")

    async def run():
        registry.register("relay-1", browser)
        task = asyncio.create_task(
            registry.push_client_tool_call("relay-1", "generate", {})
        )
        await asyncio.sleep(0)
        call_id = browser.frames[0]["callId"]
        async with _client(app) as client:
            await client.post(
                "/api/mcp-relay/result",
                json={
                    "sessionId": "relay-1",
                    "callId": call_id,
                    "result": "no model loaded",
                    "isError": True,
                },
            )
        with pytest.raises(RelayError) as excinfo:
            await task
        return str(excinfo.value)

    assert "no model loaded" in asyncio.run(run())


def test_post_result_for_an_unknown_call_is_rejected_not_crashed(monkeypatch):
    registry = RelayRegistry()
    app = _app(registry, monkeypatch)

    async def run():
        registry.register("relay-1", FakeBrowser(registry, "relay-1"))
        async with _client(app) as client:
            response = await client.post(
                "/api/mcp-relay/result",
                json={"sessionId": "relay-1", "callId": "ghost", "result": "late"},
            )
        return response.status_code, response.json()

    status, body = asyncio.run(run())

    assert status == 200
    assert body["ok"] is False


def test_post_result_for_an_unknown_session_is_rejected(monkeypatch):
    registry = RelayRegistry()
    app = _app(registry, monkeypatch)

    async def run():
        async with _client(app) as client:
            response = await client.post(
                "/api/mcp-relay/result",
                json={"sessionId": "nobody-home", "callId": "x", "result": "late"},
            )
        return response.status_code, response.json()

    status, body = asyncio.run(run())

    assert status == 200
    assert body["ok"] is False


# ---------------------------------------------------------------------------
# Tool catalog (C4) — one source of truth
# ---------------------------------------------------------------------------
def test_catalog_is_the_same_list_assistant_routes_hands_the_providers():
    """C4: the move out of assistant_routes.py must be semantics-preserving."""
    from backend.assistant_routes import theDAW_TOOLS

    assert PROVIDER_TOOLS == theDAW_TOOLS


def test_provider_tools_keep_the_openai_function_shape():
    assert PROVIDER_TOOLS, "the catalog must not be empty"
    for tool in PROVIDER_TOOLS:
        assert tool["type"] == "function"
        fn = tool["function"]
        assert isinstance(fn["name"], str) and fn["name"]
        assert isinstance(fn["description"], str) and fn["description"]
        assert fn["parameters"]["type"] == "object"


def test_mcp_tools_convert_parameters_to_input_schema():
    mcp_tools = thedaw_mcp_tools()

    assert len(mcp_tools) == len(PROVIDER_TOOLS)
    for mcp_tool, provider_tool in zip(mcp_tools, PROVIDER_TOOLS):
        fn = provider_tool["function"]
        assert set(mcp_tool) == {"name", "description", "inputSchema"}
        assert mcp_tool["name"] == fn["name"]
        assert mcp_tool["description"] == fn["description"]
        assert mcp_tool["inputSchema"] == fn["parameters"]


def test_mcp_tool_names_are_unprefixed_and_unique():
    names = [t["name"] for t in thedaw_mcp_tools()]

    assert len(names) == len(set(names))
    assert "navigate" in names
    assert "editor_get_state" in names
    assert not [n for n in names if n.startswith("mcp__")]


def test_mcp_tools_are_json_serializable_for_the_stdio_wire():
    payload = json.dumps({"tools": thedaw_mcp_tools()})

    # stdio framing is newline-delimited: a message MUST NOT contain a newline.
    assert "\n" not in payload


def test_mcp_tools_returns_an_independent_copy():
    first = thedaw_mcp_tools()
    first[0]["description"] = "mutated"

    assert thedaw_mcp_tools()[0]["description"] != "mutated"


# ---------------------------------------------------------------------------
# Malformed declarations must not kill the MCP child at import
# ---------------------------------------------------------------------------
def test_a_declaration_missing_parameters_gets_an_empty_object_schema(monkeypatch):
    monkeypatch.setattr(
        tool_catalog,
        "PROVIDER_TOOLS",
        [
            {
                "type": "function",
                "function": {"name": "half_written", "description": "wip"},
            }
        ],
    )

    tools = thedaw_mcp_tools()

    assert tools == [
        {
            "name": "half_written",
            "description": "wip",
            "inputSchema": {"type": "object", "properties": {}},
        }
    ]


def test_a_declaration_missing_a_description_gets_an_empty_string(monkeypatch):
    monkeypatch.setattr(
        tool_catalog,
        "PROVIDER_TOOLS",
        [
            {
                "type": "function",
                "function": {
                    "name": "undocumented",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ],
    )

    assert thedaw_mcp_tools()[0]["description"] == ""


def test_the_default_schema_is_not_shared_between_malformed_declarations(monkeypatch):
    """Two schema-less tools must not alias one mutable dict."""
    monkeypatch.setattr(
        tool_catalog,
        "PROVIDER_TOOLS",
        [
            {"type": "function", "function": {"name": "a"}},
            {"type": "function", "function": {"name": "b"}},
        ],
    )

    tools = thedaw_mcp_tools()
    tools[0]["inputSchema"]["properties"]["leaked"] = True

    assert tools[1]["inputSchema"] == {"type": "object", "properties": {}}
    assert thedaw_mcp_tools()[0]["inputSchema"] == {"type": "object", "properties": {}}
