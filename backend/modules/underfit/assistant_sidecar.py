"""Run the UNDERFIT assistant backend (underfit/assistant-backend) as a sidecar.

The assistant orb bundled into the Underfit dashboard (frontend
src/views/underfit/UnderfitAssistantOrb.tsx, built into
underfit/dashboard/assistant/underfit-orb.js) talks to its own Node/Express
server on :5473 (``server.ts``). Nothing started that server, so the orb's
every request failed. This module starts it next to the dashboard at backend
startup (router.startup_underfit), stops it with every other sidecar
(core/teardown.py), and gives the orb a status and a Start action through
/api/underfit/assistant/status and /api/underfit/assistant/start.

The server runs as ``node node_modules/tsx/dist/cli.mjs server.ts``: node
itself is the child, so ``stop()`` terminates the server and not an npm or
cmd.exe wrapper that would leave node running. ``node_modules`` is installed
with ``npm install`` the first time it is missing, from the checked-in
package-lock.json, the same way the Foundry sidecar installs its own.

Only a process THIS backend spawned is ever stopped: an assistant already
answering on the port (started by hand, or by another backend) is reused and
left alone.
"""

from __future__ import annotations

import atexit
import json
import logging
import os
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

from backend.lib import paths
from backend.lib.launch_token import child_env

from . import sidecar as dashboard_sidecar

log = logging.getLogger(__name__)

DEFAULT_PORT = 5473
#: The server is 4,700 lines of TypeScript that tsx compiles on start.
PORT_READY_TIMEOUT_SEC = 60.0
PORT_POLL_INTERVAL_SEC = 0.5
#: What ``GET /api/health`` names itself (server.ts).
HEALTH_APP_ID = "underfit-assistant"


@dataclass(frozen=True)
class AssistantConfig:
    project_path: Path
    port: int
    underfit_root: Path
    dashboard_port: int


_state_lock = Lock()
_proc: Optional[subprocess.Popen[bytes]] = None
#: The ``npm install`` a first start runs, so ``stop()`` can end it.
_install_proc: Optional[subprocess.Popen[bytes]] = None
#: The last start failure, shown by /status until a start succeeds.
_last_error: Optional[str] = None
#: ``"installing"`` while a start runs npm install, ``"launching"`` until node
#: is spawned, else None. /status reports a start in either phase.
_phase: Optional[str] = None
#: Bumped by ``stop()``. A start that finds a different value was cancelled
#: and leaves the state alone.
_generation = 0


def log_path() -> Path:
    """Where the server's output goes. Resolved per call so a test that points
    theDAW_DATA_DIR elsewhere is honoured."""
    return paths.data_path("logs", "underfit-assistant.log")


def _log_tail(n: int = 30) -> str:
    try:
        with open(log_path(), "rb") as fh:
            lines = fh.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return ""
    return "\n".join(lines[-n:])


def resolve_config() -> AssistantConfig:
    dash = dashboard_sidecar.resolve_config()
    project_env = os.getenv("theDAW_UNDERFIT_ASSISTANT_PROJECT")
    project_path = (
        Path(project_env).expanduser().resolve()
        if project_env
        else dash.project_path / "assistant-backend"
    )
    port_env = os.getenv("theDAW_UNDERFIT_ASSISTANT_PORT")
    try:
        port = int(port_env) if port_env else DEFAULT_PORT
    except ValueError:
        port = DEFAULT_PORT
    return AssistantConfig(
        project_path=project_path,
        port=port,
        underfit_root=dash.project_path,
        dashboard_port=dash.port,
    )


def _resolve_node() -> Optional[str]:
    """THEDAW_NODE, else node on PATH (the packaged app puts its bundled node
    first on PATH)."""
    explicit = os.getenv("THEDAW_NODE")
    if explicit:
        return explicit
    return shutil.which("node") or shutil.which("node.exe")


def _resolve_npm() -> Optional[str]:
    return shutil.which("npm.cmd") or shutil.which("npm")


