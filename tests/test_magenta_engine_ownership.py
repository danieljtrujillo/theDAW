"""Stopping the Magenta engine stops only the engine this checkout started.

Two checkouts of theDAW on one machine (the user's app tree and a worktree, or
two clones) each spawn their own engine from their own sidecars/magenta
folder. The stop used to run ``pkill -f "sidecars/magenta/server.py|
studio_server.py"`` inside WSL, which ends every magenta engine on the machine:
a test run or a second checkout stopping its engine killed the running app's.

The stop now signals the pid the spawn recorded, and only while that pid still
runs this checkout's script, plus this checkout's own bundled Studio server.
The fake tests replay start -> (backend restart) -> stop against a process
table that holds both checkouts' engines; the POSIX test does it with real
processes.
"""

from __future__ import annotations

import asyncio
import contextlib
import shlex
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from backend.modules.magenta import sidecar


class _ProcTable:
    """The engine side's processes. Answers ``ps`` with the table, removes a
    pid on ``kill``, and removes every pid whose args match on ``pkill -f``
    (what the real pkill does), so a stop that reaps by name shows up as the
    other checkout's engine vanishing."""

    def __init__(self, table: dict[int, str]) -> None:
        self.table = dict(table)
        self.signalled: list[int] = []
        self.commands: list[list[str]] = []

    def run(self, cmd: list[str], *args: Any, **kwargs: Any):
        argv = list(cmd)
        self.commands.append(argv)
        if argv[:1] == ["wsl.exe"]:
            # wsl.exe -d <distro> --exec <argv> | -- bash -lc <script>
            if "--exec" in argv:
                argv = argv[argv.index("--exec") + 1 :]
            else:
                argv = ["bash", "-lc", argv[-1]]
        if argv[:2] == ["bash", "-lc"]:
            argv = argv[2].split(" || ")[0].split()
            argv = [a.strip("'") for a in argv]
            if argv[:2] == ["pkill", "-f"]:
                argv = ["pkill", "-f", argv[2]]
        out = ""
        if argv and argv[0] == "ps":
            out = "".join(f"{pid:>7} {a}\n" for pid, a in sorted(self.table.items()))
        elif argv and argv[0] == "kill":
            for p in argv[2:]:
                self.signalled.append(int(p))
                self.table.pop(int(p), None)
        elif argv[:2] == ["pkill", "-f"]:
            alternatives = argv[2].split("|")
            for pid, a in list(self.table.items()):
                if any(alt in a for alt in alternatives):
                    self.signalled.append(pid)
                    del self.table[pid]
        text = kwargs.get("text") or kwargs.get("encoding")
        return subprocess.CompletedProcess(argv, 0, out if text else out.encode(), "")


class _SpawnedEngine:
    """The child ``start_engine`` gets back: on Windows that is wsl.exe."""

    pid = 101

    def poll(self) -> int | None:
        return None

    def terminate(self) -> None:
        pass

    def wait(self, timeout: float | None = None) -> int:
        return 0

    def kill(self) -> None:
        pass


def _checkout(root: Path) -> tuple[Path, Path]:
    engine = root / "sidecars" / "magenta" / "server.py"
    studio = root / "sidecars" / "magenta-rt2-nvidia" / "app" / "studio_server.py"
    for f in (engine, studio):
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("", encoding="utf-8")
    return engine, studio


