"""Manage the GANTASMO-LIVE-VJ Vite server as an SA3 sidecar.

The VJ project is its own repo (``gantasmo/VJ-9000``), discovered
relative to the app or overridable via ``theDAW_VJ_PROJECT``. It's a
vanilla Vite/React SPA — no Python, no heavy ML deps, no server
component — so the compiled ``dist/`` IS the whole app.

DEFAULT (static mode): whenever a build is resolvable, the theDAW
BACKEND serves ``dist/`` itself as a StaticFiles mount at
``/vj-app`` (see ``server.py``) and spawns NO Node process. This
removes the runtime Node.js requirement on end-user machines and
makes the VJ tab behave identically on Windows, macOS, Linux, and
Docker. ``resolve_dist_dir()`` / ``is_static_mode()`` / the
``STATIC_MOUNT_PATH`` constant drive that path; a dist can come from
``theDAW_VJ_DIST``, the resolved checkout's ``dist/``, or a release
bundle beside the app. When the resolved project is a full source
checkout with npm present, ``ensure_static_dist()`` refreshes a stale
build first so dev checkouts stay current.

DEV mode (``theDAW_VJ_DEV=1``): the legacy path — spawn the Vite dev
server (HMR) and poll the port — for working ON the VJ app itself.

The dev/preview server (dev mode only) deliberately uses a NON-default
port (5187) because:
  * 3000 (React default) is the user's explicit "don't use this"
    request — they've had too many collisions.
  * 5173 is the SA3 frontend's port.
  * 5174 is Vite's next-port fallback (so SA3 frontend often grabs it
    when 5173 is taken).
  * 5187 is far enough from those that it stays out of the way.

The port is configurable via ``theDAW_VJ_PORT``.

Lifecycle:
  * ``probe()`` — does the project exist? Does package.json look right?
    Is the port currently listening?
  * ``ensure_running()`` — lazy spawn. Returns the live URL once the
    dev server is ready, or raises RuntimeError with a diagnostic.
  * ``stop()`` — terminates the subprocess.
  * Warm-up is request-driven: router.py's ``_maybe_auto_spawn`` kicks a
    one-time background readiness thread on the first /url, /mobile, or
    /status call (there is no FastAPI startup hook).
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


# Repo root (…/stable-audio-3): backend/modules/vj/sidecar.py -> parents[3].
_REPO_ROOT = Path(__file__).resolve().parents[3]


def _vj_project_candidates() -> list[Path]:
    """Portable search order for the VJ project when theDAW_VJ_PROJECT is
    unset. Ordered from "bundled/checked-out inside the app" to
    "dev-checkout sibling of this repo". Nothing here is machine-specific:
    every entry is derived from this file's location, so it resolves the
    same on any install. The first candidate whose package.json exists
    wins; if none do, the first entry is used so diagnostics name a path
    local to THIS install rather than one from the build machine."""
    # Both the local dev name (GANTASMO-LIVE-VJ) and the repo name a fresh
    # `git clone` produces (VJ-9000) are searched, so a plain clone beside the
    # repo works with no env var on any machine.
    return [
        _REPO_ROOT / "vj",  # bundled checkout inside the app (release layout)
        _REPO_ROOT.parent / "GANTASMO-LIVE-VJ",  # sibling of the repo
        _REPO_ROOT.parent / "VJ-9000",  # sibling, fresh-clone name
        _REPO_ROOT.parent.parent / "GANTASMO-LIVE-VJ",  # nested dev layout
        _REPO_ROOT.parent.parent / "VJ-9000",  # nested dev, fresh-clone name
    ]


def _default_project_path() -> Path:
    candidates = _vj_project_candidates()
    for c in candidates:
        if (c / "package.json").is_file():
            return c
    return candidates[0]


DEFAULT_PROJECT_PATH = _default_project_path()
DEFAULT_PORT = 5187
PORT_READY_TIMEOUT_SEC = 60.0
PORT_POLL_INTERVAL_SEC = 0.5
BUILD_TIMEOUT_SEC = 300.0
NPM_INSTALL_TIMEOUT_SEC = 600.0

# Child-process output (npm install, vite dev/preview) lands here so failures
# are diagnosable; previously it went to DEVNULL and a server that died before
# ready reported only "exited (rc=1)" with no cause anywhere.
SIDECAR_LOG_PATH = _REPO_ROOT / "data" / "logs" / "vj-sidecar.log"


@contextmanager
def _sidecar_log_handle() -> Iterator[IO[bytes] | int]:
    """Yield a child-stdout target: the sidecar log file, or DEVNULL when the
    file can't be opened (read-only disk). Closes the parent's handle on
    exit; a spawned child keeps its inherited copy."""
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


# Inputs to the staleness check: the newest mtime across these (files
# directly, directories recursively) is compared against dist/index.html,
# which vite rewrites on every build.
_SOURCE_DIRS = ("src", "assets", "public")
_SOURCE_FILES = (
    "index.html",
    "vite.config.ts",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
)


@dataclass
class VJConfig:
    project_path: Path
    port: int
    npm_path: str
    dev_mode: bool


_state_lock = Lock()
_proc: Optional[subprocess.Popen[bytes]] = None
_resolved_url: Optional[str] = None


def resolve_config() -> VJConfig:
    """Resolve project path + port + the npm binary to use."""
    pkg = os.getenv("theDAW_VJ_PROJECT")
    project_path = Path(pkg).expanduser().resolve() if pkg else DEFAULT_PROJECT_PATH

    port_env = os.getenv("theDAW_VJ_PORT")
    try:
        port = int(port_env) if port_env else DEFAULT_PORT
    except ValueError:
        port = DEFAULT_PORT

    # On Windows the executable is npm.cmd; shutil.which handles the
    # shim resolution. Fall back to a bare 'npm' so the error message
    # at spawn time is informative ("npm not found") rather than a
    # generic FileNotFoundError.
    npm_path = shutil.which("npm.cmd") or shutil.which("npm") or "npm"

    dev_mode = os.getenv("theDAW_VJ_DEV") == "1"

    return VJConfig(
        project_path=project_path, port=port, npm_path=npm_path, dev_mode=dev_mode
    )


# The URL subpath the backend serves the production VJ build under. The VJ
# build is compiled with vite `base: '/vj-app/'` so its assets resolve here.
STATIC_MOUNT_PATH = "/vj-app"


def _dist_candidates() -> list[Path]:
    """Search order for a servable VJ production build (``dist/``). Ordered
    from most explicit to least: an env override, the resolved project's own
    build, then release-bundle locations relative to the app. Every entry is
    derived from config/this file's location — nothing machine-specific."""
    cands: list[Path] = []
    d = os.getenv("theDAW_VJ_DIST")
    if d:
        cands.append(Path(d).expanduser().resolve())
    cands.append(resolve_config().project_path / "dist")  # dev checkout build
    cands.append(_REPO_ROOT / "vj-dist")  # dist-only release bundle
    cands.append(_REPO_ROOT / "vj" / "dist")  # full checkout bundle
    # Where `npm run fetch:vj` stages the build during dev — so testing the
    # static path locally needs no env var, just that one command.
    cands.append(_REPO_ROOT / "electron-ui" / "resources" / "vj-dist")
    return cands


