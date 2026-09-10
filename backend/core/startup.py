"""Startup hooks for backend modules, run from the app lifespan.

Modules used to hang work off ``@router.on_event("startup")``. FastAPI
deprecated on_event in favour of lifespan handlers, and a router mounted by
``load_modules`` has no lifespan of its own that the app would ever run — so
this is the one place a module registers what it needs done once the app is
starting, and ``server._on_startup`` runs the lot. It mirrors core/teardown.py,
which already plays the shutdown half: every sidecar a module might spawn is
stopped there, so a module needs no shutdown hook of its own.

Hooks are best-effort — one that fails is logged and the rest still run — and
must not block: the underfit dashboard spawn, for instance, hands off to a
daemon thread and returns.
"""

from __future__ import annotations

import logging
from typing import Callable

log = logging.getLogger(__name__)

_hooks: list[tuple[str, Callable[[], None]]] = []


def register_startup_hook(name: str, fn: Callable[[], None]) -> None:
    """Queue ``fn`` to run once when the app starts. Importing a router twice
    (tests reload modules) must not run it twice, so a name already registered
    replaces the earlier hook rather than adding a second."""
    for i, (existing, _) in enumerate(_hooks):
        if existing == name:
            _hooks[i] = (name, fn)
            return
    _hooks.append((name, fn))


def run_startup_hooks() -> None:
    for name, fn in list(_hooks):
        try:
            fn()
        except Exception:  # noqa: BLE001 — one module's startup must not stop the rest
            log.error("startup hook %s failed", name, exc_info=True)
