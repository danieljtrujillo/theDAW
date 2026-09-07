"""Magenta RT2 module — proxies the WSL2/CUDA mrt2 studio sidecar.

Endpoints (mounted at /api/magenta):
    GET  /probe                   -> sidecar health (+ availability flag + state)
    POST /generate                -> start a generation job; returns {job:{id}}
    GET  /jobs/{job_id}           -> poll job status/result (mirrors the main JOBS shape)
    GET  /engine/status           -> health + install probe + machine-readable state
    POST /engine/start|stop|restart
    POST /engine/install          -> launch the consented one-time installer
    GET  /engine/models           -> the checkpoints the sidecar supports (+ active)
    PUT  /engine/model            -> pick the checkpoint the engine loads
    GET  /engine/checkpoints      -> checkpoint download jobs + installed files
    POST /engine/checkpoints/{model}/download
    POST /engine/checkpoints/clear

Every 412 carries the same detail shape: the install probe's keys plus
``state`` ("not_installed" | "not_running" | "starting" | "probe_failed"),
``installable`` and ``message``. ``setup_required`` is kept for older clients
and is true only for ``not_installed``.

The generation itself is one-shot on the sidecar, but we wrap it in the same
job/poll shape the frontend already uses for SA3 generations so the UI flow is
uniform. The model is text-prompt -> audio; ``model_size`` is accepted for
forward-compatibility — the engine serves whichever checkpoint was picked with
``PUT /engine/model`` (mrt2_small by default).
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import time
import uuid
from typing import Callable

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from . import sidecar

log = logging.getLogger(__name__)
router = APIRouter()

MAGENTA_JOBS: dict[str, dict] = {}

# Serializes on-demand engine bring-up so concurrent CREATE presses don't each
# park SA3 + spawn WSL; the first wins, the rest see it ready inside the lock.
_bringup_lock = asyncio.Lock()

NOT_INSTALLED_MESSAGE = (
    "The Magenta RT2 engine is not installed yet. Installing checks the PC, "
    "asks consent, and sets up everything."
)


def _gate_detail(setup: dict, state: str, message: str) -> dict:
    """The 412 payload. Flat install-probe keys + `state`, backward compatible
    with clients that only know `setup_required` / `installable` / `message`."""
    return {
        "setup_required": state == "not_installed",
        **setup,
        "installable": sidecar.installer_available(),
        "state": state,
        "message": message,
    }


def _setup_gate(setup: dict) -> HTTPException | None:
    """412 for the two install states a caller cannot proceed from. A probe
    that did not answer is reported as exactly that — never as "not
    installed", which is what used to send installed users back to Install."""
    if setup.get("probe_failed"):
        return HTTPException(
            412,
            _gate_detail(
                setup,
                "probe_failed",
                "Couldn't check whether Magenta RT2 is installed: "
                f"{setup.get('probe_error') or 'no answer from WSL'}. "
                "Retry in a moment.",
            ),
        )
    if not setup.get("ready"):
        return HTTPException(
            412, _gate_detail(setup, "not_installed", NOT_INSTALLED_MESSAGE)
        )
    return None


def _normalize_style_audio(audio_bytes: bytes) -> bytes:
    """Auto-format an uploaded style clip ("clone its vibe") to canonical PCM16
    WAV so the sidecar can always read it.

    The sidecar decodes style clips with libsndfile inside WSL, whose build may be
    older or lack codecs (MP3, M4A, Opus, some WAV variants) that the Windows-side
    backend handles fine — that mismatch is what surfaces as the sidecar's
    "Format not recognised". Re-encoding here means the sidecar always receives a
    universally-readable WAV regardless of the source format. Tries soundfile
    first, then ffmpeg for anything soundfile can't decode."""
    try:
        import soundfile as sf

        data, sr = sf.read(io.BytesIO(audio_bytes), dtype="float32", always_2d=True)
        out = io.BytesIO()
        sf.write(out, data, sr, format="WAV", subtype="PCM_16")
        return out.getvalue()
    except Exception as e_sf:
        log.info(
            "magenta: soundfile couldn't decode style clip (%s); trying ffmpeg", e_sf
        )

    import os
    import shutil
    import subprocess
    import tempfile

    if not shutil.which("ffmpeg"):
        raise ValueError("style clip format not recognised and ffmpeg is unavailable")
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        out_path = tf.name
    try:
        proc = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                "pipe:0",
                "-acodec",
                "pcm_s16le",
                out_path,
            ],
            input=audio_bytes,
            capture_output=True,
        )
        if proc.returncode != 0:
            err = proc.stderr.decode("utf-8", "replace")[:200] if proc.stderr else "?"
            raise ValueError(f"style clip could not be decoded: {err}")
        with open(out_path, "rb") as f:
            return f.read()
    finally:
        try:
            os.unlink(out_path)
        except OSError:
            pass