def resolve_dist_dir() -> Optional[Path]:
    """First candidate that holds a real build (``index.html`` present), or
    None when nothing is servable yet."""
    for c in _dist_candidates():
        if (c / "index.html").is_file():
            return c
    return None


def is_static_mode() -> bool:
    """True when the backend should SERVE a static VJ build rather than spawn
    a Node dev/preview server. This is the default whenever a build is
    resolvable; ``theDAW_VJ_DEV=1`` forces the Node dev-server path instead."""
    if os.getenv("theDAW_VJ_DEV") == "1":
        return False
    return resolve_dist_dir() is not None


# Set True by server.py when the /vj-app StaticFiles mount is actually
# registered (mounting happens once, at server import). Routes must key the
# "return the static URL" decision off THIS, not is_static_mode(): a dist
# built later in the session flips is_static_mode() true while no mount
# exists, which would hand the iframe a /vj-app/ URL that 404s.
STATIC_MOUNTED = False


def static_mount_active() -> bool:
    return STATIC_MOUNTED


def ensure_static_dist() -> Path:
    """Return the servable ``dist/`` dir for the static mount. When the
    resolved project is a full source checkout with npm available, refresh a
    stale/missing build first so dev checkouts stay current; a dist-only
    release bundle (no source, no npm) is served as-is. Raises RuntimeError
    naming the env overrides when nothing can be served."""
    cfg = resolve_config()
    proj = cfg.project_path
    has_source = (proj / "package.json").is_file()
    has_npm = bool(shutil.which("npm") or shutil.which("npm.cmd"))
    if has_source and has_npm:
        try:
            _ensure_build(cfg)  # no-op unless dist is missing or stale
        except RuntimeError as e:
            log.warning("vj.sidecar: static rebuild failed, using existing dist: %s", e)
    dist = resolve_dist_dir()
    if dist is None:
        raise RuntimeError(
            "VJ build not found. Point theDAW_VJ_PROJECT at a VJ checkout "
            "(it builds automatically when npm is present) or theDAW_VJ_DIST "
            "at a prebuilt dist/ folder."
        )
    return dist


