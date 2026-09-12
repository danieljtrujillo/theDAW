"""theDAW's port preflight.

The bug these cover: a Pinokio Start on a machine that already had a backend
running died with uvicorn's raw ``[Errno 10048] ... only one usage of each
socket address`` and Pinokio reported it as the event ``["Errno "]``. Nothing
told the user what to close.
"""

from __future__ import annotations

import socket
from contextlib import closing

import pytest

from backend import ports


@pytest.fixture
def bound_port():
    """A real listening socket on an ephemeral port, closed afterwards."""
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as srv:
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        yield srv.getsockname()[1]


def test_port_tables_agree_with_the_shipped_launchers():
    # theDAW.bat and theDAW.sh both clear exactly these five.
    assert ports.ALL_PORTS == (5173, 8600, 5187, 5188, 5472)
    assert ports.BACKEND_PORT == 8600
    assert ports.FRONTEND_PORT == 5173
    # --free defaults to the two that actually block a start, and both are in
    # the full list.
    assert set(ports.DEFAULT_PORTS) <= set(ports.ALL_PORTS)
    assert ports.BACKEND_PORT in ports.DEFAULT_PORTS


def test_is_port_free_sees_a_real_listener(bound_port: int):
    assert ports.is_port_free(bound_port) is False


def test_is_port_free_on_an_unused_port():
    # Bind, read the number, close: nothing is listening there now.
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as probe:
        probe.bind(("127.0.0.1", 0))
        free = probe.getsockname()[1]
    assert ports.is_port_free(free) is True


def test_describe_occupant_is_none_when_the_port_is_free():
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as probe:
        probe.bind(("127.0.0.1", 0))
        free = probe.getsockname()[1]
    assert ports.describe_occupant(free) is None


def test_describe_occupant_names_the_port_and_says_what_to_do(bound_port: int):
    """The whole point: a sentence instead of an errno."""
    msg = ports.describe_occupant(bound_port)
    assert msg is not None
    assert str(bound_port) in msg
    # Never leak the raw socket error the user could not act on.
    assert "Errno" not in msg
    assert "10048" not in msg
    # Always ends in something to DO.
    assert "try again" in msg.lower() or "close" in msg.lower()


def test_describe_occupant_recognises_our_own_process(bound_port: int, monkeypatch):
    """This test process holds the socket, so with our own cmdline hints in
    place the message must say it is theDAW rather than a stranger."""
    monkeypatch.setattr(ports, "_OUR_EXE_HINTS", ("python", "pytest"))
    monkeypatch.setattr(ports, "_OUR_CMDLINE_HINTS", ("pytest", "backend.run"))
    msg = ports.describe_occupant(bound_port)
    assert msg is not None
    # Either it identified us, or it could not read the process table at all
    # (CI sandboxes deny that) — in which case it must SAY it could not tell.
    assert (
        "theDAW's backend is already running" in msg
        or "cannot see which program" in msg
    )


@pytest.mark.parametrize(
    ("name", "cmdline", "expected"),
    [
        ("python.exe", "python -m backend.run", True),
        ("python.exe", "python -m backend._supervisor", True),
        ("node.exe", "node vite dev", True),
        # A stranger's server that merely happens to be python: NOT ours.
        ("python.exe", "python -m http.server 8600", False),
        ("python.exe", "python manage.py runserver", False),
        # Right command line, wrong kind of binary.
        ("nginx.exe", "nginx -g daemon off; backend.run", False),
        ("", "", False),
    ],
)
def test_is_ours_needs_both_the_binary_and_the_command_line(name, cmdline, expected):
    assert ports._is_ours(name, cmdline) is expected


def test_free_ports_never_kills_a_foreign_listener(bound_port: int, monkeypatch):
    """A program that is not ours is reported, never terminated. Killing an
    unrelated server because it picked our port would be worse than refusing
    to start."""
    monkeypatch.setattr(ports, "_is_ours", lambda name, cmdline: False)
    killed, refused = ports.free_ports([bound_port])
    assert killed == []
    # It is still listening.
    assert ports.is_port_free(bound_port) is False
    # Either it was reported as foreign, or the process table was unreadable.
    assert all(h.ours is False for h in refused)


