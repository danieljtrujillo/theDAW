import asyncio
import sys

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

import base64
import io
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
import torch
import torchaudio
from fastapi import FastAPI, Form, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

# MUST set non-interactive backend BEFORE any other matplotlib imports
import matplotlib
matplotlib.use('Agg')

from matplotlib.figure import Figure
from PIL import Image
from backend.assistant_routes import router as assistant_router

from stable_audio_3.inference.distribution_shift import (
    DistributionShift,
    FluxDistributionShift,
    LogSNRShift,
)
from stable_audio_3.interface.aeiou import audio_spectrogram_image
from stable_audio_3.model_configs import arc_models, rf_models
from stable_audio_3.models.lora import remove_lora

logger = logging.getLogger(__name__)

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
PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_GENERATION_MODEL = "medium"
GENERATION_MODELS = {**arc_models, **rf_models}
SPECTROGRAM_TYPES = ("mel", "stft", "chromagram", "cqt")
_UNSAFE_FILENAME_CHARS = re.compile(r'[^A-Za-z0-9._ -]+')
_DASH_RUN = re.compile(r'-{2,}')
_WINDOWS_RESERVED_FILENAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}
_generation_pipelines: dict[str, object] = {}
_active_model_name = DEFAULT_GENERATION_MODEL
_generation_job_lock = asyncio.Lock()

# Spectrogram cache: {job_id: {mel, stft, chromagram, cqt}}
_spec_cache: dict[str, dict[str, str]] = {}


@dataclass(frozen=True)
class LoraFormSlot:
    index: int
    upload: object
    weight: float


def _normalize_generation_model(model_name: str | None) -> str:
    """Return a supported DiT generation model, falling back away from AE-only names."""
    normalized = (model_name or "").strip().lower()
    if normalized in GENERATION_MODELS:
        return normalized
    return DEFAULT_GENERATION_MODEL


def _get_or_load_generation_pipeline(model_name: str):
    """Load and cache the selected DiT generation pipeline."""
    global pipeline, sample_rate, _active_model_name

    normalized = _normalize_generation_model(model_name)
    if normalized not in _generation_pipelines:
        from stable_audio_3.model import StableAudioModel

        _generation_pipelines[normalized] = StableAudioModel.from_pretrained(normalized)

    selected = _generation_pipelines[normalized]
    pipeline = selected
    sample_rate = selected.model_config["sample_rate"]
    _active_model_name = normalized
    return selected


def _coerce_form_bool(value) -> bool:
    """Coerce browser FormData boolean strings into Python booleans."""
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}
    return False


def _normalize_init_audio_type(init_audio_type: str | None) -> str:
    normalized = (init_audio_type or "Audio").strip().lower()
    if normalized in {"rf-inv", "rf inversion", "rf-inversion", "rfinversion"}:
        return "RF-Inversion"
    return "Audio"


def _validate_init_audio_mode(init_audio_type: str | None, has_init_audio: bool) -> str:
    normalized = _normalize_init_audio_type(init_audio_type)
    if has_init_audio and normalized == "RF-Inversion":
        raise HTTPException(
            status_code=501,
            detail=(
                "RF-Inversion controls are present in the UI, but the current "
                "Stable Audio 3 pipeline code does not implement RF-Inversion yet. "
                "Use Init Audio / Audio mode for this generation."
            ),
        )
    return normalized


def _condense_filename_text(text: str | None, fallback: str = "_") -> str:
    condensed = _UNSAFE_FILENAME_CHARS.sub("-", str(text or ""))
    condensed = _DASH_RUN.sub("-", condensed).strip(" .-")[:150].rstrip(" .-")
    if not condensed:
        condensed = fallback
    if condensed.upper() in _WINDOWS_RESERVED_FILENAMES:
        condensed = f"{condensed}_"
    return condensed


def _get_generation_artifacts_root() -> Path:
    """Return the local folder where generated audio + spectrograms are saved."""
    configured = os.getenv("STABLEDAW_GENERATIONS_DIR")
    return Path(configured).expanduser().resolve() if configured else PROJECT_ROOT / "data" / "generations"


