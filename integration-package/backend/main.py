"""
FastAPI backend for stem separation with 2/4/6/12 stem support
Uses BS-RoFormer (state-of-the-art), F0-guided vocal separation, and LARSNET
"""

import os
import sys
import json
import shutil
import tempfile
import asyncio
import zipfile
import contextlib
import tarfile
import subprocess
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple
from datetime import datetime
import uuid

from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect, HTTPException, Query, BackgroundTasks
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import torch
import torchaudio
import numpy as np
import soundfile as sf
import librosa
import torchcrepe

# BS-RoFormer integration via audio-separator
try:
    from audio_separator.separator import Separator
    BS_ROFORMER_AVAILABLE = True
except ImportError:
    BS_ROFORMER_AVAILABLE = False
    print("[WARN] audio-separator not available, falling back to Demucs")

# Add LARSNET to path
sys.path.append(str(Path(__file__).parent / "larsnet"))

# Global storage for processing status
processing_status: Dict[str, Dict[str, Any]] = {}
websocket_connections: Dict[str, WebSocket] = {}

app = FastAPI(title="Stem Separator API", version="1.0.0")

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ProcessingStatus(BaseModel):
    task_id: str
    status: str
    progress: int
    message: str
    result_url: Optional[str] = None
    error: Optional[str] = None

class SeparationRequest(BaseModel):
    stems: int = 4
    device: str = "cpu"
    quality: str = "hq"  # fast | balanced | hq

# Utility functions
def get_device():
    """Get the appropriate device for processing"""
    if torch.cuda.is_available():
        return "cuda"
    elif torch.backends.mps.is_available():
        return "mps"
    else:
        return "cpu"

async def update_progress(task_id: str, progress: int, message: str, status: str = "processing"):
    """Update processing progress and notify via WebSocket if connected"""
    processing_status[task_id] = {
        "status": status,
        "progress": progress,
        "message": message,
        "timestamp": datetime.now().isoformat()
    }
    
    # Send WebSocket update if client is connected
    if task_id in websocket_connections:
        try:
            # Map backend status to frontend-friendly 'type'
            ws_type = (
                "complete" if status == "completed" else
                "error" if status == "error" else
                "progress"
            )

            payload = {
                "task_id": task_id,
                "status": status,
                "type": ws_type,
                "progress": progress,
                "message": message
            }

            # If we already computed a download url, include it
            result_url = processing_status.get(task_id, {}).get("result_url")
            if result_url:
                payload["download_url"] = result_url

            await websocket_connections[task_id].send_json(payload)
        except:
            # Client disconnected, remove from connections
            websocket_connections.pop(task_id, None)

def choose_demucs_config(stems: int, quality: str) -> Dict[str, str]:
    """Map a quality preset → (model, overlap, shifts) triple.

    Presets (4-stem reference times on a mid-range consumer GPU, 4-min track):

      fast      htdemucs       overlap 0.25  shifts 1   ~20-40s
      balanced  htdemucs_ft    overlap 0.25  shifts 2   ~1-3 min
      hq        htdemucs_ft    overlap 0.5   shifts 5   ~5-15 min

    The previous default (htdemucs_ft / overlap 0.9 / shifts 10) regularly
    took 20-40+ minutes per track on the same class of hardware while the UI
    sat at the now-removed fake-progress ceiling.

    Individual DEMUCS_* env vars still win over preset defaults so power
    users can override piece by piece.
    """
    q = (quality or "balanced").strip().lower()
    if q not in ("fast", "balanced", "hq"):
        q = "balanced"

    presets = {
        "fast": {"model_4": "htdemucs", "overlap": "0.25", "shifts": "1"},
        "balanced": {"model_4": "htdemucs_ft", "overlap": "0.25", "shifts": "2"},
        "hq": {"model_4": "htdemucs_ft", "overlap": "0.5", "shifts": "5"},
    }
    p = presets[q]

    cfg = {
        "model_2": os.environ.get("DEMUCS_MODEL_2", "mdx_extra"),
        "model_4": os.environ.get("DEMUCS_MODEL_4", p["model_4"]),
        "model_6": os.environ.get("DEMUCS_MODEL_6", "htdemucs_6s"),
        "overlap": os.environ.get("DEMUCS_OVERLAP", p["overlap"]),
        "shifts": os.environ.get("DEMUCS_SHIFTS", p["shifts"]),
        "clip_mode": "rescale",
        "quality": q,
    }
    return cfg

