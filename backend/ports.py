"""theDAW's own TCP ports, and one cross-platform way to inspect or free them.

``theDAW.bat`` and ``theDAW.sh`` both clear these ports before starting, each
with a shell pipeline of its own (``netstat | findstr | taskkill`` on Windows,
``fuser`` with an ``lsof`` fallback on POSIX). The Pinokio launcher had neither,
because its steps are JSON with nowhere to put a three-platform pipeline, which
is how a Pinokio Start on a machine that already had a backend running died with

    ERROR: [Errno 10048] error while attempting to bind on address
    ('0.0.0.0', 8600): only one usage of each socket address ... is permitted

and Pinokio then reported the whole failure as the event ``["Errno "]``.

This gives every launcher one portable way to ask and to act:

    python -m backend.ports --check     # report, exit 1 if anything is bound
    python -m backend.ports --free      # stop theDAW's own stale listeners
    python -m backend.ports --free --all-ports

``theDAW.bat`` and ``theDAW.sh`` deliberately KEEP their native pipelines: they
are a process spawn cheaper than starting Python, and they still work when the
venv is half-built, a state the .bat is specifically written to survive. The port
numbers here are the single source of truth, and ``tests/test_ports.py`` parses
both launchers to prove their lists still match this table.

Identity, because ``--free`` kills things
-----------------------------------------
A process is ours only when it is running FROM THIS CHECKOUT: its command line
or its working directory has to contain this repository's root. Matching on the
command line alone was not enough -- ``vite`` appears in every Vite dev server on
the machine, so an unrelated project on port 5173 looked exactly like ours.

The PID is revalidated against the process creation time immediately before any
signal. A PID identified during the scan can exit and be reused by the OS before
the signal lands, and Windows recycles PIDs aggressively.

Shutdown, cleanest first
------------------------
For the backend port, ``--free`` first asks the running instance to stop through
``POST /api/admin/shutdown``, which runs FastAPI's shutdown handlers and closes
the library database. Only if that is refused or times out does it signal the
process. This matters on Windows, where ``psutil.terminate()`` is
``TerminateProcess`` -- not a catchable SIGTERM -- so signalling a backend
mid-write is exactly as abrupt as killing it.
"""

from __future__ import annotations

import argparse
import os
import socket
import sys
from dataclasses import dataclass
from pathlib import Path
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

# Binaries we are willing to signal. Necessary but never sufficient; see
# _is_ours, which also requires the process to live in this checkout.
_OUR_EXE_HINTS = ("python", "pythonw", "node", "uv", "electron", "thedaw")

# Entry points that identify one of OUR processes, once the checkout matches.
_OUR_CMDLINE_HINTS = (
    "backend.run",
    "backend._supervisor",
    "backend._devstack",
    "backend.server",
    "vite",
    "npm",
)

# How long to wait for a clean HTTP shutdown before signalling instead.
_CLEAN_SHUTDOWN_TIMEOUT = 6.0


def repo_root() -> Path:
    """This checkout's root: the directory holding ``backend/``."""
    return Path(__file__).resolve().parent.parent


def _same_tree(text: str) -> bool:
    """Does ``text`` point inside this checkout?

    Compared case-insensitively with both separators normalised, because a
    Windows command line mixes ``/`` and ``\\`` freely and a drive letter's case
    is not stable.
    """
    if not text:
        return False
    root = str(repo_root()).replace("\\", "/").lower()
    return root in text.replace("\\", "/").lower()


@dataclass(frozen=True)
class Holder:
    """A process listening on one of our ports, as seen during one scan."""

    port: int
    pid: int
    name: str
    cmdline: str
    ours: bool
    #: psutil's process creation time, used to prove the PID was not recycled.
    create_time: Optional[float] = None

    def describe(self) -> str:
        who = "theDAW" if self.ours else "another program"
        # The name comes from the OS and can hold anything. These strings are
        # printed to a pipe, which carries the locale encoding, so a non-ASCII
        # executable name would raise UnicodeEncodeError under LC_ALL=C and the
        # message explaining a failure would become a second failure.
        safe = self.name.encode("ascii", "backslashreplace").decode("ascii")
        return f"port {self.port}: {who} - {safe} (pid {self.pid})"


