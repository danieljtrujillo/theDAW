"""
End-to-end tests for the stdio ``thedaw`` MCP server.

The server is spawned as a REAL subprocess (that is the only way to prove the
stdio framing) and pointed at a tiny fake relay HTTP server bound to a free port.
The full handshake is driven over stdin/stdout: ``initialize`` →
``notifications/initialized`` → ``tools/list`` → ``tools/call``.

Framing rules asserted here come from the MCP spec (basic/transports, stdio):
messages are newline-delimited, MUST NOT contain embedded newlines, and the
server MUST NOT write anything to stdout that is not a valid MCP message.
"""

import importlib.util
import json
import queue
import subprocess
import sys
import threading
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from backend.modules.assistant.tool_catalog import thedaw_mcp_tools

REPO_ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = REPO_ROOT / "backend" / "modules" / "assistant" / "thedaw_mcp_server.py"
RELAY_ID = "relay-under-test"
READ_TIMEOUT_S = 30


# ---------------------------------------------------------------------------
# Fake relay server
# ---------------------------------------------------------------------------
class FakeRelay:
    """Stands in for the FastAPI /api/mcp-relay/call endpoint.

    Records every request body and answers from a scripted reply table keyed by
    tool name (defaulting to a successful echo).
    """

    def __init__(self):
        self.requests = []
        self.replies = {}
        self.gates = {}
        self.default_reply = {"ok": True, "result": "ok"}
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 — BaseHTTPRequestHandler API
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length).decode("utf-8") if length else ""
                try:
                    body = json.loads(raw)
                except json.JSONDecodeError:
                    body = {"__unparsed__": raw}
                outer.requests.append({"path": self.path, "body": body})
                name = body.get("name")
                gate = outer.gates.get(name)
                if gate is not None:
                    gate.wait(timeout=READ_TIMEOUT_S)
                reply = outer.replies.get(name, outer.default_reply)
                payload = json.dumps(reply).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):  # keep pytest output clean
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def start(self):
        self._thread.start()
        return self

    def stop(self):
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


class McpChild:
    """The spawned stdio MCP server, with a line reader pump."""

    def __init__(self, port):
        self.proc = subprocess.Popen(
            [sys.executable, str(SERVER_PATH), str(port), RELAY_ID],
            cwd=str(REPO_ROOT),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self.stdout_lines = queue.Queue()
        self._pump = threading.Thread(target=self._read_stdout, daemon=True)
        self._pump.start()

    def _read_stdout(self):
        for line in self.proc.stdout:
            self.stdout_lines.put(line)
        self.stdout_lines.put(None)

    def send(self, message):
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def send_raw(self, text):
        self.proc.stdin.write(text)
        self.proc.stdin.flush()

    def read_line(self, timeout=READ_TIMEOUT_S):
        try:
            line = self.stdout_lines.get(timeout=timeout)
        except queue.Empty:
            pytest.fail(
                f"no stdout line within {timeout}s; stderr so far: {self.drain_stderr()}"
            )
        if line is None:
            pytest.fail(f"stdout closed; stderr: {self.drain_stderr()}")
        return line

    def read_message(self, timeout=READ_TIMEOUT_S):
        line = self.read_line(timeout)
        assert line.endswith("\n"), "stdio messages are newline-delimited"
        assert "\n" not in line[:-1], "a message MUST NOT contain embedded newlines"
        return json.loads(line)

    def expect_no_message(self, timeout=1.0):
        try:
            line = self.stdout_lines.get(timeout=timeout)
        except queue.Empty:
            return
        pytest.fail(f"expected silence on stdout, got: {line!r}")

    def drain_stderr(self):
        self.proc.stdin.close()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        return (self.proc.stderr.read() or "").strip()

    def close(self):
        try:
            if self.proc.stdin and not self.proc.stdin.closed:
                self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=5)
        for stream in (self.proc.stdout, self.proc.stderr):
            try:
                stream.close()
            except OSError:
                pass


@pytest.fixture
def relay():
    fake = FakeRelay().start()
    yield fake
    fake.stop()


@pytest.fixture
def child(relay):
    proc = McpChild(relay.port)
    yield proc
    proc.close()


def _initialize(child, protocol_version="2025-06-18", message_id=1):
    child.send(
        {
            "jsonrpc": "2.0",
            "id": message_id,
            "method": "initialize",
            "params": {
                "protocolVersion": protocol_version,
                "capabilities": {},
                "clientInfo": {"name": "pytest", "version": "1.0.0"},
            },
        }
    )
    return child.read_message()


def _handshake(child):
    response = _initialize(child)
    child.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
    return response


