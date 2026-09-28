"""theDAW's port preflight.

The bug these cover: a Pinokio Start on a machine that already had a backend
running died with uvicorn's raw ``[Errno 10048] ... only one usage of each
socket address`` and Pinokio reported it as the event ``["Errno "]``. Nothing
told the user what to close.
"""

from __future__ import annotations

import os
import re
import shutil
import socket
import subprocess
import sys
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Iterator

import psutil
import pytest

from backend import ports

REPO_ROOT = Path(__file__).resolve().parent.parent

#: The interpreter itself, not a venv's redirector: on Windows a venv's
#: python.exe starts the base interpreter as a CHILD, and the child would be the
#: listener these tests look for.
_PYTHON = getattr(sys, "_base_executable", None) or sys.executable

#: What every stand-in listener runs: bind an ephemeral loopback port, print
#: it, and wait to be stopped.
_LISTENER = (
    "import socket, time\n"
    "s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)\n"
    "s.bind(('127.0.0.1', 0))\n"
    "s.listen(1)\n"
    "print(s.getsockname()[1], flush=True)\n"
    "time.sleep(120)\n"
)


@contextmanager
def _listening_child(
    cwd: Path, args: list[str]
) -> Iterator[tuple[subprocess.Popen, int]]:
    """A real process started in ``cwd`` as ``python <args>``, listening on the
    port it yields. Killed, with anything it started, on the way out."""
    proc = subprocess.Popen(
        [_PYTHON, *args], cwd=str(cwd), stdout=subprocess.PIPE, text=True
    )
    try:
        assert proc.stdout is not None
        port = int(proc.stdout.readline())
        yield proc, port
    finally:
        try:
            parent = psutil.Process(proc.pid)
            for child in parent.children(recursive=True):
                child.kill()
            parent.kill()
        except psutil.NoSuchProcess:
            pass
        proc.wait(timeout=10)
        if proc.stdout is not None:
            proc.stdout.close()


def _fake_checkout(root: Path) -> Path:
    """A folder where ``python -m backend.run`` starts a listener, the way a
    real theDAW checkout's backend does."""
    (root / "backend").mkdir(parents=True)
    (root / "backend" / "__init__.py").write_text("", encoding="utf-8")
    (root / "backend" / "run.py").write_text(_LISTENER, encoding="utf-8")
    return root


@pytest.fixture
def bound_port():
    """A real listening socket on an ephemeral port, closed afterwards."""
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as srv:
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        yield srv.getsockname()[1]


@pytest.fixture
def unused_port() -> int:
    """A port number nothing is listening on."""
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


# --------------------------------------------------------------------------
# the port table is the single source of truth for all three launchers
# --------------------------------------------------------------------------


#: Every shipped launcher that clears theDAW's ports before starting it.
_LAUNCHERS = ("theDAW.bat", "theDAW-desktop.bat", "theDAW.sh")

#: What a launcher must never run again. Each one kills WHATEVER holds a port:
#: another project's Vite on 5173, another Electron app's server. The launchers
#: go through ``backend.ports --free`` instead, which stops only processes
#: running from this checkout. These match the ACT, not the exact text that was
#: removed once: a launcher that signals a pid or an image name it looked up
#: itself has skipped the ownership check however it spells it.
_BLIND_KILLS = (
    re.compile(r"taskkill[^\n]*/PID", re.IGNORECASE),  # kill by pid (netstat | ...)
    re.compile(r"taskkill[^\n]*/IM", re.IGNORECASE),  # kill by image name
    re.compile(r"\bpkill\b"),
    re.compile(r"\bkillall\b"),
    re.compile(r"Stop-Process", re.IGNORECASE),
    re.compile(r"\bkill\s+-9\b"),
    re.compile(r"\bfuser\s+-k\b"),
)


def _launcher(name: str) -> str:
    return (REPO_ROOT / name).read_text(encoding="utf-8", errors="replace")


def _code_lines(text: str) -> str:
    """The launcher without its comment lines, so the comments that DESCRIBE
    the old pipeline cannot trip the check that it is gone."""
    kept = [
        line
        for line in text.splitlines()
        if not line.lstrip().startswith(("::", "rem ", "REM ", "#"))
    ]
    return "\n".join(kept)


