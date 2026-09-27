"""A MIDI file read into music21 with every note at the time it sounds.

``converter.parse`` on a MIDI file bars the notes, splits a measure whose notes
overlap into voices, ties notes across bar lines and fills the gaps with rests
(``music21.midi.translate.midiTrackToStream``). Two steps of that go wrong on a
transcription whose notes overlap:

  - ``makeTies`` looks only inside a voiced measure's voices
    (``music21/stream/makeNotation.py:1282``). The remainder of a note it split
    at the previous bar line goes into the next measure loose when that measure
    has no voice with the same id (``makeNotation.py:1342``), so a note held
    across two bar lines is never split at the second one.
  - ``makeRests`` then places every measure at the sum of the lengths of the
    measures before it (``makeNotation.py:983``), so a measure overfilled by
    that note moves every later measure, and every note in it, later by the
    overflow.

:func:`read_midi` puts each measure back at the sum of the bar durations before
it, joins the pieces ``makeTies`` split back into one note, and returns parts
with no measures, voices or rests: each note or chord at its absolute offset.
music21 bars and ties them again, correctly, when the score is written.

A MIDI note is the pitch that sounds, so every part is marked
``atSoundingPitch``. music21 reads a General MIDI clarinet, horn, trumpet,
saxophone, English horn, piccolo, contrabass or banjo program as a transposing
instrument, and its MusicXML writer calls ``toWrittenPitch``, which moves a
part at sounding pitch to the written pitch its ``<transpose>`` states. A part
whose ``atSoundingPitch`` is music21's ``'unknown'`` is written untransposed
under that ``<transpose>``, so a reader applying it plays a B-flat clarinet a
whole step low.
"""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

MIDI_SUFFIXES = (".mid", ".midi")

# Part-level context carried over from the import, at its absolute offset.
_CONTEXT_CLASSES = (
    "Instrument",
    "Clef",
    "KeySignature",
    "TimeSignature",
    "MetronomeMark",
)


def is_midi(path: Path) -> bool:
    return Path(path).suffix.lower() in MIDI_SUFFIXES


def read_score(path: Path, *, cache: bool = True) -> Any:
    """``path`` as a music21 score: :func:`read_midi` for a MIDI file,
    ``converter.parse`` for anything else. ``cache=False`` keeps music21 from
    reading or writing its parse cache (for a file about to be deleted). A
    sheet an older build wrote at sounding pitch is marked as such
    (:func:`.sheet_pitch.mark_legacy_sounding_pitch`)."""
    from music21 import converter  # type: ignore[import]

    from .sheet_pitch import mark_legacy_sounding_pitch

    if is_midi(path):
        return read_midi(path, cache=cache)
    score = converter.parse(str(path), forceSource=not cache)
    mark_legacy_sounding_pitch(score, Path(path))
    return score


def read_midi(path: Path, *, cache: bool = True) -> Any:
    """A MIDI file as a ``Score`` of flat parts, each note at its own offset."""
    from music21 import converter, stream  # type: ignore[import]

    parsed = converter.parse(str(path), forceSource=not cache)
    score = stream.Score()
    score.atSoundingPitch = True
    if parsed.metadata is not None:
        score.insert(0, copy.deepcopy(parsed.metadata))
    parts = list(parsed.parts) if isinstance(parsed, stream.Score) else [parsed]
    for part in parts:
        score.insert(0, _flat_part(part))
    return score


def _place_measures(part: Any) -> None:
    """Put each measure at the sum of the bar durations before it."""
    from music21 import common, stream  # type: ignore[import]

    at = 0.0
    for measure in part.getElementsByClass(stream.Measure):
        part.setElementOffset(measure, at)
        length = measure.barDuration.quarterLength - measure.paddingLeft
        at = common.opFrac(at + length - measure.paddingRight)


