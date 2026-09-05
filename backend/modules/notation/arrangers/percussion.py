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
from typing import Any

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


def _time_signature(pm: Any) -> str:
    try:
        changes = pm.time_signature_changes
        if changes:
            ts = changes[0]
            if ts.numerator > 0 and ts.denominator > 0:
                return f"{int(ts.numerator)}/{int(ts.denominator)}"
    except Exception:  # noqa: BLE001
        pass
    return "4/4"


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


def _quarters(pm: Any, seconds: float) -> float:
    """Seconds → quarter lengths through the file's own tempo map."""
    try:
        return float(pm.time_to_tick(seconds)) / float(pm.resolution)
    except Exception:  # noqa: BLE001
        return seconds * _initial_tempo(pm) / 60.0


def _quantise(ql: float) -> float:
    return round(ql / _QUANT) * _QUANT


def _hit_events(pm: Any) -> list[tuple[float, float, int]]:
    """(quantised offset, quantised duration, canonical pitch) per hit."""
    events: list[tuple[float, float, int]] = []
    for inst in _drum_instruments(pm):
        for n in inst.notes:
            start = _quantise(_quarters(pm, n.start))
            end = _quantise(_quarters(pm, max(n.end, n.start)))
            dur = max(_MIN_QL, end - start)
            events.append((start, dur, canonical_drum_pitch(n.pitch)))
    events.sort(key=lambda e: (e[0], e[2]))
    return events


def _make_unpitched(pitch: int) -> Any:
    from music21 import note  # type: ignore[import]

    step, octave, head = DRUM_STAFF[pitch]
    element = note.Unpitched(displayName=f"{step}{octave}")
    element.displayStep = step
    element.displayOctave = octave
    if head != "normal":
        element.notehead = head
    return element


def build_percussion_part(midi_path: Path, *, title: str = "Drums") -> Any:
    """Build a ``music21.stream.Part`` percussion staff from a drum MIDI.

    PercussionClef + UnpitchedPercussion instrument, the file's first time
    signature (default 4/4) and initial tempo; every hit becomes a
    ``note.Unpitched`` at its DRUM_STAFF position (x / circle-x heads for
    cymbals), start/end quantised to 1/16 (min 0.25 QL, clipped to the next
    onset so nothing overlaps), simultaneous hits merged into a
    ``percussion.PercussionChord``. The part is barred (``makeMeasures``).
    """
    import pretty_midi  # type: ignore[import]
    from music21 import clef, instrument, meter, percussion, stream, tempo  # type: ignore[import]

    pm = pretty_midi.PrettyMIDI(str(midi_path))

    part = stream.Part()
    part.partName = title or "Drums"
    part.partAbbreviation = (title or "Drums")[:6]
    part.insert(0, clef.PercussionClef())
    part.insert(0, instrument.UnpitchedPercussion())
    part.insert(0, meter.TimeSignature(_time_signature(pm)))
    part.insert(0, tempo.MetronomeMark(number=_initial_tempo(pm)))

    events = _hit_events(pm)
    # Group simultaneous hits; dedupe identical staff positions in a group.
    groups: list[tuple[float, float, list[int]]] = []
    for start, dur, pitch in events:
        if groups and abs(groups[-1][0] - start) < 1e-9:
            if pitch not in groups[-1][2]:
                groups[-1][2].append(pitch)
            groups[-1] = (groups[-1][0], max(groups[-1][1], dur), groups[-1][2])
        else:
            groups.append((start, dur, [pitch]))

    for index, (start, dur, pitches) in enumerate(groups):
        if index + 1 < len(groups):
            gap = groups[index + 1][0] - start
            dur = max(_MIN_QL, min(dur, gap))
        heads = [_make_unpitched(p) for p in pitches]
        if len(heads) == 1:
            element = heads[0]
        else:
            element = percussion.PercussionChord(heads)
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