@pytest.mark.parametrize("name", _LAUNCHERS)
def test_every_launcher_frees_ports_through_the_ownership_check(name: str):
    """The table in backend.ports is the single source of truth, and the
    launchers now use it directly: ``--all-ports`` is ALL_PORTS by construction,
    so there is no second list in a launcher to drift from it."""
    code = _code_lines(_launcher(name))
    assert "-m backend.ports --free --all-ports" in code, (
        f"{name} no longer clears its ports through backend.ports --free"
    )


@pytest.mark.parametrize("name", _LAUNCHERS)
def test_no_launcher_kills_a_process_it_did_not_identify_as_ours(name: str):
    code = _code_lines(_launcher(name))
    hits = [rx.pattern for rx in _BLIND_KILLS if rx.search(code)]
    assert not hits, (
        f"{name} kills processes without checking they are theDAW's: {hits}"
    )


def test_the_lan_https_listener_has_a_port_in_the_table():
    """The TLS Vite listener that makes theDAW a secure context on the LAN is
    a port the launchers start and therefore a port they must also clear: a
    stale one left holding 5443 stops the next launch from serving audio, mic
    and MIDI to any other device."""
    assert ports.LAN_HTTPS_PORT == 5443
    assert ports.LAN_HTTPS_PORT in ports.ALL_PORTS


def test_no_two_of_our_ports_are_the_same_number():
    """Two entries sharing a number means one of the services silently never
    binds, and the launcher sweeps the other one's process."""
    assert len(set(ports.ALL_PORTS)) == len(ports.ALL_PORTS)


def test_default_ports_are_a_subset_that_includes_the_backend():
    assert set(ports.DEFAULT_PORTS) <= set(ports.ALL_PORTS)
    assert ports.BACKEND_PORT in ports.DEFAULT_PORTS
    assert ports.FRONTEND_PORT in ports.DEFAULT_PORTS


# --------------------------------------------------------------------------
# is_port_free
# --------------------------------------------------------------------------


def test_is_port_free_sees_a_loopback_listener(bound_port: int):
    """The listener is on 127.0.0.1 while backend.run binds 0.0.0.0. An earlier
    version probed only one of those and disagreed with uvicorn."""
    assert ports.is_port_free(bound_port) is False


def test_is_port_free_on_an_unused_port(unused_port: int):
    assert ports.is_port_free(unused_port) is True


def test_is_port_free_consults_the_listening_table_first(monkeypatch, unused_port: int):
    """The table is the only authority that sees every local address, so a
    listener it reports counts even when a bind to 0.0.0.0 would succeed."""
    monkeypatch.setattr(ports, "_listening_pids", lambda port: [4321])
    assert ports.is_port_free(unused_port) is False


# --------------------------------------------------------------------------
# describe_occupant
# --------------------------------------------------------------------------


def test_describe_occupant_is_none_when_the_port_is_free(unused_port: int):
    assert ports.describe_occupant(unused_port) is None


def test_describe_occupant_names_the_port_and_says_what_to_do(bound_port: int):
    msg = ports.describe_occupant(bound_port)
    assert msg is not None
    assert str(bound_port) in msg
    assert "Errno" not in msg
    assert "10048" not in msg
    assert "try again" in msg.lower() or "close" in msg.lower()


def test_describe_occupant_escapes_a_non_ascii_process_name(
    bound_port: int, monkeypatch
):
    """A foreign executable's name comes from the OS and can hold anything.
    These strings go to a pipe, which carries the locale encoding."""
    weird = ports.Holder(
        port=bound_port, pid=1234, name="pyth\u00f6n\u4e2d.exe", cmdline="", ours=False
    )
    monkeypatch.setattr(ports, "holders", lambda p: [weird])
    msg = ports.describe_occupant(bound_port)
    assert msg is not None
    msg.encode("ascii")
    weird.describe().encode("ascii")


# --------------------------------------------------------------------------
# identity: only ours, only from THIS checkout
# --------------------------------------------------------------------------

_HERE = str(REPO_ROOT)


