"""Rule-based score arrangers.

Transforms symbolic music (one or more MIDIs) into different playable
arrangements rendered as MusicXML:

  - ``lead-sheet``      melody (skyline) plus chord symbols
  - ``piano-reduction`` two-staff grand-staff reduction split at middle C
  - ``simplified``      single-staff melody only, quantized
  - ``band-score``      one staff per source stem (percussion staff for drum
                        MIDIs, clef by register, redundant 'full' mix skipped),
                        every staff on one beat grid

Pure music21; no new dependencies. Each builder returns a ``music21`` score
that the engine writes to MusicXML, so the results render in the existing
OpenSheetMusicDisplay viewer.

Every builder writes fresh parts, so each one copies the source's meter, key
and tempo into them: every time signature, key signature and metronome mark at
the offset where the source states it (a band score takes one meter and key
map for all its staves, see :func:`_band_marks`). Each time signature sits on
the bar line where it takes effect, and a source that opens with a pickup bar
gives the arrangement the same pickup (:func:`_bar_like_source`). Each head
keeps the velocity of the notes it stands for. An arrangement is at concert
pitch.
"""

from __future__ import annotations

import copy
import logging
import math
import tempfile
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)

# A MIDI converted to a beat grid is written at no fewer ticks per quarter than
# this, so each note lands within half a millisecond of its source second.
_GRID_RESOLUTION = 960

# Tie types that join a head to the one before it, and to the one after it.
_TIE_IN = ("stop", "continue")
_TIE_OUT = ("start", "continue")

STYLES = ("lead-sheet", "piano-reduction", "simplified", "band-score")

# Pitches at or above middle C (MIDI 60) go to the treble staff.
_TREBLE_BASS_SPLIT = 60

# Band-score register control. A stem whose median pitch is below A3 (57)
# reads on a bass clef. Each clef gets a window of three ledger lines above
# and below the staff; pitches outside it are folded by octave INTO the
# window (pitch class preserved, register normalised), because basic-pitch
# stems span MIDI 22-101 and a ten-ledger-line stack under a treble staff
# inflates every system past the page.
_BAND_BASS_CLEF_BELOW = 57
_CLEF_WINDOWS: dict[str, tuple[int, int]] = {
    "G": (53, 88),  # F3 .. E6 on a treble staff
    "F": (33, 67),  # A1 .. G4 on a bass staff
}
# Keep the lowest pitch plus the top three: a sane skyline and measure width.
_BAND_MAX_CHORD = 4
# Stem names that are a second transcription of the whole mix; redundant
# beside the real stems (measured Jaccard 0.47 against the stem union) and
# always the tallest staff.
_MIX_STEM_NAMES = frozenset({"full", "mix", "master"})
# A band-score meter or key change read in seconds is put on the beat grid at
# the nearest 64th note, which every bar line of a standard meter lies on.
_MARK_STEPS_PER_QUARTER = 16
# Offsets closer than this many quarters are one offset.
_EPS = 1e-6


