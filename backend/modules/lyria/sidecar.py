"""Manage the Lyria 3 Pro Express server as a theDAW sidecar.

The Lyria project is its own repo (``StarskreamEXE/lyria-3-pro``), discovered
relative to this app or overridable via ``theDAW_LYRIA_PROJECT``. theDAW
embeds it whole: its frontend is served by its own Express server and is
kept as-is, per the integration constraint. We spawn it, we don't rebuild it.

WHY THERE IS NO STATIC MODE (the key difference from vj/sidecar.py):
the VJ app is a pure static SPA, so its compiled ``dist/`` IS the whole app
and the backend can serve it with no Node process. Lyria is not: its Express
server answers ``/api/ai/*``, ``/api/lyria/generate``, ``/api/generations``,
and mounts ``/generations`` static. The server is load-bearing, so the Node
process must always run. This module is therefore modeled on VJ's dev-mode
branch only.

The port (5188) deliberately avoids every port already in play:
  * 3000 is the user's explicit "never use this" — too many collisions.
  * 3001 is Lyria's own standalone default, and is NOT safe here: VS Code
    binds it on IPv6 (``::``) on at least one dev machine, and because
    Windows resolves ``localhost`` to ``::1`` first, every request silently
    times out against the squatter while Lyria sits healthy on IPv4.
  * 5173 is the theDAW frontend; 5174 is Vite's next-port fallback.
  * 5187 is the VJ sidecar.
  * 8600 is the theDAW backend; 5472 is in use elsewhere.
  * 5188 sits beside VJ's port, out of the way of all of the above.

Override with ``theDAW_LYRIA_PORT``.

COST SAFETY: every real Lyria 3 Pro generation costs $0.08 and every clip
$0.04, on the user's own key, with no seed and no reproducibility. This
sidecar therefore injects ``LYRIA_MOCK=1`` BY DEFAULT, which makes the child
synthesize a local WAV instead of calling either paid provider. Real spending
requires an explicit opt-in via ``theDAW_LYRIA_MOCK=0``. A mis-click in MAKE
costs nothing for SA3 or Magenta (both local); here it would cost money, so
the default is the safe one.

Lifecycle:
  * ``probe()`` -- does the project exist? Is the port listening? Are we
    in mock mode? Non-spawning; safe for /status.
  * ``ensure_running()`` -- lazy spawn, returns the live URL or raises
    RuntimeError with a diagnostic.
  * ``stop()`` -- terminates the subprocess (registered in
    backend/core/teardown.py, or Shutdown/Restart orphans it on its port).
"""

from __future__ import annotations

import logging
import os
import shutil
import socket
import subprocess
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import IO, Iterator, Optional

log = logging.getLogger(__name__)


# Repo root (.../stable-audio-3): backend/modules/lyria/sidecar.py -> parents[3].
_REPO_ROOT = Path(__file__).resolve().parents[3]


def _lyria_project_candidates() -> list[Path]:
    """Portable search order for the Lyria project when theDAW_LYRIA_PROJECT
    is unset. Ordered from "bundled inside the app" to "dev checkout near
    this repo". Every entry derives from this file's location, so it resolves
    the same on any install. First candidate with a package.json wins; if none
    do, the first is used so diagnostics name a path local to THIS install."""
    return [
        _REPO_ROOT / "lyria",  # bundled checkout inside the app (release layout)
        _REPO_ROOT.parent / "lyria-3-pro",  # sibling of the repo
        _REPO_ROOT.parent.parent / "lyria-3-pro",  # nested dev layout
    ]


def _default_project_path() -> Path:
    candidates = _lyria_project_candidates()
    for c in candidates:
        if (c / "package.json").is_file():
            return c
    return candidates[0]


DEFAULT_PROJECT_PATH = _default_project_path()
DEFAULT_PORT = 5188
PORT_READY_TIMEOUT_SEC = 90.0
PORT_POLL_INTERVAL_SEC = 0.5
NPM_INSTALL_TIMEOUT_SEC = 600.0

