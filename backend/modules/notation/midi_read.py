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

theDAW's roll writes what FF 58 cannot hold in text events beside each time
signature (``frontend/src/lib/midi.ts`` ``meterEventMetas``):
``theDAW:groups=2+2+3`` is the bar's grouping, in units of the denominator,
and ``theDAW:pickup=<16th steps>`` on the tick-0 signature is the roll's
pickup, which the file states as a short signature at tick 0 followed by the
real one where bar 1 starts. :func:`read_midi_meters` reads both.
:func:`read_midi` builds every time signature from its grouping (7/8
``2+2+3`` beams and accents two, two and three eighths) and opens a file with
a pickup on a pickup bar of the real meter (``paddingLeft`` set, bar 0),
barring its parts to do so. A roll's ticks are its notes exactly, so a file
carrying any ``theDAW:`` text is parsed with ``quantizePost=False`` and the
score is marked exact (:func:`..grid.mark_exact`): nothing quantizes it again.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

MIDI_SUFFIXES = (".mid", ".midi")

# The text events theDAW's roll writes (frontend/src/lib/midi.ts).
DAW_TEXT = "theDAW:"
GROUPS_TEXT = "theDAW:groups="
PICKUP_TEXT = "theDAW:pickup="

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
    from music21 import converter

    from .sheet_pitch import mark_legacy_sounding_pitch

    if is_midi(path):
        return read_midi(path, cache=cache)
    score = converter.parse(str(path), forceSource=not cache)
    mark_legacy_sounding_pitch(score, Path(path))
    return score


@dataclass(frozen=True)
class MeterMark:
    """One FF 58 time signature at its tick, with the grouping its
    ``theDAW:groups=`` text gives (empty without one)."""

    tick: int
    num: int
    den: int
    groups: tuple[int, ...] = ()

    @property
    def spec(self) -> str:
        from .bar_lines import meter_spec

        return meter_spec(self.num, self.den, self.groups)


@dataclass(frozen=True)
class MidiMeters:
    """Every time signature of a MIDI file, merged across its tracks.

    ``pickup_steps`` is the ``theDAW:pickup=`` text on the tick-0 signature
    (16th steps; ``None`` when the file has none) and ``roll`` whether the file
    carries any ``theDAW:`` text, which only theDAW's roll writes.
    """

    ppq: int
    marks: tuple[MeterMark, ...]
    pickup_steps: Optional[float]
    roll: bool

    def pickup_holds(self) -> bool:
        """Whether the file opens with the pickup its text states: a signature
        at tick 0, the next one where the pickup ends, and the pickup shorter
        than a bar of that next one."""
        if not self.pickup_steps or self.pickup_steps <= 0 or len(self.marks) < 2:
            return False
        first, second = self.marks[0], self.marks[1]
        pickup_ticks = self.pickup_steps * self.ppq / 4.0
        if first.tick != 0 or abs(second.tick - pickup_ticks) > 1:
            return False
        bar_ticks = second.num * 4.0 * self.ppq / second.den
        return pickup_ticks < bar_ticks - 1

    def stated(
        self, quarters: Callable[[int], float]
    ) -> tuple[list[tuple[float, str]], float]:
        """``([(offset, spec)], padding)`` with each offset ``quarters(tick)``.

        With a pickup (:meth:`pickup_holds`) the short tick-0 signature is
        left out, the real meter stands at 0, and ``padding`` is how far into
        a bar of it the music starts (the pickup bar's ``paddingLeft``): the
        caller moves the music that much later and opens on a pickup bar
        (:func:`.bar_lines.bar_like_source`). Without one ``padding`` is 0 and
        every signature stands where the file states it.
        """
        from .bar_lines import bar_quarters

        if not self.pickup_holds():
            return [(quarters(m.tick), m.spec) for m in self.marks], 0.0
        real = self.marks[1:]
        pickup = quarters(real[0].tick)
        padding = bar_quarters(real[0].spec) - pickup
        out = [(0.0, real[0].spec)]
        out += [(quarters(m.tick), m.spec) for m in real[1:]]
        return out, padding if padding > 1e-9 else 0.0


