"""Chord track builder: ``gantasmo.chordtrack`` JSON for the SCORE chord strip.

Two sources, one schema:

- **harmony** — a lead-sheet MusicXML whose ``<harmony>`` elements music21
  parses as :class:`~music21.harmony.ChordSymbol`. Exact and authoritative:
  offsets are converted through the same piecewise tempo map the note chart
  uses, so a chord block lands where the engraved chord does.
- **chroma** — the recording itself. ``librosa`` chroma (CQT) is pooled per
  beat, scored against weighted chord templates, and decoded with a sticky
  Viterbi so a chord has to earn a change. The analysis row (bpm, beats, key,
  scale) seeds the beat grid and a key prior; when it is absent the beat
  tracker runs here and the prior is skipped. No new dependencies.

The output carries BOTH the MusicXML chord ``kind`` vocabulary (``major``,
``dominant-seventh``, …) and the sounding ``pitchClasses``, so a consumer can
colour by kind without an interval table and voice a diagram without a chord
parser. Documents never contain ``null``: every optional value has a typed
sentinel (``-1`` for no bass, ``""`` for an unknown tonic, ``[]`` for N.C.).

``startBeat`` / ``endBeat`` are beats from the start of the piece in the same
unit as ``timing.beats`` indexes: quarter-note offsets for the harmony source,
beat-grid indexes for the chroma source. ``startSec`` / ``endSec`` are the
invariant the strip animates from.
"""

from __future__ import annotations

import json
import logging
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .notechart import (
    FALLBACK_BPM,
    _expand_repeats,
    _f,
    _first_null_path,
    _measure_grid,
    _measure_lookup,
    _round_tree,
    _s,
    _seconds_from_beats,
    _tempo_map,
)

log = logging.getLogger(__name__)

SCHEMA = "gantasmo.chordtrack"
SCHEMA_VERSION = 1
ENGINE = "chordtrack"

METHODS = ("auto", "harmony", "chroma")
RESOLUTIONS = ("beat", "bar")

# Sample rate and hop for the chroma path. 22050 / 2048 gives ~93 ms frames,
# fine enough for beat pooling and cheap enough for a multi-minute track.
_SR = 22050
_HOP = 2048
_N_OCTAVES = 6

# Viterbi: the chance of staying on the current chord from one beat to the next.
# The remaining mass is spread evenly over every other state.
_STAY_PROB = 0.9
# Cosine similarity lives in [0, 1]; it is scaled into the log domain so one
# beat of clear evidence (a ~0.4 similarity gap) is worth about one switch.
_EMISSION_WEIGHT = 12.0
# Extra log-score for triads diatonic to the analysed key.
_KEY_PRIOR = 0.08 * _EMISSION_WEIGHT

_SHARP_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
_FLAT_NAMES = ("C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B")
_PC_OF_LETTER = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

# Key tonics whose chord spellings lean flat, by mode.
_FLAT_MAJOR_TONICS = frozenset({5, 10, 3, 8, 1, 6})  # F Bb Eb Ab Db Gb
_FLAT_MINOR_TONICS = frozenset({2, 7, 0, 5, 10, 3})  # D G C F Bb Eb

# Chord kind (MusicXML vocabulary) -> (intervals, template weights, symbol suffix)
_KIND_INTERVALS: dict[str, tuple[tuple[int, ...], tuple[float, ...], str]] = {
    "major": ((0, 4, 7), (1.0, 0.8, 0.6), ""),
    "minor": ((0, 3, 7), (1.0, 0.8, 0.6), "m"),
    "dominant-seventh": ((0, 4, 7, 10), (1.0, 0.8, 0.6, 0.5), "7"),
    "minor-seventh": ((0, 3, 7, 10), (1.0, 0.8, 0.6, 0.5), "m7"),
    "major-seventh": ((0, 4, 7, 11), (1.0, 0.8, 0.6, 0.5), "maj7"),
    "diminished": ((0, 3, 6), (1.0, 0.8, 0.6), "dim"),
    "augmented": ((0, 4, 8), (1.0, 0.8, 0.6), "aug"),
    "suspended-fourth": ((0, 5, 7), (1.0, 0.8, 0.6), "sus4"),
    "power": ((0, 7), (1.0, 0.6), "5"),
}
_TRIAD_KINDS = ("major", "minor")
_SEVENTH_KINDS = ("dominant-seventh", "minor-seventh", "major-seventh")
_NO_CHORD = "N"