def arrange(
    sources: list[Path],
    style: str,
    *,
    title: str = "",
    reference_bpm: Optional[float] = None,
) -> dict[str, Any]:
    """Build an arrangement of ``style`` from one or more source MIDIs.

    ``reference_bpm`` (the song's analysed tempo) is the beat grid a band score
    lays every staff out at; see :func:`_grid_bpm` for the tempo used without
    it. The single-source styles keep their source's own tempo.

    Returns a result dict; on success it carries the music21 ``score`` for the
    caller to write. Never raises.
    """
    style = style.lower().strip()
    if style not in STYLES:
        return {"ok": False, "error": f"unknown arrangement style: {style!r}"}
    try:
        import music21  # noqa: F401 - availability check
    except ImportError:
        return {"ok": False, "error": "music21 is not installed."}

    from ..midi_read import read_score

    paths = [Path(s) for s in sources]
    if not paths:
        return {"ok": False, "error": "no source provided"}
    for path in paths:
        if not path.is_file():
            return {"ok": False, "error": f"source not found: {path}"}

    extra_stats: dict[str, Any] = {}
    try:
        if style == "band-score":
            score, extra_stats = _band_score(paths, title, reference_bpm)
        else:
            base = read_score(paths[0])
            # A part for a transposing instrument may hold written pitch; the
            # arrangement, its notes and its key are at concert pitch.
            base.toSoundingPitch(inPlace=True)
            context = _source_context(base)
            pickup = _pickup(base)
            try:
                base = base.quantize((4, 3), inPlace=False, recurse=True)
            except Exception as exc:  # noqa: BLE001 - quantize is best-effort
                log.debug("arrange: quantize skipped for %s: %s", paths[0], exc)
            if style == "piano-reduction":
                score = _piano_reduction(base, title, context)
            elif style == "lead-sheet":
                score = _lead_sheet(base, title, context)
            else:
                score = _simplified(base, title, context)
            # Re-quantize AFTER the merge. These styles all route through
            # _skyline_chords -> chordify(), which slices a new sonority at every
            # onset boundary across every part. When the source mixes duple and
            # triple positions (which the (4, 3) grid above permits by design),
            # those slice widths are differences between the two grids and are
            # not representable as a plain note value, so music21 renders them as
            # nonsense tuplets: 12:7, 24:19, 11:8, 17:16. Snapping the assembled
            # score back onto the same grid removes the slicing artifacts while
            # leaving real triplets alone. Measured on a live piano-reduction:
            # irrational tuplet notes 8 -> 0, total tuplets 690 -> 214, note
            # count unchanged at 1183.
            try:
                score = score.quantize((4, 3), inPlace=False, recurse=True)
            except Exception as exc:  # noqa: BLE001 - quantize is best-effort
                log.debug("arrange: post-merge quantize skipped for %s: %s", style, exc)
            _bar_like_source(score, pickup)
    except Exception as exc:  # noqa: BLE001
        log.warning("arrange: %s failed: %s", style, exc)
        return {"ok": False, "error": repr(exc)}

    note_count = len(score.flatten().notes)
    if note_count == 0:
        return {"ok": False, "error": "no notes found in source(s)"}
    stats: dict[str, Any] = {"parts": len(score.parts), "notes": note_count}
    stats.update(extra_stats)
    return {"ok": True, "style": style, "score": score, "stats": stats}


def _skyline_chords(base: Any) -> list[Any]:
    """Collapse a score to vertical sonorities with absolute offsets."""
    from music21 import chord

    flat = base.chordify().flatten()
    return list(flat.getElementsByClass(chord.Chord))


def _is_hidden(mark: Any) -> bool:
    return bool(getattr(getattr(mark, "style", None), "hideObjectOnPrint", False))


def _source_context(base: Any) -> list[tuple[Any, Any]]:
    """``(offset, mark)`` for every time signature, key signature and metronome
    mark of ``base``, once per kind and offset, in offset order.

    ``base`` must be at sounding pitch, or a transposing part's key signature is
    its written key. Every part of a MIDI repeats the conductor track's marks
    and music21 hides each tempo mark it copies past the first part, so the
    first mark of a kind at an offset stands, a shown tempo mark ahead of a
    hidden one. Parts with pitched notes are read first, because a percussion
    part states no key of the music.
    """
    from music21 import common, key, meter, tempo

    kinds = (meter.TimeSignature, key.KeySignature, tempo.MetronomeMark)
    flats = [part.flatten() for part in (list(getattr(base, "parts", ())) or [base])]
    flats.sort(key=lambda flat: 0 if any(el.pitches for el in flat.notes) else 1)
    found: dict[tuple[Any, int], Any] = {}
    for flat in flats:
        for mark in flat.getElementsByClass(kinds):
            kind = next(i for i, cls in enumerate(kinds) if isinstance(mark, cls))
            at = (common.opFrac(mark.getOffsetBySite(flat)), kind)
            held = found.get(at)
            if held is None or (_is_hidden(held) and not _is_hidden(mark)):
                found[at] = mark
    return [(offset, found[(offset, kind)]) for offset, kind in sorted(found)]


def _pickup(base: Any) -> float:
    """How far into its first bar a source that opens with a pickup starts:
    the quarters music21 pads its first measure by (``paddingLeft``, which the
    MusicXML reader sets on a short first measure), 0 without a pickup or for
    a source read without measures, as a MIDI is."""
    from music21 import stream

    for part in list(getattr(base, "parts", ())) or [base]:
        first = part.getElementsByClass(stream.Measure).first()
        if first is None:
            continue
        padding = float(first.paddingLeft or 0.0)
        bar = float(first.barDuration.quarterLength)
        return padding if _EPS < padding < bar - _EPS else 0.0
    return 0.0