def read_midi_meters(path: Path) -> Optional[MidiMeters]:
    """The time signatures, groupings and pickup of the MIDI file at ``path``,
    read from every track; ``None`` when the file does not read."""
    try:
        import mido

        midi = mido.MidiFile(str(path), clip=True)
    except (
        ImportError,
        OSError,
        EOFError,
        ValueError,
        KeyError,
        IndexError,
        TypeError,
    ):
        # An unreadable file states no meter.
        return None
    by_tick: dict[int, tuple[int, int]] = {}
    groups: dict[int, tuple[int, ...]] = {}
    pickup: Optional[float] = None
    roll = False
    for track in midi.tracks:
        tick = 0
        for message in track:
            tick += int(message.time)
            kind = message.type
            if kind == "time_signature" and message.numerator > 0:
                by_tick[tick] = (int(message.numerator), int(message.denominator))
            elif kind == "text":
                text = str(message.text)
                if not text.startswith(DAW_TEXT):
                    continue
                roll = True
                if text.startswith(GROUPS_TEXT):
                    parsed = _int_groups(text[len(GROUPS_TEXT) :])
                    if parsed:
                        groups[tick] = parsed
                elif text.startswith(PICKUP_TEXT) and tick == 0:
                    try:
                        steps = float(text[len(PICKUP_TEXT) :])
                    except ValueError:
                        continue
                    if steps >= 0:
                        pickup = steps
    marks = tuple(
        MeterMark(tick, num, den, groups.get(tick, ()))
        for tick, (num, den) in sorted(by_tick.items())
    )
    return MidiMeters(
        ppq=int(midi.ticks_per_beat or 480),
        marks=marks,
        pickup_steps=pickup,
        roll=roll,
    )


def _int_groups(text: str) -> tuple[int, ...]:
    try:
        values = tuple(int(g) for g in text.split("+"))
    except ValueError:
        return ()
    return values if values and all(v >= 1 for v in values) else ()


def read_midi(path: Path, *, cache: bool = True) -> Any:
    """A MIDI file as a ``Score`` of flat parts, each note at its own offset.

    Every time signature is built from its ``theDAW:groups=`` grouping. A
    file that opens with a ``theDAW:pickup=`` pickup is barred here, its first
    bar the pickup (``paddingLeft``), since a flat part cannot say where its
    bar lines fall. A roll file (any ``theDAW:`` text) is read at its exact
    ticks and marked exact (:func:`.grid.mark_exact`).
    """
    from music21 import converter, meter, stream

    from .arrangers.percussion import engrave_pitched_percussion_parts
    from .bar_lines import bar_like_source, time_signature
    from .grid import mark_exact

    meters = read_midi_meters(Path(path))
    keywords: dict[str, Any] = {}
    if meters is not None and meters.roll:
        keywords["quantizePost"] = False
    parsed = converter.parse(str(path), forceSource=not cache, **keywords)
    score = stream.Score()
    score.atSoundingPitch = True
    if parsed.metadata is not None:
        score.insert(0, copy.deepcopy(parsed.metadata))
    parts = list(parsed.parts) if isinstance(parsed, stream.Score) else [parsed]
    stated: list[tuple[float, str]] = []
    padding = 0.0
    if meters is not None and meters.marks:
        ppq = float(meters.ppq)
        stated, padding = meters.stated(lambda tick: tick / ppq)
    for part in parts:
        flat = _flat_part(part)
        if stated:
            for ts in list(flat.getElementsByClass(meter.TimeSignature)):
                flat.remove(ts)
            for offset, spec in stated:
                flat.insert(offset, time_signature(spec))
        score.insert(0, flat)
    # Timpani and the mallets read as themselves: clef, names, and the octaves
    # a glockenspiel or xylophone sounds above the written note.
    engrave_pitched_percussion_parts(score)
    if meters is not None and meters.roll:
        mark_exact(score)
    if padding:
        bar_like_source(score, padding)
    return score


def _place_measures(part: Any) -> None:
    """Put each measure at the sum of the bar durations before it."""
    from music21 import common, stream

    at = 0.0
    for measure in part.getElementsByClass(stream.Measure):
        part.setElementOffset(measure, at)
        length = measure.barDuration.quarterLength - measure.paddingLeft
        at = common.opFrac(at + length - measure.paddingRight)


def _flat_part(part: Any) -> Any:
    from music21 import chord, common, note, stream

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
