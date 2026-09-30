"""The measurements behind the editor tools. No FastAPI, no I/O of its own
beyond ``backend/lib/audio_io.py`` and the ffmpeg command this builds.

Four jobs, each a plain function over a decoded clip or over plain numbers:

* :func:`analyze_clip` — duration, sample rate, channels, peak/RMS in dBFS,
  tempo (beats included), onsets, key.
* :func:`detect_tempo` — the tempo half of the above on its own.
* :func:`compare_timing` — MIDI note starts against audio onsets, greedy
  nearest-neighbour inside a window, reported as the offset to nudge by.
* :func:`stretch_filter` — the ``atempo`` chain for a duration ratio.

**Tempo comes from the rhythm module** (``rhythm.engine.analyze_file``): it
already tracks a tempo CURVE with change points, which is a better reading
than anything a second implementation would produce. It refuses clips under
four seconds, though, and a clip tool cannot — a two-second selection is an
ordinary thing to ask about — so :func:`detect_tempo` falls back to librosa's
beat tracker over the same fine-hop onset envelope the onsets come from. The
fallback is marked only by the shorter beat list; the shape never changes.

**Onsets run at hop 128 / n_fft 512** (5.8 ms a frame at 22.05 kHz), not the
rhythm engine's hop 512. At hop 512 a frame is 23 ms and the reported onset
can sit 12 ms from the transient before anything is wrong; the whole point of
comparing MIDI against onsets is that tens of milliseconds matter.
"""

from __future__ import annotations

import logging
import math
from pathlib import Path
from typing import Any, Optional

import numpy as np

from backend.lib.audio_io import load_audio_array, save_audio

log = logging.getLogger(__name__)

EDITOR_TOOLS_VERSION = 1

#: Everything downstream of the decode runs mono at this rate — the rate the
#: rhythm engine and the key detector already use, so no extra resample.
ANALYSIS_SR = 22050
ONSET_HOP = 128
ONSET_N_FFT = 512

#: dBFS floor for digital silence, so the payload is always JSON-serializable
#: (``-inf`` is not).
DB_FLOOR = -120.0

#: ``ratio`` is new_duration / old_duration.
RATIO_MIN = 0.25
RATIO_MAX = 4.0
#: ffmpeg's ``atempo`` accepts one factor in this range; anything further is a
#: chain of stages whose product is the factor asked for.
ATEMPO_MIN = 0.5
ATEMPO_MAX = 2.0

DEFAULT_MAX_MATCH_SEC = 0.12

#: The relative median-absolute-deviation of the inter-beat intervals at which
#: tempo confidence reaches 0. 10 % of a beat is a grid nothing would follow.
_BEAT_SPREAD_ZERO = 0.10

#: The rhythm engine's own floor (``_MIN_DURATION_SEC``), duplicated as the
#: threshold for reaching past it rather than imported: this decides when to
#: fall back, which is this module's policy, not the rhythm module's.
_RHYTHM_MIN_SEC = 4.0


class DecodeError(ValueError):
    """The bytes handed in are not audio anything installed can decode."""


# --------------------------------------------------------------- decoding


def load_clip(path: str | Path) -> tuple[np.ndarray, int]:
    """Decode to ``(float32 [channels, frames], samplerate)``.

    libsndfile first and the ffmpeg CLI after, both inside
    ``backend/lib/audio_io.py`` — never ``torchaudio.load``, which needs
    torchcodec's FFmpeg shared libraries and has none on Windows.
    """
    try:
        audio, sr = load_audio_array(path)
    except Exception as exc:  # noqa: BLE001 — libsndfile and ffmpeg raise different types
        raise DecodeError(str(exc)) from exc
    if audio.size == 0 or sr <= 0:
        raise DecodeError("the file decoded to no audio")
    return audio, int(sr)


def to_analysis_mono(audio: np.ndarray, sr: int) -> np.ndarray:
    """Downmix and resample to mono at :data:`ANALYSIS_SR`."""
    import librosa

    mono = np.ascontiguousarray(audio.mean(axis=0), dtype=np.float32)
    if sr == ANALYSIS_SR:
        return mono
    return np.ascontiguousarray(
        librosa.resample(mono, orig_sr=sr, target_sr=ANALYSIS_SR), dtype=np.float32
    )


