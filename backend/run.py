import logging
import os
import sys
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _configure_logging() -> None:
    """Send the app's own log lines to stderr, where the Electron shell and
    theDAW.bat already capture the backend's output.

    Uvicorn configures ITS loggers and nothing else, so with no root handler
    every ``logger.info`` in backend/ — the startup timings, "Loaded module",
    and the loader's "Module X failed to load" — went nowhere. That is how a
    module with a SyntaxError sat unmounted for three days while its tab
    404'd. Configured before ``backend.server`` is imported, because the
    module loader runs at import time.
    """
    root = logging.getLogger()
    if root.handlers:
        return
    level = os.getenv("THEDAW_LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    # Chatty third parties stay at WARNING; the app's own modules at INFO.
    for noisy in ("httpx", "httpcore", "urllib3", "numba", "filelock"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


_configure_logging()

from backend.ports import BACKEND_PORT, describe_occupant  # noqa: E402

# Exit code for "the port was already taken". Distinct from the supervisor's
# 88 (restart) and 89 (update), both of which respawn — this one must not, and
# backend/_supervisor.py terminates on any other code.
PORT_IN_USE_EXIT_CODE = 90


def _preflight_port() -> Optional[str]:
    """Whoever already holds the backend port, described in a sentence.

    Without this the failure surfaced as uvicorn's raw socket error:

        ERROR: [Errno 10048] error while attempting to bind on address
        ('0.0.0.0', 8600): only one usage of each socket address ... permitted

    which tells a user nothing about what to close. It was worse through a
    launcher: the Pinokio start script scrapes the child's output for a
    "Uvicorn running on" line, so on a clash it matched nothing useful and
    reported the whole failure as the event ``["Errno "]``.

    Checked BEFORE the bind so the message is the first and only thing printed,
    and so importing the app is not wasted when it cannot serve anyway.
    """
    return describe_occupant(BACKEND_PORT)


if __name__ == "__main__":
    # BEFORE importing the app. Importing backend.server mounts every module
    # and opens the library DB, so doing it first would spend seconds of work
    # and touch the database of the instance already running, only to exit.
    occupant = _preflight_port()
    if occupant is not None:
        print(f"theDAW cannot start: {occupant}", file=sys.stderr, flush=True)
        logging.getLogger("backend.run").error(
            "port %d unavailable: %s", BACKEND_PORT, occupant
        )
        sys.exit(PORT_IN_USE_EXIT_CODE)

    import uvicorn

    from backend.server import app

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=BACKEND_PORT,
        reload=False,
        log_level="info",
    )