# Child-process output (npm install, the Express/tsx server) lands here so
# failures are diagnosable rather than vanishing into DEVNULL.
SIDECAR_LOG_PATH = _REPO_ROOT / "data" / "logs" / "lyria-sidecar.log"


@contextmanager
def _sidecar_log_handle() -> Iterator[IO[bytes] | int]:
    """Yield a child-stdout target: the sidecar log file, or DEVNULL when the
    file can't be opened (read-only disk). Closes the parent's handle on exit;
    a spawned child keeps its inherited copy."""
    handle: IO[bytes] | int = subprocess.DEVNULL
    try:
        SIDECAR_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        handle = open(SIDECAR_LOG_PATH, "ab")
    except OSError:
        handle = subprocess.DEVNULL
    try:
        yield handle
    finally:
        if not isinstance(handle, int):
            try:
                handle.close()
            except OSError:
                pass


@dataclass
class LyriaConfig:
    project_path: Path
    port: int
    npm_path: str
    mock: bool


_state_lock = Lock()
_proc: Optional[subprocess.Popen[bytes]] = None
_resolved_url: Optional[str] = None


def is_mock() -> bool:
    """True when the child will synthesize local WAVs instead of calling a
    paid provider. Defaults to True -- see the COST SAFETY note above. Only
    the exact string "0" opts in to real spending, so a typo fails safe."""
    return os.getenv("theDAW_LYRIA_MOCK", "1") != "0"


def resolve_config() -> LyriaConfig:
    """Resolve project path + port + the npm binary to use."""
    pkg = os.getenv("theDAW_LYRIA_PROJECT")
    project_path = Path(pkg).expanduser().resolve() if pkg else DEFAULT_PROJECT_PATH

    port_env = os.getenv("theDAW_LYRIA_PORT")
    try:
        port = int(port_env) if port_env else DEFAULT_PORT
    except ValueError:
        port = DEFAULT_PORT

    # On Windows the executable is npm.cmd; shutil.which handles the shim
    # resolution. Fall back to a bare 'npm' so the error at spawn time reads
    # "npm not found" rather than a generic FileNotFoundError.
    npm_path = shutil.which("npm.cmd") or shutil.which("npm") or "npm"

    return LyriaConfig(
        project_path=project_path, port=port, npm_path=npm_path, mock=is_mock()
    )


def _child_env(cfg: LyriaConfig) -> dict[str, str]:
    """Build the child's environment.

    theDAW owns the spawn, so it owns the env -- this is what lets us drive
    Lyria's cost mode and key resolution WITHOUT modifying its source. Lyria
    already reads all of these (server.ts:10 dotenv, :13 GEMINI_API_KEY,
    :33-36 OPENROUTER_API_KEY, :102 PORT), and its in-app Settings modal still
    overrides the keys per-request via x-*-api-key headers, so a user who
    prefers the in-app flow is unaffected.
    """
    env = os.environ.copy()
    env["PORT"] = str(cfg.port)
    if cfg.mock:
        env["LYRIA_MOCK"] = "1"
    else:
        # Explicit opt-in to real spending: clear any inherited mock flag so a
        # stale value in the parent's environment can't silently re-enable it.
        env.pop("LYRIA_MOCK", None)
    # Pass through keys theDAW already holds so the user needn't re-enter them.
    # Absent keys are simply not set; Lyria then reports them as unconfigured
    # via its own /api/settings/status and its Settings modal still works.
    for key in ("GEMINI_API_KEY", "OPENROUTER_API_KEY", "AI_PROVIDER"):
        val = os.getenv(key)
        if val:
            env[key] = val
    return env