async def _demucs_elapsed_ticker(task_id: str, pinned_progress: int, tick_seconds: int = 5):
    """While Demucs runs, update the message with elapsed wall-clock time.

    Demucs doesn't expose machine-readable progress (its tqdm bar uses
    carriage-return overwrites that our line-buffered subprocess pipes
    don't capture). The earlier '_demucs_heartbeat' implementation faked
    a percentage that ticked from 20 → 59 over ~6.5 minutes and then
    sat at 59 for the entire actual run — every "stuck at 59%" report
    was that ceiling, not a real failure.

    This replacement keeps progress pinned at ``pinned_progress`` and
    only updates the message with elapsed time. Honest, and the UI can
    layer its own context (device, quality, stems) on top.
    """
    started = datetime.now()
    try:
        while True:
            await asyncio.sleep(tick_seconds)
            elapsed = (datetime.now() - started).total_seconds()
            mins = int(elapsed // 60)
            secs = int(elapsed % 60)
            await update_progress(
                task_id,
                pinned_progress,
                f"Running Demucs… elapsed {mins}m {secs:02d}s "
                f"(Demucs doesn't emit progress; tracking elapsed time only)"
            )
    except asyncio.CancelledError:
        return

async def run_demucs_async(input_file: Path, output_dir: Path, stems: int, device: str, task_id: str, quality: str) -> Path:
    """Run Demucs separation asynchronously and return the output directory path.
    Sends heartbeat progress updates and enforces a timeout to avoid hangs.
    """
    # Timeout for the whole demucs subprocess in seconds (default 45 min)
    timeout_sec = int(os.environ.get("DEMUCS_TIMEOUT_SEC", "2700"))
    
    # Resolve Python to run Demucs: prefer DEMUCS_PYTHON, else current environment python
    python_exe = os.environ.get("DEMUCS_PYTHON") or sys.executable

    # Preflight: detect CUDA availability in target interpreter; fall back to CPU if not available
    try:
        probe = await asyncio.create_subprocess_exec(
            python_exe, "-c", "import torch, json; print(json.dumps({'cuda': __import__('torch').cuda.is_available()}))",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        out, _ = await probe.communicate()
        if out:
            import json as _json
            cuda_ok = _json.loads(out.decode().strip()).get('cuda', False)
            if device == 'cuda' and not cuda_ok:
                print("[run_demucs_async] Target interpreter lacks CUDA; forcing device=cpu")
                device = 'cpu'
    except Exception:
        if device == 'cuda':
            print("[run_demucs_async] CUDA probe error; forcing device=cpu")
            device = 'cpu'

    # Create a unique output directory for this task to avoid conflicts
    task_output_dir = output_dir / f"task_{task_id}"
    task_output_dir.mkdir(parents=True, exist_ok=True)
    
    # Clean up any existing files in the task directory
    if task_output_dir.exists():
        print(f"Cleaning up existing task directory: {task_output_dir}")
        shutil.rmtree(task_output_dir, ignore_errors=True)
        task_output_dir.mkdir(parents=True, exist_ok=True)

    # Build command based on stem count
    print(f"[run_demucs_async] Building command for {stems} stems (type: {type(stems)}), quality={quality}")
    cfg = choose_demucs_config(stems, quality)
    model_2 = cfg["model_2"]
    model_4 = cfg["model_4"]
    model_6 = cfg["model_6"]
    overlap = cfg["overlap"]
    shifts = cfg["shifts"]

    if stems == 2:
        cmd = [
            python_exe, "-m", "demucs",
            "-n", model_2,
            "--two-stems", "vocals",
            "--clip-mode", cfg["clip_mode"],
            "--overlap", overlap,
            "--shifts", shifts,
            "-d", device,
            "-o", str(task_output_dir),
            str(input_file)
        ]
    elif stems == 4:
        cmd = [
            python_exe, "-m", "demucs",
            "-n", model_4,
            "--clip-mode", cfg["clip_mode"],
            "--overlap", overlap,
            "--shifts", shifts,
            "-d", device,
            "-o", str(task_output_dir),
            str(input_file)
        ]
    elif stems in [6, 12]:
        cmd = [
            python_exe, "-m", "demucs",
            "-n", model_6,
            "--clip-mode", cfg["clip_mode"],
            "--overlap", overlap,
            "--shifts", shifts,
            "-d", device,
            "-o", str(task_output_dir),
            str(input_file)
        ]
    else:
        raise ValueError(f"Unsupported stem count: {stems}")

    print(f"Running Demucs command: {' '.join(cmd)}")
    print(f"Task ID: {task_id}")
    print(f"Output directory: {task_output_dir}")

    # Environment to help avoid interactive hangs
    env = os.environ.copy()
    env.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    env.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    env.setdefault("PYTHONUNBUFFERED", "1")

    # Start subprocess with pipes
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env
    )

    # While demucs runs, pin progress at 20 and surface elapsed wall-clock
    # time in the message (Demucs itself emits no machine-readable progress).
    heartbeat = asyncio.create_task(_demucs_elapsed_ticker(task_id, 20, 5))

    # Read output concurrently and print for diagnostics
    async def _stream(pipe, prefix: str):
        try:
            while True:
                line = await pipe.readline()
                if not line:
                    break
                text = line.decode(errors='ignore').rstrip()
                if text:
                    print(f"[demucs:{prefix}] {text}")
        except Exception as e:
            print(f"[demucs:{prefix}] stream error: {e}")

    stream_out = asyncio.create_task(_stream(proc.stdout, 'out'))
    stream_err = asyncio.create_task(_stream(proc.stderr, 'err'))

    try:
        await asyncio.wait_for(proc.wait(), timeout=timeout_sec)
    except asyncio.TimeoutError:
        heartbeat.cancel()
        with contextlib.suppress(Exception):
            proc.kill()
        raise Exception(f"Demucs timed out after {timeout_sec} seconds")
    finally:
        # Ensure streams drained
        await asyncio.gather(stream_out, stream_err, return_exceptions=True)
        heartbeat.cancel()

    if proc.returncode != 0:
        raise Exception(f"Demucs failed with exit code {proc.returncode}")

    # Find the output directory that Demucs created
    if stems == 2:
        possible_dirs = ["mdx_extra", "mdx", "htdemucs"]
        model_dir = None
        for dir_name in possible_dirs:
            if (task_output_dir / dir_name).exists():
                model_dir = dir_name
                print(f"Found 2-stem model directory: {model_dir}")
                break
        if not model_dir:
            dirs = [d for d in task_output_dir.iterdir() if d.is_dir()]
            if dirs:
                model_dir = dirs[0].name
                print(f"Using first directory found for 2-stem: {model_dir}")
            else:
                print(f"No directories found in {task_output_dir}")
                raise Exception(f"No output directory found for 2-stem separation")
    elif stems == 4:
        # Use the actual model the command ran with (htdemucs for 'fast',
        # htdemucs_ft for 'balanced'/'hq') — demucs names the output folder
        # after the model, so hardcoding 'htdemucs' breaks the ft presets.
        model_dir = model_4
    else:
        model_dir = model_6

    print(f"Looking for model directory: {model_dir}")

    stem_dir: Optional[Path] = None
    model_path = task_output_dir / model_dir
    if not model_path.exists():
        # Robust fallback: demucs always produces exactly one model folder.
        # If the name guess is wrong, use whatever directory it created
        # rather than failing.
        dirs = [d for d in task_output_dir.iterdir() if d.is_dir()]
        if dirs:
            model_path = dirs[0]
            print(f"Name guess '{model_dir}' missing; using produced directory: {model_path.name}")
        else:
            print(f"Expected model path doesn't exist: {model_path}")
            print(f"Contents of {task_output_dir}:")
            for item in task_output_dir.iterdir():
                print(f"  - {item.name} (dir: {item.is_dir()})")
            raise Exception(f"Model directory '{model_dir}' not found in {task_output_dir}")

    for item in model_path.iterdir():
        if item.is_dir():
            stem_dir = item
            print(f"Found track directory: {stem_dir}")
            break

    if not stem_dir or not stem_dir.exists():
        raise Exception(f"Could not find track output directory in {model_path}")

    wav_files = list(stem_dir.glob("*.wav"))
    print(f"Found {len(wav_files)} WAV files in {stem_dir}:")
    for wav_file in wav_files:
        print(f"  - {wav_file.name}")

    expected_stems = stems if stems != 12 else 6
    if len(wav_files) != expected_stems:
        print(f"WARNING: Expected {expected_stems} stems but found {len(wav_files)}")
        print(f"Files found: {[f.name for f in wav_files]}")

    print(f"Demucs output directory: {stem_dir}")
    # Normalize 2-stem naming if needed (accompaniment -> no_vocals)
    if stems == 2:
        acc = stem_dir / 'accompaniment.wav'
        no_vocals = stem_dir / 'no_vocals.wav'
        if acc.exists() and not no_vocals.exists():
            try:
                acc.rename(no_vocals)
                print("[demucs] Renamed accompaniment.wav -> no_vocals.wav")
            except Exception as rn_err:
                print(f"[demucs] Rename failed: {rn_err}")
    return stem_dir

def run_demucs(input_file: Path, output_dir: Path, stems: int, device: str, task_id: str) -> Path:
    """Run Demucs separation and return the output directory path"""
    try:
        # Resolve Python to run Demucs: prefer DEMUCS_PYTHON, else current environment python
        python_exe = os.environ.get("DEMUCS_PYTHON") or sys.executable

        # Preflight: detect CUDA availability in target interpreter; fall back to CPU if not available
        try:
            probe = subprocess.run(
                [python_exe, "-c", "import torch, json; print(json.dumps({'cuda': torch.cuda.is_available()}))"],
                capture_output=True, text=True, check=False
            )
            if probe.returncode == 0:
                import json as _json
                cuda_ok = _json.loads(probe.stdout.strip()).get('cuda', False)
                if device == 'cuda' and not cuda_ok:
                    print("[run_demucs] Target interpreter lacks CUDA; forcing device=cpu")
                    device = 'cpu'
            else:
                if device == 'cuda':
                    print("[run_demucs] CUDA probe failed; forcing device=cpu")
                    device = 'cpu'
        except Exception:
            if device == 'cuda':
                print("[run_demucs] CUDA probe error; forcing device=cpu")
                device = 'cpu'
        
        # Create a unique output directory for this task to avoid conflicts
        task_output_dir = output_dir / f"task_{task_id}"
        task_output_dir.mkdir(parents=True, exist_ok=True)
        
        # Clean up any existing files in the task directory
        if task_output_dir.exists():
            print(f"Cleaning up existing task directory: {task_output_dir}")
            shutil.rmtree(task_output_dir, ignore_errors=True)
            task_output_dir.mkdir(parents=True, exist_ok=True)
        
        # Build command based on stem count
        print(f"[run_demucs] Building command for {stems} stems (type: {type(stems)})")
        print(f"[run_demucs] stems == 2: {stems == 2}")
        print(f"[run_demucs] stems == 4: {stems == 4}")
        print(f"[run_demucs] stems == 6: {stems == 6}")
        print(f"[run_demucs] stems in [6, 12]: {stems in [6, 12]}")
        
        if stems == 2:
            # 2-stem separation: vocals and no_vocals
            cmd = [
                python_exe, "-m", "demucs",
                "--two-stems", "vocals",
                "-d", device,
                "-o", str(task_output_dir),
                str(input_file)
            ]
        elif stems == 4:
            # 4-stem separation using htdemucs
            cmd = [
                python_exe, "-m", "demucs",
                "-n", "htdemucs",
                "-d", device,
                "-o", str(task_output_dir),
                str(input_file)
            ]
        elif stems in [6, 12]:
            # 6-stem separation using htdemucs_6s (also used as base for 12-stem)
            cmd = [
                python_exe, "-m", "demucs",
                "-n", "htdemucs_6s",
                "-d", device,
                "-o", str(task_output_dir),
                str(input_file)
            ]
        else:
            raise ValueError(f"Unsupported stem count: {stems}")
        
        print(f"Running Demucs command: {' '.join(cmd)}")
        print(f"Task ID: {task_id}")
        print(f"Output directory: {task_output_dir}")
        
        # Run demucs
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=False
        )
        
        if result.returncode != 0:
            print(f"Demucs error: {result.stderr}")
            raise Exception(f"Demucs failed: {result.stderr}")
        
        # Find the output directory that Demucs created
        # Demucs creates a subdirectory with the model name
        # For 2-stem, we need to check what directory is actually created
        if stems == 2:
            # 2-stem mode might create different directory names depending on the model
            # Let's check what was actually created
            possible_dirs = ["mdx_extra", "mdx", "htdemucs"]
            model_dir = None
            for dir_name in possible_dirs:
                if (task_output_dir / dir_name).exists():
                    model_dir = dir_name
                    print(f"Found 2-stem model directory: {model_dir}")
                    break
            
            if not model_dir:
                # If no expected directory found, use the first directory created
                dirs = [d for d in task_output_dir.iterdir() if d.is_dir()]
                if dirs:
                    model_dir = dirs[0].name
                    print(f"Using first directory found for 2-stem: {model_dir}")
                else:
                    print(f"No directories found in {task_output_dir}")
                    raise Exception(f"No output directory found for 2-stem separation")
        elif stems == 4:
            model_dir = "htdemucs"
        else:  # 6 or 12
            model_dir = "htdemucs_6s"
        
        print(f"Looking for model directory: {model_dir}")
        
        # Find the actual output folder (Demucs creates modelname/trackname/)
        stem_dir = None
        model_path = task_output_dir / model_dir
        
        if not model_path.exists():
            # List what directories were actually created
            print(f"Expected model path doesn't exist: {model_path}")
            print(f"Contents of {task_output_dir}:")
            for item in task_output_dir.iterdir():
                print(f"  - {item.name} (dir: {item.is_dir()})")
            raise Exception(f"Model directory '{model_dir}' not found in {task_output_dir}")
        
        # Find the subdirectory with the track name
        for item in model_path.iterdir():
            if item.is_dir():
                stem_dir = item
                print(f"Found track directory: {stem_dir}")
                break
        
        if not stem_dir or not stem_dir.exists():
            raise Exception(f"Could not find track output directory in {model_path}")
        
        # Verify we have the expected number of stem files
        wav_files = list(stem_dir.glob("*.wav"))
        print(f"Found {len(wav_files)} WAV files in {stem_dir}:")
        for wav_file in wav_files:
            print(f"  - {wav_file.name}")
        
        # Verify expected stem count
        expected_stems = stems
        if stems == 12:
            expected_stems = 6  # base stems before LARSNET
        
        if len(wav_files) != expected_stems:
            print(f"WARNING: Expected {expected_stems} stems but found {len(wav_files)}")
            print(f"Files found: {[f.name for f in wav_files]}")
            # Don't raise an error here, but log the discrepancy
            # Some models might produce slightly different outputs
            
        print(f"Demucs output directory: {stem_dir}")
        return stem_dir
        
    except Exception as e:
        print(f"Error running demucs: {e}")
        raise