# --------------------------------------------------------------------------
# public API
# --------------------------------------------------------------------------


def build_chordtrack(
    *,
    entry_id: str,
    audio_path: Path | None,
    analysis_row: dict[str, Any] | None,
    lead_sheet_path: Path | None,
    method: str = "auto",
    include_sevenths: bool = True,
    resolution: str = "beat",
    source_artifact_id: str = "",
) -> dict[str, Any]:
    """Build a ``gantasmo.chordtrack`` document.

    ``method`` ``'auto'`` prefers the lead sheet when it carries at least two
    chord symbols and falls back to the audio otherwise. Raises ``ValueError``
    when no chords can be derived from the sources given.
    """
    method = (method or "auto").lower().strip()
    if method not in METHODS:
        raise ValueError(f"unknown chord method {method!r}; expected one of {METHODS}")
    resolution = (resolution or "beat").lower().strip()
    if resolution not in RESOLUTIONS:
        raise ValueError(
            f"unknown resolution {resolution!r}; expected one of {RESOLUTIONS}"
        )
    analysis = dict(analysis_row or {})

    harmony_doc: Optional[dict[str, Any]] = None
    harmony_error = ""
    if method in ("auto", "harmony") and lead_sheet_path is not None:
        try:
            harmony_doc = _from_harmony(lead_sheet_path, analysis, resolution)
        except Exception as exc:  # noqa: BLE001 - fall through to chroma / report
            harmony_error = repr(exc)
            log.debug("chordtrack: harmony source failed: %s", exc)
            harmony_doc = None

    chosen: Optional[dict[str, Any]] = None
    if method == "harmony":
        if harmony_doc is None or not harmony_doc["chords"]:
            raise ValueError(
                "no chord symbols found in the lead sheet"
                + (f" ({harmony_error})" if harmony_error else "")
            )
        chosen = harmony_doc
    elif method == "chroma":
        if audio_path is None or not Path(audio_path).is_file():
            raise ValueError("chroma chord estimation needs an audio file")
        chosen = _from_chroma(Path(audio_path), analysis, include_sevenths, resolution)
    else:  # auto
        enough = harmony_doc is not None and len(harmony_doc["chords"]) >= 2
        if enough:
            chosen = harmony_doc
        elif audio_path is not None and Path(audio_path).is_file():
            chosen = _from_chroma(
                Path(audio_path), analysis, include_sevenths, resolution
            )
        elif harmony_doc is not None and harmony_doc["chords"]:
            chosen = harmony_doc
        else:
            raise ValueError(
                "no chord source: the lead sheet has no chord symbols and there "
                "is no audio to estimate from"
            )

    if chosen is None or not chosen["chords"]:
        raise ValueError("no chords could be derived")

    chords = chosen["chords"]
    for index, chord in enumerate(chords):
        chord["id"] = index
    symbols = {c["symbol"] for c in chords}
    mean_conf = sum(_f(c["confidence"]) for c in chords) / len(chords)

    doc = {
        "schema": SCHEMA,
        "schemaVersion": SCHEMA_VERSION,
        "generator": _generator_string(chosen["method"]),
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": {
            "entryId": _s(entry_id),
            "method": chosen["method"],
            "sourceArtifactId": _s(source_artifact_id),
        },
        "timing": chosen["timing"],
        "key": chosen["key"],
        "chords": chords,
        "stats": {
            "chordCount": len(chords),
            "distinctSymbols": len(symbols),
            "meanConfidence": mean_conf,
        },
    }
    return _round_tree(doc)