@pytest.mark.parametrize(
    ("name", "cmdline", "cwd", "expected"),
    [
        # Ours: entry point named, and the checkout is in the command line.
        ("python.exe", f"{_HERE}/.venv/Scripts/python.exe -m backend.run", "", True),
        # Ours: command line has no path, but the working directory is ours.
        ("python.exe", "python -m backend._supervisor", _HERE, True),
        ("node.exe", "node vite", _HERE + "/frontend", True),
        # NOT ours: another project's Vite dev server. This is the case that
        # made "vite" alone dangerous -- --free would have killed it.
        ("node.exe", "node vite", "C:/work/someone-elses-app", False),
        ("node.exe", "C:/work/other/node_modules/vite/bin/vite.js", "", False),
        # NOT ours: a stranger's python server, even in our directory.
        ("python.exe", "python -m http.server 8600", _HERE, False),
        ("python.exe", "python manage.py runserver", _HERE, False),
        # NOT ours: right command line and checkout, wrong kind of binary.
        ("nginx.exe", f"nginx -c {_HERE} backend.run", _HERE, False),
        ("", "", "", False),
        # NOT ours: a sibling folder whose name merely STARTS with this one's,
        # the Pinokio launcher's clone and every theDAW-<branch> worktree.
        (
            "python.exe",
            f"{_HERE}-Pinokio/.venv/Scripts/python.exe -m backend.run",
            "",
            False,
        ),
        ("node.exe", "node vite", _HERE + "-footer-bar/frontend", False),
        ("python.exe", "python -m backend._supervisor", _HERE + "-midi-dock", False),
        # Ours: the checkout folder itself, and a quoted path inside it.
        ("python.exe", "python -m backend.run", _HERE, True),
        ("python.exe", f'"{_HERE}/.venv/Scripts/python.exe" -m backend.run', "", True),
    ],
)
def test_is_ours_requires_binary_entry_point_and_this_checkout(
    name, cmdline, cwd, expected
):
    assert ports._is_ours(name, cmdline, cwd) is expected


def test_same_tree_ignores_separator_and_case():
    root = str(REPO_ROOT)
    assert ports._same_tree(root) is True
    assert ports._same_tree(root.replace("\\", "/").upper()) is True
    assert ports._same_tree(root.replace("/", "\\").lower()) is True
    assert ports._same_tree("") is False
    assert ports._same_tree("C:/somewhere/else") is False
    assert ports._same_tree(root + "-Pinokio") is False
    assert ports._same_tree(root + "-Pinokio/frontend") is False