def run_larsnet_separation(drums_file: Path, output_dir: Path) -> bool:
    """Run LARSNET for drum separation - splits drums into kick, snare, hihat, cymbals, toms"""
    try:
        # Ensure LARSNET models are present (extract from zip if necessary)
        def ensure_larsnet_models():
            base = Path(__file__).parent / "larsnet"
            models_dir = base / "pretrained_larsnet_models"
            zip_path = base / "pretrained_larsnet_models.zip"
            # Basic check: expect at least one .pth file if installed
            if models_dir.exists() and any(models_dir.rglob("*.pth")):
                print(f"[LARSNET] Found pretrained models under {models_dir}")
                return
            if zip_path.exists():
                print(f"[LARSNET] Extracting pretrained models from {zip_path}...")
                with zipfile.ZipFile(zip_path, 'r') as zf:
                    zf.extractall(base)
                print("[LARSNET] Extraction complete")
            else:
                print("[LARSNET] WARNING: pretrained models zip not found; LARSNET may fail")

        ensure_larsnet_models()

        # Import LARSNET modules
        from larsnet.larsnet import LarsNet
        
        # Initialize LARSNET with config
        config_path = Path(__file__).parent / "larsnet" / "config.yaml"
        print(f"Loading LARSNET with config: {config_path}")
        
        larsnet = LarsNet(
            wiener_filter=False,
            device="cpu",  # Use CPU for stability
            config=str(config_path)
        )
        
        # Process drums file
        print(f"Processing drums file: {drums_file}")
        stems = larsnet(str(drums_file))
        
        # Save separated drum stems directly in the output directory
        # This will create kick.wav, snare.wav, hihat.wav, cymbals.wav, toms.wav
        import soundfile as sf
        for stem_name, waveform in stems.items():
            save_path = output_dir / f"{stem_name}.wav"
            print(f"Saving drum stem: {save_path}")
            
            # Convert tensor to numpy array and transpose for soundfile
            audio_data = waveform.cpu().numpy()
            if audio_data.ndim == 2:
                audio_data = audio_data.T  # Transpose to (samples, channels)
            # Normalize to avoid clipping/distortion
            try:
                peak = float(np.max(np.abs(audio_data)))
                if peak > 1e-6:
                    gain = min(1.0, 0.98 / peak)
                    audio_data = (audio_data * gain).astype(audio_data.dtype, copy=False)
            except Exception as norm_err:
                print(f"[LARSNET] normalization skipped: {norm_err}")
            
            sf.write(save_path, audio_data, larsnet.sr, subtype='FLOAT')
        
        # Remove the original drums.wav file since we've replaced it with separated drums
        if drums_file.exists():
            drums_file.unlink()
            print(f"Removed original drums.wav file")
        
        return True
    except Exception as e:
        print(f"Error running LARSNET: {e}")
        print(f"Keeping original drums.wav file")
        return False  # Return False to indicate LARSNET failed

