"""theDAW's own TCP ports, and one cross-platform way to inspect or free them.

Why this module exists: ``theDAW.bat`` and ``theDAW.sh`` both clear these ports
before starting, each with a shell pipeline of its own (``netstat | findstr |
taskkill`` on Windows, ``fuser`` with an ``lsof`` fallback on POSIX). The
**Pinokio launcher had neither** — its steps are JSON, with no good place to put
a three-platform shell pipeline — which is how a Pinokio Start on a machine that
already had a backend running died with

    ERROR: [Errno 10048] error while attempting to bind on address
    ('0.0.0.0', 8600): only one usage of each socket address ... is permitted

and Pinokio then reported the whole failure as the event ``["Errno "]``.

This gives every launcher one portable way to ask and to act:

    python -m backend.ports --check     # report, exit 1 if anything is bound
    python -m backend.ports --free      # stop theDAW's own stale listeners
    python -m backend.ports --free --all-ports

``theDAW.bat`` and ``theDAW.sh`` deliberately KEEP their native pipelines: they
are a process spawn cheaper than starting Python, and they still work when the
venv is half-built — which is a state the .bat is specifically written to
survive. The port numbers here are the single source of truth for all three, and
``tests/test_ports.py`` asserts the table still matches what they clear.

``--free`` is deliberately conservative: it only kills a process it can identify
as theDAW's own (see :func:`_is_ours`). A foreign program sitting on 8600 is
reported and left alone — taking down somebody's unrelated server because it
picked the same port would be far worse than refusing to start.

psutil is a base dependency (``pyproject.toml``), so this works the same on
Windows, macOS and Linux with no shell pipelines.
"""

from __future__ import annotations

import argparse
import os
import socket
import sys
from dataclasses import dataclass
from typing import Iterable, Optional

# The backend's HTTP port. Everything else in the app derives from it.
BACKEND_PORT = 8600
# The Vite dev server.
FRONTEND_PORT = 5173
# The sidecars theDAW.bat and theDAW.sh also clear: VJ, Sway and the tunnel.
SIDECAR_PORTS = (5187, 5188, 5472)

#: Every port a launcher clears, in the order the shipped launchers list them.
ALL_PORTS: tuple[int, ...] = (FRONTEND_PORT, BACKEND_PORT, *SIDECAR_PORTS)

#: What ``--free`` touches by default: the two that actually block a start.
DEFAULT_PORTS: tuple[int, ...] = (FRONTEND_PORT, BACKEND_PORT)

# Process names we are willing to kill when they hold one of our ports. A bare
# "python" is included because that IS how the backend runs; the name alone is
# never enough, which is why _is_ours also checks the command line.
_OUR_EXE_HINTS = ("python", "pythonw", "node", "uv", "electron", "thedaw")

# Substrings that identify one of OUR processes in a command line.
_OUR_CMDLINE_HINTS = (
    "backend.run",
    "backend._supervisor",
    "backend._devstack",
    "backend.server",
    "thedaw",
    "vite",
)


@dataclass(frozen=True)
class Holder:
    """A process listening on one of our ports."""

    port: int
    pid: int
    name: str
    cmdline: str
    ours: bool

    def describe(self) -> str:
        who = "theDAW" if self.ours else "another program"
        return f"port {self.port}: {who} - {self.name} (pid {self.pid})"


