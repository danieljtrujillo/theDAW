"""Manage the stem-separation sidecar process and proxy requests to it.

The integration-package (D:/StableAudio/JoshOG/integration-package by
default, overridable via STABLEDAW_STEMS_PACKAGE) ships its own FastAPI
server with Demucs + LARSNET. It needs heavy deps (demucs, torchcrepe,
audio-separator) that we deliberately keep OUT of the main app's
environment.

This module:

  * Locates the package and the Python interpreter that can run it
    (defaults to the main venv; overridable via STABLEDAW_STEMS_PYTHON
    so users can point at an isolated venv where the heavy deps live).
  * ``probe()`` — non-spawning health check: does the package exist?
    Does the configured Python import demucs?
  * ``ensure_running()`` — lazy spawn. Starts the sidecar as a
    subprocess via ``run_backend.py``, watches for ``backend_port.txt``
    to appear, polls ``/health`` until ready, then caches the port.
  * ``stop()`` — terminates the sidecar gracefully.
  * Async ``submit_separation()`` / ``poll_status()`` / ``fetch_stems_zip()``
    wrappers around the sidecar's HTTP API.

We never auto-start at app boot. The user opts in via Settings → enable
the ``stems`` module + flip an auto-toggle, OR via an explicit
``POST /api/stems/start`` call (manual mode).
"""

from __future__ import annotations

import logging
import os
import socket
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import httpx

log = logging.getLogger(__name__)


DEFAULT_PACKAGE_PATH = Path(r"D:/StableAudio/JoshOG/integration-package/backend")
PORT_FILENAME = "backend_port.txt"
# run_backend.py does a dependency check + possible pip install on first
# spawn — that can take minutes. Give it five before we give up.
HEALTH_TIMEOUT_SEC = 300.0
HEALTH_POLL_INTERVAL_SEC = 1.0


@dataclass
class SidecarConfig:
    package_path: Path
    python_exe: Path
    auto_port: bool = True
    port: Optional[int] = None
    extra_args: list[str] = field(default_factory=list)


def resolve_config() -> SidecarConfig:
    pkg = os.getenv("STABLEDAW_STEMS_PACKAGE")
    package_path = Path(pkg).expanduser().resolve() if pkg else DEFAULT_PACKAGE_PATH
    py = os.getenv("STABLEDAW_STEMS_PYTHON")
    python_exe = Path(py).expanduser().resolve() if py else Path(sys.executable)
    port_env = os.getenv("STABLEDAW_STEMS_PORT")
    port = int(port_env) if (port_env and port_env.isdigit()) else None
    return SidecarConfig(
        package_path=package_path,
        python_exe=python_exe,
        auto_port=port is None,
        port=port,
    )


def _port_file(cfg: SidecarConfig) -> Path:
    return cfg.package_path / PORT_FILENAME