def f0_harmonic_mask_lead_back(vocals_wav: Path, out_dir: Path, use_gpu: bool, log_cb=print, sr_target=44100):
    """
    Split vocals into lead/back using torchcrepe F0-driven harmonic masks.
    This is SUPERIOR to mid-side processing - uses pitch tracking for accurate separation.
    From MultiStemSplitter_FULL custom stemmer.
    """
    try:
        y, sr = librosa.load(str(vocals_wav), sr=sr_target, mono=True)
        if np.max(np.abs(y)) < 1e-5:
            sf.write(out_dir / "vocals_lead.wav", y, sr_target)
            sf.write(out_dir / "vocals_back.wav", np.zeros_like(y), sr_target)
            log_cb("[F0 Vocal Split] Empty vocals, skipping")
            return True

        device = "cuda:0" if (use_gpu and torch.cuda.is_available()) else "cpu"
        hop_length = 512
        fmin, fmax = 80.0, 1100.0

        log_cb(f"[F0 Vocal Split] Tracking pitch on {device}...")
        audio_t = torch.tensor(y, dtype=torch.float32, device=device).unsqueeze(0)
        pitch, periodicity = torchcrepe.predict(
            audio_t, sr_target, hop_length, fmin, fmax, model="full",
            batch_size=1024, device=device, return_periodicity=True
        )
        pitch = torchcrepe.filter.median(pitch, 3).squeeze(0).detach().cpu().numpy()
        periodicity = torchcrepe.filter.median(periodicity, 3).squeeze(0).detach().cpu().numpy()

        n_fft = 2048
        S = librosa.stft(y, n_fft=n_fft, hop_length=hop_length, window="hann")
        mag = np.abs(S)
        phase = np.angle(S)
        freqs = librosa.fft_frequencies(sr=sr_target, n_fft=n_fft)
        mask = np.zeros_like(mag, dtype=np.float32)
        max_harm = 12

        for t in range(mag.shape[1]):
            f0 = pitch[t]
            conf = periodicity[t]
            if not np.isfinite(f0) or f0 <= 0 or conf < 0.2:
                continue
            for k in range(1, max_harm + 1):
                target = k * f0
                if target >= freqs[-1]:
                    break
                sigma = max(30.0, 0.06 * target)
                mask[:, t] += np.exp(-0.5 * ((freqs - target) / sigma) ** 2)

        mask = mask / (mask.max(axis=0, keepdims=True) + 1e-8)
        mask = mask ** 0.8
        S_lead = (mag * mask) * np.exp(1j * phase)
        S_back = (mag * (1.0 - mask)) * np.exp(1j * phase)
        lead = librosa.istft(S_lead, hop_length=hop_length, window="hann", length=len(y))
        back = librosa.istft(S_back, hop_length=hop_length, window="hann", length=len(y))

        sf.write(out_dir / "vocals_lead.wav", lead, sr_target)
        sf.write(out_dir / "vocals_back.wav", back, sr_target)
        log_cb("[F0 Vocal Split] Wrote vocals_lead.wav, vocals_back.wav using F0 harmonic masking")
        return True
    except Exception as e:
        log_cb(f"[F0 Vocal Split] Error: {e}")
        return False

