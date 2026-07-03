"""Manage the Underfit LoRA-trainer dashboard as an SA3 sidecar.

The Underfit project lives in its own repo vendored inside theDAW's repo
root (overridable via ``theDAW_UNDERFIT_PROJECT``). It is
a plain-Python ``http.server`` control plane with its OWN venv — we
spawn ``dashboard/server.py`` with that venv's interpreter and pass
``UNDERFIT_DASHBOARD_PORT`` (default 8791; the standalone project
defaults to 8787, which is taken by an unrelated app on this machine).

The Underfit center tab (frontend/src/views/UnderfitView.tsx) does NOT
call this module — it polls http://localhost:8791 directly and mounts
its iframe when the port answers. This sidecar exists so the docs'
promise ("you do not launch or manage it separately",
docs/guides/underfit.md) is actually true: the backend spawns the
dashboard at startup and stops it on shutdown.

Lifecycle:
  * ``probe()`` — non-spawning diagnostics.
  * ``ensure_running()`` — lazy spawn; no-ops when the port is already
    listening (covers a manually-started instance, which we then never
    kill — we only stop processes we spawned).
  * ``stop()`` — terminates OUR child. Deliberately NOT a tree-kill:
    the dashboard launches training runs as detached subprocesses that
    are documented to survive dashboard restarts, so killing the whole
    tree would destroy in-flight training. Terminating just the
    dashboard process preserves that contract.
"""

from __future__ import annotations

import logging
import os
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Optional

log = logging.getLogger(__name__)

# The underfit repo is vendored INSIDE theDAW's repo root (it keeps its own
# .git and is gitignored by theDAW). Overridable via theDAW_UNDERFIT_PROJECT.
_REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_PROJECT_PATH = _REPO_ROOT / "underfit"
DEFAULT_PORT = 8791
PORT_READY_TIMEOUT_SEC = 30.0
PORT_POLL_INTERVAL_SEC = 0.5
# Child stdout/stderr land here so a spawn that dies (missing venv dep,
# port clash, traceback) can be diagnosed instead of vanishing.
LOG_PATH = _REPO_ROOT / "data" / "underfit-sidecar.log"


@dataclass
class UnderfitConfig:
    project_path: Path
    port: int
    python_path: Path
    server_script: Path


_state_lock = Lock()
_proc: Optional[subprocess.Popen[bytes]] = None


def resolve_config() -> UnderfitConfig:
    """Resolve the underfit checkout, its venv python, and the port."""
    pkg = os.getenv("theDAW_UNDERFIT_PROJECT")
    project_path = Path(pkg).expanduser().resolve() if pkg else DEFAULT_PROJECT_PATH

    port_env = os.getenv("theDAW_UNDERFIT_PORT")
    try:
        port = int(port_env) if port_env else DEFAULT_PORT
    except ValueError:
        port = DEFAULT_PORT

    if sys.platform == "win32":
        python_path = project_path / ".venv" / "Scripts" / "python.exe"
    else:
        python_path = project_path / ".venv" / "bin" / "python"

    return UnderfitConfig(
        project_path=project_path,
        port=port,
        python_path=python_path,
        server_script=project_path / "dashboard" / "server.py",
    )


def _port_is_listening(port: int, host: str = "127.0.0.1") -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.4):
            return True
    except OSError:
        return False


def probe() -> dict:
    """Non-spawning diagnostics for /status."""
    cfg = resolve_config()
    issues: list[str] = []
    if not cfg.project_path.is_dir():
        issues.append(
            f"underfit checkout not found at {cfg.project_path} — clone it "
            "there or set theDAW_UNDERFIT_PROJECT"
        )
    elif not cfg.server_script.is_file():
        issues.append(f"no dashboard server at {cfg.server_script}")
    if cfg.project_path.is_dir() and not cfg.python_path.is_file():
        issues.append(
            f"underfit venv python missing at {cfg.python_path} — run its "
            "setup to create .venv"
        )
    return {
        "project_path": str(cfg.project_path),
        "port": cfg.port,
        "listening": _port_is_listening(cfg.port),
        "process_alive": _proc is not None and _proc.poll() is None,
        "url": f"http://localhost:{cfg.port}",
        "issues": issues,
    }


def ensure_running(*, wait_for_ready: bool = True) -> str:
    """Spawn the dashboard if nothing is listening yet; return its URL.
    Safe to call repeatedly — no-ops when the port is already served
    (whether by our child or an instance the user started by hand)."""
    global _proc
    with _state_lock:
        cfg = resolve_config()
        url = f"http://localhost:{cfg.port}"

        if _port_is_listening(cfg.port):
            return url

        if _proc is not None and _proc.poll() is None:
            pass  # live child, not listening yet — fall through to the wait
        else:
            info = probe()
            if info["issues"]:
                raise RuntimeError(
                    "Underfit sidecar cannot start: " + "; ".join(info["issues"])
                )
            env = dict(os.environ)
            env["UNDERFIT_DASHBOARD_PORT"] = str(cfg.port)
            LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
            log_handle = open(LOG_PATH, "ab")  # noqa: SIM115 — child owns it
            log.info(
                "underfit.sidecar: spawning %s %s (cwd=%s, port=%s)",
                cfg.python_path,
                cfg.server_script,
                cfg.project_path,
                cfg.port,
            )
            try:
                _proc = subprocess.Popen(
                    [str(cfg.python_path), str(cfg.server_script)],
                    cwd=str(cfg.project_path),
                    env=env,
                    stdout=log_handle,
                    stderr=log_handle,
                    shell=False,
                )
            except OSError as e:
                raise RuntimeError(f"Failed to launch Underfit sidecar: {e}") from e
            finally:
                # The child inherited the handle; our copy can close.
                log_handle.close()

        if not wait_for_ready:
            return url

        deadline = time.monotonic() + PORT_READY_TIMEOUT_SEC
        while time.monotonic() < deadline:
            if _port_is_listening(cfg.port):
                log.info("underfit.sidecar: ready at %s", url)
                return url
            if _proc is not None and _proc.poll() is not None:
                raise RuntimeError(
                    "Underfit dashboard exited before becoming ready (rc="
                    f"{_proc.returncode}). See {LOG_PATH} for its output."
                )
            time.sleep(PORT_POLL_INTERVAL_SEC)
        raise RuntimeError(
            f"Underfit dashboard didn't open port {cfg.port} within "
            f"{int(PORT_READY_TIMEOUT_SEC)}s. See {LOG_PATH} for its output."
        )


def stop() -> bool:
    """Terminate the dashboard if WE spawned it. Returns True when a
    live process was stopped. Intentionally terminates only the
    dashboard process itself (no tree-kill): its training runs are
    detached on purpose and must survive."""
    global _proc
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
        return True