# ---------------------------------------------------------------------------
# initialize
# ---------------------------------------------------------------------------
def test_initialize_returns_a_wellformed_jsonrpc_result(child):
    response = _initialize(child)

    assert response["jsonrpc"] == "2.0"
    assert response["id"] == 1
    assert "error" not in response
    result = response["result"]
    assert result["serverInfo"]["name"] == "thedaw"
    assert isinstance(result["serverInfo"]["version"], str)
    assert "tools" in result["capabilities"]


def test_initialize_echoes_a_supported_protocol_version(child):
    """Spec: if the server supports the requested version it MUST echo it."""
    response = _initialize(child, protocol_version="2024-11-05")

    assert response["result"]["protocolVersion"] == "2024-11-05"


def test_initialize_falls_back_to_its_own_version_when_unsupported(child):
    """Spec: otherwise the server MUST answer with a version it does support."""
    response = _initialize(child, protocol_version="1999-01-01")

    version = response["result"]["protocolVersion"]
    assert version != "1999-01-01"
    assert version in {"2024-11-05", "2025-03-26", "2025-06-18"}


def test_initialize_without_params_still_answers(child):
    child.send({"jsonrpc": "2.0", "id": 7, "method": "initialize"})
    response = child.read_message()

    assert response["id"] == 7
    assert response["result"]["serverInfo"]["name"] == "thedaw"


# ---------------------------------------------------------------------------
# notifications / ping / unknown methods
# ---------------------------------------------------------------------------
def test_initialized_notification_gets_no_response(child):
    _initialize(child)
    child.send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    child.expect_no_message()


def test_notification_does_not_wedge_the_stream(child):
    _handshake(child)
    child.send({"jsonrpc": "2.0", "id": 2, "method": "ping"})
    response = child.read_message()

    assert response["id"] == 2
    assert response["result"] == {}


def test_unknown_method_returns_method_not_found(child):
    _handshake(child)
    child.send({"jsonrpc": "2.0", "id": 3, "method": "resources/list"})
    response = child.read_message()

    assert response["id"] == 3
    assert response["error"]["code"] == -32601


def test_unparsable_line_is_skipped_without_killing_the_server(child):
    _handshake(child)
    child.send_raw("this is not json\n")
    child.send({"jsonrpc": "2.0", "id": 4, "method": "ping"})
    response = child.read_message()

    assert response["id"] == 4


# ---------------------------------------------------------------------------
# tools/list
# ---------------------------------------------------------------------------
def test_tools_list_serves_the_shared_catalog(child):
    _handshake(child)
    child.send({"jsonrpc": "2.0", "id": 5, "method": "tools/list"})
    response = child.read_message()

    tools = response["result"]["tools"]
    expected = thedaw_mcp_tools()
    assert tools == expected
    assert [t["name"] for t in tools][:1] == ["navigate"]
    for tool in tools:
        assert set(tool) == {"name", "description", "inputSchema"}
        assert not tool["name"].startswith("mcp__")


# ---------------------------------------------------------------------------
# tools/call
# ---------------------------------------------------------------------------
def test_tools_call_posts_the_c2_body_to_the_relay(child, relay):
    _handshake(child)
    child.send(
        {
            "jsonrpc": "2.0",
            "id": 6,
            "method": "tools/call",
            "params": {"name": "navigate", "arguments": {"tab": "edit"}},
        }
    )
    child.read_message()

    assert len(relay.requests) == 1
    request = relay.requests[0]
    assert request["path"] == "/api/mcp-relay/call"
    assert request["body"] == {
        "sessionId": RELAY_ID,
        "name": "navigate",
        "args": {"tab": "edit"},
    }


def test_tools_call_returns_the_relay_result_as_text_content(child, relay):
    relay.replies["navigate"] = {"ok": True, "result": "now on EDIT"}
    _handshake(child)
    child.send(
        {
            "jsonrpc": "2.0",
            "id": 6,
            "method": "tools/call",
            "params": {"name": "navigate", "arguments": {"tab": "edit"}},
        }
    )
    response = child.read_message()

    assert response["id"] == 6
    assert "error" not in response
    assert response["result"]["content"] == [{"type": "text", "text": "now on EDIT"}]
    assert response["result"]["isError"] is False


def test_tools_call_without_arguments_relays_an_empty_object(child, relay):
    _handshake(child)
    child.send(
        {
            "jsonrpc": "2.0",
            "id": 6,
            "method": "tools/call",
            "params": {"name": "get_status"},
        }
    )
    child.read_message()

    assert relay.requests[0]["body"]["args"] == {}


def test_relay_error_becomes_a_tool_execution_error_not_a_protocol_error(child, relay):
    """Spec: tool failures ride back as isError:true so the model sees them."""
    relay.replies["generate"] = {"ok": False, "error": "no model loaded"}
    _handshake(child)
    child.send(
        {
            "jsonrpc": "2.0",
            "id": 8,
            "method": "tools/call",
            "params": {"name": "generate", "arguments": {}},
        }
    )
    response = child.read_message()

    assert "error" not in response
    assert response["result"]["isError"] is True
    assert "no model loaded" in response["result"]["content"][0]["text"]