def _newest_source_mtime(root: Path) -> float:
    newest = 0.0
    for name in _SOURCE_FILES:
        f = root / name
        if f.is_file():
            newest = max(newest, f.stat().st_mtime)
    for name in _SOURCE_DIRS:
        d = root / name
        if d.is_dir():
            for p in d.rglob("*"):
                if p.is_file():
                    newest = max(newest, p.stat().st_mtime)
    return newest


def _build_is_stale(root: Path) -> bool:
    """True when dist/ is missing or older than the newest source file."""
    marker = root / "dist" / "index.html"
    if not marker.is_file():
        return True
    return _newest_source_mtime(root) > marker.stat().st_mtime


def _ensure_build(cfg: VJConfig) -> None:
    """Run ``npm run build`` when dist/ is missing or stale. Raises
    RuntimeError with the build log tail on failure."""
    if not _build_is_stale(cfg.project_path):
        return
    log.info("vj.sidecar: dist/ missing or stale — running npm run build")
    try:
        proc = subprocess.run(
            [cfg.npm_path, "run", "build"],
            cwd=str(cfg.project_path),
            capture_output=True,
            timeout=BUILD_TIMEOUT_SEC,
            shell=False,
        )
    except FileNotFoundError as e:
        raise RuntimeError(f"VJ sidecar: npm not found ({e}). Install Node.js.") from e
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(
            f"VJ build timed out after {int(BUILD_TIMEOUT_SEC)}s in {cfg.project_path}."
        ) from e
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or b"").decode("utf-8", "replace")[-2000:]
        raise RuntimeError(
            f"VJ build failed (rc={proc.returncode}) in {cfg.project_path}:\n{tail}"
        )
    log.info("vj.sidecar: build complete")


def _port_is_listening(port: int, host: str = "127.0.0.1") -> bool:
    """True if something is already listening on ``host:port`` — used
    both for readiness polls and for detecting an existing VJ instance
    we shouldn't double-spawn."""
    try:
        with socket.create_connection((host, port), timeout=0.4):
            return True
    except OSError:
        return False


