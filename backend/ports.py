"""theDAW's own TCP ports, and one cross-platform way to inspect or free them.

``theDAW.bat`` and ``theDAW.sh`` once cleared these ports each with a shell
pipeline of its own (``netstat | findstr | taskkill`` on Windows, ``fuser`` with
an ``lsof`` fallback on POSIX). The Pinokio launcher had neither, because its
steps are JSON with nowhere to put a three-platform pipeline, which is how a
Pinokio Start on a machine that already had a backend running died with

    ERROR: [Errno 10048] error while attempting to bind on address
    ('0.0.0.0', 8600): only one usage of each socket address ... is permitted

and Pinokio then reported the whole failure as the event ``["Errno "]``.

This gives every launcher one portable way to ask and to act:

    python -m backend.ports --check     # report, exit 1 if anything is bound
    python -m backend.ports --free      # stop theDAW's own stale listeners
    python -m backend.ports --free --all-ports
    python -m backend.ports --require-frontend-port   # exit 1 if 5173 is taken

All three shipped launchers (``theDAW.bat``, ``theDAW-desktop.bat``,
``theDAW.sh``) now call ``--free --all-ports`` instead of their old native
``netstat | taskkill`` / ``fuser -k`` pipelines: those stopped WHATEVER held a
port, which on a developer's machine is as likely to be another project's Vite
on 5173 as a stale theDAW. ``--free`` stops only listeners running FROM THIS
CHECKOUT and leaves everyone else's alone. The port numbers here are the single
source of truth, and ``tests/test_ports.py`` reads all three launchers to prove
they still go through this module and never signal a pid or an image name they
looked up themselves.

Identity, because ``--free`` kills things
-----------------------------------------
A process is ours only when it is running FROM THIS CHECKOUT: its command line
or its working directory has to name this repository's root or a path inside
it. Matching on the command line alone was not enough -- ``vite`` appears in
every Vite dev server on the machine, so an unrelated project on port 5173
looked exactly like ours. The root is matched as a whole folder name, so a
sibling such as ``theDAW-Pinokio`` or a ``theDAW-<branch>`` worktree beside
this checkout is somebody else.

theDAW's Node sidecars are matched the same way against their OWN project
folders: Lyria and VJ run from a bundled folder inside this checkout or, when
that is missing, from a clone beside it (``lyria-3-pro``, ``GANTASMO-LIVE-VJ``),
and the Lyria and Foundry listeners run ``tsx server.ts`` or
``node dist/server.cjs``, which name no backend entry point. A clone beside the
checkout is shared by every checkout next to it, so a sidecar whose parent
chain leads to another checkout's running backend is that checkout's.

The PID is revalidated against the process creation time immediately before any
signal. A PID identified during the scan can exit and be reused by the OS before
the signal lands, and Windows recycles PIDs aggressively.

Shutdown, cleanest first
------------------------
For the backend port, ``--free`` first asks the running instance to stop through
``POST /api/admin/shutdown``, which runs the app's shutdown handlers -- the
live VST hosts, each of which saves its plugin state, then the background
queue, the assistant's ``claude`` children and every sidecar -- before the
process exits. Only if that is refused or times out does it signal the process. This
matters on Windows, where ``psutil.terminate()`` is ``TerminateProcess`` -- not a
catchable SIGTERM -- so signalling a backend mid-write is exactly as abrupt as
killing it.

Listing listeners on macOS
--------------------------
``psutil.net_connections()`` walks every process on the machine, and on macOS it
raises AccessDenied unless it runs as root, which a launcher never does. There
the listeners come from ``lsof`` run as the user, which lists that user's own
sockets: every process theDAW starts.
"""

from __future__ import annotations

import argparse
import importlib
import os
import re
import shutil
import socket
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

