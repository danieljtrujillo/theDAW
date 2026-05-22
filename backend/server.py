import asyncio
import base64
import io
import json
import logging
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Optional

import torch
import torchaudio
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from stable_audio_3.inference.distribution_shift import (
    DistributionShift,
    FluxDistributionShift,
    LogSNRShift,
)

app = FastAPI(title="StableDAW API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

pipeline = None
sample_rate = 44100
model_load_error: Optional[str] = None
model_load_error_detail: Optional[str] = None
SA3_DEBUG_ERRORS = os.environ.get("SA3_DEBUG_ERRORS", "0") in ("1", "true", "True")


@app.on_event("startup")
async def load_model():
    global pipeline, sample_rate, model_load_error, model_load_error_detail
    from stable_audio_3.model import StableAudioModel

    # Default to local-only model resolution for StableDAW backend startup.
    # Set SA3_LOCAL_ONLY=0 if you explicitly want HF fallback.
    os.environ.setdefault("SA3_LOCAL_ONLY", "1")

    try:
        pipeline = StableAudioModel.from_pretrained("medium")
        sample_rate = pipeline.model_config["sample_rate"]
        model_load_error = None
        model_load_error_detail = None
    except Exception as e:
        pipeline = None
        model_load_error = "MODEL_LOAD_FAILED"
        model_load_error_detail = str(e)
        logging.error("Model load failed", exc_info=True)


@app.get("/api/health")
async def health():
    if model_load_error:
        resp = {
            "status": "degraded",
            "model_loaded": False,
            "error": model_load_error,
        }
        if SA3_DEBUG_ERRORS and model_load_error_detail:
            resp["detail"] = model_load_error_detail
        return JSONResponse(resp, status_code=503)
    return {"status": "ok", "model_loaded": pipeline is not None}


@app.get("/api/model-info")
async def model_info():
    if not pipeline:
        resp = {"error": model_load_error or "Model not loaded"}
        if SA3_DEBUG_ERRORS and model_load_error_detail:
            resp["detail"] = model_load_error_detail
        return JSONResponse(resp, status_code=503)
    return {
        "active_model": "medium",
        "available_models": ["medium"],
        "sample_rate": sample_rate,
        "diffusion_objective": pipeline.model.diffusion_objective,
        "has_cuda": torch.cuda.is_available(),
        "device": str(pipeline.device),
        "vram_used_gb": (
            round(torch.cuda.memory_allocated() / 1024**3, 2)
            if torch.cuda.is_available()
            else 0
        ),
        "vram_total_gb": (
            round(torch.cuda.get_device_properties(0).total_memory / 1024**3, 2)
            if torch.cuda.is_available()
            else 0
        ),
    }


async def _load_audio_upload(upload: UploadFile):
    """Read an uploaded audio file and return (sample_rate, tensor) tuple."""
    data = await upload.read()
    buf = io.BytesIO(data)
    waveform, sr = torchaudio.load(buf)
    return (sr, waveform)


def _audio_to_bytes(audio: torch.Tensor, sr: int, fmt: str) -> bytes:
    """Encode a tensor to audio bytes via a named temp file.

    torchaudio.save's type stubs declare the first argument as str | PathLike,
    but the runtime implementation accepts BinaryIO in newer versions. Using a
    named temp file keeps the call site properly typed and portable.
    """
    with tempfile.NamedTemporaryFile(suffix=f".{fmt}", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        torchaudio.save(tmp_path, audio, sr, format=fmt)
        return Path(tmp_path).read_bytes()
    finally:
        Path(tmp_path).unlink(missing_ok=True)


@app.post("/api/generate")
async def generate(
    prompt: str = Form(...),
    negative_prompt: Optional[str] = Form(None),
    duration: float = Form(30.0),
    steps: int = Form(8),
    cfg_scale: float = Form(1.0),
    seed: int = Form(-1),
    sampler_type: Optional[str] = Form(None),
    sigma_max: float = Form(1.0),
    apg_scale: float = Form(1.0),
    duration_padding_sec: float = Form(6.0),
    cfg_rescale: float = Form(0.0),
    cfg_norm_threshold: float = Form(0.0),
    cfg_interval_min: float = Form(0.0),
    cfg_interval_max: float = Form(1.0),
    # Distribution shift
    dist_shift_type: Optional[str] = Form(None),
    logsnr_anchor_length: int = Form(2000),
    logsnr_anchor_logsnr: float = Form(-6.2),
    logsnr_rate: float = Form(1.0),
    logsnr_end: float = Form(2.0),
    flux_min_len: int = Form(256),
    flux_max_len: int = Form(4096),
    flux_alpha_min: float = Form(1.15),
    flux_alpha_max: float = Form(4.5),
    full_base_shift: float = Form(0.5),
    full_max_shift: float = Form(1.15),
    full_min_len: int = Form(256),
    full_max_len: int = Form(4096),
    # Init audio
    init_noise_level: float = Form(1.0),
    init_audio_type: str = Form("Audio"),
    # Inpainting
    mask_start: float = Form(0.0),
    mask_end: float = Form(0.0),
    # RF-Inversion
    inversion_steps: int = Form(8),
    inversion_gamma: float = Form(0.5),
    inversion_unconditional: str = Form("false"),
    # File format
    file_format: str = Form("wav"),
    # File uploads
    init_audio: Optional[UploadFile] = File(None),
    inpaint_audio: Optional[UploadFile] = File(None),
):
    if not pipeline:
        resp = {"error": model_load_error or "Model not loaded"}
        if SA3_DEBUG_ERRORS and model_load_error_detail:
            resp["detail"] = model_load_error_detail
        return JSONResponse(resp, status_code=503)

    # Build dist_shift object
    dist_shift = None
    if dist_shift_type and dist_shift_type not in ("None", "none", ""):
        if dist_shift_type == "LogSNR":
            dist_shift = LogSNRShift(
                anchor_length=logsnr_anchor_length,
                anchor_logsnr=logsnr_anchor_logsnr,
                rate=logsnr_rate,
                logsnr_end=logsnr_end,
            )
        elif dist_shift_type == "Flux":
            dist_shift = FluxDistributionShift(
                min_length=flux_min_len,
                max_length=flux_max_len,
                alpha_min=flux_alpha_min,
                alpha_max=flux_alpha_max,
            )
        elif dist_shift_type == "Full":
            dist_shift = DistributionShift(
                base_shift=full_base_shift,
                max_shift=full_max_shift,
                min_length=full_min_len,
                max_length=full_max_len,
            )

    # Load init audio if provided
    init_audio_tuple = None
    if init_audio is not None and init_audio.filename:
        init_audio_tuple = await _load_audio_upload(init_audio)

    # Load inpaint audio if provided
    inpaint_audio_tuple = None
    if inpaint_audio is not None and inpaint_audio.filename:
        inpaint_audio_tuple = await _load_audio_upload(inpaint_audio)

    generate_args = {
        "prompt": prompt,
        "negative_prompt": negative_prompt if negative_prompt else None,
        "duration": duration,
        "steps": steps,
        "cfg_scale": cfg_scale,
        "seed": seed,
        "apg_scale": apg_scale,
        "duration_padding_sec": duration_padding_sec,
        "scale_phi": cfg_rescale,
        "cfg_norm_threshold": cfg_norm_threshold,
        "cfg_interval": (cfg_interval_min, cfg_interval_max),
    }

    if sampler_type:
        generate_args["sampler_type"] = sampler_type
    if sigma_max != 1.0:
        generate_args["sigma_max"] = sigma_max
    if dist_shift is not None:
        generate_args["dist_shift"] = dist_shift

    # Init audio (audio-to-audio)
    if init_audio_tuple:
        generate_args["init_audio"] = init_audio_tuple
        generate_args["init_noise_level"] = init_noise_level

    # Inpainting
    if inpaint_audio_tuple:
        generate_args["inpaint_audio"] = inpaint_audio_tuple
        if mask_start > 0 or mask_end > 0:
            generate_args["inpaint_mask_start_seconds"] = mask_start
            generate_args["inpaint_mask_end_seconds"] = mask_end

    if pipeline is None:
        return JSONResponse(
            {"error": model_load_error or "Model not loaded"}, status_code=503
        )

    audio = pipeline.generate(**generate_args)
    audio = audio.float().clamp(-1, 1).squeeze(0).cpu()

    # Output format
    fmt = file_format if file_format in ("wav", "flac", "ogg") else "wav"
    mime_map = {"wav": "audio/wav", "flac": "audio/flac", "ogg": "audio/ogg"}

    audio_bytes = _audio_to_bytes(audio, sample_rate, fmt)

    return StreamingResponse(
        io.BytesIO(audio_bytes),
        media_type=mime_map.get(fmt, "audio/wav"),
        headers={
            "Content-Disposition": f"attachment; filename=output_{seed}.{fmt}",
            "X-Seed": str(seed),
            "X-Duration": str(duration),
        },
    )


# --- Async job shim for StableDAW frontend (generate-jobs + polling) ---

JOBS: dict[str, dict] = {}


def _generate_to_bytes(generate_args: dict, file_format: str) -> tuple[bytes, str]:
    if pipeline is None:
        raise RuntimeError("Model not loaded")
    audio = pipeline.generate(**generate_args)
    audio = audio.float().clamp(-1, 1).squeeze(0).cpu()
    fmt = file_format if file_format in ("wav", "flac", "ogg") else "wav"
    return _audio_to_bytes(audio, sample_rate, fmt), fmt


async def _run_generate_job(
    job_id: str,
    base_args: dict,
    batch_size: int,
    file_format: str,
):
    JOBS[job_id]["status"] = "running"
    loop = asyncio.get_event_loop()
    mime_map = {"wav": "audio/wav", "flac": "audio/flac", "ogg": "audio/ogg"}
    try:
        items = []
        seed_base = int(base_args.get("seed", -1))
        for i in range(max(1, batch_size)):
            args = dict(base_args)
            if batch_size > 1 and seed_base != -1:
                args["seed"] = seed_base + i
            audio_bytes, fmt = await loop.run_in_executor(
                None, _generate_to_bytes, args, file_format
            )
            items.append(
                {
                    "audio_base64": base64.b64encode(audio_bytes).decode("ascii"),
                    "mime_type": mime_map.get(fmt, "audio/wav"),
                    "filename": f"stabledaw_{job_id[:8]}_{i}.{fmt}",
                }
            )
        if batch_size > 1:
            JOBS[job_id]["result"] = {"batch": True, "items": items}
        else:
            JOBS[job_id]["result"] = {"batch": False, "item": items[0]}
        JOBS[job_id]["status"] = "completed"
    except Exception as e:
        JOBS[job_id]["status"] = "failed"
        JOBS[job_id]["error"] = str(e)


@app.post("/api/generate-jobs")
async def generate_jobs(
    model_name: str = Form("medium"),
    prompt: str = Form(...),
    negative_prompt: str = Form(""),
    duration: float = Form(30.0),
    steps: int = Form(8),
    cfg_scale: float = Form(1.0),
    seed: int = Form(-1),
    batch_size: int = Form(1),
    init_noise_level: float = Form(1.0),
    init_audio_type: str = Form("Audio"),
    file_format: str = Form("wav"),
    file_naming: str = Form("verbose"),
    mask_start: float = Form(0.0),
    mask_end: float = Form(0.0),
    init_audio: Optional[UploadFile] = File(None),
    inpaint_audio: Optional[UploadFile] = File(None),
):
    if not pipeline:
        detail = model_load_error or "Model not loaded"
        if SA3_DEBUG_ERRORS and model_load_error_detail:
            detail = f"{detail}: {model_load_error_detail}"
        logging.error(f"/api/generate-jobs failed: {detail}")
        raise HTTPException(status_code=503, detail=detail)

    init_audio_tuple = None
    if init_audio is not None and init_audio.filename:
        init_audio_tuple = await _load_audio_upload(init_audio)

    inpaint_audio_tuple = None
    if inpaint_audio is not None and inpaint_audio.filename:
        inpaint_audio_tuple = await _load_audio_upload(inpaint_audio)

    base_args: dict = {
        "prompt": prompt,
        "negative_prompt": negative_prompt or None,
        "duration": float(duration),
        "steps": int(steps),
        "cfg_scale": float(cfg_scale),
        "seed": int(seed),
    }
    if init_audio_tuple:
        base_args["init_audio"] = init_audio_tuple
        base_args["init_noise_level"] = float(init_noise_level)
    if inpaint_audio_tuple:
        base_args["inpaint_audio"] = inpaint_audio_tuple
        if mask_start > 0 or mask_end > 0:
            base_args["inpaint_mask_start_seconds"] = float(mask_start)
            base_args["inpaint_mask_end_seconds"] = float(mask_end)

    job_id = str(uuid.uuid4())
    JOBS[job_id] = {
        "id": job_id,
        "kind": "generate",
        "status": "queued",
        "progress": {"step": 0, "steps": int(steps)},
        "created_at": time.time(),
    }

    asyncio.create_task(
        _run_generate_job(job_id, base_args, int(batch_size), file_format)
    )

    return {"job": {"id": job_id}}


@app.get("/api/jobs")
async def list_jobs():
    return {"jobs": list(JOBS.values())}


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.get("/api/autoencoder/info")
async def autoencoder_info():
    return {"available_autoencoders": [], "loaded_autoencoders": []}


@app.get("/api/presets")
async def list_presets():
    return []


@app.post("/api/presets")
async def save_preset(preset: dict):
    return {"id": str(uuid.uuid4()), "saved": True}


# --- Studio Processing ---

EFFECT_PARAM_BOUNDS = {
    "mastering_chain": {
        "lowBoost": (-6.0, 6.0),
        "highBoost": (-6.0, 6.0),
        "limiterCeiling": (0.8, 1.0),
        "targetLUFS": (-24.0, -8.0),
    },
    "compression": {
        "attack": (0.01, 1.0),
        "decay": (0.1, 2.0),
    },
    "highpass": {
        "frequency": (20.0, 1000.0),
    },
    "volume": {
        "level": (0.0, 3.0),
    },
    "tempo": {
        "rate": (0.5, 2.0),
    },
    "vocal_processing": {
        "highpassFreq": (40.0, 200.0),
        "presenceBoost": (-6.0, 6.0),
        "targetLUFS": (-24.0, -8.0),
    },
    "lofi_vinyl": {
        "degradation": (0.0, 10.0),
        "lowpassFreq": (2000.0, 16000.0),
    },
    "stereo_widener": {
        "delayMs": (1.0, 40.0),
    },
    "reverb_delay": {
        "delayMs": (100.0, 2000.0),
        "decay": (0.1, 0.9),
        "reverbDecay": (0.1, 0.9),
    },
    "sub_exciter": {
        "subBoost": (0.0, 12.0),
        "trebleBoost": (0.0, 8.0),
    },
    "phase_isolation": {
        "cancelAmount": (0.5, 1.0),
    },
    "eq_mid": {
        "frequency": (20.0, 20000.0),
        "width": (50.0, 5000.0),
        "gain": (-12.0, 12.0),
    },
    "loudnorm": {
        "targetLUFS": (-30.0, -8.0),
        "truePeak": (-6.0, 0.0),
    },
    "lowpass": {
        "frequency": (500.0, 20000.0),
    },
    "pitch_shift": {
        "shift": (-4800.0, 4800.0),
    },
    "delay": {
        "leftMs": (0.0, 2000.0),
        "rightMs": (0.0, 2000.0),
    },
    "echo": {
        "delayMs": (100.0, 3000.0),
        "decay": (0.1, 0.8),
    },
    "fade": {
        "fadeInDuration": (0.0, 10.0),
        "fadeOutDuration": (0.0, 10.0),
    },
    "denoise": {
        "noiseReduction": (5.0, 50.0),
    },
    "declick": {
        "windowSize": (10.0, 100.0),
    },
    "silence_remove": {
        "threshold": (-80.0, -20.0),
    },
    "export_flac": {
        "compressionLevel": (0.0, 12.0),
    },
    "export_mp3": {
        "bitrate": (128.0, 320.0),
    },
    "export_aac": {
        "bitrate": (128.0, 320.0),
    },
    "export_opus": {
        "bitrate": (64.0, 256.0),
    },
}


def _validate_param(value: float, bounds: tuple[float, float], name: str) -> float:
    """Validate a numeric parameter is within bounds. Raises ValueError if not."""
    try:
        val = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"Parameter '{name}' must be a number, got: {value!r}")
    lo, hi = bounds
    if val < lo or val > hi:
        raise ValueError(
            f"Parameter '{name}' must be between {lo} and {hi}, got: {val}"
        )
    return val


def _build_filter(effect: str, params: dict[str, float]) -> list[str]:
    """Build FFmpeg audio filter arguments. Returns ['-af', 'filter_string'] or more complex args."""
    if effect == "mastering_chain":
        low_boost = params["lowBoost"]
        high_boost = params["highBoost"]
        limiter = params["limiterCeiling"]
        lufs = params["targetLUFS"]
        af = (
            f"anequalizer=c0 f=40 w=80 g={low_boost} t=1|c0 f=10000 w=5000 g={high_boost} t=2,"
            f"compand=attacks=0.001:decays=0.3:points=-80/-80|-40/-20|-20/-10|0/-5,"
            f"alimiter=limit={limiter},"
            f"loudnorm=I={lufs}:LRA=7:TP=-1,"
            f"aformat=sample_fmts=s24:sample_rates=96000"
        )
        return ["-af", af]

    elif effect == "compression":
        attack = params["attack"]
        decay = params["decay"]
        af = (
            f"compand=attacks={attack}:decays={decay}:points=-80/-80|-30/-15|0/-3|20/-1"
        )
        return ["-af", af]

    elif effect == "highpass":
        freq = params["frequency"]
        return ["-af", f"highpass=f={freq}"]

    elif effect == "volume":
        level = params["level"]
        return ["-af", f"volume={level}"]

    elif effect == "tempo":
        rate = params["rate"]
        return ["-af", f"atempo={rate}"]

    elif effect == "vocal_processing":
        hp = params["highpassFreq"]
        boost = params["presenceBoost"]
        lufs = params["targetLUFS"]
        af = (
            f"highpass=f={hp},"
            f"anequalizer=c0 f=200 w=100 g=-2 t=0|c0 f=3000 w=1000 g={boost} t=1,"
            f"compand=attacks=0.1:decays=0.3:points=-80/-80|-30/-10|0/-3|20/-0.5,"
            f"loudnorm=I={lufs}:LRA=11:TP=-1.5"
        )
        return ["-af", af]

    elif effect == "lofi_vinyl":
        deg = params["degradation"]
        lp = params["lowpassFreq"]
        sr = int(44100 - deg * 2000)
        af = (
            f"aresample={sr},"
            f"highpass=f=250,"
            f"lowpass=f={lp},"
            f"chorus=0.5:0.9:50|60|40:0.4|0.32|0.3:0.25|0.4|0.3:2|2.3|1.3"
        )
        return ["-af", af]

    elif effect == "stereo_widener":
        ms = params["delayMs"]
        return ["-af", f"adelay=0|{ms}"]

    elif effect == "reverb_delay":
        d = params["delayMs"]
        decay = params["decay"]
        rdecay = params["reverbDecay"]
        d2 = d * 2
        af = (
            f"aecho=0.8:0.9:{d}|{d2}:{decay}|{decay * 0.7:.2f},"
            f"aecho=1.0:0.7:{d2}:{rdecay}"
        )
        return ["-af", af]

    elif effect == "sub_exciter":
        sub = params["subBoost"]
        treble = params["trebleBoost"]
        return ["-af", f"bass=g={sub}:f=60:w=0.4,treble=g={treble}:f=10000:w=0.5"]

    elif effect == "phase_isolation":
        amt = params["cancelAmount"]
        return ["-af", f"pan=stereo|c0=c0-{amt}*c1|c1=c1-{amt}*c0"]

    elif effect == "eq_mid":
        freq = params["frequency"]
        width = params["width"]
        gain = params["gain"]
        return ["-af", f"anequalizer=c0 f={freq} w={width} g={gain} t=1"]

    elif effect == "loudnorm":
        lufs = params["targetLUFS"]
        tp = params["truePeak"]
        return ["-af", f"loudnorm=I={lufs}:LRA=7:TP={tp}"]

    elif effect == "lowpass":
        freq = params["frequency"]
        return ["-af", f"lowpass=f={freq}"]

    elif effect == "pitch_shift":
        shift = params["shift"]
        return ["-af", f"afreqshift=shift={shift}"]

    elif effect == "delay":
        left = params["leftMs"]
        right = params["rightMs"]
        return ["-af", f"adelay={left}|{right}"]

    elif effect == "echo":
        d = params["delayMs"]
        decay = params["decay"]
        return ["-af", f"aecho=0.8:0.9:{d}:{decay}"]

    elif effect == "fade":
        fi = params["fadeInDuration"]
        fo = params["fadeOutDuration"]
        parts = []
        if fi > 0:
            parts.append(f"afade=t=in:st=0:d={fi}")
        if fo > 0:
            parts.append(f"afade=t=out:st=0:d={fo}")
        if not parts:
            parts.append("anull")
        return ["-af", ",".join(parts)]

    elif effect == "denoise":
        nr = params["noiseReduction"]
        return ["-af", f"afftdn=nr={nr}"]

    elif effect == "declick":
        w = params["windowSize"]
        return ["-af", f"adeclick=window={w}"]

    elif effect == "silence_remove":
        thresh = params["threshold"]
        return ["-af", f"silenceremove=1:0:{thresh}dB"]

    elif effect == "export_flac":
        level = int(params["compressionLevel"])
        return ["-c:a", "flac", "-compression_level", str(level)]

    elif effect == "export_mp3":
        br = int(params["bitrate"])
        return ["-c:a", "libmp3lame", "-b:a", f"{br}k"]

    elif effect == "export_aac":
        br = int(params["bitrate"])
        return ["-c:a", "aac", "-b:a", f"{br}k"]

    elif effect == "export_opus":
        br = int(params["bitrate"])
        return ["-c:a", "libopus", "-b:a", f"{br}k"]

    else:
        raise ValueError(f"Unknown effect: {effect}")


@app.post("/api/studio/process")
async def studio_process(
    audio: UploadFile = File(...),
    effect: str = Form(...),
    params: str = Form("{}"),
    output_format: str = Form("wav"),
):
    # Validate effect name against whitelist
    if effect not in EFFECT_PARAM_BOUNDS:
        raise HTTPException(status_code=400, detail=f"Unknown effect: {effect}")

    # Validate output format
    allowed_formats = {"wav", "flac", "ogg", "mp3", "aac", "opus"}
    if output_format not in allowed_formats:
        raise HTTPException(
            status_code=400, detail=f"Unsupported format: {output_format}"
        )

    # Parse and validate params
    try:
        raw_params = json.loads(params)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid params JSON")

    bounds = EFFECT_PARAM_BOUNDS[effect]
    validated: dict[str, float] = {}
    for key, (lo, hi) in bounds.items():
        if key not in raw_params:
            raise HTTPException(status_code=400, detail=f"Missing parameter: {key}")
        try:
            validated[key] = _validate_param(raw_params[key], (lo, hi), key)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    # Build filter args
    try:
        filter_args = _build_filter(effect, validated)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Process with FFmpeg in a temp directory
    tmp_dir = tempfile.mkdtemp(prefix="studio_")
    try:
        input_path = Path(tmp_dir) / "input.wav"
        output_ext = output_format if output_format != "ogg" else "ogg"
        output_path = Path(tmp_dir) / f"output.{output_ext}"

        # Write uploaded file to disk
        content = await audio.read()
        input_path.write_bytes(content)

        # Build FFmpeg command as a list (no shell=True)
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(input_path),
            *filter_args,
            str(output_path),
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
        )

        if result.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"FFmpeg error: {result.stderr[-500:] if result.stderr else 'unknown error'}",
            )

        if not output_path.exists():
            raise HTTPException(status_code=500, detail="FFmpeg produced no output")

        # Read output and return as streaming response
        output_bytes = output_path.read_bytes()

        mime_types = {
            "wav": "audio/wav",
            "flac": "audio/flac",
            "ogg": "audio/ogg",
            "mp3": "audio/mpeg",
            "aac": "audio/aac",
            "opus": "audio/opus",
        }

        return StreamingResponse(
            io.BytesIO(output_bytes),
            media_type=mime_types.get(output_format, "audio/wav"),
            headers={
                "Content-Disposition": f'attachment; filename="processed.{output_ext}"'
            },
        )

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
