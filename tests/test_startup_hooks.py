"""The module-startup registry (backend/core/startup.py).

It makes two promises, and both only matter once something has already gone
wrong: a router imported twice must not run its startup twice, and one
module's failing hook must not stop the modules queued after it. Neither has
a happy path worth a test of its own.
"""

import logging

from backend.core import startup


def test_a_name_registered_twice_runs_once(monkeypatch):
    monkeypatch.setattr(startup, "_hooks", [])
    calls: list[str] = []
    startup.register_startup_hook("m", lambda: calls.append("first"))
    # A reload re-imports the router, which re-registers under the same name;
    # the later registration must replace the earlier one, not queue behind it.
    startup.register_startup_hook("m", lambda: calls.append("second"))

    startup.run_startup_hooks()

    assert calls == ["second"]


def test_a_failing_hook_does_not_stop_the_rest(monkeypatch, caplog):
    monkeypatch.setattr(startup, "_hooks", [])
    caplog.set_level(logging.ERROR, logger="backend.core.startup")
    calls: list[str] = []

    def boom() -> None:
        raise RuntimeError("dashboard exploded")

    startup.register_startup_hook("a", lambda: calls.append("a"))
    startup.register_startup_hook("b", boom)
    startup.register_startup_hook("c", lambda: calls.append("c"))

    startup.run_startup_hooks()

    assert calls == ["a", "c"]
    assert "startup hook b failed" in caplog.text
