"""
MCP relay — the bridge between the Claude Code CLI and the browser.

Flow (contract C2 of ``orchestration/plans/P-20260915-bcc-assistant.md``)::

    claude CLI  --stdio-->  thedaw_mcp_server.py
                            |  POST /api/mcp-relay/call {sessionId,name,args}
                            v
                        RelayRegistry.push_client_tool_call
                            |  SSE frame {type:"client_tool_call",sessionId,callId,name,args}
                            v
                          browser (orb-kit actionHandlers)
                            |  POST /api/mcp-relay/result {sessionId,callId,result}
                            v
                        RelayRegistry.resolve  -> the awaiting call returns

A session is registered under its ``relay_id`` (minted when the persistent Claude
child is spawned) and aliased under every Claude ``session_id`` the CLI reports,
because the browser posts results keyed by ``session_id`` while the stdio child
posts calls keyed by ``relay_id``. Both keys must reach the SAME channel or every
tool call times out.

Timeouts are asymmetric ON PURPOSE. The server-side waiter (115s) is strictly
below the stdio child's socket timeout (120s) so that on a genuine non-response
the server answers FIRST; if they were equal the child could destroy the socket
the instant the server tried to write to it.

Execution-boundary rules (both endpoints):

* ``sessionId`` must be a registered relay id or alias — otherwise nothing is
  pushed and nothing is resolved.
* ``callId`` must be pending FOR THAT session — a result cannot be redirected
  into another conversation's pending call, and a replayed result is ignored.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any, Callable, Optional

from fastapi import APIRouter, Body

from .tool_catalog import thedaw_mcp_tools

__all__ = [
    "RELAY_CLIENT_TIMEOUT_MS",
    "RELAY_SERVER_TIMEOUT_MS",
    "RelayError",
    "RelayRegistry",
    "RelaySession",
    "registry",
    "router",
    "thedaw_mcp_tools",
]

log = logging.getLogger(__name__)

# Server-side waiter for POST /api/mcp-relay/call. Kept STRICTLY below the stdio
# child's socket timeout so the server always resolves first.
RELAY_SERVER_TIMEOUT_MS = 115_000
# Socket timeout used by thedaw_mcp_server.py for the same round trip. A single
# browser tool round-trip may legitimately be slow (a big editor_get_state, a
# render), but it never bounds a whole turn — the child lives for the session.
RELAY_CLIENT_TIMEOUT_MS = 120_000

# A frame writer: called with the SSE frame dict. Whoever owns the live response
# supplies it and is responsible for serializing/writing it. ``None`` means the
# session currently has NO live SSE channel (between turns, or after close).
FrameWriter = Callable[[dict[str, Any]], None]


class RelayError(RuntimeError):
    """A tool call could not be delivered, or came back as an error."""


class RelaySession:
    """One conversation's relay channel: a frame writer plus its pending calls."""

    __slots__ = ("relay_id", "writer", "pending", "aliases")

    def __init__(self, relay_id: str, writer: Optional[FrameWriter]) -> None:
        self.relay_id = relay_id
        self.writer = writer
        self.pending: dict[str, asyncio.Future] = {}
        self.aliases: set[str] = set()