def _listening_pids(port: int) -> list[int]:
    """PIDs listening on ``port``, on any local address. Empty when unreadable."""
    return [h.pid for h in holders([port])]


def is_port_free(port: int, host: str = "0.0.0.0") -> bool:
    """Can theDAW bind ``port``? False means something already holds it.

    Three ways to be wrong here, all of which bit an earlier version:

    * A connect probe to 127.0.0.1 alone misses a listener bound to another
      local address, which still blocks the wildcard bind uvicorn does.
    * A bind probe alone can succeed on Windows against 0.0.0.0 while the real
      bind later fails, and on Linux a listener on 127.0.0.1 does not stop a
      0.0.0.0 bind from succeeding here while uvicorn's own fails.
    * Either probe alone is blind when the process table cannot be read.

    So: consult the listening table first, since it is the only authority that
    sees every address, and fall back to a bind attempt with the same wildcard
    address and SO_REUSEADDR semantics uvicorn uses.
    """
    if _listening_pids(port):
        return False
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        # Deliberately NOT SO_REUSEADDR: uvicorn does not set it on Windows, and
        # setting it here would make the probe succeed where the real bind fails.
        try:
            probe.bind((host, port))
        except OSError:
            return False
    # Nothing in the table and the wildcard bind succeeded. One more connect
    # probe catches a listener the table hid from an unprivileged caller.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.35)
        return probe.connect_ex(("127.0.0.1", port)) != 0


def _is_ours(name: str, cmdline: str, cwd: str = "") -> bool:
    """Is this process theDAW's, running from THIS checkout?

    All three of these have to agree, because ``--free`` kills what it matches:
    the binary is one we launch, the command line names one of our entry points,
    and either the command line or the working directory is inside this
    repository. Without the last one, every Vite dev server on the machine
    matched, and ``--free`` would have killed an unrelated project's.
    """
    low_name = (name or "").lower()
    low_cmd = (cmdline or "").lower()
    if not any(hint in low_name for hint in _OUR_EXE_HINTS):
        return False
    if not any(hint in low_cmd for hint in _OUR_CMDLINE_HINTS):
        return False
    return _same_tree(low_cmd) or _same_tree(cwd or "")


