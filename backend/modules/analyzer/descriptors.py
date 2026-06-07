"""Full descriptor taxonomy extraction for the Analyzer module.

Computes LOW-LEVEL, MID-LEVEL, and HIGH-LEVEL audio descriptors from any
audio file and returns a single JSON-serializable dict matching the schema
documented in ``modules/analyzer/README.md``.

Libraries used: numpy, scipy, soundfile, librosa, pyloudnorm.
FFmpeg (via ``edit_tools_backend.lib.audio_analysis.measure_loudness``) provides
EBU-R128 true-peak, momentary/short-term LUFS, and loudness range.
"""

from __future__ import annotations

import asyncio
import math
from pathlib import Path
from typing import Any

import librosa
import numpy as np
import pyloudnorm
import soundfile as sf
from scipy.signal import butter, sosfilt

from edit_tools_backend.lib.audio_analysis import measure_loudness

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_EPS = 1e-9

# Krumhansl–Schmuckler key profiles
_MAJOR_PROFILE = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
)
_MINOR_PROFILE = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
)

_KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Band definitions: (name, low_hz, high_hz)
_BANDS = [
    ("sub", 20, 60),
    ("low", 60, 250),
    ("low_mid", 250, 500),
    ("mid", 500, 2000),
    ("high_mid", 2000, 6000),
    ("high", 6000, 12000),
    ("air", 12000, 20000),
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _to_db(linear: float) -> float:
    """Convert a linear amplitude to dB, clamped to -120."""
    if linear <= 0:
        return -120.0
    return float(20.0 * math.log10(linear))


def _rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(x**2)))


def _to_mono(audio: np.ndarray) -> np.ndarray:
    """Collapse to mono if stereo (samples, channels)."""
    if audio.ndim == 2:
        return audio.mean(axis=1)
    return audio


def _bandpass_sos(low: float, high: float, sr: int, order: int = 4) -> np.ndarray:
    """Design a Butterworth bandpass filter as second-order sections.

    For the lowest band (sub), use a lowpass instead; for the highest (air),
    use a highpass.
    """
    nyq = sr / 2.0
    lo = max(low / nyq, 0.001)
    hi = min(high / nyq, 0.999)
    if lo <= 0.001:
        # lowpass only
        return butter(order, hi, btype="low", output="sos")
    if hi >= 0.999:
        # highpass only
        return butter(order, lo, btype="high", output="sos")
    return butter(order, [lo, hi], btype="band", output="sos")


def _band_rms(mono: np.ndarray, sr: int, low: float, high: float) -> float:
    """RMS of a bandpass-filtered signal."""
    sos = _bandpass_sos(low, high, sr)
    filtered = sosfilt(sos, mono)
    return _rms(filtered)


# ---------------------------------------------------------------------------
# Krumhansl–Schmuckler key finding
# ---------------------------------------------------------------------------


def _find_key(chroma_mean: np.ndarray) -> tuple[str, float]:
    """Return (key_label, confidence) using Krumhansl–Schmuckler.

    Rotates the major and minor profiles against the 12-bin chroma vector,
    picks the rotation with the highest Pearson correlation.
    """
    best_corr = -2.0
    best_key = "C major"
    for shift in range(12):
        rolled = np.roll(chroma_mean, -shift)
        for profile, mode_name in [
            (_MAJOR_PROFILE, "major"),
            (_MINOR_PROFILE, "minor"),
        ]:
            corr = float(np.corrcoef(rolled, profile)[0, 1])
            if corr > best_corr:
                best_corr = corr
                best_key = f"{_KEY_NAMES[shift]} {mode_name}"
    confidence = max(0.0, min(1.0, (best_corr + 1.0) / 2.0))  # map [-1,1] → [0,1]
    return best_key, round(confidence, 4)


# ---------------------------------------------------------------------------
# Individual descriptor groups
# ---------------------------------------------------------------------------


