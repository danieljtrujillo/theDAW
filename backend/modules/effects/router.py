import asyncio
import json
import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

router = APIRouter()

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


def _build_filter(effect: str, params: dict[str, float], output_format: str = "wav") -> list[str]:
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
            f"loudnorm=I={lufs}:LRA=7:TP=-1"
        )
        # pcm_s24le is only valid in WAV containers; let FFmpeg pick the right
        # codec for every other format (mp3 → libmp3lame, aac → aac, etc.)
        if output_format == "wav":
            return ["-af", af, "-c:a", "pcm_s24le"]
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
        # Strip leading silence only: remove 1 silence period from the start,
        # requiring at least 0.1 s of silence before trimming.
        return ["-af", f"silenceremove=start_periods=1:start_duration=0.1:start_threshold={thresh}dB"]

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


@router.post("/process")
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
        filter_args = _build_filter(effect, validated, output_format)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    mime_types = {
        "wav": "audio/wav",
        "flac": "audio/flac",
        "ogg": "audio/ogg",
        "mp3": "audio/mpeg",
        "aac": "audio/aac",
        "opus": "audio/opus",
    }

    tmp_dir = tempfile.mkdtemp(prefix="studio_")
    try:
        input_path = Path(tmp_dir) / "input.wav"
        output_ext = output_format if output_format != "ogg" else "ogg"
        output_path = Path(tmp_dir) / f"output.{output_ext}"

        # Stream the upload to disk in 1 MB chunks — no full-file memory copy.
        with open(input_path, "wb") as f:
            while chunk := await audio.read(1 << 20):
                f.write(chunk)

        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(input_path),
            *filter_args,
            str(output_path),
        ]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=600)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise HTTPException(status_code=504, detail="FFmpeg timed out after 600s")

        if proc.returncode != 0:
            err = (stderr or b"").decode("utf-8", errors="replace")
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise HTTPException(
                status_code=500,
                detail=f"FFmpeg error: {err[-500:] if err else 'unknown error'}",
            )

        if not output_path.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise HTTPException(status_code=500, detail="FFmpeg produced no output")

        # Read the entire output into memory so the temp dir can be cleaned
        # immediately.  This avoids Vite-proxy streaming issues where
        # FileResponse's chunked pipe breaks mid-transfer for large files,
        # causing net::ERR_FAILED in the browser.
        output_bytes = output_path.read_bytes()
        shutil.rmtree(tmp_dir, ignore_errors=True)

        return Response(
            content=output_bytes,
            media_type=mime_types.get(output_format, "audio/wav"),
            headers={
                "Content-Disposition": f'attachment; filename="processed.{output_ext}"',
            },
        )
    except HTTPException:
        raise
    except Exception:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise
