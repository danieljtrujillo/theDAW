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

Engine state model (``engine_state``), shared by every route and by the storage
provider card so no surface has to guess from prose:

    running        the extended engine answers /health with ready=true
    starting       spawned / answering but still loading + compiling
    error          the engine is up but its model load failed (see /health)
    not_running    installed (venv + deps + a checkpoint) but no engine process
    not_installed  the WSL side was never set up (Setup-MRT2 / Install button)
    probe_failed   the install probe itself did not answer (WSL cold start,
                   timeout) -- NOT "not installed"; the caller should retry
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

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
# The one-time installer, so the UI can LAUNCH it on a button press instead of
# printing "go and double-click Setup-MRT2.bat". Fixed at import time and never
# taken from a request, so no caller can point this at another executable.
_INSTALLER = _REPO_ROOT / "sidecars" / "magenta-rt2-nvidia" / "Setup-MRT2.bat"
# Env default for the engine model; the in-app pick (``set_engine_model``) is
# persisted in _MODEL_FILE and outranks it, see ``engine_model``.
_ENGINE_MODEL = os.getenv("THEDAW_MAGENTA_MODEL", "mrt2_small")
_MODEL_FILE = _REPO_ROOT / "data" / "magenta_engine.json"
_WSL_PYTHON = os.getenv("THEDAW_MAGENTA_WSL_PY", "~/mrt2/.venv/bin/python")
# Native engine interpreter for Linux/macOS auto-spawn (Windows uses WSL). On
# Linux this is the CUDA JAX venv; on macOS the magenta-rt[mlx] venv. The
# zero-config cross-platform path is to run the engine yourself and set
# THEDAW_MAGENTA_URL — then no interpreter is needed here at all.
_NATIVE_PYTHON = os.getenv("THEDAW_MAGENTA_PYTHON", "~/mrt2/.venv/bin/python")
# pkill pattern matching BOTH magenta engines (extended + bundled Studio).
_ENGINE_PKILL_PATTERN = "sidecars/magenta/server.py|studio_server.py"
# Where the vendored sidecar keeps model assets (``mrt models init`` /
# ``mrt checkpoints download`` write here; the engine loads from here).
_ASSETS_DIR = "~/Documents/Magenta/magenta-rt-v2"
_CHECKPOINTS_DIR = f"{_ASSETS_DIR}/checkpoints"
_LOG_DIR = _REPO_ROOT / "logs"

# ── the model catalog ───────────────────────────────────────────────────────
#
# Exactly the checkpoints the vendored sidecar can load: the registry in
# sidecars/magenta-rt2-nvidia/port_src/magenta_rt/jax/model.py (MODEL_CLASSES)
# and jax/system.py (_CHECKPOINT_REGISTRY) know two sizes, and only two. The
# VRAM figures are the sidecar's own numbers (cloud/launcher.py MODEL_REQS
# ``how_local``: our extended server is the JAX fp32 path, not the native int8
# one), so the "runnable here?" verdict is the sidecar's verdict, not a guess.
CHECKPOINT_REPO = "google/magenta-realtime-2"  # cli/models_commands.py _HF_REPO_NAME
DEFAULT_ENGINE_MODEL = "mrt2_small"
ENGINE_MODELS: dict[str, dict] = {
    "mrt2_small": {
        "label": "MRT2 Small",
        "params": "230M",
        "checkpoint": "mrt2_small.safetensors",
        # ~1.1 GB download (install/setup_all.sh); "JAX fp32 (~4 GB)" VRAM.
        "download_bytes": 1_128_840_272,
        "jax_vram_gb": 4.0,
        "how_local": "JAX fp32 needs about 4 GB of VRAM",
    },
    "mrt2_base": {
        "label": "MRT2 Base",
        "params": "2.4B",
        "checkpoint": "mrt2_base.safetensors",
        "download_bytes": None,
        "jax_vram_gb": 12.0,
        "how_local": (
            "JAX fp32 wants about 12 GB of VRAM; the sidecar's own docs run this "
            "size on a cloud GPU (RunPod)"
        ),
    },
}

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


