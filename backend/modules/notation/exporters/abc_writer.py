"""ABC notation writer for music21 scores.

music21 parses ABC but cannot write it: ``ConverterABC`` declares
``registerOutputExtensions = ()`` and defines no ``write()``, and its class
docstring says "Input only". Calling ``stream.write('abc')`` therefore falls
through to music21's generic writer, which emits ``repr(stream)`` into the file
and reports success, so the SCORE tab's ABC export produced a 37-byte file
reading ``<music21.stream.Stream 0x...>``.

The maintained third-party option (``abc-xml-converter``, which packages Willem
Vree's ``xml2abc``) hard-pins ``setuptools~=69.5.1`` and ``pyparsing~=3.1.1``
against this project's 80.10.2 / 3.3.2, so adopting it would force a major
downgrade of the environment. This module writes ABC directly from the music21
stream instead: no dependency, no downgrade, and no licence obligation.

Covers what this pipeline actually produces: multi-part scores as ABC voices,
measures and bar lines, notes, chords, rests, accidentals, ties, key and time
signatures, and tempo. Tuplets are carried as sounding durations rather than
``(n`` brackets; see :func:`_element_token` for why.

Reference: the ABC notation standard v2.1, https://abcnotation.com/wiki/abc:standard:v2.1
"""

from __future__ import annotations

import logging
from fractions import Fraction
from typing import Any, Optional

log = logging.getLogger(__name__)

# Sharps count -> major tonic, as ABC spells a key signature.
_MAJOR_FOR_SHARPS = {
    -7: "Cb",
    -6: "Gb",
    -5: "Db",
    -4: "Ab",
    -3: "Eb",
    -2: "Bb",
    -1: "F",
    0: "C",
    1: "G",
    2: "D",
    3: "A",
    4: "E",
    5: "B",
    6: "F#",
    7: "C#",
}

# ABC writes durations as a multiple of the unit note length L. A short unit
# keeps most durations integral; these are the conventional choices.
_LONG_UNIT = Fraction(1, 2)  # an eighth note in quarter-length terms
_SHORT_UNIT = Fraction(1, 4)  # a sixteenth


def _frac(value: Any) -> Fraction:
    """A music21 quarterLength (float, Fraction, or duration tuple) as a
    Fraction, bounded so float noise cannot produce a 10-digit denominator."""
    try:
        return Fraction(value).limit_denominator(64)
    except (TypeError, ValueError):
        return Fraction(1)


def _abc_pitch(pitch: Any) -> str:
    """One music21 pitch as an ABC pitch token.

    ABC puts middle C (C4) at bare uppercase ``C``; the octave above is
    lowercase, higher octaves add ``'`` and lower ones add ``,``. Accidentals
    are prefixes: ``^`` sharp, ``_`` flat, ``=`` natural.
    """
    step = str(getattr(pitch, "step", "C") or "C")
    octave = getattr(pitch, "octave", None)
    octave = 4 if octave is None else int(octave)
    try:
        alter = int(getattr(pitch, "alter", 0) or 0)
    except (TypeError, ValueError):
        alter = 0

    if alter > 0:
        accidental = "^" * min(alter, 2)
    elif alter < 0:
        accidental = "_" * min(-alter, 2)
    else:
        accidental = ""

    if octave >= 5:
        letter = step.lower()
        marks = "'" * (octave - 5)
    else:
        letter = step.upper()
        marks = "," * (4 - octave)
    return f"{accidental}{letter}{marks}"


def _abc_duration(quarter_length: Any, unit: Fraction) -> str:
    """A duration as an ABC length suffix, relative to the unit note length.

    ``1`` is written as the empty string, ``1/2`` as ``/2``, ``3/2`` as ``3/2``.
    """
    ratio = _frac(quarter_length) / unit
    if ratio == 1:
        return ""
    if ratio.denominator == 1:
        return str(ratio.numerator)
    if ratio.numerator == 1:
        return f"/{ratio.denominator}"
    return f"{ratio.numerator}/{ratio.denominator}"


def _pick_unit(meter_ratio: Optional[Fraction]) -> Fraction:
    """The conventional ABC unit note length for a meter: a sixteenth for
    short meters (under 3/4), an eighth otherwise."""
    if meter_ratio is None:
        return _LONG_UNIT
    return _SHORT_UNIT if meter_ratio < Fraction(3, 4) else _LONG_UNIT


def _key_token(key_obj: Any) -> str:
    """A music21 key or key-signature as an ABC ``K:`` value."""
    if key_obj is None:
        return "C"
    tonic = getattr(key_obj, "tonic", None)
    mode = str(getattr(key_obj, "mode", "") or "").lower()
    if tonic is not None:
        name = str(getattr(tonic, "name", "") or "").replace("-", "b")
        if name:
            if mode == "minor":
                return f"{name}m"
            if mode in (
                "dorian",
                "phrygian",
                "lydian",
                "mixolydian",
                "aeolian",
                "locrian",
            ):
                return f"{name}{mode[:3].capitalize()}"
            return name
    try:
        return _MAJOR_FOR_SHARPS.get(int(getattr(key_obj, "sharps", 0) or 0), "C")
    except (TypeError, ValueError):
        return "C"