def _safe_filename(filename: str | None, fallback: str = "output.wav") -> str:
    raw_name = str(filename or fallback).replace("\\", "-").replace("/", "-")
    fallback_suffix = Path(fallback).suffix or ".wav"
    suffix_match = re.search(r'\.[A-Za-z0-9]{1,16}$', raw_name)
    suffix = suffix_match.group(0) if suffix_match else fallback_suffix
    stem_text = raw_name[: -len(suffix)] if suffix and raw_name.endswith(suffix) else raw_name
    stem = _condense_filename_text(stem_text, Path(fallback).stem or "output")
    suffix = _UNSAFE_FILENAME_CHARS.sub("", suffix or fallback_suffix)
    if suffix.lower() not in {".wav", ".flac", ".ogg", ".png", ".json", ".safetensors"}:
        suffix = fallback_suffix
    return f"{stem}{suffix}"


def _make_generation_filename(
    job_id: str,
    index: int,
    file_format: str,
    file_naming: str,
    prompt: str,
    negative_prompt: str | None,
    seed: int,
) -> str:
    """Build a safe output filename using the frontend-selected naming mode."""
    fmt = (file_format or "wav").split()[0].lower()
    if fmt not in {"wav", "flac", "ogg"}:
        fmt = "wav"

    mode = (file_naming or "verbose").strip().lower()
    if mode == "seed":
        basename = f"seed_{seed}"
    elif mode == "prompt":
        basename = _condense_filename_text(prompt)
    elif mode == "verbose":
        basename = _condense_filename_text(prompt)
        if negative_prompt:
            basename += f".neg-{_condense_filename_text(negative_prompt)}"
        basename += f".{seed}"
    else:
        basename = f"stabledaw_{_condense_filename_text(job_id[:8], 'job')}"

    return f"{basename}_{index}.{fmt}"


def _save_generation_artifacts(
    job_id: str,
    index: int,
    audio_bytes: bytes,
    audio_filename: str,
    mime_type: str,
    spectrograms: dict[str, str],
    metadata: dict | None = None,
) -> dict:
    """Save one generation's audio, spectrogram PNGs, and metadata locally."""
    item_dir = _get_generation_artifacts_root() / job_id / f"{index:02d}"
    item_dir.mkdir(parents=True, exist_ok=True)

    safe_audio_filename = _safe_filename(audio_filename)
    audio_path = item_dir / safe_audio_filename
    audio_path.write_bytes(audio_bytes)

    spectrogram_paths: dict[str, str | None] = {}
    for name in SPECTROGRAM_TYPES:
        encoded = spectrograms.get(name) or ""
        if not encoded:
            spectrogram_paths[name] = None
            continue
        spec_path = item_dir / f"spectrogram_{name}.png"
        spec_path.write_bytes(base64.b64decode(encoded))
        spectrogram_paths[name] = str(spec_path)

    metadata_path = item_dir / "metadata.json"
    metadata_payload = {
        "job_id": job_id,
        "index": index,
        "filename": safe_audio_filename,
        "mime_type": mime_type,
        "audio_path": str(audio_path),
        "artifact_dir": str(item_dir),
        "spectrogram_paths": spectrogram_paths,
        "saved_at": time.time(),
        **(metadata or {}),
    }
    metadata_path.write_text(json.dumps(metadata_payload, indent=2), encoding="utf-8")

    return {
        "artifact_dir": str(item_dir),
        "audio_path": str(audio_path),
        "spectrogram_paths": spectrogram_paths,
        "metadata_path": str(metadata_path),
    }


def _extract_lora_form_slots(form) -> list[LoraFormSlot]:
    """Extract ordered LoRA uploads and weights from multipart form data."""
    slots: list[LoraFormSlot] = []
    for key, upload in form.multi_items():
        if not key.startswith("lora_file_"):
            continue
        try:
            index = int(key.rsplit("_", 1)[1])
        except (IndexError, ValueError):
            continue
        if not getattr(upload, "filename", None):
            continue
        try:
            weight = float(form.get(f"lora_weight_{index}", 1.0))
        except (TypeError, ValueError):
            weight = 1.0
        slots.append(LoraFormSlot(index=index, upload=upload, weight=weight))
    return sorted(slots, key=lambda slot: slot.index)