async def _bring_up_sidecar(
    timeout: float = 240.0, on_state: Callable[[str, str], None] | None = None
) -> None:
    """Ensure the extended sidecar is up and ready, starting it on demand.

    No-op when it is already available. Otherwise: refuse with an actionable
    message if the WSL side was never installed; else park SA3 to free the GPU,
    stop any stray engine, spawn ours, and wait for /health to report ready.
    ``on_state`` (optional) is told "starting" / "running" so a job can show
    the bring-up to whoever is polling it. Raises RuntimeError (carried into
    the job's error) on setup-missing or timeout.
    """
    if (await sidecar.health()).get("available"):
        return
    loop = asyncio.get_event_loop()
    async with _bringup_lock:
        h = await sidecar.health()
        if h.get("available"):
            return
        setup = await loop.run_in_executor(None, sidecar.setup_state)
        if setup.get("probe_failed"):
            raise RuntimeError(
                "Couldn't check whether Magenta RT2 is installed: "
                f"{setup.get('probe_error')}. Try again in a moment."
            )
        if not setup.get("ready"):
            raise RuntimeError(
                "Magenta RT2 is not installed yet. Install it from the Magenta "
                "card in Settings → Models."
            )
        if on_state:
            on_state(
                "starting", "waiting for the GPU, then starting the Magenta engine"
            )
        # The load takes the pipeline's single GPU lane so a Demucs / whisper /
        # basic-pitch run cannot sit on the card while JAX allocates its
        # weights (that overlap is the RESOURCE_EXHAUSTED failure).
        from backend.core import pipeline

        async with pipeline.gpu("magenta"):
            # Park SA3 so the engine's JAX runtime finds a free GPU, then (re)spawn.
            if not (h.get("reachable") and h.get("protocol_ok")):
                if on_state:
                    on_state("starting", "starting the Magenta engine")
                try:
                    from backend import server as srv

                    await srv.offload_model()
                except Exception:
                    log.debug(
                        "magenta: SA3 offload before engine start failed",
                        exc_info=True,
                    )
                await loop.run_in_executor(None, sidecar.stop_engine)
                await loop.run_in_executor(None, sidecar.start_engine)
            # Model load can take a while on a cold start; poll until ready.
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                await asyncio.sleep(2.0)
                h = await sidecar.health()
                if h.get("available"):
                    if on_state:
                        on_state("running", "generating")
                    return
                if on_state and h.get("status"):
                    on_state("starting", str(h.get("status")))
                if sidecar.engine_state(h, None) == "error":
                    hint = _classify_engine_error(h).get("fix") or (
                        "Pick another model in Settings → Models or check "
                        "logs/magenta-sidecar.log."
                    )
                    raise RuntimeError(
                        "The Magenta RT2 engine failed to load its model: "
                        f"{h.get('error') or h.get('status')}. {hint}"
                    )
        raise RuntimeError(
            "The Magenta RT2 engine started but did not become ready in time. "
            "Check the WSL sidecar, then try again."
        )