def _first(stream_obj: Any, cls: Any) -> Any:
    """The first element of a class anywhere in a stream, or None."""
    try:
        found = list(stream_obj.recurse().getElementsByClass(cls))
        return found[0] if found else None
    except Exception:  # noqa: BLE001 - music21 raises broadly on odd streams
        return None


def _element_token(element: Any, unit: Fraction) -> str:
    """One note, chord, or rest as an ABC token (without a trailing bar line).

    Durations are always the SOUNDING length. ABC expresses any rational length
    natively (``A/3`` is a triplet eighth against ``L:1/8``), so tuplets need no
    ``(n`` bracket. Emitting the bracket instead means writing each member at
    its notated value and tracking how many members remain, and getting that
    bookkeeping wrong on this pipeline's heavily-quantized input produced
    durations music21 rejected on re-parse with "Unknown type: complex".
    Sounding lengths round-trip cleanly and carry the same rhythm.
    """
    from music21 import chord, note  # type: ignore[import]

    quarter_length = getattr(getattr(element, "duration", None), "quarterLength", 1)
    length = _abc_duration(quarter_length, unit)

    if isinstance(element, note.Rest):
        return f"z{length}"
    if isinstance(element, chord.Chord):
        pitches = "".join(_abc_pitch(p) for p in element.pitches)
        token = f"[{pitches}]{length}"
    elif isinstance(element, note.Note):
        token = f"{_abc_pitch(element.pitch)}{length}"
    else:
        return ""

    tie = getattr(element, "tie", None)
    if tie is not None and str(getattr(tie, "type", "")) in ("start", "continue"):
        token += "-"
    return token


def _voice_body(part: Any, unit: Fraction) -> str:
    """The ABC body for a single part: measures separated by bar lines."""
    from music21 import chord, note, stream  # type: ignore[import]

    measures = list(part.getElementsByClass(stream.Measure))
    if not measures:
        # A part with no measure structure still exports as one long bar.
        measures = [part]

    lines: list[str] = []
    for measure in measures:
        tokens: list[str] = []
        for element in measure.recurse().getElementsByClass(
            (note.Note, note.Rest, chord.Chord)
        ):
            token = _element_token(element, unit)
            if token:
                tokens.append(token)
        if tokens:
            lines.append(" ".join(tokens))
    if not lines:
        return ""
    body = " | ".join(lines)
    return f"{body} |]"


def score_to_abc(
    score: Any, *, title: str = "", composer: str = "", tune_index: int = 1
) -> str:
    """Render a music21 score as an ABC tune.

    Returns the ABC text. Raises ValueError when the score carries no notes,
    so a caller never registers an empty export as a success.
    """
    from music21 import key as m21key  # type: ignore[import]
    from music21 import meter as m21meter  # type: ignore[import]
    from music21 import stream as m21stream  # type: ignore[import]
    from music21 import tempo as m21tempo  # type: ignore[import]

    if len(list(score.recurse().notes)) == 0:
        raise ValueError("score contains no notes")

    time_signature = _first(score, m21meter.TimeSignature)
    meter_ratio: Optional[Fraction] = None
    meter_token = "4/4"
    if time_signature is not None:
        numerator = int(getattr(time_signature, "numerator", 4) or 4)
        denominator = int(getattr(time_signature, "denominator", 4) or 4)
        meter_token = f"{numerator}/{denominator}"
        meter_ratio = Fraction(numerator, max(1, denominator))

    unit = _pick_unit(meter_ratio)
    key_obj = _first(score, m21key.Key) or _first(score, m21key.KeySignature)

    header: list[str] = [f"X:{tune_index}"]
    header.append(f"T:{title.strip()}" if title.strip() else "T:Untitled")
    if composer.strip():
        header.append(f"C:{composer.strip()}")
    marking = _first(score, m21tempo.MetronomeMark)
    if marking is not None:
        try:
            bpm = int(round(float(marking.getQuarterBPM() or 0)))
            if bpm > 0:
                header.append(f"Q:1/4={bpm}")
        except Exception:  # noqa: BLE001 - tempo is decorative here
            pass
    header.append(f"M:{meter_token}")
    header.append(f"L:{unit.numerator * 1}/{unit.denominator * 4}")

    parts = list(score.getElementsByClass(m21stream.Part))
    if not parts:
        parts = [score]

    bodies: list[tuple[str, str, str]] = []
    for index, part in enumerate(parts, start=1):
        body = _voice_body(part, unit)
        if not body:
            continue
        name = str(getattr(part, "partName", "") or "").strip()
        bodies.append((str(index), name, body))

    if not bodies:
        raise ValueError("score produced no ABC voices")

    # Voice declarations belong in the header block, before K: closes it.
    if len(bodies) > 1:
        for voice_id, name, _ in bodies:
            label = ' name="{}"'.format(name) if name else ""
            header.append(f"V:{voice_id}{label}")
    header.append(f"K:{_key_token(key_obj)}")

    lines = list(header)
    for voice_id, _, body in bodies:
        if len(bodies) > 1:
            lines.append(f"V:{voice_id}")
        lines.append(body)
    return "\n".join(lines) + "\n"