def write_chordtrack(output_path: Path, **build_kwargs: Any) -> dict[str, Any]:
    """Build, write, re-read and self-validate a chord track.

    Never raises into the route: every failure comes back as
    ``{"ok": False, "error": ...}`` so the caller can 501 with the dict.
    """
    try:
        doc = build_chordtrack(**build_kwargs)
    except Exception as exc:  # noqa: BLE001 - report, never raise into the route
        log.warning("chordtrack: build failed: %s", exc)
        return {"ok": False, "engine": ENGINE, "error": repr(exc)}

    null_path = _first_null_path(doc)
    if null_path:
        return {
            "ok": False,
            "engine": ENGINE,
            "error": f"chord track carries a null at {null_path}",
        }

    try:
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(
            json.dumps(doc, ensure_ascii=False, separators=(",", ":"), allow_nan=False),
            encoding="utf-8",
        )
        check = json.loads(output_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return {
            "ok": False,
            "engine": ENGINE,
            "error": f"chord track unwritable: {exc!r}",
        }

    if check.get("schemaVersion") != SCHEMA_VERSION or not check.get("chords"):
        return {
            "ok": False,
            "engine": ENGINE,
            "error": "chord track failed self-validation (schemaVersion or chords)",
        }

    return {
        "ok": True,
        "path": str(output_path),
        "engine": ENGINE,
        "engine_version": str(SCHEMA_VERSION),
        "schema_version": SCHEMA_VERSION,
        "stats": doc["stats"],
        "method": doc["source"]["method"],
    }


# --------------------------------------------------------------------------
# shared helpers
# --------------------------------------------------------------------------


def _generator_string(method: str) -> str:
    parts = [f"theDAW chordtrack {SCHEMA_VERSION}"]
    try:
        if method == "harmony":
            import music21  # type: ignore[import]

            parts.append(f"music21 {getattr(music21, '__version__', 'unknown')}")
        else:
            import librosa  # type: ignore[import]

            parts.append(f"librosa {getattr(librosa, '__version__', 'unknown')}")
    except ImportError:
        pass
    return " / ".join(parts)


def _parse_key_name(text: Any) -> int:
    """Pitch class of a key/root name such as ``C#``, ``Bb``, ``B-``; -1 if unknown."""
    name = _s(text).strip()
    if not name:
        return -1
    letter = name[0].upper()
    if letter not in _PC_OF_LETTER:
        return -1
    pc = _PC_OF_LETTER[letter]
    for ch in name[1:]:
        if ch == "#":
            pc += 1
        elif ch in ("b", "-"):
            pc -= 1
        else:
            break
    return pc % 12


def _analysis_key(analysis: dict[str, Any]) -> tuple[int, str, float]:
    """(tonic pc or -1, mode or '', confidence 0..1) from an analysis row."""
    tonic = _parse_key_name(analysis.get("key"))
    mode = _s(analysis.get("scale")).lower().strip()
    if mode not in ("major", "minor"):
        mode = ""
    confidence = _f(analysis.get("key_confidence"))
    confidence = min(1.0, max(0.0, confidence))
    if tonic < 0:
        return -1, mode, 0.0
    return tonic, mode, confidence


def _prefer_flats(tonic_pc: int, mode: str) -> bool:
    if tonic_pc < 0:
        return False
    if mode == "minor":
        return tonic_pc in _FLAT_MINOR_TONICS
    return tonic_pc in _FLAT_MAJOR_TONICS


def _pc_name(pc: int, flats: bool) -> str:
    names = _FLAT_NAMES if flats else _SHARP_NAMES
    return names[pc % 12]


def _analysis_beats(analysis: dict[str, Any]) -> list[float]:
    """Strictly increasing, finite beat times from ``beats_json``; [] when unusable."""
    raw = analysis.get("beats_json")
    if raw in (None, ""):
        raw = analysis.get("beats")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return []
    if not isinstance(raw, list):
        return []
    beats: list[float] = []
    for value in raw:
        sec = _f(value, float("nan"))
        if not math.isfinite(sec) or sec < 0:
            continue
        if beats and sec <= beats[-1] + 1e-6:
            continue
        beats.append(sec)
    return beats if len(beats) >= 2 else []


def _synth_beats(bpm: float, duration_sec: float) -> list[float]:
    """A metronomic beat grid at ``bpm`` covering ``duration_sec``."""
    bpm = bpm if bpm > 0 else FALLBACK_BPM
    step = 60.0 / bpm
    count = max(2, int(math.floor(duration_sec / step + 1e-9)) + 1)
    return [i * step for i in range(count)]


def _merge_equal(chords: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse consecutive spans with the same symbol into one span."""
    merged: list[dict[str, Any]] = []
    for chord in chords:
        if merged and merged[-1]["symbol"] == chord["symbol"]:
            prev = merged[-1]
            total = (prev["endSec"] - prev["startSec"]) + (
                chord["endSec"] - chord["startSec"]
            )
            if total > 0:
                prev["confidence"] = (
                    prev["confidence"] * (prev["endSec"] - prev["startSec"])
                    + chord["confidence"] * (chord["endSec"] - chord["startSec"])
                ) / total
            prev["endSec"] = chord["endSec"]
            prev["endBeat"] = chord["endBeat"]
            continue
        merged.append(dict(chord))
    return merged


def _span(
    *,
    start_sec: float,
    end_sec: float,
    start_beat: float,
    end_beat: float,
    measure: int,
    symbol: str,
    root: str,
    root_pc: int,
    kind: str,
    bass_pc: int,
    pitch_classes: list[int],
    confidence: float,
) -> dict[str, Any]:
    return {
        "id": 0,
        "startSec": float(start_sec),
        "endSec": float(end_sec),
        "startBeat": float(start_beat),
        "endBeat": float(end_beat),
        "measure": int(measure),
        "symbol": _s(symbol),
        "root": _s(root),
        "rootPc": int(root_pc),
        "kind": _s(kind) or "major",
        "bassPc": int(bass_pc),
        "pitchClasses": [int(p) for p in pitch_classes],
        "confidence": float(min(1.0, max(0.0, confidence))),
    }


# --------------------------------------------------------------------------
# harmony source (lead sheet <harmony> via music21)
# --------------------------------------------------------------------------

_FIGURE_FLAT = re.compile(r"(^|/)([A-Ga-g])-")


def _display_figure(figure: str) -> str:
    """music21 spells flats with ``-`` (``B-7``); players read ``Bb7``."""
    return _FIGURE_FLAT.sub(lambda m: f"{m.group(1)}{m.group(2)}b", _s(figure))


def _score_key(score: Any) -> tuple[int, str, float]:
    """(tonic pc, mode, confidence) from the first key signature; (-1, '', 0) if none."""
    from music21 import key as m21key  # type: ignore[import]

    for element in score.flatten().getElementsByClass(m21key.KeySignature):
        try:
            k = element if isinstance(element, m21key.Key) else element.asKey("major")
            tonic = getattr(k, "tonic", None)
            if tonic is None:
                continue
            mode = _s(getattr(k, "mode", "major")).lower()
            if mode not in ("major", "minor"):
                mode = "major"
            return int(tonic.pitchClass), mode, 1.0
        except Exception:  # noqa: BLE001 - a malformed signature is not fatal
            continue
    return -1, "", 0.0


def _beats_per_bar(score: Any) -> int:
    from music21 import meter as m21meter  # type: ignore[import]

    for ts in score.flatten().getElementsByClass(m21meter.TimeSignature):
        try:
            # Quarter-note beats per bar (6/8 -> 3), matching the quarter-length
            # tempo map every other number here uses.
            per_bar = float(ts.barDuration.quarterLength)
        except Exception:  # noqa: BLE001
            continue
        if per_bar > 0:
            return max(1, int(round(per_bar)))
    return 4


def _from_harmony(
    lead_sheet_path: Path, analysis: dict[str, Any], resolution: str
) -> dict[str, Any]:
    from music21 import converter, harmony  # type: ignore[import]

    score = converter.parse(str(lead_sheet_path))
    score = _expand_repeats(score)
    tempo_entries = _tempo_map(score, 480)
    to_sec = _seconds_from_beats(tempo_entries)
    grid = _measure_grid(score)
    measure_of = _measure_lookup(grid)
    beats_per_bar = _beats_per_bar(score)
    total_beats = _f(getattr(score, "highestTime", 0.0))

    raw: list[tuple[float, Any]] = []
    for cs in score.flatten().getElementsByClass(harmony.ChordSymbol):
        try:
            if not cs.pitches or cs.root() is None:
                continue
        except Exception:  # noqa: BLE001 - an unidentifiable symbol is skipped
            continue
        raw.append((_f(cs.offset), cs))
    raw.sort(key=lambda item: item[0])

    if raw:
        total_beats = max(total_beats, raw[-1][0] + float(beats_per_bar))

    if resolution == "bar" and grid:
        starts = [offset for _, offset, _, _ in grid]
        snapped: list[tuple[float, Any]] = []
        for offset, cs in raw:
            nearest = min(starts, key=lambda s: abs(s - offset))
            snapped.append((nearest, cs))
        # Two symbols snapped to the same bar: the later one wins the bar.
        by_bar: dict[float, Any] = {}
        for offset, cs in snapped:
            by_bar[offset] = cs
        raw = sorted(by_bar.items(), key=lambda item: item[0])

    chords: list[dict[str, Any]] = []
    for index, (offset, cs) in enumerate(raw):
        next_offset = raw[index + 1][0] if index + 1 < len(raw) else total_beats
        if next_offset <= offset:
            next_offset = offset + float(beats_per_bar)
        root = cs.root()
        root_pc = int(root.pitchClass)
        bass = cs.bass()
        bass_pc = -1
        if bass is not None and int(bass.pitchClass) != root_pc:
            bass_pc = int(bass.pitchClass)
        others = sorted({int(p.pitchClass) for p in cs.pitches} - {root_pc})
        kind = _s(getattr(cs, "chordKind", "")) or "major"
        chords.append(
            _span(
                start_sec=to_sec(offset),
                end_sec=to_sec(next_offset),
                start_beat=offset,
                end_beat=next_offset,
                measure=measure_of(offset),
                symbol=_display_figure(cs.figure) or _display_figure(root.name),
                root=_display_figure(root.name),
                root_pc=root_pc,
                kind=kind,
                bass_pc=bass_pc,
                pitch_classes=[root_pc] + others,
                confidence=1.0,
            )
        )
    chords = _merge_equal(chords)

    duration_sec = to_sec(total_beats)
    tonic, mode, key_conf = _score_key(score)
    if tonic < 0:
        tonic, mode, key_conf = _analysis_key(analysis)

    analysis_beats = _analysis_beats(analysis)
    analysis_bpm = _f(analysis.get("bpm"))
    if analysis_beats and analysis_bpm > 0:
        bpm = analysis_bpm
        beats = analysis_beats
        downbeats = beats[::beats_per_bar]
    else:
        bpm = _f(tempo_entries[0]["bpm"], FALLBACK_BPM)
        beat_count = max(2, int(math.ceil(total_beats - 1e-9)) + 1)
        beats = [to_sec(float(b)) for b in range(beat_count)]
        downbeats = [to_sec(float(b)) for b in range(0, beat_count, beats_per_bar)]

    return {
        "method": "harmony",
        "chords": chords,
        "timing": {
            "bpm": float(bpm),
            "beats": [float(b) for b in beats],
            "downbeats": [float(b) for b in downbeats],
            "beatsPerBar": int(beats_per_bar),
            "durationSec": float(duration_sec),
        },
        "key": {
            "tonic": _pc_name(tonic, _prefer_flats(tonic, mode)) if tonic >= 0 else "",
            "mode": mode,
            "confidence": float(key_conf),
        },
    }


# --------------------------------------------------------------------------
# chroma source (audio -> templates -> Viterbi)
# --------------------------------------------------------------------------


def _templates(include_sevenths: bool) -> tuple[list[tuple[int, str]], Any]:
    """(state labels, unit-norm template matrix [states x 12]).

    State labels are ``(root_pc, kind)``; the trailing state is ``(-1, 'N')``.
    """
    import numpy as np

    kinds = list(_TRIAD_KINDS) + (list(_SEVENTH_KINDS) if include_sevenths else [])
    labels: list[tuple[int, str]] = []
    rows: list[Any] = []
    for kind in kinds:
        intervals, weights, _ = _KIND_INTERVALS[kind]
        for root in range(12):
            vec = np.zeros(12, dtype=np.float64)
            for interval, weight in zip(intervals, weights):
                vec[(root + interval) % 12] = weight
            rows.append(vec / np.linalg.norm(vec))
            labels.append((root, kind))
    flat = np.full(12, 1.0 / 12.0)
    rows.append(flat / np.linalg.norm(flat))
    labels.append((-1, _NO_CHORD))
    return labels, np.vstack(rows)


def _key_prior_vector(labels: list[tuple[int, str]], tonic: int, mode: str) -> Any:
    import numpy as np

    prior = np.zeros(len(labels), dtype=np.float64)
    if tonic < 0 or mode not in ("major", "minor"):
        return prior
    if mode == "major":
        majors = {tonic % 12, (tonic + 5) % 12, (tonic + 7) % 12}
        minors = {(tonic + 2) % 12, (tonic + 4) % 12, (tonic + 9) % 12}
    else:
        minors = {tonic % 12, (tonic + 5) % 12, (tonic + 7) % 12}
        majors = {(tonic + 3) % 12, (tonic + 8) % 12, (tonic + 10) % 12}
    for index, (root, kind) in enumerate(labels):
        if (kind == "major" and root in majors) or (kind == "minor" and root in minors):
            prior[index] = _KEY_PRIOR
    return prior


def _viterbi(log_emission: Any, stay: float, switch: float) -> list[int]:
    """Most likely state path for a [T x N] log-emission matrix."""
    import numpy as np

    steps, states = log_emission.shape
    if steps == 0:
        return []
    log_stay = math.log(stay)
    log_switch = math.log(switch)
    score = log_emission[0].copy()
    back = np.zeros((steps, states), dtype=np.int64)
    for t in range(1, steps):
        # Either stay (diagonal) or come from the best other state.
        best_prev = int(np.argmax(score))
        best_val = score[best_prev] + log_switch
        stay_val = score + log_stay
        prev = np.full(states, best_prev, dtype=np.int64)
        use_stay = stay_val >= best_val
        prev[use_stay] = np.arange(states)[use_stay]
        score = np.where(use_stay, stay_val, best_val) + log_emission[t]
        back[t] = prev
    path = [int(np.argmax(score))]
    for t in range(steps - 1, 0, -1):
        path.append(int(back[t][path[-1]]))
    path.reverse()
    return path


def _pool_chroma(chroma: Any, boundaries_sec: list[float], sr: int, hop: int) -> Any:
    """Median chroma per segment, L1-normalised; segments are consecutive
    ``boundaries_sec`` pairs. Empty segments borrow their nearest frame."""
    import numpy as np

    frames = chroma.shape[1]
    columns: list[Any] = []
    for index in range(len(boundaries_sec) - 1):
        start = int(round(boundaries_sec[index] * sr / hop))
        end = int(round(boundaries_sec[index + 1] * sr / hop))
        start = min(max(0, start), frames - 1)
        end = min(max(start + 1, end), frames)
        column = np.median(chroma[:, start:end], axis=1)
        total = float(column.sum())
        columns.append(column / total if total > 1e-12 else np.full(12, 1.0 / 12.0))
    return np.vstack(columns) if columns else np.zeros((0, 12))


def _from_chroma(
    audio_path: Path,
    analysis: dict[str, Any],
    include_sevenths: bool,
    resolution: str,
) -> dict[str, Any]:
    import librosa  # type: ignore[import]
    import numpy as np

    y, sr = librosa.load(str(audio_path), sr=_SR, mono=True)
    duration_sec = float(len(y)) / float(sr) if sr else 0.0
    if duration_sec <= 0.0 or len(y) < _HOP * 2:
        raise ValueError("audio is too short for chord estimation")
    chroma = librosa.feature.chroma_cqt(
        y=y, sr=sr, hop_length=_HOP, n_octaves=_N_OCTAVES
    )

    analysis_bpm = _f(analysis.get("bpm"))
    beats = _analysis_beats(analysis)
    if beats and analysis_bpm <= 0:
        gaps = np.diff(np.asarray(beats))
        analysis_bpm = 60.0 / float(np.median(gaps)) if len(gaps) else FALLBACK_BPM
    bpm = analysis_bpm
    if not beats:
        try:
            tempo, frames = librosa.beat.beat_track(y=y, sr=sr, hop_length=_HOP)
            tracked = [
                float(t) for t in librosa.frames_to_time(frames, sr=sr, hop_length=_HOP)
            ]
            tempo_value = float(np.atleast_1d(tempo)[0]) if tempo is not None else 0.0
        except Exception as exc:  # noqa: BLE001 - beat tracking is best-effort
            log.debug("chordtrack: beat_track failed: %s", exc)
            tracked, tempo_value = [], 0.0
        if len(tracked) >= 2:
            beats = tracked
            if bpm <= 0:
                gaps = np.diff(np.asarray(beats))
                bpm = (
                    tempo_value
                    if tempo_value > 0
                    else 60.0 / float(np.median(gaps))
                    if len(gaps)
                    else FALLBACK_BPM
                )
        else:
            bpm = bpm if bpm > 0 else (tempo_value if tempo_value > 0 else FALLBACK_BPM)
            beats = _synth_beats(bpm, duration_sec)
    if bpm <= 0:
        bpm = FALLBACK_BPM
    beat_len = 60.0 / bpm
    beats = [b for b in beats if b < duration_sec - 1e-6] or [0.0]
    beats_per_bar = 4
    downbeats = beats[::beats_per_bar]

    # Segment boundaries: the head before the first beat, every beat, the tail.
    boundaries = list(beats)
    if boundaries[0] > 1e-3:
        boundaries.insert(0, 0.0)
    else:
        boundaries[0] = 0.0
    boundaries.append(duration_sec)

    pooled = _pool_chroma(chroma, boundaries, sr, _HOP)
    labels, templates = _templates(include_sevenths)
    similarity = pooled @ templates.T  # cosine: rows L1 -> rescale by L2 norm
    norms = np.linalg.norm(pooled, axis=1, keepdims=True)
    norms[norms < 1e-12] = 1.0
    similarity = np.clip(similarity / norms, 0.0, 1.0)

    tonic, mode, key_conf = _analysis_key(analysis)
    prior = _key_prior_vector(labels, tonic, mode)
    log_emission = similarity * _EMISSION_WEIGHT + prior[None, :]
    states = len(labels)
    path = _viterbi(log_emission, _STAY_PROB, (1.0 - _STAY_PROB) / max(1, states - 1))

    # Runs of equal state -> spans over segment indexes.
    runs: list[tuple[int, int, int]] = []  # (state, first segment, last segment + 1)
    for index, state in enumerate(path):
        if runs and runs[-1][0] == state:
            runs[-1] = (state, runs[-1][1], index + 1)
        else:
            runs.append((state, index, index + 1))

    flats = _prefer_flats(tonic, mode)

    def make(state: int, seg_start: int, seg_end: int) -> dict[str, Any]:
        root, kind = labels[state]
        start_sec = boundaries[seg_start]
        end_sec = boundaries[seg_end]
        conf = float(np.mean(similarity[seg_start:seg_end, state]))
        if kind == _NO_CHORD:
            symbol, root_name, pcs = "N.C.", "", []
            kind_out, root_pc = "none", -1
        else:
            intervals, _, suffix = _KIND_INTERVALS[kind]
            root_name = _pc_name(root, flats)
            symbol = root_name + suffix
            pcs = [(root + i) % 12 for i in intervals]
            kind_out, root_pc = kind, root
        return _span(
            start_sec=start_sec,
            end_sec=end_sec,
            start_beat=_beat_index(beats, start_sec),
            end_beat=_beat_index(beats, end_sec),
            measure=int(_beat_index(beats, start_sec) // beats_per_bar) + 1,
            symbol=symbol,
            root=root_name,
            root_pc=root_pc,
            kind=kind_out,
            bass_pc=-1,
            pitch_classes=pcs,
            confidence=max(conf, 1e-3),
        )

    chords = [make(state, a, b) for state, a, b in runs]

    if resolution == "bar":
        chords = _snap_to_downbeats(chords, downbeats, duration_sec)

    chords = _absorb_short_spans(chords, beat_len)
    chords = _merge_equal(chords)
    if not chords:
        raise ValueError("chroma estimation produced no chords")

    return {
        "method": "chroma",
        "chords": chords,
        "timing": {
            "bpm": float(bpm),
            "beats": [float(b) for b in beats],
            "downbeats": [float(b) for b in downbeats],
            "beatsPerBar": int(beats_per_bar),
            "durationSec": float(duration_sec),
        },
        "key": {
            "tonic": _pc_name(tonic, flats) if tonic >= 0 else "",
            "mode": mode if tonic >= 0 else "",
            "confidence": float(key_conf if tonic >= 0 else 0.0),
        },
    }


def _beat_index(beats: list[float], sec: float) -> float:
    """Fractional beat index of ``sec`` on the beat grid (extrapolated at the ends)."""
    if not beats:
        return 0.0
    if len(beats) == 1:
        return 0.0 if sec <= beats[0] else (sec - beats[0])
    from bisect import bisect_right

    index = bisect_right(beats, sec) - 1
    if index < 0:
        gap = beats[1] - beats[0]
        return (sec - beats[0]) / gap if gap > 0 else 0.0
    if index >= len(beats) - 1:
        gap = beats[-1] - beats[-2]
        return (len(beats) - 1) + ((sec - beats[-1]) / gap if gap > 0 else 0.0)
    gap = beats[index + 1] - beats[index]
    return index + ((sec - beats[index]) / gap if gap > 0 else 0.0)


def _snap_to_downbeats(
    chords: list[dict[str, Any]], downbeats: list[float], duration_sec: float
) -> list[dict[str, Any]]:
    """Move every chord change to the nearest downbeat; spans that collapse are
    dropped into their predecessor."""
    if not downbeats or not chords:
        return chords
    anchors = list(downbeats)
    if anchors[0] > 1e-6:
        anchors.insert(0, 0.0)

    def nearest(sec: float) -> float:
        return min(anchors, key=lambda a: abs(a - sec))

    out: list[dict[str, Any]] = []
    for index, chord in enumerate(chords):
        start = 0.0 if index == 0 else nearest(chord["startSec"])
        if out and start <= out[-1]["startSec"] + 1e-9:
            # Collapsed into the previous bar: the earlier chord keeps the bar.
            continue
        span = dict(chord)
        span["startSec"] = start
        if out:
            out[-1]["endSec"] = start
        out.append(span)
    if out:
        out[-1]["endSec"] = duration_sec
    return out


def _absorb_short_spans(
    chords: list[dict[str, Any]], beat_len: float
) -> list[dict[str, Any]]:
    """Spans shorter than one beat are folded into their predecessor (or, at the
    head, into their successor), so a single noisy beat never flashes a chord."""
    threshold = max(1e-6, beat_len * 0.99)
    out: list[dict[str, Any]] = []
    pending_head: Optional[dict[str, Any]] = None
    for chord in chords:
        if pending_head is not None:
            chord = dict(chord)
            chord["startSec"] = pending_head["startSec"]
            chord["startBeat"] = pending_head["startBeat"]
            chord["measure"] = pending_head["measure"]
            pending_head = None
        if chord["endSec"] - chord["startSec"] < threshold:
            if out:
                out[-1]["endSec"] = chord["endSec"]
                out[-1]["endBeat"] = chord["endBeat"]
            else:
                pending_head = chord
            continue
        out.append(dict(chord))
    if pending_head is not None:
        out.append(pending_head)
    return out


__all__ = [
    "SCHEMA",
    "SCHEMA_VERSION",
    "ENGINE",
    "METHODS",
    "RESOLUTIONS",
    "build_chordtrack",
    "write_chordtrack",
]
