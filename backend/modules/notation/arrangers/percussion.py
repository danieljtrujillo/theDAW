"""Drum-kit MIDI → unpitched percussion staff.

A drum MIDI (General MIDI channel 10, ``is_drum`` instruments) carries kit
voices as MIDI pitches, not notes. Chordifying it onto a treble staff prints
the kick as an F2 and the hi-hat as an F#3 — pitched garbage. This module
maps every General MIDI kit voice to its standard drum-kit staff position
(kick on the first space, snare on the third, hats and cymbals above the
staff with ``x`` heads, toms on the spaces) and builds a music21 part on a
``PercussionClef`` with ``note.Unpitched`` events, which MusicXML writes as
``<unpitched>`` + ``<notehead>`` and OpenSheetMusicDisplay renders as a real
percussion staff.

Pure music21 + pretty_midi; no new dependencies. Both the band-score
arranger and the plain MIDI → MusicXML conversion route drum sources here.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)

# General MIDI kit voices the drum transcriber writes (backend/modules/midi/
# drums.py mirrors this table; 39 = hand clap is the generic fallback).
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

GM_PITCHES: frozenset[int] = frozenset(GM.values())

# GM pitch -> (display step, display octave, notehead). Standard drum-kit
# notation on a five-line percussion staff (treble-clef positions): kick F4
# (first space), snare C5 (third space), toms on the spaces (A4 / D5 / E5),
# hi-hat G5 with an x head (open hat: circle-x), crash A5 x, ride F5 x,
# generic percussion C5 x.
DRUM_STAFF: dict[int, tuple[str, int, str]] = {
    36: ("F", 4, "normal"),
    38: ("C", 5, "normal"),
    42: ("G", 5, "x"),
    46: ("G", 5, "circle-x"),
    49: ("A", 5, "x"),
    51: ("F", 5, "x"),
    45: ("A", 4, "normal"),
    47: ("D", 5, "normal"),
    50: ("E", 5, "normal"),
    39: ("C", 5, "x"),
}

# Highway / note-chart voice names (coarser than GM: both hats are 'hihat',
# all toms are 'tom').
DRUM_VOICE_FOR_PITCH: dict[int, str] = {
    36: "kick",
    38: "snare",
    42: "hihat",
    46: "hihat",
    49: "crash",
    51: "ride",
    45: "tom",
    47: "tom",
    50: "tom",
    39: "perc",
}

# Extra GM kit pitches folded onto the nearest notated voice so real-world
# drum MIDIs (not only our transcriber's ten voices) still land on the staff.
_GM_ALIASES: dict[int, int] = {
    35: 36,  # acoustic bass drum -> kick
    37: 38,  # side stick -> snare
    40: 38,  # electric snare -> snare
    41: 45,  # low floor tom -> tom_low
    43: 45,  # high floor tom -> tom_low
    44: 42,  # pedal hi-hat -> closed hat
    48: 47,  # hi-mid tom -> tom_mid
    52: 49,  # china cymbal -> crash
    53: 51,  # ride bell -> ride
    55: 49,  # splash -> crash
    57: 49,  # crash 2 -> crash
    59: 51,  # ride 2 -> ride
}

_DISPLAY_TO_PITCH: dict[tuple[str, int, str], int] = {
    (step, octave, head): pitch for pitch, (step, octave, head) in DRUM_STAFF.items()
}

_QUANT = 0.25  # 1/16 note in quarter lengths
_MIN_QL = 0.25
_DEFAULT_TEMPO = 120.0


def canonical_drum_pitch(pitch: int) -> int:
    """Map any GM kit pitch onto one of the ten notated voices (39 = perc
    when nothing closer is known)."""
    pitch = int(pitch)
    if pitch in DRUM_STAFF:
        return pitch
    return _GM_ALIASES.get(pitch, GM["perc"])


def drum_voice_for_pitch(pitch: int) -> str:
    """Coarse voice name ('kick' | 'snare' | 'hihat' | 'tom' | 'crash' |
    'ride' | 'perc') for a GM kit pitch."""
    return DRUM_VOICE_FOR_PITCH.get(canonical_drum_pitch(pitch), "perc")


def gm_pitch_for_display(step: str, octave: int, notehead: str = "normal") -> int:
    """Reverse lookup: staff position (+ notehead) → GM pitch, 0 when unknown.

    Used by the note-chart exporter to recover ``midi``/``drumVoice`` from an
    ``<unpitched>`` note. Unknown heads fall back to the 'normal' head at the
    same position, then to 0.
    """
    key = (str(step).upper(), int(octave), (notehead or "normal").lower())
    if key in _DISPLAY_TO_PITCH:
        return _DISPLAY_TO_PITCH[key]
    alt = (key[0], key[1], "normal")
    return _DISPLAY_TO_PITCH.get(alt, 0)


def is_drum_midi(path: Path) -> bool:
    """True when ``path`` is a drum-kit MIDI: any ``is_drum`` instrument, or a
    file named like a drum stem whose every pitch is a known kit voice.

    Never raises — unreadable files are simply not drums.
    """
    try:
        import pretty_midi  # type: ignore[import]

        pm = pretty_midi.PrettyMIDI(str(path))
    except Exception as exc:  # noqa: BLE001 - not a MIDI we can read
        log.debug("percussion: could not read %s: %s", path, exc)
        return False
    if any(inst.is_drum for inst in pm.instruments):
        return True
    name = Path(path).name.lower()
    if "drum" not in name:
        return False
    pitches = {n.pitch for inst in pm.instruments for n in inst.notes}
    return bool(pitches) and pitches <= GM_PITCHES


def _drum_instruments(pm: Any) -> list[Any]:
    flagged = [inst for inst in pm.instruments if inst.is_drum]
    return flagged or list(pm.instruments)


def _time_signatures(pm: Any, bpm: Optional[float] = None) -> list[tuple[float, str]]:
    """Every time signature of ``pm`` as ``(offset in quarters, "n/d")``, in
    order, each at the bar line where it takes effect
    (:func:`..bar_lines.snap_meters_to_bar_lines`: 4/4 until the file states a
    meter, the later of two on one bar line, no restatements); ``[(0.0,
    "4/4")]`` when the file states none. With ``bpm`` the offsets count beats of
    ``bpm``, as the hits' do (:func:`_quarters`)."""
    from ..bar_lines import snap_meters_to_bar_lines

    stated = [
        (
            _quantise(_quarters(pm, ts.time, bpm)),
            f"{int(ts.numerator)}/{int(ts.denominator)}",
        )
        for ts in pm.time_signature_changes
        if ts.numerator > 0 and ts.denominator > 0
    ]
    return [(offset, ratio) for offset, ratio, _i in snap_meters_to_bar_lines(stated)]