async def _persist_lora_uploads(form, job_id: str) -> tuple[list[str], list[float], Path | None]:
    """Persist uploaded LoRA files long enough for the background job to load them."""
    slots = _extract_lora_form_slots(form)
    if not slots:
        return [], [], None

    temp_dir = Path(tempfile.mkdtemp(prefix=f"stabledaw_lora_{job_id[:8]}_"))
    paths: list[str] = []
    weights: list[float] = []
    for slot in slots:
        original = Path(getattr(slot.upload, "filename", f"lora_{slot.index}.safetensors")).name
        stem = _condense_filename_text(Path(original).stem, f"lora_{slot.index}")
        suffix = Path(original).suffix or ".safetensors"
        dest = temp_dir / f"{slot.index:02d}_{stem}{suffix}"
        data = await slot.upload.read()
        dest.write_bytes(data)
        paths.append(str(dest))
        weights.append(slot.weight)

    return paths, weights, temp_dir


def _clear_generation_loras(generation_pipeline) -> None:
    """Remove request-scoped LoRA parametrizations from a cached pipeline."""
    remove_lora(generation_pipeline.model)
    generation_pipeline.model.use_lora = False
    generation_pipeline.model.lora_names = []


def _image_to_base64(img: Image.Image) -> str:
    """Convert PIL Image to base64 PNG string."""
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)
    return base64.b64encode(buf.read()).decode('utf-8')


def _fig_to_base64(fig: Figure) -> str:
    """Convert matplotlib Figure to base64 PNG string."""
    buf = io.BytesIO()
    fig.savefig(buf, format='png', bbox_inches='tight', pad_inches=0, dpi=100)
    buf.seek(0)
    return base64.b64encode(buf.read()).decode('utf-8')


async def _decode_audio_bytes(audio_bytes: bytes) -> tuple[np.ndarray, int]:
    """Decode raw audio bytes to numpy array. Returns (waveform, sample_rate).

    Tries soundfile first (wav, flac, ogg), then falls back to torchaudio via temp file.
    Waveform shape: (channels, samples) as float32.
    """
    buf = io.BytesIO(audio_bytes)

    # Try soundfile first (handles wav, flac, ogg)
    try:
        import soundfile as sf
        waveform, sr = sf.read(buf)
        # Convert to float32, shape (channels, samples) or (samples,)
        waveform = waveform.astype(np.float32)
        if waveform.ndim == 1:
            waveform = waveform[None, :]  # (1, samples)
        else:
            waveform = waveform.T  # (channels, samples)
        return waveform, sr
    except (ImportError, Exception) as e:
        logger.debug(f"soundfile decode failed, trying torchaudio: {e}")
        buf.seek(0)

    # Fallback: torchaudio via temp file
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        f.write(audio_bytes)
        fname = f.name
    try:
        t, sr = torchaudio.load(fname)
        return t.numpy(), sr
    finally:
        try:
            os.unlink(fname)
        except Exception:
            pass


def _generate_mel(waveform: torch.Tensor, sr: int) -> str:
    """Generate MEL spectrogram. Returns base64 PNG or empty string on error."""
    try:
        mel_img = audio_spectrogram_image(
            waveform,
            power=2.0,
            sample_rate=sr,
            db=True,
            db_range=[35, 120],
            justimage=True
        )
        return _image_to_base64(mel_img)
    except Exception as e:
        logger.warning(f"MEL spectrogram failed: {e}")
        return ""


def _generate_stft(waveform: np.ndarray, sr: int) -> str:
    """Generate STFT spectrogram. Returns base64 PNG or empty string on error."""
    try:
        import librosa
        import librosa.display

        mono = waveform[0] if waveform.ndim > 1 else waveform
        D = librosa.amplitude_to_db(np.abs(librosa.stft(mono)), ref=np.max)

        fig = Figure(figsize=(10, 3))
        ax = fig.add_subplot(111)
        librosa.display.specshow(D, sr=sr, x_axis='time', y_axis='hz', ax=ax, cmap='viridis')
        ax.set_axis_off()
        fig.tight_layout(pad=0)

        return _fig_to_base64(fig)
    except Exception as e:
        logger.warning(f"STFT spectrogram failed: {e}")
        return ""


