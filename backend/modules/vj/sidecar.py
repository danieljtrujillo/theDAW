"""Manage the GANTASMO-LIVE-VJ Vite dev server as an SA3 sidecar.

The VJ project lives in its own repo at
``D:/StableAudio/GANTASMO-LIVE-VJ`` (overridable via
``theDAW_VJ_PROJECT``). It's a vanilla Vite/React app — no Python,
no heavy ML deps — so the spawn logic is much simpler than the stems
sidecar: just shell out to ``npm run dev`` with ``--port <N>`` and
poll the port until the dev server is listening.

We deliberately use a NON-default port (5187) because:
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
  * The FastAPI startup hook in router.py calls ensure_running() in
    the background so the VJ server is warm by the time the user
    clicks the VJ tab.
"""

from __future__ import annotations

import logging
import os
import shutil
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Optional

log = logging.getLogger(__name__)


DEFAULT_PROJECT_PATH = Path(r"D:/StableAudio/GANTASMO-LIVE-VJ")
DEFAULT_PORT = 5187
PORT_READY_TIMEOUT_SEC = 60.0
PORT_POLL_INTERVAL_SEC = 0.5


@dataclass
class VJConfig:
    project_path: Path
    port: int
    npm_path: str


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

    return VJConfig(project_path=project_path, port=port, npm_path=npm_path)


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
    pkg_json = pkg / "package.json"
    issues: list[str] = []
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
    """Spawn the VJ Vite dev server if it isn't already, and return the
    URL it serves on. Safe to call repeatedly — no-ops if the port is
    already listening, even if some OTHER process started the server."""
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
                try:
                    rc = subprocess.call(
                        install_cmd,
                        cwd=str(cfg.project_path),
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        shell=False,
                    )
                except FileNotFoundError as e:
                    raise RuntimeError(
                        f"VJ sidecar: npm not found ({e}). Install Node.js."
                    ) from e
                if rc != 0:
                    raise RuntimeError(
                        f"npm install failed in {cfg.project_path} (rc={rc}). "
                        "Run it manually to see the full error output, then retry."
                    )
                log.info("vj.sidecar: npm install complete")
            cmd = [cfg.npm_path, "run", "dev", "--", "--port", str(cfg.port)]
            log.info(
                "vj.sidecar: spawning %s (cwd=%s)",
                " ".join(cmd),
                cfg.project_path,
            )
            try:
                # On Windows, npm is a .cmd shim; CREATE_NO_WINDOW
                # keeps the spawn quiet inside the SA3 backend console
                # instead of popping a separate cmd window. We capture
                # stdout/stderr so they merge into the backend log.
                creationflags = 0
                if sys.platform == "win32":
                    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP
                _proc = subprocess.Popen(
                    cmd,
                    cwd=str(cfg.project_path),
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
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
                    "package.json `dev` script."
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
            _proc.terminate()
            _proc.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            _proc.kill()
        finally:
            _proc = None
            _resolved_url = None
        return True