@router.get("/probe")
async def probe():
    h = await sidecar.health()
    setup = None
    if not (h.get("reachable") and h.get("protocol_ok")):
        setup = await asyncio.get_event_loop().run_in_executor(
            None, sidecar.setup_state
        )
    return {**h, "state": sidecar.engine_state(h, setup)}


# ── engine lifecycle: the Model dropdown's GPU swap, no terminal anywhere ────
#
# /engine/start parks the SA3 model in CPU RAM (frees VRAM), stops any OTHER
# magenta engine (including the bundled JSON-protocol Studio server), and spawns
# the extended sidecar in WSL2. /engine/stop kills every magenta engine and
# swaps SA3 back onto the GPU. Both refuse with 409 while a generation runs.


async def _start_engine(refresh: bool) -> dict:
    h = await sidecar.health()
    if h.get("reachable") and h.get("protocol_ok"):
        # The extended engine is already up (ready or still loading) — keep it.
        return {
            "ok": True,
            "already_running": True,
            "state": sidecar.engine_state(h, None),
            **h,
        }

    # Refuse with a precise diagnosis when the WSL side was never set up —
    # spawning would just die on a missing venv and read as a vague ERROR.
    loop = asyncio.get_event_loop()
    setup = await loop.run_in_executor(None, lambda: sidecar.setup_state(refresh))
    gate = _setup_gate(setup)
    if gate:
        raise gate

    # The engine's JAX runtime grabs its weights on the GPU at load. Anything
    # else on the card meanwhile — a Demucs separation, whisper, basic-pitch,
    # the resident SA3 model — makes that load die with RESOURCE_EXHAUSTED
    # (seen 2026-09-06: a stems run and an engine start overlapped, the engine
    # OOM'd at 96 MiB and the sidecar connection dropped). So the load takes
    # the pipeline's single GPU lane: it waits for a separation in flight, and
    # holds the lane until the engine reports ready (or fails), so nothing
    # heavy starts underneath it. The HTTP reply does not wait; /engine/status
    # reports "starting" (with a "waiting for the GPU" message while queued).
    global _start_task
    if _start_task is not None and not _start_task.done():
        return {
            "ok": True,
            "already_running": False,
            "state": "starting",
            "queued": True,
        }
    _start_task = asyncio.create_task(_start_engine_on_gpu_lane(), name="magenta:start")
    return {"ok": True, "already_running": False, "state": "starting", "queued": True}


_start_task: "asyncio.Task[None] | None" = None
_start_note: str = ""
_ENGINE_LOAD_TIMEOUT_SEC = 240


async def _start_engine_on_gpu_lane() -> None:
    global _start_note
    from backend.core import pipeline

    loop = asyncio.get_event_loop()
    _start_note = "waiting for the GPU (a separation, whisper or MIDI run is using it)"
    try:
        async with pipeline.gpu("magenta"):
            _start_note = "parking the SA3 model and spawning the engine"
            from backend import server as srv

            await srv.offload_model()
            await loop.run_in_executor(None, sidecar.stop_engine)
            await loop.run_in_executor(None, sidecar.start_engine)
            _start_note = "loading the checkpoint on the GPU"
            deadline = loop.time() + _ENGINE_LOAD_TIMEOUT_SEC
            while loop.time() < deadline:
                await asyncio.sleep(2.0)
                h = await sidecar.health()
                state = sidecar.engine_state(h, None)
                if state in ("running", "error"):
                    break
                if state == "not_running" and not sidecar.engine_process_alive():
                    break
    except Exception as e:  # noqa: BLE001 - reported through /engine/status
        log.exception("magenta: engine start failed")
        _start_note = f"start failed: {e}"
        return
    _start_note = ""