def _is_port_in_use(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        try:
            s.connect((host, port))
            return True
        except OSError:
            return False


def probe(cfg: Optional[SidecarConfig] = None) -> dict:
    """Non-spawning health snapshot used by /api/stems/probe."""
    cfg = cfg or resolve_config()
    out: dict = {
        "ok": False,
        "package_path": str(cfg.package_path),
        "python_exe": str(cfg.python_exe),
        "package_exists": cfg.package_path.is_dir(),
        "run_backend_exists": (cfg.package_path / "run_backend.py").is_file(),
        "demucs_importable": False,
        "demucs_error": None,
        "port_hint": cfg.port,
        "running": False,
    }
    if not out["package_exists"]:
        out["error"] = (
            f"integration-package not found at {cfg.package_path}. "
            f"Set STABLEDAW_STEMS_PACKAGE to point at it, or clone it from "
            f"its source repository."
        )
        return out

    if cfg.python_exe.is_file():
        try:
            result = subprocess.run(
                [str(cfg.python_exe), "-c", "import demucs; print(demucs.__version__)"],
                capture_output=True,
                text=True,
                timeout=15,
            )
            if result.returncode == 0:
                out["demucs_importable"] = True
                out["demucs_version"] = result.stdout.strip()
            else:
                out["demucs_error"] = result.stderr.strip()[:300]
        except (subprocess.TimeoutExpired, OSError) as e:
            out["demucs_error"] = repr(e)
    else:
        out["demucs_error"] = f"python_exe not found: {cfg.python_exe}"

    port_file = _port_file(cfg)
    if port_file.is_file():
        try:
            port = int(port_file.read_text().strip())
            out["last_port"] = port
            out["running"] = _is_port_in_use("127.0.0.1", port)
        except (ValueError, OSError):
            pass

    out["ok"] = (
        out["package_exists"] and out["run_backend_exists"] and out["demucs_importable"]
    )
    return out


class StemsSidecar:
    """Lifecycle wrapper around the integration-package's FastAPI server.

    One instance per process. ``ensure_running()`` is idempotent — calling
    it when the sidecar is already up just returns the cached port.
    """

    def __init__(self, cfg: Optional[SidecarConfig] = None) -> None:
        self.cfg = cfg or resolve_config()
        self._process: Optional[subprocess.Popen] = None
        self._port: Optional[int] = None
        self._client: Optional[httpx.AsyncClient] = None
        self._stdout_log: Optional[Path] = None
        self._stderr_log: Optional[Path] = None

    @property
    def stdout_log(self) -> Optional[Path]:
        return self._stdout_log

    @property
    def stderr_log(self) -> Optional[Path]:
        return self._stderr_log

    @property
    def port(self) -> Optional[int]:
        return self._port

    @property
    def running(self) -> bool:
        if self._process is None:
            return False
        return self._process.poll() is None

    def ensure_running(self) -> int:
        """Spawn the sidecar if it isn't already running, return its port.

        If demucs (or other heavy deps) aren't installed in the configured
        Python, the integration-package's ``run_backend.py`` will pip-
        install them as part of its boot sequence. That can take several
        minutes on first run; HEALTH_TIMEOUT_SEC is sized to allow it.
        Raises only if the install actually fails or never produces a
        port file.
        """
        if self.running and self._port:
            return self._port

        if not self.cfg.package_path.is_dir():
            raise RuntimeError(
                f"stems integration-package not found at {self.cfg.package_path}. "
                f"Set STABLEDAW_STEMS_PACKAGE to point at the package's backend/ dir."
            )
        run_backend = self.cfg.package_path / "run_backend.py"
        if not run_backend.is_file():
            raise RuntimeError(f"stems sidecar launcher missing: {run_backend}")

        # If demucs isn't importable in the configured Python, install
        # deps ourselves rather than letting run_backend.py try (it uses
        # plain `python -m pip` which fails in uv-managed venvs that
        # ship without pip). We use ensurepip / uv-pip fallback.
        if not probe(self.cfg).get("demucs_importable"):
            log.info("stems.sidecar: demucs not importable — installing deps first")
            install_result = install_dependencies(self.cfg)
            if not install_result.get("ok"):
                err_blob = (
                    install_result.get("stderr") or install_result.get("error") or ""
                )
                raise RuntimeError(
                    "stems sidecar dep install failed "
                    f"({install_result.get('install_mode', 'unknown')}): "
                    f"{err_blob[:600]}"
                )

        # Clear any stale port file.
        port_file = _port_file(self.cfg)
        if port_file.exists():
            try:
                port_file.unlink()
            except OSError:
                pass

        cmd = [str(self.cfg.python_exe), str(run_backend), "--log-level", "warning"]
        if self.cfg.port is not None:
            cmd.extend(["--port", str(self.cfg.port)])
        cmd.extend(self.cfg.extra_args)

        log.info("stems.sidecar: spawning %s", " ".join(cmd))
        # Capture stdout/stderr to log files in the package dir so the
        # user can see what the launcher is doing (dependency install,
        # model download, etc.).
        log_dir = self.cfg.package_path / ".sidecar_logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        self._stdout_log = log_dir / "stdout.log"
        self._stderr_log = log_dir / "stderr.log"
        try:
            stdout_fp = open(self._stdout_log, "wb")
            stderr_fp = open(self._stderr_log, "wb")
            self._process = subprocess.Popen(
                cmd,
                cwd=str(self.cfg.package_path),
                stdout=stdout_fp,
                stderr=stderr_fp,
            )
        except OSError as e:
            raise RuntimeError(f"failed to spawn stems sidecar: {e}") from e

        port = self._wait_for_port(port_file)
        if port is None:
            stdout_tail = _tail_log(self._stdout_log)
            stderr_tail = _tail_log(self._stderr_log)
            self.stop()
            raise RuntimeError(
                f"stems sidecar didn't write {PORT_FILENAME} within "
                f"{HEALTH_TIMEOUT_SEC}s.\n"
                f"stdout tail: {stdout_tail[:500]}\n"
                f"stderr tail: {stderr_tail[:500]}"
            )

        if not self._wait_for_health(port):
            stdout_tail = _tail_log(self._stdout_log)
            stderr_tail = _tail_log(self._stderr_log)
            self.stop()
            raise RuntimeError(
                f"stems sidecar on port {port} didn't return healthy.\n"
                f"stdout tail: {stdout_tail[:500]}\n"
                f"stderr tail: {stderr_tail[:500]}"
            )

        self._port = port
        log.info("stems.sidecar: healthy on port %d", port)
        return port

    def _wait_for_port(self, port_file: Path) -> Optional[int]:
        deadline = time.monotonic() + HEALTH_TIMEOUT_SEC
        while time.monotonic() < deadline:
            if self._process is None or self._process.poll() is not None:
                return None
            if port_file.is_file():
                try:
                    txt = port_file.read_text().strip()
                    if txt:
                        return int(txt)
                except (ValueError, OSError):
                    pass
            time.sleep(HEALTH_POLL_INTERVAL_SEC)
        return None

    def _wait_for_health(self, port: int) -> bool:
        deadline = time.monotonic() + HEALTH_TIMEOUT_SEC
        url = f"http://127.0.0.1:{port}/health"
        while time.monotonic() < deadline:
            try:
                with httpx.Client(timeout=2.0) as client:
                    r = client.get(url)
                if r.status_code == 200:
                    return True
            except (httpx.HTTPError, OSError):
                pass
            time.sleep(HEALTH_POLL_INTERVAL_SEC)
        return False

    def stop(self) -> None:
        if self._process is not None:
            try:
                self._process.terminate()
                try:
                    self._process.wait(timeout=10.0)
                except subprocess.TimeoutExpired:
                    self._process.kill()
                    self._process.wait(timeout=5.0)
            except OSError:
                pass
            finally:
                self._process = None
                self._port = None

    # ---- Async proxy -------------------------------------------------------

    async def _ensure_client(self) -> httpx.AsyncClient:
        port = self.ensure_running()
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=f"http://127.0.0.1:{port}",
                timeout=httpx.Timeout(30.0, read=300.0),
            )
        return self._client

    async def submit_separation(
        self,
        audio_path: Path,
        *,
        stems: int = 4,
        device: Optional[str] = None,
    ) -> dict:
        client = await self._ensure_client()
        with audio_path.open("rb") as f:
            files = {"file": (audio_path.name, f, "audio/wav")}
            params: dict = {"stems": stems}
            if device:
                params["device"] = device
            r = await client.post("/upload", files=files, params=params)
        r.raise_for_status()
        return r.json()

    async def poll_status(self, task_id: str) -> dict:
        client = await self._ensure_client()
        r = await client.get(f"/status/{task_id}")
        r.raise_for_status()
        return r.json()

    async def list_stems(self, task_id: str) -> dict:
        client = await self._ensure_client()
        r = await client.get(f"/stems/{task_id}")
        r.raise_for_status()
        return r.json()

    async def fetch_stem_bytes(self, task_id: str, filename: str) -> bytes:
        client = await self._ensure_client()
        r = await client.get(f"/stems/{task_id}/{filename}")
        r.raise_for_status()
        return r.content


