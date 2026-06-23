"""Client for the Magenta RealTime 2 (mrt2) sidecar.

The live sidecar is theDAW's extended MRT2 server (``sidecars/magenta/server.py``)
running in WSL2 on the NVIDIA GPU. It supersedes the bundle's text-only
``studio_server.py``: it loads ``MagentaRT2Jax`` once and exposes a small HTTP API:

    GET  /health    -> {"ready": bool, "status": str, "model": str, "device": str}
    POST /generate  -> multipart {prompt, duration, temperature, top_k,
                                  cfg_musiccoca, cfg_notes, notes?, audio?}
                       -> audio/wav bytes (48 kHz stereo)

Conditioning is combinable per the model: a **text** prompt (default), a list of
**MIDI notes** (``notes`` = ``[{pitch:0-127,start,end}]``, encoded to the model's
128-pitch state windows), and/or an **audio-style** reference clip (``audio``,
embedded via the model's style encoder; overrides the prompt). The response
``X-Conditioning`` header reports which mode(s) were used. Override the URL with
``THEDAW_MAGENTA_URL`` (default ``http://localhost:8777``).
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

SIDECAR_URL = os.getenv("THEDAW_MAGENTA_URL", "http://localhost:8777").rstrip("/")

# The identity the EXTENDED sidecar reports in /health. The bundled Studio server
# answers ``ready: true`` too but speaks an incompatible JSON protocol and reports
# ``app: "mrt2-studio"`` — the probe must never mistake it for ours.
EXPECTED_APP = "mrt2-extended"


async def health() -> dict:
    """Probe the sidecar. Always returns a dict with an ``available`` flag.

    ``available`` is True only when the responder is ready AND speaks the
    extended protocol (identity field absent = an older extended build, accepted;
    ``mrt2-studio`` = the bundled JSON-protocol Studio server, rejected).
    """
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{SIDECAR_URL}/health")
            r.raise_for_status()
            data = r.json()
            app_id = data.get("app")
            protocol_ok = app_id in (None, EXPECTED_APP)
            return {
                **data,
                "reachable": True,
                "protocol_ok": protocol_ok,
                "available": bool(data.get("ready")) and protocol_ok,
                "url": SIDECAR_URL,
            }
    except Exception as e:
        log.debug("Magenta sidecar not reachable at %s: %s", SIDECAR_URL, e)
        return {
            "available": False,
            "reachable": False,
            "protocol_ok": False,
            "url": SIDECAR_URL,
        }


# ── engine lifecycle (the WSL2 process behind SIDECAR_URL) ──────────────────
#
# The extended sidecar runs inside WSL2 (JAX needs the Linux CUDA stack). The
# spawn mirrors the bundled MRT2-Studio.vbs launcher: same distro detection
# (``.wsl_distro`` written by Setup, fallback Ubuntu), same venv, no console
# window. ``stop_engine`` also kills the bundled Studio server so two engines
# never contend for the GPU.

_REPO_ROOT = Path(__file__).resolve().parents[3]
_ENGINE_SCRIPT = _REPO_ROOT / "sidecars" / "magenta" / "server.py"
_DISTRO_FILE = _REPO_ROOT / "sidecars" / "magenta-rt2-nvidia" / "app" / ".wsl_distro"
_ENGINE_MODEL = os.getenv("THEDAW_MAGENTA_MODEL", "mrt2_small")
_WSL_PYTHON = os.getenv("THEDAW_MAGENTA_WSL_PY", "~/mrt2/.venv/bin/python")
# pkill pattern matching BOTH magenta engines (extended + bundled Studio).
_ENGINE_PKILL_PATTERN = "sidecars/magenta/server.py|studio_server.py"

_engine_lock = threading.Lock()
_engine_proc: subprocess.Popen | None = None


def _wsl_distro() -> str:
    try:
        name = _DISTRO_FILE.read_text(encoding="utf-8").strip()
        if name:
            return name
    except OSError:
        pass
    return "Ubuntu"


def _wsl_path(p: Path) -> str:
    """Convert a Windows path to its WSL mount path (D:\\x\\y -> /mnt/d/x/y)."""
    s = str(p.resolve())
    if len(s) > 1 and s[1] == ":":
        return "/mnt/" + s[0].lower() + s[2:].replace("\\", "/")
    return s.replace("\\", "/")


def engine_process_alive() -> bool:
    return _engine_proc is not None and _engine_proc.poll() is None


_setup_cache: dict = {"t": 0.0, "state": None}
_SETUP_CACHE_SECONDS = 30.0


def setup_state(refresh: bool = False) -> dict:
    """Is the WSL side actually installed? Probes the venv python, the
    extended server's web deps (fastapi/uvicorn/python-multipart), and the
    model checkpoints so the UI can say 'setup required' instead of a bare
    error when Setup-MRT2 never ran (or the venv predates the web deps).
    Cached for 30 s (the wsl spawn is ~a second); pass ``refresh=True``
    after a setup run."""
    now = time.monotonic()
    if (
        not refresh
        and _setup_cache["state"] is not None
        and now - _setup_cache["t"] < _SETUP_CACHE_SECONDS
    ):
        return _setup_cache["state"]

    state = {
        "wsl": False,
        "venv": False,
        "deps": False,
        "checkpoint": False,
        "ready": False,
    }
    try:
        py = _WSL_PYTHON.replace("'", "")
        result = subprocess.run(
            [
                "wsl.exe",
                "-d",
                _wsl_distro(),
                "--",
                "bash",
                "-lc",
                f"echo WSL_OK; test -x {py} && echo VENV_OK; "
                f"{py} -c 'import numpy,soundfile,fastapi,uvicorn,multipart' "
                "2>/dev/null && echo DEPS_OK; "
                "ls ~/Documents/Magenta/magenta-rt-v2/checkpoints/*.safetensors "
                ">/dev/null 2>&1 && echo CKPT_OK",
            ],
            capture_output=True,
            text=True,
            timeout=15,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            shell=False,
        )
        out = result.stdout
        state["wsl"] = "WSL_OK" in out
        state["venv"] = "VENV_OK" in out
        state["deps"] = "DEPS_OK" in out
        state["checkpoint"] = "CKPT_OK" in out
    except (OSError, subprocess.TimeoutExpired) as e:
        log.debug("magenta.engine: setup probe failed: %s", e)
    state["ready"] = state["venv"] and state["deps"] and state["checkpoint"]
    _setup_cache["t"] = now
    _setup_cache["state"] = state
    return state


def start_engine() -> dict:
    """Spawn the extended sidecar in WSL2 (blocking call, returns immediately
    after the spawn; readiness is observed via ``health()``)."""
    global _engine_proc
    with _engine_lock:
        if engine_process_alive():
            return {"spawned": False, "reason": "engine process already alive"}
        if not _ENGINE_SCRIPT.is_file():
            raise RuntimeError(f"engine script not found: {_ENGINE_SCRIPT}")
        distro = _wsl_distro()
        port = SIDECAR_URL.rsplit(":", 1)[-1] or "8777"
        bash_cmd = (
            f"MRT2_PORT={port} MRT2_MODEL={_ENGINE_MODEL} "
            f"exec {_WSL_PYTHON} '{_wsl_path(_ENGINE_SCRIPT)}'"
        )
        cmd = ["wsl.exe", "-d", distro, "--", "bash", "-lc", bash_cmd]
        creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        # Capture the sidecar's output to a logfile instead of DEVNULL — a
        # spawn that dies on a missing dep (e.g. ModuleNotFoundError) would
        # otherwise vanish and surface only as a vague 503 downstream.
        log_path = _REPO_ROOT / "logs" / "magenta-sidecar.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log.info("magenta.engine: spawning %s (log: %s)", " ".join(cmd), log_path)
        with open(log_path, "ab") as log_fh:
            _engine_proc = subprocess.Popen(
                cmd,
                stdout=log_fh,
                stderr=subprocess.STDOUT,
                creationflags=creationflags,
                shell=False,
            )
        return {"spawned": True, "distro": distro, "model": _ENGINE_MODEL, "port": port}


def stop_engine() -> dict:
    """Stop every magenta engine: our tracked child plus any engine started
    outside the app (the .vbs launcher, a manual run), via pkill inside WSL."""
    global _engine_proc
    with _engine_lock:
        terminated = False
        if engine_process_alive():
            try:
                _engine_proc.terminate()
                _engine_proc.wait(timeout=5.0)
                terminated = True
            except subprocess.TimeoutExpired:
                _engine_proc.kill()
                terminated = True
        _engine_proc = None
        pkilled = False
        try:
            rc = subprocess.run(
                [
                    "wsl.exe",
                    "-d",
                    _wsl_distro(),
                    "--",
                    "bash",
                    "-lc",
                    f"pkill -f '{_ENGINE_PKILL_PATTERN}' || true",
                ],
                timeout=20,
                capture_output=True,
                shell=False,
            ).returncode
            pkilled = rc == 0
        except Exception as e:
            log.warning("magenta.engine: WSL pkill failed: %s", e)
        return {"terminated": terminated, "pkilled": pkilled}


async def generate(
    *,
    prompt: str,
    duration: float = 10.0,
    temperature: float = 1.3,
    top_k: int = 40,
    cfg_musiccoca: float = 3.0,
    cfg_notes: float = 1.0,
    cfg_drums: float = 1.0,
    drums: int = -1,
    chunk_frames: int = 25,
    notes: list[dict] | str | None = None,
    seed: int = 0,
    extend: bool = False,
    styles: list[dict] | str | None = None,
    audio_bytes: bytes | None = None,
    audio_mime: str = "audio/wav",
) -> tuple[bytes, dict]:
    """Generate audio. Returns ``(wav_bytes, meta_headers)``.

    Conditioning (all optional, combinable per the model):
      - ``prompt``: text style (used when no ``audio_bytes`` style is given).
      - ``notes``: piano-roll events ``[{pitch, start, end}, ...]`` (or a JSON
        string) -> MIDI-conditioned accompaniment.
      - ``audio_bytes``: a clip whose style is embedded (clone / style-transfer).

    Sent as multipart to the extended sidecar (sidecars/magenta/server.py), which
    renders synchronously and replies with WAV bytes + ``X-RTF`` / ``X-Audio-Seconds``
    / ``X-Generate-Seconds`` / ``X-Sample-Rate`` / ``X-Conditioning`` headers.
    """
    data: dict[str, str] = {
        "prompt": prompt or "",
        "duration": str(float(duration)),
        "temperature": str(float(temperature)),
        "top_k": str(int(top_k)),
        "cfg_musiccoca": str(float(cfg_musiccoca)),
        "cfg_notes": str(float(cfg_notes)),
        "cfg_drums": str(float(cfg_drums)),
        "drums": str(int(drums)),
        "chunk_frames": str(int(chunk_frames)),
        "seed": str(int(seed)),
        "extend": "true" if extend else "false",
    }
    if notes:
        data["notes"] = notes if isinstance(notes, str) else json.dumps(notes)
    if styles:
        data["styles"] = styles if isinstance(styles, str) else json.dumps(styles)
    files = {"audio": ("style.wav", audio_bytes, audio_mime)} if audio_bytes else None

    # Generation can take a while for long durations; allow a long read timeout.
    async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=600)) as client:
        r = await client.post(f"{SIDECAR_URL}/generate", data=data, files=files)
        r.raise_for_status()
        meta = {
            k: r.headers.get(k)
            for k in (
                "X-RTF",
                "X-Audio-Seconds",
                "X-Segment-Seconds",
                "X-Generate-Seconds",
                "X-Sample-Rate",
                "X-Extend",
                "X-Conditioning",
            )
            if r.headers.get(k)
        }
        return r.content, meta