def split_vocals_midside(vocals_path: Path, out_dir: Path) -> bool:
    """DEPRECATED: Old mid-side processing method. Use f0_harmonic_mask_lead_back instead.
    Produces vocals_lead.wav (center) and vocals_backing.wav (residual)."""
    try:
        if not vocals_path.exists():
            print(f"[split_vocals_midside] vocals file not found: {vocals_path}")
            return False
        audio, sr = sf.read(str(vocals_path))
        if audio.ndim == 1:
            mid = audio
            side = np.zeros_like(audio)
        else:
            L = audio[:, 0]
            R = audio[:, 1]
            mid = 0.5 * (L + R)
            side = 0.5 * (L - R)
        lead_stereo = np.stack([mid, mid], axis=-1)
        backing_stereo = np.stack([mid - side, mid + side], axis=-1)
        # Normalize to avoid clipping
        def norm(x):
            m = np.max(np.abs(x))
            return x if m == 0 else x / m * 0.95
        lead_stereo = norm(lead_stereo)
        backing_stereo = norm(backing_stereo)
        sf.write(str(out_dir / 'vocals_lead.wav'), lead_stereo, sr)
        sf.write(str(out_dir / 'vocals_backing.wav'), backing_stereo, sr)
        print("[split_vocals_midside] wrote vocals_lead.wav and vocals_backing.wav")
        return True
    except Exception as e:
        print(f"[split_vocals_midside] error: {e}")
        return False