def is_port_free(port: int, host: str = "127.0.0.1") -> bool:
    """Can we connect to ``port``? False means something is listening.

    A connect probe rather than a bind probe: binding to test would itself
    briefly occupy the port, and on Windows a bind test against 0.0.0.0 can
    succeed while the real bind later fails because of SO_EXCLUSIVEADDRUSE.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.35)
        return probe.connect_ex((host, port)) != 0


def _is_ours(name: str, cmdline: str) -> bool:
    """Is this process one of theDAW's, rather than an unrelated server?

    Both halves must agree: the executable looks like something we launch AND
    the command line names one of our entry points. `python` alone is not
    evidence — the user may well be running their own server.
    """
    low_name = (name or "").lower()
    low_cmd = (cmdline or "").lower()
    if not any(hint in low_name for hint in _OUR_EXE_HINTS):
        return False
    return any(hint in low_cmd for hint in _OUR_CMDLINE_HINTS)


def holders(ports: Iterable[int]) -> list[Holder]:
    """Who is listening on each of ``ports``. Empty when psutil cannot look.

    Never raises: enumerating connections needs privileges we may not have, and
    a launcher must still be able to start (or to report honestly) without it.
    """
    try:
        import psutil
    except ImportError:  # pragma: no cover - psutil is a base dependency
        return []

    wanted = set(ports)
    found: list[Holder] = []
    seen: set[tuple[int, int]] = set()
    try:
        conns = psutil.net_connections(kind="inet")
    except (psutil.AccessDenied, PermissionError, OSError):
        return []

    for conn in conns:
        if conn.status != psutil.CONN_LISTEN or not conn.laddr:
            continue
        port = conn.laddr.port
        if port not in wanted or conn.pid is None:
            continue
        key = (port, conn.pid)
        if key in seen:
            continue
        seen.add(key)
        name, cmdline = "", ""
        try:
            proc = psutil.Process(conn.pid)
            name = proc.name()
            cmdline = " ".join(proc.cmdline())
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
        found.append(
            Holder(
                port=port,
                pid=conn.pid,
                name=name or "?",
                cmdline=cmdline,
                ours=_is_ours(name, cmdline),
            )
        )
    return found


def free_ports(
    ports: Iterable[int] = DEFAULT_PORTS,
) -> tuple[list[Holder], list[Holder]]:
    """Stop theDAW's own listeners on ``ports``.

    Returns ``(killed, refused)``. ``refused`` holds every listener that is NOT
    ours; the caller decides whether that is fatal. Terminate first, then kill
    what has not gone after a short grace — a backend asked to terminate closes
    its DB cleanly, and the library DB is the user's work.
    """
    try:
        import psutil
    except ImportError:  # pragma: no cover
        return [], []

    killed: list[Holder] = []
    refused: list[Holder] = []
    targets: list[tuple[Holder, "psutil.Process"]] = []
    ourselves = os.getpid()

    for holder in holders(ports):
        if not holder.ours or holder.pid == ourselves:
            if not holder.ours:
                refused.append(holder)
            continue
        try:
            targets.append((holder, psutil.Process(holder.pid)))
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    for _holder, proc in targets:
        try:
            proc.terminate()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    gone, alive = psutil.wait_procs([p for _h, p in targets], timeout=3)
    for proc in alive:
        try:
            proc.kill()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    if alive:
        psutil.wait_procs(alive, timeout=2)
    killed = [h for h, _p in targets]
    return killed, refused


def describe_occupant(port: int = BACKEND_PORT) -> Optional[str]:
    """One sentence naming who holds ``port``, or None if it is free.

    Used by :mod:`backend.run` to replace the raw ``[Errno 10048]`` with
    something a user can act on.
    """
    if is_port_free(port):
        return None
    found = [h for h in holders([port])]
    if not found:
        return (
            f"Port {port} is already in use, but this process cannot see which program holds it "
            "(that usually needs administrator rights). Close any other copy of theDAW and try again."
        )
    holder = found[0]
    if holder.ours:
        return (
            f"theDAW's backend is already running on port {port} ({holder.name}, pid {holder.pid}). "
            "Close the other theDAW window, or use it: two backends cannot share the port."
        )
    return (
        f"Port {port} is held by another program: {holder.name} (pid {holder.pid}). "
        "Close it and start theDAW again."
    )


def _main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m backend.ports",
        description="Inspect or free the TCP ports theDAW uses.",
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--check",
        action="store_true",
        help="report what is bound; exit 1 if anything is",
    )
    mode.add_argument(
        "--free", action="store_true", help="stop theDAW's own stale listeners"
    )
    parser.add_argument(
        "--all-ports",
        action="store_true",
        help=f"act on every port ({', '.join(map(str, ALL_PORTS))}) rather than just {', '.join(map(str, DEFAULT_PORTS))}",
    )
    args = parser.parse_args(argv)
    ports = ALL_PORTS if args.all_ports else DEFAULT_PORTS

    if args.check:
        bound = holders(ports)
        busy = [p for p in ports if not is_port_free(p)]
        if not busy:
            print(f"[ports] free: {', '.join(map(str, ports))}")
            return 0
        for holder in bound:
            print(f"[ports] {holder.describe()}")
        unexplained = sorted(set(busy) - {h.port for h in bound})
        for port in unexplained:
            print(f"[ports] port {port}: in use by a process this user cannot see")
        return 1

    killed, refused = free_ports(ports)
    for holder in killed:
        print(
            f"[ports] stopped theDAW's stale listener on port {holder.port} (pid {holder.pid})"
        )
    for holder in refused:
        print(
            f"[ports] LEFT ALONE {holder.describe()} - theDAW will not kill another program's process"
        )
    if not killed and not refused:
        print(f"[ports] nothing to free on {', '.join(map(str, ports))}")
    # Freeing is best-effort by design: a launcher should carry on and let the
    # bind itself be the authority, with backend.run's message if it fails.
    return 0


if __name__ == "__main__":
    sys.exit(_main())
