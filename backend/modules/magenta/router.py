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
import logging
import time
import uuid

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from . import sidecar

log = logging.getLogger(__name__)
router = APIRouter()

MAGENTA_JOBS: dict[str, dict] = {}


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
    return {**h, "process_alive": sidecar.engine_process_alive()}


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
    h = await sidecar.health()
    if not h.get("available"):
        raise HTTPException(503, f"Magenta sidecar not available at {h.get('url')}")

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