def test_free_leaves_a_sibling_checkouts_backend_running(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The sequence on the machine this was reported on: theDAW-Pinokio (or a
    theDAW-<branch> worktree) sits beside the checkout and its backend is
    running; this checkout's launcher then runs ``--free``. The sibling's
    folder starts with this checkout's name, and ``root in text`` counted it as
    this checkout, so the launch stopped the other install's backend."""
    here = _fake_checkout(tmp_path / "theDAW")
    sibling = _fake_checkout(tmp_path / "theDAW-Pinokio")
    monkeypatch.setattr(ports, "repo_root", lambda: here)

    with _listening_child(sibling, ["-m", "backend.run"]) as (proc, port):
        stopped, refused = ports.free_ports([port])
        assert stopped == []
        assert [h.pid for h in refused] == [proc.pid]
        assert proc.poll() is None, "the sibling checkout's backend was stopped"


def test_free_still_stops_a_stale_backend_from_this_checkout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The twin of the sibling case: the same listener, run from THIS folder,
    is the stale backend ``--free`` exists to stop."""
    here = _fake_checkout(tmp_path / "theDAW")
    monkeypatch.setattr(ports, "repo_root", lambda: here)

    with _listening_child(here, ["-m", "backend.run"]) as (proc, port):
        stopped, refused = ports.free_ports([port])
        assert [h.pid for h in stopped] == [proc.pid]
        assert refused == []
        proc.wait(timeout=10)


# --------------------------------------------------------------------------
# theDAW's Node sidecars, each run from its own project folder
# --------------------------------------------------------------------------


def _sidecar_project(folder: Path, entry: str) -> Path:
    """A sidecar project folder whose ``entry`` file starts a listener.

    Python runs a file whatever its extension, so ``python server.ts`` stands
    in for Lyria's ``tsx server.ts`` with the same command line shape and the
    same working directory."""
    target = folder / entry
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(_LISTENER, encoding="utf-8")
    return folder


@pytest.mark.parametrize(
    ("env", "folder_name", "entry"),
    [
        # Lyria: `npm run dev` is `tsx server.ts`, in a clone beside the repo.
        ("theDAW_LYRIA_PROJECT", "lyria-3-pro", "server.ts"),
        # Foundry: the production server, `node dist/server.cjs`.
        ("THEDAW_FOUNDRY_PROJECT", "VST-UI-FOUNDRY", "dist/server.cjs"),
        # VJ: its own vite, in a clone beside the repo.
        ("theDAW_VJ_PROJECT", "GANTASMO-LIVE-VJ", "node_modules/vite/bin/vite.js"),
    ],
)
def test_free_stops_a_stale_sidecar_left_running_from_its_project_folder(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    env: str,
    folder_name: str,
    entry: str,
):
    """A sidecar left behind by a crashed session holds its port against the
    next launch, and the next backend then adopts a process that still has the
    old session's keys. Its command line names no backend entry point and its
    folder is not this checkout, so ``--free`` left it running."""
    here = _fake_checkout(tmp_path / "theDAW")
    monkeypatch.setattr(ports, "repo_root", lambda: here)
    project = _sidecar_project(tmp_path / folder_name, entry)
    monkeypatch.setenv(env, str(project))

    with _listening_child(project, [entry]) as (proc, port):
        stopped, refused = ports.free_ports([port])
        assert [h.pid for h in stopped] == [proc.pid], f"refused: {refused}"
        proc.wait(timeout=10)


#: A stand-in backend.run that starts a sidecar the way the real backend does:
#: as its own child, in the sidecar's project folder. It prints the sidecar's
#: port and keeps running, as a live backend does.
_BACKEND_WITH_SIDECAR = (
    "import subprocess, sys, time\n"
    "sidecar = subprocess.Popen([sys.executable, 'server.ts'], cwd=sys.argv[1],\n"
    "                           stdout=subprocess.PIPE, text=True)\n"
    "print(sidecar.stdout.readline().strip(), flush=True)\n"
    "time.sleep(120)\n"
)


@pytest.mark.parametrize(
    ("backend_folder", "expect_stopped"),
    [
        # theDAW-Pinokio beside this checkout, running, with Lyria from the
        # clone both checkouts share.
        ("theDAW-Pinokio", False),
        # This checkout's own backend and its Lyria.
        ("theDAW", True),
    ],
)
def test_free_leaves_a_shared_sidecar_to_the_checkout_whose_backend_runs_it(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    backend_folder: str,
    expect_stopped: bool,
):
    """Lyria from Dev/lyria-3-pro is the project folder of every checkout beside
    it. With theDAW-Pinokio running, this checkout's ``--free --all-ports``
    left the Pinokio backend alone but stopped the Lyria it was using, since
    the folder was all the match looked at."""
    here = _fake_checkout(tmp_path / "theDAW")
    monkeypatch.setattr(ports, "repo_root", lambda: here)
    shared = _sidecar_project(tmp_path / "lyria-3-pro", "server.ts")
    monkeypatch.setenv("theDAW_LYRIA_PROJECT", str(shared))
    owner = tmp_path / backend_folder
    if owner != here:
        _fake_checkout(owner)
    (owner / "backend" / "run.py").write_text(_BACKEND_WITH_SIDECAR, encoding="utf-8")

    with _listening_child(owner, ["-m", "backend.run", str(shared)]) as (backend, port):
        sidecar = next(h for h in ports.holders([port]) if h.pid != backend.pid).pid
        stopped, _refused = ports.free_ports([port])
        assert [h.pid for h in stopped] == ([sidecar] if expect_stopped else [])
        assert psutil.pid_exists(sidecar) is not expect_stopped
        assert backend.poll() is None


def test_free_leaves_the_same_entry_point_alone_outside_the_sidecar_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """``server.ts`` alone proves nothing: another project's dev server runs
    one too. Only the sidecar's own project folder makes it theDAW's."""
    here = _fake_checkout(tmp_path / "theDAW")
    monkeypatch.setattr(ports, "repo_root", lambda: here)
    monkeypatch.setenv("theDAW_LYRIA_PROJECT", str(tmp_path / "lyria-3-pro"))
    stranger = _sidecar_project(tmp_path / "someone-elses-app", "server.ts")

    with _listening_child(stranger, ["server.ts"]) as (proc, port):
        stopped, _refused = ports.free_ports([port])
        assert stopped == []
        assert proc.poll() is None


# --------------------------------------------------------------------------
# macOS: psutil needs root to list connections, lsof does not
# --------------------------------------------------------------------------


def _as_macos_without_root(
    monkeypatch: pytest.MonkeyPatch, lsof_output: str
) -> list[dict]:
    """psutil refuses exactly as it does on macOS for a non-root user, and a
    stand-in lsof answers with ``lsof_output``. Returns the keyword arguments
    of every lsof call, as they are made."""
    calls: list[dict] = []

    def refused(kind: str = "inet"):
        raise psutil.AccessDenied(pid=None, msg="net_connections needs root on macOS")

    monkeypatch.setattr(psutil, "net_connections", refused)
    fake_lsof = "/usr/sbin/lsof"
    real_which = shutil.which
    monkeypatch.setattr(
        shutil,
        "which",
        lambda cmd, *a, **k: fake_lsof if cmd == "lsof" else real_which(cmd, *a, **k),
    )
    real_run = subprocess.run

    def run(argv, *args, **kwargs):
        if argv and argv[0] == fake_lsof:
            calls.append(kwargs)
            return subprocess.CompletedProcess(argv, 0, lsof_output, "")
        return real_run(argv, *args, **kwargs)

    monkeypatch.setattr(subprocess, "run", run)
    return calls


def test_free_stops_a_stale_backend_on_macos_without_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """On macOS psutil.net_connections() raises AccessDenied unless run as
    root, holders() answered with nothing, and ``--free`` stopped nothing: a
    stale backend then made the new one fail to bind. lsof, run as the user,
    lists the user's own listeners."""
    here = _fake_checkout(tmp_path / "theDAW")
    monkeypatch.setattr(ports, "repo_root", lambda: here)

    with _listening_child(here, ["-m", "backend.run"]) as (proc, port):
        _as_macos_without_root(
            monkeypatch,
            # -F pn output: a process line, then its files. The first file is
            # a listener on another port, which must be ignored.
            f"p{proc.pid}\nf3\nn*:1\nf4\nn127.0.0.1:{port}\n",
        )
        stopped, refused = ports.free_ports([port])
        assert [h.pid for h in stopped] == [proc.pid]
        assert refused == []
        proc.wait(timeout=10)


def test_lsof_listeners_reads_every_address_form(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("THEDAW_LAUNCH_TOKEN", "secret-of-the-desktop-shell")
    calls = _as_macos_without_root(
        monkeypatch,
        "p101\nf5\nn*:8600\np202\nf7\nn[::1]:5173\nf8\nn127.0.0.1:5443\np303\nf9\nn*:9999\n",
    )
    assert ports._lsof_listeners({8600, 5173, 5443}) == [
        (8600, 101),
        (5173, 202),
        (5443, 202),
    ]
    # lsof is a child like any other: the desktop shell's launch token stays
    # with the backend (backend.lib.launch_token.child_env).
    assert len(calls) == 1
    assert "THEDAW_LAUNCH_TOKEN" not in calls[0]["env"]


def test_lsof_missing_means_nothing_to_report(monkeypatch: pytest.MonkeyPatch):
    real_which = shutil.which
    monkeypatch.setattr(
        shutil,
        "which",
        lambda cmd, *a, **k: None if cmd == "lsof" else real_which(cmd, *a, **k),
    )
    monkeypatch.setattr(ports, "_LSOF_FALLBACKS", ())
    assert ports._lsof_listeners({8600}) == []


def test_still_the_same_process_rejects_a_recycled_pid():
    """A PID from the scan can exit and be reused before the signal lands."""
    import psutil

    stale = ports.Holder(
        port=1, pid=os.getpid(), name="python", cmdline="", ours=True, create_time=1.0
    )
    assert ports._still_the_same_process(stale) is None

    live = psutil.Process(os.getpid())
    same = ports.Holder(
        port=1,
        pid=os.getpid(),
        name="python",
        cmdline="",
        ours=True,
        create_time=live.create_time(),
    )
    assert ports._still_the_same_process(same) is not None


# --------------------------------------------------------------------------
# free_ports
# --------------------------------------------------------------------------


def test_free_ports_never_kills_a_foreign_listener(bound_port: int, monkeypatch):
    monkeypatch.setattr(
        ports, "_is_ours", lambda name, cmdline, cwd="", pid=None: False
    )
    stopped, refused = ports.free_ports([bound_port])
    assert stopped == []
    assert ports.is_port_free(bound_port) is False
    assert all(h.ours is False for h in refused)


def test_free_ports_skips_this_very_process(bound_port: int, monkeypatch):
    monkeypatch.setattr(ports, "_is_ours", lambda name, cmdline, cwd="", pid=None: True)
    stopped, _refused = ports.free_ports([bound_port])
    assert all(h.pid != os.getpid() for h in stopped)
    assert ports.is_port_free(bound_port) is False


def _fake_proc(pid: int):
    return type(
        "P", (), {"pid": pid, "terminate": lambda s: None, "kill": lambda s: None}
    )()


def test_free_ports_reports_only_processes_that_actually_exited(monkeypatch):
    """Reporting a kill that failed would tell a launcher the port is free when
    it is not, and Start would then die on the bind anyway."""
    import psutil

    holder = ports.Holder(port=4242, pid=999001, name="python", cmdline="", ours=True)
    monkeypatch.setattr(ports, "holders", lambda p: [holder])
    monkeypatch.setattr(ports, "_still_the_same_process", lambda h: _fake_proc(999001))
    # Never exits, through both the terminate wait and the kill wait.
    monkeypatch.setattr(
        psutil, "wait_procs", lambda procs, timeout=None: ([], list(procs))
    )

    stopped, refused = ports.free_ports([4242])
    assert stopped == []
    assert refused == []


def test_free_ports_reports_a_process_that_did_exit(monkeypatch):
    import psutil

    holder = ports.Holder(port=4243, pid=999002, name="python", cmdline="", ours=True)
    monkeypatch.setattr(ports, "holders", lambda p: [holder])
    monkeypatch.setattr(ports, "_still_the_same_process", lambda h: _fake_proc(999002))
    monkeypatch.setattr(
        psutil, "wait_procs", lambda procs, timeout=None: (list(procs), [])
    )

    stopped, _refused = ports.free_ports([4243])
    assert [h.pid for h in stopped] == [999002]


def test_the_clean_shutdown_wait_outlasts_the_backends_handler_budget():
    """--free signals the backend once this wait runs out. The backend gives its
    shutdown handlers (live plugins saving state among them) a budget after a
    short delay; signalling inside that window cuts the save in half."""
    from backend import admin_routes

    assert ports._CLEAN_SHUTDOWN_TIMEOUT > (
        admin_routes._EXIT_DELAY_SEC + admin_routes.SHUTDOWN_HANDLER_BUDGET_SEC
    )


def test_free_ports_asks_the_backend_to_shut_down_cleanly_first(monkeypatch):
    """On Windows psutil.terminate() is TerminateProcess, not a catchable
    SIGTERM, so signalling a backend mid-write is as abrupt as killing it. The
    HTTP shutdown runs the app's own shutdown handlers instead."""
    holder = ports.Holder(
        port=ports.BACKEND_PORT, pid=999003, name="python", cmdline="", ours=True
    )
    monkeypatch.setattr(ports, "holders", lambda p: [holder])
    asked: list[int] = []

    def clean(port: int) -> bool:
        asked.append(port)
        return True

    monkeypatch.setattr(ports, "_ask_backend_to_stop", clean)
    monkeypatch.setattr(
        ports,
        "_still_the_same_process",
        lambda h: pytest.fail("signalled a process that had already stopped cleanly"),
    )

    stopped, _refused = ports.free_ports([ports.BACKEND_PORT])
    assert asked == [ports.BACKEND_PORT]
    assert [h.pid for h in stopped] == [999003]


def test_a_refused_clean_shutdown_falls_through_to_signalling(monkeypatch):
    import psutil

    holder = ports.Holder(
        port=ports.BACKEND_PORT, pid=999004, name="python", cmdline="", ours=True
    )
    monkeypatch.setattr(ports, "holders", lambda p: [holder])
    monkeypatch.setattr(ports, "_ask_backend_to_stop", lambda port: False)
    monkeypatch.setattr(ports, "_still_the_same_process", lambda h: _fake_proc(999004))
    monkeypatch.setattr(
        psutil, "wait_procs", lambda procs, timeout=None: (list(procs), [])
    )

    stopped, _refused = ports.free_ports([ports.BACKEND_PORT])
    assert [h.pid for h in stopped] == [999004]


def test_ask_backend_to_stop_is_false_when_nothing_answers(unused_port: int):
    assert ports._ask_backend_to_stop(unused_port) is False


def test_holders_never_raises_without_psutil(monkeypatch):
    import builtins

    real_import = builtins.__import__

    def no_psutil(name, *args, **kwargs):
        if name == "psutil":
            raise ImportError("no psutil")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_psutil)
    assert ports.holders([8600]) == []
    assert ports.free_ports([8600]) == ([], [])


# --------------------------------------------------------------------------
# the CLI
# --------------------------------------------------------------------------


def test_check_exits_nonzero_while_a_port_is_bound(
    bound_port: int, monkeypatch, capsys
):
    monkeypatch.setattr(ports, "DEFAULT_PORTS", (bound_port,))
    assert ports._main(["--check"]) == 1
    assert str(bound_port) in capsys.readouterr().out


def test_check_exits_zero_when_everything_is_free(
    monkeypatch, capsys, unused_port: int
):
    monkeypatch.setattr(ports, "DEFAULT_PORTS", (unused_port,))
    assert ports._main(["--check"]) == 0
    assert "free" in capsys.readouterr().out


def test_free_reports_success_even_with_nothing_to_do(
    monkeypatch, capsys, unused_port: int
):
    """--free is best-effort: a launcher carries on and lets the real bind be
    the authority, so it must not fail the launch by exiting non-zero."""
    monkeypatch.setattr(ports, "DEFAULT_PORTS", (unused_port,))
    assert ports._main(["--free"]) == 0
    assert "nothing to free" in capsys.readouterr().out


def test_all_ports_flag_widens_the_set(monkeypatch):
    seen: list[tuple[int, ...]] = []
    monkeypatch.setattr(
        ports, "free_ports", lambda p: (seen.append(tuple(p)), ([], []))[1]
    )
    ports._main(["--free", "--all-ports"])
    assert seen == [ports.ALL_PORTS]


def test_every_user_facing_message_is_ascii(bound_port: int, monkeypatch, capsys):
    msg = ports.describe_occupant(bound_port)
    assert msg is not None
    msg.encode("ascii")

    monkeypatch.setattr(ports, "DEFAULT_PORTS", (bound_port,))
    ports._main(["--check"])
    capsys.readouterr().out.encode("ascii")

    monkeypatch.setattr(
        ports, "_is_ours", lambda name, cmdline, cwd="", pid=None: False
    )
    ports._main(["--free"])
    capsys.readouterr().out.encode("ascii")


def test_port_in_use_exit_code_cannot_be_mistaken_for_a_respawn():
    """backend/_supervisor.py respawns on 88 (restart) and 89 (update) and
    terminates on anything else. A port clash must terminate, not loop."""
    from backend._supervisor import RESTART_EXIT_CODE
    from backend._update_sync import UPDATE_EXIT_CODE
    from backend.run import PORT_IN_USE_EXIT_CODE

    assert PORT_IN_USE_EXIT_CODE not in (0, RESTART_EXIT_CODE, UPDATE_EXIT_CODE)


# ---------------------------------------------------------------------------
# --require-frontend-port: the web UI never moves to a new browser origin
# ---------------------------------------------------------------------------


def test_require_frontend_port_names_the_program_holding_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
):
    """Another program on the web UI's port stops the launch with that
    program's name, pid and folder, and exits 1 so a launcher can stop. The
    program itself is left running."""
    here = tmp_path / "theDAW"
    here.mkdir()
    monkeypatch.setattr(ports, "repo_root", lambda: here)
    stranger = _fake_checkout(tmp_path / "someone-elses-app")

    with _listening_child(stranger, ["-m", "backend.run"]) as (proc, port):
        monkeypatch.setattr(ports, "FRONTEND_PORT", port)
        assert ports._main(["--require-frontend-port"]) == 1
        out = capsys.readouterr().out
        assert f"pid {proc.pid}" in out
        assert "someone-elses-app" in out
        assert "saved settings" in out
        out.encode("ascii")
        assert proc.poll() is None


