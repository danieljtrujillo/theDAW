"""theDAW's port preflight.

The bug these cover: a Pinokio Start on a machine that already had a backend
running died with uvicorn's raw ``[Errno 10048] ... only one usage of each
socket address`` and Pinokio reported it as the event ``["Errno "]``. Nothing
told the user what to close.
"""

from __future__ import annotations

import os
import re
import socket
from contextlib import closing
from pathlib import Path

import pytest

from backend import ports

REPO_ROOT = Path(__file__).resolve().parent.parent


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


def test_the_windows_launcher_clears_exactly_this_table():
    """Read theDAW.bat rather than restating the numbers. A test that compares
    one hard-coded tuple against another cannot notice the launcher drifting."""
    bat = (REPO_ROOT / "theDAW.bat").read_text(encoding="utf-8", errors="replace")
    found = tuple(int(p) for p in re.findall(r'/c:":(\d+) "', bat))
    assert found == ports.ALL_PORTS


def test_the_posix_launcher_clears_exactly_this_table():
    sh = (REPO_ROOT / "theDAW.sh").read_text(encoding="utf-8", errors="replace")
    match = re.search(r"for port in ([\d ]+); do", sh)
    assert match, "theDAW.sh no longer has the port loop this test reads"
    found = tuple(int(p) for p in match.group(1).split())
    assert found == ports.ALL_PORTS


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
    monkeypatch.setattr(ports, "_is_ours", lambda name, cmdline, cwd="": False)
    stopped, refused = ports.free_ports([bound_port])
    assert stopped == []
    assert ports.is_port_free(bound_port) is False
    assert all(h.ours is False for h in refused)


def test_free_ports_skips_this_very_process(bound_port: int, monkeypatch):
    monkeypatch.setattr(ports, "_is_ours", lambda name, cmdline, cwd="": True)
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

    monkeypatch.setattr(ports, "_is_ours", lambda name, cmdline, cwd="": False)
    ports._main(["--free"])
    capsys.readouterr().out.encode("ascii")


def test_port_in_use_exit_code_cannot_be_mistaken_for_a_respawn():
    """backend/_supervisor.py respawns on 88 (restart) and 89 (update) and
    terminates on anything else. A port clash must terminate, not loop."""
    from backend._supervisor import RESTART_EXIT_CODE
    from backend._update_sync import UPDATE_EXIT_CODE
    from backend.run import PORT_IN_USE_EXIT_CODE

    assert PORT_IN_USE_EXIT_CODE not in (0, RESTART_EXIT_CODE, UPDATE_EXIT_CODE)
