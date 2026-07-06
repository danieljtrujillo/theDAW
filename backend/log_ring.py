"""In-memory ring buffer of recent backend log records for the LOG panel.

The frontend LOG panel used to show only frontend-emitted events, so VERBOSE
mode revealed nothing about the backend. This attaches a bounded handler to the
root logger and exposes the captured records at GET /api/log so the panel can
stream real backend activity (module loads, sidecar output, warnings, errors,
tracebacks). Purely in-memory; nothing is persisted, and the per-request access
log is skipped to keep the panel readable.
"""

from __future__ import annotations

import logging
from collections import deque
from threading import Lock

_MAX = 2000
_lock = Lock()
_ring: deque[dict] = deque(maxlen=_MAX)
_seq = 0
_handler: logging.Handler | None = None

_LEVEL_MAP = {
    "DEBUG": "debug",
    "INFO": "info",
    "WARNING": "warn",
    "ERROR": "error",
    "CRITICAL": "error",
}


class _RingHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        # The access log is one line per HTTP request; too noisy for the panel.
        if record.name.startswith("uvicorn.access"):
            return
        global _seq
        try:
            msg = record.getMessage()
        except Exception:
            msg = str(record.msg)
        if record.exc_info:
            try:
                fmt = self.formatter or logging.Formatter()
                msg = f"{msg}\n{fmt.formatException(record.exc_info)}"
            except Exception:
                pass
        with _lock:
            _seq += 1
            _ring.append(
                {
                    "seq": _seq,
                    "ts": record.created * 1000.0,
                    "level": _LEVEL_MAP.get(record.levelname, "info"),
                    "source": record.name,
                    "msg": msg,
                }
            )


def install_log_ring(level: int = logging.INFO) -> None:
    """Attach the ring handler, re-attaching if a logging reconfiguration
    (e.g. uvicorn startup) dropped it. Idempotent (no duplicate handler).
    Attaches to BOTH the root logger and the "uvicorn" logger: uvicorn's
    default config sets propagate=False on its loggers, so ASGI exception
    tracebacks (uvicorn.error) never reach root — exactly the records the
    LOG panel exists for. Lowers levels to ``level`` only if higher."""
    global _handler
    if _handler is None:
        _handler = _RingHandler()
        _handler.setLevel(logging.DEBUG)
    for logger_name in ("", "uvicorn"):
        target = logging.getLogger(logger_name)
        if target.level == logging.NOTSET or target.level > level:
            if logger_name == "":
                target.setLevel(level)
        if _handler not in target.handlers:
            target.addHandler(_handler)


def read_since(since_seq: int = 0, limit: int = 1000) -> dict:
    """Return records with seq > ``since_seq`` (or the tail when 0), plus the
    cursor the caller should poll from next. When the page is truncated by
    ``limit`` the cursor is the LAST RETURNED record's seq (not the global
    max), so a burst larger than one page is paged through instead of the
    gap being silently skipped."""
    with _lock:
        if since_seq <= 0:
            entries = list(_ring)[-limit:]
        else:
            entries = [e for e in _ring if e["seq"] > since_seq][:limit]
        cursor = entries[-1]["seq"] if entries else _seq
        return {"seq": cursor, "entries": entries}
