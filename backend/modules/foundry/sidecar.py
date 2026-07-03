"""Manage the VST Foundry fullstack server as a theDAW sidecar.

VST Foundry is an in-repo Node/Express app (VST-Foundry-UI/VST-UI-FOUNDRY) with
its own frontend + backend, so it runs as its own server on a dedicated port
and the theDAW UI embeds it by iframe (see frontend FoundryView).

DEFAULT (production): when a compiled build is present (``dist/server.cjs`` +
``node_modules``), run it directly with node — no npm, no dev server, no install
step. The packaged release ships the built app plus a bundled node runtime, so
this path needs nothing preinstalled. ``THEDAW_NODE`` overrides the node binary.

DEV (``THEDAW_FOUNDRY_DEV=1``, or when no build exists): npm-install on first run
then ``npm run dev`` (Vite+Express, HMR off) for working ON Foundry itself.
"""

from __future__ import annotations

import atexit
import logging
import os
import signal
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Optional

log = logging.getLogger(__name__)

DEFAULT_PROJECT_PATH = (
    Path(__file__).resolve().parents[3] / "VST-Foundry-UI" / "VST-UI-FOUNDRY"
)
DEFAULT_PORT = 5472
PORT_READY_TIMEOUT_SEC = 90.0
PORT_POLL_INTERVAL_SEC = 0.5

# Repo root is parents[3] of this file (foundry -> modules -> backend -> repo),
# the same anchor DEFAULT_PROJECT_PATH is built from. Capture the sidecar's
# output to a logfile instead of DEVNULL so a spawn that dies (missing dep,
# bad package.json script) leaves a trail the /url and /status endpoints can
# surface, instead of vanishing into a vague timeout.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_LOG_PATH = _REPO_ROOT / "data" / "logs" / "foundry-sidecar.log"


@dataclass(frozen=True)
class FoundryConfig:
    project_path: Path
    port: int
    npm_path: str


_state_lock = Lock()
_proc: Optional[subprocess.Popen[bytes]] = None
_resolved_url: Optional[str] = None


def _open_log():
    """Open the sidecar logfile for append (binary), creating data/logs/ first.

    The returned handle is passed as both stdout and stderr to the spawned
    process. The child inherits a duplicated fd, so the parent may close its
    handle right after spawning while the child keeps appending.
    """
    _LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    return open(_LOG_PATH, "ab")


def _log_tail(n: int = 40) -> str:
    """Return the last ~n lines of the sidecar log, or '' if it's missing."""
    try:
        with open(_LOG_PATH, "rb") as fh:
            lines = fh.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return ""
    return "\n".join(lines[-n:])


def resolve_config() -> FoundryConfig:
    project_env = os.getenv("THEDAW_FOUNDRY_PROJECT")
    project_path = (
        Path(project_env).expanduser().resolve()
        if project_env
        else DEFAULT_PROJECT_PATH.resolve()
    )

    port_env = os.getenv("THEDAW_FOUNDRY_PORT")
    try:
        port = int(port_env) if port_env else DEFAULT_PORT
    except ValueError:
        port = DEFAULT_PORT

    npm_path = shutil.which("npm.cmd") or shutil.which("npm") or "npm"
    return FoundryConfig(project_path=project_path, port=port, npm_path=npm_path)


def _resolve_node() -> Optional[str]:
    """The node binary to run the compiled Foundry server with. Honors
    THEDAW_NODE, else finds one on PATH (the packaged app prepends its bundled
    tools dir to PATH, so a shipped node is picked up automatically)."""
    explicit = os.getenv("THEDAW_NODE")
    if explicit:
        return explicit
    return shutil.which("node") or shutil.which("node.exe")


def _production_server(cfg: FoundryConfig) -> Optional[Path]:
    """The compiled fullstack server (``dist/server.cjs``, produced by
    ``npm run build``) if it exists AND its runtime deps are present. esbuild
    bundles server.ts with ``--packages=external``, so ``node_modules`` must
    ship alongside dist/. Returns None when no runnable production build is
    available (then the sidecar falls back to the npm dev server)."""
    server = cfg.project_path / "dist" / "server.cjs"
    node_modules = cfg.project_path / "node_modules"
    if server.is_file() and node_modules.is_dir():
        return server
    return None


