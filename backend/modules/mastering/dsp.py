"""Numpy / scipy DSP kernels for mastering tools.

Pure-python signal processing used by dynamic_eq, transient_shaper,
spectral_stabilizer, and match_eq handlers. All functions operate on
numpy arrays and return numpy arrays — file I/O is the caller's job.
"""

from __future__ import annotations

import numpy as np
from scipy import signal


# ── Dynamic EQ ────────────────────────────────────────────────────────
def dynamic_eq_process(
    audio: np.ndarray,
    sr: int,
    bands: list[dict],
) -> np.ndarray:
    """Per-band envelope-following gain reduction applied to the FULL signal.

    Each band dict: {freq, q, threshold_db, ratio, attack_ms, release_ms, gain_db}.
    """
    out = audio.copy().astype(np.float64)
    for band in bands:
        freq = band["freq"]
        q = band.get("q", 1.0)
        thresh_db = band["threshold_db"]
        ratio = band["ratio"]
        attack_ms = band.get("attack_ms", 10.0)
        release_ms = band.get("release_ms", 100.0)
        gain_db = band.get("gain_db", 0.0)

        # Design bandpass to isolate the band for envelope detection
        low = freq / (2 ** (1 / (2 * q)))
        high = freq * (2 ** (1 / (2 * q)))
        nyq = sr / 2.0
        low_n = max(low / nyq, 0.001)
        high_n = min(high / nyq, 0.999)
        if low_n >= high_n:
            continue
        try:
            sos = signal.butter(2, [low_n, high_n], btype="band", output="sos")
        except ValueError:
            continue

        # Process each channel
        for ch in range(out.shape[1] if out.ndim > 1 else 1):
            chan = out[:, ch] if out.ndim > 1 else out
            # Isolate band for envelope detection
            band_sig = signal.sosfilt(sos, chan)
            # Envelope: rectify + single-pole lowpass
            envelope = np.abs(band_sig)
            attack_coeff = np.exp(-1.0 / (attack_ms * sr / 1000.0))
            release_coeff = np.exp(-1.0 / (release_ms * sr / 1000.0))
            env_smooth = _smooth_envelope(envelope, attack_coeff, release_coeff)
            # Convert to dB
            env_db = 20.0 * np.log10(env_smooth + 1e-10)
            # Gain reduction: only where envelope exceeds threshold
            over = np.maximum(env_db - thresh_db, 0.0)
            gain_reduction_db = -over * (1.0 - 1.0 / ratio) + gain_db
            gain_lin = np.power(10.0, gain_reduction_db / 20.0)
            if out.ndim > 1:
                out[:, ch] = chan * gain_lin
            else:
                out = chan * gain_lin
    return out


def _smooth_envelope(env: np.ndarray, attack: float, release: float) -> np.ndarray:
    """Single-pole attack/release envelope follower."""
    out = np.empty_like(env)
    out[0] = env[0]
    for i in range(1, len(env)):
        coeff = attack if env[i] > out[i - 1] else release
        out[i] = coeff * out[i - 1] + (1.0 - coeff) * env[i]
    return out


# ── Transient Shaper ──────────────────────────────────────────────────
def transient_shape(
    audio: np.ndarray,
    sr: int,
    attack: float = 0.0,
    sustain: float = 0.0,
    fast_ms: float = 1.0,
    slow_ms: float = 50.0,
) -> np.ndarray:
    """Dual-envelope transient shaper.

    attack > 0 boosts transients, < 0 softens.
    sustain > 0 boosts sustain, < 0 attenuates.
    """
    out = audio.copy().astype(np.float64)
    fast_coeff = np.exp(-1.0 / max(fast_ms * sr / 1000.0, 1.0))
    slow_coeff = np.exp(-1.0 / max(slow_ms * sr / 1000.0, 1.0))

    for ch in range(out.shape[1] if out.ndim > 1 else 1):
        chan = out[:, ch] if out.ndim > 1 else out
        rectified = np.abs(chan)
        # Single-pole followers
        env_fast = _single_pole(rectified, fast_coeff)
        env_slow = _single_pole(rectified, slow_coeff)
        # Transient signal: difference of envelopes
        transient = env_fast - env_slow
        # Gain: 1 + attack * max(0, transient) + sustain * min(0, transient)
        gain = (
            1.0
            + attack * np.maximum(0.0, transient)
            + sustain * np.minimum(0.0, transient)
        )
        if out.ndim > 1:
            out[:, ch] = chan * gain
        else:
            out = chan * gain
    return out


def _single_pole(x: np.ndarray, coeff: float) -> np.ndarray:
    """Single-pole lowpass via scipy lfilter."""
    b = np.array([1.0 - coeff])
    a = np.array([1.0, -coeff])
    return signal.lfilter(b, a, np.abs(x))


# ── Spectral Stabilizer ──────────────────────────────────────────────
# Built-in target: gentle smile — slight boost at low-end and high-end
SMILE_CURVE_FREQS = np.array(
    [20, 60, 150, 400, 1000, 3000, 6000, 10000, 16000, 20000], dtype=float
)
SMILE_CURVE_DB = np.array(
    [2.0, 1.5, 0.5, 0.0, 0.0, 0.0, 0.5, 1.0, 1.5, 2.0], dtype=float
)


def spectral_stabilize(
    audio: np.ndarray,
    sr: int,
    amount_db: float = 6.0,
    n_fft: int = 4096,
    numtaps: int = 4097,
) -> np.ndarray:
    """Measure average spectrum, compute correction toward target, apply FIR."""
    from ...lib.fir_utils import apply_fir, design_fir_from_curve

    # Measure average spectrum
    mono = audio.mean(axis=1) if audio.ndim > 1 else audio
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
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    mag_db = 20.0 * np.log10(acc + 1e-9)

    # Interpolate target at the same frequencies
    nyq = sr / 2.0
    target_freqs = SMILE_CURVE_FREQS[SMILE_CURVE_FREQS <= nyq]
    target_db = SMILE_CURVE_DB[: len(target_freqs)]
    target_interp = np.interp(freqs, target_freqs, target_db)

    # Correction = target - measured, clamped to +-amount
    correction = target_interp - mag_db
    # Normalize: center correction around 0 (we don't want to match absolute level)
    correction -= np.mean(correction)
    correction = np.clip(correction, -amount_db, amount_db)

    # Design FIR from correction curve (skip DC)
    fir_freqs = freqs[1:]
    fir_gains = correction[1:]
    kernel = design_fir_from_curve(fir_freqs, fir_gains, sr=sr, numtaps=numtaps)
    return apply_fir(audio, kernel)