def _classify_engine_error(h: dict) -> dict:
    """Turn the engine's raw error into something a user can act on."""
    err = str(h.get("error") or h.get("status") or "")
    low = err.lower()
    if "resource_exhausted" in low or "out of memory" in low or "oom" in low:
        return {
            "error_kind": "gpu_oom",
            "fix": (
                "The GPU ran out of memory while the engine loaded its checkpoint. "
                "Something else was on the card (a stem separation, whisper, MIDI "
                "transcription or the SA3 model). Wait for it to finish, then press "
                "Restart engine — the load now waits its turn for the GPU."
            ),
        }
    if "checkpoint" in low or "no such file" in low or "not found" in low:
        return {
            "error_kind": "checkpoint_missing",
            "fix": "The picked checkpoint is not on disk — download it under Models, then Restart engine.",
        }
    if err:
        return {
            "error_kind": "engine_error",
            "fix": "Restart the engine; if it fails again the sidecar log has the traceback.",
        }
    return {}


@router.post("/engine/start")
async def engine_start(refresh: bool = False):
    return await _start_engine(refresh)


@router.post("/engine/restart")
async def engine_restart():
    """Stop whatever engine is up and start again with the currently picked
    model — the click that applies a model change while the engine runs."""
    loop = asyncio.get_event_loop()
    stopped = await loop.run_in_executor(None, sidecar.stop_engine)
    # Give the port a moment to close so the start path does not see the old
    # engine as "already running".
    for _ in range(10):
        if not (await sidecar.health()).get("reachable"):
            break
        await asyncio.sleep(0.5)
    started = await _start_engine(False)
    return {**started, "stopped": stopped}


