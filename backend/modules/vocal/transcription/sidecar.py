"""faster-whisper transcription sidecar (isolated venv, one-shot CLI).

Transcription needs faster-whisper (CTranslate2), kept OUT of the main app
environment. This module bootstraps a dedicated venv next to worker.py, installs
faster-whisper into it on demand (uv first, pip fallback), and runs worker.py as
a one-shot subprocess that returns word-timed segments as JSON. faster-whisper is
NEVER imported in the main process; only the worker (inside the isolated venv)
imports it, so server startup stays cheap.

GPU by default when the host has a CUDA device (torch says so): device
``cuda``, ``float16`` compute, the ``large-v3`` model, and the cuBLAS / cuDNN
pip wheels (requirements-cuda.txt) installed into the sidecar venv, whose
library folders are handed to the worker. Without a GPU it is CPU int8 with
the ``small`` model. The worker itself falls back to CPU when the CUDA run
fails, so a broken driver never blocks transcription. Override any of it via
theDAW_WHISPER_DEVICE / theDAW_WHISPER_COMPUTE / theDAW_WHISPER_MODEL, or point
at an existing interpreter with theDAW_WHISPER_PYTHON. The venv location is
configurable with theDAW_WHISPER_VENV_DIR (default: next to this file).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from backend.lib.launch_token import child_env

log = logging.getLogger(__name__)

_PACKAGE_DIR = Path(__file__).resolve().parent
_WORKER = _PACKAGE_DIR / "worker.py"
_REQUIREMENTS = _PACKAGE_DIR / "requirements.txt"
_REQUIREMENTS_CUDA = _PACKAGE_DIR / "requirements-cuda.txt"
SIDECAR_VENV_DIRNAME = ".whisper_venv"
# onnxruntime belongs here: decode_options() always sets vad_filter=True, so a
# venv without it imports faster_whisper fine and then fails at transcribe time.
# Probing only faster_whisper reported such a venv as healthy — the failure
# surfaced as an opaque RuntimeError mid-job instead of a missing dependency.
_CRITICAL_PACKAGES: tuple[str, ...] = ("faster_whisper", "onnxruntime")
# The CUDA runtime libraries faster-whisper needs on the GPU path; optional.
_CUDA_PACKAGES: tuple[str, ...] = ("nvidia.cublas", "nvidia.cudnn")
# Defaults per device class. Model ids are faster-whisper's own names.
_GPU_DEFAULTS = {"device": "cuda", "compute_type": "float16", "model": "large-v3"}
_CPU_DEFAULTS = {"device": "cpu", "compute_type": "int8", "model": "small"}


def _dir_size(path: Path) -> int:
    """Sum of every regular file under ``path`` (recursive). Never raises;
    files that vanish or deny access mid-walk are skipped."""
    total = 0
    try:
        for f in path.rglob("*"):
            try:
                if f.is_file():
                    total += f.stat().st_size
            except OSError:
                continue
    except OSError:
        return total
    return total


def _hf_layout_revision(d: Path) -> Optional[tuple[Path, int]]:
    """For a HuggingFace-cache-layout dir ``models--org--name``, return the
    ``(largest_revision_dir, size)`` under ``snapshots/``, else ``None``.

    Size is the largest SINGLE revision, not the whole ``snapshots`` tree: every
    revision dir links the same blobs, so summing them all would count a small
    multi-revision model several times and let it outrank a bigger one."""
    if "faster-whisper" not in d.name.lower():
        return None
    snap = d / "snapshots"
    if not snap.is_dir():
        return None
    best: Optional[Path] = None
    best_size = -1
    try:
        for r in snap.iterdir():
            if not r.is_dir():
                continue
            size = _dir_size(r)
            if size > best_size:
                best, best_size = r, size
    except OSError:
        return None
    if best is None:
        return None
    return best, best_size


def _hf_cache_model(d: Path) -> Optional[tuple[str, int]]:
    """For a dir in the REAL HuggingFace cache, return ``(repo_id, size)``.

    A bare repo id is right here and only here: ``WhisperModel`` resolves it
    against this very cache, so nothing is re-downloaded. For a hub tree copied
    somewhere else the id would be a cache MISS and trigger a download — see
    ``_scan_extra_folder``, which returns the revision path instead."""
    rev = _hf_layout_revision(d)
    if rev is None:
        return None
    parts = d.name.split("--", 2)
    if len(parts) != 3:
        return None
    return f"{parts[1]}/{parts[2]}", rev[1]


def _ct2_model(d: Path) -> Optional[tuple[str, int]]:
    """For a plain CTranslate2 faster-whisper model dir (directly contains
    ``model.bin`` + ``config.json``), return ``(absolute_dir_path, size)``, else
    ``None``. ``WhisperModel`` accepts such a local directory path directly.

    A CTranslate2 layout alone is not enough — it is also how non-whisper CT2
    models (translation, etc.) look, and handing one to ``WhisperModel`` fails at
    load time. We additionally require a whisper marker: a ``tokenizer.json`` in
    the dir, or ``whisper`` in the dir name."""
    try:
        if not ((d / "model.bin").is_file() and (d / "config.json").is_file()):
            return None
        if not ((d / "tokenizer.json").is_file() or "whisper" in d.name.lower()):
            return None
        return str(d.resolve()), _dir_size(d)
    except OSError:
        return None


def _scan_hf_cache() -> list[tuple[str, int]]:
    """Every faster-whisper model in the HuggingFace cache as ``(repo_id, size)``.
    Empty when the hub is unimportable or the cache is absent."""
    try:
        from huggingface_hub.constants import HF_HUB_CACHE
    except Exception:  # noqa: BLE001 - hub not importable in this env
        return []
    cache = Path(HF_HUB_CACHE)
    if not cache.is_dir():
        return []
    out: list[tuple[str, int]] = []
    try:
        for d in cache.glob("models--*"):
            m = _hf_cache_model(d)
            if m is not None:
                out.append(m)
    except OSError:
        return out
    return out


def _extra_model_folders() -> list[Path]:
    """Folders listed in the ``models.extra_folders`` setting, as ``Path``s.

    Read defensively: the settings module may not have landed yet, the key may
    be absent, and the value may be the wrong type. Any of that yields ``[]``
    rather than raising, so this module stays cheap and importable.

    Read-ONLY: we use the already-initialized store rather than ``get_store()``,
    because constructing a ``SettingsStore`` creates directories and writes /
    migrates the real settings.json. Resolving a model must never write to the
    user's config. The app initializes the store at startup, so this is a no-op
    there; off the app (tests, CLI) it simply reports no extra folders."""
    try:
        from backend.modules.settings import router as _settings_router

        store = getattr(_settings_router, "_store", None)
        if store is None:
            return []
        raw = store.get_all().get("models", {}).get("extra_folders", [])
    except Exception:  # noqa: BLE001 - setting optional / store may be unavailable
        return []
    if not isinstance(raw, list):
        return []
    out: list[Path] = []
    for item in raw:
        if not isinstance(item, str) or not item.strip():
            continue
        try:
            out.append(Path(item).expanduser())
        except Exception:  # noqa: BLE001 - a bogus path string is just skipped
            continue
    return out


def _scan_extra_folder(folder: Path) -> list[tuple[str, int]]:
    """faster-whisper models found in ``folder``: the folder itself as a
    CTranslate2 model, plus any immediate subfolder that is a CTranslate2 model
    or a HuggingFace-cache-layout dir. Returns ``(identifier, size)`` pairs.
    Nonexistent / unreadable folders yield ``[]``."""
    out: list[tuple[str, int]] = []
    try:
        if not folder.is_dir():
            return out
    except OSError:
        return out
    root = _ct2_model(folder)
    if root is not None:
        out.append(root)
    try:
        children = list(folder.iterdir())
    except OSError:
        return out
    for child in children:
        try:
            if not child.is_dir():
                continue
        except OSError:
            continue
        hf = _hf_layout_revision(child)
        if hf is not None:
            # The revision DIRECTORY, not the repo id. This hub tree lives under
            # a user folder, so a repo id would miss the real HF_HUB_CACHE and
            # make WhisperModel download it. A local dir loads straight off disk.
            out.append((str(hf[0].resolve()), hf[1]))
        ct2 = _ct2_model(child)
        if ct2 is not None:
            out.append(ct2)
    return out


def _best_cached_whisper_model() -> Optional[str]:
    """Return the identifier of the largest faster-whisper model already on disk
    across the HuggingFace cache AND every folder in ``models.extra_folders``,
    or ``None`` if none are found.

    The identifier is a repo id for HuggingFace-cache-layout models (resolved
    from that cache, no download) or an absolute directory path for plain
    CTranslate2 model folders. Lets the app use whatever whisper model the user
    actually has — including local ones outside the hub cache — without a
    hardcoded catalog and without a network fetch.
    """
    candidates: list[tuple[str, int]] = list(_scan_hf_cache())
    for folder in _extra_model_folders():
        candidates.extend(_scan_extra_folder(folder))
    if not candidates:
        return None
    return max(candidates, key=lambda c: c[1])[0]


# Env var the worker reads for the DLL / shared-library folders to load.
LIB_DIRS_ENV = "theDAW_WHISPER_LIB_DIRS"
_INSTALL_TIMEOUT_SEC = 20 * 60
_TRANSCRIBE_TIMEOUT_SEC = 30 * 60
# Optional per-call decoding knobs a caller may forward to the worker. Anything
# else in ``extra`` is dropped so the request stays a closed, known shape.
_EXTRA_KEYS: tuple[str, ...] = (
    "initial_prompt",
    "hotwords",
    "condition_on_previous_text",
    "vad_filter",
    "vad_parameters",
    "hallucination_silence_threshold",
    "beam_size",
    "best_of",
    "temperature",
    "no_speech_threshold",
    "log_prob_threshold",
    "compression_ratio_threshold",
)


def _venv_python(base: Path) -> Path:
    venv_dir = base / SIDECAR_VENV_DIRNAME
    if sys.platform == "win32":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


@dataclass
class WhisperConfig:
    venv_base: Path
    python_exe: Path
    model: str
    device: str
    compute_type: str

    @property
    def wants_cuda(self) -> bool:
        return self.device.lower().startswith("cuda")


_cuda_cache: Optional[bool] = None


def cuda_available() -> bool:
    """Does this host have a CUDA GPU torch can see? Cached; never raises."""
    global _cuda_cache
    if _cuda_cache is None:
        try:
            import torch

            _cuda_cache = bool(torch.cuda.is_available())
        except Exception:  # noqa: BLE001 - no torch, no GPU
            _cuda_cache = False
    return _cuda_cache


def resolve_config() -> WhisperConfig:
    base_env = os.getenv("theDAW_WHISPER_VENV_DIR")
    venv_base = Path(base_env).expanduser().resolve() if base_env else _PACKAGE_DIR
    py = os.getenv("theDAW_WHISPER_PYTHON")
    python_exe = Path(py).expanduser().resolve() if py else _venv_python(venv_base)
    device = os.getenv("theDAW_WHISPER_DEVICE", "").strip().lower()
    if not device:
        device = "cuda" if cuda_available() else "cpu"
    defaults = _GPU_DEFAULTS if device.startswith("cuda") else _CPU_DEFAULTS
    return WhisperConfig(
        venv_base=venv_base,
        python_exe=python_exe,
        model=(
            os.getenv("theDAW_WHISPER_MODEL", "").strip()
            or (_best_cached_whisper_model() if device.startswith("cuda") else "")
            or defaults["model"]
        ),
        device=device,
        compute_type=os.getenv("theDAW_WHISPER_COMPUTE", "").strip()
        or defaults["compute_type"],
    )


def _probe_packages(
    python_exe: Path, packages: tuple[str, ...] = _CRITICAL_PACKAGES
) -> dict:
    """Import the given packages in the sidecar Python in ONE subprocess.
    Cheap, never raises; returns {pkg: {ok, version|error}} or {_error: ...}."""
    script = (
        "import json, importlib\n"
        f"pkgs = {list(packages)!r}\n"
        "out = {}\n"
        "for p in pkgs:\n"
        "    try:\n"
        "        m = importlib.import_module(p)\n"
        "        out[p] = {'ok': True, 'version': getattr(m, '__version__', None)}\n"
        "    except Exception as e:\n"
        "        out[p] = {'ok': False, 'error': repr(e)[:300]}\n"
        "print(json.dumps(out))\n"
    )
    try:
        result = subprocess.run(
            [str(python_exe), "-c", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            env=child_env(),
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        return {"_error": repr(e)}
    if result.returncode != 0:
        return {"_error": result.stderr.strip()[:300] or "probe subprocess failed"}
    try:
        return json.loads(result.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError) as e:
        return {"_error": f"probe parse failed: {e}"}


def probe(cfg: Optional[WhisperConfig] = None) -> dict:
    """Non-spawning health snapshot for the UI: is the venv built and can it
    import faster-whisper?"""
    cfg = cfg or resolve_config()
    venv_dir = cfg.python_exe.parent.parent
    out: dict = {
        "ok": False,
        "python_exe": str(cfg.python_exe),
        "python_exe_exists": cfg.python_exe.is_file(),
        "sidecar_venv": str(venv_dir),
        "sidecar_venv_exists": venv_dir.exists(),
        "worker_exists": _WORKER.is_file(),
        "model": cfg.model,
        "device": cfg.device,
        "compute_type": cfg.compute_type,
        "cuda": cfg.wants_cuda,
        "cuda_libs_ok": not cfg.wants_cuda,
        "packages": {},
        "missing_critical": list(_CRITICAL_PACKAGES),
        "critical_ok": False,
    }
    if cfg.python_exe.is_file():
        pkgs = _probe_packages(
            cfg.python_exe,
            _CRITICAL_PACKAGES + (_CUDA_PACKAGES if cfg.wants_cuda else ()),
        )
        if "_error" in pkgs:
            out["error"] = pkgs["_error"]
        else:
            out["packages"] = pkgs
            out["missing_critical"] = [
                p for p in _CRITICAL_PACKAGES if not pkgs.get(p, {}).get("ok")
            ]
            out["critical_ok"] = len(out["missing_critical"]) == 0
            if cfg.wants_cuda:
                out["cuda_libs_ok"] = all(
                    pkgs.get(p, {}).get("ok") for p in _CUDA_PACKAGES
                )
    else:
        out["error"] = f"sidecar venv not created yet: {cfg.python_exe}"
    out["ok"] = out["critical_ok"] and out["worker_exists"]
    return out


def available() -> bool:
    try:
        return bool(probe().get("critical_ok"))
    except Exception as e:
        log.info("vocal.whisper: availability probe failed: %s", e)
        return False


def _bootstrap_venv(cfg: WhisperConfig) -> dict:
    """Create the isolated venv on demand (uv venv --seed, stdlib venv fallback)."""
    venv_dir = cfg.python_exe.parent.parent
    if cfg.python_exe.is_file():
        return {"ok": True, "created": False, "tool": "existing"}
    venv_dir.parent.mkdir(parents=True, exist_ok=True)
    try:
        result = subprocess.run(
            ["uv", "venv", str(venv_dir), "--python", sys.executable, "--seed"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
            env=child_env(),
        )
        if result.returncode == 0 and cfg.python_exe.is_file():
            return {"ok": True, "created": True, "tool": "uv"}
    except (OSError, subprocess.TimeoutExpired) as e:
        log.info("vocal.whisper: uv venv unavailable (%s), falling back", e)
    try:
        result = subprocess.run(
            [sys.executable, "-m", "venv", str(venv_dir)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
            env=child_env(),
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        return {"ok": False, "created": False, "tool": "venv", "error": repr(e)}
    return {
        "ok": result.returncode == 0 and cfg.python_exe.is_file(),
        "created": True,
        "tool": "venv",
        "stderr": result.stderr[-2000:],
    }


def _install_cmd(python_exe: Path, req: Path) -> tuple[list[str], str]:
    """Prefer `uv pip install --python <exe>` (host project is uv-based); fall
    back to the venv's own pip."""
    try:
        uv_check = subprocess.run(
            ["uv", "--version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
            env=child_env(),
        )
        if uv_check.returncode == 0:
            return (
                ["uv", "pip", "install", "--python", str(python_exe), "-r", str(req)],
                "uv-pip",
            )
    except (OSError, subprocess.TimeoutExpired):
        pass
    return ([str(python_exe), "-m", "pip", "install", "-r", str(req)], "pip")


def install_dependencies(cfg: Optional[WhisperConfig] = None) -> dict:
    """Bootstrap the isolated venv then install faster-whisper into it."""
    cfg = cfg or resolve_config()
    out: dict = {"ok": False, "python_exe": str(cfg.python_exe)}
    if not _REQUIREMENTS.is_file():
        out["error"] = f"requirements.txt not found at {_REQUIREMENTS}"
        return out
    bootstrap = _bootstrap_venv(cfg)
    out["venv_bootstrap"] = bootstrap
    if not bootstrap.get("ok"):
        out["error"] = (
            "could not create whisper venv at "
            f"{cfg.python_exe.parent.parent}: "
            f"{bootstrap.get('stderr', bootstrap.get('error', '?'))}"
        )
        return out
    try:
        argv, mode = _install_cmd(cfg.python_exe, _REQUIREMENTS)
        out["install_mode"] = mode
        result = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=_INSTALL_TIMEOUT_SEC,
            env=child_env(),
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        out["error"] = repr(e)
        return out
    out["returncode"] = result.returncode
    out["stdout"] = result.stdout[-4000:]
    out["stderr"] = result.stderr[-4000:]
    out["ok"] = result.returncode == 0
    if out["ok"] and cfg.wants_cuda:
        out["cuda_install"] = install_cuda_libs(cfg)
    return out


def install_cuda_libs(cfg: Optional[WhisperConfig] = None) -> dict:
    """Install the cuBLAS / cuDNN wheels into the sidecar venv. A failure
    is reported, not raised: the worker falls back to CPU without them."""
    cfg = cfg or resolve_config()
    out: dict = {"ok": False}
    if not _REQUIREMENTS_CUDA.is_file():
        out["error"] = f"requirements-cuda.txt not found at {_REQUIREMENTS_CUDA}"
        return out
    try:
        argv, mode = _install_cmd(cfg.python_exe, _REQUIREMENTS_CUDA)
        out["install_mode"] = mode
        result = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=_INSTALL_TIMEOUT_SEC,
            env=child_env(),
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        out["error"] = repr(e)
        return out
    out["returncode"] = result.returncode
    out["stderr"] = result.stderr[-2000:]
    out["ok"] = result.returncode == 0
    if not out["ok"]:
        log.warning(
            "vocal.whisper: CUDA libraries did not install; the worker will use the CPU"
        )
    return out


_lib_dirs_cache: dict[str, list[str]] = {}


def cuda_lib_dirs(python_exe: Path) -> list[str]:
    """The bin (Windows) / lib (POSIX) folders of the nvidia pip wheels inside
    the sidecar venv, for the worker to load cuBLAS and cuDNN from. Empty when
    they are not installed. Cached per interpreter."""
    key = str(python_exe)
    if key in _lib_dirs_cache:
        return _lib_dirs_cache[key]
    sub = "bin" if sys.platform == "win32" else "lib"
    script = (
        "import json, os, importlib\n"
        "out = []\n"
        "for name in ('nvidia.cublas', 'nvidia.cudnn'):\n"
        "    try:\n"
        "        m = importlib.import_module(name)\n"
        "        for base in list(getattr(m, '__path__', [])):\n"
        f"            d = os.path.join(base, {sub!r})\n"
        "            if os.path.isdir(d): out.append(d)\n"
        "    except Exception:\n"
        "        pass\n"
        "print(json.dumps(out))\n"
    )
    dirs: list[str] = []
    try:
        result = subprocess.run(
            [str(python_exe), "-c", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            env=child_env(),
        )
        if result.returncode == 0:
            dirs = [str(d) for d in json.loads(result.stdout.strip().splitlines()[-1])]
    except Exception as e:  # noqa: BLE001 - no dirs means CPU
        log.info("vocal.whisper: CUDA lib dir probe failed: %s", e)
    _lib_dirs_cache[key] = dirs
    return dirs


def worker_env(cfg: WhisperConfig) -> dict:
    """The child environment: the parent's without the launch token, plus the
    CUDA library folders (Windows: an env var the worker turns into
    add_dll_directory calls; POSIX: prepended to LD_LIBRARY_PATH, which the
    loader reads at start)."""
    env = child_env()
    if not cfg.wants_cuda:
        return env
    dirs = cuda_lib_dirs(cfg.python_exe)
    if not dirs:
        return env
    env[LIB_DIRS_ENV] = os.pathsep.join(dirs)
    if sys.platform != "win32":
        prev = env.get("LD_LIBRARY_PATH", "")
        env["LD_LIBRARY_PATH"] = os.pathsep.join(dirs + ([prev] if prev else []))
    return env


def ensure_ready(cfg: Optional[WhisperConfig] = None) -> dict:
    """Probe; install on demand if missing; re-probe. Returns the final probe."""
    cfg = cfg or resolve_config()
    pr = probe(cfg)
    if pr.get("critical_ok"):
        if cfg.wants_cuda and not pr.get("cuda_libs_ok"):
            log.info("vocal.whisper: installing CUDA libraries for the GPU path")
            pr["cuda_install"] = install_cuda_libs(cfg)
            _lib_dirs_cache.pop(str(cfg.python_exe), None)
        return pr
    log.info("vocal.whisper: installing faster-whisper into isolated venv (first run)")
    inst = install_dependencies(cfg)
    if not inst.get("ok"):
        pr["install"] = inst
        pr["error"] = inst.get("error") or (inst.get("stderr") or "")[:600]
        return pr
    pr2 = probe(cfg)
    pr2["install"] = {"ok": True, "mode": inst.get("install_mode")}
    return pr2


async def transcribe(
    audio_path: Path,
    language: str = "en",
    cfg: Optional[WhisperConfig] = None,
    extra: Optional[dict] = None,
) -> dict:
    """Run the isolated worker on one file. Returns the worker's JSON dict:
    {ok, language, text, segments} on success, {ok: False, error} otherwise.
    Never raises; install/spawn/parse failures all come back as ok=False.

    ``extra`` optionally forwards decoding knobs to the worker; only the keys in
    ``_EXTRA_KEYS`` (``initial_prompt``, ``condition_on_previous_text``,
    ``vad_filter``, ``beam_size``) are passed through, and ``None`` values are
    skipped so the worker keeps its own defaults. Existing callers that omit
    ``extra`` get exactly the request they always did."""
    cfg = cfg or resolve_config()
    ready = await asyncio.to_thread(ensure_ready, cfg)
    if not ready.get("critical_ok"):
        return {
            "ok": False,
            "error": ready.get("error") or "faster-whisper not installed",
            "probe": ready,
        }
    request_dict: dict = {
        "audio": str(audio_path),
        "language": language,
        "model": cfg.model,
        "device": cfg.device,
        "compute_type": cfg.compute_type,
    }
    if extra:
        request_dict.update(
            {k: v for k, v in extra.items() if k in _EXTRA_KEYS and v is not None}
        )
    request = json.dumps(request_dict)
    # The GPU lane: one heavy model on the card at a time (Demucs, basic-pitch
    # and this worker share it), and the background queue parks meanwhile.
    from backend.core import pipeline

    async with pipeline.gpu("whisper"):
        started = time.monotonic()
        try:
            proc = await asyncio.create_subprocess_exec(
                str(cfg.python_exe),
                str(_WORKER),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=worker_env(cfg),
            )
        except OSError as e:
            return {"ok": False, "error": f"failed to spawn whisper worker: {e!r}"}
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(request.encode("utf-8")),
                timeout=_TRANSCRIBE_TIMEOUT_SEC,
            )
        except asyncio.TimeoutError:
            proc.kill()
            return {
                "ok": False,
                "error": f"whisper worker timed out after {_TRANSCRIBE_TIMEOUT_SEC}s",
            }
    elapsed = time.monotonic() - started
    err_text = stderr.decode("utf-8", "replace").strip()
    err_tail = err_text[-500:]
    if proc.returncode != 0 and not stdout.strip():
        return {"ok": False, "error": f"whisper worker failed: {err_tail}"}
    try:
        last = stdout.decode("utf-8", "replace").strip().splitlines()[-1]
        out = json.loads(last)
    except (ValueError, IndexError) as e:
        return {"ok": False, "error": f"whisper worker bad output: {e}; {err_tail}"}
    out["elapsed"] = round(elapsed, 2)
    if out.get("ok"):
        used = out.get("device_used")
        if cfg.wants_cuda and used != cfg.device:
            # The card was asked for and the worker fell back: say so loudly,
            # this is the difference between 10 s and 10 min.
            log.warning(
                "vocal.whisper: %s requested but the worker ran on %s (%s): %s",
                cfg.device,
                used,
                out.get("model"),
                err_tail,
            )
        else:
            log.info(
                "vocal.whisper: %s on %s in %.1fs (%s)",
                out.get("model"),
                used,
                elapsed,
                audio_path.name,
            )
    return out


__all__ = [
    "WhisperConfig",
    "available",
    "cuda_available",
    "install_cuda_libs",
    "ensure_ready",
    "install_dependencies",
    "probe",
    "resolve_config",
    "transcribe",
]