def _db(amplitude: float) -> float:
    if not math.isfinite(amplitude) or amplitude <= 0.0:
        return DB_FLOOR
    return max(DB_FLOOR, 20.0 * math.log10(amplitude))


# ----------------------------------------------------------------- onsets


def onset_envelope(mono: np.ndarray) -> np.ndarray:
    import librosa

    return librosa.onset.onset_strength(
        y=mono, sr=ANALYSIS_SR, hop_length=ONSET_HOP, n_fft=ONSET_N_FFT
    )


def detect_onsets(
    mono: np.ndarray, envelope: Optional[np.ndarray] = None
) -> list[float]:
    """Onset times in seconds.

    ``backtrack=True`` walks each peak back to the local minimum before it, so
    the time reported is where the transient STARTS rather than where the
    envelope crested — which is what a note start is being compared against.
    """
    import librosa

    if mono.size < ONSET_N_FFT:
        return []
    env = onset_envelope(mono) if envelope is None else envelope
    times = librosa.onset.onset_detect(
        onset_envelope=env,
        sr=ANALYSIS_SR,
        hop_length=ONSET_HOP,
        units="time",
        backtrack=True,
    )
    return [round(float(t), 4) for t in np.atleast_1d(times)]


# ------------------------------------------------------------------ tempo


def beat_confidence(beats: list[float]) -> float:
    """How evenly spaced the beats are, in ``[0, 1]``.

    Relative median absolute deviation of the inter-beat intervals, mapped so
    that a perfectly regular grid is 1.0 and a spread of
    :data:`_BEAT_SPREAD_ZERO` of a beat is 0.0. The median keeps a single
    dropped or doubled beat from dominating the reading the way a standard
    deviation would.
    """
    if len(beats) < 3:
        return 0.0
    intervals = np.diff(np.asarray(beats, dtype=np.float64))
    median = float(np.median(intervals))
    if median <= 0.0:
        return 0.0
    spread = float(np.median(np.abs(intervals - median))) / median
    return round(float(np.clip(1.0 - spread / _BEAT_SPREAD_ZERO, 0.0, 1.0)), 4)


def _tempo_from_rhythm(path: Path) -> Optional[dict[str, Any]]:
    from backend.modules.rhythm.engine import analyze_file

    try:
        result = analyze_file(path)
    except Exception as exc:  # noqa: BLE001 — a refusal here is a fallback, not a 500
        log.info("editor_tools: rhythm analysis failed for %s (%s)", path.name, exc)
        return None
    bpm = result.get("tempo", {}).get("bpm")
    if bpm is None:
        log.info(
            "editor_tools: rhythm read no tempo for %s (%s)",
            path.name,
            result.get("diagnostics", {}).get("reason"),
        )
        return None
    beats = [round(float(t), 4) for t in result.get("beats", [])]
    return {
        "bpm": round(float(bpm), 2),
        "confidence": beat_confidence(beats),
        "beats": beats,
    }


def _tempo_from_envelope(envelope: np.ndarray) -> dict[str, Any]:
    """librosa's beat tracker over the fine-hop onset envelope.

    Only reached for clips the rhythm engine will not read (under four
    seconds, or too few beats for its meter machinery).
    """
    import librosa

    if envelope.size < 4:
        return {"bpm": None, "confidence": 0.0, "beats": []}
    bpm, frames = librosa.beat.beat_track(
        onset_envelope=envelope, sr=ANALYSIS_SR, hop_length=ONSET_HOP, units="frames"
    )
    bpm_value = float(np.atleast_1d(bpm)[0])
    if not math.isfinite(bpm_value) or bpm_value <= 0.0:
        return {"bpm": None, "confidence": 0.0, "beats": []}
    times = librosa.frames_to_time(
        np.atleast_1d(frames), sr=ANALYSIS_SR, hop_length=ONSET_HOP
    )
    beats = [round(float(t), 4) for t in times]
    return {
        "bpm": round(bpm_value, 2),
        "confidence": beat_confidence(beats),
        "beats": beats,
    }


def tempo_of(path: Path, mono: np.ndarray, envelope: np.ndarray) -> dict[str, Any]:
    """``{bpm, confidence, beats}``. The rhythm engine when it will answer,
    librosa's beat tracker when the clip is shorter than it accepts."""
    if mono.size / ANALYSIS_SR >= _RHYTHM_MIN_SEC:
        reading = _tempo_from_rhythm(path)
        if reading is not None:
            return reading
    return _tempo_from_envelope(envelope)


