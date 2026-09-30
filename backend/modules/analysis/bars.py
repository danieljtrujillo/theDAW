"""Estimate the number of musical bars in a track.

We use the chimera tempo detector's beat list and assume a 4/4 time
signature. Bars = floor(len(beats) / 4). This is a coarse estimate;
swing / 3/4 / 6/8 material will be wrong by a constant factor, but
that's acceptable for first-pass cataloguing.
"""

from __future__ import annotations

import logging
from typing import Optional

log = logging.getLogger(__name__)

# pyloudnorm's BS.1770 gating works in 400 ms blocks; anything shorter than a
# few blocks either raises or gates to -inf. Same threshold chimera/render.py
# uses for the same reason.
_LUFS_MIN_SEC = 0.4
_RMS_DB_FLOOR = -90.0


def estimate_bars(beats: list[float], time_sig_numerator: int = 4) -> Optional[float]:
    if not beats:
        return None
    n = max(1, int(time_sig_numerator))
    return float(len(beats)) / float(n)


def estimate_rms_db(
    audio_path,
    *,
    # y_sr carries a pre-decoded librosa.load(path, sr=22050, mono=True) result so callers can share one decode.
    y_sr: Optional[tuple] = None,
) -> Optional[float]:
    """Rough loudness proxy: 20*log10(RMS). :func:`estimate_loudness_lufs`
    does not fall back to this (it returns None); prompt building uses it
    when no LUFS value exists."""
    try:
        import librosa
        import numpy as np
    except ImportError:
        return None
    from pathlib import Path

    p = Path(audio_path)
    if not p.is_file():
        return None
    if y_sr is not None:
        y = y_sr[0]
    else:
        try:
            y, _ = librosa.load(str(p), sr=22050, mono=True)
        except Exception:
            return None
    if y.size == 0:
        return None
    rms = float(np.sqrt(np.mean(y * y)))
    if rms <= 1e-9:
        return _RMS_DB_FLOOR
    return float(20.0 * np.log10(rms))


def estimate_loudness_lufs(audio_path) -> Optional[float]:
    """Integrated loudness in LUFS (ITU-R BS.1770 via pyloudnorm — already a
    project dependency; see analyzer/descriptors.py:158-162 for the same
    API/shape).

    Deliberately does NOT reuse the shared ``y_sr`` mono/22.05kHz librosa
    decode the other analysis steps share: downmixing to mono before
    metering reads low on stereo material (up to ~9.5 dB low on wide
    stereo — L=R stereo alone reads ~3 dB low, since a mono sum halves the
    per-channel power BS.1770 expects to see twice). This decodes the file
    at its native rate/channel layout via ``backend.lib.audio_io`` instead —
    one extra decode per analysis, accepted because analysis is not on the
    hot path and this does not run at mass-reanalysis scale (see
    ``ANALYSIS_VERSION`` in engine.py, deliberately not bumped for this).

    Returns ``None`` — never an RMS-dB number mislabeled as LUFS — whenever
    BS.1770 truly can't measure: file missing/undecodable, clip shorter
    than the ~0.4 s gating block, or the meter gates everything out (a
    silent or near-silent clip integrates to -inf / below the -70 LUFS
    absolute gate).
    """
    import math
    from pathlib import Path

    p = Path(audio_path)
    if not p.is_file():
        return None

    try:
        from backend.lib.audio_io import load_audio_array

        data, sr = load_audio_array(p)  # (channels, frames) float32, native rate
    except Exception as e:
        log.debug("analysis.bars: audio_io decode failed for %s: %s", p.name, e)
        return None

    frames = data.T  # pyloudnorm wants (samples, channels)
    if frames.shape[0] < int(_LUFS_MIN_SEC * sr):
        return None

    try:
        import warnings

        import pyloudnorm as pyln

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            value = float(pyln.Meter(int(sr)).integrated_loudness(frames))
    except Exception as e:
        log.debug("analysis.bars: pyloudnorm failed for %s: %s", p.name, e)
        return None

    if not math.isfinite(value) or value < -70.0:
        return None
    return value
