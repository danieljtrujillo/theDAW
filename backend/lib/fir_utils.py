"""FIR design helpers — shared by Match EQ, Spectral Stabilizer, linear-phase EQ.

Design a linear-phase FIR from an arbitrary frequency→gain curve, apply it, or
export it as a WAV impulse response so it can be convolved by ffmpeg ``afir``.
"""

from __future__ import annotations

from pathlib import Path


def design_fir_from_curve(freqs_hz, gains_db, sr: int = 44100, numtaps: int = 4097):
    """Linear-phase FIR kernel from (freqs_hz, gains_db) control points.

    ``freqs_hz`` must be ascending within [0, sr/2]. Returns a numpy array.
    """
    import numpy as np
    from scipy.signal import firwin2

    freqs = np.asarray(freqs_hz, dtype=float)
    gains = np.power(10.0, np.asarray(gains_db, dtype=float) / 20.0)
    nyq = sr / 2.0
    # firwin2 needs normalized freqs spanning 0..1 with endpoints present
    f = np.concatenate(([0.0], np.clip(freqs / nyq, 1e-6, 1.0), [1.0]))
    g = np.concatenate(([gains[0]], gains, [gains[-1]]))
    # ensure strictly increasing
    f, idx = np.unique(f, return_index=True)
    g = g[idx]
    if numtaps % 2 == 0:
        numtaps += 1
    return firwin2(numtaps, f, g)


def apply_fir(audio, kernel):
    """Convolve audio (mono or [N, ch]) with a FIR kernel (same-length output)."""
    import numpy as np
    from scipy.signal import fftconvolve

    audio = np.asarray(audio)
    if audio.ndim == 1:
        return fftconvolve(audio, kernel, mode="same")
    return np.stack(
        [fftconvolve(audio[:, c], kernel, mode="same") for c in range(audio.shape[1])],
        axis=1,
    )


def export_ir_wav(kernel, sr: int, path: Path) -> Path:
    """Write a FIR kernel as a WAV impulse response for ffmpeg ``afir``."""
    import numpy as np
    import soundfile as sf

    k = np.asarray(kernel, dtype="float32")
    peak = np.max(np.abs(k)) or 1.0
    sf.write(str(path), (k / peak * 0.98), sr, subtype="FLOAT")
    return path