def holders(ports: Iterable[int]) -> list[Holder]:
    """Who is listening on each of ``ports``. Empty when psutil cannot look.

    Never raises: enumerating connections needs privileges we may not have, and
    a launcher must still start, or report honestly, without them.
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
        name, cmdline, cwd, created = "", "", "", None
        try:
            proc = psutil.Process(conn.pid)
            name = proc.name()
            cmdline = " ".join(proc.cmdline())
            created = proc.create_time()
            try:
                cwd = proc.cwd()
            except (psutil.AccessDenied, OSError):
                cwd = ""
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
        found.append(
            Holder(
                port=port,
                pid=conn.pid,
                name=name or "?",
                cmdline=cmdline,
                ours=_is_ours(name, cmdline, cwd),
                create_time=created,
            )
        )
    return found


def _still_the_same_process(holder: Holder) -> Optional["object"]:
    """The live process for ``holder``, or None if the PID no longer is it.

    A PID seen during the scan can exit and be reused before a signal lands, so
    the creation time is compared as well. Without this, ``--free`` could signal
    whatever inherited the number.
    """
    try:
        import psutil
    except ImportError:  # pragma: no cover
        return None
    try:
        proc = psutil.Process(holder.pid)
        if (
            holder.create_time is not None
            and abs(proc.create_time() - holder.create_time) > 0.001
        ):
            return None
        return proc
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return None


def _ask_backend_to_stop(port: int) -> bool:
    """Ask a theDAW backend on ``port`` to shut down cleanly. True if it did.

    ``POST /api/admin/shutdown`` runs FastAPI's shutdown handlers and closes the
    library database, which signalling the process does not: on Windows
    ``psutil.terminate()`` is ``TerminateProcess``, so it is every bit as abrupt
    as ``kill()`` and can cut a write in half.
    """
    import json
    import time
    import urllib.error
    import urllib.request

    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/admin/shutdown",
        data=b"",
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            if response.status >= 400:
                return False
            json.loads(response.read() or b"{}")
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return False

    deadline = time.monotonic() + _CLEAN_SHUTDOWN_TIMEOUT
    while time.monotonic() < deadline:
        if not _listening_pids(port):
            return True
        time.sleep(0.25)
    return False


def free_ports(
    ports: Iterable[int] = DEFAULT_PORTS,
) -> tuple[list[Holder], list[Holder]]:
    """Stop theDAW's own listeners on ``ports``.

    Returns ``(stopped, refused)``. ``stopped`` holds only processes that are
    genuinely gone -- reporting a kill that failed would tell a launcher the port
    was free when it is not. ``refused`` holds every listener that is not ours;
    the caller decides whether that is fatal.
    """
    try:
        import psutil
    except ImportError:  # pragma: no cover
        return [], []

    wanted = list(ports)
    refused: list[Holder] = []
    stopped: list[Holder] = []
    ourselves = os.getpid()
    targets: list[tuple[Holder, "psutil.Process"]] = []

    for holder in holders(wanted):
        if not holder.ours:
            refused.append(holder)
            continue
        if holder.pid == ourselves:
            continue
        # Cleanest route first, and it also removes this holder from the table.
        if holder.port == BACKEND_PORT and _ask_backend_to_stop(holder.port):
            stopped.append(holder)
            continue
        proc = _still_the_same_process(holder)
        if proc is None:
            # Already gone, or the PID is no longer this process. Either way
            # there is nothing of ours left to signal.
            continue
        targets.append((holder, proc))

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
        gone_after_kill, _still = psutil.wait_procs(alive, timeout=2)
        gone.extend(gone_after_kill)
    exited = {p.pid for p in gone}
    stopped.extend(h for h, _p in targets if h.pid in exited)
    return stopped, refused


def describe_occupant(port: int = BACKEND_PORT) -> Optional[str]:
    """One sentence naming who holds ``port``, or None if it is free.

    Used by :mod:`backend.run` to replace the raw ``[Errno 10048]`` with
    something a user can act on.
    """
    if is_port_free(port):
        return None
    found = holders([port])
    if not found:
        return (
            f"Port {port} is already in use, but this process cannot see which program holds it "
            "(that usually needs administrator rights). Close any other copy of theDAW and try again."
        )
    holder = found[0]
    safe = holder.name.encode("ascii", "backslashreplace").decode("ascii")
    if holder.ours:
        return (
            f"theDAW's backend is already running on port {port} ({safe}, pid {holder.pid}). "
            "Close the other theDAW window, or use it: two backends cannot share the port."
        )
    return (
        f"Port {port} is held by another program: {safe} (pid {holder.pid}). "
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
        help=(
            f"act on every port ({', '.join(map(str, ALL_PORTS))}) rather than just "
            f"{', '.join(map(str, DEFAULT_PORTS))}"
        ),
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

    stopped, refused = free_ports(ports)
    for holder in stopped:
        print(
            f"[ports] stopped theDAW's stale listener on port {holder.port} (pid {holder.pid})"
        )
    for holder in refused:
        print(
            f"[ports] LEFT ALONE {holder.describe()} - theDAW will not kill another program's process"
        )
    if not stopped and not refused:
        print(f"[ports] nothing to free on {', '.join(map(str, ports))}")
    # Freeing is best-effort by design: a launcher should carry on and let the
    # bind itself be the authority, with backend.run's message if it fails.
    return 0


if __name__ == "__main__":
    sys.exit(_main())