def _no_window_flags() -> int:
    return subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0


def _engine_python() -> str:
    """The engine interpreter as a shell word (WSL venv on Windows, native
    venv elsewhere). Single quotes are stripped so the probe/download commands
    can embed it inside ``bash -lc`` without nested quoting."""
    if sys.platform == "win32":
        return _WSL_PYTHON.replace(chr(39), "")
    return str(Path(_NATIVE_PYTHON).expanduser())


def _sh_path(p: str) -> str:
    """A path for use INSIDE double quotes in bash: a leading ``~`` becomes
    ``$HOME`` (a quoted tilde is never expanded — quoting it as-is is exactly
    the bug that read an installed venv as missing)."""
    p = p.replace('"', "")
    return "$HOME" + p[1:] if p.startswith("~") else p


def _bash_cmd(script: str) -> list[str]:
    """Run ``script`` under a login bash: inside the WSL distro on Windows,
    natively on Linux/macOS."""
    if sys.platform == "win32":
        return ["wsl.exe", "-d", _wsl_distro(), "--", "bash", "-lc", script]
    return ["bash", "-lc", script]


# ── persisted engine model pick ─────────────────────────────────────────────


def engine_model() -> str:
    """The checkpoint the next engine start loads.

    Precedence: the in-app pick (data/magenta_engine.json) > the
    THEDAW_MAGENTA_MODEL env var > mrt2_small. An env value outside the
    catalog is passed through untouched (a custom checkpoint name is the
    user's business); the in-app pick is validated on write instead.
    """
    try:
        data = json.loads(_MODEL_FILE.read_text(encoding="utf-8"))
        picked = str(data.get("model") or "").strip()
        if picked in ENGINE_MODELS:
            return picked
    except (OSError, ValueError):
        pass
    return _ENGINE_MODEL.strip() or DEFAULT_ENGINE_MODEL


def set_engine_model(model_id: str) -> str:
    """Persist the engine model pick. Raises ValueError for an unknown id."""
    if model_id not in ENGINE_MODELS:
        raise ValueError(
            f"Unknown Magenta model {model_id!r}. The sidecar supports: "
            + ", ".join(ENGINE_MODELS)
        )
    _MODEL_FILE.parent.mkdir(parents=True, exist_ok=True)
    _MODEL_FILE.write_text(json.dumps({"model": model_id}, indent=2), encoding="utf-8")
    log.info("magenta: engine model set to %s", model_id)
    return model_id


# ── GPU + per-model verdicts ────────────────────────────────────────────────

_gpu_cache: dict | None = None


