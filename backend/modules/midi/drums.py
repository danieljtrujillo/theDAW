"""Drum-stem transcription: onsets + spectral heuristics -> GM drum MIDI.

basic-pitch on a drum stem produces hundreds of spurious pitched notes
spanning five octaves, which is useless for notation (a percussion staff)
and for play-along (a drum highway with one lane per voice). This engine
is deliberately model-free: librosa onset detection finds the hits, a
handful of band-energy / decay rules label each hit with one or more drum
voices, and pretty_midi writes a Standard MIDI File with a single
``is_drum`` instrument on General MIDI percussion pitches.

Every threshold lives in :data:`RULES` so tests (and later tuning passes)
can adjust them without touching the code. Band energies are normalised by
their 95th percentile over the track's SHORT onsets (cymbal washes and the
hits inside them excluded), so the rules are relative to the material rather
than to absolute loudness; every voice additionally has to make its own band
group rise over the 30 ms before the hit, which keeps a decaying wash from
reading as snare + open hat on top of the kick underneath it.

Only librosa, numpy and pretty_midi are needed — all base dependencies —
so :func:`transcribe_drums` is always available.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

import numpy as np

log = logging.getLogger(__name__)

ENGINE_NAME = "drum-onsets"
ENGINE_VERSION = "1"

#: General MIDI percussion pitches per drum voice. 39 (hand clap) is the
#: generic fallback for an onset no rule claims.
GM: dict[str, int] = {
    "kick": 36,
    "snare": 38,
    "hihat_closed": 42,
    "hihat_open": 46,
    "crash": 49,
    "ride": 51,
    "tom_low": 45,
    "tom_mid": 47,
    "tom_high": 50,
    "perc": 39,
}

#: Reverse map: GM pitch -> voice label.
VOICE_FOR_PITCH: dict[int, str] = {pitch: label for label, pitch in GM.items()}

#: Analysis bands in Hz (upper bound ``None`` = Nyquist).
BANDS: dict[str, tuple[float, Optional[float]]] = {
    "sub": (0.0, 100.0),
    "low": (100.0, 250.0),
    "lowmid": (250.0, 600.0),
    "mid": (600.0, 2000.0),
    "hi": (2000.0, 6000.0),
    "air": (6000.0, None),
}

#: Tunable rule thresholds. Values suffixed ``_n`` compare against
#: p95-normalised energies (0..~1); ``decay`` values are tail/head energy
#: ratios; ``share`` values are fractions of the onset's total head energy.
RULES: dict[str, float] = {
    # onset detection
    "onset_delta": 0.07,
    "onset_wait": 2,
    "head_ms": 60.0,
    "tail_ms": 200.0,
    "pre_roll_ms": 4.0,
    # a real hit must lift some band 3 dB over the 30 ms before it (drops the
    # ghost onsets the flux detector emits when a kick tail ends) and be
    # above -80 dBFS
    "pre_window_ms": 30.0,
    "onset_rise_min": 2.0,
    "silence_rms": 1e-4,
    # low-band envelope (catches a kick under a cymbal wash) upper edge
    "low_env_fmax_hz": 300.0,
    # onsets closer than this (seconds) from the two envelopes are one hit
    "merge_window_sec": 0.03,
    # p95 reference for the cymbal bands is taken over SHORT onsets only, so
    # crash/ride tails do not drag the hats below threshold
    "ref_short_decay_max": 0.35,
    # a voice's own band group must jump ~1.8 dB (per-sample energy ratio)
    # over the pre-window for the voice to be present at this onset
    "band_rise_min": 1.5,
    # kick
    "kick_lowgroup_n": 0.45,
    "kick_centroid_hz": 350.0,
    "kick_sub_share": 0.35,
    "kick_sub_rise": 8.0,
    # snare
    "snare_crack_n": 0.4,
    "snare_lowmid_n": 0.2,
    "snare_decay_max": 0.35,
    # closed hat (air band, > 6 kHz)
    "hat_air_n": 0.3,
    "hat_closed_decay_max": 0.25,
    # open hat / ride
    "open_air_n": 0.3,
    "open_decay_min": 0.35,
    # crash
    "crash_energy_n": 0.7,
    "crash_broadband_min_bands": 3,
    "crash_band_share_min": 0.08,
    "crash_decay_min": 0.5,
    # toms
    "tom_lowgroup_n": 0.45,
    "tom_peak_min_hz": 100.0,
    "tom_peak_max_hz": 300.0,
    "tom_decay_min": 0.2,
    "tom_decay_max": 0.6,
    "tom_low_max_hz": 120.0,
    "tom_mid_max_hz": 200.0,
    # quantisation (seconds) and note length
    "quantise_window_sec": 0.025,
    "note_len_sec": 0.1,
}

SR = 22050
HOP = 256
N_FFT = 2048


# --------------------------------------------------------------------------
# Feature extraction
# --------------------------------------------------------------------------


def _band_energies(spec: np.ndarray, freqs: np.ndarray) -> dict[str, float]:
    out: dict[str, float] = {}
    for name, (lo, hi) in BANDS.items():
        mask = freqs >= lo
        if hi is not None:
            mask &= freqs < hi
        out[name] = float(np.sum(spec[mask]))
    return out


def _head_window(n: int) -> np.ndarray:
    """Flat window with a raised-cosine fade over the last quarter.

    A Hann window would sit at ~0 exactly where the transient is (an 8 ms
    hi-hat lives in the first samples of the 60 ms head), so the head is
    left flat and only the cut at the far end is tapered.
    """
    win = np.ones(n, dtype=np.float64)
    fade = max(1, n // 4)
    ramp = 0.5 * (1.0 + np.cos(np.linspace(0.0, np.pi, fade)))
    win[n - fade :] = ramp
    return win


def _power_spectrum(seg: np.ndarray) -> np.ndarray:
    """Power spectrum of a short segment, zero-padded to N_FFT."""
    if seg.size == 0:
        return np.zeros(N_FFT // 2 + 1, dtype=np.float64)
    padded = np.zeros(N_FFT, dtype=np.float64)
    n = min(seg.size, N_FFT)
    padded[:n] = (seg[:n] * _head_window(n)).astype(np.float64)
    mag = np.abs(np.fft.rfft(padded))
    return mag * mag


def _refine_onset(y: np.ndarray, sr: int, t: float) -> float:
    """Snap an onset-frame time to the steepest short-time energy rise
    within [t - 15 ms, t + 25 ms].

    Frame-based onsets carry a hop's worth of jitter (and backtracking pulls
    them early). The head window must start at the real hit to catch an
    8 ms hi-hat, so a sample-level refinement is worth the few FLOPs.
    """
    lo = max(0, int((t - 0.015) * sr))
    hi = min(y.size, int((t + 0.025) * sr))
    if hi - lo < 64:
        return t
    frame = max(16, int(0.002 * sr))
    seg = y[lo:hi].astype(np.float64)
    n_frames = (seg.size - frame) // frame
    if n_frames < 2:
        return t
    rms = np.array(
        [
            np.sqrt(np.mean(seg[i * frame : (i + 1) * frame] ** 2))
            for i in range(n_frames)
        ]
    )
    d = np.diff(rms)
    if d.size == 0 or float(np.max(d)) <= 0.0:
        return t
    k = int(np.argmax(d))
    return (lo + k * frame) / sr


def _onset_features(y: np.ndarray, sr: int, t: float) -> dict[str, float]:
    """Band energies, spectral centroid, decay ratios and the low-band peak
    for one onset at time ``t`` (seconds)."""
    pre_roll = RULES["pre_roll_ms"] / 1000.0
    head_len = RULES["head_ms"] / 1000.0
    tail_len = RULES["tail_ms"] / 1000.0
    start = max(0, int((t - pre_roll) * sr))
    head_end = min(y.size, int((t - pre_roll + head_len) * sr))
    tail_end = min(y.size, int((t - pre_roll + tail_len) * sr))
    head = y[start:head_end]
    tail = y[head_end:tail_end]
    pre_start = max(0, start - int(RULES["pre_window_ms"] / 1000.0 * sr))
    pre = y[pre_start:start]

    freqs = np.fft.rfftfreq(N_FFT, d=1.0 / sr)
    head_spec = _power_spectrum(head)
    tail_spec = _power_spectrum(tail)
    head_bands = _band_energies(head_spec, freqs)
    tail_bands = _band_energies(tail_spec, freqs)

    total = float(np.sum(head_spec)) + 1e-12
    tail_total = float(np.sum(tail_spec))
    # The tail window is longer than the head; scale to per-sample energy so
    # a steady tone reads as decay ~= 1.0 and a burst as ~0.
    head_n = max(1, head.size)
    tail_n = max(1, tail.size)
    scale = head_n / tail_n

    centroid = float(np.sum(freqs * head_spec) / total)

    head_rms = (
        float(np.sqrt(np.mean(head.astype(np.float64) ** 2))) if head.size else 0.0
    )
    # Largest per-sample band-energy rise over the 30 ms before the hit. A
    # real hit lifts at least one band sharply even inside a cymbal wash (a
    # kick's sub band); the end of a decay lifts none. No pre-window (a hit
    # in the first 30 ms of the file) counts as a clean rise.
    band_rise: dict[str, float] = {}
    if pre.size >= 32:
        pre_bands = _band_energies(_power_spectrum(pre), freqs)
        pre_n = float(pre.size)
        head_n_f = float(max(1, head.size))

        def _ratio(head_e: float, pre_e: float) -> float:
            return (head_e / head_n_f) / (pre_e / pre_n + 1e-12)

        for name in BANDS:
            band_rise[name] = _ratio(head_bands[name], pre_bands[name])
        band_rise["lowgroup"] = _ratio(
            head_bands["sub"] + head_bands["low"], pre_bands["sub"] + pre_bands["low"]
        )
        band_rise["crack"] = _ratio(
            head_bands["mid"] + head_bands["hi"], pre_bands["mid"] + pre_bands["hi"]
        )
    else:
        for name in (*BANDS, "lowgroup", "crack"):
            band_rise[name] = float("inf")

    feats: dict[str, float] = {
        "t": t,
        "energy": total,
        "centroid": centroid,
        "rms": head_rms,
        "rise": max(band_rise.values()),
    }
    for name, value in band_rise.items():
        feats[f"{name}_rise"] = value
    for name in BANDS:
        feats[name] = head_bands[name]
        feats[f"{name}_share"] = head_bands[name] / total
        feats[f"{name}_decay"] = (tail_bands[name] * scale) / (head_bands[name] + 1e-12)
    feats["decay"] = (tail_total * scale) / total
    feats["lowgroup"] = head_bands["sub"] + head_bands["low"]
    feats["crack"] = head_bands["mid"] + head_bands["hi"]
    feats["top"] = head_bands["hi"] + head_bands["air"]
    top_tail = (tail_bands["hi"] + tail_bands["air"]) * scale
    feats["top_decay"] = top_tail / (feats["top"] + 1e-12)

    # Tonal estimate for toms: strongest bin between 60 and 300 Hz.
    low_mask = (freqs >= 60.0) & (freqs <= 300.0)
    low_spec = head_spec[low_mask]
    if low_spec.size and float(np.max(low_spec)) > 0.0:
        feats["low_peak_hz"] = float(freqs[low_mask][int(np.argmax(low_spec))])
    else:
        feats["low_peak_hz"] = 0.0
    return feats


_NORMALISED_KEYS = (
    "sub",
    "low",
    "lowmid",
    "mid",
    "hi",
    "air",
    "lowgroup",
    "crack",
    "top",
    "energy",
)


def _normalise(features: list[dict[str, float]]) -> None:
    """Add ``<key>_n`` = value / p95(value over the reference onsets).

    The reference is the SHORT onsets (``decay < ref_short_decay_max``),
    falling back to all onsets when fewer than four are that short. A crash
    and the hits inside its wash carry far more energy in every band than a
    dry kick, snare or hat; letting them set the reference would push the
    dry hits below their thresholds.
    """
    if not features:
        return
    short = [f for f in features if f["decay"] < RULES["ref_short_decay_max"]]
    ref = short if len(short) >= 4 else features
    for key in _NORMALISED_KEYS:
        values = np.array([f[key] for f in ref], dtype=np.float64)
        p95 = float(np.percentile(values, 95)) if values.size else 0.0
        denom = p95 if p95 > 0.0 else 1.0
        for f in features:
            f[f"{key}_n"] = f[key] / denom


# --------------------------------------------------------------------------
# Classification
# --------------------------------------------------------------------------


def classify_onset(f: dict[str, float]) -> list[str]:
    """Multi-label drum-voice rules for one normalised onset feature dict.

    Returns a non-empty list of :data:`GM` labels (``['perc']`` when no rule
    fires). An onset can be kick + hat, snare + hat, kick + crash, etc.
    """
    r = RULES
    labels: list[str] = []
    # A voice is only present when ITS band group actually jumped at this
    # onset. Inside a cymbal wash the decaying wash still dominates the
    # mid/high bands of a kick's head window; without this guard that kick
    # reads as snare + open hat.
    rise_min = r["band_rise_min"]
    low_rose = f["lowgroup_rise"] >= rise_min
    crack_rose = f["crack_rise"] >= rise_min
    air_rose = f["air_rise"] >= rise_min

    # --- toms vs kick (mutually exclusive on the low group) ----------------
    low_hit = low_rose and f["lowgroup_n"] >= r["kick_lowgroup_n"]
    is_tom = (
        low_rose
        and f["lowgroup_n"] >= r["tom_lowgroup_n"]
        and r["tom_peak_min_hz"] <= f["low_peak_hz"] <= r["tom_peak_max_hz"]
        and r["tom_decay_min"] <= f["decay"] <= r["tom_decay_max"]
    )
    if is_tom:
        peak = f["low_peak_hz"]
        if peak < r["tom_low_max_hz"]:
            labels.append("tom_low")
        elif peak < r["tom_mid_max_hz"]:
            labels.append("tom_mid")
        else:
            labels.append("tom_high")
    elif low_hit and (
        f["centroid"] < r["kick_centroid_hz"]
        or f["sub_share"] >= r["kick_sub_share"]
        # under a wash the sub share is diluted, but the sub band still jumps
        or f["sub_rise"] >= r["kick_sub_rise"]
    ):
        labels.append("kick")

    # --- snare: crack (mid+hi) with body (lowmid), short ------------------
    if (
        crack_rose
        and f["crack_n"] >= r["snare_crack_n"]
        and f["lowmid_n"] >= r["snare_lowmid_n"]
        and f["decay"] < r["snare_decay_max"]
    ):
        labels.append("snare")

    # --- crash: loud, broadband, long ------------------------------------
    broad_bands = sum(
        1 for name in BANDS if f[f"{name}_share"] >= r["crash_band_share_min"]
    )
    is_crash = (
        air_rose
        and f["energy_n"] >= r["crash_energy_n"]
        and broad_bands >= r["crash_broadband_min_bands"]
        and f["decay"] >= r["crash_decay_min"]
    )
    if is_crash:
        labels.append("crash")

    # --- hats / ride on the air band (> 6 kHz), decided by its decay -------
    # The air band is used rather than hi+air because a snare's crack fills
    # 2-6 kHz too; only the cymbals reach above 6 kHz with real energy.
    if (
        air_rose
        and f["air_n"] >= r["hat_air_n"]
        and f["air_decay"] < r["hat_closed_decay_max"]
    ):
        labels.append("hihat_closed")
    elif (
        air_rose
        and not is_crash
        and f["air_n"] >= r["open_air_n"]
        and f["air_decay"] >= r["open_decay_min"]
    ):
        labels.append("ride" if f["hi"] > f["air"] else "hihat_open")

    if not labels:
        labels.append("perc")
    return labels


# --------------------------------------------------------------------------
# Timing helpers
# --------------------------------------------------------------------------


def _quantise_to_grid(t: float, beats: np.ndarray, window: float) -> float:
    """Snap ``t`` to the nearest 1/16 of the beat grid when within ``window``
    seconds; otherwise return it unchanged."""
    if beats.size < 2:
        return t
    period = float(np.median(np.diff(beats)))
    if period <= 0.0:
        return t
    i = int(np.searchsorted(beats, t, side="right")) - 1
    if i < 0:
        base, span = float(beats[0]), period
        k = np.round((t - base) / (span / 4.0))
    elif i >= beats.size - 1:
        base, span = float(beats[-1]), period
        k = np.round((t - base) / (span / 4.0))
    else:
        base, span = float(beats[i]), float(beats[i + 1] - beats[i]) or period
        k = np.round((t - base) / (span / 4.0))
    g = base + k * (span / 4.0)
    return g if abs(g - t) <= window else t


def _detect(onset_env: np.ndarray, sr: int) -> np.ndarray:
    """Peak-pick an onset envelope into onset times (seconds)."""
    import librosa

    if onset_env.size == 0 or float(np.max(onset_env)) <= 0.0:
        return np.zeros(0, dtype=np.float64)
    onsets = librosa.onset.onset_detect(
        onset_envelope=onset_env,
        sr=sr,
        hop_length=HOP,
        backtrack=True,
        units="time",
        delta=RULES["onset_delta"],
        wait=int(RULES["onset_wait"]),
    )
    return np.asarray(onsets, dtype=np.float64)


def _merge_onsets(a: np.ndarray, b: np.ndarray, window: float) -> np.ndarray:
    """Union of two onset lists; a ``b`` onset within ``window`` seconds of an
    ``a`` onset is the same hit and is dropped."""
    if a.size == 0:
        return np.sort(b)
    if b.size == 0:
        return np.sort(a)
    keep = [t for t in b if float(np.min(np.abs(a - t))) > window]
    return np.sort(np.concatenate([a, np.asarray(keep, dtype=np.float64)]))


def _estimate_bpm(y: np.ndarray, sr: int, onset_env: np.ndarray) -> float:
    import librosa

    try:
        tempo, _ = librosa.beat.beat_track(
            onset_envelope=onset_env, sr=sr, hop_length=HOP
        )
        tempo_f = float(np.atleast_1d(tempo)[0])
        if np.isfinite(tempo_f) and tempo_f > 0.0:
            return tempo_f
    except Exception as e:  # pragma: no cover - librosa internals
        log.debug("drums: beat_track failed: %s", e)
    return 120.0


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------


def analyse_drums(
    audio_path: Path,
    *,
    sr: int = SR,
) -> tuple[list[dict[str, float]], list[list[str]], np.ndarray, np.ndarray, int]:
    """Load ``audio_path``, detect onsets and classify each one.

    Returns ``(features, labels, onset_env, y, sr)`` — the building blocks
    :func:`transcribe_drums` writes to MIDI, exposed for tests/tuning.
    """
    import librosa

    y, sr_loaded = librosa.load(str(audio_path), sr=sr, mono=True)
    sr = int(sr_loaded)
    y = np.asarray(y, dtype=np.float32)
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    onsets = _detect(onset_env, sr)

    # A second, low-band envelope: the mean spectral flux over all mel bands
    # barely moves when a kick lands inside a cymbal wash (the wash is
    # decaying everywhere else), so kicks under crashes are found here.
    if y.size >= N_FFT:
        low_env = librosa.onset.onset_strength(
            y=y, sr=sr, hop_length=HOP, fmax=RULES["low_env_fmax_hz"], n_mels=12
        )
        onsets = _merge_onsets(onsets, _detect(low_env, sr), RULES["merge_window_sec"])

    features: list[dict[str, float]] = []
    for t_frame in onsets:
        t = _refine_onset(y, sr, float(t_frame))
        f = _onset_features(y, sr, t)
        if f["rms"] < RULES["silence_rms"] or f["rise"] < RULES["onset_rise_min"]:
            continue  # ghost onset: not a hit, just the end of a decay
        frame = min(onset_env.size - 1, max(0, int(round(t * sr / HOP))))
        # Peak of the onset envelope around the hit -> velocity.
        f["strength"] = (
            float(np.max(onset_env[frame : frame + 3])) if onset_env.size else 0.0
        )
        features.append(f)
    _normalise(features)
    if features:
        strengths = np.array([f["strength"] for f in features])
        p95 = float(np.percentile(strengths, 95)) or 1.0
        for f in features:
            f["strength_n"] = float(np.clip(f["strength"] / p95, 0.0, 1.0))
    labels = [classify_onset(f) for f in features]
    return features, labels, onset_env, y, sr


def transcribe_drums(
    audio_path: Path,
    output_midi_path: Path,
    *,
    bpm: Optional[float] = None,
    beats: Optional[list[float]] = None,
    sr: int = SR,
) -> dict:
    """Transcribe a drum stem to a GM drum MIDI file.

    ``bpm`` / ``beats`` (seconds) come from the entry's analysis row when the
    caller has one; without ``bpm`` the tempo is estimated from the audio.
    With ``beats``, note starts within 25 ms of a 1/16 grid point snap to it
    (raw timing is kept otherwise).

    Returns a result dict; never raises on a per-file problem::

        {"ok": True, "engine": "drum-onsets", "engine_version": "1",
         "notes_count": n, "onsets": m, "per_class": {label: count},
         "bpm": bpm_used}
    """
    import pretty_midi

    p = Path(audio_path)
    if not p.is_file():
        return {"ok": False, "engine": ENGINE_NAME, "error": f"audio not found: {p}"}

    try:
        features, labels, onset_env, y, sr_used = analyse_drums(p, sr=sr)
    except Exception as e:
        log.warning("drums: analysis failed for %s: %s", p.name, e)
        return {"ok": False, "engine": ENGINE_NAME, "error": repr(e)}

    bpm_used: float
    if bpm is not None and float(bpm) > 0.0:
        bpm_used = float(bpm)
    else:
        bpm_used = _estimate_bpm(y, sr_used, onset_env)

    grid = None
    if beats:
        try:
            grid = np.array(sorted(float(b) for b in beats), dtype=np.float64)
            if grid.size < 2:
                grid = None
        except (TypeError, ValueError):
            grid = None

    midi = pretty_midi.PrettyMIDI(initial_tempo=bpm_used)
    inst = pretty_midi.Instrument(program=0, is_drum=True, name="Drums")
    per_class: dict[str, int] = {}
    note_len = RULES["note_len_sec"]
    window = RULES["quantise_window_sec"]
    for f, voices in zip(features, labels):
        start = float(f["t"])
        if grid is not None:
            start = _quantise_to_grid(start, grid, window)
        start = max(0.0, start)
        velocity = int(np.clip(round(40 + 87 * f.get("strength_n", 0.5)), 1, 127))
        for voice in voices:
            inst.notes.append(
                pretty_midi.Note(
                    velocity=velocity,
                    pitch=GM[voice],
                    start=start,
                    end=start + note_len,
                )
            )
            per_class[voice] = per_class.get(voice, 0) + 1
    midi.instruments.append(inst)

    out = Path(output_midi_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        midi.write(str(out))
    except Exception as e:
        log.warning("drums: MIDI write failed for %s: %s", out, e)
        return {"ok": False, "engine": ENGINE_NAME, "error": repr(e)}

    return {
        "ok": True,
        "engine": ENGINE_NAME,
        "engine_version": ENGINE_VERSION,
        "notes_count": len(inst.notes),
        "onsets": len(features),
        "per_class": per_class,
        "bpm": bpm_used,
    }
