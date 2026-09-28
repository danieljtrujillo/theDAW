"""
Scripted stand-in for the ``claude`` CLI used by the persistent-session tests.

Speaks the same NDJSON protocol as ``claude -p --input-format stream-json
--output-format stream-json``: one ``system``/``init`` line at startup, then a
scripted reply per ``{"type":"user",...}`` line read from stdin. stdin is never
closed by us, so a single child serves many turns — which is exactly the
property ``backend/modules/assistant/claude_session.py`` has to preserve.

Driven by two environment variables:

``FAKE_CLI_MODE``
    ``basic``        one text delta + one ``result`` per turn.
    ``stale_first``  like ``basic``, but the FIRST turn emits its ``result``
                     TWICE in a single write (the stale-result drain case).
    ``control``      emits a ``can_use_tool`` control_request per turn and
                     blocks until a ``control_response`` arrives, then replies.
    ``silent``       emits ``init`` and then nothing at all (stall watchdog).
    ``chatty``       six text deltas 0.1s apart, then a ``result`` — long, but
                     never silent, so an inactivity watchdog must NOT fire.
    ``until_interrupt`` one text delta, then the turn stays open until an
                     ``interrupt`` control_request ends it with a ``result``,
                     as the real CLI does. Every engine-initiated
                     control_request gets a success ``control_response``.

``FAKE_CLI_LOG``
    Optional path; every raw stdin line is appended verbatim, one per line, so
    a test can assert on the EXACT JSON the session engine wrote.
"""

import json
import os
import sys
import time
import uuid

MODE = os.environ.get("FAKE_CLI_MODE", "basic")
LOG_PATH = os.environ.get("FAKE_CLI_LOG", "")
SESSION_ID = os.environ.get("FAKE_CLI_SESSION_ID") or str(uuid.uuid4())


def log_line(raw: str) -> None:
    """Append one raw stdin line to FAKE_CLI_LOG, if configured."""
    if not LOG_PATH:
        return
    with open(LOG_PATH, "a", encoding="utf-8") as handle:
        handle.write(raw + "\n")


def emit(*objects: dict) -> None:
    """Write one or more NDJSON lines in a SINGLE flush (ordering matters)."""
    payload = "".join(json.dumps(obj) + "\n" for obj in objects)
    sys.stdout.write(payload)
    sys.stdout.flush()


def result_event(turn: int) -> dict:
    return {
        "type": "result",
        "subtype": "success",
        "session_id": SESSION_ID,
        "is_error": False,
        "num_turns": turn,
        "duration_ms": 12,
        "total_cost_usd": 0.0001,
        "usage": {
            "input_tokens": 11,
            "output_tokens": 22,
            "cache_read_input_tokens": 3,
            "cache_creation_input_tokens": 4,
        },
    }


def text_event(text: str) -> dict:
    return {
        "type": "content_block_delta",
        "delta": {"type": "text_delta", "text": text},
    }


def main() -> int:
    sys.stdout.reconfigure(newline="\n")
    emit(
        {
            "type": "system",
            "subtype": "init",
            "session_id": SESSION_ID,
            "model": "fake-model",
            "tools": ["Read"],
            "mcp_servers": [{"name": "thedaw", "status": "connected"}],
        }
    )

    turn = 0
    awaiting_control = False
    turn_open = False

    for raw in iter(sys.stdin.readline, ""):
        line = raw.strip()
        if not line:
            continue
        log_line(line)
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = data.get("type")

        if kind == "control_response":
            if not awaiting_control:
                continue
            awaiting_control = False
            emit(text_event("approved"), result_event(turn))
            continue

        if kind == "control_request":
            # An interrupt (or any engine-initiated control request). Stay
            # alive and keep waiting — the child must survive an interrupt.
            if MODE == "until_interrupt":
                request = data.get("request") or {}
                emit(
                    {
                        "type": "control_response",
                        "response": {
                            "subtype": "success",
                            "request_id": data.get("request_id"),
                            "response": {},
                        },
                    }
                )
                if request.get("subtype") == "interrupt" and turn_open:
                    turn_open = False
                    emit(result_event(turn))
            continue

        if kind != "user":
            continue

        turn += 1
        if MODE == "silent":
            continue
        if MODE == "control":
            awaiting_control = True
            emit(
                {
                    "type": "control_request",
                    "request_id": f"req_{turn}",
                    "request": {
                        "subtype": "can_use_tool",
                        "tool_name": "Bash",
                        "input": {"command": "echo hi"},
                    },
                }
            )
            continue
        if MODE == "until_interrupt":
            turn_open = True
            emit(text_event("working "))
            continue
        if MODE == "chatty":
            for index in range(6):
                emit(text_event(f"chunk{index} "))
                time.sleep(0.1)
            emit(result_event(turn))
            continue
        if MODE == "stale_first" and turn == 1:
            # Both results in ONE write: the second is stale and must be
            # drained without pushing the result FIFO past the turn counter.
            emit(text_event("hello"), result_event(turn), result_event(turn))
            continue
        emit(text_event("hello"), result_event(turn))

    return 0


if __name__ == "__main__":
    sys.exit(main())