def _flat_part(part: Any) -> Any:
    from music21 import chord, common, note, stream  # type: ignore[import]

    _place_measures(part)
    flat = part.flatten()

    out = stream.Part()
    out.partName = part.partName
    out.partAbbreviation = part.partAbbreviation
    out.atSoundingPitch = True
    seen: set[tuple[str, float]] = set()
    for element in flat.getElementsByClass(_CONTEXT_CLASSES):
        offset = common.opFrac(element.getOffsetBySite(flat))
        marker = (type(element).__name__, float(offset))
        if marker in seen:
            continue
        seen.add(marker)
        out.insert(offset, copy.deepcopy(element))

    # One piece per sounding pitch: [offset, end, pitch, velocity, tie, lyrics].
    pieces: list[list[Any]] = []
    for element in flat.notes:
        offset = common.opFrac(element.getOffsetBySite(flat))
        end = common.opFrac(offset + element.duration.quarterLength)
        members = list(element.notes) if isinstance(element, chord.Chord) else [element]
        for member in members:
            tie = member.tie if member.tie is not None else element.tie
            velocity = member.volume.velocity
            if velocity is None:
                velocity = element.volume.velocity
            pieces.append(
                [
                    offset,
                    end,
                    member.pitch,
                    velocity,
                    tie.type if tie is not None else None,
                    list(element.lyrics),
                ]
            )

    notes = _join_tied(pieces)

    groups: dict[tuple[float, float], list[list[Any]]] = {}
    for piece in notes:
        groups.setdefault((piece[0], piece[1]), []).append(piece)
    for (offset, end), members in sorted(groups.items(), key=lambda item: item[0]):
        heads = []
        for _offset, _end, pitch, velocity, _tie, _lyrics in sorted(
            members, key=lambda m: m[2].ps
        ):
            head = note.Note(copy.deepcopy(pitch))
            if velocity is not None:
                head.volume.velocity = velocity
            heads.append(head)
        element = heads[0] if len(heads) == 1 else chord.Chord(heads)
        carry_chord_velocity(element)
        element.duration.quarterLength = common.opFrac(end - offset)
        for lyric in members[0][5]:
            element.lyrics.append(copy.deepcopy(lyric))
        out.insert(offset, element)
    return out


def carry_chord_velocity(element: Any) -> None:
    """Give a chord the mean velocity of its heads as its own.

    MusicXML writes one ``dynamics`` value for all the heads of a chord, and
    music21 takes it from the chord's own volume (``m21ToXml`` reads the chord
    passed as ``chordParent``). A chord built from notes has no volume of its
    own, so its heads' velocities never reach the sheet. The heads keep their
    own velocities for anything that plays the score. A percussion chord is a
    chord here too. A single note, or a chord whose heads carry no velocity, is
    left as it is.
    """
    from music21 import chord

    if not isinstance(element, chord.ChordBase):
        return
    velocities = [
        head.volume.velocity
        for head in element.notes
        if head.hasVolumeInformation() and head.volume.velocity is not None
    ]
    if velocities:
        element.volume.velocity = int(round(sum(velocities) / len(velocities)))


def _join_tied(pieces: list[list[Any]]) -> list[list[Any]]:
    """Join each run of tied pieces of one pitch into the note it came from.

    A piece whose tie starts or continues is followed by the next piece of the
    same pitch that begins where it ends and whose tie continues or stops.
    """
    by_pitch: dict[float, list[list[Any]]] = {}
    for piece in pieces:
        by_pitch.setdefault(piece[2].ps, []).append(piece)
    joined: list[list[Any]] = []
    for run in by_pitch.values():
        run.sort(key=lambda p: (p[0], p[1]))
        open_pieces: list[list[Any]] = []
        for piece in run:
            head = next(
                (
                    held
                    for held in open_pieces
                    if held[4] in ("start", "continue")
                    and piece[4] in ("continue", "stop")
                    and abs(float(held[1]) - float(piece[0])) < 1e-9
                ),
                None,
            )
            if head is not None:
                head[1] = piece[1]
                head[4] = piece[4]
                continue
            open_pieces.append(piece)
        joined.extend(open_pieces)
    return joined