@pytest.fixture
def two_checkouts(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    ours, our_studio = _checkout(tmp_path / "theDAW-worktree")
    theirs, their_studio = _checkout(tmp_path / "theDAW")
    python = tmp_path / "python"
    python.write_text("", encoding="utf-8")
    monkeypatch.setattr(sidecar, "_engine_proc", None)
    monkeypatch.setattr(sidecar, "_ENGINE_SCRIPT", ours)
    # raising=False: the same test runs, and fails, against a build without them.
    monkeypatch.setattr(sidecar, "_STUDIO_SCRIPT", our_studio, raising=False)
    monkeypatch.setattr(
        sidecar, "_PID_FILE", tmp_path / "data" / "magenta_engine.pid", raising=False
    )
    monkeypatch.setattr(sidecar, "_NATIVE_PYTHON", str(python))
    monkeypatch.setattr(sidecar, "_LOG_DIR", tmp_path / "logs")
    monkeypatch.setattr(sidecar, "_wsl_distro", lambda: "Ubuntu")
    monkeypatch.setattr(sidecar, "_resolve_start_model", lambda: ("mrt2_small", None))
    monkeypatch.setattr(sidecar, "_ENGINE_STOP_GRACE_SEC", 0.0, raising=False)
    monkeypatch.setattr(sidecar, "_PID_RECORD_WAIT_SEC", 0.0, raising=False)
    yield {
        "ours": ours,
        "our_studio": our_studio,
        "theirs": theirs,
        "their_studio": their_studio,
    }
    # A Windows spawn starts a thread that waits for the pid record; let it
    # finish here, so its log line never lands in a later test.
    _join_pid_record_threads()


def _join_pid_record_threads() -> None:
    for thread in threading.enumerate():
        if thread.name == "magenta:pid-record":
            thread.join(timeout=10)


def _as_engine_sees(path: Path) -> str:
    """How a process on the engine side spells ``path`` in its arguments: the
    WSL mount path on Windows, the path itself elsewhere."""
    return sidecar._wsl_path(path) if sidecar.sys.platform == "win32" else str(path)


@pytest.mark.parametrize("platform", ["win32", "linux"])
def test_stop_leaves_the_other_checkouts_engine_running(
    platform: str, two_checkouts: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sidecar.sys, "platform", platform)
    c = two_checkouts
    monkeypatch.setattr(sidecar.subprocess, "Popen", lambda *a, **k: _SpawnedEngine())

    # 1. This checkout's backend starts its engine.
    started = sidecar.start_engine()
    assert started["spawned"] is True
    if platform == "win32":
        # Inside WSL the spawn's bash writes its own pid before exec (the
        # command is checked in the next test); this is that write.
        pid_file = sidecar._PID_FILE
        pid_file.parent.mkdir(parents=True, exist_ok=True)
        pid_file.write_text("101\n", encoding="utf-8")
    assert sidecar._PID_FILE.read_text(encoding="utf-8").strip() == "101"

    # 2. The backend restarts: the child handle is gone, the engine is not.
    monkeypatch.setattr(sidecar, "_engine_proc", None)

    procs = _ProcTable(
        {
            1: "/init",
            101: f"/home/u/mrt2/.venv/bin/python {_as_engine_sees(c['ours'])}",
            202: f"/home/u/mrt2/.venv/bin/python {_as_engine_sees(c['theirs'])}",
            303: f"/home/u/mrt2/.venv/bin/python {_as_engine_sees(c['our_studio'])}",
            404: f"/home/u/mrt2/.venv/bin/python {_as_engine_sees(c['their_studio'])}",
            # A checkout whose folder ends in this one's path: not this one.
            505: f"/home/u/mrt2/.venv/bin/python /srv{_as_engine_sees(c['our_studio'])}",
        }
    )
    monkeypatch.setattr(sidecar.subprocess, "run", procs.run)

    # 3. It stops its engine.
    stopped = sidecar.stop_engine()

    assert sorted(procs.signalled) == [101, 303]
    assert sorted(procs.table) == [1, 202, 404, 505], "the others run on"
    assert sorted(stopped["reaped"]) == [101, 303]
    assert [e["pid"] for e in stopped["left_running"]] == [202, 404, 505]
    assert not sidecar._PID_FILE.exists(), "the spent pid record is cleared"


def test_the_windows_spawn_records_the_engine_pid(
    two_checkouts: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sidecar.sys, "platform", "win32")
    seen: list[list[str]] = []

    def popen(cmd, *a, **k):
        seen.append(cmd)
        return _SpawnedEngine()

    monkeypatch.setattr(sidecar.subprocess, "Popen", popen)
    sidecar.start_engine()
    [cmd] = seen
    # --exec: no default shell reads the script first and expands $$ itself.
    assert cmd[:6] == ["wsl.exe", "-d", "Ubuntu", "--exec", "bash", "-lc"]
    script = cmd[-1]
    record = sidecar._wsl_path(sidecar._PID_FILE)
    tmp, final = shlex.quote(record + ".tmp"), shlex.quote(record)
    # $$ is the bash that ``exec`` turns into the engine: the same pid.
    assert f"echo $$ > {tmp}" in script
    assert f"mv -f {tmp} {final};" in script
    assert script.index(final) < script.index("exec ")
    # A record that cannot be written says so in the sidecar log, with the
    # shell's own error: nothing is sent to /dev/null.
    assert "2>/dev/null" not in script
    missing = shlex.quote("theDAW: could not record the engine pid in " + record)
    assert f"|| echo {missing} >&2;" in script


def test_a_reused_pid_is_not_signalled(
    two_checkouts: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The record says 101, but the engine it named exited long ago and the
    system gave 101 to the other checkout's engine. Nothing of ours runs, so
    nothing is signalled and the record is cleared."""
    monkeypatch.setattr(sidecar.sys, "platform", "win32")
    c = two_checkouts
    sidecar._PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    sidecar._PID_FILE.write_text("101\n", encoding="utf-8")
    procs = _ProcTable(
        {101: f"/home/u/mrt2/.venv/bin/python {_as_engine_sees(c['theirs'])}"}
    )
    monkeypatch.setattr(sidecar.subprocess, "run", procs.run)

    stopped = sidecar.stop_engine()

    assert procs.signalled == []
    assert sorted(procs.table) == [101]
    assert stopped["reaped"] == []
    assert not sidecar._PID_FILE.exists()


def test_a_listing_that_fails_signals_nothing(
    two_checkouts: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    """WSL did not answer: the stop cannot tell whose engine is whose, so it
    signals nobody and keeps the record for the next stop."""
    monkeypatch.setattr(sidecar.sys, "platform", "win32")
    sidecar._PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    sidecar._PID_FILE.write_text("101\n", encoding="utf-8")
    calls: list[list[str]] = []

    def run(cmd, *a, **k):
        calls.append(list(cmd))
        return subprocess.CompletedProcess(cmd, 1, "", "WSL is starting")

    monkeypatch.setattr(sidecar.subprocess, "run", run)
    stopped = sidecar.stop_engine()
    assert all("kill" not in c and "pkill" not in " ".join(c) for c in calls)
    assert stopped["reaped"] == []
    assert sidecar._PID_FILE.read_text(encoding="utf-8").strip() == "101"


def test_our_engine_without_a_pid_record_still_stops(
    two_checkouts: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The spawn could not write its record (a data folder on a network share
    WSL cannot reach, or an engine started before the record existed). This
    checkout's engine is still ours by its script path, and the other
    checkout's engine is still left alone."""
    monkeypatch.setattr(sidecar.sys, "platform", "win32")
    c = two_checkouts
    assert not sidecar._PID_FILE.exists()
    procs = _ProcTable(
        {
            101: f"/home/u/mrt2/.venv/bin/python {_as_engine_sees(c['ours'])}",
            202: f"/home/u/mrt2/.venv/bin/python {_as_engine_sees(c['theirs'])}",
        }
    )
    monkeypatch.setattr(sidecar.subprocess, "run", procs.run)

    stopped = sidecar.stop_engine()

    assert procs.signalled == [101]
    assert stopped["reaped"] == [101]
    assert stopped["survivors"] == []
    assert [e["pid"] for e in stopped["left_running"]] == [202]
    assert stopped["listed"] is True


def test_the_spawn_clears_an_old_record_and_reports_a_missing_one(
    two_checkouts: dict, monkeypatch: pytest.MonkeyPatch, caplog
) -> None:
    """A record left by an earlier engine would read as the new engine's, so
    the spawn removes it; when the new engine's bash never writes one, the
    backend log says so."""
    monkeypatch.setattr(sidecar.sys, "platform", "win32")
    sidecar._PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    sidecar._PID_FILE.write_text("999\n", encoding="utf-8")
    monkeypatch.setattr(sidecar.subprocess, "Popen", lambda *a, **k: _SpawnedEngine())
    sidecar.start_engine()
    assert not sidecar._PID_FILE.exists()
    _join_pid_record_threads()

    with caplog.at_level("WARNING", logger=sidecar.log.name):
        found = sidecar._confirm_pid_record(_SpawnedEngine(), sidecar._PID_FILE, 0.0)
    assert found is False
    assert "did not record its pid" in caplog.text

    caplog.clear()
    sidecar._PID_FILE.write_text("101\n", encoding="utf-8")
    with caplog.at_level("WARNING", logger=sidecar.log.name):
        found = sidecar._confirm_pid_record(_SpawnedEngine(), sidecar._PID_FILE, 0.0)
    assert found is True
    assert caplog.text == ""


class _Listening:
    """socket.create_connection that finds a listener on ``ports`` only."""

    def __init__(self, ports: set[int]) -> None:
        self.ports = ports

    def __call__(self, address, timeout=None):
        if address[1] not in self.ports:
            raise ConnectionRefusedError(address)
        return contextlib.nullcontext()


def test_stable_audio_will_not_load_beside_another_copys_engine(
    two_checkouts: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Another copy of theDAW has its engine on 8777. A Stable Audio load
    stops this checkout's engines (there are none), finds that engine still
    running, and is refused with the engine named: stacking the checkpoint load
    on a resident engine is the commit-limit crash the pre-clear exists for."""
    import socket

    from fastapi import HTTPException

    from backend import server

    monkeypatch.setattr(sidecar.sys, "platform", "win32")
    c = two_checkouts
    theirs = f"/home/u/mrt2/.venv/bin/python {_as_engine_sees(c['theirs'])}"
    procs = _ProcTable({1: "/init", 202: theirs})
    monkeypatch.setattr(sidecar.subprocess, "run", procs.run)
    monkeypatch.setattr(socket, "create_connection", _Listening({8777}))
    loads: list[str] = []
    monkeypatch.setattr(
        server, "_get_or_load_generation_pipeline", lambda name: loads.append(name)
    )

    with pytest.raises(HTTPException) as refused:
        asyncio.run(server.preload_model(model="small"))

    assert refused.value.status_code == 409
    detail = refused.value.detail
    assert detail["state"] == "engine_elsewhere"
    assert detail["engines"] == [{"pid": 202, "args": theirs, "owner": "other"}]
    assert "pid 202" in detail["message"]
    assert loads == [], "the checkpoint load never ran"
    assert procs.signalled == [], "the other copy's engine was not touched"


def test_stable_audio_loads_once_our_own_engine_has_stopped(
    two_checkouts: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    import socket

    from backend import server

    monkeypatch.setattr(sidecar.sys, "platform", "win32")
    c = two_checkouts
    procs = _ProcTable(
        {101: f"/home/u/mrt2/.venv/bin/python {_as_engine_sees(c['ours'])}"}
    )
    monkeypatch.setattr(sidecar.subprocess, "run", procs.run)
    monkeypatch.setattr(socket, "create_connection", _Listening({8777}))
    monkeypatch.setattr(
        server, "_get_or_load_generation_pipeline", lambda name: object()
    )

    result = asyncio.run(server.preload_model(model="small"))

    assert result["loaded"] is True
    assert procs.signalled == [101]


@pytest.fixture
def engine_router(two_checkouts: dict, monkeypatch: pytest.MonkeyPatch):
    """The Magenta router with the engine unreachable and installed, a process
    table holding the other checkout's engine, and no real spawn."""
    from backend.modules.magenta import router

    async def health():
        return {"reachable": False, "protocol_ok": False, "available": False}

    monkeypatch.setattr(sidecar.sys, "platform", "win32")
    monkeypatch.setattr(sidecar, "health", health)
    monkeypatch.setattr(sidecar, "setup_state", lambda refresh=False: {"ready": True})
    spawned: list[list[str]] = []

    def popen(cmd, *a, **k):
        spawned.append(cmd)
        return _SpawnedEngine()

    monkeypatch.setattr(sidecar.subprocess, "Popen", popen)
    monkeypatch.setattr(router, "_start_task", None)
    monkeypatch.setattr(router, "_start_blocked", None, raising=False)
    monkeypatch.setattr(router, "_start_failure", "", raising=False)
    theirs = f"/home/u/mrt2/.venv/bin/python {_as_engine_sees(two_checkouts['theirs'])}"
    procs = _ProcTable({1: "/init", 202: theirs})
    monkeypatch.setattr(sidecar.subprocess, "run", procs.run)
    return {"router": router, "procs": procs, "spawned": spawned}


def test_the_engine_start_is_refused_beside_another_copys_engine(
    engine_router,
) -> None:
    from fastapi import HTTPException

    router = engine_router["router"]
    with pytest.raises(HTTPException) as refused:
        asyncio.run(router._start_engine(False))
    assert refused.value.status_code == 409
    assert refused.value.detail["state"] == "engine_elsewhere"
    assert [e["pid"] for e in refused.value.detail["engines"]] == [202]
    assert engine_router["spawned"] == []
    assert router._start_task is None


def test_a_start_that_meets_another_engine_says_why_in_the_status(
    engine_router, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The other engine appeared after the start was accepted: the queued
    start stops ours, finds it, does not spawn, and /engine/status carries the
    reason (and the engine) after the start task has ended."""
    from backend import server

    router = engine_router["router"]

    async def no_offload():
        return {}

    monkeypatch.setattr(server, "offload_model", no_offload)

    asyncio.run(router._start_engine_on_gpu_lane())
    assert engine_router["spawned"] == []

    status = asyncio.run(router.engine_status())
    assert status["state"] == "not_running"
    assert status["blocked"]["state"] == "engine_elsewhere"
    assert [e["pid"] for e in status["blocked"]["engines"]] == [202]
    assert "pid 202" in status["start_error"]


def test_engine_stop_leaves_stable_audio_parked_beside_another_engine(
    engine_router, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Switching back to Stable Audio stops this copy's engine. With another
    copy's engine still on the GPU, SA3 is not moved back beside it, and the
    reply names that engine for the client's card."""
    from backend import server

    router = engine_router["router"]
    onloads: list[bool] = []

    async def onload():
        onloads.append(True)
        return {"onloaded": 1}

    monkeypatch.setattr(server, "onload_model", onload)

    reply = asyncio.run(router.engine_stop())

    assert onloads == []
    assert [e["pid"] for e in reply["left_running"]] == [202]
    assert "skipped" in reply["sa3"]
    assert engine_router["procs"].signalled == []


def test_stop_that_engine_stops_only_the_named_engine(engine_router) -> None:
    """The card's confirmed "Stop that engine": the named pid is stopped; a
    pid that runs no Magenta engine is refused and left alone."""
    from fastapi import HTTPException

    router = engine_router["router"]
    procs = engine_router["procs"]
    with pytest.raises(HTTPException) as refused:
        asyncio.run(router.engine_stop_process(router.EngineProcessBody(pid=1)))
    assert refused.value.status_code == 404
    assert procs.signalled == []

    result = asyncio.run(router.engine_stop_process(router.EngineProcessBody(pid=202)))
    assert result["ok"] is True
    assert result["stopped"] is True
    assert procs.signalled == [202]
    assert sorted(procs.table) == [1]


_SLEEPER = "import time\ntime.sleep(120)\n"


@pytest.mark.skipif(sys.platform == "win32", reason="the engine side is WSL here")
def test_real_processes_only_this_checkouts_engine_stops(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ours, our_studio = _checkout(tmp_path / "theDAW-worktree")
    theirs, _their_studio = _checkout(tmp_path / "theDAW")
    ours.write_text(_SLEEPER, encoding="utf-8")
    theirs.write_text(_SLEEPER, encoding="utf-8")
    monkeypatch.setattr(sidecar, "_engine_proc", None)
    monkeypatch.setattr(sidecar, "_ENGINE_SCRIPT", ours)
    # raising=False: the same test runs, and fails, against a build without them.
    monkeypatch.setattr(sidecar, "_STUDIO_SCRIPT", our_studio, raising=False)
    monkeypatch.setattr(
        sidecar, "_PID_FILE", tmp_path / "data" / "magenta_engine.pid", raising=False
    )
    monkeypatch.setattr(sidecar, "_NATIVE_PYTHON", sys.executable)
    monkeypatch.setattr(sidecar, "_LOG_DIR", tmp_path / "logs")
    monkeypatch.setattr(sidecar, "_resolve_start_model", lambda: ("mrt2_small", None))

    other = subprocess.Popen([sys.executable, str(theirs)])
    try:
        sidecar.start_engine()
        mine = sidecar._engine_proc
        assert mine is not None
        # The backend restarts: the handle is lost, the engine runs on.
        monkeypatch.setattr(sidecar, "_engine_proc", None)
        time.sleep(0.2)

        stopped = sidecar.stop_engine()

        assert mine.wait(timeout=10) is not None, "this checkout's engine stopped"
        assert stopped["reaped"] == [mine.pid]
        assert other.poll() is None, "the other checkout's engine is still running"
    finally:
        other.kill()
        other.wait(timeout=10)