def _tsx_cli(cfg: AssistantConfig) -> Path:
    return cfg.project_path / "node_modules" / "tsx" / "dist" / "cli.mjs"


def _port_is_listening(port: int, host: str = "127.0.0.1") -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.4):
            return True
    except OSError:
        return False


def _is_assistant_server(port: int) -> bool:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/health", timeout=1.0
        ) as response:
            body = json.loads(response.read(2048).decode("utf-8", "replace"))
    except (OSError, urllib.error.URLError, ValueError):
        return False
    return isinstance(body, dict) and body.get("app") == HEALTH_APP_ID


def probe() -> dict:
    """Non-spawning status for /api/underfit/assistant/status.

    ``starting`` covers the whole start: the first-run ``npm install``
    (``installing`` is true then), the spawn, and node compiling server.ts
    until it answers."""
    cfg = resolve_config()
    issues: list[str] = []
    if not (cfg.project_path / "server.ts").is_file():
        issues.append(f"no assistant server at {cfg.project_path / 'server.ts'}")
    if not _resolve_node():
        issues.append("Node.js was not found on PATH, so the assistant cannot run.")
    elif not _tsx_cli(cfg).is_file() and not _resolve_npm():
        issues.append(
            "The assistant's packages are not installed and npm was not found on "
            "PATH to install them."
        )
    running = _is_assistant_server(cfg.port)
    with _state_lock:
        alive = _proc is not None and _proc.poll() is None
        phase = _phase
        last_error = _last_error
    return {
        "port": cfg.port,
        "url": f"http://localhost:{cfg.port}",
        "running": running,
        "starting": not running and (alive or phase is not None),
        "installing": not running and phase == "installing",
        "spawned_here": alive,
        "installed": _tsx_cli(cfg).is_file(),
        "issues": issues,
        "error": None if running else last_error,
        "log_path": str(log_path()),
    }


def _child_env(cfg: AssistantConfig) -> dict[str, str]:
    env = child_env()
    env["UNDERFIT_ASSISTANT_PORT"] = str(cfg.port)
    env["UNDERFIT_ROOT"] = str(cfg.underfit_root)
    env["UNDERFIT_MCP_PATH"] = str(cfg.underfit_root / "mcp-server.cjs")
    env["UNDERFIT_DASHBOARD_PORT"] = str(cfg.dashboard_port)
    # The orb is served by the dashboard; server.ts already allows :8791, and
    # this adds the dashboard's real port when theDAW_UNDERFIT_PORT moved it.
    origins = [
        f"http://localhost:{cfg.dashboard_port}",
        f"http://127.0.0.1:{cfg.dashboard_port}",
    ]
    existing = env.get("FOUNDRY_ALLOWED_ORIGINS", "")
    env["FOUNDRY_ALLOWED_ORIGINS"] = ",".join(filter(None, [existing, *origins]))
    return env


def _group_flags() -> dict:
    """Start a child in its own process group, so ``_kill_tree`` reaches what
    it spawns (npm runs through cmd.exe on Windows and forks node)."""
    if sys.platform == "win32":
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def _kill_tree(proc: subprocess.Popen[bytes]) -> None:
    """End ``proc`` and every process it started. Never raises."""
    if proc.poll() is not None:
        return
    if sys.platform == "win32":
        # taskkill /T walks the child chain; Popen.terminate stops only the
        # cmd.exe that npm.cmd runs in and leaves npm's node behind.
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                capture_output=True,
                timeout=15,
                env=child_env(),
            )
        except (OSError, subprocess.TimeoutExpired) as e:
            log.debug("underfit.assistant: taskkill failed: %s", e)
    else:
        import signal

        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (OSError, ProcessLookupError) as e:
            log.debug("underfit.assistant: killpg failed: %s", e)
    try:
        proc.wait(timeout=5.0)
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            log.warning("underfit.assistant: pid %s did not exit", proc.pid)


