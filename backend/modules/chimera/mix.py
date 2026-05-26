"""Mix N pre-stretched audio clips into a single output WAV.

Currently implements start-aligned mixing: every clip starts at t=0 of the
output. Downbeat alignment and Phrase Weave layer on top of this primitive
by passing pre-trimmed inputs (the alignment work happens before mix).

Inputs MUST be at `out_sr` already — the caller (router) is responsible for
sample-rate normalization, typically as part of the stretch step.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import TypedDict

import numpy as np
import soundfile as sf

log = logging.getLogger(__name__)


TARGET_RMS = 0.15
PEAK_CEILING = 0.99


class MixResult(TypedDict):
    output_path: str
    sample_rate: int
    duration_sec: float
    num_clips: int
    peak: float
    rms: float


def _to_stereo_f32(audio: np.ndarray) -> np.ndarray:
    arr = np.asarray(audio, dtype=np.float32)
    if arr.ndim == 1:
        arr = np.stack([arr, arr], axis=1)
    elif arr.ndim == 2 and arr.shape[1] == 1:
        arr = np.repeat(arr, 2, axis=1)
    elif arr.ndim == 2 and arr.shape[1] > 2:
        arr = arr[:, :2]
    return arr


def _loop_to_length(stereo: np.ndarray, target_samples: int) -> np.ndarray:
    """Tile a clip to a target sample count. Used so short clips don't go silent
    inside a longer mix window."""
    if stereo.shape[0] >= target_samples or stereo.shape[0] == 0:
        return stereo[:target_samples] if stereo.shape[0] >= target_samples else stereo
    reps = (target_samples // stereo.shape[0]) + 1
    tiled = np.tile(stereo, (reps, 1))
    return tiled[:target_samples]


def _apply_fade(
    stereo: np.ndarray, fade_in_samples: int, fade_out_samples: int
) -> None:
    """Apply linear fade-in / fade-out envelopes in-place."""
    n = stereo.shape[0]
    if fade_in_samples > 0:
        k = min(fade_in_samples, n)
        env = np.linspace(0.0, 1.0, k, dtype=np.float32)[:, None]
        stereo[:k] *= env
    if fade_out_samples > 0:
        k = min(fade_out_samples, n)
        env = np.linspace(1.0, 0.0, k, dtype=np.float32)[:, None]
        stereo[n - k :] *= env


def mix_clips(
    clip_paths: list[str | Path],
    weights: list[float],
    output_path: str | Path,
    out_sr: int = 44100,
    clip_windows: list[tuple[float, float] | None] | None = None,
    mix_offsets_sec: list[float] | None = None,
    loop_to_sec: list[float | None] | None = None,
    chunk_fade_sec: float = 0.0,
    master_fade_in_sec: float = 0.0,
    master_fade_out_sec: float = 0.0,
) -> MixResult:
    """Mix N clips into a single output.

    Parameters
    ----------
    clip_windows[i] : (start_sec, end_sec) or None
        Slice clip i before mixing. None = full clip.
    mix_offsets_sec[i] : float
        Where clip i lands on the output timeline. Default 0 for all.
    loop_to_sec[i] : float or None
        After windowing, loop clip i (np.tile) to reach this duration. Used
        when a clip is shorter than its assigned slot in the arrangement, so
        the slot doesn't go silent. None = no looping.
    """
    n_clips = len(clip_paths)
    if n_clips == 0:
        raise ValueError("mix_clips: need at least one clip")
    if len(weights) != n_clips:
        raise ValueError(
            f"mix_clips: weights length {len(weights)} != clip_paths length {n_clips}"
        )
    if clip_windows is not None and len(clip_windows) != n_clips:
        raise ValueError(
            f"mix_clips: clip_windows length {len(clip_windows)} != clip_paths length {n_clips}"
        )
    if mix_offsets_sec is not None and len(mix_offsets_sec) != n_clips:
        raise ValueError(
            f"mix_clips: mix_offsets_sec length {len(mix_offsets_sec)} != clip_paths length {n_clips}"
        )
    if loop_to_sec is not None and len(loop_to_sec) != n_clips:
        raise ValueError(
            f"mix_clips: loop_to_sec length {len(loop_to_sec)} != clip_paths length {n_clips}"
        )

    windows = clip_windows if clip_windows is not None else [None] * n_clips
    offsets = mix_offsets_sec if mix_offsets_sec is not None else [0.0] * n_clips
    loops = loop_to_sec if loop_to_sec is not None else [None] * n_clips

    loaded: list[tuple[np.ndarray, float, int]] = []  # (stereo, weight, offset_samples)
    max_end = 0
    for path, weight, window, offset_sec, loop_sec in zip(
        clip_paths, weights, windows, offsets, loops
    ):
        audio, sr = sf.read(str(path), dtype="float32", always_2d=False)
        if sr != out_sr:
            raise ValueError(
                f"mix_clips: clip {path} has sr={sr}, expected {out_sr}. "
                "Caller must normalize sample rate before mixing."
            )
        stereo = _to_stereo_f32(audio)
        if window is not None:
            start_sec, end_sec = window
            n = stereo.shape[0]
            start_sample = max(0, min(n, int(start_sec * out_sr)))
            end_sample = max(start_sample, min(n, int(end_sec * out_sr)))
            stereo = stereo[start_sample:end_sample]
        if loop_sec is not None and loop_sec > 0:
            target = int(loop_sec * out_sr)
            stereo = _loop_to_length(stereo, target)
        if chunk_fade_sec > 0 and stereo.shape[0] > 0:
            stereo = stereo.copy()
            fade_samples = int(chunk_fade_sec * out_sr)
            _apply_fade(stereo, fade_samples, fade_samples)
        offset_samples = max(0, int(offset_sec * out_sr))
        loaded.append((stereo, float(weight), offset_samples))
        end = offset_samples + stereo.shape[0]
        if end > max_end:
            max_end = end

    max_len = max_end
    out = np.zeros((max_len, 2), dtype=np.float32)
    for stereo, weight, offset_samples in loaded:
        n = stereo.shape[0]
        out[offset_samples : offset_samples + n] += stereo * weight

    rms = float(np.sqrt(np.mean(out * out))) if out.size else 0.0
    if rms > 1e-9:
        gain = TARGET_RMS / rms
        peak = float(np.max(np.abs(out * gain)))
        if peak > PEAK_CEILING:
            gain *= PEAK_CEILING / peak
        out = out * gain

    if master_fade_in_sec > 0 or master_fade_out_sec > 0:
        _apply_fade(
            out,
            int(master_fade_in_sec * out_sr),
            int(master_fade_out_sec * out_sr),
        )

    final_peak = float(np.max(np.abs(out))) if out.size else 0.0
    final_rms = float(np.sqrt(np.mean(out * out))) if out.size else 0.0

    # PCM_16 instead of 32-bit FLOAT — halves the file size with no audible
    # difference for init audio (the diffusion model re-encodes through its
    # autoencoder anyway). 16-bit headroom is plenty after the RMS normalize
    # and peak ceiling above.
    sf.write(str(output_path), out, out_sr, subtype="PCM_16")

    return {
        "output_path": str(output_path),
        "sample_rate": out_sr,
        "duration_sec": max_len / out_sr,
        "num_clips": len(loaded),
        "peak": final_peak,
        "rms": final_rms,
    }
