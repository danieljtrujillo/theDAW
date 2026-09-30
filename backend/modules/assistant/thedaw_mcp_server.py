#!/usr/bin/env python
"""
theDAW — stdio MCP server (JSON-RPC 2.0 over stdin/stdout).

The Claude Code CLI spawns this file as a subprocess and speaks the Model Context
Protocol to it. Tool calls are relayed over HTTP to theDAW's FastAPI backend,
which forwards them to the connected browser (the thing that actually mutates the
DAW) and answers once the browser responds::

    claude CLI --stdio--> this file --HTTP--> /api/mcp-relay/call --SSE--> browser

Usage::

    python backend/modules/assistant/thedaw_mcp_server.py <PORT> <RELAY_ID>

stdio framing (MCP spec, basic/transports §stdio): messages are UTF-8,
newline-delimited, and MUST NOT contain embedded newlines. stdout is reserved
EXCLUSIVELY for protocol messages — every diagnostic goes to stderr, or the
JSON-RPC stream is corrupted.

Stdlib only, by design: this child must boot instantly and must not drag the
backend's dependency tree (torch et al.) into a per-session subprocess.
"""

from __future__ import annotations

import json
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

# Spawned by path, so the repo root is not on sys.path yet. Both packages on the
# way to the catalog have empty __init__.py files, so this import is cheap.
_REPO_ROOT = Path(__file__).resolve().parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from backend.modules.assistant.tool_catalog import thedaw_mcp_tools  # noqa: E402

SERVER_NAME = "thedaw"
SERVER_VERSION = "1.0.0"

# Protocol revisions this server speaks. The spec says: echo the client's version
# when we support it, otherwise answer with one we do support (the latest).
SUPPORTED_PROTOCOL_VERSIONS = ("2024-11-05", "2025-03-26", "2025-06-18")
LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[-1]

# Socket timeout for one browser round trip. Deliberately ABOVE the backend's
# own waiter (mcp_relay.RELAY_SERVER_TIMEOUT_MS = 115_000) so the server always
# answers first on a genuine non-response instead of us tearing the socket down
# underneath it. Duplicated as a literal because this process must not import
# FastAPI. Keep the two in sync.
RELAY_TIMEOUT_MS = 120_000

PORT = sys.argv[1] if len(sys.argv) > 1 else ""
RELAY_ID = sys.argv[2] if len(sys.argv) > 2 else ""

_TOOLS = thedaw_mcp_tools()
_TOOL_NAMES = {tool["name"] for tool in _TOOLS}

_stdout_lock = threading.Lock()