# The backend's HTTP port. Everything else in the app derives from it.
BACKEND_PORT = 8600
# The Vite dev server.
FRONTEND_PORT = 5173
# The second Vite listener, the one with TLS, that makes theDAW reachable from
# another device on the LAN as a SECURE CONTEXT. Browsers hand out
# AudioContext.audioWorklet, the microphone, Web MIDI, the clipboard and
# crypto.subtle only over https:// or localhost, so a phone or a second PC on
# plain http://<lan-ip>:5173 gets an EDIT tab with no audio engine at all.
LAN_HTTPS_PORT = 5443
# The sidecars every launcher also clears: VJ (5187), Lyria (5188) and the VST
# Foundry (5472). Each module's DEFAULT_PORT is the authority for its number.
SIDECAR_PORTS = (5187, 5188, 5472)

#: Every port a launcher clears, in the order the shipped launchers list them.
ALL_PORTS: tuple[int, ...] = (
    FRONTEND_PORT,
    LAN_HTTPS_PORT,
    BACKEND_PORT,
    *SIDECAR_PORTS,
)

#: What ``--free`` touches by default: the two that actually block a start.
DEFAULT_PORTS: tuple[int, ...] = (FRONTEND_PORT, BACKEND_PORT)

#: How the launcher tells this process which port the web UI REALLY took.
FRONTEND_PORT_ENV = "theDAW_FRONTEND_PORT"


def frontend_port() -> int:
    """The port the web UI is serving on this launch.

    The launchers start the web UI on ``FRONTEND_PORT`` only, and stop with the
    holder's name when another program has it (:func:`frontend_port_blocker`).
    Whoever started the web UI still exports the port it serves on as
    ``theDAW_FRONTEND_PORT`` for the backend child -- ``backend/_devstack.py``
    in web mode, the desktop shell from its renderer URL -- and anything that
    ADVERTISES the web UI's address, the Mobile Access link and QR code from
    ``GET /api/network/lan`` above all, reads it here, so the address a second
    device is sent to is the one actually serving theDAW.

    Anything unusable in the environment (empty, not a number, out of the 1-65535
    range) falls back to the table rather than raising: a bad value must not stop
    the backend from answering at all.
    """
    raw = os.environ.get(FRONTEND_PORT_ENV, "").strip()
    try:
        port = int(raw)
    except ValueError:
        return FRONTEND_PORT
    return port if 1 <= port <= 65535 else FRONTEND_PORT


# Binaries we are willing to signal. Necessary but never sufficient; see
# _is_ours, which also requires the process to live in this checkout.
_OUR_EXE_HINTS = ("python", "pythonw", "node", "uv", "electron", "thedaw")

# The backend's own entry points: what a process that starts sidecars runs.
_BACKEND_ENTRY_POINTS = (
    "backend.run",
    "backend._supervisor",
    "backend._devstack",
    "backend.server",
)

# Entry points that identify one of OUR processes, once the checkout matches.
_OUR_CMDLINE_HINTS = (
    *_BACKEND_ENTRY_POINTS,
    "vite",
    "npm",
)

# theDAW's Node sidecars: the module that owns each one, and the entry points
# its LISTENING process names. Lyria's `npm run dev` is `tsx server.ts`; the
# Foundry runs `node dist/server.cjs`, or `tsx server.ts` in its dev mode; VJ
# runs its project's own vite. The folder each one runs from comes from that
# module's resolve_config(), so theDAW_LYRIA_PROJECT / THEDAW_FOUNDRY_PROJECT /
# theDAW_VJ_PROJECT move the match exactly where they move the sidecar.
_SIDECARS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("backend.modules.lyria.sidecar", ("server.ts",)),
    ("backend.modules.foundry.sidecar", ("server.cjs", "server.ts")),
    ("backend.modules.vj.sidecar", ("vite",)),
)

# How long to wait for a clean HTTP shutdown before signalling instead. Longer
# than the backend's own budget for its shutdown handlers (admin_routes'
# SHUTDOWN_HANDLER_BUDGET_SEC, plus the delay before they start), so a backend
# saving its live plugins' state is never signalled halfway through.
_CLEAN_SHUTDOWN_TIMEOUT = 20.0


def repo_root() -> Path:
    """This checkout's root: the directory holding ``backend/``."""
    return Path(__file__).resolve().parent.parent