def _generate_chromagram(waveform: np.ndarray, sr: int) -> str:
    """Generate chromagram. Returns base64 PNG or empty string on error."""
    try:
        import librosa
        import librosa.display

        mono = waveform[0] if waveform.ndim > 1 else waveform
        chroma = librosa.feature.chroma_stft(y=mono, sr=sr)

        fig = Figure(figsize=(10, 3))
        ax = fig.add_subplot(111)
        librosa.display.specshow(chroma, sr=sr, x_axis='time', y_axis='chroma', ax=ax, cmap='viridis')
        ax.set_axis_off()
        fig.tight_layout(pad=0)

        return _fig_to_base64(fig)
    except Exception as e:
        logger.warning(f"chromagram failed: {e}")
        return ""


def _generate_cqt(waveform: np.ndarray, sr: int) -> str:
    """Generate CQT spectrogram. Returns base64 PNG or empty string on error."""
    try:
        import librosa
        import librosa.display

        mono = waveform[0] if waveform.ndim > 1 else waveform
        C = np.abs(librosa.cqt(mono, sr=sr))
        C_db = librosa.amplitude_to_db(C, ref=np.max)

        fig = Figure(figsize=(10, 3))
        ax = fig.add_subplot(111)
        librosa.display.specshow(C_db, sr=sr, x_axis='time', y_axis='cqt_note', ax=ax, cmap='viridis')
        ax.set_axis_off()
        fig.tight_layout(pad=0)

        return _fig_to_base64(fig)
    except Exception as e:
        logger.warning(f"CQT spectrogram failed: {e}")
        return ""


def _generate_spectrograms(waveform: torch.Tensor, sr: int) -> dict[str, str]:
    """
    Generate all 4 spectrogram types from waveform tensor.
    Returns dict with base64 PNG strings: {mel, stft, chromagram, cqt}.
    Each type is independently fault-tolerant - returns empty string on error.
    """
    result = {"mel": "", "stft": "", "chromagram": "", "cqt": ""}

    # MEL - use existing aeiou function
    result["mel"] = _generate_mel(waveform, sr)

    # For STFT, Chromagram, CQT - convert to numpy for librosa
    try:
        if waveform.ndim > 1:
            y = waveform.mean(dim=0).cpu().numpy()
        else:
            y = waveform.cpu().numpy()


        result["stft"] = _generate_stft(y, sr)
        result["chromagram"] = _generate_chromagram(y, sr)
        result["cqt"] = _generate_cqt(y, sr)

    except ImportError:
        logger.warning("librosa not installed - STFT, Chromagram, and CQT unavailable")
    except Exception as e:
        logger.warning(f"Librosa spectrogram generation failed: {e}")

    return result


@app.on_event("startup")
async def load_model():
    _get_or_load_generation_pipeline(DEFAULT_GENERATION_MODEL)

    import logging as _logging
    _logger = _logging.getLogger(__name__)
    try:
        from backend.rag import initialize_rag
        n_chunks = initialize_rag()
        _logger.info("RAG indexed %d chunks", n_chunks)
    except Exception as e:
        _logger.warning("RAG initialization failed (non-fatal): %s", e)


@app.get("/api/health")
async def health():
    return {"status": "ok", "model_loaded": pipeline is not None}