def log(*parts: object) -> None:
    """Diagnostics — stderr ONLY (stdout belongs to the protocol)."""
    try:
        sys.stderr.write("[thedaw mcp] " + " ".join(str(p) for p in parts) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def send(message: dict) -> None:
    """Write one JSON-RPC message as a single newline-delimited line."""
    # ensure_ascii keeps the payload single-line and 7-bit safe on the pipe; the
    # dumps output itself never contains a raw newline.
    line = json.dumps(message, ensure_ascii=True) + "\n"
    with _stdout_lock:
        sys.stdout.write(line)
        sys.stdout.flush()


def send_result(message_id: object, result: dict) -> None:
    send({"jsonrpc": "2.0", "id": message_id, "result": result})


def send_error(message_id: object, code: int, message: str) -> None:
    send(
        {
            "jsonrpc": "2.0",
            "id": message_id,
            "error": {"code": code, "message": message},
        }
    )


# ---------------------------------------------------------------------------
# HTTP relay -> backend -> browser
# ---------------------------------------------------------------------------
def _timeout_error(name: str) -> str:
    return f"relay timed out after {RELAY_TIMEOUT_MS // 1000}s for tool {name!r}"


def relay_call(name: str, args: dict) -> dict:
    """POST /api/mcp-relay/call and return the decoded ``{ok, result|error}``."""
    body = json.dumps({"sessionId": RELAY_ID, "name": name, "args": args}).encode(
        "utf-8"
    )
    request = urllib.request.Request(
        f"http://127.0.0.1:{PORT}/api/mcp-relay/call",
        data=body,
        headers={"Content-Type": "application/json", "Content-Length": str(len(body))},
        method="POST",
    )
    try:
        with urllib.request.urlopen(
            request, timeout=RELAY_TIMEOUT_MS / 1000
        ) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8")[:200]
        except Exception:
            pass
        return {"ok": False, "error": f"relay HTTP {exc.code}: {detail or exc.reason}"}
    except urllib.error.URLError as exc:
        # urlopen wraps a socket timeout in URLError, so check before reporting
        # it as an unreachable backend.
        if isinstance(exc.reason, TimeoutError):
            return {"ok": False, "error": _timeout_error(name)}
        return {"ok": False, "error": f"relay unreachable on port {PORT}: {exc.reason}"}
    except TimeoutError:
        return {"ok": False, "error": _timeout_error(name)}
    except Exception as exc:
        return {"ok": False, "error": f"relay call failed: {exc}"}

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return {"ok": False, "error": f"invalid relay response: {raw[:200]}"}
    if not isinstance(payload, dict):
        return {"ok": False, "error": f"invalid relay response: {raw[:200]}"}
    return payload


def _as_text(value: object) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(value)


# ---------------------------------------------------------------------------
# JSON-RPC dispatch
# ---------------------------------------------------------------------------
def handle_initialize(message: dict) -> None:
    params = message.get("params") or {}
    requested = params.get("protocolVersion")
    version = (
        requested
        if requested in SUPPORTED_PROTOCOL_VERSIONS
        else LATEST_PROTOCOL_VERSION
    )
    send_result(
        message["id"],
        {
            "protocolVersion": version,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        },
    )


def handle_tools_call(message: dict) -> None:
    message_id = message["id"]
    params = message.get("params") or {}
    name = params.get("name")
    args = params.get("arguments")
    if not isinstance(name, str) or not name:
        send_error(message_id, -32602, "tools/call requires params.name")
        return
    if name not in _TOOL_NAMES:
        send_error(message_id, -32602, f"Unknown tool: {name}")
        return
    if args is None:
        args = {}
    if not isinstance(args, dict):
        send_error(
            message_id, -32602, f"tools/call arguments for {name} must be an object"
        )
        return

    payload = relay_call(name, args)
    if payload.get("ok"):
        text = _as_text(payload.get("result"))
        is_error = False
    else:
        text = _as_text(payload.get("error")) or "tool call failed"
        is_error = True
        log(f"tool {name} failed: {text[:300]}")
    send_result(
        message_id, {"content": [{"type": "text", "text": text}], "isError": is_error}
    )


def handle_message(message: dict) -> None:
    message_id = message.get("id")
    method = message.get("method")

    # Notifications carry no id and MUST NOT be answered.
    if message_id is None:
        if not isinstance(method, str):
            log("ignoring id-less message with no method")
        return

    if method == "initialize":
        handle_initialize(message)
    elif method == "ping":
        send_result(message_id, {})
    elif method == "tools/list":
        send_result(message_id, {"tools": _TOOLS})
    elif method == "tools/call":
        handle_tools_call(message)
    else:
        send_error(message_id, -32601, f"Method not found: {method}")


def dispatch(message: dict) -> None:
    try:
        handle_message(message)
    except Exception as exc:  # a handler crash must never kill the stream
        log("handler error:", repr(exc))
        message_id = message.get("id")
        if message_id is not None:
            try:
                send_error(message_id, -32603, f"Internal error: {exc}")
            except Exception:
                pass


def main() -> int:
    if not PORT or not RELAY_ID:
        log("usage: thedaw_mcp_server.py <PORT> <RELAY_ID>")
        return 2
    log(f"ready — {len(_TOOLS)} tools, relay=127.0.0.1:{PORT} session={RELAY_ID}")

    # Each request runs on its own thread so a 120s browser round trip does not
    # stall pings / tools/list / other tool calls the CLI issues meanwhile.
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            log("failed to parse line:", line[:200])
            continue
        if not isinstance(message, dict):
            log("ignoring non-object message:", line[:200])
            continue
        threading.Thread(target=dispatch, args=(message,), daemon=True).start()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