def _tempo_changes(pm: Any) -> list[tuple[float, float]]:
    """Every tempo of ``pm`` as ``(offset in quarters, bpm)`` through its own
    tempo map, each offset on the 1/16 grid the hits are quantised to; the
    initial tempo at 0 when the file states none. Of two at one offset the
    later stands, and a tempo restating the one in force is dropped."""
    out: list[tuple[float, float]] = []
    times, tempi = pm.get_tempo_changes()
    changes = [(float(t), float(b)) for t, b in zip(times, tempi) if b > 0]
    for seconds, bpm in sorted(changes, key=lambda change: change[0]):
        offset = _quantise(_quarters(pm, seconds))
        if out and abs(out[-1][0] - offset) < 1e-9:
            out.pop()
        if not out or out[-1][1] != bpm:
            out.append((offset, bpm))
    if not out or out[0][0] > 0:
        out.insert(0, (0.0, _initial_tempo(pm)))
    return out


def _initial_tempo(pm: Any) -> float:
    try:
        _times, tempi = pm.get_tempo_changes()
        if len(tempi):
            bpm = float(tempi[0])
            if bpm > 0:
                return bpm
    except Exception:  # noqa: BLE001
        pass
    return _DEFAULT_TEMPO


def _quarters(pm: Any, seconds: float, bpm: Optional[float] = None) -> float:
    """Seconds → quarter lengths at ``bpm``, or through the file's own tempo map
    when no ``bpm`` is given."""
    if bpm is not None:
        return seconds * bpm / 60.0
    try:
        return float(pm.time_to_tick(seconds)) / float(pm.resolution)
    except Exception:  # noqa: BLE001
        return seconds * _initial_tempo(pm) / 60.0


def _quantise(ql: float) -> float:
    return round(ql / _QUANT) * _QUANT


def _hit_events(
    pm: Any, bpm: Optional[float] = None
) -> list[tuple[float, float, int, int]]:
    """(quantised offset, quantised duration, canonical pitch, velocity) per hit."""
    events: list[tuple[float, float, int, int]] = []
    for inst in _drum_instruments(pm):
        for n in inst.notes:
            start = _quantise(_quarters(pm, n.start, bpm))
            end = _quantise(_quarters(pm, max(n.end, n.start), bpm))
            dur = max(_MIN_QL, end - start)
            events.append((start, dur, canonical_drum_pitch(n.pitch), int(n.velocity)))
    events.sort(key=lambda e: (e[0], e[2]))
    return events