def gpu_info() -> dict:
    """Name + VRAM of the local NVIDIA GPU(s). torch first (already loaded in
    this process, instant), nvidia-smi as the fallback. Cached for the process
    lifetime: cards do not come and go."""
    global _gpu_cache
    if _gpu_cache is not None:
        return _gpu_cache
    gpus: list[dict] = []
    try:
        import torch

        if torch.cuda.is_available():
            for i in range(torch.cuda.device_count()):
                props = torch.cuda.get_device_properties(i)
                gpus.append(
                    {
                        "name": props.name,
                        "vram_gb": round(props.total_memory / 2**30, 1),
                    }
                )
    except Exception:  # noqa: BLE001 - torch absent or CUDA broken: try smi
        gpus = []
    if not gpus:
        try:
            out = subprocess.run(
                [
                    "nvidia-smi",
                    "--query-gpu=name,memory.total",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True,
                text=True,
                timeout=12,
                creationflags=_no_window_flags(),
            ).stdout
            for line in out.strip().splitlines():
                parts = [p.strip() for p in line.split(",")]
                if len(parts) >= 2:
                    try:
                        gpus.append(
                            {
                                "name": parts[0],
                                "vram_gb": round(float(parts[1]) / 1024, 1),
                            }
                        )
                    except ValueError:
                        continue
        except (OSError, subprocess.TimeoutExpired):
            pass
    best = max((g["vram_gb"] for g in gpus), default=None)
    _gpu_cache = {"gpus": gpus, "best_vram_gb": best}
    return _gpu_cache


def model_verdict(model_id: str, vram_gb: float | None) -> dict:
    """Can this checkpoint run on the local card? Mirrors the vendored
    launcher's yes / tight / no split, against its JAX fp32 figures."""
    spec = ENGINE_MODELS[model_id]
    need = float(spec["jax_vram_gb"])
    base = f"{spec['params']} parameters · {spec['how_local']}"
    if vram_gb is None:
        return {
            "runnable": "unknown",
            "reason": f"{base}. No NVIDIA GPU detected on this PC.",
        }
    have = f"this GPU has {vram_gb:g} GB"
    if vram_gb >= need:
        return {"runnable": "yes", "reason": f"{base}; {have} — fits."}
    if vram_gb >= need - 2.0:
        return {
            "runnable": "tight",
            "reason": f"{base}; {have} — tight, it may not fit.",
        }
    return {
        "runnable": "no",
        "reason": f"{base}; {have} — not enough VRAM to run it locally.",
    }


# ── install probe ───────────────────────────────────────────────────────────

_setup_cache: dict = {"t": 0.0, "state": None}
_SETUP_CACHE_SECONDS = 30.0
# A failed probe (WSL still waking up, timeout) is cached only briefly: it is
# a "try again" answer, not a fact about the install.
_SETUP_FAILURE_CACHE_SECONDS = 5.0
# The first wsl.exe call after a Windows boot can take well over ten seconds.
# A short timeout here is exactly what used to read as "not installed".
_SETUP_PROBE_TIMEOUT = 30


def setup_state(refresh: bool = False) -> dict:
    """Is the WSL side actually installed? Probes the venv python, the
    extended server's web deps (fastapi/uvicorn/python-multipart), and the
    model checkpoints so the UI can say 'setup required' instead of a bare
    error when Setup-MRT2 never ran (or the venv predates the web deps).

    Returns ``{wsl, venv, deps, checkpoint, checkpoints: [file...], ready,
    probe_failed, probe_error}``. ``probe_failed`` means the probe itself did
    not answer; ``ready`` is False then too, but that is NOT "not installed" —
    callers must keep the two apart. Cached for 30 s (failures 5 s); pass
    ``refresh=True`` after a setup run or a checkpoint download."""
    now = time.monotonic()
    cached = _setup_cache["state"]
    if not refresh and cached is not None:
        ttl = (
            _SETUP_FAILURE_CACHE_SECONDS
            if cached.get("probe_failed")
            else _SETUP_CACHE_SECONDS
        )
        if now - _setup_cache["t"] < ttl:
            return cached

    state: dict = {
        "wsl": False,
        "venv": False,
        "deps": False,
        "checkpoint": False,
        "checkpoints": [],
        "ready": False,
        "probe_failed": False,
        "probe_error": None,
    }
    py = _sh_path(_engine_python())
    ckpts = _sh_path(_CHECKPOINTS_DIR)
    # "WSL_OK" means "platform prerequisite satisfied" — on Linux/macOS the
    # probe runs natively, so it is always true there.
    script = (
        f'echo WSL_OK; test -x "{py}" && echo VENV_OK; '
        f"\"{py}\" -c 'import numpy,soundfile,fastapi,uvicorn,multipart' "
        "2>/dev/null && echo DEPS_OK; "
        f"ls \"{ckpts}/\" 2>/dev/null | sed 's/^/CKPT:/'"
    )
    try:
        result = subprocess.run(
            _bash_cmd(script),
            capture_output=True,
            text=True,
            timeout=_SETUP_PROBE_TIMEOUT,
            creationflags=_no_window_flags(),
            shell=False,
        )
        out = result.stdout or ""
        state["wsl"] = "WSL_OK" in out
        state["venv"] = "VENV_OK" in out
        state["deps"] = "DEPS_OK" in out
        state["checkpoints"] = sorted(
            {
                ln[len("CKPT:") :].strip()
                for ln in out.splitlines()
                if ln.startswith("CKPT:") and ln.strip().endswith(".safetensors")
            }
        )
        state["checkpoint"] = bool(state["checkpoints"])
        if not state["wsl"]:
            # wsl.exe ran but the distro never echoed: treat as a probe
            # failure (distro missing / not started), not as "not installed".
            err = (result.stderr or "").strip().splitlines()
            state["probe_failed"] = True
            state["probe_error"] = (
                err[-1][:200] if err else "the WSL distro did not answer"
            )
    except subprocess.TimeoutExpired:
        state["probe_failed"] = True
        state["probe_error"] = (
            f"the install check timed out after {_SETUP_PROBE_TIMEOUT}s "
            "(WSL may still be starting)"
        )
        log.debug("magenta.engine: setup probe timed out")
    except OSError as e:
        state["probe_failed"] = True
        state["probe_error"] = str(e)[:200]
        log.debug("magenta.engine: setup probe failed: %s", e)
    state["ready"] = bool(state["venv"] and state["deps"] and state["checkpoint"])
    _setup_cache["t"] = now
    _setup_cache["state"] = state
    return state


def engine_state(health_info: dict, setup: dict | None) -> str:
    """Collapse a /health probe + the install probe into one machine-readable
    state (see the module docstring). ``setup=None`` means the caller did not
    probe the install; the answer is then ``not_running`` at worst."""
    if health_info.get("available"):
        return "running"
    if health_info.get("reachable") and health_info.get("protocol_ok"):
        status = str(health_info.get("status") or "")
        if health_info.get("error") or status.startswith("error"):
            return "error"
        return "starting"
    if engine_process_alive():
        return "starting"
    if setup is None:
        return "not_running"
    if setup.get("probe_failed"):
        return "probe_failed"
    if not setup.get("ready"):
        return "not_installed"
    return "not_running"


def installer_available() -> bool:
    """Whether this checkout ships the one-time installer at all."""
    return _INSTALLER.is_file()


def model_catalog(setup: dict | None = None) -> dict:
    """The real model list: every checkpoint the sidecar supports, stamped
    with installed / active / runnable-here, plus the GPU it was judged on."""
    setup = setup if setup is not None else setup_state()
    installed = set(setup.get("checkpoints") or [])
    active = engine_model()
    gpu = gpu_info()
    jobs = {j["model"]: j for j in checkpoint_jobs()}
    models = []
    for model_id, spec in ENGINE_MODELS.items():
        verdict = model_verdict(model_id, gpu.get("best_vram_gb"))
        models.append(
            {
                "id": model_id,
                "label": spec["label"],
                "params": spec["params"],
                "checkpoint": spec["checkpoint"],
                "repo_id": CHECKPOINT_REPO,
                "download_bytes": spec["download_bytes"],
                "installed": spec["checkpoint"] in installed,
                "active": model_id == active,
                "download": jobs.get(model_id),
                **verdict,
            }
        )
    return {"active": active, "gpu": gpu, "models": models}


def launch_installer() -> dict:
    """Start the installer in its own console window and return immediately.

    This is the click that replaces "go run Setup-MRT2.bat". The installer is
    interactive by design — it states what it needs, how large the downloads
    are, and asks for consent — so it gets a real console the user can answer
    in, rather than being buried in a hidden pipe. Nothing is waited on here;
    the caller polls ``setup_state(refresh=True)`` for the outcome.
    """
    if sys.platform != "win32":
        raise RuntimeError(
            "The one-click Magenta RT2 installer is Windows-only. On Linux and "
            "macOS, run the engine yourself and point theDAW at it with "
            "THEDAW_MAGENTA_URL."
        )
    if not _INSTALLER.is_file():
        raise FileNotFoundError(
            f"The Magenta RT2 installer is missing from this checkout ({_INSTALLER})."
        )
    proc = subprocess.Popen(  # noqa: S603 - fixed path, never request-supplied
        ["cmd.exe", "/c", str(_INSTALLER)],
        cwd=str(_INSTALLER.parent),
        creationflags=subprocess.CREATE_NEW_CONSOLE,
        close_fds=True,
    )
    log.info("magenta: launched installer %s (pid %s)", _INSTALLER, proc.pid)
    return {"pid": proc.pid, "installer": str(_INSTALLER)}


# ── checkpoint downloads (mrt checkpoints download, in the engine venv) ─────

_dl_lock = threading.Lock()
_dl_jobs: dict[str, dict] = {}
_PROGRESS_RE = re.compile(
    r"(\d{1,3})%\|[^|]*\|\s*([\d.]+\s*[kKMGT]?i?B?)/([\d.]+\s*[kKMGT]?i?B?)"
)
_UNIT = {"": 1, "k": 1024, "m": 1024**2, "g": 1024**3, "t": 1024**4}


def _parse_size(text: str) -> int | None:
    m = re.match(r"([\d.]+)\s*([kKMGT]?)", text.strip())
    if not m:
        return None
    try:
        return int(float(m.group(1)) * _UNIT[m.group(2).lower()])
    except (ValueError, KeyError):
        return None


def _download_log_path(model_id: str) -> Path:
    return _LOG_DIR / f"magenta-download-{model_id}.log"


def _log_tail(path: Path, max_bytes: int = 4096) -> str:
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - max_bytes))
            return fh.read().decode("utf-8", "replace")
    except OSError:
        return ""