def _snap_meters(part: Any) -> None:
    """Move each time signature of the unbarred ``part`` to the bar line where
    ``makeMeasures`` puts it in force (:mod:`..bar_lines`), so no bar prints a
    meter its contents do not fill."""
    from music21 import meter

    from ..bar_lines import snap_meters_to_bar_lines

    stated = list(part.getElementsByClass(meter.TimeSignature))
    at = [(float(ts.getOffsetBySite(part)), ts.ratioString) for ts in stated]
    for ts in stated:
        part.remove(ts)
    for offset, ratio, index in snap_meters_to_bar_lines(at):
        part.insert(
            offset, stated[index] if index is not None else meter.TimeSignature(ratio)
        )


def _pickup_bar_fits(part: Any, pickup: float) -> bool:
    """Whether the first bar of the barred ``part`` can become a pickup of
    ``pickup`` quarters short: it has no voices and nothing but rests starts
    before ``pickup``."""
    from music21 import stream

    first = part.getElementsByClass(stream.Measure).first()
    if first is None or first.hasVoices():
        return False
    return all(
        el.isRest
        for el in first.notesAndRests
        if el.getOffsetBySite(first) < pickup - _EPS
    )


def _open_with_pickup(part: Any, pickup: float) -> None:
    """Turn the first bar of the barred ``part``, whose music starts ``pickup``
    quarters in, into a pickup bar (:func:`_pickup_bar_fits` must hold): the
    rests before the music go, a rest reaching past ``pickup`` keeping its
    part after it, the rest of the bar moves back by ``pickup`` with
    ``paddingLeft`` set, and every later bar moves back and is numbered one
    lower, so the pickup is bar 0 as in the source."""
    from music21 import common, note, stream

    measures = list(part.getElementsByClass(stream.Measure))
    first = measures[0]
    for el in list(first.notesAndRests):
        offset = el.getOffsetBySite(first)
        if offset < pickup - _EPS:
            first.remove(el)
            end = offset + el.quarterLength
            if end > pickup + _EPS:
                first.insert(pickup, note.Rest(quarterLength=end - pickup))
    for el in list(first.elements):
        offset = el.getOffsetBySite(first)
        if offset >= pickup - _EPS:
            first.setElementOffset(el, common.opFrac(offset - pickup))
    first.paddingLeft = pickup
    first.number = 0
    for measure in measures[1:]:
        part.setElementOffset(
            measure, common.opFrac(measure.getOffsetBySite(part) - pickup)
        )
        measure.number = measure.number - 1


def _bar_like_source(score: Any, pickup: float) -> None:
    """Bar the unbarred parts of a single-source arrangement as the source is.

    Each time signature moves to the bar line it takes effect on
    (:func:`_snap_meters`). With a ``pickup`` (:func:`_pickup`) every note and
    every mark after offset 0 moves ``pickup`` later, so the source's bar lines
    fall on the arrangement's; the parts are then barred and each first bar
    becomes the pickup (:func:`_open_with_pickup`). Without one the writer
    bars the parts.
    """
    from music21 import common, note

    for part in score.parts:
        if pickup:
            for element in list(part.elements):
                offset = element.getOffsetBySite(part)
                if offset > 0 or isinstance(element, note.GeneralNote):
                    part.setElementOffset(element, common.opFrac(offset + pickup))
        _snap_meters(part)
    if pickup:
        # As music21's writer bars a score: every part to the end of the
        # longest, so a staff that falls silent keeps its bars.
        end = [0.0, float(score.highestTime)]
        for part in score.parts:
            part.makeNotation(refStreamOrTimeRange=end, inPlace=True)
        # Every staff opens with the pickup, or none does and each first bar
        # opens on rests, so the staves keep one bar grid.
        if all(_pickup_bar_fits(part, pickup) for part in score.parts):
            for part in score.parts:
                _open_with_pickup(part, pickup)


def _hidden_tempo(mark: Any) -> Any:
    """A copy of ``mark`` as music21 writes a MIDI's tempo into every part after
    the first: nothing printed, the same ``<sound tempo>``."""
    hidden = copy.deepcopy(mark)
    hidden.numberImplicit = True
    hidden.style.hideObjectOnPrint = True
    return hidden