async def process_audio_separation(
    task_id: str,
    file_path: Path,
    stems: int,
    device: str,
    split_vocals: bool = False,
    quality: str = "hq"
):
    """Process audio separation in background"""
    try:
        print(f"[process_audio_separation] Called with stems={stems} (type: {type(stems)})")
        await update_progress(task_id, 0, "Starting separation process...")
        
        # Create temporary directory for processing
        temp_dir = Path(tempfile.mkdtemp())
        output_dir = temp_dir / "separated"
        output_dir.mkdir(exist_ok=True)
        
        # Run Demucs separation based on stem count
        if stems == 2:
            await update_progress(task_id, 20, "Running 2-stem vocal separation...")
            stem_dir = await run_demucs_async(file_path, output_dir, stems, device, task_id, quality)
            
        elif stems == 4:
            await update_progress(task_id, 20, "Running 4-stem separation (vocals, bass, drums, other)...")
            stem_dir = await run_demucs_async(file_path, output_dir, stems, device, task_id, quality)
            
        elif stems == 6:
            await update_progress(task_id, 20, "Running 6-stem separation (vocals, bass, drums, other, guitar, piano)...")
            stem_dir = await run_demucs_async(file_path, output_dir, stems, device, task_id, quality)
            
        elif stems == 12:
            # First run 6-stem separation
            await update_progress(task_id, 20, "Running 6-stem separation as base...")
            stem_dir = await run_demucs_async(file_path, output_dir, stems, device, task_id, quality)
            
            # Then run LARSNET on drums to get 5 additional drum stems
            await update_progress(task_id, 60, "Separating drum components with LARSNET (kick, snare, hihat, cymbals, toms)...")
            
            drums_file = stem_dir / "drums.wav"
            print(f"[12-stem] Looking for drums file at: {drums_file}")
            print(f"[12-stem] Drums file exists: {drums_file.exists()}")
            
            if drums_file.exists():
                print(f"[12-stem] Starting LARSNET separation on {drums_file}")
                before = set(f.name for f in stem_dir.glob('*.wav'))
                success = run_larsnet_separation(drums_file, stem_dir)
                after = set(f.name for f in stem_dir.glob('*.wav'))
                added = list(sorted(after - before))
                if not success or len(added) == 0:
                    print("[12-stem] LARSNET failed or produced no files; keeping original drums if present")
                else:
                    print(f"[12-stem] LARSNET created files: {added}")
            else:
                print(f"[12-stem] ERROR: Drums file not found at {drums_file}")
                print(f"[12-stem] Available files in {stem_dir}:")
                for f in stem_dir.glob("*.wav"):
                    print(f"  - {f.name}")
        else:
            raise ValueError(f"Unsupported stem count: {stems}")
        
        # Optional: split vocals into lead/backing via F0-guided harmonic masking
        if split_vocals:
            try:
                vocals_file = stem_dir / 'vocals.wav'
                if vocals_file.exists():
                    await update_progress(task_id, 75, "Splitting vocals (lead/backing) via F0 pitch tracking...")
                    use_gpu = (device == "cuda")
                    f0_harmonic_mask_lead_back(vocals_file, stem_dir, use_gpu, print)
            except Exception as e:
                print(f"[process] vocals split skipped: {e}")

        await update_progress(task_id, 80, "Creating ZIP archive...")

        # Create ZIP file with all stems from the actual stem directory
        zip_path = temp_dir / f"stems_{task_id}.zip"
        try:
            print(f"[zip] Creating zip at: {zip_path}")
            with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
                wavs = list(stem_dir.glob("*.wav"))
                print(f"[zip] Found {len(wavs)} wav(s) to add")
                for wav_file in wavs:
                    arcname = wav_file.name
                    zipf.write(wav_file, arcname)
                    print(f"[zip] Added: {arcname}")
            print("[zip] Zip creation complete")
        except Exception as ze:
            print(f"[zip] Error creating zip: {ze}")
            raise

        # Move ZIP to static location (atomic replace)
        results_dir = Path(__file__).parent / "results"
        results_dir.mkdir(exist_ok=True)
        final_zip = results_dir / f"stems_{task_id}.zip"
        try:
            if final_zip.exists():
                print(f"[zip] Removing existing zip at destination: {final_zip}")
                final_zip.unlink()
            # shutil.move (not os.replace) so cross-drive moves work on Windows:
            # tempfile.mkdtemp() lands on the system temp drive, which may
            # differ from the install drive, and MoveFileEx (used by
            # os.replace) refuses cross-drive renames with WinError 17.
            shutil.move(str(zip_path), str(final_zip))
            print(f"[zip] Moved zip to: {final_zip}")
            if not final_zip.exists() or final_zip.stat().st_size == 0:
                raise Exception("Final zip file missing or empty after move")
        except Exception as me:
            print(f"[zip] Error moving zip to results: {me}")
            raise

        # Persist individual stem WAVs for on-demand access by desktop app
        stems_out_dir = results_dir / "tasks" / task_id
        try:
            stems_out_dir.mkdir(parents=True, exist_ok=True)
            copied = []
            for wav_file in stem_dir.glob("*.wav"):
                dest = stems_out_dir / wav_file.name
                shutil.copy2(wav_file, dest)
                copied.append(wav_file.name)
            print(f"[stems] Copied {len(copied)} wav(s) to {stems_out_dir}: {copied}")
        except Exception as ce:
            print(f"[stems] Failed to persist individual stems: {ce}")

        # Update status and include result URL for WS clients
        processing_status[task_id]["result_url"] = f"/download/{task_id}"
        processing_status[task_id]["stems_url"] = f"/stems/{task_id}"
        await update_progress(task_id, 100, "Processing complete!", "completed")
        
        # Cleanup temp files
        shutil.rmtree(temp_dir, ignore_errors=True)
        if file_path.exists():
            file_path.unlink()
        
    except Exception as e:
        # ADDED FOR DETAILED LOGGING
        import traceback
        log_dir = Path(__file__).parent / "logs"
        log_dir.mkdir(exist_ok=True)
        error_log_file = log_dir / "detailed_error.log"
        
        error_details = (
            f"--- DETAILED ERROR REPORT ---\n"
            f"Timestamp: {datetime.now().isoformat()}\n"
            f"Task ID: {task_id}\n"
            f"File Path: {file_path}\n"
            f"Stems: {stems}\n"
            f"Device: {device}\n"
            f"Exception Type: {type(e).__name__}\n"
            f"Error Message: {str(e)}\n"
            f"Traceback:\n{traceback.format_exc()}\n"
            f"--- END REPORT ---\n\n"
        )
        
        with open(error_log_file, "a") as f:
            f.write(error_details)
        # END DETAILED LOGGING
        
        print(f"Error in processing: {e}. See detailed_error.log for more info.")
        await update_progress(task_id, 0, f"Error: {str(e)}", "error")
        processing_status[task_id]["error"] = str(e)

