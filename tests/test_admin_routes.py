"""POST /api/admin/shutdown and /api/admin/restart.

The bug these cover: both ended the process with ``os._exit`` straight after
stopping the sidecars, so the app's shutdown handlers -- the background queue,
the assistant's ``claude`` children, the live VST hosts saving their plugin
state -- never ran. ``backend/ports.py`` said they did, and ``--free`` makes
this call on every launch.

``os._exit``, the sidecar teardown and the live VST host stop are replaced by
recorders in every test here; each test waits for the recorded exit before it
returns, so the exit thread never outlives the patch.

Every client here is a loopback peer unless the test is about a caller that is
not: the router answers only this machine (``require_loopback_or_launch_token``),
because a LAN script that sends no browser headers passed the cross-site check.
"""

from __future__ import annotations

import ast
import asyncio
import logging
import os
import sys
import threading
import time
import types
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import admin_routes
from backend.lib import launch_token

REPO_ROOT = Path(__file__).resolve().parent.parent
LOOPBACK_PEER = ("127.0.0.1", 51000)
LAN_PEER = ("10.20.30.40", 51000)


def _app(events: list, handlers=None) -> FastAPI:
    """An app wired the way backend/server.py wires the real one: the lifespan
    publishes its shutdown coroutine on app.state for the admin routes."""

    async def record_handlers() -> None:
        events.append("handlers")

    @asynccontextmanager
    async def lifespan(app_: FastAPI):
        app_.state.run_shutdown_handlers = handlers or record_handlers
        yield

    app = FastAPI(lifespan=lifespan)
    app.include_router(admin_routes.router)
    return app


@pytest.fixture
def exits(monkeypatch: pytest.MonkeyPatch):
    events: list = []
    exited = threading.Event()

    def fake_exit(code: int) -> None:
        events.append(("exit", code))
        exited.set()

    monkeypatch.setattr(os, "_exit", fake_exit)
    import backend.core.teardown as teardown

    monkeypatch.setattr(
        teardown, "stop_all_sidecars", lambda: events.append("sidecars")
    )
    import backend.modules.vst.live_host as live_host

    monkeypatch.setattr(live_host, "kill_all", lambda: events.append("vst"))
    return events, exited


@pytest.mark.parametrize(
    "headers",
    [
        {},  # backend.ports --free and the desktop shell: no browser headers
        {"Origin": "http://localhost:5173", "Sec-Fetch-Site": "same-site"},  # the UI
    ],
)
def test_shutdown_runs_the_apps_shutdown_handlers_before_the_process_exits(
    exits, headers: dict
):
    events, exited = exits
    with TestClient(_app(events), client=LOOPBACK_PEER) as client:
        response = client.post("/api/admin/shutdown", headers=headers)
        assert response.status_code == 200
        assert exited.wait(10), "the process never exited"
    first_exit = events.index(("exit", 0))
    assert "handlers" in events[:first_exit], f"exit came first: {events}"


def test_restart_runs_them_too_and_exits_with_the_respawn_code(
    exits, monkeypatch: pytest.MonkeyPatch
):
    """A restart that skips them orphans every claude child and drops the live
    plugins' unsaved state, exactly as a shutdown would."""
    monkeypatch.setenv(admin_routes.SUPERVISOR_ENV_FLAG, "1")
    events, exited = exits
    with TestClient(_app(events), client=LOOPBACK_PEER) as client:
        assert client.post("/api/admin/restart").status_code == 200
        assert exited.wait(10), "the process never exited"
    first_exit = events.index(("exit", admin_routes.RESTART_EXIT_CODE))
    assert "handlers" in events[:first_exit]


def test_hung_handlers_cannot_keep_the_process_alive(
    exits, monkeypatch: pytest.MonkeyPatch
):
    """The handlers get a budget. Past it the process exits anyway, and the
    live VST hosts and the sidecars are still stopped: the hosts save their
    plugin state, and no sidecar is left holding its port."""
    monkeypatch.setattr(admin_routes, "SHUTDOWN_HANDLER_BUDGET_SEC", 0.3)
    events, exited = exits

    async def hang() -> None:
        await asyncio.sleep(30)

    with TestClient(_app(events, handlers=hang), client=LOOPBACK_PEER) as client:
        assert client.post("/api/admin/shutdown").status_code == 200
        assert exited.wait(10), "a hung handler kept the process alive"
    assert events == ["vst", "sidecars", ("exit", 0)]


def test_an_app_without_a_lifespan_still_stops_its_sidecars(exits):
    events, exited = exits
    app = FastAPI()
    app.include_router(admin_routes.router)
    with TestClient(app, client=LOOPBACK_PEER) as client:
        assert client.post("/api/admin/shutdown").status_code == 200
        assert exited.wait(10)
    assert events == ["vst", "sidecars", ("exit", 0)]