#: What a start cancelled by ``stop()`` raises.
STOPPED_MESSAGE = "The assistant start was stopped."


def _cancelled(generation: int) -> bool:
    """True when ``stop()`` ran after the start that holds ``generation``.
    Call with ``_state_lock`` held."""
    return generation != _generation


def _install(cfg: AssistantConfig, generation: int) -> None:
    """Run ``npm install`` as a tracked child, without holding the lock while
    it runs, so /status answers and ``stop()`` can end it."""
    global _install_proc
    npm = _resolve_npm()
    if not npm:
        raise RuntimeError(
            "The assistant's packages are not installed and npm was not found on PATH."
        )
    log.info("underfit.assistant: node_modules missing, running npm install")
    target = log_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "ab") as fh:
        with _state_lock:
            if _cancelled(generation):
                raise RuntimeError(STOPPED_MESSAGE)
            try:
                proc = subprocess.Popen(
                    [npm, "install"],
                    cwd=str(cfg.project_path),
                    stdout=fh,
                    stderr=fh,
                    shell=False,
                    env=child_env(),
                    **_group_flags(),
                )
            except OSError as e:
                raise RuntimeError(f"npm install could not run: {e}") from e
            _install_proc = proc
        rc = proc.wait()
    with _state_lock:
        if _install_proc is proc:
            _install_proc = None
        if _cancelled(generation):
            raise RuntimeError(STOPPED_MESSAGE)
    if rc != 0 or not _tsx_cli(cfg).is_file():
        raise RuntimeError(
            f"npm install in {cfg.project_path} exited {rc}."
            f"\n--- {target.name} (tail) ---\n{_log_tail()}"
        )


def _spawn_node(cfg: AssistantConfig, node: str) -> subprocess.Popen[bytes]:
    target = log_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    cmd = [node, str(_tsx_cli(cfg)), "server.ts"]
    log.info(
        "underfit.assistant: spawning %s (cwd=%s, port=%s)",
        " ".join(cmd),
        cfg.project_path,
        cfg.port,
    )
    creationflags = (
        subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0
    )
    with open(target, "ab") as fh:
        try:
            return subprocess.Popen(
                cmd,
                cwd=str(cfg.project_path),
                env=_child_env(cfg),
                stdout=fh,
                stderr=fh,
                creationflags=creationflags,
                shell=False,
            )
        except OSError as e:
            raise RuntimeError(f"Failed to launch the UNDERFIT assistant: {e}") from e


def _wait_ready(cfg: AssistantConfig, generation: int) -> str:
    """Wait until the server answers. An install in progress has no deadline
    (``stop()`` ends it); the spawned server gets PORT_READY_TIMEOUT_SEC."""
    url = f"http://localhost:{cfg.port}"
    deadline: Optional[float] = None
    while True:
        if _is_assistant_server(cfg.port):
            log.info("underfit.assistant: ready at %s", url)
            return url
        with _state_lock:
            if _cancelled(generation):
                raise RuntimeError(STOPPED_MESSAGE)
            phase = _phase
            proc = _proc
            last_error = _last_error
        if phase == "installing":
            deadline = None
        elif proc is not None and proc.poll() is not None:
            raise RuntimeError(
                "The UNDERFIT assistant exited before it answered "
                f"(rc={proc.returncode})."
                f"\n--- {log_path().name} (tail) ---\n{_log_tail()}"
            )
        elif phase is None and proc is None:
            # The start this call joined failed and left its reason.
            raise RuntimeError(
                last_error or "The UNDERFIT assistant stopped before it answered."
            )
        else:
            now = time.monotonic()
            if deadline is None:
                deadline = now + PORT_READY_TIMEOUT_SEC
            elif now >= deadline:
                raise RuntimeError(
                    f"The UNDERFIT assistant did not answer on port {cfg.port} "
                    f"within {int(PORT_READY_TIMEOUT_SEC)}s. See {log_path()}."
                )
        time.sleep(PORT_POLL_INTERVAL_SEC)