def _carry_context(
    part: Any, context: list[tuple[Any, Any]], *, shows_tempo: bool
) -> None:
    """Insert a copy of every ``(offset, mark)`` of ``context`` into ``part``.

    Only the part that ``shows_tempo`` prints the metronome marks; every other
    part carries each one hidden, so a part extracted on its own still plays
    at its tempo.
    """
    from music21 import tempo

    for offset, mark in context:
        if isinstance(mark, tempo.MetronomeMark) and not shows_tempo:
            part.insert(offset, _hidden_tempo(mark))
        else:
            part.insert(offset, copy.deepcopy(mark))


def _velocity(notes: list[Any]) -> Optional[int]:
    """The velocity of a head written for ``notes``: the loudest of them, or
    None when none carries one."""
    values = [
        n.volume.velocity
        for n in notes
        if n.hasVolumeInformation() and n.volume.velocity is not None
    ]
    return max(values) if values else None


def _tie_type(notes: list[Any]) -> Optional[str]:
    """The tie of a head written for ``notes`` of a chordified sonority.

    ``chordify`` cuts a held note wherever another note starts or ends and ties
    the pieces. The head continues a held note only when every note it stands
    for does, and runs on only when every one of them does.
    """
    types = [n.tie.type if n.tie is not None else None for n in notes]
    incoming = all(t in _TIE_IN for t in types)
    outgoing = all(t in _TIE_OUT for t in types)
    if incoming and outgoing:
        return "continue"
    if incoming:
        return "stop"
    if outgoing:
        return "start"
    return None


def _voice(
    heads: list[tuple[Any, Optional[str], Optional[int]]], quarter_length: float
) -> Any:
    """A note or chord of ``(pitch, tie type, velocity)`` heads."""
    from music21 import chord, note, tie

    from ..midi_read import carry_chord_velocity

    notes = []
    for pitch, tie_type, velocity in heads:
        head = note.Note(pitch)
        if tie_type:
            head.tie = tie.Tie(tie_type)
        if velocity is not None:
            head.volume.velocity = velocity
        notes.append(head)
    element = notes[0] if len(notes) == 1 else chord.Chord(notes)
    carry_chord_velocity(element)
    element.duration.quarterLength = quarter_length or 1.0
    return element


def _mend_ties(part: Any) -> None:
    """Strike a head only where its note is struck.

    A head tied in continues the head of its pitch that ends where it starts.
    Octave folding, the chord cap and the skyline drop heads, so that head can
    be missing: the note was struck earlier, under another head, and nothing is
    struck here. Such a head is removed, and with it the rest of its tied run,
    so it never reads as a new note. A tie out of a head that no head
    continues is released.
    """
    from music21 import chord, common, harmony, note, tie

    heads: list[tuple[Any, Any, int, Any, Any]] = []
    for element in part.getElementsByClass((note.Note, chord.Chord)):
        if isinstance(element, harmony.ChordSymbol):
            continue
        offset = common.opFrac(element.offset)
        end = common.opFrac(offset + element.duration.quarterLength)
        members = list(element.notes) if isinstance(element, chord.Chord) else [element]
        for head in members:
            heads.append((offset, end, int(head.pitch.midi), head, element))
    heads.sort(key=lambda h: (h[0], h[2]))

    def kind(head: Any) -> Optional[str]:
        return head.tie.type if head.tie is not None else None

    kept: list[tuple[Any, Any, int, Any]] = []
    kept_ending: dict[tuple[Any, int], Any] = {}
    dropped: dict[int, tuple[Any, list[Any]]] = {}
    for offset, end, midi, head, element in heads:
        before = kept_ending.get((offset, midi))
        if kind(head) in _TIE_IN and (before is None or kind(before) not in _TIE_OUT):
            dropped.setdefault(id(element), (element, []))[1].append(head)
            continue
        kept_ending[(end, midi)] = head
        kept.append((offset, end, midi, head))

    kept_starting = {(offset, midi): head for offset, _end, midi, head in kept}
    decided: list[tuple[Any, Optional[str]]] = []
    for _offset, end, midi, head in kept:
        current = kind(head)
        after = kept_starting.get((end, midi))
        out_ok = current in _TIE_OUT and after is not None and kind(after) in _TIE_IN
        in_ok = current in _TIE_IN
        if in_ok and out_ok:
            decided.append((head, "continue"))
        elif in_ok:
            decided.append((head, "stop"))
        elif out_ok:
            decided.append((head, "start"))
        else:
            decided.append((head, None))
    for head, tie_type in decided:
        head.tie = tie.Tie(tie_type) if tie_type else None

    from ..midi_read import carry_chord_velocity

    for element, gone in dropped.values():
        members = list(element.notes) if isinstance(element, chord.Chord) else [element]
        if len(gone) == len(members):
            part.remove(element)
        else:
            for head in gone:
                element.remove(head)
            carry_chord_velocity(element)