def _refresh_download_progress(job: dict) -> None:
    """Best-effort progress from the CLI's tqdm bar (``45%|████| 4.5G/10G``).
    The bar rewrites its line with carriage returns, so the last fragment of
    the log holds the latest figure."""
    tail = _log_tail(_download_log_path(job["model"]))
    if not tail:
        return
    frags = [f for f in re.split(r"[\r\n]", tail) if f.strip()]
    for frag in reversed(frags):
        m = _PROGRESS_RE.search(frag)
        if m:
            job["percent"] = int(m.group(1))
            done = _parse_size(m.group(2))
            total = _parse_size(m.group(3))
            if done is not None:
                job["bytes_done"] = done
            if total:
                job["bytes_total"] = total
            return
    job["log_tail"] = "\n".join(frags[-6:])[-600:]


def checkpoint_jobs() -> list[dict]:
    with _dl_lock:
        jobs = [dict(j) for j in _dl_jobs.values()]
    for job in jobs:
        if job["status"] == "downloading":
            _refresh_download_progress(job)
    return jobs


def clear_checkpoint_jobs() -> int:
    with _dl_lock:
        finished = [k for k, j in _dl_jobs.items() if j["status"] != "downloading"]
        for k in finished:
            del _dl_jobs[k]
    return len(finished)