def _stop_a_server_with_a_client_connected() -> int:
    """Replay what ``--free`` leaves behind when it stops a stale web UI that a
    browser tab was still talking to: the server closes the connection first,
    so its end of it sits in TIME_WAIT on the server's port, and then the
    listener goes away. Returns that port, which nothing is listening on."""
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if os.name == "posix":
        # Vite's own bind (libuv) sets it on POSIX, and Linux lets a later
        # SO_REUSEADDR bind through a TIME_WAIT only when the socket that left
        # it had the option too.
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("0.0.0.0", 0))
    listener.listen(1)
    port = listener.getsockname()[1]
    with closing(socket.create_connection(("127.0.0.1", port), timeout=5)) as tab:
        served, _ = listener.accept()
        # The server's side closes first, so the TIME_WAIT lands on its port.
        served.close()
        tab.settimeout(5)
        assert tab.recv(1) == b""
    listener.close()
    return port


def test_a_web_ui_port_left_in_time_wait_is_free_for_the_next_launch(
    monkeypatch: pytest.MonkeyPatch, capsys
):
    """Vite binds with SO_REUSEADDR on Linux and macOS, so it starts on a port
    whose only sockets are a stopped server's TIME_WAIT. The launcher's check
    has to agree; on Linux a bind probe without that option failed with
    EADDRINUSE for up to a minute after --free, and the launch stopped naming
    no program. On
    Windows, which binds through TIME_WAIT either way, this passes regardless;
    the Linux CI runner is where it catches the probe."""
    port = _stop_a_server_with_a_client_connected()
    monkeypatch.setattr(ports, "FRONTEND_PORT", port)

    assert ports.is_port_free(port) is True
    assert ports.frontend_port_blocker() is None
    assert ports._main(["--require-frontend-port"]) == 0
    assert capsys.readouterr().out == ""