def _new_score(title: str, fallback: str) -> Any:
    from music21 import metadata, stream

    score = stream.Score()
    score.insert(0, metadata.Metadata())
    score.metadata.title = title or fallback
    return score


def _piano_reduction(base: Any, title: str, context: list[tuple[Any, Any]]) -> Any:
    from music21 import clef, stream

    treble = stream.Part()
    treble.partName = "Piano R.H."
    treble.insert(0, clef.TrebleClef())
    _carry_context(treble, context, shows_tempo=True)
    bass = stream.Part()
    bass.partName = "Piano L.H."
    bass.insert(0, clef.BassClef())
    _carry_context(bass, context, shows_tempo=False)

    for sonority in _skyline_chords(base):
        ql = sonority.duration.quarterLength
        heads = sorted(
            ((n.pitch, _tie_type([n]), _velocity([n])) for n in sonority.notes),
            key=lambda head: head[0].midi,
        )
        high = [head for head in heads if head[0].midi >= _TREBLE_BASS_SPLIT]
        low = [head for head in heads if head[0].midi < _TREBLE_BASS_SPLIT]
        if high:
            treble.insert(sonority.offset, _voice(high, ql))
        if low:
            bass.insert(sonority.offset, _voice(low, ql))
    _mend_ties(treble)
    _mend_ties(bass)

    score = _new_score(title, "Piano Reduction")
    score.insert(0, treble)
    score.insert(0, bass)
    return score


def _simplified(base: Any, title: str, context: list[tuple[Any, Any]]) -> Any:
    from music21 import clef, stream

    melody = stream.Part()
    melody.partName = "Melody"
    melody.insert(0, clef.TrebleClef())
    _carry_context(melody, context, shows_tempo=True)
    for sonority in _skyline_chords(base):
        top = max(sonority.notes, key=lambda n: n.pitch.midi)
        element = _voice(
            [(top.pitch, _tie_type([top]), _velocity([top]))],
            sonority.duration.quarterLength,
        )
        melody.insert(sonority.offset, element)
    _mend_ties(melody)

    score = _new_score(title, "Simplified Melody")
    score.insert(0, melody)
    return score


def _safe_chord_symbol(sonority: Any) -> Any:
    """Return a renderable ChordSymbol for a sonority, or None.

    music21's ``chordSymbolFromChord`` returns an "unidentified" symbol for
    chords it can't name, and inserting one crashes MusicXML export with
    "no pitches in chord". This rebuilds from the figure and verifies it.
    """
    from music21 import harmony

    try:
        figure = getattr(harmony.chordSymbolFromChord(sonority), "figure", "") or ""
    except Exception:  # noqa: BLE001 - many chords have no clean symbol
        return None
    if not figure or "Cannot Be Identified" in figure:
        return None
    try:
        clean = harmony.ChordSymbol(figure)
    except Exception:  # noqa: BLE001
        return None
    return clean if clean.pitches else None


def _lead_sheet(base: Any, title: str, context: list[tuple[Any, Any]]) -> Any:
    from music21 import clef, stream

    lead = stream.Part()
    lead.partName = "Lead"
    lead.insert(0, clef.TrebleClef())
    _carry_context(lead, context, shows_tempo=True)
    last_figure = None
    for sonority in _skyline_chords(base):
        top = max(sonority.notes, key=lambda n: n.pitch.midi)
        element = _voice(
            [(top.pitch, _tie_type([top]), _velocity([top]))],
            sonority.duration.quarterLength,
        )
        lead.insert(sonority.offset, element)
        # A triad is the minimum for a meaningful, identifiable chord symbol.
        if len(sonority.pitches) >= 3:
            symbol = _safe_chord_symbol(sonority)
            if symbol is not None and symbol.figure != last_figure:
                lead.insert(sonority.offset, symbol)
                last_figure = symbol.figure
    _mend_ties(lead)

    score = _new_score(title, "Lead Sheet")
    score.insert(0, lead)
    return score


