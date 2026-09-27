"""Put the original audio back around an inpainted region.

The Stable Audio 3 inpaint path hands the model the mask and the masked audio
as conditioning only. The sampler starts from noise and returns its own
rendering of the whole window, the kept parts included: they come back close
to the original, never equal to it, and each region edge lands wherever the
model blended. ``composite_inpaint`` restores the original outside every
regenerated run and crossfades each edge that borders kept audio with an
equal-power ramp laid inside the run. Every sample outside the regenerated
runs is the original's sample.

The output is in the generation's domain: its sample rate, its channel count
and its length. A generation longer than the original keeps its extra tail
(nothing of the original exists there to restore); a shorter one is never
padded. An original at another rate is resampled to the generation's rate
with torchaudio's resample, the transform ``pipeline.generate`` applies to the
inpaint upload before the model sees it, so the kept samples are the ones the
model was conditioned on. The EDIT inpaint sends 44.1 kHz, the model's own
rate, and nothing is resampled on that path.

Pure numpy apart from that resample; torch is imported only when the rates
differ. Tested in tests/test_inpaint_composite.py.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# The model applies the mask on the latent grid: 4096x downsampling at 44.1 kHz
# is ~93 ms per latent frame, so its own blend at a region edge spans about one
# frame. A feather shorter than that crossfades inside audio the model already
# smeared; 0.10 s covers it.
DEFAULT_FEATHER_SEC = 0.10
MAX_FEATHER_SEC = 0.5

# The loudness match is a correction, never a mix decision: a region repainted
# on purpose to be quieter or louder keeps most of that change.
MAX_LOUDNESS_GAIN_DB = 6.0
# Below this RMS a region is silence, and a ratio against it means nothing.
_SILENCE_RMS = 1e-5


@dataclass(frozen=True)
class CompositeOptions:
    """How an opted-in inpaint is composited (see composite_inpaint)."""

    feather_sec: float = DEFAULT_FEATHER_SEC
    match_loudness: bool = True


def keep_mask_from_seconds(
    length: int, sample_rate: int, start_sec: float, end_sec: float
) -> np.ndarray:
    """A keep mask (1 = original, 0 = regenerated) for one region, rounded
    the way ``pipeline.generate`` rounds ``inpaint_mask_*_seconds``."""
    mask = np.ones(max(0, int(length)), dtype=np.float32)
    a = min(max(int(start_sec * sample_rate), 0), mask.size)
    b = min(max(int(end_sec * sample_rate), 0), mask.size)
    if b > a:
        mask[a:b] = 0.0
    return mask


def regenerated_runs(regenerated: np.ndarray) -> list[tuple[int, int]]:
    """``[start, end)`` of every contiguous True run in a boolean array."""
    if regenerated.size == 0:
        return []
    padded = np.concatenate(([False], regenerated.astype(bool), [False]))
    edges = np.flatnonzero(padded[1:] != padded[:-1])
    return [(int(a), int(b)) for a, b in zip(edges[::2], edges[1::2])]


def _regenerated(keep_mask: np.ndarray, length: int, original_len: int) -> np.ndarray:
    """Which of ``length`` output samples come from the generation. The mask is
    cut or extended (as kept) to the output's length, and everything past the
    original's end is generated: there is no original there."""
    keep = np.ones(length, dtype=bool)
    m = np.asarray(keep_mask).reshape(-1)[:length]
    keep[: m.size] = m >= 0.5
    regen = ~keep
    regen[min(original_len, length) :] = True
    return regen


def _feathers(a: int, b: int, original_len: int, feather: int) -> tuple[int, int]:
    """Crossfade length at the start and at the end of the run ``[a, b)``.

    Each edge is decided on its own. An edge has a seam only where kept
    original audio borders it: the start when ``0 < a < original_len``, the
    end when ``b < original_len``. The ramp lies inside the run, so it also
    needs original audio under it to fade out of. When both edges have seams
    they share the run; one seam alone may use all of it.
    """
    length = b - a
    start = 0 < a < original_len
    end = b < original_len
    limit = length // 2 if (start and end) else length
    fs = min(feather, limit, original_len - a) if start else 0
    fe = min(feather, limit) if end else 0
    return max(0, fs), max(0, fe)


def blend_weights(
    keep_mask: np.ndarray, length: int, original_len: int, feather: int
) -> np.ndarray:
    """The generation's weight per output sample: 0 where the original is
    kept, 1 in the body of each regenerated run, and an equal-power ramp
    (``sin`` in, ``cos`` out) over each edge that borders kept audio. The
    original's weight is ``sqrt(1 - w**2)``, so the two always sum to unit power.
    """
    regen = _regenerated(keep_mask, length, original_len)
    # float64: in float32 the last samples of a long ramp round to exactly 1.0
    # and the ramp would end a few samples early.
    w = regen.astype(np.float64)
    for a, b in regenerated_runs(regen):
        fs, fe = _feathers(a, b, original_len, feather)
        if fs > 0:
            t = (np.arange(fs, dtype=np.float64) + 0.5) / fs
            w[a : a + fs] = np.sin(t * np.pi / 2.0)
        if fe > 0:
            t = (np.arange(fe, dtype=np.float64) + 0.5) / fe
            w[b - fe : b] = np.cos(t * np.pi / 2.0)
    return w