def test_free_ports_skips_this_very_process(bound_port: int, monkeypatch):
    """Guard against the launcher killing itself: free_ports must never
    terminate its own pid even when it matches every 'ours' hint."""
    monkeypatch.setattr(ports, "_is_ours", lambda name, cmdline: True)
    killed, _refused = ports.free_ports([bound_port])
    import os

    assert all(h.pid != os.getpid() for h in killed)
    assert ports.is_port_free(bound_port) is False


def test_holders_never_raises_without_psutil(monkeypatch):
    """A launcher must still run if psutil cannot enumerate connections."""
    import builtins

    real_import = builtins.__import__

    def no_psutil(name, *args, **kwargs):
        if name == "psutil":
            raise ImportError("no psutil")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_psutil)
    assert ports.holders([8600]) == []
    assert ports.free_ports([8600]) == ([], [])


def test_check_exits_nonzero_while_a_port_is_bound(
    bound_port: int, monkeypatch, capsys
):
    monkeypatch.setattr(ports, "DEFAULT_PORTS", (bound_port,))
    rc = ports._main(["--check"])
    assert rc == 1
    assert str(bound_port) in capsys.readouterr().out


def test_check_exits_zero_when_everything_is_free(monkeypatch, capsys):
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as probe:
        probe.bind(("127.0.0.1", 0))
        free = probe.getsockname()[1]
    monkeypatch.setattr(ports, "DEFAULT_PORTS", (free,))
    rc = ports._main(["--check"])
    assert rc == 0
    assert "free" in capsys.readouterr().out


def test_free_reports_success_even_with_nothing_to_do(monkeypatch, capsys):
    """--free is best-effort: a launcher carries on and lets the real bind be
    the authority, so it must not fail the launch by exiting non-zero."""
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as probe:
        probe.bind(("127.0.0.1", 0))
        free = probe.getsockname()[1]
    monkeypatch.setattr(ports, "DEFAULT_PORTS", (free,))
    assert ports._main(["--free"]) == 0
    assert "nothing to free" in capsys.readouterr().out


def test_all_ports_flag_widens_the_set(monkeypatch, capsys):
    seen: list[tuple[int, ...]] = []
    monkeypatch.setattr(
        ports, "free_ports", lambda p: (seen.append(tuple(p)), ([], []))[1]
    )
    ports._main(["--free", "--all-ports"])
    assert seen == [ports.ALL_PORTS]


def test_every_user_facing_message_is_ascii(bound_port: int, monkeypatch, capsys):
    """These strings are printed to a PIPE by the launchers (Pinokio, the
    Electron shell, theDAW.bat). A pipe carries the locale encoding, so on a
    `LC_ALL=C` Linux box a prose em-dash raises UnicodeEncodeError and the
    message that was meant to explain the failure becomes a second failure."""
    msg = ports.describe_occupant(bound_port)
    assert msg is not None
    msg.encode("ascii")  # raises if a smart dash or quote crept back in

    monkeypatch.setattr(ports, "DEFAULT_PORTS", (bound_port,))
    ports._main(["--check"])
    out = capsys.readouterr().out
    out.encode("ascii")

    monkeypatch.setattr(ports, "_is_ours", lambda name, cmdline: False)
    ports._main(["--free"])
    capsys.readouterr().out.encode("ascii")


def test_port_in_use_exit_code_cannot_be_mistaken_for_a_respawn():
    """backend/_supervisor.py respawns on 88 (restart) and 89 (update) and
    terminates on anything else. A port clash must terminate, not loop."""
    from backend._supervisor import RESTART_EXIT_CODE
    from backend._update_sync import UPDATE_EXIT_CODE
    from backend.run import PORT_IN_USE_EXIT_CODE

    assert PORT_IN_USE_EXIT_CODE not in (0, RESTART_EXIT_CODE, UPDATE_EXIT_CODE)