@app.get("/api/model-info")
async def model_info():
    if not pipeline:
        return JSONResponse({"error": "Model not loaded"}, status_code=503)
    return {
        "active_model": _active_model_name,
        "available_models": sorted(GENERATION_MODELS),
        "loaded_models": sorted(_generation_pipelines),
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


@app.post("/api/spectrogram")
async def generate_spectrogram(
    audio_base64: Optional[str] = Form(None),
    mime_type: str = Form("audio/wav"),
    sample_rate_form: int = Form(44100),
    audio_file: Optional[UploadFile] = File(None),
):
    """
    Generate spectrograms (MEL, STFT, Chromagram, CQT) from audio.
    Accepts either audio_base64 (string) OR audio_file (UploadFile).
    Returns JSON with base64 PNG strings for each spectrogram type.
    """
    # Validate input
    if audio_base64 is None and audio_file is None:
        raise HTTPException(status_code=400, detail="Either audio_base64 or audio_file must be provided")

    if audio_base64 is not None and audio_file is not None:
        raise HTTPException(status_code=400, detail="Provide either audio_base64 or audio_file, not both")

    try:
        # Load audio
        if audio_file is not None:
            # Read from UploadFile
            audio_data = await audio_file.read()

            # Validate size (50MB limit)
            if len(audio_data) > 50 * 1024 * 1024:
                raise HTTPException(status_code=413, detail="Audio file exceeds 50MB limit")
        else:
            # Decode base64
            audio_data = base64.b64decode(audio_base64)

            # Validate size (50MB limit)
            if len(audio_data) > 50 * 1024 * 1024:
                raise HTTPException(status_code=413, detail="Audio data exceeds 50MB limit")

        # Decode audio with robust fallback
        waveform_np, sr = await _decode_audio_bytes(audio_data)
        waveform = torch.from_numpy(waveform_np)

        # Generate spectrograms
        spectrograms = _generate_spectrograms(waveform, sr)

        return JSONResponse(spectrograms)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Spectrogram generation error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to generate spectrograms: {str(e)}")


@app.get("/api/spectrogram/{job_id}")
async def get_cached_spectrogram(job_id: str):
    """
    Retrieve cached spectrograms for a completed job.
    Returns 404 if job not found or spectrograms not cached.
    """
    if job_id not in _spec_cache:
        raise HTTPException(status_code=404, detail="Spectrograms not found for this job")

    return JSONResponse(_spec_cache[job_id])


@app.get("/api/spectrogram/{job_id}/{index}")
async def get_cached_spectrogram_item(job_id: str, index: int):
    """Retrieve cached spectrograms for a specific generated item in a batch."""
    cache_key = f"{job_id}:{index}"
    if cache_key not in _spec_cache:
        raise HTTPException(status_code=404, detail="Spectrograms not found for this job item")

    return JSONResponse(_spec_cache[cache_key])


async def _load_audio_upload(upload: UploadFile):
    """Read an uploaded audio file and return (sample_rate, tensor) tuple."""
    data = await upload.read()
    buf = io.BytesIO(data)
    waveform, sr = torchaudio.load(buf)
    return (sr, waveform)


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
        return JSONResponse({"error": "Model not loaded"}, status_code=503)

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
    init_audio_type = _validate_init_audio_mode(
        init_audio_type,
        has_init_audio=init_audio_tuple is not None,
    )

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

    audio = pipeline.generate(**generate_args)
    audio = audio.to(torch.float32).clamp(-1, 1).squeeze(0).cpu()

    # Output format
    fmt = file_format if file_format in ("wav", "flac", "ogg") else "wav"
    mime_map = {"wav": "audio/wav", "flac": "audio/flac", "ogg": "audio/ogg"}

    buffer = io.BytesIO()
    torchaudio.save(buffer, audio, sample_rate, format=fmt)
    buffer.seek(0)

    return StreamingResponse(
        buffer,
        media_type=mime_map.get(fmt, "audio/wav"),
        headers={
            "Content-Disposition": f"attachment; filename=output_{seed}.{fmt}",
            "X-Seed": str(seed),
            "X-Duration": str(duration),
        },
    )


# --- Async job shim for StableDAW frontend (generate-jobs + polling) ---

JOBS: dict[str, dict] = {}


def _generate_to_bytes(generation_pipeline, generate_args: dict, file_format: str) -> tuple[bytes, str]:
    audio = generation_pipeline.generate(**generate_args)
    audio = audio.to(torch.float32).clamp(-1, 1).squeeze(0).cpu()
    fmt = file_format if file_format in ("wav", "flac", "ogg") else "wav"
    output_sample_rate = int(generation_pipeline.model_config.get("sample_rate", sample_rate))
    buf = io.BytesIO()
    torchaudio.save(buf, audio, output_sample_rate, format=fmt)
    return buf.getvalue(), fmt


async def _run_generate_job(
    job_id: str,
    generation_pipeline,
    base_args: dict,
    batch_size: int,
    file_format: str,
    file_naming: str,
    lora_paths: list[str],
    lora_weights: list[float],
    lora_temp_dir: Path | None,
):
    JOBS[job_id]["status"] = "running"
    loop = asyncio.get_event_loop()
    mime_map = {"wav": "audio/wav", "flac": "audio/flac", "ogg": "audio/ogg"}
    try:
        items = []
        async with _generation_job_lock:
            try:
                if lora_paths:
                    _clear_generation_loras(generation_pipeline)
                    generation_pipeline.load_lora(lora_paths)
                    for i, weight in enumerate(lora_weights):
                        generation_pipeline.set_lora_strength(weight, lora_index=i)

                seed_base = int(base_args.get("seed", -1))
                for i in range(max(1, batch_size)):
                    args = dict(base_args)
                    if batch_size > 1 and seed_base != -1:
                        args["seed"] = seed_base + i
                    audio_bytes, fmt = await loop.run_in_executor(
                        None, _generate_to_bytes, generation_pipeline, args, file_format
                    )
                    mime_type = mime_map.get(fmt, "audio/wav")
                    filename = _make_generation_filename(
                        job_id,
                        i,
                        fmt,
                        file_naming,
                        str(base_args.get("prompt", "")),
                        base_args.get("negative_prompt"),
                        int(args.get("seed", -1)),
                    )
                    waveform, sr = torchaudio.load(io.BytesIO(audio_bytes))
                    spectrograms = _generate_spectrograms(waveform, sr)
                    artifact_info = _save_generation_artifacts(
                        job_id=job_id,
                        index=i,
                        audio_bytes=audio_bytes,
                        audio_filename=filename,
                        mime_type=mime_type,
                        spectrograms=spectrograms,
                        metadata={
                            "model_name": JOBS[job_id].get("model_name"),
                            "prompt": base_args.get("prompt", ""),
                            "negative_prompt": base_args.get("negative_prompt"),
                            "duration": base_args.get("duration"),
                            "steps": args.get("steps"),
                            "cfg_scale": args.get("cfg_scale"),
                            "seed": args.get("seed"),
                        },
                    )
                    _spec_cache[f"{job_id}:{i}"] = spectrograms
                    if i == 0:
                        _spec_cache[job_id] = spectrograms
                    items.append(
                        {
                            "audio_base64": base64.b64encode(audio_bytes).decode("ascii"),
                            "mime_type": mime_type,
                            "filename": filename,
                            "spectrograms": spectrograms,
                            **artifact_info,
                        }
                    )
            finally:
                if lora_paths:
                    _clear_generation_loras(generation_pipeline)

        if batch_size > 1:
            JOBS[job_id]["result"] = {"batch": True, "items": items}
        else:
            JOBS[job_id]["result"] = {"batch": False, "item": items[0]}
        JOBS[job_id]["artifact_dir"] = str(_get_generation_artifacts_root() / job_id)
        JOBS[job_id]["status"] = "completed"
        logger.info("Saved generation artifacts for job %s in %s", job_id, JOBS[job_id]["artifact_dir"])

    except Exception as e:
        JOBS[job_id]["status"] = "failed"
        JOBS[job_id]["error"] = str(e)
    finally:
        if lora_temp_dir is not None:
            shutil.rmtree(lora_temp_dir, ignore_errors=True)


@app.post("/api/generate-jobs")
async def generate_jobs(
    request: Request,
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
    sampler_type: Optional[str] = Form(None),
    sigma_max: float = Form(1.0),
    duration_padding_sec: float = Form(6.0),
    apg_scale: float = Form(1.0),
    cfg_rescale: float = Form(0.0),
    cfg_norm_threshold: float = Form(0.0),
    cfg_interval_min: float = Form(0.0),
    cfg_interval_max: float = Form(1.0),
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
    inversion_steps: int = Form(8),
    inversion_gamma: float = Form(0.5),
    inversion_unconditional: str = Form("false"),
    cut_to_duration: str = Form("true"),
    init_audio: Optional[UploadFile] = File(None),
    inpaint_audio: Optional[UploadFile] = File(None),
):
    if not pipeline:
        raise HTTPException(status_code=503, detail="Model not loaded")

    normalized_model_name = _normalize_generation_model(model_name)
    generation_pipeline = _get_or_load_generation_pipeline(normalized_model_name)

    init_audio_tuple = None
    if init_audio is not None and init_audio.filename:
        init_audio_tuple = await _load_audio_upload(init_audio)

    normalized_init_audio_type = _validate_init_audio_mode(
        init_audio_type,
        has_init_audio=init_audio_tuple is not None,
    )

    inpaint_audio_tuple = None
    if inpaint_audio is not None and inpaint_audio.filename:
        inpaint_audio_tuple = await _load_audio_upload(inpaint_audio)

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

    base_args: dict = {
        "prompt": prompt,
        "negative_prompt": negative_prompt or None,
        "duration": float(duration),
        "steps": int(steps),
        "cfg_scale": float(cfg_scale),
        "seed": int(seed),
        "apg_scale": float(apg_scale),
        "duration_padding_sec": float(duration_padding_sec),
        "scale_phi": float(cfg_rescale),
        "cfg_norm_threshold": float(cfg_norm_threshold),
        "cfg_interval": (float(cfg_interval_min), float(cfg_interval_max)),
        "truncate_output_to_duration": _coerce_form_bool(cut_to_duration),
    }
    if sampler_type:
        base_args["sampler_type"] = sampler_type
    if sigma_max != 1.0:
        base_args["sigma_max"] = float(sigma_max)
    if dist_shift is not None:
        base_args["dist_shift"] = dist_shift
    if init_audio_tuple:
        base_args["init_audio"] = init_audio_tuple
        base_args["init_noise_level"] = float(init_noise_level)
    if inpaint_audio_tuple:
        base_args["inpaint_audio"] = inpaint_audio_tuple
        if mask_start > 0 or mask_end > 0:
            base_args["inpaint_mask_start_seconds"] = float(mask_start)
            base_args["inpaint_mask_end_seconds"] = float(mask_end)

    job_id = str(uuid.uuid4())
    lora_paths, lora_weights, lora_temp_dir = await _persist_lora_uploads(
        await request.form(),
        job_id,
    )
    JOBS[job_id] = {
        "id": job_id,
        "kind": "generate",
        "model_name": normalized_model_name,
        "init_audio_type": normalized_init_audio_type,
        "lora_count": len(lora_paths),
        "status": "queued",
        "progress": {"step": 0, "steps": int(steps)},
        "created_at": time.time(),
    }

    asyncio.create_task(
        _run_generate_job(
            job_id,
            generation_pipeline,
            base_args,
            int(batch_size),
            file_format,
            file_naming,
            lora_paths,
            lora_weights,
            lora_temp_dir,
        )
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


@app.post("/api/jobs/train-lora")
async def train_lora_stub():
    raise HTTPException(status_code=501, detail="LoRA training not implemented in this backend.")


@app.post("/api/jobs/pre-encode")
async def pre_encode_stub():
    raise HTTPException(status_code=501, detail="Pre-encode not implemented in this backend.")


@app.post("/api/autoencoder/encode")
async def ae_encode_stub():
    raise HTTPException(status_code=501, detail="Autoencoder encode not implemented in this backend.")


@app.post("/api/autoencoder/decode")
async def ae_decode_stub():
    raise HTTPException(status_code=501, detail="Autoencoder decode not implemented in this backend.")


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
        raise ValueError(f"Parameter '{name}' must be between {lo} and {hi}, got: {val}")
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
        af = f"compand=attacks={attack}:decays={decay}:points=-80/-80|-30/-15|0/-3|20/-1"
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
        raise HTTPException(status_code=400, detail=f"Unsupported format: {output_format}")

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
            "ffmpeg", "-y",
            "-i", str(input_path),
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
            headers={"Content-Disposition": f'attachment; filename="processed.{output_ext}"'},
        )

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

app.include_router(assistant_router)