def _resample(audio: np.ndarray, from_rate: int, to_rate: int) -> np.ndarray:
    import torch
    import torchaudio

    out = torchaudio.functional.resample(
        torch.from_numpy(np.ascontiguousarray(audio, dtype=np.float32)),
        int(from_rate),
        int(to_rate),
    )
    return out.numpy().astype(np.float32, copy=False)


def _match_channels(original: np.ndarray, channels: int) -> np.ndarray:
    """The original with the generation's channel count. A mono original is
    copied to every channel, so each channel outside the region is the
    original sample itself."""
    have = original.shape[0]
    if have == channels:
        return original
    if have == 1:
        return np.repeat(original, channels, axis=0)
    if channels == 1:
        return original.mean(axis=0, keepdims=True, dtype=np.float32)
    if have > channels:
        return original[:channels]
    extra = np.repeat(original[-1:], channels - have, axis=0)
    return np.concatenate([original, extra], axis=0)


def _loudness_gain(original: np.ndarray, generated: np.ndarray) -> float:
    orig_rms = float(np.sqrt(np.mean(np.square(original, dtype=np.float64))))
    gen_rms = float(np.sqrt(np.mean(np.square(generated, dtype=np.float64))))
    if orig_rms < _SILENCE_RMS or gen_rms < _SILENCE_RMS:
        return 1.0
    limit = 10.0 ** (MAX_LOUDNESS_GAIN_DB / 20.0)
    return float(np.clip(orig_rms / gen_rms, 1.0 / limit, limit))


def composite_inpaint(
    original: np.ndarray,
    generated: np.ndarray,
    sample_rate: int,
    keep_mask: np.ndarray,
    *,
    original_sample_rate: int | None = None,
    feather_sec: float = DEFAULT_FEATHER_SEC,
    match_loudness: bool = True,
) -> np.ndarray:
    """Restore ``original`` outside the regenerated runs of ``keep_mask``.

    Args:
        original: ``(channels, samples)`` float, the audio sent to the model.
        generated: ``(channels, samples)`` float, the model's output.
        sample_rate: the generation's rate; the output and ``keep_mask`` use it.
        keep_mask: per sample of the generation, 1 = keep the original and
            0 = regenerated. Shorter masks keep the rest; longer ones are cut.
        original_sample_rate: the original's rate when it differs.
        feather_sec: crossfade length at each edge that borders kept audio,
            laid inside the run; clamped to 0..MAX_FEATHER_SEC.
        match_loudness: scale the generation in each run to the original's
            RMS over that run, clamped to +/-MAX_LOUDNESS_GAIN_DB, and skipped
            when either side is silent.

    Returns:
        ``(channels, n)`` float32 with the generation's channel count and
        length. Outside the regenerated runs, and within the original's length,
        every sample equals the original's (after resampling when the rates
        differ). Nothing is clipped: a float output keeps its peaks, and a
        fixed-point save clips on write.
    """
    generated = np.asarray(generated, dtype=np.float32)
    if generated.ndim == 1:
        generated = generated[None, :]
    original = np.asarray(original, dtype=np.float32)
    if original.ndim == 1:
        original = original[None, :]
    if original_sample_rate is not None and int(original_sample_rate) != int(
        sample_rate
    ):
        original = _resample(original, int(original_sample_rate), int(sample_rate))
    original = _match_channels(original, generated.shape[0])

    length = generated.shape[-1]
    n = min(original.shape[-1], length)
    feather = int(
        round(min(max(float(feather_sec), 0.0), MAX_FEATHER_SEC) * sample_rate)
    )
    w = blend_weights(keep_mask, length, n, feather)
    regen = w > 0.0

    source = generated
    if match_loudness:
        source = generated.copy()
        for a, b in regenerated_runs(regen):
            # Measured where both exist; a run wholly past the original's end
            # has nothing to match.
            if min(b, n) > a:
                gain = _loudness_gain(
                    original[:, a : min(b, n)], generated[:, a : min(b, n)]
                )
                if gain != 1.0:
                    source[:, a:b] *= np.float32(gain)

    # Assemble without arithmetic on the kept samples: they are copied, so they
    # stay exactly the original's.
    out = source.copy()
    kept = ~regen[:n]
    out[:, :n][:, kept] = original[:, :n][:, kept]
    ramp = regen[:n] & (w[:n] < 1.0)
    if ramp.any():
        wg = w[:n][ramp]
        wo = np.sqrt(np.maximum(0.0, 1.0 - np.square(wg)))
        out[:, :n][:, ramp] = (
            original[:, :n][:, ramp] * wo + source[:, :n][:, ramp] * wg
        )
    return out