class RelayRegistry:
    """Active relay sessions keyed by relay id and by aliased Claude session ids."""

    def __init__(self, server_timeout_ms: int = RELAY_SERVER_TIMEOUT_MS) -> None:
        self._sessions: dict[str, RelaySession] = {}
        self._server_timeout_ms = server_timeout_ms

    # -- lifecycle ---------------------------------------------------------
    def register(
        self, relay_id: str, writer: Optional[FrameWriter] = None
    ) -> RelaySession:
        """Register (or re-register) ``relay_id`` and point it at ``writer``."""
        session = self._sessions.get(relay_id)
        if session is None:
            session = RelaySession(relay_id, writer)
            self._sessions[relay_id] = session
        else:
            session.writer = writer
        return session

    def alias(self, relay_id: str, session_id: str) -> None:
        """Make ``session_id`` resolve to the same channel as ``relay_id``."""
        session = self._sessions.get(relay_id)
        if session is None:
            log.warning("mcp-relay: cannot alias unknown relay %s", relay_id)
            return
        if session_id == relay_id or session_id in session.aliases:
            return
        session.aliases.add(session_id)
        self._sessions[session_id] = session

    def set_writer(self, session_key: str, writer: Optional[FrameWriter]) -> None:
        """Re-point a session's channel at the current turn's response (or detach)."""
        session = self._sessions.get(session_key)
        if session is None:
            log.warning(
                "mcp-relay: cannot set writer for unknown session %s", session_key
            )
            return
        session.writer = writer

    def get(self, session_key: str) -> Optional[RelaySession]:
        return self._sessions.get(session_key)

    def unregister(self, session_key: str) -> None:
        """Drop a session: fail every call still waiting, then remove all its keys."""
        session = self._sessions.get(session_key)
        if session is None:
            return
        session.writer = None
        for call_id, future in list(session.pending.items()):
            session.pending.pop(call_id, None)
            if not future.done():
                future.set_exception(
                    RelayError(f"relay session {session.relay_id} closed mid-call")
                )
        self._sessions.pop(session.relay_id, None)
        for alias in session.aliases:
            self._sessions.pop(alias, None)
        session.aliases.clear()

    # -- call / result -----------------------------------------------------
    async def push_client_tool_call(
        self, session_key: str, name: str, args: Optional[dict[str, Any]] = None
    ) -> str:
        """Push a ``client_tool_call`` frame and await the browser's result.

        The frame carries ``sessionId`` — the key the caller pushed under, which
        may be a Claude ``session_id`` alias — so the browser can echo it back to
        ``POST /api/mcp-relay/result`` verbatim instead of guessing which of its
        conversations the call belongs to.

        Returns the browser's result string. Raises :class:`RelayError` if the
        session is unknown, has no live SSE, the write fails, the browser reports
        an error, or the server-side timeout elapses first.
        """
        session = self._sessions.get(session_key)
        if session is None:
            raise RelayError(f"no active relay session for {session_key!r}")
        writer = session.writer
        if writer is None:
            raise RelayError(
                f"relay session {session_key!r} has no live SSE channel right now"
            )

        call_id = f"tc_{uuid.uuid4().hex[:12]}"
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        session.pending[call_id] = future
        frame = {
            "type": "client_tool_call",
            "sessionId": session_key,
            "callId": call_id,
            "name": name,
            "args": args or {},
        }
        try:
            writer(frame)
        except Exception as exc:  # closed/broken SSE — never leave a pending entry
            session.pending.pop(call_id, None)
            raise RelayError(f"failed to relay tool call {name!r}: {exc}") from exc

        timeout_s = self._server_timeout_ms / 1000
        try:
            return await asyncio.wait_for(future, timeout=timeout_s)
        except asyncio.TimeoutError:
            raise RelayError(
                f"tool call {name!r} timed out after {round(timeout_s)}s "
                "waiting for the browser"
            ) from None
        finally:
            session.pending.pop(call_id, None)

    def resolve(
        self, session_key: str, call_id: str, result: str, is_error: bool = False
    ) -> bool:
        """Resolve a pending call. Returns False when there is nothing to resolve.

        A result is only accepted when ``call_id`` is pending for THIS session;
        unknown sessions, unknown calls, and replayed results are ignored.
        """
        session = self._sessions.get(session_key)
        if session is None:
            log.warning("mcp-relay: result for unknown session %s", session_key)
            return False
        future = session.pending.get(call_id)
        if future is None:
            log.warning(
                "mcp-relay: result for unknown call %s on session %s",
                call_id,
                session_key,
            )
            return False
        session.pending.pop(call_id, None)
        if future.done():
            return False
        if is_error:
            future.set_exception(RelayError(result))
        else:
            future.set_result(result)
        return True


# Process-wide registry. The Claude session owner (T01/T07) registers/aliases and
# re-points the writer per turn; the routes below only read it.
registry = RelayRegistry()

router = APIRouter(prefix="/api/mcp-relay", tags=["assistant-mcp-relay"])


@router.post("/call")
async def mcp_relay_call(payload: dict[str, Any] = Body(default_factory=dict)):
    """Relay an MCP tool call to the browser and block on its result (C2)."""
    session_id = payload.get("sessionId")
    name = payload.get("name")
    args = payload.get("args") or {}
    if not isinstance(session_id, str) or not session_id:
        return {"ok": False, "error": "sessionId is required"}
    if not isinstance(name, str) or not name:
        return {"ok": False, "error": "name is required"}
    if not isinstance(args, dict):
        return {"ok": False, "error": "args must be an object"}
    try:
        result = await registry.push_client_tool_call(session_id, name, args)
    except RelayError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:  # never leak a traceback onto the MCP wire
        log.exception("mcp-relay: call %s failed", name)
        return {"ok": False, "error": f"relay failure: {exc}"}
    return {"ok": True, "result": result}


@router.post("/result")
async def mcp_relay_result(payload: dict[str, Any] = Body(default_factory=dict)):
    """Accept the browser's result for a pending ``client_tool_call`` (C2)."""
    session_id = payload.get("sessionId")
    call_id = payload.get("callId")
    result = payload.get("result")
    is_error = bool(payload.get("isError"))
    if not isinstance(session_id, str) or not session_id:
        return {"ok": False, "error": "sessionId is required"}
    if not isinstance(call_id, str) or not call_id:
        return {"ok": False, "error": "callId is required"}
    if result is None:
        result = ""
    elif not isinstance(result, str):
        return {"ok": False, "error": "result must be a string"}
    if not registry.resolve(session_id, call_id, result, is_error):
        return {"ok": False, "error": "no pending call for that session"}
    return {"ok": True}