def _make_unpitched(pitch: int, velocity: Optional[int] = None) -> Any:
    from music21 import note  # type: ignore[import]

    step, octave, head = DRUM_STAFF[pitch]
    element = note.Unpitched(displayName=f"{step}{octave}")
    element.displayStep = step
    element.displayOctave = octave
    if head != "normal":
        element.notehead = head
    if velocity is not None:
        element.volume.velocity = velocity
    return element


def build_percussion_part(
    midi_path: Path,
    *,
    title: str = "Drums",
    bpm: Optional[float] = None,
    time_signatures: Optional[list[tuple[float, str]]] = None,
    shows_tempo: bool = True,
) -> Any:
    """Build a ``music21.stream.Part`` percussion staff from a drum MIDI.

    PercussionClef + UnpitchedPercussion instrument, every time signature of
    the file at the bar line it takes effect on (4/4 when it states none) and
    every tempo of its tempo map at its offset. With ``bpm`` the staff is laid
    out at that tempo instead: each hit sits at ``seconds * bpm / 60`` quarters
    and one mark sounds at ``bpm``, so a band score can put the kit on the same
    beat grid as its other staves.
    ``time_signatures`` (``(offset, "n/d")`` pairs on that grid) bars the staff
    by a band score's shared meter map in place of the file's own. With
    ``shows_tempo`` False the mark sounds but is not printed, for a staff that
    is not the one carrying the score's tempo. Every hit becomes a
    ``note.Unpitched`` at its DRUM_STAFF position (x / circle-x heads for
    cymbals), start/end quantised to 1/16 (min 0.25 QL, clipped to the next
    onset so nothing overlaps), simultaneous hits merged into a
    ``percussion.PercussionChord``. Each head carries the velocity of its hit,
    the loudest where several hits land on one staff position. The part is
    barred (``makeMeasures``).
    """
    import pretty_midi  # type: ignore[import]
    from music21 import clef, instrument, meter, percussion, stream  # type: ignore[import]

    from ..midi_read import carry_chord_velocity
    from ..tempo_marks import metronome_mark

    pm = pretty_midi.PrettyMIDI(str(midi_path))

    part = stream.Part()
    part.partName = title or "Drums"
    part.partAbbreviation = (title or "Drums")[:6]
    part.insert(0, clef.PercussionClef())
    part.insert(0, instrument.UnpitchedPercussion())
    grid_bpm = float(bpm) if bpm is not None and bpm > 0 else None
    for offset, ratio in time_signatures or _time_signatures(pm, grid_bpm):
        part.insert(offset, meter.TimeSignature(ratio))
    # The sheet prints each tempo as a whole number. The exact tempo every hit's
    # offset below is worked out at is the sounding tempo: the one grid tempo,
    # or every tempo of the file's own map at the offset it takes effect.
    for offset, sounding in [(0.0, grid_bpm)] if grid_bpm else _tempo_changes(pm):
        mark = metronome_mark(sounding)
        if not shows_tempo:
            mark.numberImplicit = True
            mark.style.hideObjectOnPrint = True
        part.insert(offset, mark)

    events = _hit_events(pm, grid_bpm)
    # Group simultaneous hits; dedupe identical staff positions in a group, the
    # head as loud as the loudest hit it stands for.
    groups: list[tuple[float, float, dict[int, int]]] = []
    for start, dur, pitch, velocity in events:
        if groups and abs(groups[-1][0] - start) < 1e-9:
            heads_at = groups[-1][2]
            heads_at[pitch] = max(heads_at.get(pitch, 0), velocity)
            groups[-1] = (groups[-1][0], max(groups[-1][1], dur), heads_at)
        else:
            groups.append((start, dur, {pitch: velocity}))

    for index, (start, dur, pitches) in enumerate(groups):
        if index + 1 < len(groups):
            gap = groups[index + 1][0] - start
            dur = max(_MIN_QL, min(dur, gap))
        heads = [_make_unpitched(p, v) for p, v in pitches.items()]
        if len(heads) == 1:
            element = heads[0]
        else:
            element = percussion.PercussionChord(heads)
            carry_chord_velocity(element)
        element.duration.quarterLength = dur
        part.insert(start, element)

    part.makeMeasures(inPlace=True)
    return part


def build_percussion_score(midi_path: Path, *, title: str = "") -> Any:
    """A one-part ``music21.stream.Score`` wrapping :func:`build_percussion_part`
    (what ``midi_to_musicxml`` writes for a drum MIDI)."""
    from music21 import metadata, stream  # type: ignore[import]

    score = stream.Score()
    score.insert(0, metadata.Metadata())
    score.metadata.title = title or "Drums"
    score.insert(0, build_percussion_part(midi_path, title="Drums"))
    return score