def _download_worker(model_id: str, job: dict) -> None:
    spec = ENGINE_MODELS[model_id]
    py = _engine_python()
    mrt = _sh_path(py.rsplit("/", 1)[0] + "/mrt" if "/" in py else "mrt")
    script = f'"{mrt}" checkpoints download {spec["checkpoint"]} --source hf'
    log_path = _download_log_path(model_id)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log.info("magenta: downloading %s via %s (log: %s)", model_id, script, log_path)
    rc: int | None = None
    error: str | None = None
    try:
        with open(log_path, "wb") as fh:
            rc = subprocess.call(
                _bash_cmd(script),
                stdout=fh,
                stderr=subprocess.STDOUT,
                timeout=3 * 3600,
                creationflags=_no_window_flags(),
                shell=False,
            )
    except subprocess.TimeoutExpired:
        error = "the download did not finish within 3 hours"
    except OSError as e:
        error = str(e)
    if error is None and rc != 0:
        tail = _log_tail(log_path, 2048)
        lines = [ln for ln in re.split(r"[\r\n]", tail) if ln.strip()]
        error = "\n".join(lines[-8:]) or f"mrt checkpoints download exited with {rc}"
    # Re-probe so the catalog / provider card flips to installed immediately.
    setup = setup_state(refresh=True)
    with _dl_lock:
        job["finished_at"] = time.time()
        job["rc"] = rc
        if error is None and spec["checkpoint"] not in (setup.get("checkpoints") or []):
            error = (
                f"the download finished but {spec['checkpoint']} is not in "
                f"{_CHECKPOINTS_DIR} — see {log_path}"
            )
        if error is None:
            job["status"] = "done"
            job["percent"] = 100
            if job.get("bytes_total"):
                job["bytes_done"] = job["bytes_total"]
        else:
            job["status"] = "error"
            job["error"] = error
    log.info("magenta: download %s -> %s", model_id, job["status"])


