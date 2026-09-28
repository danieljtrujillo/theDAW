"""Shared analysis / metering helpers — used by mastering, delivery, restoration.

Loudness + true-peak come from FFmpeg's EBU-R128 ``loudnorm`` (accurate, includes
oversampled true-peak); spectrum + stereo metrics come from numpy on the decoded
samples. ``pyloudnorm`` is used as a pure-Python cross-check when available.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Optional

from . import ffmpeg, ffmpeg_tools


# loudnorm's own documented AVOption ranges (`ffmpeg -h filter=loudnorm`):
# measured_I -99..0, measured_LRA 0..99, measured_TP -99..99,
# measured_thresh -99..0, offset -99..99. These five are the only AVOptions
# every caller (delivery/router.py, mastering/router.py) feeds a second-pass
# loudnorm from this dict (as measured_I=/measured_LRA=/measured_TP=/
# measured_thresh=/offset=) — output_i/output_tp/output_lra/output_thresh/
# normalization_type are informational only and never fed back, so they need
# no clamp. A pathological input can push any of the five out of range —
# e.g. a full-scale square wave reports measured_I above 0 LUFS, and
# DIGITAL SILENCE reports target_offset as "inf" (there is no finite gain
# that reaches a target loudness from -inf LUFS). Feeding either straight
# back into a second-pass loudnorm as `measured_I=`/`offset=` is out of
# loudnorm's own accepted range and fails with "Result too large" — a 500
# that had nothing to do with the actual audio content.
_LOUDNORM_RANGES: dict[str, tuple[float, float]] = {
    "input_i": (-99.0, 0.0),
    "input_lra": (0.0, 99.0),
    "input_tp": (-99.0, 99.0),
    "input_thresh": (-99.0, 0.0),
    "target_offset": (-99.0, 99.0),
}


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


async def measure_loudness(
    path: Path,
    target_i: float = -14.0,
    target_lra: float = 7.0,
    target_tp: float = -1.0,
) -> dict:
    """First-pass EBU-R128 measurement via ffmpeg loudnorm (print_format=json).

    Returns the measured values needed for a transparent second pass:
    ``input_i, input_lra, input_tp, input_thresh, target_offset``. The four
    ``input_*`` values are clamped to loudnorm's own documented AVOption
    ranges before being returned, so a caller feeding them straight back in
    as ``measured_*=`` for a second pass never hands loudnorm a value it
    would itself reject.
    """
    cmd = [
        await ffmpeg_tools.ffmpeg_exe_async(),
        "-i",
        str(path),
        "-af",
        f"loudnorm=I={target_i}:LRA={target_lra}:TP={target_tp}:print_format=json",
        "-f",
        "null",
        "-",
    ]
    stderr = await ffmpeg.run(cmd, timeout=300)
    m = re.search(r"\{[^{}]*\"input_i\"[\s\S]*?\}", stderr)
    if not m:
        raise RuntimeError("loudnorm JSON not found in ffmpeg output")
    data = json.loads(m.group())
    result = {k: _f(v) for k, v in data.items()}
    for key, (lo, hi) in _LOUDNORM_RANGES.items():
        value = result.get(key)
        if isinstance(value, (int, float)):
            result[key] = _clamp(float(value), lo, hi)
    return result


async def verify_true_peak(path: Path, max_tp: float) -> tuple[bool, float]:
    """Re-measure an encoded file and check its true-peak vs a ceiling.

    Used by Smart Export's post-encode verification: lossy codecs can introduce
    inter-sample peaks above the limiter ceiling. Returns (passed, measured_tp).
    """
    stats = await measure_loudness(path)
    tp = stats.get("input_tp", 0.0)
    return (tp <= max_tp, tp)


def _read_audio_guarded(path: Path, **kwargs):
    """``sf.read`` with an ffmpeg-decode fallback for the containers libsndfile
    cannot open -- m4a/aac/wma, which the app accepts and which regularly
    arrive with a ``.wav`` extension. Mirrors ``mastering/router.py``'s
    ``_guarded_sf_read``; without it Match-EQ raises ``LibsndfileError`` before
    its own guarded read is ever reached."""
    import soundfile as sf

    try:
        return sf.read(str(path), **kwargs)
    except Exception:
        import subprocess
        import tempfile

        from backend.lib.launch_token import child_env

        with tempfile.TemporaryDirectory() as tmp:
            decoded = Path(tmp) / "decoded.wav"
            try:
                subprocess.run(
                    [
                        ffmpeg_tools.ffmpeg_exe(),
                        "-y",
                        "-i",
                        str(path),
                        "-c:a",
                        "pcm_f32le",
                        str(decoded),
                    ],
                    check=True,
                    capture_output=True,
                    stdin=subprocess.DEVNULL,
                    timeout=600.0,
                    env=child_env(),
                )
            except subprocess.CalledProcessError as e:
                stderr = (e.stderr or b"").decode("utf-8", errors="replace")
                raise ffmpeg.FFmpegError(e.returncode or -1, stderr) from e
            return sf.read(str(decoded), **kwargs)


def decoded_frame_count(path: Path) -> int | None:
    """Exact decoded sample count via ffprobe's per-frame ``nb_samples``,
    summed across the audio stream — the actual number of samples the
    decoder produces, unlike ``duration * sample_rate`` (container duration
    excludes encoder priming/padding, e.g. AAC's encoder delay, so that
    product silently disagrees with the real decode by hundreds of samples).

    Shared by ``enhance/router.py`` and ``restoration/router.py`` (both
    previously carried byte-for-byte duplicate copies of this helper; moved
    here so a future fix lands once instead of needing to be re-applied to
    both families).

    Returns ``None`` (never raises) if ffprobe is missing, the probe fails,
    or a frame's ``nb_samples`` can't be parsed — callers fall back to the
    duration-based estimate in that case.
    """
    import subprocess

    from backend.lib.launch_token import child_env
    from backend.modules.analysis.ffprobe import has_ffprobe

    if not has_ffprobe():
        return None
    try:
        result = subprocess.run(
            [
                ffmpeg_tools.ffprobe_exe(),
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "frame=nb_samples",
                "-of",
                "csv=p=0",
                str(path),
            ],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60.0,
            stdin=subprocess.DEVNULL,
            env=child_env(),
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError, ValueError):
        return None
    if result.returncode != 0 or not result.stdout:
        return None
    total = 0
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            total += int(line)
        except ValueError:
            return None
    return total


def compute_spectrum(path: Path, n_fft: int = 4096, bands: int = 256) -> dict:
    """Average magnitude spectrum (log-spaced) for analyzer / Match-EQ display."""
    import numpy as np

    audio, sr = _read_audio_guarded(path, always_2d=True)
    mono = audio.mean(axis=1)
    if mono.size < n_fft:
        mono = np.pad(mono, (0, n_fft - mono.size))
    hop = n_fft // 2
    win = np.hanning(n_fft)
    acc = np.zeros(n_fft // 2 + 1)
    frames = 0
    for i in range(0, mono.size - n_fft, hop):
        spec = np.abs(np.fft.rfft(mono[i : i + n_fft] * win))
        acc += spec
        frames += 1
    if frames:
        acc /= frames
    freqs = np.fft.rfftfreq(n_fft, 1 / sr)
    mag_db = 20 * np.log10(acc + 1e-9)
    # resample to log-spaced bands
    lo, hi = 20.0, min(sr / 2, 20000.0)
    log_f = np.logspace(np.log10(lo), np.log10(hi), bands)
    out_db = np.interp(log_f, freqs, mag_db)
    return {"sr": int(sr), "freqs": log_f.tolist(), "mag_db": out_db.tolist()}


def compute_stereo_metrics(path: Path) -> dict:
    """Stereo correlation, width and balance for the imager / goniometer."""
    import numpy as np

    audio, _ = _read_audio_guarded(path, always_2d=True)
    if audio.shape[1] < 2:
        return {"correlation": 1.0, "width": 0.0, "balance": 0.0, "mono": True}
    left, right = audio[:, 0], audio[:, 1]
    denom = (np.std(left) * np.std(right)) or 1e-9
    corr = float(np.mean((left - left.mean()) * (right - right.mean())) / denom)
    mid = (left + right) / 2
    side = (left - right) / 2
    width = float(np.sqrt(np.mean(side**2)) / (np.sqrt(np.mean(mid**2)) + 1e-9))
    balance = float(np.sqrt(np.mean(right**2)) - np.sqrt(np.mean(left**2)))
    return {"correlation": corr, "width": width, "balance": balance, "mono": False}


def _f(v) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return v