def ensure_running(*, wait_for_ready: bool = True) -> str:
    """Start the assistant server unless one already answers; return its URL.

    The lock is held only to read and change the state, never across npm
    install or the readiness wait, so /status and ``stop()`` answer during a
    start. A call that finds a start already under way waits on that one."""
    global _proc, _last_error, _phase
    cfg = resolve_config()
    url = f"http://localhost:{cfg.port}"
    needs_install = False
    node: Optional[str] = None
    with _state_lock:
        generation = _generation
        joined = _phase is not None or (_proc is not None and _proc.poll() is None)
        if not joined:
            try:
                if _is_assistant_server(cfg.port):
                    _last_error = None
                    return url
                if _port_is_listening(cfg.port):
                    raise RuntimeError(
                        f"Port {cfg.port} is in use by something that is not the "
                        "UNDERFIT assistant."
                    )
                if not (cfg.project_path / "server.ts").is_file():
                    raise RuntimeError(
                        f"No assistant server at {cfg.project_path / 'server.ts'}."
                    )
                node = _resolve_node()
                if not node:
                    raise RuntimeError(
                        "Node.js was not found on PATH, so the assistant cannot run."
                    )
                needs_install = not _tsx_cli(cfg).is_file()
                if needs_install and not _resolve_npm():
                    raise RuntimeError(
                        "The assistant's packages are not installed and npm was "
                        "not found on PATH."
                    )
            except RuntimeError as e:
                _last_error = str(e)
                raise
            _phase = "installing" if needs_install else "launching"
            _last_error = None
    try:
        if not joined and node is not None:
            if needs_install:
                _install(cfg, generation)
            with _state_lock:
                if _cancelled(generation):
                    raise RuntimeError(STOPPED_MESSAGE)
                _phase = "launching"
                _proc = _spawn_node(cfg, node)
                _phase = None
        if not wait_for_ready:
            return url
        ready = _wait_ready(cfg, generation)
        with _state_lock:
            if not _cancelled(generation):
                _last_error = None
        return ready
    except RuntimeError as e:
        with _state_lock:
            if not _cancelled(generation):
                _last_error = str(e)
                if not joined:
                    _phase = None
        raise


def _request_shutdown(port: int) -> bool:
    """Ask the server to shut down; it stops its Claude CLI children first."""
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/shutdown",
        data=b"{}",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=2.0) as response:
            return 200 <= response.status < 300
    except (OSError, urllib.error.URLError):
        return False


def stop() -> bool:
    """Stop what THIS process started: a running ``npm install`` and the
    server. A foreign server is left running.

    A start under way is cancelled (it sees the bumped generation and spawns
    nothing). The lock is held only to take the processes, so a shutdown
    during a first-run install returns once npm is killed, and never waits for
    the start itself.

    The server is asked to shut down first (POST /api/shutdown), which ends
    the Claude CLI sessions it started; ``terminate()`` alone kills node on
    Windows without letting it stop them."""
    global _proc, _install_proc, _phase, _generation
    with _state_lock:
        _generation += 1
        _phase = None
        installer, _install_proc = _install_proc, None
        proc, _proc = _proc, None
    stopped = False
    if installer is not None and installer.poll() is None:
        _kill_tree(installer)
        stopped = True
    if proc is None or proc.poll() is not None:
        return stopped
    if _request_shutdown(resolve_config().port):
        try:
            proc.wait(timeout=12.0)
            return True
        except subprocess.TimeoutExpired:
            pass
    proc.terminate()
    try:
        proc.wait(timeout=10.0)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5.0)
    return True


def _atexit_stop() -> None:
    """Stop our server when the backend exits normally. Never raises."""
    try:
        stop()
    except (OSError, RuntimeError, subprocess.SubprocessError) as e:
        log.debug("underfit.assistant: stop at exit failed: %s", e)


atexit.register(_atexit_stop)