def test_unknown_tool_is_a_protocol_error(child):
    _handshake(child)
    child.send(
        {
            "jsonrpc": "2.0",
            "id": 9,
            "method": "tools/call",
            "params": {"name": "definitely_not_a_tool", "arguments": {}},
        }
    )
    response = child.read_message()

    assert response["error"]["code"] == -32602
    assert "definitely_not_a_tool" in response["error"]["message"]


def test_tools_call_without_a_name_is_a_protocol_error(child):
    _handshake(child)
    child.send({"jsonrpc": "2.0", "id": 10, "method": "tools/call", "params": {}})
    response = child.read_message()

    assert response["error"]["code"] == -32602


def test_multiline_relay_result_stays_a_single_stdio_message(child, relay):
    relay.replies["editor_get_state"] = {"ok": True, "result": "line one\nline two"}
    _handshake(child)
    child.send(
        {
            "jsonrpc": "2.0",
            "id": 11,
            "method": "tools/call",
            "params": {"name": "editor_get_state", "arguments": {}},
        }
    )
    response = child.read_message()  # asserts the single-line framing itself

    assert response["result"]["content"][0]["text"] == "line one\nline two"


def test_a_slow_tool_call_does_not_block_other_messages(child, relay):
    """The CLI pings and lists while a browser round-trip is in flight."""
    gate = threading.Event()
    relay.gates["generate"] = gate
    relay.replies["generate"] = {"ok": True, "result": "rendered"}

    _handshake(child)
    child.send(
        {
            "jsonrpc": "2.0",
            "id": 12,
            "method": "tools/call",
            "params": {"name": "generate", "arguments": {}},
        }
    )
    child.send({"jsonrpc": "2.0", "id": 13, "method": "ping"})

    ping = child.read_message()
    assert ping["id"] == 13, "ping must answer while the tool call is still pending"

    gate.set()
    call = child.read_message()
    assert call["id"] == 12
    assert call["result"]["content"][0]["text"] == "rendered"


# ---------------------------------------------------------------------------
# Relay transport failures
# ---------------------------------------------------------------------------
def _load_server_module(port):
    """Import the server in-process with a controlled argv (it reads argv at import)."""
    saved_argv = sys.argv
    sys.argv = [str(SERVER_PATH), str(port), RELAY_ID]
    try:
        spec = importlib.util.spec_from_file_location(
            "thedaw_mcp_server_under_test", SERVER_PATH
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.argv = saved_argv


def test_an_unreachable_backend_becomes_a_tool_error(child, relay):
    """The relay port can die mid-session; the model must see why."""
    relay.stop()  # the backend is gone, the child is still up
    _handshake(child)
    child.send(
        {
            "jsonrpc": "2.0",
            "id": 17,
            "method": "tools/call",
            "params": {"name": "get_status", "arguments": {}},
        }
    )
    response = child.read_message()

    assert response["result"]["isError"] is True
    assert "relay" in response["result"]["content"][0]["text"].lower()


def test_a_socket_timeout_is_reported_as_a_timeout_not_as_unreachable(monkeypatch):
    module = _load_server_module(1)

    def fake_urlopen(*_args, **_kwargs):
        raise urllib.error.URLError(TimeoutError("timed out"))

    # monkeypatch: module.urllib is the process-wide urllib, and a bare
    # assignment left every later test in the run talking to this fake.
    monkeypatch.setattr(module.urllib.request, "urlopen", fake_urlopen)
    payload = module.relay_call("generate", {})

    assert payload["ok"] is False
    assert "timed out after 120s" in payload["error"]
    assert "unreachable" not in payload["error"]


def test_a_nonjson_relay_body_is_reported_rather_than_raised(monkeypatch):
    module = _load_server_module(1)

    class FakeResponse:
        def read(self):
            return b"<html>502</html>"

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

    monkeypatch.setattr(
        module.urllib.request, "urlopen", lambda *_a, **_k: FakeResponse()
    )
    payload = module.relay_call("generate", {})

    assert payload["ok"] is False
    assert "invalid relay response" in payload["error"]


# ---------------------------------------------------------------------------
# stdout hygiene
# ---------------------------------------------------------------------------
def test_stdout_carries_only_protocol_messages(child, relay):
    _handshake(child)
    child.send({"jsonrpc": "2.0", "id": 14, "method": "tools/list"})
    child.read_message()
    child.send(
        {
            "jsonrpc": "2.0",
            "id": 15,
            "method": "tools/call",
            "params": {"name": "get_status", "arguments": {}},
        }
    )
    child.read_message()
    child.send_raw("garbage\n")
    child.send({"jsonrpc": "2.0", "id": 16, "method": "ping"})
    child.read_message()

    child.expect_no_message()