def test_require_frontend_port_is_silent_and_zero_when_the_port_is_free(
    monkeypatch: pytest.MonkeyPatch, capsys, unused_port: int
):
    monkeypatch.setattr(ports, "FRONTEND_PORT", unused_port)
    assert ports._main(["--require-frontend-port"]) == 0
    assert capsys.readouterr().out == ""


@pytest.mark.parametrize("name", ("theDAW.bat", "theDAW-desktop.bat"))
def test_the_desktop_launch_checks_the_web_ui_port_before_electron_starts(name: str):
    """The desktop window loads http://localhost:5173 too. The launcher asks
    first and stops on a non-zero answer, before electron-vite runs."""
    code = _code_lines(_launcher(name))
    check = code.index("-m backend.ports --require-frontend-port")
    launch = code.index("pushd electron-ui\ncall npm run dev")
    assert check < launch
    assert "if errorlevel 1" in code[check:launch]


def test_the_desktop_renderer_never_slides_off_the_web_ui_port():
    """Without strictPort, electron-vite moves to 5174 when 5173 is taken, and
    the window opens on a new origin with none of its saved settings."""
    text = (REPO_ROOT / "electron-ui" / "electron.vite.config.ts").read_text(
        encoding="utf-8"
    )
    server = text[text.index("server: {") :]
    server = server[: server.index("fs: {")]
    assert re.search(r"\bport:\s*5173\b", server)
    assert re.search(r"\bstrictPort:\s*true\b", server)


# ---------------------------------------------------------------------------
# frontend_port(): the port the web UI REALLY took this launch
# ---------------------------------------------------------------------------


def test_the_frontend_port_defaults_to_the_table(monkeypatch):
    monkeypatch.delenv("theDAW_FRONTEND_PORT", raising=False)
    assert ports.frontend_port() == ports.FRONTEND_PORT


def test_the_launcher_can_name_the_port_the_web_ui_actually_took(monkeypatch):
    """_devstack hands the backend the port it chose when another program had
    5173; everything that advertises the web UI's address must follow it."""
    monkeypatch.setenv("theDAW_FRONTEND_PORT", "5177")
    assert ports.frontend_port() == 5177


@pytest.mark.parametrize("value", ["", "   ", "nope", "0", "-1", "65536", "5173.5"])
def test_an_unusable_frontend_port_falls_back_to_the_table(monkeypatch, value: str):
    monkeypatch.setenv("theDAW_FRONTEND_PORT", value)
    assert ports.frontend_port() == ports.FRONTEND_PORT
