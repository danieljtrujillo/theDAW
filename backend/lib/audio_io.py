"""Audio in and out, float-native, without torchcodec.

torchaudio >= 2.9 decodes and encodes through torchcodec, which loads FFmpeg's
SHARED libraries at import time — on Windows the "full-shared" build, which no
ordinary ffmpeg install carries (the winget / gyan "essentials" and "full"
builds are static). The moment torchaudio moved to 2.11 every
``torchaudio.load`` / ``save`` in the app raised "Could not load libtorchcodec"
on the dev box, and would on every user's machine. Its ``save`` had also
stopped honouring ``encoding`` / ``bits_per_sample``, so a float export came
back requantized — the exact loss backend/lib/audio_depth.py exists to prevent.

libsndfile 1.2 reads and writes everything the app produces — WAV at every
depth including float, FLAC, OGG Vorbis and Opus, MP3, AIFF, W64, CAF — and
does it without clamping, which is what the tool paths already rely on. The
containers it cannot open (m4a/aac, webm, anything with a video track) go
through the ffmpeg CLI the app already requires, decoded to a float WAV in a
temp file. Nothing here touches torchcodec; torchaudio stays for its
transforms (resample, spectrograms) and nothing else.
"""

from __future__ import annotations

import io
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np
import soundfile as sf

if TYPE_CHECKING:
    import torch

_SF_FORMAT = {
    "wav": "WAV",
    "wave": "WAV",
    "flac": "FLAC",
    "ogg": "OGG",
    "oga": "OGG",
    "opus": "OGG",
    "mp3": "MP3",
    "aiff": "AIFF",
    "aif": "AIFF",
    "w64": "W64",
    "caf": "CAF",
}


def save_subtype(fmt: str, wav_bit_depth: str) -> str | None:
    """The libsndfile subtype for a generated file at the requested depth.

    PCM_16 stays the default: it halves the on-disk footprint at no perceptible
    cost on generative audio, and every finished job also carries its audio
    base64-encoded in the JOBS dict until it is pruned, so the depth is paid
    for twice. ``32f`` is the escape hatch for output going straight back into
    a float session — the Edit timeline, a VST chain, the Chimera stack — where
    every requantization along the way compounds.

    FLAC is lossless but never float, so a wide request lands there at 24.
    OGG is Vorbis and has no PCM word length to set at all.
    """
    fmt = fmt.lower()
    if fmt == "wav":
        return {"32f": "FLOAT", "24": "PCM_24"}.get(wav_bit_depth, "PCM_16")
    if fmt == "flac":
        return "PCM_24" if wav_bit_depth in ("24", "32f") else "PCM_16"
    if fmt in ("ogg", "oga"):
        return "VORBIS"
    return None


def save_audio(
    dst: str | Path | io.IOBase,
    audio: Any,
    samplerate: int,
    *,
    format: str | None = None,
    subtype: str | None = None,
) -> str | None:
    """Write ``audio`` — a torch tensor or ndarray shaped (channels, frames) —
    to a path or a file-like object. Returns the subtype actually used.

    Fixed-point subtypes get the -1..1 clip (int PCM wraps rather than
    saturates on overflow); float subtypes do not, because a peak above 0 dBFS
    surviving is the whole point of asking for float.
    """
    data = _frames_by_channels(audio)
    fmt = _format_of(dst, format)
    if subtype is None:
        subtype = save_subtype(fmt, "16")
    if subtype not in ("FLOAT", "DOUBLE"):
        data = np.clip(data, -1.0, 1.0)
    target = str(dst) if isinstance(dst, (str, Path)) else dst
    sf.write(
        target,
        data,
        int(samplerate),
        format=_SF_FORMAT.get(fmt, fmt.upper()),
        subtype=subtype,
    )
    return subtype


def load_audio_array(
    src: str | Path | bytes | bytearray | io.IOBase, *, format: str | None = None
) -> tuple[np.ndarray, int]:
    """Decode a path, bytes, or file-like to (float32 array [channels, frames], samplerate).

    libsndfile first; the ffmpeg CLI for anything it cannot open. Never clamps.
    """
    handle: Any = io.BytesIO(src) if isinstance(src, (bytes, bytearray)) else src
    try:
        data, sr = sf.read(
            handle, dtype="float32", always_2d=True, format=_sf_hint(format)
        )
    except Exception as exc:  # noqa: BLE001 — libsndfile raises several types; the fallback decides
        if hasattr(handle, "seek"):
            handle.seek(0)
        data, sr = _read_via_ffmpeg(src, exc)
    return np.ascontiguousarray(data.T, dtype=np.float32), int(sr)


def load_audio(
    src: str | Path | bytes | bytearray | io.IOBase, *, format: str | None = None
) -> tuple["torch.Tensor", int]:
    """``load_audio_array`` as a torch tensor [channels, frames] — the shape
    ``torchaudio.load`` returned, so call sites swap one name for another."""
    import torch

    data, sr = load_audio_array(src, format=format)
    return torch.from_numpy(data), sr


# ---------------------------------------------------------------- internals


def _frames_by_channels(audio: Any) -> np.ndarray:
    if hasattr(audio, "detach"):  # torch tensor, on any device
        audio = audio.detach().cpu().float().numpy()
    arr = np.asarray(audio, dtype=np.float32)
    if arr.ndim == 1:
        arr = arr[None, :]
    if arr.ndim != 2:
        raise ValueError(f"audio must be (channels, frames), got shape {arr.shape}")
    return np.ascontiguousarray(arr.T)


def _format_of(dst: Any, fmt: str | None) -> str:
    if fmt:
        return fmt.lower().lstrip(".")
    if isinstance(dst, (str, Path)):
        return Path(dst).suffix.lower().lstrip(".") or "wav"
    raise ValueError("format= is required when writing to a file-like object")


def _sf_hint(fmt: str | None) -> str | None:
    if not fmt:
        return None
    return _SF_FORMAT.get(fmt.lower().lstrip("."), fmt.upper())


def _read_via_ffmpeg(src: Any, cause: Exception) -> tuple[np.ndarray, int]:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError(
            f"libsndfile could not open the audio ({cause}) and ffmpeg is not on PATH"
        ) from cause
    tmp = Path(tempfile.mkdtemp(prefix="thedaw-audio-"))
    try:
        if isinstance(src, (str, Path)):
            in_path = Path(src)
        else:
            in_path = tmp / "in.bin"
            payload = bytes(src) if isinstance(src, (bytes, bytearray)) else src.read()
            in_path.write_bytes(payload)
        out_path = tmp / "out.wav"
        # stdin=DEVNULL: the backend does not always own a console, and an
        # inherited handle makes ffmpeg's console reader block forever.
        proc = subprocess.run(
            [
                ffmpeg,
                "-y",
                "-v",
                "error",
                "-i",
                str(in_path),
                "-vn",
                "-f",
                "wav",
                "-c:a",
                "pcm_f32le",
                str(out_path),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=600,
            check=False,
        )
        if proc.returncode != 0:
            tail = proc.stderr.decode("utf-8", errors="replace")[-500:]
            raise RuntimeError(f"ffmpeg could not decode the audio: {tail}") from cause
        # The SoundFile object, not sf.read: a decoded float WAV is exactly the
        # thing libsndfile reads, whatever made the first attempt fail.
        with sf.SoundFile(str(out_path)) as f:
            return f.read(dtype="float32", always_2d=True), int(f.samplerate)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
