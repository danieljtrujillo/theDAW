"""Note-chart exporter: a symbolic score as a ``gantasmo.notechart`` document.

The chart drives the XR flying-notation scene, where engraved SMuFL glyphs fly
toward the player and have to arrive with the recording. That target dictates
almost every decision here:

  - **Both raw and quantized onsets ship on every event.** The engraved sheet is
    an idealization produced by ``score.quantize((4, 3))``; the waveform never
    moved. On a 1/16 grid at 120 BPM the worst-case displacement is 62.5 ms,
    which is wider than a rhythm game's "perfect" window, so judging against the
    quantized value fails a player who is dead on the beat. Layout uses
    ``onsetSec``, judging uses ``onsetSecRaw``, and swing survives only because
    the difference between them is preserved.
  - **The document is JsonUtility-safe.** Unity's ``JsonUtility`` is the codec on
    the other side (Newtonsoft is only transitively present there), so the root
    is an object, every array is a named field, there are no unions, and there is
    no ``null`` anywhere: absent strings are ``""``, absent numbers ``0``, absent
    arrays ``[]``, and "no value" integers ``-1``.
  - **Spelled pitch is mandatory.** MIDI 63 is D#4 or Eb4; those are different
    glyphs at different staff positions, and the spelling is exactly what a raw
    MIDI pitch discarded.
  - **Rests are first-class and share the event array with notes**, so a spawner
    walks one monotonic cursor and no merge can reorder the rhythm.

Time is always absolute seconds from chart zero, computed here against the
score's real tempo map. Nothing assumes 120 BPM: the piano transcription route
writes 120 and the arrangement route writes 100, so a hardcoded constant would
silently stretch every arrangement chart.

Reference: SMuFL 1.4 glyph assignments, which Bravura implements at the same
codepoints.
"""

from __future__ import annotations

import json
import logging
import math
from bisect import bisect_right
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

log = logging.getLogger(__name__)

SCHEMA = "gantasmo.notechart"
SCHEMA_VERSION = 1
ENGINE = "music21-notechart"

DEFAULT_TICKS_PER_QUARTER = 480
DEFAULT_GRID_DIVISIONS = 4
DEFAULT_VELOCITY = 64
# music21's own fallback when a score declares no tempo. Used ONLY as that
# fallback; the real tempo is always read from the score.
FALLBACK_BPM = 120.0
# Rests carry a conventional staff step (middle line) so a rest lane reads at a
# stable height instead of jumping around.
REST_STAFF_STEP = 4
# A tuplet wider than this is a quantizer artifact rather than musical intent
# (the live corpus holds 12:11 and 12:7 ratios produced by quantize((4, 3))).
# Flagged so the scene can draw it and still exclude it from judging.
IRRATIONAL_TUPLET_ACTUAL = 7
# Grace notes have quarterLength 0, which is both unhittable and invisible.
# They get a synthetic visible length: a third of the note they lean on, capped.
GRACE_MAX_SEC = 0.08
GRACE_MIN_SEC = 0.02
# Coordinates and durations are rounded here; 1 us is far below audible.
ROUND_DIGITS = 6

# Duration types that have a printed glyph. Anything else is clamped to the
# nearest of these and counted in stats.clampedDurations.
_TYPE_QUARTER_LENGTHS = (
    ("breve", 8.0),
    ("whole", 4.0),
    ("half", 2.0),
    ("quarter", 1.0),
    ("eighth", 0.5),
    ("16th", 0.25),
    ("32nd", 0.125),
    ("64th", 0.0625),
    ("128th", 0.03125),
)
_PRINTABLE_TYPES = frozenset(name for name, _ in _TYPE_QUARTER_LENGTHS)

# SMuFL glyph name -> codepoint, as a decimal integer because that is what
# TextMeshPro wants. Names stay primary; they are the stable identifier.
_CODEPOINTS: dict[str, int] = {
    "noteDoubleWhole": 57808,
    "noteWhole": 57810,
    "noteHalfUp": 57811,
    "noteHalfDown": 57812,
    "noteQuarterUp": 57813,
    "noteQuarterDown": 57814,
    "note8thUp": 57815,
    "note8thDown": 57816,
    "note16thUp": 57817,
    "note16thDown": 57818,
    "note32ndUp": 57819,
    "note32ndDown": 57820,
    "note64thUp": 57821,
    "note64thDown": 57822,
    "note128thUp": 57823,
    "note128thDown": 57824,
    "noteheadDoubleWhole": 57504,
    "noteheadWhole": 57506,
    "noteheadHalf": 57507,
    "noteheadBlack": 57508,
    "noteheadXBlack": 57513,
    "restDoubleWhole": 58594,
    "restWhole": 58595,
    "restHalf": 58596,
    "restQuarter": 58597,
    "rest8th": 58598,
    "rest16th": 58599,
    "rest32nd": 58600,
    "rest64th": 58601,
    "rest128th": 58602,
    "accidentalFlat": 57952,
    "accidentalNatural": 57953,
    "accidentalSharp": 57954,
    "accidentalDoubleSharp": 57955,
    "accidentalDoubleFlat": 57956,
    "flag8thUp": 57920,
    "flag8thDown": 57921,
    "flag16thUp": 57922,
    "flag16thDown": 57923,
    "flag32ndUp": 57924,
    "flag32ndDown": 57925,
    "flag64thUp": 57926,
    "flag64thDown": 57927,
    "gClef": 57424,
    "gClef8vb": 57426,
    "cClef": 57436,
    "fClef": 57442,
    "unpitchedPercussionClef1": 57449,
    "timeSig0": 57472,
    "timeSig1": 57473,
    "timeSig2": 57474,
    "timeSig3": 57475,
    "timeSig4": 57476,
    "timeSig5": 57477,
    "timeSig6": 57478,
    "timeSig7": 57479,
    "timeSig8": 57480,
    "timeSig9": 57481,
    "timeSigCommon": 57482,
    "timeSigCutCommon": 57483,
    "barlineSingle": 57392,
    "barlineDouble": 57393,
    "barlineFinal": 57394,
    "staff5Lines": 57364,
    "legerLine": 57378,
    "augmentationDot": 57831,
}