# -------------------------------------------------------------------- key


def key_of(path: Path, mono: np.ndarray) -> Optional[dict[str, Any]]:
    """``{root, scale, confidence}`` from the analysis module's chroma +
    Krumhansl-Schmuckler detector, or ``None`` when it cannot decide.

    ``confidence`` there is a Pearson correlation in ``[-1, 1]``; a negative
    one means the winning profile still fits worse than chance, which is not
    a key, so it is reported as no key at all.
    """
    from backend.modules.analysis.key import detect_key

    found = detect_key(path, y_sr=(mono, ANALYSIS_SR))
    root, scale, confidence = found["key"], found["scale"], found["confidence"]
    if root is None or scale is None or confidence is None:
        return None
    if float(confidence) <= 0.0:
        return None
    return {
        "root": str(root),
        "scale": str(scale),
        "confidence": round(float(confidence), 4),
    }


# ------------------------------------------------------------ the payloads


def analyze_clip(path: str | Path) -> dict[str, Any]:
    """The full ``POST /analyze`` payload for a decoded file on disk."""
    p = Path(path)
    audio, sr = load_clip(p)
    mono = to_analysis_mono(audio, sr)
    envelope = onset_envelope(mono) if mono.size >= ONSET_N_FFT else np.zeros(0)
    peak = float(np.abs(audio).max())
    rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))
    return {
        "durationSec": round(audio.shape[1] / sr, 4),
        "sampleRate": int(sr),
        "channels": int(audio.shape[0]),
        "peakDb": round(_db(peak), 2),
        "rmsDb": round(_db(rms), 2),
        "tempo": tempo_of(p, mono, envelope),
        "onsets": detect_onsets(mono, envelope),
        "key": key_of(p, mono),
    }


def analyze_clip_at_rate(path: str | Path, sample_rate: int) -> dict[str, Any]:
    """:func:`analyze_clip` with the file's declared rate overridden.

    ``sample_rate_hint`` is a HEADER OVERRIDE, not a resample: the decoded
    samples are re-timed at ``sample_rate``, so every second the payload
    reports — duration, beats, onsets — is a second at that rate. It exists
    for clips whose container lies about the rate, which is what a raw dump
    re-wrapped as WAV usually is. Passing the rate the file already declares
    changes nothing.

    The re-timed copy is written beside the source (both live in the caller's
    temp directory) because the rhythm engine and the key detector both take
    a PATH, and re-decoding a float WAV is lossless.
    """
    p = Path(path)
    audio, decoded_sr = load_clip(p)
    if int(sample_rate) == decoded_sr:
        return analyze_clip(p)
    rehinted = p.parent / f"rehinted_{int(sample_rate)}.wav"
    save_audio(rehinted, audio, int(sample_rate), subtype="FLOAT")
    try:
        return analyze_clip(rehinted)
    finally:
        rehinted.unlink(missing_ok=True)


def detect_tempo(path: str | Path) -> dict[str, Any]:
    """``{bpm, confidence, beats}`` — the tempo half of :func:`analyze_clip`,
    byte-identical to the ``tempo`` block it returns."""
    p = Path(path)
    audio, sr = load_clip(p)
    mono = to_analysis_mono(audio, sr)
    envelope = onset_envelope(mono) if mono.size >= ONSET_N_FFT else np.zeros(0)
    return tempo_of(p, mono, envelope)


def onsets_of(path: str | Path) -> list[float]:
    audio, sr = load_clip(Path(path))
    return detect_onsets(to_analysis_mono(audio, sr))


# --------------------------------------------------------- timing compare