def _stem_base(path: Path) -> str:
    """Normalised stem name: lower-case, last ``__``-separated segment
    (``Song__full`` -> ``full``)."""
    stem = path.stem.lower().strip()
    if "__" in stem:
        stem = stem.rsplit("__", 1)[-1]
    return stem


def _is_mix_stem(path: Path) -> bool:
    return _stem_base(path) in _MIX_STEM_NAMES


def _is_drum_named(path: Path) -> bool:
    base = _stem_base(path)
    return "drum" in base or "percussion" in base


def _clef_for_pitches(midis: list[int]) -> str:
    """'F' (bass) when the median pitch sits below A3, else 'G' (treble)."""
    if not midis:
        return "G"
    ordered = sorted(midis)
    median = ordered[len(ordered) // 2]
    return "F" if median < _BAND_BASS_CLEF_BELOW else "G"


def fold_into_window(midi: int, low: int, high: int) -> int:
    """Move ``midi`` by whole octaves until it lies in ``[low, high]``.

    The window is always at least an octave wide, so the result is unique.
    """
    while midi < low:
        midi += 12
    while midi > high:
        midi -= 12
    return midi


def _band_voice(
    notes: list[Any], quarter_length: float, window: tuple[int, int]
) -> tuple[Any, int]:
    """One band-score sonority: the notes of a chordified sonority folded into
    the clef window, deduped, capped at ``_BAND_MAX_CHORD`` (lowest + top
    three), each head tied as the notes it stands for are and as loud as the
    loudest of them. Returns the element and the number of pitches that were
    folded."""
    from music21 import pitch as m21pitch

    low, high = window
    folded = 0
    sources: dict[int, list[Any]] = {}
    for n in notes:
        midi = int(n.pitch.midi)
        target = fold_into_window(midi, low, high)
        if target != midi:
            folded += 1
        sources.setdefault(target, []).append(n)
    kept = sorted(sources)
    if len(kept) > _BAND_MAX_CHORD:
        kept = [kept[0]] + kept[-(_BAND_MAX_CHORD - 1) :]
    heads = [
        (m21pitch.Pitch(midi=m), _tie_type(sources[m]), _velocity(sources[m]))
        for m in kept
    ]
    return _voice(heads, quarter_length), folded


def _grid_bpm(
    staves: list[tuple[Path, str, bool]], reference_bpm: Optional[float]
) -> float:
    """The one tempo a band score lays every staff out at.

    ``reference_bpm`` when it is a positive number. Otherwise the tempo of the
    first drum-kit MIDI, because the drum transcriber writes the song's
    analysed tempo; otherwise the first staff's own tempo.
    """
    import pretty_midi

    from .percussion import _DEFAULT_TEMPO, _initial_tempo

    if reference_bpm is not None and math.isfinite(reference_bpm) and reference_bpm > 0:
        return float(reference_bpm)
    if not staves:
        return _DEFAULT_TEMPO
    path = next((p for p, _name, drum_kit in staves if drum_kit), staves[0][0])
    return _initial_tempo(pretty_midi.PrettyMIDI(str(path)))


def _grid_offset(seconds: float, bpm: float) -> Any:
    """``seconds`` as quarters of ``bpm``, at the nearest 64th note."""
    from music21 import common

    steps = round(float(seconds) * bpm / 60.0 * _MARK_STEPS_PER_QUARTER)
    return common.opFrac(steps / _MARK_STEPS_PER_QUARTER)


def _changes_only(marks: list[tuple[Any, Any]]) -> list[tuple[Any, Any]]:
    """``(offset, value)`` marks in offset order, keeping the later of two at
    one offset and dropping any that restates the value in force."""
    out: list[tuple[Any, Any]] = []
    for offset, value in sorted(marks, key=lambda mark: mark[0]):
        if out and out[-1][0] == offset:
            out.pop()
        if not out or out[-1][1] != value:
            out.append((offset, value))
    return out


def _band_marks(
    staves: list[tuple[Path, str, bool]], bpm: float
) -> tuple[list[tuple[Any, str]], list[tuple[Any, Any]]]:
    """The one meter map and the one key map every staff of a band score is
    barred and keyed by: ``([(offset, "n/d")], [(offset, Key)])``, each offset
    on the ``bpm`` grid and each meter on the bar line it takes effect on
    (:func:`..bar_lines.snap_meters_to_bar_lines`).

    The stems of one song are separate files, and a staff barred by its own
    file disagrees with its neighbours wherever the files do (basic-pitch
    states no meter at all). The meter map is that of the first stem that
    states a time signature, a drum-kit MIDI ahead of the rest as for the grid
    tempo; the key map is that of the first pitched stem that states a key.
    Stems that state neither leave the score in music21's default 4/4 with no
    key signature.
    """
    import pretty_midi
    from music21 import common, key

    from ..bar_lines import snap_meters_to_bar_lines

    files = {path: pretty_midi.PrettyMIDI(str(path)) for path, _name, _drum in staves}
    meters: list[tuple[Any, str]] = []
    for path, _name, _drum in sorted(staves, key=lambda staff: not staff[2]):
        stated = [
            (_grid_offset(ts.time, bpm), f"{int(ts.numerator)}/{int(ts.denominator)}")
            for ts in files[path].time_signature_changes
            if ts.numerator > 0 and ts.denominator > 0
        ]
        if stated:
            meters = [
                (common.opFrac(offset), ratio)
                for offset, ratio, _i in snap_meters_to_bar_lines(stated)
            ]
            break
    keys: list[tuple[Any, Any]] = []
    for path, _name, drum_kit in staves:
        if drum_kit or not files[path].key_signature_changes:
            continue
        stated_keys = []
        for ks in files[path].key_signature_changes:
            mode, sharps = pretty_midi.key_number_to_mode_accidentals(ks.key_number)
            tonality = key.KeySignature(sharps).asKey("minor" if mode else "major")
            stated_keys.append((_grid_offset(ks.time, bpm), tonality))
        keys = _changes_only(stated_keys)
        break
    return meters, keys


def _conform_midi(source: Path, bpm: float, target: Path) -> Path:
    """Put ``source`` on a constant ``bpm`` grid and return the file to read.

    A MIDI whose only tempo is already ``bpm`` is returned as it is. Any other
    is written to ``target`` at ``bpm``, with every note, time signature and
    key signature at the second it sounds in ``source``, and ``target`` is
    returned. Its quarter-note offsets then count beats of ``bpm``.
    """
    import pretty_midi

    from .percussion import _initial_tempo

    pm = pretty_midi.PrettyMIDI(str(source))
    _times, tempi = pm.get_tempo_changes()
    if len(tempi) <= 1 and _initial_tempo(pm) == bpm:
        return source
    out = pretty_midi.PrettyMIDI(
        resolution=max(int(pm.resolution), _GRID_RESOLUTION), initial_tempo=bpm
    )
    out.instruments = pm.instruments
    out.time_signature_changes = pm.time_signature_changes
    out.key_signature_changes = pm.key_signature_changes
    target.parent.mkdir(parents=True, exist_ok=True)
    out.write(str(target))
    return target


def _band_score(
    paths: list[Path], title: str, reference_bpm: Optional[float] = None
) -> tuple[Any, dict[str, Any]]:
    """One staff per stem, every staff on one beat grid.

    * With more than one source, a whole-mix stem (``full``/``mix``/``master``)
      is skipped: it duplicates the real stems and is always the tallest staff.
    * A drum-kit MIDI (``is_drum`` instruments, or GM kit pitches in a file
      named like a drum stem) becomes an unpitched percussion staff.
    * A drum-NAMED stem that is NOT kit data (a pitched transcription of a
      drum stem: hundreds of spurious notes across five octaves) is skipped
      when other stems exist: omitting is honest, chordifying is garbage.
    * Every other stem picks its clef from its median pitch, folds outliers by
      octave into a three-ledger-line window and caps chords at four pitches.

    The stem MIDIs of one song declare different tempos: the drum transcriber
    writes the analysed tempo and basic-pitch writes 120. A quarter note is a
    different length of time in each, so every staff is laid out at the one
    tempo :func:`_grid_bpm` picks, each note at the second it sounds in its own
    file, and the score prints one metronome mark at that tempo: on the first
    percussion staff, else on the top staff. Every other staff carries the
    mark unprinted. Every staff is barred and keyed by :func:`_band_marks`.

    Returns ``(score, stats)`` with ``stats = {skipped, skip_reasons, clefs,
    folded_notes}``.
    """
    from music21 import chord, clef, meter, stream

    from ..midi_read import read_score
    from ..tempo_marks import metronome_mark
    from .percussion import build_percussion_part, is_drum_midi

    score = _new_score(title, "Band Score")
    skipped: list[str] = []
    skip_reasons: dict[str, str] = {}
    clefs: dict[str, str] = {}
    folded_total = 0
    multi = len(paths) > 1

    staves: list[tuple[Path, str, bool]] = []
    for index, path in enumerate(paths):
        part_name = path.stem[:24] or f"Part {index + 1}"
        drum_kit = is_drum_midi(path)
        if multi and not drum_kit and _is_mix_stem(path):
            skipped.append(path.stem)
            skip_reasons[path.stem] = "whole-mix transcription duplicates the stems"
            continue
        if multi and not drum_kit and _is_drum_named(path):
            skipped.append(path.stem)
            skip_reasons[path.stem] = (
                "pitched transcription of a drum stem (no kit data)"
            )
            continue
        staves.append((path, part_name, drum_kit))

    bpm = _grid_bpm(staves, reference_bpm)
    meters, keys = _band_marks(staves, bpm)
    shows_tempo = next((i for i, staff in enumerate(staves) if staff[2]), 0)
    with tempfile.TemporaryDirectory(prefix="band_grid_") as scratch:
        for index, (path, part_name, drum_kit) in enumerate(staves):
            if drum_kit:
                part = build_percussion_part(
                    path,
                    title=part_name,
                    bpm=bpm,
                    time_signatures=meters,
                    shows_tempo=index == shows_tempo,
                )
                clefs[part_name] = "percussion"
                score.insert(0, part)
                continue

            staff_midi = _conform_midi(path, bpm, Path(scratch) / f"{index}.mid")
            # A converted file lives in a directory deleted below; music21 would
            # otherwise pickle it into its cache under a path never read again.
            source = read_score(staff_midi, cache=staff_midi == path)
            try:
                source = source.quantize((4, 3), inPlace=False, recurse=True)
            except Exception as exc:  # noqa: BLE001 - quantize is best-effort
                log.debug("arrange: quantize skipped for %s: %s", path, exc)
            sonorities = list(
                source.chordify().flatten().getElementsByClass(chord.Chord)
            )
            clef_sign = _clef_for_pitches(
                [int(p.midi) for sonority in sonorities for p in sonority.pitches]
            )
            window = _CLEF_WINDOWS[clef_sign]
            # Rebuild each stem into a fresh part (as the other builders do) so
            # the MusicXML writer bars it with a consistent time signature.
            # Inserting chordify()'s pre-measured stream directly produced scores
            # OSMD could not render ("Cannot read properties of undefined
            # (reading 'denominator')").
            part = stream.Part()
            part.partName = part_name
            part.partAbbreviation = part_name[:6]
            part.insert(0, clef.BassClef() if clef_sign == "F" else clef.TrebleClef())
            for offset, ratio in meters:
                part.insert(offset, meter.TimeSignature(ratio))
            for offset, tonality in keys:
                part.insert(offset, copy.deepcopy(tonality))
            mark = metronome_mark(bpm)
            part.insert(0, mark if index == shows_tempo else _hidden_tempo(mark))
            for sonority in sonorities:
                element, folded = _band_voice(
                    list(sonority.notes), sonority.duration.quarterLength, window
                )
                folded_total += folded
                part.insert(sonority.offset, element)
            _mend_ties(part)
            clefs[part_name] = clef_sign
            score.insert(0, part)

    stats: dict[str, Any] = {
        "skipped": skipped,
        "skip_reasons": skip_reasons,
        "clefs": clefs,
        "folded_notes": folded_total,
    }
    return score, stats