_singleton: Optional[StemsSidecar] = None


def get_sidecar() -> StemsSidecar:
    global _singleton
    if _singleton is None:
        _singleton = StemsSidecar()
    return _singleton


def reset_sidecar() -> None:
    """For tests only: drop the cached singleton (does not stop a running process)."""
    global _singleton
    _singleton = None


def _tail_log(path: Optional[Path], n_bytes: int = 1024) -> str:
    """Return the last ``n_bytes`` of a log file as a short string, for
    error messages. Returns '' if the file is missing / unreadable."""
    if path is None or not path.is_file():
        return ""
    try:
        size = path.stat().st_size
        with path.open("rb") as f:
            if size > n_bytes:
                f.seek(size - n_bytes)
            return f.read().decode("utf-8", errors="replace").strip()
    except OSError:
        return ""


def _stems_install_cmd(python_exe: Path, req: Path) -> tuple[list[str], str]:
    """Pick the right pip-install invocation for ``python_exe``.
    See backend.modules.midi.engine._pip_install_cmd for the same logic
    — duplicated here to keep the two modules import-independent.
    """
    pip_check = subprocess.run(
        [str(python_exe), "-c", "import pip"],
        capture_output=True,
        text=True,
        timeout=15,
    )
    if pip_check.returncode == 0:
        return ([str(python_exe), "-m", "pip", "install", "-r", str(req)], "pip")
    ensurepip = subprocess.run(
        [str(python_exe), "-m", "ensurepip", "--upgrade", "--default-pip"],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if ensurepip.returncode == 0:
        return (
            [str(python_exe), "-m", "pip", "install", "-r", str(req)],
            "pip-after-ensurepip",
        )
    return (
        ["uv", "pip", "install", "--python", str(python_exe), "-r", str(req)],
        "uv-pip",
    )


def install_dependencies(cfg: Optional[SidecarConfig] = None) -> dict:
    """Run pip install for the integration-package's requirements.txt
    against the configured Python. Returns ``{ok, output}``. Used by the
    /install endpoint when the user wants to download deps proactively
    rather than waiting for the sidecar's first-spawn auto-install.

    Handles uv-managed venvs that lack pip by ensurepip-bootstrapping
    or falling back to `uv pip install --python <exe>`.
    """
    cfg = cfg or resolve_config()
    req = cfg.package_path / "requirements.txt"
    out: dict = {"ok": False, "python_exe": str(cfg.python_exe)}
    if not req.is_file():
        out["error"] = f"requirements.txt not found at {req}"
        return out
    try:
        argv, install_mode = _stems_install_cmd(cfg.python_exe, req)
        out["install_mode"] = install_mode
        result = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=15 * 60,
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        out["error"] = repr(e)
        return out
    out["returncode"] = result.returncode
    out["stdout"] = result.stdout[-4000:]
    out["stderr"] = result.stderr[-4000:]
    out["ok"] = result.returncode == 0
    return out


__all__ = [
    "DEFAULT_PACKAGE_PATH",
    "SidecarConfig",
    "StemsSidecar",
    "get_sidecar",
    "install_dependencies",
    "probe",
    "reset_sidecar",
    "resolve_config",
]
