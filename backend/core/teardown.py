"""Best-effort teardown of every child process the backend may have spawned.

The Shutdown/Restart buttons exit via ``os._exit`` (atexit handlers hang on
uvicorn shutdown when invoked from a request thread), which used to orphan
every running sidecar: the VJ/Foundry node servers, the stems python process,
questcast/akvj helpers, and the underfit dashboard all stayed resident holding
their ports. This module gives both the lifespan shutdown and the admin exit
paths one place that stops them all, swallowing every failure — teardown must
never block or break process exit.
"""

from __future__ import annotations

import logging

log = logging.getLogger(__name__)


def stop_all_sidecars() -> None:
    """Stop every known sidecar, best-effort. Safe to call multiple times,
    from any thread; never raises."""
    # (import path, callable name, needs get_sidecar() instance)
    targets = [
        ("backend.modules.vj.sidecar", "stop", False),
        ("backend.modules.lyria.sidecar", "stop", False),
        ("backend.modules.foundry.sidecar", "stop", False),
        ("backend.modules.underfit.sidecar", "stop", False),
        ("backend.modules.magenta.sidecar", "stop_engine", False),
        ("backend.modules.stems.sidecar", "stop", True),
        ("backend.modules.questcast.sidecar", "stop", True),
        ("backend.modules.akvj.sidecar", "stop", True),
    ]
    for module_path, fn_name, needs_instance in targets:
        try:
            module = __import__(module_path, fromlist=[fn_name, "get_sidecar"])
            target = module.get_sidecar() if needs_instance else module
            getattr(target, fn_name)()
        except Exception:  # noqa: BLE001 — teardown must never break exit
            log.debug("teardown: %s.%s failed", module_path, fn_name, exc_info=True)