def _port_is_listening(port: int, host: str = "127.0.0.1") -> bool:
    """True if something is already listening on host:port -- used both for
    readiness polls and for detecting an existing instance we shouldn't
    double-spawn.

    Note the explicit 127.0.0.1: this must NOT be "localhost". On Windows
    localhost resolves to ::1 first, and an unrelated IPv6 listener on the
    same port (VS Code does this on 3001) would make a healthy sidecar look
    dead, or a dead one look alive.
    """
    try:
        with socket.create_connection((host, port), timeout=0.4):
            return True
    except OSError:
        return False


def _ensure_deps(cfg: LyriaConfig) -> None:
    """Install node_modules when missing.

    Hoisted into its own function deliberately: vj/sidecar.py has this check
    inline in ensure_running() only, so its _ensure_build() path can run
    `npm run build` against a checkout with no node_modules and fail with a
    bare "vite: not found". Every path that runs npm here goes through this
    first.
    """
    node_modules = cfg.project_path / "node_modules"
    if node_modules.is_dir():
        return
    log.info("lyria.sidecar: node_modules missing -- running npm install")
    try:
        # Output goes to the sidecar log so install failures are diagnosable;
        # the timeout stops a hung npm (network stall) from pinning the state
        # lock forever.
        with _sidecar_log_handle() as install_log:
            rc = subprocess.call(
                [cfg.npm_path, "install"],
                cwd=str(cfg.project_path),
                stdout=install_log,
                stderr=subprocess.STDOUT,
                shell=False,
                timeout=NPM_INSTALL_TIMEOUT_SEC,
            )
    except FileNotFoundError as e:
        raise RuntimeError(
            f"Lyria sidecar: npm not found ({e}). Install Node.js."
        ) from e
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(
            f"npm install timed out after {int(NPM_INSTALL_TIMEOUT_SEC)}s in "
            f"{cfg.project_path} -- check the network, then retry."
        ) from e
    if rc != 0:
        raise RuntimeError(
            f"npm install failed in {cfg.project_path} (rc={rc}). See "
            f"{SIDECAR_LOG_PATH} for the full output, then retry."
        )
    log.info("lyria.sidecar: npm install complete")


def detect_lan_ip() -> Optional[str]:
    """Best-effort detection of this machine's primary LAN IPv4 address.

    Opens a UDP socket "toward" a public address (no packets are sent for a
    UDP connect) and reads back the local end of the route the OS picked,
    dodging the 127.0.0.1 that gethostbyname(gethostname()) often returns.
    Returns None when no non-loopback address can be determined.
    """
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # 8.8.8.8 is just a routing hint; nothing is transmitted.
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except OSError:
        ip = ""
    finally:
        if s is not None:
            try:
                s.close()
            except OSError:
                pass
    if ip and not ip.startswith("127."):
        return ip
    return None


def probe() -> dict:
    """Non-spawning diagnostics for the Settings UI / /status endpoint."""
    cfg = resolve_config()
    pkg = cfg.project_path
    pkg_json = pkg / "package.json"
    issues: list[str] = []
    if not pkg.is_dir():
        issues.append(
            f"Lyria project not found at {pkg} -- clone StarskreamEXE/lyria-3-pro "
            "beside this repo or set theDAW_LYRIA_PROJECT."
        )
    elif not pkg_json.is_file():
        issues.append(f"no package.json at {pkg_json}")
    if not (shutil.which("npm") or shutil.which("npm.cmd")):
        issues.append("npm not found on PATH -- install Node.js first")
    return {
        "project_path": str(pkg),
        "port": cfg.port,
        "mock": cfg.mock,
        "deps_installed": (pkg / "node_modules").is_dir(),
        "listening": _port_is_listening(cfg.port),
        "process_alive": _proc is not None and _proc.poll() is None,
        "url": _resolved_url or f"http://127.0.0.1:{cfg.port}",
        "lan_ip": detect_lan_ip(),
        "issues": issues,
    }