@router.post("/engine/install")
async def engine_install():
    """Launch the one-time installer — the button that replaces telling the
    user to find and double-click Setup-MRT2.bat.

    Returns as soon as the installer's console is up; it runs on its own and
    asks the user for consent there. Poll /engine/status (or re-read the model
    status in Settings) to see when the install lands.
    """
    loop = asyncio.get_event_loop()
    setup = await loop.run_in_executor(None, lambda: sidecar.setup_state(True))
    if setup.get("ready"):
        return {"launched": False, "already_installed": True, **setup}
    try:
        info = await loop.run_in_executor(None, sidecar.launch_installer)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(501, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(500, f"Could not start the installer: {exc}") from exc
    return {"launched": True, **info, **setup}


@router.post("/engine/stop")
async def engine_stop():
    loop = asyncio.get_event_loop()
    stopped = await loop.run_in_executor(None, sidecar.stop_engine)

    from backend import server as srv

    try:
        restored = await srv.onload_model()
    except HTTPException as e:
        # A running generation blocks the eager onload; the lazy wake path
        # restores the model at the next CREATE anyway.
        restored = {"skipped": e.detail}
    return {"ok": True, **stopped, "sa3": restored, "state": "not_running"}


@router.get("/engine/status")
async def engine_status(refresh: bool = False):
    """Health + install probe + one machine-readable ``state``. Pass
    ``refresh=1`` to bypass the install-probe cache (after an install)."""
    h = await sidecar.health()
    out = {
        **h,
        "process_alive": sidecar.engine_process_alive(),
        "active_model": sidecar.engine_model(),
        "installable": sidecar.installer_available(),
    }
    setup = None
    if refresh or not (h.get("reachable") and h.get("protocol_ok")):
        setup = await asyncio.get_event_loop().run_in_executor(
            None, lambda: sidecar.setup_state(refresh)
        )
        out["setup_required"] = bool(
            not setup.get("ready") and not setup.get("probe_failed")
        )
        out["setup"] = setup
    out["state"] = sidecar.engine_state(h, setup)
    # A start queued behind the GPU lane reads as "starting", with the reason.
    if (
        _start_task is not None
        and not _start_task.done()
        and out["state"]
        in (
            "not_running",
            "starting",
        )
    ):
        out["state"] = "starting"
        out["message"] = _start_note
    if out["state"] == "error":
        out.update(_classify_engine_error(h))
        if out.get("fix"):
            out["message"] = out["fix"]
    return out


# ── model pick + checkpoint downloads ───────────────────────────────────────


class EngineModelBody(BaseModel):
    model: str


@router.get("/engine/models")
async def engine_models(refresh: bool = False):
    """The real model list (what the vendored sidecar can load), each stamped
    installed / active / runnable on this GPU, plus any download in flight."""
    loop = asyncio.get_event_loop()
    setup = await loop.run_in_executor(None, lambda: sidecar.setup_state(refresh))
    catalog = await loop.run_in_executor(None, lambda: sidecar.model_catalog(setup))
    h = await sidecar.health()
    return {
        **catalog,
        "running_model": h.get("model") if h.get("reachable") else None,
        "state": sidecar.engine_state(h, setup),
        "setup": setup,
    }


@router.put("/engine/model")
async def engine_set_model(body: EngineModelBody):
    """Pick the checkpoint the engine loads. Persisted (data/magenta_engine.json)
    and used by the next start; ``restart_required`` says whether a running
    engine still serves the previous pick."""
    loop = asyncio.get_event_loop()
    setup = await loop.run_in_executor(None, sidecar.setup_state)
    spec = sidecar.ENGINE_MODELS.get(body.model)
    if spec is None:
        raise HTTPException(
            400,
            f"Unknown Magenta model {body.model!r}. The sidecar supports: "
            + ", ".join(sidecar.ENGINE_MODELS),
        )
    if (
        not setup.get("probe_failed")
        and setup.get("checkpoints")
        and spec["checkpoint"] not in setup["checkpoints"]
    ):
        raise HTTPException(
            409,
            {
                "message": (
                    f"{spec['label']} is not downloaded yet ({spec['checkpoint']}). "
                    "Download it first, then pick it."
                ),
                "downloadable": True,
                "model": body.model,
            },
        )
    sidecar.set_engine_model(body.model)
    h = await sidecar.health()
    running_model = h.get("model") if h.get("reachable") else None
    return {
        "ok": True,
        "active": body.model,
        "running_model": running_model,
        "restart_required": bool(running_model and running_model != body.model),
        **(await loop.run_in_executor(None, lambda: sidecar.model_catalog(setup))),
    }


@router.get("/engine/checkpoints")
async def engine_checkpoints():
    loop = asyncio.get_event_loop()
    setup = await loop.run_in_executor(None, sidecar.setup_state)
    jobs = await loop.run_in_executor(None, sidecar.checkpoint_jobs)
    return {"jobs": jobs, "installed": setup.get("checkpoints") or []}


@router.post("/engine/checkpoints/{model_id}/download")
async def engine_download_checkpoint(model_id: str):
    """Fetch a checkpoint with the sidecar's own ``mrt checkpoints download``
    (inside the engine venv), in the background. Needs the venv: without it
    there is no ``mrt`` to run, and Install is the answer."""
    if model_id not in sidecar.ENGINE_MODELS:
        raise HTTPException(
            404,
            f"Unknown Magenta model {model_id!r}. The sidecar supports: "
            + ", ".join(sidecar.ENGINE_MODELS),
        )
    loop = asyncio.get_event_loop()
    setup = await loop.run_in_executor(None, sidecar.setup_state)
    if setup.get("probe_failed"):
        gate = _setup_gate(setup)
        if gate:
            raise gate
    if not setup.get("venv"):
        raise HTTPException(
            412,
            _gate_detail(
                setup,
                "not_installed",
                "The Magenta RT2 engine is not installed yet, so there is nothing "
                "to download the checkpoint with. Install first.",
            ),
        )
    job = await loop.run_in_executor(
        None, lambda: sidecar.start_checkpoint_download(model_id)
    )
    return {"ok": True, "job": job}


@router.post("/engine/checkpoints/clear")
async def engine_clear_checkpoint_jobs():
    return {"cleared": sidecar.clear_checkpoint_jobs()}


@router.get("/jobs/{job_id}")
async def get_job(job_id: str, summary: bool = False):
    job = MAGENTA_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if summary:
        # Status-only view for pollers that stream the finished take from the
        # library instead (the phone companion): a completed job's "result"
        # carries the whole WAV as base64, which is megabytes per poll.
        return {k: v for k, v in job.items() if k != "result"}
    return job


@router.post("/generate")
async def generate(
    prompt: str = Form(""),
    duration: float = Form(10.0),
    temperature: float = Form(1.3),
    top_k: int = Form(40),
    cfg_musiccoca: float = Form(3.0),
    cfg_notes: float = Form(1.0),
    cfg_drums: float = Form(1.0),
    drums: int = Form(-1),
    chunk_frames: int = Form(25),
    notes: str = Form(""),
    seed: int = Form(0),
    extend: bool = Form(False),
    styles: str = Form(""),
    model_size: str = Form("small"),
    audio_file: UploadFile | None = File(None),
):
    # The engine is brought up on demand inside the job (it can take a while to
    # load). Only fail fast here when the WSL side was never installed (or the
    # install check did not answer), so the user gets an actionable setup
    # prompt instead of a stuck job. "Installed, not running" is NOT a 412: the
    # job starts the engine itself and reports that stage while it does.
    h = await sidecar.health()
    engine_state = "running"
    if not h.get("available"):
        setup = await asyncio.get_event_loop().run_in_executor(
            None, sidecar.setup_state
        )
        gate = _setup_gate(setup)
        if gate:
            raise gate
        engine_state = sidecar.engine_state(h, setup)

    # Read the optional style clip now (the UploadFile is tied to this request)
    # and auto-format it to a canonical WAV the sidecar can always decode.
    audio_bytes = None
    audio_mime = "audio/wav"
    if audio_file is not None and audio_file.filename:
        raw = await audio_file.read()
        try:
            audio_bytes = await asyncio.get_event_loop().run_in_executor(
                None, _normalize_style_audio, raw
            )
        except Exception as e:
            raise HTTPException(
                422,
                {
                    "message": (
                        f"Couldn't read the style clip {audio_file.filename!r}: {e}"
                    )
                },
            ) from e

    job_id = uuid.uuid4().hex[:8]
    cond = "audio" if audio_bytes else ("notes" if notes.strip() else "text")
    MAGENTA_JOBS[job_id] = {
        "id": job_id,
        "kind": "magenta-generate",
        "model_name": f"magenta-{model_size}",
        "conditioning": cond,
        "extend": bool(extend),
        "status": "queued",
        "progress": {"step": 0, "steps": 1},
        "engine_state": engine_state,
        "created_at": time.time(),
        "result": None,
        "error": None,
    }
    asyncio.create_task(
        _run_generate(
            job_id,
            prompt=prompt,
            duration=duration,
            temperature=temperature,
            top_k=top_k,
            cfg_musiccoca=cfg_musiccoca,
            cfg_notes=cfg_notes,
            cfg_drums=cfg_drums,
            drums=drums,
            chunk_frames=chunk_frames,
            notes=notes or None,
            seed=seed,
            extend=extend,
            styles=styles or None,
            audio_bytes=audio_bytes,
            audio_mime=audio_mime,
        )
    )
    return {"ok": True, "job": {"id": job_id}, "engine_state": engine_state}


def _save_magenta_to_library(
    job_id: str,
    wav_bytes: bytes,
    *,
    prompt: str,
    duration: float,
    model_name: str,
    conditioning: str,
    seed: int,
) -> None:
    """Persist a magenta generation as a first-class library entry (``{job_id}_00``),
    mirroring the SA3 generate flow (artifacts on disk + DB sync + analysis), so it
    shows up in the library exactly like an SA3 output. Without this the frontend's
    post-generation lookup for ``{job_id}_00`` never resolves and the user sees
    "Could not find freshly-saved entry". Blocking — call via run_in_executor.
    """
    from backend.server import _save_generation_artifacts_sync, _generate_spectrograms

    spectrograms: dict[str, str] = {}
    try:
        import torchaudio

        waveform, sr = torchaudio.load(io.BytesIO(wav_bytes))
        spectrograms = _generate_spectrograms(waveform, sr)
    except Exception as e:  # spectrograms are a nicety, not required for the entry
        log.debug("magenta: spectrogram generation skipped: %s", e)

    _save_generation_artifacts_sync(
        job_id=job_id,
        index=0,
        audio_bytes=wav_bytes,
        audio_filename=f"magenta-{job_id}.wav",
        mime_type="audio/wav",
        spectrograms=spectrograms,
        metadata={
            "model_name": model_name,
            "prompt": prompt,
            "duration": duration,
            "seed": seed,
            "conditioning": conditioning,
        },
    )

    # Mirror into SQLite + enqueue analysis/stems/midi, same as the SA3 path.
    try:
        from backend.modules.library.router import get_store as _get_library_store
        from backend.modules.library.store import (
            _maybe_enqueue_analysis,
            _maybe_enqueue_midi,
            _maybe_enqueue_stems,
        )

        store = _get_library_store()
        entry_id = f"{job_id}_00"
        record = store.get_entry(entry_id)
        if record is not None and store.db is not None:
            entry_dir = store._dir_for(entry_id)  # noqa: SLF001
            meta: dict = {}
            if entry_dir and (entry_dir / "metadata.json").is_file():
                meta = json.loads(
                    (entry_dir / "metadata.json").read_text(encoding="utf-8")
                )
            store._sync_record_to_db(record, meta)  # noqa: SLF001
            _maybe_enqueue_analysis(store, entry_id, source="generate")
            _maybe_enqueue_stems(store, entry_id, source="generate")
            _maybe_enqueue_midi(store, entry_id, source="generate")
    except Exception as e:
        log.debug("magenta: post-save library sync failed for %s_00: %s", job_id, e)


async def _run_generate(
    job_id,
    *,
    prompt,
    duration,
    temperature,
    top_k,
    cfg_musiccoca,
    cfg_notes,
    cfg_drums,
    drums,
    chunk_frames,
    notes,
    seed,
    extend,
    styles,
    audio_bytes,
    audio_mime,
):
    job = MAGENTA_JOBS[job_id]
    job["status"] = "running"

    def _on_state(state: str, stage: str) -> None:
        # Pollers read `engine_state` + `progress.stage` to say "starting the
        # Magenta engine…" instead of a silent QUEUED for three minutes.
        job["engine_state"] = state
        job["progress"] = {**job.get("progress", {}), "stage": stage}

    try:
        # Bring the engine up if it isn't already (parks SA3, spawns WSL, waits
        # for the model to load). No-op when the sidecar is already serving.
        await _bring_up_sidecar(on_state=_on_state)
        _on_state("running", "generating")
        wav_bytes, meta = await sidecar.generate(
            prompt=prompt,
            duration=duration,
            temperature=temperature,
            top_k=top_k,
            cfg_musiccoca=cfg_musiccoca,
            cfg_notes=cfg_notes,
            cfg_drums=cfg_drums,
            drums=drums,
            chunk_frames=chunk_frames,
            notes=notes,
            seed=seed,
            extend=extend,
            styles=styles,
            audio_bytes=audio_bytes,
            audio_mime=audio_mime,
        )
        # Persist as a library entry ({job_id}_00) before reporting completion, so
        # the frontend's post-generation refresh finds it (mirrors the SA3 flow).
        try:
            await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: _save_magenta_to_library(
                    job_id,
                    wav_bytes,
                    prompt=prompt,
                    duration=duration,
                    model_name=str(job.get("model_name") or "magenta-small"),
                    conditioning=str(job.get("conditioning") or "text"),
                    seed=int(seed),
                ),
            )
        except Exception as e:
            log.warning("magenta: could not save generation to library: %s", e)
        job["status"] = "completed"
        job["progress"] = {"step": 1, "steps": 1}
        job["result"] = {
            "batch": False,
            "item": {
                "audio_base64": base64.b64encode(wav_bytes).decode(),
                "mime_type": "audio/wav",
                "filename": f"magenta-{job_id}.wav",
                **meta,
            },
        }
    except Exception as e:
        log.exception("Magenta generation failed: %s", e)
        job["status"] = "failed"
        job["error"] = str(e)