# Composite note glyphs (notehead + stem + flag in one character): one glyph is
# one draw call and one collider, which is what a flying note wants.
_NOTE_GLYPHS: dict[str, tuple[str, str]] = {
    "breve": ("noteDoubleWhole", "noteDoubleWhole"),
    "whole": ("noteWhole", "noteWhole"),
    "half": ("noteHalfUp", "noteHalfDown"),
    "quarter": ("noteQuarterUp", "noteQuarterDown"),
    "eighth": ("note8thUp", "note8thDown"),
    "16th": ("note16thUp", "note16thDown"),
    "32nd": ("note32ndUp", "note32ndDown"),
    "64th": ("note64thUp", "note64thDown"),
    "128th": ("note128thUp", "note128thDown"),
}
_NOTEHEAD_GLYPHS = {
    "breve": "noteheadDoubleWhole",
    "whole": "noteheadWhole",
    "half": "noteheadHalf",
}
# Flags only matter when the renderer composes notehead + stem + flag itself.
# 128th flags are omitted deliberately: the composite glyph covers that case and
# the table above is the verified set.
_FLAG_GLYPHS: dict[str, tuple[str, str]] = {
    "eighth": ("flag8thUp", "flag8thDown"),
    "16th": ("flag16thUp", "flag16thDown"),
    "32nd": ("flag32ndUp", "flag32ndDown"),
    "64th": ("flag64thUp", "flag64thDown"),
}
_REST_GLYPHS = {
    "breve": "restDoubleWhole",
    "whole": "restWhole",
    "half": "restHalf",
    "quarter": "restQuarter",
    "eighth": "rest8th",
    "16th": "rest16th",
    "32nd": "rest32nd",
    "64th": "rest64th",
    "128th": "rest128th",
}
_ACCIDENTAL_GLYPHS = {
    "natural": "accidentalNatural",
    "sharp": "accidentalSharp",
    "flat": "accidentalFlat",
    "double-sharp": "accidentalDoubleSharp",
    "double-flat": "accidentalDoubleFlat",
}
_CLEF_GLYPHS = {
    "G": "gClef",
    "F": "fClef",
    "C": "cClef",
    "percussion": "unpitchedPercussionClef1",
}
_BARLINE_GLYPHS = {
    "regular": "barlineSingle",
    "double": "barlineDouble",
    "light-light": "barlineDouble",
    "final": "barlineFinal",
    "light-heavy": "barlineFinal",
    "heavy-light": "barlineFinal",
    "heavy-heavy": "barlineFinal",
}

_MIDI_SUFFIXES = frozenset({".mid", ".midi", ".smf"})


# --------------------------------------------------------------------------
# scalar coercion
#
# Every value written into the chart passes through one of these, because a
# single None reaching the JSON makes JsonUtility hand Unity a null string
# reference rather than "".
# --------------------------------------------------------------------------


def _s(value: Any) -> str:
    return "" if value is None else str(value)