def start_checkpoint_download(model_id: str) -> dict:
    """Fetch a checkpoint into the sidecar's assets dir with the sidecar's own
    CLI (``mrt checkpoints download``), in the background. Returns the job."""
    if model_id not in ENGINE_MODELS:
        raise ValueError(
            f"Unknown Magenta model {model_id!r}. The sidecar supports: "
            + ", ".join(ENGINE_MODELS)
        )
    spec = ENGINE_MODELS[model_id]
    with _dl_lock:
        current = _dl_jobs.get(model_id)
        if current and current["status"] == "downloading":
            return {**current, "already_running": True}
        job = {
            "id": f"magenta:{model_id}",
            "kind": "magenta",
            "model": model_id,
            "name": model_id,
            "label": f"{spec['label']} checkpoint ({spec['checkpoint']})",
            "repo_id": CHECKPOINT_REPO,
            "status": "downloading",
            "percent": 0,
            "bytes_done": 0,
            "bytes_total": spec["download_bytes"] or 0,
            "dest_dir": (
                f"\\\\wsl.localhost\\{_wsl_distro()}{_CHECKPOINTS_DIR.replace('~', '/home')}"
                if sys.platform == "win32"
                else _CHECKPOINTS_DIR
            ),
            "started_at": time.time(),
            "finished_at": None,
            "rc": None,
            "error": None,
            "log": str(_download_log_path(model_id)),
        }
        _dl_jobs[model_id] = job
    threading.Thread(
        target=_download_worker,
        args=(model_id, job),
        daemon=True,
        name=f"magenta-dl-{model_id}",
    ).start()
    return dict(job)


# ── engine spawn / stop ─────────────────────────────────────────────────────


def _resolve_start_model() -> tuple[str, str | None]:
    """The model to launch with, and a note when it is not the configured one
    (its checkpoint is missing but another supported one is present)."""
    wanted = engine_model()
    setup = setup_state()
    present = set(setup.get("checkpoints") or [])
    if setup.get("probe_failed") or not present:
        return wanted, None
    spec = ENGINE_MODELS.get(wanted)
    if spec is None or spec["checkpoint"] in present:
        return wanted, None
    for model_id, other in ENGINE_MODELS.items():
        if other["checkpoint"] in present:
            return (
                model_id,
                f"{wanted} is selected but {spec['checkpoint']} is not downloaded; "
                f"starting {model_id} instead.",
            )
    return wanted, None