def _norm(text: str) -> str:
    """``text`` with ``/`` separators, for path comparison; lower case on
    Windows only.

    A Windows command line mixes ``/`` and ``\\`` freely and a drive letter's
    case is not stable. Linux and macOS paths keep their case: ``/srv/theDAW``
    and ``/srv/thedaw`` are two checkouts there.
    """
    text = text.replace("\\", "/")
    return text.lower() if os.name == "nt" else text


def _names_folder(folder: Path | str, text: str) -> bool:
    """Does ``text`` name ``folder`` itself or a path inside it?

    The folder has to end where a path component ends: at a separator, a
    quote, whitespace or the end of the text. A plain substring test counted
    ``.../Dev/theDAW-Pinokio/...`` and every ``theDAW-<branch>`` worktree as
    inside ``.../Dev/theDAW``, so ``--free`` stopped another checkout's backend.
    """
    if not text:
        return False
    root = _norm(str(folder)).rstrip("/")
    if not root:
        return False
    return re.search(re.escape(root) + r"(?=[/\"'\s]|$)", _norm(text)) is not None


def _same_tree(text: str) -> bool:
    """Does ``text`` point at this checkout or inside it?"""
    return _names_folder(repo_root(), text)


def _sidecar_folders() -> list[tuple[Path, tuple[str, ...]]]:
    """``(project folder, entry points)`` for every sidecar module that loads.

    Imported here rather than at the top: this module runs in a launcher before
    anything else, and the sidecar modules are only needed once a listener has
    already failed the backend rule. One that cannot be imported or configured
    is left out, so a broken sidecar module never stops a launch.
    """
    found: list[tuple[Path, tuple[str, ...]]] = []
    for module_name, entries in _SIDECARS:
        try:
            module = importlib.import_module(module_name)
            folder = Path(module.resolve_config().project_path)
        except Exception:
            continue
        found.append((folder, entries))
    return found


def _started_by_another_checkout(pid: int) -> bool:
    """Was process ``pid`` started by a backend running from another checkout?

    Walks the parent chain to the nearest process that runs a backend entry
    point and asks whether that backend is this checkout's. Lyria and VJ can
    run from a folder BESIDE the repository (``Dev/lyria-3-pro``), and every
    checkout beside it -- theDAW-Pinokio, a worktree -- resolves to that same
    folder, so the folder alone cannot say whose a running sidecar is. A
    sidecar whose backend is gone (the stale case ``--free`` exists for) or
    was this checkout's has no such parent, and anything unreadable counts as
    no such parent too.
    """
    try:
        import psutil

        chain = psutil.Process(pid).parents()
    except Exception:
        return False
    for parent in chain:
        try:
            cmd = _norm(" ".join(parent.cmdline()))
        except (psutil.Error, OSError):
            continue
        if not any(hint in cmd.lower() for hint in _BACKEND_ENTRY_POINTS):
            continue
        try:
            cwd = parent.cwd()
        except (psutil.Error, OSError):
            cwd = ""
        return not (_same_tree(cmd) or _same_tree(cwd))
    return False


def _is_our_sidecar(cmdline: str, cwd: str, pid: Optional[int] = None) -> bool:
    """Is this listener one of theDAW's sidecars, running from its own folder
    and not started by another checkout's backend?"""
    low_cmd = (cmdline or "").lower()
    for folder, entries in _sidecar_folders():
        if not any(entry in low_cmd for entry in entries):
            continue
        # The folder match reads the command line as written: path case is
        # folded on Windows only (see ``_norm``).
        if _names_folder(folder, cmdline or "") or _names_folder(folder, cwd or ""):
            return pid is None or not _started_by_another_checkout(pid)
    return False


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
    #: The process's working directory, when the OS let us read it.
    cwd: str = ""

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