def _i(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _f(value: Any, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _glyph(name: str) -> tuple[str, int]:
    """A glyph name paired with its codepoint, or the empty pair when unknown."""
    code = _CODEPOINTS.get(name)
    return (name, code) if code is not None else ("", 0)


def _round_tree(value: Any) -> Any:
    """Round every float in the document and scrub anything non-finite.

    A NaN from a divide-by-zero tempo serializes as bare ``NaN``, which is not
    JSON and which Unity rejects at parse time, so the whole chart would be lost
    to one bad number.
    """
    if isinstance(value, float):
        return round(value, ROUND_DIGITS) if math.isfinite(value) else 0.0
    if isinstance(value, dict):
        return {k: _round_tree(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_round_tree(v) for v in value]
    if value is None:
        return ""
    return value


def _first_null_path(value: Any, path: str = "$") -> str:
    """Path of the first JSON null in the document, or ``""`` when there is none."""
    if value is None:
        return path
    if isinstance(value, dict):
        for k, v in value.items():
            found = _first_null_path(v, f"{path}.{k}")
            if found:
                return found
    elif isinstance(value, list):
        for idx, v in enumerate(value):
            found = _first_null_path(v, f"{path}[{idx}]")
            if found:
                return found
    return ""


# --------------------------------------------------------------------------
# tempo, meter, key and measure maps
# --------------------------------------------------------------------------


def _tempo_map(score: Any, ticks_per_quarter: int) -> list[dict[str, Any]]:
    """Every tempo change, with beats and seconds pre-paired.

    ``bpm`` is always quarter-notes per minute (``getQuarterBPM``), so 6/8 at
    "dotted quarter = 60" lands as 180 and a consumer never has to know the
    referent. Seconds are integrated across the piecewise-constant map rather
    than read from music21's ``secondsMap``, so the Unity side reproduces every
    onset with the same two lines of arithmetic.
    """
    from music21 import tempo as m21tempo  # type: ignore[import]

    marks: dict[float, float] = {}
    for mark in score.flatten().getElementsByClass(m21tempo.MetronomeMark):
        try:
            bpm = float(mark.getQuarterBPM() or 0.0)
        except Exception:  # noqa: BLE001 - a malformed mark must not kill the chart
            bpm = 0.0
        if not math.isfinite(bpm) or bpm <= 0:
            continue
        # Later mark at the same offset wins, which is what a re-stamped tempo
        # means.
        marks[round(float(mark.offset), 6)] = bpm

    if 0.0 not in marks:
        # An entry at beat 0 is guaranteed, because every onset before the first
        # declared mark would otherwise have no tempo to convert against. The
        # first declared tempo carries backwards; 120 only when there is none.
        marks[0.0] = marks[min(marks)] if marks else FALLBACK_BPM

    entries: list[dict[str, Any]] = []
    seconds = 0.0
    previous: Optional[tuple[float, float]] = None
    for beats in sorted(marks):
        bpm = marks[beats]
        if previous is not None:
            prev_beats, prev_bpm = previous
            seconds += (beats - prev_beats) * 60.0 / prev_bpm
        entries.append(
            {
                "timeSec": seconds,
                "timeBeats": beats,
                "timeTicks": int(round(beats * ticks_per_quarter)),
                "bpm": bpm,
                "secPerBeat": 60.0 / bpm,
                "measure": 0,
                "interpolateToNext": False,
            }
        )
        previous = (beats, bpm)
    return entries


def _seconds_from_beats(entries: list[dict[str, Any]]) -> Callable[[float], float]:
    """Beats (quarter lengths) to absolute seconds across the tempo map."""
    starts = [float(e["timeBeats"]) for e in entries]

    def convert(beats: float) -> float:
        index = max(0, bisect_right(starts, beats) - 1)
        entry = entries[index]
        bpm = float(entry["bpm"]) or FALLBACK_BPM
        return (
            float(entry["timeSec"]) + (beats - float(entry["timeBeats"])) * 60.0 / bpm
        )

    return convert


def _measure_grid(score: Any) -> list[tuple[int, float, float, Any]]:
    """(number, offsetBeats, lengthBeats, measure) for the densest part.

    Parts can disagree on bar count when one of them ends early, so the grid
    comes from whichever part carries the most measures.
    """
    from music21 import stream as m21stream  # type: ignore[import]

    best: list[Any] = []
    for part in _parts_of(score):
        measures = list(part.getElementsByClass(m21stream.Measure))
        if len(measures) > len(best):
            best = measures

    grid: list[tuple[int, float, float, Any]] = []
    for index, measure in enumerate(best):
        number = _i(getattr(measure, "number", 0)) or (index + 1)
        offset = _f(measure.offset)
        length = _f(getattr(measure.duration, "quarterLength", 0.0))
        grid.append((number, offset, length, measure))
    return grid


def _measure_lookup(
    grid: list[tuple[int, float, float, Any]],
) -> Callable[[float], int]:
    """Measure number containing a beat offset; 1 when the score has no bars."""
    starts = [offset for _, offset, _, _ in grid]

    def lookup(beats: float) -> int:
        if not grid:
            return 1
        index = max(0, bisect_right(starts, beats + 1e-9) - 1)
        return grid[index][0]

    return lookup


def _is_pickup(measure: Any, index: int) -> bool:
    """An anacrusis: padded on the left, or short at the head of the score."""
    if _f(getattr(measure, "paddingLeft", 0.0)) > 0:
        return True
    if index > 0:
        return False
    bar_length = _f(
        getattr(getattr(measure, "barDuration", None), "quarterLength", 0.0)
    )
    actual = _f(getattr(measure.duration, "quarterLength", 0.0))
    return bar_length > 0 and 0 < actual < bar_length - 1e-6


def _pickup_beats(grid: list[tuple[int, float, float, Any]]) -> float:
    """Beats MISSING from an opening anacrusis.

    This is the number to add to ``onsetBeats`` before taking a bar-relative
    position; without it every bar-derived visual in the scene is off by the
    pickup for the whole song.
    """
    if not grid:
        return 0.0
    _, _, length, measure = grid[0]
    if not _is_pickup(measure, 0):
        return 0.0
    padding = _f(getattr(measure, "paddingLeft", 0.0))
    if padding > 0:
        return padding
    bar_length = _f(
        getattr(getattr(measure, "barDuration", None), "quarterLength", 0.0)
    )
    return max(0.0, bar_length - length)


def _measures_block(
    grid: list[tuple[int, float, float, Any]],
    to_seconds: Callable[[float], float],
) -> list[dict[str, Any]]:
    from music21 import bar as m21bar  # type: ignore[import]

    out: list[dict[str, Any]] = []
    for index, (number, offset, length, measure) in enumerate(grid):
        right = getattr(measure, "rightBarline", None)
        style = _s(getattr(right, "type", "") or "regular").lower()
        glyph, code = _glyph(_BARLINE_GLYPHS.get(style, "barlineSingle"))
        starts_repeat = False
        ends_repeat = False
        left = getattr(measure, "leftBarline", None)
        if isinstance(left, m21bar.Repeat):
            starts_repeat = _s(getattr(left, "direction", "")) == "start"
        if isinstance(right, m21bar.Repeat):
            ends_repeat = _s(getattr(right, "direction", "")) == "end"
        out.append(
            {
                "number": _i(number),
                "timeSec": to_seconds(offset),
                "timeBeats": offset,
                "durationBeats": length,
                "isPickup": _is_pickup(measure, index),
                "barlineGlyph": glyph,
                "barlineCodepoint": code,
                "startsRepeat": starts_repeat,
                "endsRepeat": ends_repeat,
            }
        )
    return out


def _time_signature_map(
    score: Any,
    to_seconds: Callable[[float], float],
    to_measure: Callable[[float], int],
) -> list[dict[str, Any]]:
    from music21 import meter as m21meter  # type: ignore[import]

    seen: dict[float, Any] = {}
    for ts in score.flatten().getElementsByClass(m21meter.TimeSignature):
        seen[round(_f(ts.offset), 6)] = ts

    out: list[dict[str, Any]] = []
    for beats in sorted(seen):
        ts = seen[beats]
        numerator = _i(getattr(ts, "numerator", 4), 4)
        denominator = _i(getattr(ts, "denominator", 4), 4) or 4
        symbol = _s(getattr(ts, "symbol", "")).lower()
        if symbol not in ("common", "cut"):
            symbol = "normal"
        # Multi-digit numerators have no single glyph; the scene composes them
        # from the numeric fields, so the name is left empty rather than lying.
        num_glyph, num_code = (
            _glyph(f"timeSig{numerator}") if numerator < 10 else ("", 0)
        )
        den_glyph, den_code = (
            _glyph(f"timeSig{denominator}") if denominator < 10 else ("", 0)
        )
        out.append(
            {
                "measure": to_measure(beats),
                "timeSec": to_seconds(beats),
                "timeBeats": beats,
                "numerator": numerator,
                "denominator": denominator,
                "symbol": symbol,
                "beatsPerBar": _f(getattr(ts.barDuration, "quarterLength", 4.0), 4.0),
                "glyphNumerator": num_glyph,
                "glyphNumeratorCodepoint": num_code,
                "glyphDenominator": den_glyph,
                "glyphDenominatorCodepoint": den_code,
            }
        )
    return out


def _key_signature_map(
    score: Any,
    to_seconds: Callable[[float], float],
    to_measure: Callable[[float], int],
) -> list[dict[str, Any]]:
    from music21 import key as m21key  # type: ignore[import]

    seen: dict[float, Any] = {}
    for ks in score.flatten().getElementsByClass(m21key.KeySignature):
        seen[round(_f(ks.offset), 6)] = ks

    out: list[dict[str, Any]] = []
    for beats in sorted(seen):
        ks = seen[beats]
        fifths = _i(getattr(ks, "sharps", 0))
        mode = _s(getattr(ks, "mode", "")).lower()
        if mode not in ("major", "minor"):
            mode = ""
        tonic = _s(getattr(getattr(ks, "tonic", None), "name", ""))
        glyph, code = _glyph("accidentalSharp" if fifths > 0 else "accidentalFlat")
        if fifths == 0:
            glyph, code = "", 0
        out.append(
            {
                "measure": to_measure(beats),
                "timeSec": to_seconds(beats),
                "timeBeats": beats,
                "fifths": fifths,
                "mode": mode,
                "tonic": tonic,
                "accidentalGlyph": glyph,
                "accidentalCodepoint": code,
                "accidentalCount": abs(fifths),
            }
        )
    return out


# --------------------------------------------------------------------------
# parts and events
# --------------------------------------------------------------------------


def _parts_of(score: Any) -> list[Any]:
    """The score's parts, or the score itself when it carries notes directly."""
    from music21 import stream as m21stream  # type: ignore[import]

    parts = list(score.getElementsByClass(m21stream.Part))
    return parts or [score]


def _printable_type(dur: Any) -> tuple[str, bool]:
    """A printable duration type, plus whether it had to be clamped.

    ``quantize((4, 3))`` produces ratios such as 12:7 whose duration has no
    ``type`` + ``dots`` spelling at all; music21 reports "complex" or
    "inexpressible" for those, and a glyph has to be chosen anyway.
    """
    name = _s(getattr(dur, "type", ""))
    if name in _PRINTABLE_TYPES:
        return name, False
    quarters = _f(getattr(dur, "quarterLength", 0.0))
    if quarters <= 0:
        return "quarter", True
    best = min(
        _TYPE_QUARTER_LENGTHS, key=lambda item: abs(math.log(quarters / item[1]))
    )
    return best[0], True


def _clef_at(clefs: list[tuple[float, Any]], beats: float) -> Any:
    active = None
    for offset, obj in clefs:
        if offset <= beats + 1e-9:
            active = obj
        else:
            break
    return active if active is not None else (clefs[0][1] if clefs else None)


def _part_clefs(part: Any) -> list[tuple[float, Any]]:
    from music21 import clef as m21clef  # type: ignore[import]

    found: list[tuple[float, Any]] = []
    for obj in part.recurse().getElementsByClass(m21clef.Clef):
        try:
            offset = _f(obj.getOffsetInHierarchy(part))
        except Exception:  # noqa: BLE001 - detached clefs fall back to their own offset
            offset = _f(obj.offset)
        found.append((offset, obj))
    found.sort(key=lambda item: item[0])
    if not found:
        found = [(0.0, m21clef.TrebleClef())]
    return found


def _clef_block(
    clefs: list[tuple[float, Any]],
    to_seconds: Callable[[float], float],
    to_measure: Callable[[float], int],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for offset, obj in clefs:
        sign = _s(getattr(obj, "sign", "G")) or "G"
        glyph_name = _CLEF_GLYPHS.get(sign, "gClef")
        if sign == "G" and _i(getattr(obj, "octaveChange", 0)) == -1:
            glyph_name = "gClef8vb"
        glyph, code = _glyph(glyph_name)
        out.append(
            {
                "measure": to_measure(offset),
                "staff": 1,
                "timeSec": to_seconds(offset),
                "timeBeats": offset,
                "sign": sign,
                "line": _i(getattr(obj, "line", 2), 2),
                "octaveChange": _i(getattr(obj, "octaveChange", 0)),
                # Clef.lowestLine is the diatonic note number of the bottom staff
                # line (treble 31, bass 19), which is the whole of staff
                # placement: staffStep = diatonicNoteNum - lowestLine.
                "lowestLineDiatonic": _i(getattr(obj, "lowestLine", 31), 31),
                "glyph": glyph,
                "glyphCodepoint": code,
            }
        )
    return out


def _ledger_lines(staff_step: int) -> tuple[int, bool]:
    if staff_step < 0:
        return (-staff_step) // 2, True
    if staff_step > 8:
        return (staff_step - 8) // 2, False
    return 0, False


def _beam_info(element: Any) -> tuple[str, int]:
    """(beam type, beam depth). Rests have no ``.beams`` attribute at all."""
    beams = getattr(element, "beams", None)
    if beams is None:
        return "", 0
    try:
        types = list(beams.getTypes())
        depth = len(beams.beamsList)
    except Exception:  # noqa: BLE001 - malformed beam data is decorative here
        return "", 0
    return (_s(types[0]) if types else ""), depth


def _tuplet_info(dur: Any) -> tuple[bool, int, int, str]:
    tuplets = list(getattr(dur, "tuplets", ()) or ())
    if not tuplets:
        return False, 0, 0, ""
    first = tuplets[0]
    actual = _i(getattr(first, "numberNotesActual", 0))
    normal = _i(getattr(first, "numberNotesNormal", 0))
    bracket = _s(getattr(first, "type", ""))
    if actual > IRRATIONAL_TUPLET_ACTUAL:
        # Not musical intent: quantize((4, 3)) fitting a raw transcription onto a
        # grid that admits both duple and triple subdivisions. Flagged so the
        # scene can draw it and still keep it out of judging.
        bracket = "irrational"
    return True, actual, normal, bracket


def _accidental_fields(pitch: Any) -> tuple[str, bool, str, int]:
    acc = getattr(pitch, "accidental", None)
    if acc is None:
        return "", False, "", 0
    name = _s(getattr(acc, "name", ""))
    if name not in _ACCIDENTAL_GLYPHS:
        return "", False, "", 0
    display = getattr(acc, "displayStatus", None)
    if display is False:
        return "", False, "", 0
    # displayStatus is None when nothing has decided yet; music21 prints a
    # non-natural accidental in that state, so match what would be engraved.
    if display is None and _f(getattr(acc, "alter", 0.0)) == 0.0:
        return "", False, "", 0
    cautionary = _s(getattr(acc, "displayType", "")) == "cautionary"
    glyph, code = _glyph(_ACCIDENTAL_GLYPHS[name])
    return name, cautionary, glyph, code


def _resolve_stem(element: Any, staff_step: float) -> str:
    direction = _s(getattr(element, "stemDirection", "")).lower()
    if direction in ("up", "down"):
        return direction
    if direction == "nostem":
        return ""
    return "up" if staff_step < 4 else "down"


def _note_glyphs(
    note_type: str, stem: str, is_chord_member: bool, is_percussion: bool
) -> dict[str, Any]:
    """Composite / notehead / flag glyph hints for one sounding note.

    A chord member that shares a stem carries only its bare notehead; the root
    carries the stem and the flag, so the two never draw a stem each.
    """
    down = stem == "down"
    notehead = _NOTEHEAD_GLYPHS.get(note_type, "noteheadBlack")
    if is_percussion:
        notehead = "noteheadXBlack"
    head_glyph, head_code = _glyph(notehead)

    flag_glyph, flag_code = "", 0
    if not is_chord_member and note_type in _FLAG_GLYPHS:
        flag_glyph, flag_code = _glyph(_FLAG_GLYPHS[note_type][1 if down else 0])

    if is_chord_member or is_percussion:
        glyph, code = head_glyph, head_code
    else:
        pair = _NOTE_GLYPHS.get(note_type)
        glyph, code = (
            _glyph(pair[1 if down else 0]) if pair else (head_glyph, head_code)
        )

    return {
        "glyph": glyph,
        "glyphCodepoint": code,
        "noteheadGlyph": head_glyph,
        "noteheadCodepoint": head_code,
        "flagGlyph": flag_glyph,
        "flagCodepoint": flag_code,
    }


def _blank_event() -> dict[str, Any]:
    """One event with every field present at its "absent" value.

    Fields are never omitted and never null: JsonUtility maps a missing or null
    string onto a null reference, which throws on first use in the scene.
    """
    return {
        "id": 0,
        "isRest": False,
        "onsetSec": 0.0,
        "onsetSecRaw": 0.0,
        "onsetBeats": 0.0,
        "onsetBeatsRaw": 0.0,
        "onsetTicks": 0,
        "durationSec": 0.0,
        "durationSecRaw": 0.0,
        "durationBeats": 0.0,
        "durationTicks": 0,
        "measure": 1,
        "beatInMeasure": 1.0,
        "voice": 1,
        "staff": 1,
        "midi": 0,
        "velocity": 0,
        "step": "",
        "octave": 0,
        "alter": 0,
        "accidental": "",
        "accidentalIsCautionary": False,
        "diatonicNoteNum": 0,
        "staffStep": REST_STAFF_STEP,
        "ledgerLines": 0,
        "ledgerBelow": False,
        "noteType": "quarter",
        "dots": 0,
        "isTuplet": False,
        "tupletActual": 0,
        "tupletNormal": 0,
        "tupletBracket": "",
        "isGrace": False,
        "tie": "",
        "beam": "",
        "beamDepth": 0,
        "stemDirection": "",
        "chordId": -1,
        "isChordRoot": False,
        "glyph": "",
        "glyphCodepoint": 0,
        "noteheadGlyph": "",
        "noteheadCodepoint": 0,
        "flagGlyph": "",
        "flagCodepoint": 0,
        "accidentalGlyph": "",
        "accidentalCodepoint": 0,
        "dotGlyph": "",
        "dotCodepoint": 0,
    }


class _Counters:
    """Tallies collected while walking, reported in the stats block."""

    def __init__(self) -> None:
        self.notes = 0
        self.rests = 0
        self.chords = 0
        self.tuplets = 0
        self.graces = 0
        self.tied = 0
        self.clamped = 0


def _voice_containers(measure: Any) -> list[tuple[int, float, Any]]:
    """(voice number, extra beat offset, container) for one measure."""
    voices = list(getattr(measure, "voices", ()) or ())
    if not voices:
        return [(1, 0.0, measure)]
    out: list[tuple[int, float, Any]] = []
    for index, voice in enumerate(voices):
        raw = _s(getattr(voice, "id", ""))
        number = int(raw) if raw.isdigit() else index + 1
        out.append((number, _f(voice.offset), voice))
    return out


def _emit_element(
    element: Any,
    *,
    onset_beats: float,
    measure_number: int,
    voice: int,
    clefs: list[tuple[float, Any]],
    to_seconds: Callable[[float], float],
    ticks_per_quarter: int,
    is_percussion: bool,
    chord_id: int,
    counters: _Counters,
) -> list[dict[str, Any]]:
    """One music21 element as one event (a chord becomes one event per pitch)."""
    from music21 import chord as m21chord  # type: ignore[import]
    from music21 import note as m21note  # type: ignore[import]

    dur = element.duration
    quarters = _f(getattr(dur, "quarterLength", 0.0))
    # Grace notes carry quarterLength 0 (music21 GraceDuration). Any other
    # zero-length note is treated the same way, because a zero-length event is
    # both invisible and unhittable whatever produced it, and calling it an
    # ornament keeps it out of the judged set instead of poisoning it.
    is_grace = quarters == 0.0
    note_type, clamped = _printable_type(dur)
    if clamped:
        counters.clamped += 1
    is_tuplet, tuplet_actual, tuplet_normal, tuplet_bracket = _tuplet_info(dur)
    beam, beam_depth = _beam_info(element)
    tie = _s(getattr(getattr(element, "tie", None), "type", ""))
    dots = _i(getattr(dur, "dots", 0))
    dot_glyph, dot_code = _glyph("augmentationDot") if dots > 0 else ("", 0)

    onset_sec = to_seconds(onset_beats)
    duration_sec = to_seconds(onset_beats + quarters) - onset_sec
    try:
        beat_in_measure = _f(getattr(element, "beat", 1.0), 1.0)
    except Exception:  # noqa: BLE001 - beat needs a meter context that may be absent
        beat_in_measure = 1.0

    common = {
        "onsetSec": onset_sec,
        "onsetSecRaw": onset_sec,
        "onsetBeats": onset_beats,
        "onsetBeatsRaw": onset_beats,
        "onsetTicks": int(round(onset_beats * ticks_per_quarter)),
        "durationSec": duration_sec,
        "durationSecRaw": duration_sec,
        "durationBeats": quarters,
        "durationTicks": int(round(quarters * ticks_per_quarter)),
        "measure": measure_number,
        "beatInMeasure": beat_in_measure,
        "voice": voice,
        "staff": 1,
        "noteType": note_type,
        "dots": dots,
        "isTuplet": is_tuplet,
        "tupletActual": tuplet_actual,
        "tupletNormal": tuplet_normal,
        "tupletBracket": tuplet_bracket,
        "isGrace": is_grace,
        "tie": tie,
        "dotGlyph": dot_glyph,
        "dotCodepoint": dot_code,
    }

    if isinstance(element, m21note.Rest):
        event = _blank_event()
        event.update(common)
        event["isRest"] = True
        event["beam"] = ""
        glyph, code = _glyph(_REST_GLYPHS.get(note_type, "restQuarter"))
        event["glyph"] = glyph
        event["glyphCodepoint"] = code
        counters.rests += 1
        return [event]

    if isinstance(element, m21chord.Chord):
        pitches = sorted(element.pitches, key=lambda p: _i(getattr(p, "midi", 0)))
    elif isinstance(element, m21note.Note):
        pitches = [element.pitch]
    else:
        return []

    clef_obj = _clef_at(clefs, onset_beats)
    lowest_line = _i(getattr(clef_obj, "lowestLine", 31), 31)
    steps = [_i(getattr(p, "diatonicNoteNum", 0)) - lowest_line for p in pitches]
    stem = _resolve_stem(element, sum(steps) / len(steps) if steps else 4.0)
    velocity = _i(
        getattr(getattr(element, "volume", None), "velocity", None), DEFAULT_VELOCITY
    )
    is_chord = len(pitches) > 1
    if is_chord:
        counters.chords += 1

    events: list[dict[str, Any]] = []
    for index, pitch in enumerate(pitches):
        accidental, cautionary, acc_glyph, acc_code = _accidental_fields(pitch)
        staff_step = steps[index]
        ledger, below = _ledger_lines(staff_step)
        event = _blank_event()
        event.update(common)
        event.update(
            {
                "isRest": False,
                "midi": _i(getattr(pitch, "midi", 0)),
                "velocity": velocity,
                "step": _s(getattr(pitch, "step", "")),
                "octave": _i(getattr(pitch, "octave", 4), 4),
                "alter": int(round(_f(getattr(pitch, "alter", 0.0)))),
                "accidental": accidental,
                "accidentalIsCautionary": cautionary,
                "accidentalGlyph": acc_glyph,
                "accidentalCodepoint": acc_code,
                "diatonicNoteNum": _i(getattr(pitch, "diatonicNoteNum", 0)),
                "staffStep": staff_step,
                "ledgerLines": ledger,
                "ledgerBelow": below,
                "beam": beam,
                "beamDepth": beam_depth,
                "stemDirection": stem,
                "chordId": chord_id if is_chord else -1,
                "isChordRoot": (index == 0) if is_chord else False,
            }
        )
        event.update(
            _note_glyphs(
                note_type,
                stem,
                is_chord_member=is_chord and index > 0,
                is_percussion=is_percussion,
            )
        )
        counters.notes += 1
        if is_grace:
            counters.graces += 1
        if is_tuplet:
            counters.tuplets += 1
        if tie:
            counters.tied += 1
        events.append(event)
    return events


def _fill_grace_durations(events: list[dict[str, Any]], ticks_per_quarter: int) -> None:
    """Give every grace note a visible, non-zero duration.

    A grace note is quarterLength 0, so it would be invisible and could never
    carry a hit window; several stacked at one onset would also spawn on top of
    each other. Length comes from the note it leans on, capped so it stays an
    ornament. Beats follow seconds through the neighbour's own ratio, which is
    the local tempo without having to look it up again.
    """
    following_sec = 0.0
    beats_per_sec = 2.0
    for event in reversed(events):
        if not event["isGrace"]:
            following_sec = _f(event["durationSec"])
            if following_sec > 0 and _f(event["durationBeats"]) > 0:
                beats_per_sec = _f(event["durationBeats"]) / following_sec
            continue
        length = following_sec / 3.0 if following_sec > 0 else GRACE_MAX_SEC
        length = min(GRACE_MAX_SEC, max(GRACE_MIN_SEC, length))
        event["durationSec"] = length
        event["durationSecRaw"] = length
        event["durationBeats"] = length * beats_per_sec
        event["durationTicks"] = int(round(length * beats_per_sec * ticks_per_quarter))


def _walk_part(
    part: Any,
    *,
    clefs: list[tuple[float, Any]],
    to_seconds: Callable[[float], float],
    to_measure: Callable[[float], int],
    ticks_per_quarter: int,
    is_percussion: bool,
    counters: _Counters,
    chord_counter: list[int],
) -> list[dict[str, Any]]:
    from music21 import chord as m21chord  # type: ignore[import]
    from music21 import note as m21note  # type: ignore[import]
    from music21 import stream as m21stream  # type: ignore[import]

    measures = list(part.getElementsByClass(m21stream.Measure))
    # A part with no bar structure (a flat MIDI track) still exports as one span.
    blocks: list[tuple[int, float, Any]]
    if measures:
        blocks = [
            (_i(getattr(m, "number", 0)) or (i + 1), _f(m.offset), m)
            for i, m in enumerate(measures)
        ]
    else:
        blocks = [(1, 0.0, part)]

    events: list[dict[str, Any]] = []
    for measure_number, measure_offset, measure in blocks:
        for voice, voice_offset, container in _voice_containers(measure):
            base = measure_offset + voice_offset
            for element in container.getElementsByClass(
                (m21note.Note, m21note.Rest, m21chord.Chord)
            ):
                onset = base + _f(element.offset)
                is_chord = isinstance(element, m21chord.Chord)
                if is_chord:
                    chord_counter[0] += 1
                events.extend(
                    _emit_element(
                        element,
                        onset_beats=onset,
                        measure_number=measure_number
                        if measures
                        else to_measure(onset),
                        voice=voice,
                        clefs=clefs,
                        to_seconds=to_seconds,
                        ticks_per_quarter=ticks_per_quarter,
                        is_percussion=is_percussion,
                        chord_id=chord_counter[0] if is_chord else -1,
                        counters=counters,
                    )
                )

    # Graces sort ahead of the note they lean on at the same tick, which is both
    # the engraved reading order and what lets the grace pass below find its
    # neighbour.
    events.sort(
        key=lambda e: (
            e["onsetTicks"],
            0 if e["isGrace"] else 1,
            e["staff"],
            e["voice"],
            e["midi"],
        )
    )
    _fill_grace_durations(events, ticks_per_quarter)
    for index, event in enumerate(events):
        event["id"] = index
    return events


def _part_block(part: Any, index: int) -> dict[str, Any]:
    instrument = None
    try:
        instruments = list(part.getInstruments(returnDefault=False))
        instrument = instruments[0] if instruments else None
    except Exception:  # noqa: BLE001 - instrument lookup is metadata only
        instrument = None

    name = _s(getattr(part, "partName", "")) or _s(getattr(instrument, "partName", ""))
    if not name:
        name = f"Part {index + 1}"
    transposition = getattr(instrument, "transposition", None)
    semitones = (
        _i(getattr(transposition, "semitones", 0)) if transposition is not None else 0
    )
    percussion = "percussion" in _s(getattr(instrument, "instrumentName", "")).lower()
    return {
        "index": index,
        "id": _s(getattr(part, "id", "")) or name,
        "name": name,
        "abbreviation": _s(getattr(part, "partAbbreviation", "")),
        "instrumentName": _s(getattr(instrument, "instrumentName", "")),
        # -1, not 0, because 0 is a real program (acoustic grand) and the
        # arrangement path genuinely declares none.
        "midiProgram": _i(getattr(instrument, "midiProgram", None), -1),
        "midiChannel": _i(getattr(instrument, "midiChannel", None), 0),
        "staffCount": 1,
        "isPercussion": percussion,
        "transposeSemitones": semitones,
        "clefs": [],
        "events": [],
    }


# --------------------------------------------------------------------------
# raw onsets
# --------------------------------------------------------------------------


def _pair_raw_onsets(
    parts: list[dict[str, Any]],
    raw_midi_path: Path,
    grid_seconds: float,
) -> dict[str, Any]:
    """Overwrite each note's raw onset from the pre-quantization MIDI.

    The engraved sheet is the idealization; the MIDI is what the audio actually
    did. Pairing is greedy in ascending onset order on identical pitch, nearest
    first, each MIDI note consumable once.
    """
    import pretty_midi  # type: ignore[import]

    midi = pretty_midi.PrettyMIDI(str(raw_midi_path))
    by_pitch: dict[int, list[list[Any]]] = {}
    for instrument in midi.instruments:
        for raw in instrument.notes:
            by_pitch.setdefault(int(raw.pitch), []).append(
                [float(raw.start), float(raw.end), int(raw.velocity), False]
            )
    for entries in by_pitch.values():
        entries.sort(key=lambda item: item[0])

    tolerance = max(1.5 * grid_seconds, 0.02)
    events = [e for part in parts for e in part["events"] if not e["isRest"]]
    events.sort(key=lambda e: e["onsetSec"])

    matched = 0
    deviations: list[float] = []
    for event in events:
        candidates = by_pitch.get(_i(event["midi"]))
        if not candidates:
            continue
        target = _f(event["onsetSec"])
        best: Optional[list[Any]] = None
        best_delta = tolerance
        for entry in candidates:
            if entry[3]:
                continue
            delta = abs(entry[0] - target)
            if delta <= best_delta:
                best, best_delta = entry, delta
            elif entry[0] > target + tolerance:
                break
        if best is None:
            continue
        best[3] = True
        matched += 1
        deviations.append(best[0] - target)
        event["onsetSecRaw"] = best[0]
        event["durationSecRaw"] = max(0.0, best[1] - best[0])
        event["velocity"] = best[2]

    absolute = [abs(d) for d in deviations]
    return {
        "matched": matched,
        "unmatched": len(events) - matched,
        "max_deviation": max(absolute) if absolute else 0.0,
        "mean_deviation": (sum(absolute) / len(absolute)) if absolute else 0.0,
    }


def _apply_raw_beats(
    parts: list[dict[str, Any]], tempo_map: list[dict[str, Any]]
) -> None:
    """Mirror each raw onset back into beats so both units stay usable."""
    starts = [float(e["timeSec"]) for e in tempo_map]

    def beats_from_seconds(seconds: float) -> float:
        index = max(0, bisect_right(starts, seconds) - 1)
        entry = tempo_map[index]
        bpm = float(entry["bpm"]) or FALLBACK_BPM
        return (
            float(entry["timeBeats"]) + (seconds - float(entry["timeSec"])) * bpm / 60.0
        )

    for part in parts:
        for event in part["events"]:
            event["onsetBeatsRaw"] = beats_from_seconds(_f(event["onsetSecRaw"]))


def _max_simultaneous(parts: list[dict[str, Any]]) -> int:
    marks: list[tuple[float, int]] = []
    for part in parts:
        for event in part["events"]:
            if event["isRest"]:
                continue
            start = _f(event["onsetSec"])
            end = start + max(_f(event["durationSec"]), 1e-4)
            marks.append((start, 1))
            marks.append((end, -1))
    # Releases sort before attacks at the same instant, so a note that ends
    # exactly where the next begins is not counted twice.
    marks.sort(key=lambda item: (item[0], item[1]))
    live = 0
    peak = 0
    for _, delta in marks:
        live += delta
        peak = max(peak, live)
    return peak


# --------------------------------------------------------------------------
# public API
# --------------------------------------------------------------------------


def build_notechart(
    source_path: Path,
    *,
    title: str,
    artist: str,
    entry_id: str,
    audio_duration_sec: float | None = None,
    source_artifact_id: str = "",
    source_rel_path: str = "",
    audio: Optional[dict[str, Any]] = None,
    raw_midi_path: Optional[Path] = None,
    raw_midi_artifact_id: str = "",
    grid_divisions: int = DEFAULT_GRID_DIVISIONS,
    ticks_per_quarter: int = DEFAULT_TICKS_PER_QUARTER,
    audio_offset_sec: float = 0.0,
) -> dict[str, Any]:
    """Parse a MIDI or MusicXML source and return the note-chart document.

    The result is a plain dict ready for :func:`json.dump`. Reads
    ``source_path`` (and ``raw_midi_path`` when given) and touches nothing else.

    ``audio`` overrides the audio block wholesale for callers that have the
    library record to hand; otherwise it is derived from ``entry_id`` and
    ``audio_duration_sec``. Raises ``ValueError`` when the score carries no
    notes, so a caller never registers an empty chart as a success.
    """
    from music21 import converter  # type: ignore[import]

    score = converter.parse(str(source_path))
    if score is None:
        raise ValueError(f"music21 could not parse {source_path}")

    source_format = (
        "midi" if source_path.suffix.lower() in _MIDI_SUFFIXES else "musicxml"
    )
    if source_format == "midi":
        # Match what MAKE SHEET engraves, so the chart and the sheet agree.
        try:
            quantized = score.quantize((4, 3), inPlace=False, recurse=True)
            if quantized is not None:
                score = quantized
        except Exception as exc:  # noqa: BLE001 - quantize is best-effort
            log.debug("notechart: quantize skipped for %s: %s", source_path, exc)

    score = _expand_repeats(score)

    tempo_map = _tempo_map(score, ticks_per_quarter)
    to_seconds = _seconds_from_beats(tempo_map)
    grid = _measure_grid(score)
    to_measure = _measure_lookup(grid)
    for entry in tempo_map:
        entry["measure"] = to_measure(_f(entry["timeBeats"]))

    counters = _Counters()
    chord_counter = [0]
    parts: list[dict[str, Any]] = []
    for index, part in enumerate(_parts_of(score)):
        block = _part_block(part, index)
        clefs = _part_clefs(part)
        block["clefs"] = _clef_block(clefs, to_seconds, to_measure)
        block["events"] = _walk_part(
            part,
            clefs=clefs,
            to_seconds=to_seconds,
            to_measure=to_measure,
            ticks_per_quarter=ticks_per_quarter,
            is_percussion=bool(block["isPercussion"]),
            counters=counters,
            chord_counter=chord_counter,
        )
        parts.append(block)

    if counters.notes == 0:
        raise ValueError(f"score contains no notes: {source_path}")

    first_bpm = _f(tempo_map[0]["bpm"], FALLBACK_BPM) if tempo_map else FALLBACK_BPM
    grid_divisions = max(1, _i(grid_divisions, DEFAULT_GRID_DIVISIONS))
    grid_seconds = (60.0 / first_bpm) / grid_divisions

    raw_stats = {
        "matched": 0,
        "unmatched": 0,
        "max_deviation": 0.0,
        "mean_deviation": 0.0,
    }
    raw_is_quantized = True
    if raw_midi_path is not None and Path(raw_midi_path).is_file():
        try:
            raw_stats = _pair_raw_onsets(parts, Path(raw_midi_path), grid_seconds)
            raw_is_quantized = raw_stats["matched"] == 0
        except Exception as exc:  # noqa: BLE001 - a bad MIDI must not lose the chart
            log.warning(
                "notechart: raw onset pairing failed for %s: %s", raw_midi_path, exc
            )
    if not raw_is_quantized:
        _apply_raw_beats(parts, tempo_map)

    end_beats = 0.0
    end_seconds = 0.0
    for part in parts:
        for event in part["events"]:
            end_beats = max(
                end_beats, _f(event["onsetBeats"]) + _f(event["durationBeats"])
            )
            end_seconds = max(
                end_seconds, _f(event["onsetSec"]) + _f(event["durationSec"])
            )
    if grid:
        number, offset, length, _ = grid[-1]
        end_beats = max(end_beats, offset + length)
        end_seconds = max(end_seconds, to_seconds(offset + length))

    audio_block = _audio_block(entry_id, audio, audio_duration_sec)
    duration_sec = max(end_seconds, _f(audio_block["durationSec"]))

    chart: dict[str, Any] = {
        "schema": SCHEMA,
        "schemaVersion": SCHEMA_VERSION,
        "generator": f"theDAW notation/{ENGINE} {SCHEMA_VERSION} ({_music21_version()})",
        "generatedAtUtc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {
            "entryId": _s(entry_id),
            "sourceArtifactId": _s(source_artifact_id),
            "sourcePath": _s(source_rel_path) or source_path.name,
            "sourceFormat": source_format,
            "rawMidiArtifactId": "" if raw_is_quantized else _s(raw_midi_artifact_id),
            "title": _s(title),
            "artist": _s(artist),
            "composer": _s(artist),
        },
        "audio": audio_block,
        "timing": {
            # "Beats" are quarter-note lengths everywhere in this document,
            # regardless of meter; ChartEvent.beatInMeasure is the meter-aware
            # notated beat and is a different quantity.
            "beatUnit": "quarter",
            "ticksPerQuarter": _i(ticks_per_quarter, DEFAULT_TICKS_PER_QUARTER),
            "durationSec": duration_sec,
            "durationBeats": end_beats,
            "totalMeasures": len(grid),
            "pickupBeats": _pickup_beats(grid),
            "audioOffsetSec": _f(audio_offset_sec),
        },
        "quantization": {
            "gridDivisionsPerQuarter": grid_divisions,
            "gridLabel": f"1/{grid_divisions * 4}",
            "gridSeconds": grid_seconds,
            "tripletsAllowed": True,
            "engine": "music21.quantize((4,3))"
            if source_format == "midi"
            else "source",
            "rawIsQuantized": raw_is_quantized,
            "rawSource": "" if raw_is_quantized else f"midi:{_s(raw_midi_artifact_id)}",
            "matchedRawEvents": _i(raw_stats["matched"]),
            "unmatchedRawEvents": _i(raw_stats["unmatched"]),
            "maxRawDeviationSec": _f(raw_stats["max_deviation"]),
            "meanAbsRawDeviationSec": _f(raw_stats["mean_deviation"]),
        },
        "tempoMap": tempo_map,
        "timeSignatureMap": _time_signature_map(score, to_seconds, to_measure),
        "keySignatureMap": _key_signature_map(score, to_seconds, to_measure),
        "measures": _measures_block(grid, to_seconds),
        "parts": parts,
        "stats": {
            "partCount": len(parts),
            "noteCount": counters.notes,
            "restCount": counters.rests,
            "chordCount": counters.chords,
            "tupletCount": counters.tuplets,
            "graceCount": counters.graces,
            "tiedCount": counters.tied,
            "measureCount": len(grid),
            "clampedDurations": counters.clamped,
            "densityNotesPerSec": counters.notes / duration_sec
            if duration_sec > 0
            else 0.0,
            "maxSimultaneous": _max_simultaneous(parts),
            "meanAbsRawDeviationSec": _f(raw_stats["mean_deviation"]),
        },
    }
    return _round_tree(chart)


def write_notechart(
    source_path: Path,
    output_path: Path,
    *,
    title: str,
    artist: str,
    entry_id: str,
    audio_duration_sec: float | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Build a chart, write it, and verify the file before reporting success.

    The written file is re-read and re-parsed before this returns ``ok``: the
    ABC export in this module's sibling once reported success while writing
    ``repr(score)`` to disk, and a chart Unity cannot parse must never reach the
    sidebar looking healthy.
    """
    try:
        chart = build_notechart(
            source_path,
            title=title,
            artist=artist,
            entry_id=entry_id,
            audio_duration_sec=audio_duration_sec,
            **kwargs,
        )
    except Exception as exc:  # noqa: BLE001 - report, never raise into the route
        log.warning("notechart: build failed for %s: %s", source_path, exc)
        return {"ok": False, "engine": ENGINE, "error": repr(exc)}

    null_path = _first_null_path(chart)
    if null_path:
        return {
            "ok": False,
            "engine": ENGINE,
            "error": f"chart carries a null at {null_path}; JsonUtility cannot read it",
        }

    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(
            json.dumps(
                chart, ensure_ascii=False, separators=(",", ":"), allow_nan=False
            ),
            encoding="utf-8",
        )
        check = json.loads(output_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return {"ok": False, "engine": ENGINE, "error": f"chart unwritable: {exc!r}"}

    if check.get("schemaVersion") != SCHEMA_VERSION or not check.get("parts"):
        return {
            "ok": False,
            "engine": ENGINE,
            "error": "chart failed self-validation (schemaVersion or parts missing)",
        }

    return {
        "ok": True,
        "path": str(output_path),
        "engine": ENGINE,
        "engine_version": str(SCHEMA_VERSION),
        "schema_version": SCHEMA_VERSION,
        "stats": chart["stats"],
        "quantization": chart["quantization"],
    }


# --------------------------------------------------------------------------
# small helpers used by the public API
# --------------------------------------------------------------------------


def _music21_version() -> str:
    try:
        import music21  # type: ignore[import]

        return f"music21 {getattr(music21, '__version__', 'unknown')}"
    except ImportError:
        return "music21 unknown"


def _expand_repeats(score: Any) -> Any:
    """Expand written repeats, so chart time matches what the audio plays.

    music21 does not expand on parse, so a repeated section would leave every
    later onset short by the length of the repeat. Only attempted when the score
    actually carries repeat marks, and never fatal: malformed repeat structures
    raise, and an unexpanded chart is still readable (measures carry
    startsRepeat / endsRepeat so the scene can tell).
    """
    from music21 import bar as m21bar  # type: ignore[import]

    try:
        if not list(score.recurse().getElementsByClass(m21bar.Repeat)):
            return score
        expanded = score.expandRepeats()
        return expanded if expanded is not None else score
    except Exception as exc:  # noqa: BLE001 - expansion is best-effort
        log.debug("notechart: repeat expansion skipped: %s", exc)
        return score


def _audio_block(
    entry_id: str,
    audio: Optional[dict[str, Any]],
    audio_duration_sec: float | None,
) -> dict[str, Any]:
    given = audio or {}
    duration = (
        audio_duration_sec
        if audio_duration_sec is not None
        else given.get("durationSec")
    )
    return {
        "url": _s(
            given.get("url") or (f"/api/library/audio/{entry_id}" if entry_id else "")
        ),
        "filename": _s(given.get("filename", "")),
        "mimeType": _s(given.get("mimeType", "")),
        "sampleRate": _i(given.get("sampleRate", 44100), 44100),
        "durationSec": _f(duration),
    }