def start_engine() -> dict:
    """Spawn the extended sidecar in WSL2 (blocking call, returns immediately
    after the spawn; readiness is observed via ``health()``)."""
    global _engine_proc
    with _engine_lock:
        if engine_process_alive():
            return {"spawned": False, "reason": "engine process already alive"}
        if not _ENGINE_SCRIPT.is_file():
            raise RuntimeError(f"engine script not found: {_ENGINE_SCRIPT}")
        model, note = _resolve_start_model()
        if note:
            log.warning("magenta.engine: %s", note)
        # urlsplit, not rsplit(":"): a SIDECAR_URL without an explicit port
        # would make rsplit yield "//host" and feed the engine a bogus port.
        port = str(urlsplit(SIDECAR_URL).port or 8777)
        popen_env = os.environ.copy()
        creationflags = _no_window_flags()

        if sys.platform == "win32":
            # Windows: the JAX/CUDA engine runs inside WSL2 (env passed inline
            # in the bash command — it does not cross the wsl.exe boundary via
            # the Windows process environment).
            distro = _wsl_distro()
            bash_cmd = (
                f"MRT2_PORT={port} MRT2_MODEL={model} "
                f"exec {_WSL_PYTHON} '{_wsl_path(_ENGINE_SCRIPT)}'"
            )
            cmd = ["wsl.exe", "-d", distro, "--", "bash", "-lc", bash_cmd]
            descriptor: dict = {"distro": distro}
        else:
            # Linux/macOS: spawn the engine venv python directly — no WSL, no
            # path translation. Linux uses the CUDA JAX stack, macOS the
            # magenta-rt[mlx] backend. The engine reads MRT2_* from the
            # environment, which native subprocesses inherit.
            native_py = Path(_NATIVE_PYTHON).expanduser()
            if not native_py.is_file():
                raise RuntimeError(
                    f"Magenta engine python not found at {native_py}. Set "
                    "THEDAW_MAGENTA_PYTHON to the mrt2 venv interpreter, or run "
                    "the engine yourself and set THEDAW_MAGENTA_URL to reach it."
                )
            popen_env["MRT2_PORT"] = port
            popen_env["MRT2_MODEL"] = model
            cmd = [str(native_py), str(_ENGINE_SCRIPT)]
            descriptor = {"native": True, "python": str(native_py)}

        # Capture the sidecar's output to a logfile instead of DEVNULL — a
        # spawn that dies on a missing dep (e.g. ModuleNotFoundError) would
        # otherwise vanish and surface only as a vague 503 downstream.
        log_path = _LOG_DIR / "magenta-sidecar.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log.info("magenta.engine: spawning %s (log: %s)", " ".join(cmd), log_path)
        with open(log_path, "ab") as log_fh:
            _engine_proc = subprocess.Popen(
                cmd,
                stdout=log_fh,
                stderr=subprocess.STDOUT,
                env=popen_env,
                creationflags=creationflags,
                shell=False,
            )
        return {
            "spawned": True,
            "model": model,
            "note": note,
            "port": port,
            **descriptor,
        }


def stop_engine() -> dict:
    """Stop every magenta engine: our tracked child plus any engine started
    outside the app (the .vbs launcher, a manual run). On Windows that reap
    runs via pkill inside WSL; on Linux/macOS it runs pkill natively."""
    global _engine_proc
    with _engine_lock:
        terminated = False
        proc = _engine_proc
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=5.0)
                terminated = True
            except subprocess.TimeoutExpired:
                proc.kill()
                terminated = True
        _engine_proc = None
        pkilled = False
        if sys.platform == "win32":
            reap_cmd = [
                "wsl.exe",
                "-d",
                _wsl_distro(),
                "--",
                "bash",
                "-lc",
                f"pkill -f '{_ENGINE_PKILL_PATTERN}' || true",
            ]
        else:
            reap_cmd = ["pkill", "-f", _ENGINE_PKILL_PATTERN]
        try:
            rc = subprocess.run(
                reap_cmd,
                timeout=20,
                capture_output=True,
                shell=False,
            ).returncode
            # native pkill returns 1 when nothing matched (not an error here).
            pkilled = rc == 0
        except Exception as e:
            log.warning("magenta.engine: pkill failed: %s", e)
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