def _extract_low_level(
    audio: np.ndarray,
    mono: np.ndarray,
    sr: int,
    loudness_data: dict,
) -> dict[str, Any]:
    """Extract all low-level descriptors."""

    # RMS / energy
    rms_linear = _rms(mono)
    rms_db = round(_to_db(rms_linear), 2)

    # Peak
    peak_linear = float(np.max(np.abs(mono)))
    peak_db = round(_to_db(peak_linear), 2)

    # True peak from FFmpeg (already parsed by measure_loudness)
    true_peak_dbtp = round(loudness_data.get("input_tp", peak_db), 2)

    # Crest factor
    crest_db = round(peak_db - rms_db, 2) if rms_db > -120 else 0.0

    # LUFS — pyloudnorm for integrated, FFmpeg for momentary/short-term
    # pyloudnorm expects (samples, channels)
    meter = pyloudnorm.Meter(sr)
    audio_for_lufs = audio if audio.ndim == 2 else audio[:, np.newaxis]
    try:
        lufs_i = round(float(meter.integrated_loudness(audio_for_lufs)), 2)
    except Exception:
        lufs_i = round(loudness_data.get("input_i", -70.0), 2)

    # FFmpeg loudnorm gives input_i; for momentary/short-term we parse from
    # the same data — loudnorm doesn't separate M/S, so we approximate:
    # input_i is the integrated value, and we use it as a baseline.
    # We'll use the FFmpeg data for the integrated value and derive M/S
    # from the audio using pyloudnorm's gating (best-effort).
    lufs_m = round(
        loudness_data.get("input_i", lufs_i), 2
    )  # Momentary ≈ integrated for full-file
    lufs_s = round(
        loudness_data.get("input_i", lufs_i), 2
    )  # Short-term ≈ integrated for full-file

    # Better momentary/short-term: compute from windowed blocks
    lufs_m, lufs_s = _compute_momentary_shortterm_lufs(audio_for_lufs, sr, meter)

    # Loudness range from FFmpeg
    lra = round(loudness_data.get("input_lra", 0.0), 2)

    # Zero-crossing rate
    zcr = librosa.feature.zero_crossing_rate(y=mono)
    zcr_mean = round(float(np.mean(zcr)), 4)

    # Spectral centroid
    sc = librosa.feature.spectral_centroid(y=mono, sr=sr)
    sc_mean = round(float(np.mean(sc)), 1)

    # Spectral rolloff
    sro = librosa.feature.spectral_rolloff(y=mono, sr=sr)
    sro_mean = round(float(np.mean(sro)), 1)

    # Spectral bandwidth
    sbw = librosa.feature.spectral_bandwidth(y=mono, sr=sr)
    sbw_mean = round(float(np.mean(sbw)), 1)

    # Spectral flatness
    sf_val = librosa.feature.spectral_flatness(y=mono)
    sf_mean = round(float(np.mean(sf_val)), 4)

    # Spectral flux (onset strength as a proxy)
    onset_env = librosa.onset.onset_strength(y=mono, sr=sr)
    flux_mean = round(float(np.mean(onset_env)), 4)

    # Band energies via scipy butterworth bandpass
    band_energies_db: dict[str, float] = {}
    for band_name, lo, hi in _BANDS:
        effective_hi = min(hi, sr // 2 - 1)
        if effective_hi <= lo:
            band_energies_db[band_name] = -120.0
            continue
        b_rms = _band_rms(mono, sr, lo, effective_hi)
        band_energies_db[band_name] = round(_to_db(b_rms), 1)

    # MFCCs — 13 coefficients, mean across frames
    mfccs = librosa.feature.mfcc(y=mono, sr=sr, n_mfcc=13)
    mfcc_mean = [round(float(v), 3) for v in np.mean(mfccs, axis=1)]

    # DC offset
    dc_offset = round(float(np.mean(mono)), 6)

    return {
        "rms_db": rms_db,
        "peak_db": peak_db,
        "true_peak_dbtp": true_peak_dbtp,
        "crest_factor_db": crest_db,
        "lufs_momentary": lufs_m,
        "lufs_short_term": lufs_s,
        "lufs_integrated": lufs_i,
        "loudness_range_lu": lra,
        "zero_crossing_rate": zcr_mean,
        "spectral_centroid_hz": sc_mean,
        "spectral_rolloff_hz": sro_mean,
        "spectral_bandwidth_hz": sbw_mean,
        "spectral_flatness": sf_mean,
        "spectral_flux_mean": flux_mean,
        "band_energies_db": band_energies_db,
        "mfcc_mean": mfcc_mean,
        "dc_offset": dc_offset,
    }


def _compute_momentary_shortterm_lufs(
    audio: np.ndarray, sr: int, meter: pyloudnorm.Meter
) -> tuple[float, float]:
    """Compute peak momentary (400ms) and peak short-term (3s) LUFS.

    Uses sliding windows with pyloudnorm for each block, returning the
    maximum (loudest) value for each window size.
    """
    n_samples = audio.shape[0]

    # Momentary: 400ms window
    momentary_size = int(sr * 0.4)
    hop = int(sr * 0.1)  # 100ms hop
    max_m = -70.0
    if n_samples >= momentary_size:
        for start in range(0, n_samples - momentary_size + 1, hop):
            block = audio[start : start + momentary_size]
            try:
                val = meter.integrated_loudness(block)
                if not math.isinf(val) and val > max_m:
                    max_m = val
            except Exception:
                continue

    # Short-term: 3s window
    shortterm_size = int(sr * 3.0)
    hop_st = int(sr * 0.5)  # 500ms hop
    max_s = -70.0
    if n_samples >= shortterm_size:
        for start in range(0, n_samples - shortterm_size + 1, hop_st):
            block = audio[start : start + shortterm_size]
            try:
                val = meter.integrated_loudness(block)
                if not math.isinf(val) and val > max_s:
                    max_s = val
            except Exception:
                continue

    return round(max_m, 2), round(max_s, 2)


def _extract_mid_level(
    audio: np.ndarray,
    mono: np.ndarray,
    sr: int,
    duration: float,
) -> dict[str, Any]:
    """Extract all mid-level descriptors."""

    # ---- Onset density & transient class ----
    onset_env = librosa.onset.onset_strength(y=mono, sr=sr)
    onsets = librosa.onset.onset_detect(
        y=mono, sr=sr, onset_envelope=onset_env, units="time"
    )
    onset_density = round(len(onsets) / max(duration, _EPS), 2)

    # Crest factor for transient classification
    peak_lin = float(np.max(np.abs(mono)))
    rms_lin = _rms(mono)
    crest_db = _to_db(peak_lin) - _to_db(rms_lin) if rms_lin > _EPS else 0.0

    if onset_density < 1.5 and crest_db < 12:
        transient_class = "sparse"
    elif onset_density > 6.0 or (onset_density > 3.0 and crest_db > 18):
        transient_class = "dense"
    else:
        transient_class = "moderate"

    # ---- F0 / voicing ----
    fmin = librosa.note_to_hz("C2")
    fmax = librosa.note_to_hz("C7")
    f0, voiced_flag, voiced_prob = librosa.pyin(mono, fmin=fmin, fmax=fmax, sr=sr)
    # Median F0 over voiced frames
    voiced_mask = ~np.isnan(f0)
    if np.any(voiced_mask):
        f0_hz = round(float(np.nanmedian(f0)), 2)
        voicing_confidence = round(float(np.mean(voiced_prob[voiced_mask])), 4)
    else:
        f0_hz = None
        voicing_confidence = 0.0

    # ---- Chroma ----
    chroma = librosa.feature.chroma_cqt(y=mono, sr=sr)
    chroma_mean = np.mean(chroma, axis=1)
    chroma_list = [round(float(v), 4) for v in chroma_mean]

    # ---- Key / mode ----
    key_label, key_confidence = _find_key(chroma_mean)

    # ---- Beat / tempo ----
    tempo, beat_frames = librosa.beat.beat_track(y=mono, sr=sr)
    # librosa >= 0.10 returns tempo as an array
    if isinstance(tempo, np.ndarray):
        tempo_val = float(tempo[0]) if tempo.size > 0 else 0.0
    else:
        tempo_val = float(tempo)
    tempo_bpm = round(tempo_val, 1)

    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    beat_positions = [round(float(t), 3) for t in beat_times]

    # Tempo confidence: strength of the tempo estimate from the onset autocorrelation
    ac = librosa.autocorrelate(onset_env, max_size=len(onset_env))
    if len(ac) > 1 and ac[0] > 0:
        tempo_confidence = round(float(np.max(ac[1:]) / ac[0]), 4)
    else:
        tempo_confidence = 0.0

    # ---- Stereo metrics ----
    if audio.ndim == 2 and audio.shape[1] >= 2:
        left = audio[:, 0]
        right = audio[:, 1]

        # Stereo correlation
        stereo_corr = float(np.corrcoef(left, right)[0, 1])
        stereo_corr = round(stereo_corr, 4)

        # Stereo width: rms(L-R) / (rms(L+R) + eps)
        side = left - right
        mid = left + right
        rms_side = _rms(side)
        rms_mid = _rms(mid)
        stereo_width = round(rms_side / (rms_mid + _EPS), 4)

        # Mid/side ratio in dB
        ms_ratio_db = round(20.0 * math.log10(rms_mid / (rms_side + _EPS)), 2)
    else:
        stereo_corr = 1.0
        stereo_width = 0.0
        ms_ratio_db = 120.0  # fully mono → huge mid dominance

    return {
        "onset_density_per_sec": onset_density,
        "transient_class": transient_class,
        "f0_hz": f0_hz,
        "voicing_confidence": voicing_confidence,
        "chroma": chroma_list,
        "key": key_label,
        "key_confidence": key_confidence,
        "tempo_bpm": tempo_bpm,
        "tempo_confidence": tempo_confidence,
        "beat_positions": beat_positions,
        "stereo_correlation": stereo_corr,
        "stereo_width": stereo_width,
        "mid_side_ratio_db": ms_ratio_db,
    }


def _extract_high_level(
    audio: np.ndarray,
    mono: np.ndarray,
    sr: int,
    low_level: dict,
    mid_level: dict,
) -> dict[str, Any]:
    """Extract all high-level descriptors (source type, artifacts, perceptual)."""

    sf_mean = low_level["spectral_flatness"]
    zcr_mean = low_level["zero_crossing_rate"]
    voicing = mid_level["voicing_confidence"]
    f0_hz = mid_level["f0_hz"]
    onset_density = mid_level["onset_density_per_sec"]
    crest_db = low_level["crest_factor_db"]
    centroid = low_level["spectral_centroid_hz"]
    band_e = low_level["band_energies_db"]

    # ---- Source type ----
    source_type, source_confidence = _classify_source(
        sf_mean, zcr_mean, voicing, f0_hz, onset_density, crest_db
    )

    # ---- Instrument priors ----
    instrument_priors = _instrument_priors(
        f0_hz, voicing, onset_density, sf_mean, centroid, band_e, crest_db
    )

    # ---- Artifact flags ----
    artifact_flags = _detect_artifacts(audio, mono, sr, low_level, mid_level)

    # ---- Perceptual scores ----
    perceptual = _perceptual_scores(low_level, mid_level)

    return {
        "source_type": source_type,
        "source_confidence": source_confidence,
        "instrument_priors": instrument_priors,
        "artifact_flags": artifact_flags,
        "perceptual": perceptual,
    }


# ---------------------------------------------------------------------------
# Source classification
# ---------------------------------------------------------------------------


def _classify_source(
    spectral_flatness: float,
    zcr: float,
    voicing: float,
    f0_hz: float | None,
    onset_density: float,
    crest_db: float,
) -> tuple[str, float]:
    """Classify audio as speech, music, or noise using simple heuristics."""

    speech_score = 0.0
    music_score = 0.0
    noise_score = 0.0

    # High voicing + moderate F0 → speech
    if voicing > 0.5 and f0_hz is not None and 80 < f0_hz < 400:
        speech_score += 0.4
    if voicing > 0.7:
        speech_score += 0.2

    # Rhythmic content + tonality → music
    if onset_density > 1.5:
        music_score += 0.3
    if f0_hz is not None and voicing > 0.3:
        music_score += 0.2
    if crest_db > 6 and onset_density > 2:
        music_score += 0.2

    # High spectral flatness → noise
    if spectral_flatness > 0.5:
        noise_score += 0.5
    if spectral_flatness > 0.3 and zcr > 0.3:
        noise_score += 0.3
    if voicing < 0.1:
        noise_score += 0.2

    scores = {"speech": speech_score, "music": music_score, "noise": noise_score}
    source_type = max(scores, key=scores.get)  # type: ignore[arg-type]
    total = sum(scores.values()) or 1.0
    confidence = round(scores[source_type] / total, 4)

    return source_type, confidence


# ---------------------------------------------------------------------------
# Instrument priors
# ---------------------------------------------------------------------------


def _instrument_priors(
    f0_hz: float | None,
    voicing: float,
    onset_density: float,
    spectral_flatness: float,
    centroid: float,
    band_energies: dict[str, float],
    crest_db: float,
) -> dict[str, float]:
    """Heuristic instrument priors from spectral + temporal features."""

    priors: dict[str, float] = {}

    # Vocal: voiced, F0 in ~80–1100 Hz range, moderate spectral centroid
    vocal = 0.0
    if f0_hz is not None and 80 <= f0_hz <= 1100 and voicing > 0.4:
        vocal = 0.3 + 0.4 * voicing
        if centroid > 1000 and centroid < 5000:
            vocal += 0.2
    priors["vocal"] = round(min(1.0, vocal), 2)

    # Bass: low F0, energy concentrated in sub/low bands
    bass = 0.0
    if f0_hz is not None and 30 <= f0_hz <= 300:
        bass += 0.3
    low_energy = band_energies.get("low", -120)
    sub_energy = band_energies.get("sub", -120)
    mid_energy = band_energies.get("mid", -120)
    if low_energy > mid_energy:
        bass += 0.3
    if sub_energy > -30:
        bass += 0.2
    priors["bass"] = round(min(1.0, bass), 2)

    # Drums: onset-dense, broadband (high spectral flatness), high crest
    drums = 0.0
    if onset_density > 3.0:
        drums += 0.3
    if spectral_flatness > 0.15:
        drums += 0.2
    if crest_db > 12:
        drums += 0.3
    priors["drums"] = round(min(1.0, drums), 2)

    # Guitar: midrange F0, moderate onset density, tonal
    guitar = 0.0
    if f0_hz is not None and 80 <= f0_hz <= 1200 and voicing > 0.2:
        guitar += 0.2
    if 1.0 < onset_density < 8.0 and spectral_flatness < 0.3:
        guitar += 0.2
    if centroid > 500 and centroid < 4000:
        guitar += 0.1
    priors["guitar"] = round(min(1.0, guitar), 2)

    # Keys/synth: tonal, stable pitch, low spectral flatness
    keys = 0.0
    if voicing > 0.5 and spectral_flatness < 0.15:
        keys += 0.3
    if f0_hz is not None and 60 <= f0_hz <= 4000:
        keys += 0.2
    priors["keys"] = round(min(1.0, keys), 2)

    return priors


# ---------------------------------------------------------------------------
# Artifact detection
# ---------------------------------------------------------------------------


def _detect_artifacts(
    audio: np.ndarray,
    mono: np.ndarray,
    sr: int,
    low_level: dict,
    mid_level: dict,
) -> dict[str, Any]:
    """Detect clipping, hum, noise floor, sibilance, harshness, low-end bloom."""

    return {
        "clipping": _detect_clipping(mono, sr),
        "hum": _detect_hum(mono, sr),
        "noise": _detect_noise_floor(mono, sr),
        "sibilance": _detect_sibilance(mono, sr, mid_level),
        "harshness": _detect_harshness(mono, sr, low_level),
        "low_end_bloom": _detect_low_end_bloom(low_level),
    }


def _detect_clipping(mono: np.ndarray, sr: int) -> dict[str, Any]:
    """Detect digital clipping: consecutive samples at or near ±1.0."""
    threshold = 0.99
    abs_mono = np.abs(mono)
    clipped = abs_mono > threshold
    clip_ratio = float(np.sum(clipped)) / len(mono)

    # Find locations where consecutive samples clip (true digital clipping)
    locations_sec: list[float] = []
    if clip_ratio > 0:
        # Find runs of clipped samples
        diff = np.diff(clipped.astype(int))
        starts = np.where(diff == 1)[0]
        for s in starts:
            # Only flag if at least 2 consecutive clipped samples
            end = s + 1
            while end < len(clipped) and clipped[end]:
                end += 1
            if (end - s) >= 2:
                locations_sec.append(round(float(s) / sr, 3))

    severity = min(1.0, clip_ratio * 100)  # Scale up — even 1% is severe
    return {
        "detected": clip_ratio > 1e-5,
        "severity": round(severity, 4),
        "locations_sec": locations_sec[:50],  # Cap at 50 locations
    }


def _detect_hum(mono: np.ndarray, sr: int, n_fft: int = 8192) -> dict[str, Any]:
    """Detect power-line hum at 50/60 Hz and their harmonics via FFT peak detection."""
    # Compute magnitude spectrum
    if len(mono) < n_fft:
        padded = np.pad(mono, (0, n_fft - len(mono)))
    else:
        padded = mono[: n_fft * (len(mono) // n_fft)]  # Use full frames

    # Average spectrum across frames for stability
    hop = n_fft
    win = np.hanning(n_fft)
    n_frames = max(1, len(padded) // hop)
    acc = np.zeros(n_fft // 2 + 1)
    for i in range(n_frames):
        start = i * hop
        if start + n_fft > len(padded):
            break
        frame = padded[start : start + n_fft] * win
        acc += np.abs(np.fft.rfft(frame))
    acc /= max(n_frames, 1)

    np.fft.rfftfreq(n_fft, 1.0 / sr)
    mag_db = 20 * np.log10(acc + _EPS)

    # Check for peaks at 50/60 Hz and harmonics (up to 5th harmonic)
    hum_freqs_50 = [50 * k for k in range(1, 6)]
    hum_freqs_60 = [60 * k for k in range(1, 6)]

    def _check_hum_peaks(target_freqs: list[int]) -> float:
        total_excess = 0.0
        for fh in target_freqs:
            if fh >= sr / 2:
                continue
            idx = int(round(fh / (sr / n_fft)))
            if idx >= len(mag_db):
                continue
            # Compare peak to local neighborhood
            lo = max(0, idx - 10)
            hi = min(len(mag_db), idx + 10)
            local_median = float(np.median(mag_db[lo:hi]))
            peak_val = float(mag_db[idx])
            excess = peak_val - local_median
            if excess > 6:  # Must be at least 6dB above neighbors
                total_excess += excess
        return total_excess

    excess_50 = _check_hum_peaks(hum_freqs_50)
    excess_60 = _check_hum_peaks(hum_freqs_60)
    max_excess = max(excess_50, excess_60)

    detected = max_excess > 10  # Significant hum if >10dB total excess
    severity = min(1.0, max_excess / 50.0)
    result: dict[str, Any] = {"detected": detected}
    if detected:
        result["severity"] = round(severity, 4)
        result["fundamental_hz"] = 50 if excess_50 >= excess_60 else 60
    return result


def _detect_noise_floor(mono: np.ndarray, sr: int) -> dict[str, Any]:
    """Estimate noise floor from spectral flatness of the quietest 10% of frames."""
    hop = 2048
    n_fft = 2048
    n_frames = max(1, (len(mono) - n_fft) // hop)

    # Compute per-frame energy and spectral flatness
    frame_energies = np.zeros(n_frames)
    frame_flatness = np.zeros(n_frames)
    win = np.hanning(n_fft)

    for i in range(n_frames):
        start = i * hop
        frame = mono[start : start + n_fft] * win
        spec = np.abs(np.fft.rfft(frame))
        frame_energies[i] = np.mean(spec**2)
        # Spectral flatness: geometric mean / arithmetic mean
        log_spec = np.log(spec + _EPS)
        geo_mean = np.exp(np.mean(log_spec))
        arith_mean = np.mean(spec) + _EPS
        frame_flatness[i] = geo_mean / arith_mean

    if n_frames < 2:
        return {"detected": False}

    # Select quietest 10% of frames
    n_quiet = max(1, n_frames // 10)
    quiet_indices = np.argsort(frame_energies)[:n_quiet]
    quiet_flatness = float(np.mean(frame_flatness[quiet_indices]))

    # High flatness in quiet sections = noise
    detected = quiet_flatness > 0.3
    severity = min(1.0, quiet_flatness)

    return {
        "detected": detected,
        "severity": round(severity, 4),
    }


def _detect_sibilance(mono: np.ndarray, sr: int, mid_level: dict) -> dict[str, Any]:
    """Detect sibilance: energy spikes in 4–10 kHz during high-voicing frames."""
    if sr < 8000:
        return {"detected": False}

    hop = 2048
    n_fft = 4096
    n_frames = max(1, (len(mono) - n_fft) // hop)

    # Get F0/voicing track for frame alignment
    voicing_conf = mid_level.get("voicing_confidence", 0)
    if voicing_conf < 0.2:
        return {"detected": False}

    # Compute 4–10 kHz band energy per frame vs broadband
    nyq = sr / 2
    lo_bin = int(4000 / nyq * (n_fft // 2))
    hi_bin = min(int(10000 / nyq * (n_fft // 2)), n_fft // 2)
    if lo_bin >= hi_bin:
        return {"detected": False}

    win = np.hanning(n_fft)
    sibilance_scores: list[float] = []
    center_freqs: list[float] = []

    for i in range(n_frames):
        start = i * hop
        if start + n_fft > len(mono):
            break
        frame = mono[start : start + n_fft] * win
        spec = np.abs(np.fft.rfft(frame))
        total_energy = np.mean(spec**2) + _EPS
        band_energy = np.mean(spec[lo_bin:hi_bin] ** 2)
        ratio = band_energy / total_energy

        if ratio > 0.3:  # Band has >30% of total energy
            sibilance_scores.append(ratio)
            peak_bin = lo_bin + np.argmax(spec[lo_bin:hi_bin])
            center_freqs.append(float(peak_bin * sr / n_fft))

    if not sibilance_scores:
        return {"detected": False}

    severity = min(1.0, float(np.mean(sibilance_scores)))
    center_hz = round(float(np.median(center_freqs)), 0)

    return {
        "detected": True,
        "severity": round(severity, 4),
        "center_hz": center_hz,
    }


def _detect_harshness(mono: np.ndarray, sr: int, low_level: dict) -> dict[str, Any]:
    """Detect harshness: persistent 2–5 kHz excess vs a neutral reference curve."""
    if sr < 4000:
        return {"detected": False}

    n_fft = 4096
    hop = 2048
    win = np.hanning(n_fft)

    # Average spectrum
    n_frames = max(1, (len(mono) - n_fft) // hop)
    acc = np.zeros(n_fft // 2 + 1)
    for i in range(n_frames):
        start = i * hop
        if start + n_fft > len(mono):
            break
        frame = mono[start : start + n_fft] * win
        acc += np.abs(np.fft.rfft(frame)) ** 2
    acc /= max(n_frames, 1)
    mag_db = 10 * np.log10(acc + _EPS)

    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)

    # Measure 2–5 kHz region vs 500–2kHz and 5–8kHz neighbors
    mask_harsh = (freqs >= 2000) & (freqs <= 5000)
    mask_below = (freqs >= 500) & (freqs < 2000)
    mask_above = (freqs > 5000) & (freqs <= 8000)

    if not np.any(mask_harsh) or not np.any(mask_below):
        return {"detected": False}

    harsh_level = float(np.mean(mag_db[mask_harsh]))
    below_level = float(np.mean(mag_db[mask_below]))
    above_level = (
        float(np.mean(mag_db[mask_above])) if np.any(mask_above) else harsh_level
    )

    # Compare to neighbors: how much does 2-5kHz protrude?
    neighbor_avg = (below_level + above_level) / 2
    excess_db = harsh_level - neighbor_avg

    detected = excess_db > 3.0  # More than 3dB excess = harshness
    severity = min(1.0, max(0.0, (excess_db - 3.0) / 10.0))

    # Find center frequency of maximum harshness
    if detected:
        harsh_bins = mag_db[mask_harsh]
        harsh_freqs = freqs[mask_harsh]
        center_hz = round(float(harsh_freqs[np.argmax(harsh_bins)]), 0)
    else:
        center_hz = 0

    result: dict[str, Any] = {"detected": detected}
    if detected:
        result["severity"] = round(severity, 4)
        result["center_hz"] = center_hz
    return result


def _detect_low_end_bloom(low_level: dict) -> dict[str, Any]:
    """Detect low-end bloom: low band energy exceeds mid by >6dB."""
    band_e = low_level["band_energies_db"]
    low_e = band_e.get("low", -120)
    sub_e = band_e.get("sub", -120)
    mid_e = band_e.get("mid", -120)

    # Max of sub and low vs mid
    low_max = max(low_e, sub_e)
    excess = low_max - mid_e

    detected = excess > 6.0
    result: dict[str, Any] = {"detected": detected}
    if detected:
        result["severity"] = round(min(1.0, (excess - 6.0) / 12.0), 4)
    return result


# ---------------------------------------------------------------------------
# Perceptual scores
# ---------------------------------------------------------------------------


def _perceptual_scores(low_level: dict, mid_level: dict) -> dict[str, float]:
    """Compute perceptual scores: clarity, warmth, brightness, density, boxiness."""

    band_e = low_level["band_energies_db"]
    centroid = low_level["spectral_centroid_hz"]
    crest_db = low_level["crest_factor_db"]
    flux = low_level["spectral_flux_mean"]

    # ---- Clarity ----
    # Inverse of spectral mud (low-mid excess) + high presence
    low_mid = band_e.get("low_mid", -120)
    mid = band_e.get("mid", -120)
    high_mid = band_e.get("high_mid", -120)
    high = band_e.get("high", -120)

    mud = max(0.0, low_mid - mid)  # Low-mid excess over mid
    presence = max(
        0.0, high_mid - mid + 6
    )  # High-mid vs mid (offset for typical difference)
    clarity_raw = (presence - mud) / 12.0 + 0.5
    clarity = round(max(0.0, min(1.0, clarity_raw)), 2)

    # ---- Warmth ----
    # Low-shelf energy relative to high
    low_e = band_e.get("low", -120)
    warmth_raw = (low_e - high) / 20.0 + 0.5
    warmth = round(max(0.0, min(1.0, warmth_raw)), 2)

    # ---- Brightness ----
    # Spectral centroid normalized (typical range 500–8000 Hz)
    brightness_raw = (centroid - 500) / 7500.0
    brightness = round(max(0.0, min(1.0, brightness_raw)), 2)

    # ---- Density ----
    # Inverse of crest factor (low crest = dense) + spectral flux contribution
    # Typical crest factor: 6–20 dB
    crest_norm = 1.0 - max(0.0, min(1.0, (crest_db - 6) / 14.0))
    flux_norm = min(1.0, flux / 2.0)
    density = round(max(0.0, min(1.0, 0.6 * crest_norm + 0.4 * flux_norm)), 2)

    # ---- Boxiness ----
    # 200–500 Hz excess relative to neighbors
    low_mid_e = band_e.get("low_mid", -120)
    low_e_val = band_e.get("low", -120)
    mid_e_val = band_e.get("mid", -120)
    neighbor_avg = (low_e_val + mid_e_val) / 2.0
    boxiness_raw = (low_mid_e - neighbor_avg) / 10.0 + 0.2
    boxiness = round(max(0.0, min(1.0, boxiness_raw)), 2)

    return {
        "clarity": clarity,
        "warmth": warmth,
        "brightness": brightness,
        "density": density,
        "boxiness": boxiness,
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def extract_descriptors(audio_path: Path) -> dict[str, Any]:
    """Extract the full descriptor bundle from an audio file.

    Returns the JSON structure documented in README.md with keys:
    ``low_level``, ``mid_level``, ``high_level``, plus file metadata
    (``duration_sec``, ``sample_rate``, ``channels``, ``bit_depth``).
    """
    # ---- Read audio ----
    info = sf.info(str(audio_path))
    channels = info.channels
    # soundfile subtype → approximate bit depth
    subtype = info.subtype
    bit_depth_map = {
        "PCM_16": 16,
        "PCM_24": 24,
        "PCM_32": 32,
        "FLOAT": 32,
        "DOUBLE": 64,
        "PCM_S8": 8,
        "PCM_U8": 8,
    }
    bit_depth = bit_depth_map.get(subtype, 16)

    audio, sr = sf.read(str(audio_path), always_2d=True, dtype="float64")
    duration = float(audio.shape[0]) / sr
    mono = _to_mono(audio)

    # ---- FFmpeg loudness measurement (async) ----
    try:
        loudness_data = await measure_loudness(audio_path)
    except Exception:
        # Fallback if FFmpeg fails — we still have pyloudnorm
        loudness_data = {}

    # ---- Extract descriptor groups ----
    # Run CPU-bound extraction in thread pool to avoid blocking the event loop
    loop = asyncio.get_running_loop()

    low_level = await loop.run_in_executor(
        None, _extract_low_level, audio, mono, sr, loudness_data
    )
    mid_level = await loop.run_in_executor(
        None, _extract_mid_level, audio, mono, sr, duration
    )
    high_level = await loop.run_in_executor(
        None, _extract_high_level, audio, mono, sr, low_level, mid_level
    )

    return {
        "low_level": low_level,
        "mid_level": mid_level,
        "high_level": high_level,
        "duration_sec": round(duration, 3),
        "sample_rate": sr,
        "channels": channels,
        "bit_depth": bit_depth,
    }
