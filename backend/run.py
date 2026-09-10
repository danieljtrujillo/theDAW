import logging
import os
import sys

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

import uvicorn  # noqa: E402 — after logging, on purpose
from backend.server import app  # noqa: E402

if __name__ == "__main__":
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8600,
        reload=False,
        log_level="info",
    )