def _port_is_listening(port: int, host: str = "127.0.0.1") -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.4):
            return True
    except OSError:
        return False


def _is_foundry_server(port: int) -> bool:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/health", timeout=1.0
        ) as response:
            return b'"app":"vst-foundry"' in response.read(512).replace(b" ", b"")
    except (OSError, urllib.error.URLError):
        return False


def _request_foundry_shutdown(port: int) -> bool:
    try:
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/shutdown",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=2.0) as response:
            return 200 <= response.status < 300
    except (OSError, urllib.error.URLError):
        return False


def _wait_until_not_foundry(port: int, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _is_foundry_server(port):
            return True
        time.sleep(0.2)
    return not _is_foundry_server(port)


def _pid_listening_on_port(port: int) -> Optional[int]:
    if sys.platform != "win32":
        return None
    try:
        proc = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"],
            capture_output=True,
            text=True,
            timeout=5.0,
            shell=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    suffix = f":{port}"
    for line in proc.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[0].upper() == "TCP":
            local_address, state, pid = parts[1], parts[3], parts[4]
            if state.upper() == "LISTENING" and local_address.endswith(suffix):
                try:
                    return int(pid)
                except ValueError:
                    return None
    return None


def _terminate_pid(pid: int) -> bool:
    try:
        os.kill(pid, signal.SIGTERM)
        return True
    except OSError:
        return False


def probe() -> dict:
    cfg = resolve_config()
    package_json = cfg.project_path / "package.json"
    issues: list[str] = []
    if not cfg.project_path.is_dir():
        issues.append(f"project path does not exist: {cfg.project_path}")
    elif not package_json.is_file():
        issues.append(f"no package.json at {package_json}")
    if not (shutil.which("npm") or shutil.which("npm.cmd")):
        issues.append("npm not found on PATH — install Node.js first")

    return {
        "project_path": str(cfg.project_path),
        "port": cfg.port,
        "listening": _is_foundry_server(cfg.port),
        "process_alive": _proc is not None and _proc.poll() is None,
        "url": _resolved_url or f"http://localhost:{cfg.port}",
        "issues": issues,
    }


def ensure_running(*, wait_for_ready: bool = True) -> str:
    global _proc, _resolved_url
    with _state_lock:
        cfg = resolve_config()
        url = f"http://localhost:{cfg.port}"

        if _is_foundry_server(cfg.port):
            _resolved_url = url
            return url
        if _port_is_listening(cfg.port):
            raise RuntimeError(
                f"Port {cfg.port} is already in use, but it is not VST Foundry."
            )

        if _proc is None or _proc.poll() is not None:
            if not cfg.project_path.is_dir():
                raise RuntimeError(
                    f"VST Foundry project not found at {cfg.project_path}. "
                    "Set THEDAW_FOUNDRY_PROJECT to override."
                )

            env = os.environ.copy()
            env["THEDAW_FOUNDRY_PORT"] = str(cfg.port)

            prod_server = _production_server(cfg)
            node_bin = _resolve_node()
            if os.getenv("THEDAW_FOUNDRY_DEV") != "1" and prod_server and node_bin:
                # PRODUCTION (default when a built app is present): run the
                # compiled fullstack server directly with node — no npm, no dev
                # server, no install step. The packaged release ships dist/ +
                # node_modules + a node runtime, so this needs nothing installed.
                env["NODE_ENV"] = "production"
                cmd = [node_bin, str(prod_server)]
            else:
                # DEV / source checkout (or THEDAW_FOUNDRY_DEV=1): install deps
                # on first run, then run the Vite+Express dev server. HMR off —
                # nobody live-edits Foundry's source through the embed, and the
                # unreachable HMR socket (24678) otherwise floods the console.
                node_modules = cfg.project_path / "node_modules"
                if not node_modules.is_dir():
                    log.info(
                        "foundry.sidecar: node_modules missing — running npm install"
                    )
                    try:
                        with _open_log() as log_fh:
                            rc = subprocess.call(
                                [cfg.npm_path, "install"],
                                cwd=str(cfg.project_path),
                                stdout=log_fh,
                                stderr=log_fh,
                                shell=False,
                            )
                    except FileNotFoundError as e:
                        raise RuntimeError(
                            f"VST Foundry sidecar: npm not found ({e}). Install Node.js."
                        ) from e
                    if rc != 0:
                        raise RuntimeError(
                            f"npm install failed in {cfg.project_path} (rc={rc}). "
                            "Run it manually to see the full error output, then retry."
                            f"\n--- foundry-sidecar.log (tail) ---\n{_log_tail()}"
                        )
                env["DISABLE_HMR"] = "true"
                cmd = [cfg.npm_path, "run", "dev"]

            log.info(
                "foundry.sidecar: spawning %s (cwd=%s)", " ".join(cmd), cfg.project_path
            )
            try:
                creationflags = 0
                if sys.platform == "win32":
                    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP
                with _open_log() as log_fh:
                    _proc = subprocess.Popen(
                        cmd,
                        cwd=str(cfg.project_path),
                        env=env,
                        stdout=log_fh,
                        stderr=log_fh,
                        creationflags=creationflags,
                        shell=False,
                    )
            except FileNotFoundError as e:
                raise RuntimeError(
                    f"Failed to launch VST Foundry sidecar: {e}. Is npm on PATH?"
                ) from e

        if not wait_for_ready:
            _resolved_url = url
            return url

        deadline = time.monotonic() + PORT_READY_TIMEOUT_SEC
        while time.monotonic() < deadline:
            if _is_foundry_server(cfg.port):
                _resolved_url = url
                log.info("foundry.sidecar: ready at %s", url)
                return url
            if _proc is not None and _proc.poll() is not None:
                raise RuntimeError(
                    "VST Foundry sidecar exited before becoming ready "
                    f"(rc={_proc.returncode}). Check package.json scripts."
                    f"\n--- foundry-sidecar.log (tail) ---\n{_log_tail()}"
                )
            time.sleep(PORT_POLL_INTERVAL_SEC)

        raise RuntimeError(
            f"VST Foundry sidecar didn't open port {cfg.port} within "
            f"{int(PORT_READY_TIMEOUT_SEC)}s."
            f"\n--- foundry-sidecar.log (tail) ---\n{_log_tail()}"
        )


def stop() -> bool:
    global _proc, _resolved_url
    with _state_lock:
        cfg = resolve_config()
        was_running = _is_foundry_server(cfg.port)
        stopped = False

        if was_running and _request_foundry_shutdown(cfg.port):
            stopped = _wait_until_not_foundry(cfg.port) or stopped
            if stopped:
                _proc = None
                _resolved_url = None
                return True

        try:
            if _proc is not None and _proc.poll() is None:
                _proc.terminate()
                _proc.wait(timeout=5.0)
                stopped = _wait_until_not_foundry(cfg.port) or stopped
        except subprocess.TimeoutExpired:
            if _proc is not None:
                _proc.kill()
                stopped = _wait_until_not_foundry(cfg.port) or stopped
        finally:
            _proc = None
            _resolved_url = None

        if _is_foundry_server(cfg.port):
            pid = _pid_listening_on_port(cfg.port)
            if pid is not None:
                stopped = _terminate_pid(pid) or stopped
                deadline = time.monotonic() + 5.0
                while time.monotonic() < deadline and _is_foundry_server(cfg.port):
                    time.sleep(0.2)
        if was_running and _is_foundry_server(cfg.port):
            raise RuntimeError(f"VST Foundry is still listening on port {cfg.port}.")
        return stopped


def _atexit_stop() -> None:
    """Best-effort teardown so the spawned Node server doesn't orphan when the
    backend process exits normally. Registered at import time; guarded so a
    teardown error never propagates out of interpreter shutdown."""
    try:
        stop()
    except Exception:
        pass


atexit.register(_atexit_stop)