def compare_timing(
    onsets: list[float],
    note_starts: list[float],
    max_match_sec: float = DEFAULT_MAX_MATCH_SEC,
) -> dict[str, Any]:
    """Match MIDI note starts to audio onsets and report the offset to nudge by.

    ``delta = onset - note``: the sign is audio MINUS MIDI, so a POSITIVE
    median means the audio event happens after the note and the MIDI should
    move LATER; a negative median means the MIDI is late and should move
    earlier. It is the number you add to every note start.

    Matching is greedy over the globally closest pair first, and each onset is
    consumed once — two notes inside the window of a single onset cannot both
    claim it, which would otherwise fabricate a match for a note the audio
    never plays.
    """
    window = max(0.0, float(max_match_sec))
    notes = [float(n) for n in note_starts]
    sorted_onsets = np.sort(np.asarray([float(o) for o in onsets], dtype=np.float64))

    candidates: list[tuple[float, int, int]] = []
    if sorted_onsets.size:
        for note_idx, note in enumerate(notes):
            lo = int(np.searchsorted(sorted_onsets, note - window, side="left"))
            hi = int(np.searchsorted(sorted_onsets, note + window, side="right"))
            for onset_idx in range(lo, hi):
                delta = float(sorted_onsets[onset_idx]) - note
                candidates.append((abs(delta), note_idx, onset_idx))
    candidates.sort()

    matched_onset: dict[int, int] = {}
    taken: set[int] = set()
    for _, note_idx, onset_idx in candidates:
        if note_idx in matched_onset or onset_idx in taken:
            continue
        matched_onset[note_idx] = onset_idx
        taken.add(onset_idx)

    per_note: list[dict[str, Optional[float]]] = []
    deltas: list[float] = []
    for note_idx, note in enumerate(notes):
        onset_idx = matched_onset.get(note_idx)
        if onset_idx is None:
            per_note.append({"noteSec": note, "onsetSec": None, "deltaSec": None})
            continue
        onset = float(sorted_onsets[onset_idx])
        delta = onset - note
        deltas.append(delta)
        per_note.append(
            {
                "noteSec": note,
                "onsetSec": round(onset, 4),
                "deltaSec": round(delta, 4),
            }
        )

    return {
        "medianOffsetSec": round(float(np.median(deltas)), 4) if deltas else None,
        "meanOffsetSec": round(float(np.mean(deltas)), 4) if deltas else None,
        "matched": len(deltas),
        "unmatchedNotes": len(notes) - len(deltas),
        "perNote": per_note,
    }


# ----------------------------------------------------------------- stretch


def resolve_ratio(
    ratio: Optional[float],
    source_bpm: Optional[float] = None,
    target_bpm: Optional[float] = None,
) -> float:
    """The duration ratio (new / old) from either an explicit ratio or a pair
    of tempos.

    A clip at ``source_bpm`` played at ``target_bpm`` lasts
    ``source_bpm / target_bpm`` times as long: audio cut to a 120 BPM
    arrangement, warped onto MIDI authored at 99, gets longer by 120/99.
    """
    if ratio is not None:
        value = float(ratio)
    elif source_bpm is not None and target_bpm is not None:
        src, tgt = float(source_bpm), float(target_bpm)
        if not (math.isfinite(src) and math.isfinite(tgt)) or src <= 0 or tgt <= 0:
            raise ValueError("source_bpm and target_bpm must both be positive")
        value = src / tgt
    else:
        raise ValueError("pass either ratio, or both source_bpm and target_bpm")
    if not math.isfinite(value) or not RATIO_MIN <= value <= RATIO_MAX:
        raise ValueError(
            f"ratio {value:g} is outside the supported range "
            f"{RATIO_MIN:g}..{RATIO_MAX:g}"
        )
    return value


def atempo_chain(speed: float) -> list[float]:
    """Factors whose product is ``speed``, each inside ffmpeg's 0.5..2.0.

    ``atempo`` rejects anything outside that range per stage, so a 4x change
    is two stages. Whole stages are emitted first so the remainder — the one
    factor that is not a power of two — stays exact.
    """
    factors: list[float] = []
    remaining = float(speed)
    while remaining > ATEMPO_MAX:
        factors.append(ATEMPO_MAX)
        remaining /= ATEMPO_MAX
    while remaining < ATEMPO_MIN:
        factors.append(ATEMPO_MIN)
        remaining /= ATEMPO_MIN
    factors.append(remaining)
    return factors


def stretch_filter(ratio: float) -> str:
    """The ``-filter:a`` string that makes a clip ``ratio`` times as long.

    ``atempo`` takes a SPEED, which is the reciprocal of a duration ratio: to
    make audio longer it has to play slower. It is a time-domain (WSOLA)
    stretch, so the pitch does not move.
    """
    return ",".join(f"atempo={f:.9f}" for f in atempo_chain(1.0 / float(ratio)))
