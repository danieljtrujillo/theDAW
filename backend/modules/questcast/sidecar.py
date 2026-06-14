"""Quest cast sidecar manager.

Owns the lifecycle of the Node ``sidecars/questcast`` relay: ensures an adb
server is running (reusing the adb that questmidi already relies on), bootstraps
the Node deps + version-matched scrcpy server on first run, spawns the relay,
and parses its structured stdout so the API can report ready/error + the
WebSocket port the browser connects to.

The relay does the heavy lifting (scrcpy protocol → H.264 → WebSocket); this
module is just process lifecycle + diagnostics, mirroring the other sidecars.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Optional

from backend.core.adb import resolve_adb_path

log = logging.getLogger(__name__)

# How many recent relay log lines to retain for the /status diagnostics feed.
LOG_RING_SIZE = 400

PACKAGE_DIR = Path(__file__).resolve().parents[3] / "sidecars" / "questcast"
DEFAULT_WS_PORT = int(os.getenv("theDAW_QUESTCAST_PORT", "8930"))
BOOTSTRAP_TIMEOUT_SEC = 600.0
READY_TIMEOUT_SEC = 60.0


def _adb_path() -> Optional[str]:
    """Resolve adb the same way questmidi does, so both modules share one adb."""
    return resolve_adb_path(
        "theDAW_QUESTCAST_ADB", "theDAW_QUESTMIDI_ADB", "theDAW_ADB"
    )


def _node_path() -> Optional[str]:
    env = os.getenv("theDAW_NODE")
    if env and os.path.isfile(env):
        return env
    return shutil.which("node") or shutil.which("node.exe")


def _npm_cmd() -> Optional[str]:
    return shutil.which("npm") or shutil.which("npm.cmd")


class QuestCastSidecar:
    """One instance per process. ``start()`` is idempotent."""

    def __init__(self) -> None:
        self._proc: Optional[subprocess.Popen] = None
        self._reader: Optional[threading.Thread] = None
        self._lock = threading.RLock()
        self._port = DEFAULT_WS_PORT
        # Latest parsed status from the relay's stdout.
        self._status: dict[str, Any] = {"state": "stopped"}
        self._device_serial: Optional[str] = None
        # Ring buffer of recent relay events (structured msgs + raw chatter +
        # our own lifecycle notes) so the frontend can show EVERYTHING.
        self._log: deque[str] = deque(maxlen=LOG_RING_SIZE)

    def _record(self, line: str) -> None:
        """Append a timestamped line to the diagnostics ring + the Python log."""
        stamp = time.strftime("%H:%M:%S")
        self._log.append(f"{stamp} {line}")
        log.info("questcast: %s", line)

    # ---- diagnostics --------------------------------------------------------

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "running": self.running,
                "ws_port": self._port,
                "adb": _adb_path(),
                "node": _node_path(),
                "package_dir": str(PACKAGE_DIR),
                "bootstrapped": (PACKAGE_DIR / "node_modules").is_dir(),
                "server_bin": (
                    PACKAGE_DIR
                    / "node_modules"
                    / "@yume-chan"
                    / "fetch-scrcpy-server"
                    / "server.bin"
                ).is_file(),
                "log": list(self._log),
                **self._status,
            }

    # ---- lifecycle ----------------------------------------------------------

    def _ensure_adb_server(self) -> Optional[str]:
        adb = _adb_path()
        if not adb:
            return "adb not found — install Android platform-tools or set theDAW_ADB / theDAW_QUESTCAST_ADB"
        try:
            subprocess.run([adb, "start-server"], capture_output=True, timeout=20)
        except (subprocess.TimeoutExpired, OSError) as e:
            return f"could not start adb server: {e}"
        return None

    def _ensure_bootstrap(self) -> Optional[str]:
        if (PACKAGE_DIR / "node_modules").is_dir() and (
            PACKAGE_DIR
            / "node_modules"
            / "@yume-chan"
            / "fetch-scrcpy-server"
            / "server.bin"
        ).is_file():
            return None
        npm = _npm_cmd()
        if not npm:
            return "npm not found — cannot bootstrap the questcast sidecar deps"
        log.info("questcast: bootstrapping Node deps (one-time)…")
        try:
            result = subprocess.run(
                [npm, "install"],
                cwd=str(PACKAGE_DIR),
                capture_output=True,
                text=True,
                timeout=BOOTSTRAP_TIMEOUT_SEC,
            )
        except (subprocess.TimeoutExpired, OSError) as e:
            return f"npm install failed: {e}"
        if result.returncode != 0:
            return (
                f"npm install failed (rc={result.returncode}): {result.stderr[-400:]}"
            )
        return None

    def list_devices(self) -> dict[str, Any]:
        """Quick adb device list without starting the relay."""
        adb = _adb_path()
        if not adb:
            return {"ok": False, "error": "adb not found", "devices": []}
        err = self._ensure_adb_server()
        if err:
            return {"ok": False, "error": err, "devices": []}
        try:
            out = subprocess.run(
                [adb, "devices"], capture_output=True, text=True, timeout=15
            )
        except (subprocess.TimeoutExpired, OSError) as e:
            return {"ok": False, "error": str(e), "devices": []}
        devices = []
        for line in out.stdout.splitlines()[1:]:
            line = line.strip()
            if not line or "\t" not in line:
                continue
            serial, state = line.split("\t", 1)
            devices.append({"serial": serial, "state": state.strip()})
        return {"ok": True, "devices": devices}

    def _read_stdout(self, proc: subprocess.Popen) -> None:
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                # Non-JSON: node console.error / scrcpy stderr etc. Keep it ALL.
                with self._lock:
                    self._record(f"[relay raw] {line}")
                continue
            status = msg.get("status")
            # Record every structured event verbatim (compact) for diagnostics.
            with self._lock:
                detail = {k: v for k, v in msg.items() if k != "status"}
                self._record(
                    f"[relay] {status}"
                    + (f" {json.dumps(detail, default=str)}" if detail else "")
                )
                if status == "ready":
                    self._status = {"state": "ready", **msg}
                    self._port = int(msg.get("port", self._port))
                elif status == "error":
                    self._status = {"state": "error", **msg}
                elif status == "device":
                    self._status.setdefault("devices", msg.get("all"))
                    self._device_serial = msg.get("serial")
                elif status == "video-ended":
                    self._status = {"state": "stopped", "reason": "video-ended"}
        # The stdout pipe closed → the relay process exited.
        with self._lock:
            rc = proc.poll()
            self._record(f"[relay] process exited (rc={rc})")
            if self._status.get("state") not in ("error", "stopped"):
                self._status = {
                    "state": "stopped",
                    "reason": f"relay exited (rc={rc})",
                }

    def start(self, device_serial: Optional[str] = None) -> dict[str, Any]:
        with self._lock:
            if self.running:
                self._record("start() ignored — relay already running")
                return self.status()

            self._record(
                f"start() requested (serial={device_serial or 'first device'})"
            )

            node = _node_path()
            if not node:
                self._record("ABORT: node not found on PATH / theDAW_NODE")
                self._status = {"state": "error", "message": "node not found"}
                return {"ok": False, "error": "node not found — install Node.js"}
            self._record(f"node: {node}")

            adb = _adb_path()
            self._record(f"adb: {adb or 'NOT FOUND'}")
            err = self._ensure_adb_server()
            if err:
                self._record(f"ABORT: adb server: {err}")
                self._status = {"state": "error", "message": err}
                return {"ok": False, "error": err}
            self._record("adb start-server ok")

            self._record("ensuring node deps + scrcpy server (bootstrap)…")
            err = self._ensure_bootstrap()
            if err:
                self._record(f"ABORT: bootstrap: {err}")
                self._status = {"state": "error", "message": err}
                return {"ok": False, "error": err}
            self._record("bootstrap ok")

            env = dict(os.environ)
            env["QUESTCAST_WS_PORT"] = str(self._port)
            if device_serial:
                env["QUESTCAST_DEVICE_SERIAL"] = device_serial
            if adb:
                # The relay talks to the adb server over TCP; default 5037.
                env.setdefault("QUESTCAST_ADB_HOST", "127.0.0.1")
                env.setdefault("QUESTCAST_ADB_PORT", "5037")

            self._status = {"state": "starting"}
            self._record(
                f"spawning relay: node server.mjs {self._port} "
                f"(ws_port={self._port}, adb={env.get('QUESTCAST_ADB_HOST')}:"
                f"{env.get('QUESTCAST_ADB_PORT')})"
            )
            try:
                self._proc = subprocess.Popen(
                    [node, "server.mjs", str(self._port)],
                    cwd=str(PACKAGE_DIR),
                    env=env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                )
            except OSError as e:
                self._record(f"ABORT: spawn failed: {e}")
                self._status = {"state": "error", "message": str(e)}
                return {"ok": False, "error": str(e)}

            self._record(f"relay process started (pid={self._proc.pid})")
            self._reader = threading.Thread(
                target=self._read_stdout, args=(self._proc,), daemon=True
            )
            self._reader.start()

        # Wait (outside the lock) for the relay to report ready or error.
        deadline = time.monotonic() + READY_TIMEOUT_SEC
        while time.monotonic() < deadline:
            if not self.running:
                break
            with self._lock:
                state = self._status.get("state")
            if state in ("ready", "error"):
                break
            time.sleep(0.25)
        return self.status()

    def stop(self) -> dict[str, Any]:
        with self._lock:
            proc = self._proc
            self._proc = None
            self._status = {"state": "stopped"}
            self._record("stop() requested — terminating relay")
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        return {"ok": True, "state": "stopped"}


_sidecar: Optional[QuestCastSidecar] = None


def get_sidecar() -> QuestCastSidecar:
    global _sidecar
    if _sidecar is None:
        _sidecar = QuestCastSidecar()
    return _sidecar