def detect_lan_ip() -> Optional[str]:
    """Best-effort detection of this machine's primary LAN IPv4 address
    so phones/tablets on the same network can reach the VJ output.

    We open a UDP socket "toward" a public address (no packets are
    actually sent for UDP connect) and read back the local end of the
    route the OS picked. This reliably yields the interface IP used for
    outbound LAN/WAN traffic, dodging the 127.0.0.1 that
    ``socket.gethostbyname(gethostname())`` often returns. Returns None
    if we can't determine a non-loopback address.
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


def mobile_url_for(port: int) -> Optional[str]:
    """Return a LAN-reachable URL for the given port, or None if no
    non-loopback IP could be detected (e.g. machine is offline)."""
    ip = detect_lan_ip()
    return f"http://{ip}:{port}" if ip else None


def probe() -> dict:
    """Non-spawning diagnostics for the Settings UI / /status endpoint."""
    cfg = resolve_config()
    pkg = cfg.project_path

    # Static mode: a bundled/resolvable build is served by the backend itself.
    # No Node process, no port, no npm — the only failure is "no build found".
    if is_static_mode():
        dist = resolve_dist_dir()
        issues: list[str] = []
        if dist is None:
            issues.append("no VJ build found — set theDAW_VJ_DIST or theDAW_VJ_PROJECT")
        return {
            "project_path": str(pkg),
            "dist_path": str(dist) if dist else None,
            "mode": "static",
            # In static mode "served" replaces the port-listening check.
            "listening": dist is not None,
            "process_alive": False,
            "url": f"{STATIC_MOUNT_PATH}/",
            "mobile_url": None,
            "lan_ip": detect_lan_ip(),
            "issues": issues,
        }

    pkg_json = pkg / "package.json"
    issues = []
    if not pkg.is_dir():
        issues.append(f"project path does not exist: {pkg}")
    elif not pkg_json.is_file():
        issues.append(f"no package.json at {pkg_json}")
    if not (shutil.which("npm") or shutil.which("npm.cmd")):
        issues.append("npm not found on PATH — install Node.js first")
    listening = _port_is_listening(cfg.port)
    return {
        "project_path": str(pkg),
        "port": cfg.port,
        # HMR dev server (theDAW_VJ_DEV=1). Reached only when no static build
        # is resolvable, so this is the developer/live-edit path.
        "mode": "dev",
        "build_stale": _build_is_stale(pkg) if pkg.is_dir() else None,
        "listening": listening,
        "process_alive": _proc is not None and _proc.poll() is None,
        "url": _resolved_url or f"http://localhost:{cfg.port}",
        # LAN-reachable URL for phones/tablets (None if offline). The
        # Vite server is bound to 0.0.0.0 with allowedHosts disabled so
        # this address isn't rejected when a mobile device connects.
        "mobile_url": mobile_url_for(cfg.port),
        "lan_ip": detect_lan_ip(),
        "issues": issues,
    }


def ensure_running(*, wait_for_ready: bool = True) -> str:
    """Spawn the VJ Vite server (preview by default, dev with
    theDAW_VJ_DEV=1) if it isn't already, and return the URL it serves
    on. Safe to call repeatedly — no-ops if the port is already
    listening, even if some OTHER process started the server."""
    global _proc, _resolved_url
    with _state_lock:
        cfg = resolve_config()
        url = f"http://localhost:{cfg.port}"

        # Already listening (either our subprocess or one the user
        # launched manually) — just return the URL.
        if _port_is_listening(cfg.port):
            _resolved_url = url
            return url

        if _proc is not None and _proc.poll() is None:
            # We have a live child but it's not yet listening; fall
            # through to the wait-for-ready loop below.
            pass
        else:
            # No live child — spawn one.
            if not cfg.project_path.is_dir():
                raise RuntimeError(
                    f"VJ project not found at {cfg.project_path}. Set "
                    "theDAW_VJ_PROJECT to override."
                )
            # First-run bootstrap: if node_modules is missing, npm run
            # dev exits with rc=1 immediately ("vite: not found"). Do
            # an `npm install` first. This can take a couple of minutes
            # on a fresh checkout — the readiness deadline below is
            # generous enough to cover it, and the frontend's VJView
            # already shows a "first launch can take a minute" hint.
            node_modules = cfg.project_path / "node_modules"
            if not node_modules.is_dir():
                log.info("vj.sidecar: node_modules missing — running npm install")
                install_cmd = [cfg.npm_path, "install"]
                rc = -1
                try:
                    # Output goes to the sidecar log file so install failures
                    # are diagnosable; the timeout stops a hung npm (network
                    # stall) from pinning the state lock forever.
                    with _sidecar_log_handle() as install_log:
                        rc = subprocess.call(
                            install_cmd,
                            cwd=str(cfg.project_path),
                            stdout=install_log,
                            stderr=subprocess.STDOUT,
                            shell=False,
                            timeout=NPM_INSTALL_TIMEOUT_SEC,
                        )
                except FileNotFoundError as e:
                    raise RuntimeError(
                        f"VJ sidecar: npm not found ({e}). Install Node.js."
                    ) from e
                except subprocess.TimeoutExpired as e:
                    raise RuntimeError(
                        f"npm install timed out after {int(NPM_INSTALL_TIMEOUT_SEC)}s "
                        f"in {cfg.project_path} — check the network, then retry."
                    ) from e
                if rc != 0:
                    raise RuntimeError(
                        f"npm install failed in {cfg.project_path} (rc={rc}). "
                        f"See {SIDECAR_LOG_PATH} for the full output, then retry."
                    )
                log.info("vj.sidecar: npm install complete")
            if cfg.dev_mode:
                cmd = [cfg.npm_path, "run", "dev", "--", "--port", str(cfg.port)]
            else:
                # Production serve: build once (when stale), then `vite
                # preview` over dist/ — same port contract and SPA
                # behavior as the dev server, none of its per-request
                # work. `--host` (bare) binds 0.0.0.0 so the LAN/mobile
                # URL keeps working; allowedHosts is inherited from the
                # project's server config.
                _ensure_build(cfg)
                cmd = [
                    cfg.npm_path,
                    "run",
                    "preview",
                    "--",
                    "--port",
                    str(cfg.port),
                    "--strictPort",
                    "--host",
                ]
            log.info(
                "vj.sidecar: spawning %s (cwd=%s)",
                " ".join(cmd),
                cfg.project_path,
            )
            try:
                # On Windows, npm is a .cmd shim; CREATE_NEW_PROCESS_GROUP
                # keeps the spawn quiet inside the SA3 backend console
                # instead of popping a separate cmd window. stdout/stderr go
                # to the sidecar log file (data/logs/vj-sidecar.log) so a
                # server that dies before ready leaves its actual error
                # somewhere findable instead of vanishing into DEVNULL.
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
                    )
            except FileNotFoundError as e:
                raise RuntimeError(
                    f"Failed to launch VJ sidecar: {e}. Is npm on PATH?"
                ) from e

        if not wait_for_ready:
            _resolved_url = url
            return url

        deadline = time.monotonic() + PORT_READY_TIMEOUT_SEC
        while time.monotonic() < deadline:
            if _port_is_listening(cfg.port):
                _resolved_url = url
                log.info("vj.sidecar: ready at %s", url)
                return url
            if _proc is not None and _proc.poll() is not None:
                raise RuntimeError(
                    "VJ sidecar exited before becoming ready (rc="
                    f"{_proc.returncode}). Check the project's "
                    "package.json scripts (preview/dev)."
                )
            time.sleep(PORT_POLL_INTERVAL_SEC)
        raise RuntimeError(
            f"VJ sidecar didn't open port {cfg.port} within "
            f"{int(PORT_READY_TIMEOUT_SEC)}s — likely a npm-install "
            "or vite startup hang."
        )


def stop() -> bool:
    """Terminate the sidecar if we spawned it. Returns True if we
    actually stopped a live process."""
    global _proc, _resolved_url
    with _state_lock:
        if _proc is None:
            return False
        if _proc.poll() is not None:
            _proc = None
            return False
        try:
            if sys.platform == "win32":
                # npm.cmd is a shim: terminate() kills the cmd wrapper
                # and leaves the node (vite) child listening. Kill the
                # whole tree.
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
                # Reap the killed child so it doesn't linger as a zombie
                # until interpreter shutdown (POSIX).
                _proc.wait(timeout=5.0)
            except (subprocess.TimeoutExpired, OSError):
                pass
        finally:
            _proc = None
            _resolved_url = None
        return True