# API Endpoints
@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "name": "Stem Separator API",
        "version": "1.0.0",
        "device": get_device(),
        "endpoints": {
            "health": "/health",
            "upload": "/upload",
            "status": "/status/{task_id}",
            "download": "/download/{task_id}",
            "websocket": "/ws/{task_id}"
        }
    }

@app.get("/health")
async def health():
    """Health check endpoint"""
    return {"status": "healthy"}

@app.post("/upload")
async def upload_audio(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    stems: int = Query(default=4, description="Number of stems (2, 4, 6, or 12)"),
    device: Optional[str] = Query(default=None, description="Device to use (cpu, cuda, mps)"),
    split_vocals: bool = Query(default=False, description="If true, also output vocals_lead/backing via mid-side"),
    quality: str = Query(default="balanced", description="Quality preset: fast | balanced | hq")
):
    """Upload audio file for stem separation"""
    
    # Log the received stems parameter
    print(f"[/upload] RECEIVED REQUEST - stems parameter: {stems} (type: {type(stems)})")
    print(f"[/upload] Full params - stems: {stems}, device: {device}, file: {file.filename}")
    
    # Validate stems parameter
    if stems not in [2, 4, 6, 12]:
        print(f"[/upload] Invalid stems value: {stems}")
        raise HTTPException(status_code=400, detail="Stems must be 2, 4, 6, or 12")
    
    # Validate file type. Anything ffmpeg/demucs can decode is fair game;
    # the library holds Opus (YouTube/SoundCloud imports), WebM, AAC, etc.
    allowed_extensions = [
        '.mp3', '.wav', '.flac', '.m4a', '.ogg',
        '.opus', '.oga', '.webm', '.aac', '.aiff', '.aif', '.wma',
    ]
    file_ext = Path(file.filename).suffix.lower()
    if file_ext not in allowed_extensions:
        raise HTTPException(
            status_code=400,
            detail=f"File type {file_ext} not supported. Allowed: {', '.join(allowed_extensions)}"
        )
    
    # Generate task ID
    task_id = str(uuid.uuid4())
    
    # Save uploaded file
    temp_dir = Path(tempfile.mkdtemp())
    file_path = temp_dir / file.filename
    
    try:
        # Save file in chunks for large files
        with open(file_path, "wb") as f:
            while content := await file.read(1024 * 1024):  # Read 1MB chunks
                f.write(content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save file: {str(e)}")
    
    # Determine device. 'auto' (and an empty/unknown value) means let the
    # sidecar pick the best available device (CUDA if present, else CPU).
    if device is None or device.strip().lower() in ("auto", ""):
        device = get_device()
    # Normalize quality to the accepted preset names; choose_demucs_config
    # will fall back to 'balanced' for anything unrecognized.
    quality = (quality or "balanced").strip().lower()
    if quality not in ("fast", "balanced", "hq"):
        quality = "balanced"
    
    # Initialize status
    processing_status[task_id] = {
        "status": "queued",
        "progress": 0,
        "message": "Processing queued",
        "timestamp": datetime.now().isoformat()
    }
    
    # Start background processing
    background_tasks.add_task(process_audio_separation, task_id, file_path, stems, device, split_vocals, quality)
    
    return JSONResponse(content={
        "task_id": task_id,
        "status": "queued",
        "message": f"Processing {stems}-stem separation on {device} ({quality})"
    })

@app.get("/status/{task_id}")
async def get_status(task_id: str):
    """Get processing status"""
    if task_id not in processing_status:
        raise HTTPException(status_code=404, detail="Task not found")
    
    return ProcessingStatus(
        task_id=task_id,
        **processing_status[task_id]
    )

@app.get("/download/{task_id}")
async def download_result(task_id: str):
    """Download processed stems"""
    if task_id not in processing_status:
        raise HTTPException(status_code=404, detail="Task not found")
    
    if processing_status[task_id]["status"] != "completed":
        raise HTTPException(status_code=400, detail="Processing not completed")
    
    results_dir = Path(__file__).parent / "results"
    zip_file = results_dir / f"stems_{task_id}.zip"
    
    if not zip_file.exists():
        raise HTTPException(status_code=404, detail="Result file not found")
    
    return FileResponse(
        path=zip_file,
        media_type="application/zip",
        filename=f"stems_{task_id}.zip"
    )

@app.get("/stems/{task_id}")
async def list_stems(task_id: str):
    """List individual stem files for a task. Gracefully handles missing status."""
    # Prefer status, but do not hard fail if missing
    status = processing_status.get(task_id)
    if status and status.get("status") != "completed":
        raise HTTPException(status_code=400, detail="Processing not completed")

    results_dir = Path(__file__).parent / "results" / "tasks" / task_id
    if not results_dir.exists():
        return {"files": []}
    files = []
    for f in results_dir.glob("*.wav"):
        files.append({
            "name": f.name,
            "size": f.stat().st_size,
            "url": f"/stems/{task_id}/{f.name}"
        })
    # Return sorted names for consistent UI
    files.sort(key=lambda x: x["name"]) 
    return {"files": files}

@app.get("/stems/{task_id}/{filename}")
async def get_stem_file(task_id: str, filename: str):
    """Serve a single stem WAV for a task."""
    # basic sanitization
    if "/" in filename or ".." in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    if task_id not in processing_status:
        raise HTTPException(status_code=404, detail="Task not found")
    if processing_status[task_id]["status"] != "completed":
        raise HTTPException(status_code=400, detail="Processing not completed")

    results_dir = Path(__file__).parent / "results" / "tasks" / task_id
    file_path = results_dir / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Stem not found")
    return FileResponse(path=file_path, media_type="audio/wav", filename=filename)

@app.websocket("/ws/{task_id}")
async def websocket_endpoint(websocket: WebSocket, task_id: str):
    """WebSocket for real-time progress updates"""
    await websocket.accept()
    websocket_connections[task_id] = websocket
    
    try:
        # Send current status if exists
        if task_id in processing_status:
            await websocket.send_json({
                "task_id": task_id,
                **processing_status[task_id]
            })
        
        # Keep connection alive
        while True:
            try:
                # Wait for any message from client (ping/pong)
                data = await asyncio.wait_for(websocket.receive_text(), timeout=30)
                
                # Echo back as heartbeat
                await websocket.send_text("pong")
                
            except asyncio.TimeoutError:
                # Send heartbeat
                await websocket.send_text("ping")
                
    except WebSocketDisconnect:
        websocket_connections.pop(task_id, None)
    except Exception as e:
        print(f"WebSocket error: {e}")
        websocket_connections.pop(task_id, None)

@app.on_event("startup")
async def startup_event():
    """Initialize application on startup"""
    # Create results directory
    results_dir = Path(__file__).parent / "results"
    results_dir.mkdir(exist_ok=True)
    
    # Check for CUDA
    if torch.cuda.is_available():
        print(f"CUDA available: {torch.cuda.get_device_name(0)}")
    else:
        print("CUDA not available, using CPU")
    
    print(f"Stem Separator API started on device: {get_device()}")

@app.on_event("shutdown")
async def shutdown_event():
    """Cleanup on shutdown"""
    # Close all WebSocket connections
    for ws in websocket_connections.values():
        try:
            await ws.close()
        except:
            pass
    
    # Clean up old result files (older than 1 hour)
    results_dir = Path(__file__).parent / "results"
    if results_dir.exists():
        for file in results_dir.glob("*.zip"):
            try:
                if (datetime.now() - datetime.fromtimestamp(file.stat().st_mtime)).seconds > 3600:
                    file.unlink()
            except:
                pass

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