@pytest.mark.parametrize("route", ["/api/admin/shutdown", "/api/admin/restart"])
def test_a_page_outside_thedaw_cannot_stop_the_backend(
    exits, monkeypatch: pytest.MonkeyPatch, route: str
):
    """A plain POST needs no CORS preflight, so any site the user had open
    could stop theDAW with one fetch(). The browser labels that request as
    cross-site and page script cannot change the label."""
    monkeypatch.setenv(admin_routes.SUPERVISOR_ENV_FLAG, "1")
    events, exited = exits
    with TestClient(_app(events), client=LOOPBACK_PEER) as client:
        response = client.post(
            route,
            headers={"Origin": "https://example.com", "Sec-Fetch-Site": "cross-site"},
        )
        assert response.status_code == 403
        # Longer than the exit thread's delay: nothing was scheduled at all.
        assert not exited.wait(1.5), f"a foreign page stopped the backend: {events}"
    assert events == []


@pytest.mark.parametrize("route", ["/api/admin/shutdown", "/api/admin/restart"])
def test_a_lan_caller_cannot_stop_the_backend(
    exits, monkeypatch: pytest.MonkeyPatch, route: str
):
    """A script on the LAN sends no browser headers, so the cross-site check
    passes it. The TCP peer is what tells it apart, and nothing is scheduled."""
    monkeypatch.setenv(admin_routes.SUPERVISOR_ENV_FLAG, "1")
    monkeypatch.delenv(launch_token.ENV_VAR, raising=False)
    events, exited = exits
    with TestClient(_app(events), client=LAN_PEER) as client:
        response = client.post(route)
        assert response.status_code == 403
        assert not exited.wait(1.5), f"a LAN caller stopped the backend: {events}"
    assert events == []


def test_the_desktop_shells_launch_token_passes_from_any_peer(
    exits, monkeypatch: pytest.MonkeyPatch
):
    """The desktop shell posts to 127.0.0.1, so the token is belt and braces
    there; the check itself is header-blind for everyone else."""
    monkeypatch.setenv(launch_token.ENV_VAR, "s3cret-launch")
    events, exited = exits
    with TestClient(_app(events), client=LAN_PEER) as client:
        response = client.post(
            "/api/admin/shutdown", headers={launch_token.HEADER: "s3cret-launch"}
        )
        assert response.status_code == 200
        assert exited.wait(10), "the process never exited"
    assert ("exit", 0) in events


def test_the_real_lifespan_publishes_its_shutdown_handlers():
    """backend/server.py is what the routes read the handlers from; importing it
    here would start every module, so its lifespan is read as source."""
    source = (REPO_ROOT / "backend" / "server.py").read_text(encoding="utf-8")
    body = source[source.index("async def _lifespan") : source.index("app = FastAPI(")]
    register = body.index("setattr(app_.state, SHUTDOWN_HANDLERS_STATE, _on_shutdown)")
    assert register < body.index("\n    yield\n")
    assert admin_routes.SHUTDOWN_HANDLERS_STATE == "run_shutdown_handlers"


def _server_on_shutdown():
    """backend/server.py's real ``_on_shutdown``, compiled from its source.

    Importing server.py would start every module; the function imports what it
    stops inside its own body, so it runs here against the recorders."""
    source = (REPO_ROOT / "backend" / "server.py").read_text(encoding="utf-8")
    node = next(
        n
        for n in ast.parse(source).body
        if isinstance(n, ast.AsyncFunctionDef) and n.name == "_on_shutdown"
    )
    namespace = {"asyncio": asyncio, "logger": logging.getLogger("test.server")}
    exec(compile(ast.get_source_segment(source, node), "server.py", "exec"), namespace)
    return namespace["_on_shutdown"]


def test_slow_sidecars_cannot_cut_off_the_live_vst_hosts_state_save(
    exits, monkeypatch: pytest.MonkeyPatch
):
    """Settings > Shutdown while a sidecar is slow to stop. The server's own
    handlers run under one budget; when they stopped the sidecars first and
    the budget ran out there, the live VST hosts were never asked to save their
    plugin state, and the fallback stopped only the sidecars again."""
    monkeypatch.setattr(admin_routes, "SHUTDOWN_HANDLER_BUDGET_SEC", 0.3)
    events, exited = exits
    import backend.core.teardown as teardown

    def slow_sidecars() -> None:
        time.sleep(0.8)
        events.append("sidecars")

    monkeypatch.setattr(teardown, "stop_all_sidecars", slow_sidecars)

    class Queue:
        async def stop(self) -> None:
            events.append("queue")

    async def kill_claude_children() -> None:
        events.append("claude")

    monkeypatch.setitem(
        sys.modules,
        "backend.core.background_workers",
        types.SimpleNamespace(get_background_queue=Queue),
    )
    monkeypatch.setitem(
        sys.modules,
        "backend.modules.assistant.claude_session",
        types.SimpleNamespace(kill_all=kill_claude_children),
    )

    with TestClient(
        _app(events, handlers=_server_on_shutdown()), client=LOOPBACK_PEER
    ) as client:
        assert client.post("/api/admin/shutdown").status_code == 200
        assert exited.wait(10), "the process never exited"
    first_exit = events.index(("exit", 0))
    assert "vst" in events[:first_exit], f"the VST hosts never stopped: {events}"
    assert events.index("vst") < events.index("sidecars")
