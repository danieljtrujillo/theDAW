"""Musical key detection via chroma + Krumhansl-Schmuckler profiles.

Pure librosa — no extra deps. Cheap enough to run on every imported /
generated track. Returns the most likely key (24 candidates: 12 major +
12 minor) and a correlation confidence in ``[0, 1]``.

Reference: Krumhansl, C. L. (1990). Cognitive Foundations of Musical
Pitch. The profiles below are the canonical major / minor key profiles
from that work.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

# The chroma analysis range: librosa.feature.chroma_cqt's own default, seven
# octaves C1..C8 at 36 bins per octave. Audio sampled below about 8.4 kHz has
# its Nyquist frequency under C8's filters, so there the range stops at the
# last octave librosa accepts (C1..C7 at 8 kHz). A clip too short for that is
# analysed with the plan ``chroma_plan`` fits to it.
_FULL_BINS_PER_OCTAVE = 36
# The short-clip resolution: one bin per semitone. Its filters are a third as
# long, so a clip of 0.75 s already holds all seven octaves. On short clips of
# I-IV-V-I progressions (0.4-2 s, all twelve keys) it named the key 60 times
# out of 60, where 36 bins over the octaves that fit named it 48 times.
_SHORT_BINS_PER_OCTAVE = 12
_FULL_OCTAVES = 7
_C1_HZ = 32.70319566257483  # librosa.note_to_hz("C1")
# Below three octaves (C5..C8) the chroma holds too little of the music for a
# key to mean anything; such a clip reports no key.
MIN_CHROMA_OCTAVES = 3
# librosa.estimate_tuning's default FFT size (piptrack's n_fft). A clip shorter
# than one such frame is analysed at A440 instead of estimating its tuning.
_TUNING_FFT = 2048


@dataclass(frozen=True)
class _OctaveFrame:
    """One octave of librosa's CQT: its FFT size, the length of the signal it
    runs on, and how many times that signal was halved to get there."""

    n_fft: int
    length: int
    halvings: int


def _two_factors(x: int) -> int:
    count = 0
    while x > 0 and x % 2 == 0:
        count += 1
        x //= 2
    return count


def _octave_frames(
    n_samples: int,
    sr: float,
    hop_length: int,
    bins_per_octave: int,
    n_octaves: int,
    fmin: float,
) -> Optional[list[_OctaveFrame]]:
    """The octaves ``librosa.cqt`` computes for this signal, top octave first.

    A replay of librosa.core.constantq.vqt without the transform. The filter
    lengths come from ``librosa.filters.wavelet_lengths``, so the Q is
    librosa's own (``filter_scale / alpha``, ``alpha = (r**2 - 1) / (r**2 +
    1)``). Each octave's FFT is its longest filter rounded up to a power of
    two. The signal is halved where vqt halves it: the early downsampling
    before the first octave, and between octaves while the hop is even and the
    next octave's top bin is at most a fifth of the rate; a halved signal is
    ``ceil(n / 2)`` long (librosa.resample). ``fmin`` is the tuned bottom
    frequency, the one vqt computes from the tuning. None when librosa would
    refuse the range (its top filter reaches past Nyquist).
    """
    import librosa
    import numpy as np

    n_bins = bins_per_octave * n_octaves
    freqs = librosa.interval_frequencies(
        n_bins=n_bins,
        fmin=fmin,
        intervals="equal",
        bins_per_octave=bins_per_octave,
        sort=True,
    )
    _lengths, cutoff = librosa.filters.wavelet_lengths(freqs=freqs, sr=sr)
    nyquist = sr / 2.0
    if cutoff > nyquist:
        return None
    # constantq.__early_downsample_count
    count1 = max(0, int(np.ceil(np.log2(nyquist / cutoff)) - 1) - 1)
    count2 = max(0, _two_factors(hop_length) - n_octaves + 1)
    halvings = min(count1, count2)
    my_sr = sr / 2.0**halvings
    my_hop = hop_length // 2**halvings
    length = n_samples
    for _ in range(halvings):
        length = math.ceil(length / 2)
    frames: list[_OctaveFrame] = []
    for i in range(n_octaves):
        hi = n_bins - bins_per_octave * i
        lo = hi - bins_per_octave
        lengths, _cut = librosa.filters.wavelet_lengths(freqs=freqs[lo:hi], sr=my_sr)
        n_fft = int(2.0 ** np.ceil(np.log2(float(np.max(lengths)))))
        frames.append(_OctaveFrame(n_fft=n_fft, length=length, halvings=halvings))
        if i < n_octaves - 1 and my_hop % 2 == 0 and freqs[lo - 1] <= my_sr / 5:
            my_hop //= 2
            my_sr /= 2.0
            length = math.ceil(length / 2)
            halvings += 1
    return frames


def _octaves_under_nyquist(sr: float, bins_per_octave: int, tuning: float) -> int:
    """How many octaves up from C1, at most seven, librosa's CQT accepts at
    ``sr``: the most whose top filter's cutoff (``wavelet_lengths``, at the
    tuned bottom frequency) is at or below Nyquist. Seven from about 8.4 kHz;
    six (C1..C7) at 8 kHz. 0 when not even one octave fits."""
    import librosa

    fmin = _C1_HZ * 2.0 ** (tuning / bins_per_octave)
    nyquist = sr / 2.0
    for octaves in range(_FULL_OCTAVES, 0, -1):
        freqs = librosa.interval_frequencies(
            n_bins=bins_per_octave * octaves,
            fmin=fmin,
            intervals="equal",
            bins_per_octave=bins_per_octave,
            sort=True,
        )
        _lengths, cutoff = librosa.filters.wavelet_lengths(freqs=freqs, sr=sr)
        if cutoff <= nyquist:
            return octaves
    return 0


def _fits(frames: Optional[list[_OctaveFrame]]) -> bool:
    """Whether every octave's FFT fits the signal it runs on (librosa.stft
    zero-pads a longer frame and warns)."""
    return frames is not None and all(f.n_fft <= f.length for f in frames)


def _needed_length(frames: Optional[list[_OctaveFrame]]) -> float:
    """The clip length at which every octave of ``frames`` is filled."""
    if not frames:
        return math.inf
    return float(max(f.n_fft * 2**f.halvings for f in frames))


def _tuning(y, sr: float, bins_per_octave: int) -> float:
    """The clip's tuning in fractions of a bin, estimated the way chroma_cqt
    estimates it (``librosa.estimate_tuning`` at the plan's resolution). A clip
    shorter than one estimator frame is taken at A440."""
    if int(y.shape[-1]) < _TUNING_FFT:
        return 0.0
    import librosa

    return float(librosa.estimate_tuning(y=y, sr=sr, bins_per_octave=bins_per_octave))


@dataclass(frozen=True)
class ChromaPlan:
    """The ``librosa.feature.chroma_cqt`` parameters for one clip (see
    :func:`chroma_plan`), and how much of the full analysis it covers."""

    bins_per_octave: int
    n_octaves: int
    fmin: float
    # The clip's tuning at this resolution, handed to chroma_cqt so the plan
    # and the transform use the same tuned bottom frequency.
    tuning: float
    coverage: float


def chroma_plan(y, sr: float, hop_length: int = 512) -> ChromaPlan:
    """The chroma parameters that fit the mono clip ``y`` at ``sr``.

    The full plan (36 bins per octave from C1, librosa's default) whenever the
    clip holds it, from about 3 s. It covers the seven octaves C1..C8 from a
    rate of about 8.4 kHz; below that it stops at the last octave whose top
    filter is under Nyquist (:func:`_octaves_under_nyquist`; C1..C7 at 8 kHz),
    since librosa refuses a range that reaches past it. A shorter clip gets
    one bin per semitone over as many octaves as fit it, counted down from
    that same top. A plan fits when no octave's FFT is longer than the signal
    that octave runs on, replayed with librosa's own filter lengths
    (:func:`_octave_frames`) at the tuning the transform will use and the hop
    the caller passes to chroma_cqt.

    ``coverage`` is the clip's length over the length the full plan needs,
    capped at 1, and scales the reported confidence: a short clip has heard
    less of the music, whatever its resolution.
    """
    n_samples = int(y.shape[-1])
    tuning = _tuning(y, sr, _FULL_BINS_PER_OCTAVE)
    top = _octaves_under_nyquist(sr, _FULL_BINS_PER_OCTAVE, tuning)
    full = (
        _octave_frames(
            n_samples,
            sr,
            hop_length,
            _FULL_BINS_PER_OCTAVE,
            top,
            _C1_HZ * 2.0 ** (tuning / _FULL_BINS_PER_OCTAVE),
        )
        if top
        else None
    )
    if _fits(full):
        return ChromaPlan(_FULL_BINS_PER_OCTAVE, top, _C1_HZ, tuning, 1.0)
    coverage = min(1.0, n_samples / _needed_length(full))
    bins = _SHORT_BINS_PER_OCTAVE
    tuning = _tuning(y, sr, bins)
    top = _octaves_under_nyquist(sr, bins, tuning)
    for octaves in range(top, MIN_CHROMA_OCTAVES - 1, -1):
        fmin = _C1_HZ * 2.0 ** (top - octaves)
        frames = _octave_frames(
            n_samples, sr, hop_length, bins, octaves, fmin * 2.0 ** (tuning / bins)
        )
        if _fits(frames):
            return ChromaPlan(bins, octaves, fmin, tuning, coverage)
    return ChromaPlan(bins, 0, _C1_HZ * 2.0**top, tuning, coverage)


# Krumhansl-Schmuckler key profiles. Index 0 = C.
_MAJOR_PROFILE = (
    6.35,
    2.23,
    3.48,
    2.33,
    4.38,
    4.09,
    2.52,
    5.19,
    2.39,
    3.66,
    2.29,
    2.88,
)
_MINOR_PROFILE = (
    6.33,
    2.68,
    3.52,
    5.38,
    2.60,
    3.53,
    2.54,
    4.75,
    3.98,
    2.69,
    3.34,
    3.17,
)
_NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")


def _correlate(chroma_mean: list[float], profile: tuple[float, ...]) -> list[float]:
    """Compute Pearson correlation of the chroma vector against all 12
    rotations of ``profile``. Returns 12 correlations (one per tonic)."""
    import statistics

    chroma_mean = list(chroma_mean)
    if len(chroma_mean) != 12:
        return [0.0] * 12

    mean_x = statistics.fmean(chroma_mean)
    out: list[float] = []
    for rotation in range(12):
        rotated = profile[-rotation:] + profile[:-rotation]
        mean_y = statistics.fmean(rotated)
        num = sum((x - mean_x) * (y - mean_y) for x, y in zip(chroma_mean, rotated))
        denom_x = sum((x - mean_x) ** 2 for x in chroma_mean) ** 0.5
        denom_y = sum((y - mean_y) ** 2 for y in rotated) ** 0.5
        if denom_x == 0 or denom_y == 0:
            out.append(0.0)
        else:
            out.append(num / (denom_x * denom_y))
    return out


def key_profile_scores(chroma_mean: list[float]) -> tuple[list[float], list[float]]:
    """Correlate a 12-bin mean chroma against all 24 Krumhansl-Schmuckler keys.

    Returns ``(major, minor)``: two 12-element lists of Pearson correlations,
    index 0 = C. Pure Python, importable without librosa.
    """
    chroma_mean = [float(c) for c in chroma_mean]
    return (
        _correlate(chroma_mean, _MAJOR_PROFILE),
        _correlate(chroma_mean, _MINOR_PROFILE),
    )


def detect_key(
    audio_path: Path,
    *,
    # y_sr carries a pre-decoded librosa.load(path, sr=22050, mono=True) result so callers can share one decode.
    y_sr: Optional[tuple] = None,
    # chroma_cqt hop length. 512 is librosa's default (library analysis keeps
    # it); chimera passes 2048 for a ~8x speedup on multi-minute clips.
    chroma_hop: int = 512,
) -> dict[str, Optional[float] | Optional[str]]:
    """Return ``{key, scale, confidence, strength}`` for the audio file.

    ``confidence`` is the winning key's profile correlation in ``[-1, 1]``;
    ``strength`` is that correlation minus the mean of all 24 correlations
    (how much the winner stands out — near 0 means atonal / ambiguous).

    A clip shorter than the full C1..C8 analysis needs (about 3 s) is analysed
    at one bin per semitone over the octaves it fills (all seven from about
    0.75 s), and both numbers are scaled by the clip's share of the 3 s, so a
    short clip reports a low confidence. A clip too short for three octaves
    (under about 46 ms at 22.05 kHz) reports no key. Audio handed in at a rate
    under about 8.4 kHz (``y_sr`` at a file's own rate) is analysed up to the
    last octave below its Nyquist frequency, C7 at 8 kHz.

    On failure (no librosa, unreadable file, silent input) returns
    ``{"key": None, "scale": None, "confidence": None, "strength": None}``.
    """
    out: dict[str, Optional[float] | Optional[str]] = {
        "key": None,
        "scale": None,
        "confidence": None,
        "strength": None,
    }
    try:
        import librosa
    except ImportError:
        return out

    p = Path(audio_path)
    if not p.is_file():
        return out

    if y_sr is not None:
        y, sr = y_sr
    else:
        try:
            y, sr = librosa.load(str(p), sr=22050, mono=True)
        except Exception as e:
            log.info("analysis.key: librosa load failed for %s: %s", p.name, e)
            return out

    if y.size == 0 or not y.any():
        # Silence has no key, and gives the tuning estimate nothing to read.
        return out
    plan = chroma_plan(y, float(sr), int(chroma_hop))
    if plan.n_octaves < MIN_CHROMA_OCTAVES:
        return out

    try:
        chroma = librosa.feature.chroma_cqt(
            y=y,
            sr=sr,
            hop_length=int(chroma_hop),
            fmin=plan.fmin,
            n_octaves=plan.n_octaves,
            bins_per_octave=plan.bins_per_octave,
            tuning=plan.tuning,
        )
    except Exception as e:
        log.info("analysis.key: chroma_cqt failed for %s: %s", p.name, e)
        return out

    chroma_mean = [float(c) for c in chroma.mean(axis=1)]

    major_corr, minor_corr = key_profile_scores(chroma_mean)

    best_major_idx = max(range(12), key=lambda i: major_corr[i])
    best_minor_idx = max(range(12), key=lambda i: minor_corr[i])

    if major_corr[best_major_idx] >= minor_corr[best_minor_idx]:
        out["key"] = _NOTE_NAMES[best_major_idx]
        out["scale"] = "major"
        best = float(major_corr[best_major_idx])
    else:
        out["key"] = _NOTE_NAMES[best_minor_idx]
        out["scale"] = "minor"
        best = float(minor_corr[best_minor_idx])

    all_corr = major_corr + minor_corr
    mean_corr = sum(all_corr) / len(all_corr)
    out["confidence"] = best * plan.coverage
    out["strength"] = (best - mean_corr) * plan.coverage

    return out