def ensure_running(*, wait_for_ready: bool = True) -> str:
    """Spawn the Lyria Express server if it isn't already, and return the URL
    it serves on. Safe to call repeatedly -- no-ops if the port is already
    listening, even if some other process started it."""
    global _proc, _resolved_url
    with _state_lock:
        cfg = resolve_config()
        # 127.0.0.1, not localhost -- see _port_is_listening for why.
        url = f"http://127.0.0.1:{cfg.port}"

        # Already listening (our child, or one the user launched manually).
        if _port_is_listening(cfg.port):
            _resolved_url = url
            return url

        if _proc is not None and _proc.poll() is None:
            # Live child, not yet listening; fall through to the wait loop.
            pass
        else:
            if not cfg.project_path.is_dir():
                raise RuntimeError(
                    f"Lyria project not found at {cfg.project_path}. Clone "
                    "StarskreamEXE/lyria-3-pro beside this repo, or set "
                    "theDAW_LYRIA_PROJECT to override."
                )
            _ensure_deps(cfg)
            # `npm run dev` is `tsx server.ts`: the Express server hosts Vite in
            # middleware mode and serves both the API and the SPA from one port.
            # We use it rather than build+start because it needs no build step
            # and is the path the app is developed and tested against.
            cmd = [cfg.npm_path, "run", "dev"]
            log.info(
                "lyria.sidecar: spawning %s (cwd=%s, port=%d, mock=%s)",
                " ".join(cmd),
                cfg.project_path,
                cfg.port,
                cfg.mock,
            )
            try:
                # On Windows npm is a .cmd shim; CREATE_NEW_PROCESS_GROUP keeps
                # the spawn quiet inside the theDAW console instead of popping a
                # separate cmd window.
                creationflags = 0
                if sys.platform == "win32":
                    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP
                with _sidecar_log_handle() as spawn_out:
                    _proc = subprocess.Popen(
                        cmd,
                        cwd=str(cfg.project_path),
                        stdout=spawn_out,
                        stderr=subprocess.STDOUT,
                        creationflags=creationflags,
                        shell=False,
                        env=_child_env(cfg),
                    )
            except FileNotFoundError as e:
                raise RuntimeError(
                    f"Failed to launch Lyria sidecar: {e}. Is npm on PATH?"
                ) from e

        if not wait_for_ready:
            _resolved_url = url
            return url

        deadline = time.monotonic() + PORT_READY_TIMEOUT_SEC
        while time.monotonic() < deadline:
            if _port_is_listening(cfg.port):
                _resolved_url = url
                log.info("lyria.sidecar: ready at %s (mock=%s)", url, cfg.mock)
                return url
            if _proc is not None and _proc.poll() is not None:
                raise RuntimeError(
                    f"Lyria sidecar exited before becoming ready "
                    f"(rc={_proc.returncode}). See {SIDECAR_LOG_PATH}."
                )
            time.sleep(PORT_POLL_INTERVAL_SEC)
        raise RuntimeError(
            f"Lyria sidecar didn't open port {cfg.port} within "
            f"{int(PORT_READY_TIMEOUT_SEC)}s -- likely an npm-install or "
            f"server startup hang. See {SIDECAR_LOG_PATH}."
        )


def stop() -> bool:
    """Terminate the sidecar if we spawned it. Returns True if we actually
    stopped a live process."""
    global _proc, _resolved_url
    with _state_lock:
        if _proc is None:
            return False
        if _proc.poll() is not None:
            _proc = None
            return False
        try:
            if sys.platform == "win32":
                # npm.cmd is a shim: terminate() kills the cmd wrapper and
                # leaves the node child listening. Kill the whole tree.
                subprocess.call(
                    ["taskkill", "/PID", str(_proc.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                _proc.wait(timeout=5.0)
            else:
                _proc.terminate()
                _proc.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            _proc.kill()
            try:
                # Reap the killed child so it doesn't linger as a zombie until
                # interpreter shutdown (POSIX).
                _proc.wait(timeout=5.0)
            except (subprocess.TimeoutExpired, OSError):
                pass
        finally:
            _proc = None
            _resolved_url = None
        return True
