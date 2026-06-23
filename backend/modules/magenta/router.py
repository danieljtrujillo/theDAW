"""Magenta RT2 module — proxies the WSL2/CUDA mrt2 studio sidecar.

Endpoints (mounted at /api/magenta):
    GET  /probe          -> sidecar health (+ availability flag)
    POST /generate       -> start a generation job; returns {job:{id}}
    GET  /jobs/{job_id}  -> poll job status/result (mirrors the main JOBS shape)

The generation itself is one-shot on the sidecar, but we wrap it in the same
job/poll shape the frontend already uses for SA3 generations so the UI flow is
uniform. The model is text-prompt -> audio; ``model_size`` is accepted for
forward-compatibility but the local studio server serves a single fixed model.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import time
import uuid

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from . import sidecar

log = logging.getLogger(__name__)
router = APIRouter()

MAGENTA_JOBS: dict[str, dict] = {}

# Serializes on-demand engine bring-up so concurrent CREATE presses don't each
# park SA3 + spawn WSL; the first wins, the rest see it ready inside the lock.
_bringup_lock = asyncio.Lock()


async def _bring_up_sidecar(timeout: float = 240.0) -> None:
    """Ensure the extended sidecar is up and ready, starting it on demand.

    No-op when it is already available. Otherwise: refuse with an actionable
    message if the WSL side was never installed; else park SA3 to free the GPU,
    stop any stray engine, spawn ours, and wait for /health to report ready.
    Raises RuntimeError (carried into the job's error) on setup-missing or timeout.
    """
    if (await sidecar.health()).get("available"):
        return
    loop = asyncio.get_event_loop()
    async with _bringup_lock:
        h = await sidecar.health()
        if h.get("available"):
            return
        setup = await loop.run_in_executor(None, sidecar.setup_state)
        if not setup.get("ready"):
            raise RuntimeError(
                "Magenta RT2 is not installed. Run Setup-MRT2.bat "
                "(sidecars/magenta-rt2-nvidia) once to install it, then try again."
            )
        # Park SA3 so the engine's JAX runtime finds a free GPU, then (re)spawn.
        if not (h.get("reachable") and h.get("protocol_ok")):
            try:
                from backend import server as srv

                await srv.offload_model()
            except Exception:
                log.debug(
                    "magenta: SA3 offload before engine start failed", exc_info=True
                )
            await loop.run_in_executor(None, sidecar.stop_engine)
            await loop.run_in_executor(None, sidecar.start_engine)
        # Model load can take a while on a cold start; poll until ready.
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            await asyncio.sleep(2.0)
            if (await sidecar.health()).get("available"):
                return
        raise RuntimeError(
            "The Magenta RT2 engine started but did not become ready in time. "
            "Check the WSL sidecar, then try again."
        )


@router.get("/probe")
async def probe():
    return await sidecar.health()


# ── engine lifecycle: the Model dropdown's GPU swap, no terminal anywhere ────
#
# /engine/start parks the SA3 model in CPU RAM (frees VRAM), stops any OTHER
# magenta engine (including the bundled JSON-protocol Studio server), and spawns
# the extended sidecar in WSL2. /engine/stop kills every magenta engine and
# swaps SA3 back onto the GPU. Both refuse with 409 while a generation runs.


@router.post("/engine/start")
async def engine_start():
    h = await sidecar.health()
    if h.get("reachable") and h.get("protocol_ok"):
        # The extended engine is already up (ready or still loading) — keep it.
        return {"ok": True, "already_running": True, **h}

    # Refuse with a precise diagnosis when the WSL side was never set up —
    # spawning would just die on a missing venv and read as a vague ERROR.
    loop_probe = asyncio.get_event_loop()
    setup = await loop_probe.run_in_executor(None, sidecar.setup_state)
    if not setup.get("ready"):
        raise HTTPException(
            412,
            {
                "setup_required": True,
                **setup,
                "message": (
                    "The Magenta RT2 engine is not installed yet. Run "
                    "Setup-MRT2.bat (sidecars/magenta-rt2-nvidia) once — it "
                    "checks the PC, asks consent, and installs everything."
                ),
            },
        )

    # Park SA3 first so the engine's JAX runtime finds a free GPU. The import is
    # deferred to request time: the server module is fully initialized by then.
    from backend import server as srv

    parked = await srv.offload_model()

    # Stop every other magenta engine first (idempotent): a bundled Studio on a
    # DIFFERENT port still holds GPU memory even though the 8777 probe missed it.
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, sidecar.stop_engine)
    spawn = await loop.run_in_executor(None, sidecar.start_engine)
    return {"ok": True, "already_running": False, "parked": parked, **spawn}


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
    return {"ok": True, **stopped, "sa3": restored}


@router.get("/engine/status")
async def engine_status():
    h = await sidecar.health()
    out = {**h, "process_alive": sidecar.engine_process_alive()}
    if not (h.get("reachable") and h.get("protocol_ok")):
        setup = await asyncio.get_event_loop().run_in_executor(
            None, sidecar.setup_state
        )
        out["setup_required"] = not setup.get("ready")
        out["setup"] = setup
    return out


@router.get("/jobs/{job_id}")
async def get_job(job_id: str):
    job = MAGENTA_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
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
    # load). Only fail fast here when the WSL side was never installed, so the
    # user gets an actionable setup prompt instead of a stuck job.
    h = await sidecar.health()
    if not h.get("available"):
        setup = await asyncio.get_event_loop().run_in_executor(
            None, sidecar.setup_state
        )
        if not setup.get("ready"):
            raise HTTPException(
                412,
                {
                    "setup_required": True,
                    **setup,
                    "message": (
                        "Magenta RT2 is not installed. Run Setup-MRT2.bat "
                        "(sidecars/magenta-rt2-nvidia) once to install it."
                    ),
                },
            )

    # Read the optional style clip now (the UploadFile is tied to this request).
    audio_bytes = None
    audio_mime = "audio/wav"
    if audio_file is not None and audio_file.filename:
        audio_bytes = await audio_file.read()
        audio_mime = audio_file.content_type or "audio/wav"

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
    return {"ok": True, "job": {"id": job_id}}


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
    try:
        # Bring the engine up if it isn't already (parks SA3, spawns WSL, waits
        # for the model to load). No-op when the sidecar is already serving.
        await _bring_up_sidecar()
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