#: Do the servers theDAW launches set SO_REUSEADDR before they bind? asyncio's
#: create_server defaults ``reuse_address`` to this same test, and libuv sets
#: the option on every POSIX TCP bind.
_SERVERS_REUSE_ADDRESS = os.name == "posix" and sys.platform != "cygwin"


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
    address and SO_REUSEADDR semantics the servers use.
    """
    if _listening_pids(port):
        return False
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        if _SERVERS_REUSE_ADDRESS:
            # uvicorn (asyncio's create_server) and Vite (Node/libuv) both set
            # SO_REUSEADDR on POSIX, so their bind succeeds while sockets from a
            # just-stopped server sit in TIME_WAIT. Without it this probe fails
            # with EADDRINUSE for up to a minute after --free stops a stale
            # server, and the launcher refuses a port nothing holds.
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        # Never on Windows: neither server sets it there, SO_REUSEADDR on
        # Windows lets a bind share a port a live listener holds, and Windows
        # binds through TIME_WAIT without it.
        try:
            probe.bind((host, port))
        except OSError:
            return False
    # Nothing in the table and the wildcard bind succeeded. One more connect
    # probe catches a listener the table hid from an unprivileged caller.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.35)
        return probe.connect_ex(("127.0.0.1", port)) != 0


def _is_ours(name: str, cmdline: str, cwd: str = "", pid: Optional[int] = None) -> bool:
    """Is this process theDAW's, running from THIS checkout?

    All three of these have to agree, because ``--free`` kills what it matches:
    the binary is one we launch, the command line names one of our entry points,
    and either the command line or the working directory is inside this
    repository. Without the last one, every Vite dev server on the machine
    matched, and ``--free`` would have killed an unrelated project's.

    A sidecar passes the same three checks against its own entry points and its
    own project folder (see ``_SIDECARS``), and with ``pid`` given it must not
    have been started by another checkout's backend.
    """
    low_name = (name or "").lower()
    low_cmd = (cmdline or "").lower()
    if not any(hint in low_name for hint in _OUR_EXE_HINTS):
        return False
    if any(hint in low_cmd for hint in _OUR_CMDLINE_HINTS) and (
        _same_tree(cmdline or "") or _same_tree(cwd or "")
    ):
        return True
    return _is_our_sidecar(cmdline or "", cwd or "", pid)


# Where macOS and most Linux distributions keep lsof, for a launcher whose PATH
# leaves out the sbin directories.
_LSOF_FALLBACKS = ("/usr/sbin/lsof", "/usr/bin/lsof")


def _lsof_listeners(wanted: set[int]) -> list[tuple[int, int]]:
    """``(port, pid)`` for every TCP listener ``lsof`` shows on ``wanted``.

    The macOS path: see the module docstring. ``-F pn`` prints one ``p<pid>``
    line per process followed by its files, each with an ``n<address>`` line
    such as ``n*:8600``, ``n127.0.0.1:5173`` or ``n[::1]:5173``. lsof exits 1
    when some process could not be read, and what it did print is still right,
    so the exit code is not a verdict.
    """
    lsof = shutil.which("lsof") or next(
        (p for p in _LSOF_FALLBACKS if os.path.exists(p)), None
    )
    if lsof is None:
        return []
    # Here, not at the top: backend.lib's package import costs a launcher
    # about a quarter of a second, and only this macOS fallback needs it.
    from backend.lib.launch_token import child_env

    try:
        done = subprocess.run(
            [lsof, "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
            # The launch token stays with the backend (backend.lib.launch_token).
            env=child_env(),
        )
    except (OSError, subprocess.SubprocessError):
        return []
    found: list[tuple[int, int]] = []
    pid: Optional[int] = None
    for line in (done.stdout or "").splitlines():
        if line.startswith("p"):
            try:
                pid = int(line[1:])
            except ValueError:
                pid = None
        elif line.startswith("n") and pid is not None:
            try:
                port = int(line[1:].rsplit(":", 1)[-1])
            except ValueError:
                continue
            if port in wanted and (port, pid) not in found:
                found.append((port, pid))
    return found


def holders(ports: Iterable[int]) -> list[Holder]:
    """Who is listening on each of ``ports``. Empty when nothing can look.

    Never raises: enumerating connections needs privileges we may not have, and
    a launcher must still start, or report honestly, without them. When psutil
    is refused (macOS without root), ``lsof`` answers instead.
    """
    try:
        import psutil
    except ImportError:  # pragma: no cover - psutil is a base dependency
        return []

    wanted = set(ports)
    listening: list[tuple[int, int]] = []
    try:
        conns = psutil.net_connections(kind="inet")
    except (psutil.AccessDenied, PermissionError):
        listening = _lsof_listeners(wanted)
    except OSError:
        return []
    else:
        for conn in conns:
            if conn.status != psutil.CONN_LISTEN or not conn.laddr:
                continue
            if conn.laddr.port in wanted and conn.pid is not None:
                listening.append((conn.laddr.port, conn.pid))

    found: list[Holder] = []
    seen: set[tuple[int, int]] = set()
    for port, pid in listening:
        key = (port, pid)
        if key in seen:
            continue
        seen.add(key)
        name, cmdline, cwd, created = "", "", "", None
        try:
            proc = psutil.Process(pid)
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
                pid=pid,
                name=name or "?",
                cmdline=cmdline,
                ours=_is_ours(name, cmdline, cwd, pid),
                create_time=created,
                cwd=cwd,
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

    ``POST /api/admin/shutdown`` runs the app's shutdown handlers before the
    process exits (see the module docstring), which signalling the process does
    not: on Windows ``psutil.terminate()`` is ``TerminateProcess``, so it is
    every bit as abrupt as ``kill()`` and can cut a write in half.
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
    stopped.extend(h for h, p in targets if h.pid in exited or _has_exited(psutil, p))
    return stopped, refused


def _has_exited(psutil, proc) -> bool:
    """Whether ``proc`` no longer runs: it is gone, or it is a zombie.

    ``wait_procs`` reports a child as gone only once its parent reaps it. A
    sidecar whose parent (another backend, a shell) never waits on it stays
    a zombie on Linux and macOS after the signal, and a zombie holds no
    port, so it counts as stopped.
    """
    try:
        return proc.status() == psutil.STATUS_ZOMBIE
    except (psutil.NoSuchProcess, psutil.ZombieProcess):
        return True
    except psutil.AccessDenied:
        return False


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


def frontend_port_blocker(port: Optional[int] = None) -> Optional[str]:
    """Why theDAW's web UI cannot start on ``port``, or None when it can.

    ``port`` defaults to ``FRONTEND_PORT``, read at call time.

    The web UI does not move to another port when this one is taken. A browser
    keeps theDAW's saved settings (every store the frontend persists in
    localStorage) and its microphone and MIDI permissions per ORIGIN, and the
    port is part of the origin. On 5174 the app opens with every setting at its
    default and every permission un-granted, and whatever the user changes
    there is missing again the next time theDAW gets 5173. Stopping with the
    holder's name loses nothing; the launchers print this and stop.
    """
    if port is None:
        port = FRONTEND_PORT
    if is_port_free(port):
        return None
    why = (
        f"theDAW's web UI runs only on port {port}: your browser keeps theDAW's "
        "saved settings and its microphone and MIDI permissions under that one "
        "address, and on any other port they would all start empty."
    )
    found = holders([port])
    if not found:
        return (
            f"Port {port} is already in use, but this process cannot see which "
            "program holds it (that usually needs administrator rights). "
            f"{why} Close the other program, then start theDAW again."
        )
    holder = found[0]
    safe = holder.name.encode("ascii", "backslashreplace").decode("ascii")
    where = ""
    if holder.cwd:
        folder = holder.cwd.encode("ascii", "backslashreplace").decode("ascii")
        where = f", running in {folder}"
    if holder.ours:
        return (
            f"theDAW's web UI from this folder is still running on port {port} "
            f"({safe}, pid {holder.pid}) and could not be stopped. Close the "
            "other theDAW window, then start theDAW again."
        )
    return (
        f"Port {port} is held by another program: {safe} (pid {holder.pid}{where}). "
        f"{why} Close that program, then start theDAW again."
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
    mode.add_argument(
        "--require-frontend-port",
        action="store_true",
        help=(
            f"exit 1, naming the program, when anything else holds port "
            f"{FRONTEND_PORT}, the only port the web UI runs on"
        ),
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

    if args.require_frontend_port:
        blocker = frontend_port_blocker()
        if blocker is None:
            return 0
        print(f"[ports] theDAW cannot start: {blocker}")
        return 1

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
