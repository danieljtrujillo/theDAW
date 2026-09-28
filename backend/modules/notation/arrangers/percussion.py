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

Every time signature of the file, read from every track with its grouping
(:func:`..midi_read.read_midi_meters`), bars the staff, and a roll's pickup
opens it on a pickup bar, as the pitched staves of the same file are barred.

The orchestra's percussion lives here too. :data:`ORCHESTRAL_PERCUSSION` is
the section's unpitched instruments (bass drum, suspended cymbal, clash
cymbals, triangle, tambourine, tam-tam, wood block), each engraved on its own
one-line staff with its full and short name
(:func:`build_orchestral_percussion_parts`); a score built with
``orchestral=True`` moves each of their hits off the kit staff.
:data:`PITCHED_PERCUSSION` is timpani and the mallets (glockenspiel,
xylophone, vibraphone, marimba, tubular bells), which engrave as pitched parts
(:func:`engrave_pitched_percussion`), each with its clef and, for the
glockenspiel and xylophone, the octaves it sounds above the written note.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
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


@dataclass(frozen=True)
class OrchestralPercussion:
    """An unpitched orchestral percussion instrument with a staff of its own.

    ``gm`` is the General MIDI kit pitches that sound it (empty where GM has
    none), and ``claims_gm`` whether a hit on one of them goes to this staff
    in an orchestral score: only pitches no drum kit uses, so a kit's crash
    stays a kit crash. ``aliases`` are track names (lower case) whose every
    hit is this instrument's. ``instrument`` names the music21 instrument
    class; ``notehead`` is the head its hits print with on the one line.
    """

    key: str
    name: str
    short: str
    instrument: str
    gm: tuple[int, ...]
    claims_gm: bool
    notehead: str
    aliases: tuple[str, ...]


ORCHESTRAL_PERCUSSION: dict[str, OrchestralPercussion] = {
    voice.key: voice
    for voice in (
        OrchestralPercussion(
            "bass_drum",
            "Bass Drum",
            "B. Dr.",
            "BassDrum",
            (35,),
            False,
            "normal",
            ("bass drum", "concert bass drum", "gran cassa", "grosse caisse"),
        ),
        OrchestralPercussion(
            "suspended_cymbal",
            "Suspended Cymbal",
            "Sus. Cym.",
            "SuspendedCymbal",
            (),
            False,
            "x",
            ("suspended cymbal", "sus. cym.", "sus cym", "piatto sospeso"),
        ),
        OrchestralPercussion(
            "clash_cymbals",
            "Clash Cymbals",
            "Cym.",
            "CrashCymbals",
            (49,),
            False,
            "x",
            ("clash cymbals", "crash cymbals", "cymbals", "piatti"),
        ),
        OrchestralPercussion(
            "triangle",
            "Triangle",
            "Tri.",
            "Triangle",
            (81, 80),
            True,
            "triangle",
            ("triangle", "triangolo"),
        ),
        OrchestralPercussion(
            "tambourine",
            "Tambourine",
            "Tamb.",
            "Tambourine",
            (54,),
            True,
            "normal",
            ("tambourine", "tamburello", "tambourin"),
        ),
        OrchestralPercussion(
            "tam_tam",
            "Tam-tam",
            "T.-t.",
            "TamTam",
            (),
            False,
            "normal",
            ("tam-tam", "tam tam", "tamtam", "gong"),
        ),
        OrchestralPercussion(
            "wood_block",
            "Wood Block",
            "W. Bl.",
            "Woodblock",
            (76, 77),
            True,
            "normal",
            ("wood block", "woodblock", "wood blocks", "blocco di legno"),
        ),
    )
}

# Where an orchestral hit sits on its one-line staff: the line.
_ONE_LINE_POSITION = ("B", 4)


@dataclass(frozen=True)
class PitchedPercussion:
    """Timpani or a mallet instrument, engraved as a pitched part.

    ``program`` is its General MIDI program (0-based), ``clef`` the clef it
    reads in ('treble', 'bass', or '' for the one its register wants),
    ``octaves_up`` how many octaves it sounds above the written note, and
    ``low``/``high`` its sounding range as MIDI numbers.
    """

    key: str
    name: str
    short: str
    instrument: str
    program: int
    clef: str
    octaves_up: int
    low: int
    high: int


PITCHED_PERCUSSION: dict[str, PitchedPercussion] = {
    voice.key: voice
    for voice in (
        PitchedPercussion(
            "timpani", "Timpani", "Timp.", "Timpani", 47, "bass", 0, 38, 57
        ),
        PitchedPercussion(
            "glockenspiel",
            "Glockenspiel",
            "Glock.",
            "Glockenspiel",
            9,
            "treble",
            2,
            79,
            108,
        ),
        PitchedPercussion(
            "xylophone", "Xylophone", "Xyl.", "Xylophone", 13, "treble", 1, 65, 108
        ),
        PitchedPercussion(
            "vibraphone", "Vibraphone", "Vib.", "Vibraphone", 11, "treble", 0, 53, 89
        ),
        PitchedPercussion("marimba", "Marimba", "Mar.", "Marimba", 12, "", 0, 36, 96),
        PitchedPercussion(
            "tubular_bells",
            "Tubular Bells",
            "T. Bells",
            "TubularBells",
            14,
            "treble",
            0,
            60,
            77,
        ),
    )
}


def pitched_percussion_for_program(
    program: Optional[int],
) -> Optional[PitchedPercussion]:
    """The pitched percussion instrument General MIDI ``program`` (0-based)
    plays, or None."""
    if program is None:
        return None
    return next(
        (v for v in PITCHED_PERCUSSION.values() if v.program == int(program)), None
    )


def orchestral_voice_for_track(name: str) -> Optional[OrchestralPercussion]:
    """The orchestral instrument a track named ``name`` holds, or None."""
    wanted = " ".join(str(name or "").lower().replace("_", " ").split())
    if not wanted:
        return None
    return next(
        (v for v in ORCHESTRAL_PERCUSSION.values() if wanted in v.aliases), None
    )


def orchestral_voice_for_pitch(pitch: int) -> Optional[OrchestralPercussion]:
    """The orchestral instrument that takes GM kit ``pitch`` in an orchestral
    score (:attr:`OrchestralPercussion.claims_gm`), or None."""
    return next(
        (
            v
            for v in ORCHESTRAL_PERCUSSION.values()
            if v.claims_gm and int(pitch) in v.gm
        ),
        None,
    )


def _music21_instrument(class_name: str, name: str, short: str) -> Any:
    """An instance of music21's instrument class ``class_name`` carrying the
    names given."""
    from music21 import instrument

    made = getattr(instrument, class_name, instrument.UnpitchedPercussion)()
    made.instrumentName = name
    made.instrumentAbbreviation = short
    made.partName = name
    made.partAbbreviation = short
    return made


def engrave_pitched_percussion(part: Any, voice: PitchedPercussion) -> None:
    """Make the pitched ``part`` read as ``voice``: its instrument (names, GM
    program, and the octaves it sounds above the written note, so the sheet
    writes a glockenspiel two octaves below the pitch it plays), its clef when
    the instrument reads in one, and its name when the part has none."""
    from music21 import clef, interval

    for held in list(part.getElementsByClass("Instrument")):
        part.remove(held)
    made = _music21_instrument(voice.instrument, voice.name, voice.short)
    made.midiProgram = voice.program
    # music21's transposition is written -> sounding: an octave up is P8.
    made.transposition = (
        interval.Interval(f"P{7 * voice.octaves_up + 1}") if voice.octaves_up else None
    )
    part.insert(0, made)
    if voice.clef:
        for held in list(part.getElementsByClass("Clef")):
            if float(held.getOffsetBySite(part)) == 0.0:
                part.remove(held)
        part.insert(0, clef.BassClef() if voice.clef == "bass" else clef.TrebleClef())
    if not part.partName:
        part.partName = voice.name
    if not part.partAbbreviation:
        part.partAbbreviation = voice.short


def engrave_pitched_percussion_parts(score: Any) -> list[str]:
    """Engrave every part of ``score`` whose instrument plays a GM program of
    :data:`PITCHED_PERCUSSION` as that instrument; the keys engraved."""
    engraved: list[str] = []
    for part in list(getattr(score, "parts", ())):
        held = part.getElementsByClass("Instrument").first()
        voice = pitched_percussion_for_program(getattr(held, "midiProgram", None))
        if voice is None:
            continue
        engrave_pitched_percussion(part, voice)
        engraved.append(voice.key)
    return engraved


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
        import pretty_midi

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


def _stated_meters(
    pm: Any, bpm: Optional[float] = None, midi_path: Optional[Path] = None
) -> tuple[list[tuple[float, str]], float]:
    """``([(offset in quarters, spec)], padding)``: every time signature the
    file states, where it states it, and how far into its first bar a pickup
    starts (0 without one).

    With ``midi_path`` the signatures come from every track, each grouped by
    its ``theDAW:groups=`` text, and a ``theDAW:pickup=`` pickup is read
    (:meth:`..midi_read.MidiMeters.stated`); otherwise from ``pm``'s own list,
    which pretty_midi reads from the first track only. With ``bpm`` the
    offsets count beats of ``bpm``, as the hits' do (:func:`_quarters`).
    """
    from ..midi_read import read_midi_meters

    meters = read_midi_meters(midi_path) if midi_path is not None else None
    if meters is not None and meters.marks:
        return meters.stated(
            lambda tick: _quantise(_quarters(pm, pm.tick_to_time(tick), bpm))
        )
    stated = [
        (
            _quantise(_quarters(pm, ts.time, bpm)),
            f"{int(ts.numerator)}/{int(ts.denominator)}",
        )
        for ts in pm.time_signature_changes
        if ts.numerator > 0 and ts.denominator > 0
    ]
    return stated, 0.0


def _time_signatures(
    pm: Any, bpm: Optional[float] = None, midi_path: Optional[Path] = None
) -> list[tuple[float, str]]:
    """Every time signature of the file as ``(offset in quarters, spec)``, in
    order, each at the bar line where it takes effect
    (:func:`..bar_lines.snap_meters_to_bar_lines`: 4/4 until the file states a
    meter, the later of two on one bar line, no restatements); ``[(0.0,
    "4/4")]`` when the file states none. Read as :func:`_stated_meters` reads
    them, before any pickup moves the music."""
    from ..bar_lines import snap_meters_to_bar_lines

    stated, _padding = _stated_meters(pm, bpm, midi_path)
    return [(offset, spec) for offset, spec, _i in snap_meters_to_bar_lines(stated)]


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


# One hit: (quantised offset, quantised duration, GM pitch, velocity, track name).
_Hit = tuple[float, float, int, int, str]


def _raw_hits(pm: Any, bpm: Optional[float] = None) -> list[_Hit]:
    """Every hit of the drum instruments of ``pm`` at its own GM pitch, with
    the name of the track it is on, start/end quantised to 1/16."""
    hits: list[_Hit] = []
    for inst in _drum_instruments(pm):
        name = str(getattr(inst, "name", "") or "")
        for n in inst.notes:
            start = _quantise(_quarters(pm, n.start, bpm))
            end = _quantise(_quarters(pm, max(n.end, n.start), bpm))
            dur = max(_MIN_QL, end - start)
            hits.append((start, dur, int(n.pitch), int(n.velocity), name))
    hits.sort(key=lambda h: (h[0], h[2]))
    return hits


def _hit_events(
    pm: Any, bpm: Optional[float] = None
) -> list[tuple[float, float, int, int]]:
    """(quantised offset, quantised duration, canonical pitch, velocity) per hit."""
    events = [
        (start, dur, canonical_drum_pitch(pitch), velocity)
        for start, dur, pitch, velocity, _name in _raw_hits(pm, bpm)
    ]
    events.sort(key=lambda e: (e[0], e[2]))
    return events


def _orchestral_voice(hit: _Hit) -> Optional[OrchestralPercussion]:
    """The orchestral instrument a hit belongs to in an orchestral score: its
    track's, else the one that takes its GM pitch, else None (the kit)."""
    return orchestral_voice_for_track(hit[4]) or orchestral_voice_for_pitch(hit[2])


def _make_unpitched(pitch: int, velocity: Optional[int] = None) -> Any:
    step, octave, head = DRUM_STAFF[pitch]
    return _unpitched_at(step, octave, head, velocity)


def _unpitched_at(
    step: str, octave: int, head: str, velocity: Optional[int] = None
) -> Any:
    from music21 import note

    element = note.Unpitched(displayName=f"{step}{octave}")
    element.displayStep = step
    element.displayOctave = octave
    if head != "normal":
        element.notehead = head
    if velocity is not None:
        element.volume.velocity = velocity
    return element


def _staff(
    pm: Any,
    *,
    name: str,
    short: str,
    instrument: Any,
    grid_bpm: Optional[float],
    time_signatures: Optional[list[tuple[float, str]]],
    midi_path: Optional[Path],
    shows_tempo: bool,
    one_line: bool = False,
) -> tuple[Any, float]:
    """An empty percussion staff: its names, clef, instrument, every time
    signature and every tempo. Returns ``(part, padding)``, ``padding`` being
    how far into its first bar the file's pickup starts (0 without one, and
    always 0 with ``time_signatures`` given)."""
    from music21 import clef, layout, stream

    from ..bar_lines import time_signature
    from ..tempo_marks import metronome_mark

    part = stream.Part()
    part.partName = name
    part.partAbbreviation = short
    part.insert(0, clef.PercussionClef())
    if one_line:
        part.insert(0, layout.StaffLayout(staffLines=1))
    part.insert(0, instrument)
    padding = 0.0
    if time_signatures is not None:
        meters = list(time_signatures)
    else:
        meters, padding = _stated_meters(pm, grid_bpm, midi_path)
    for offset, spec in meters:
        part.insert(offset, time_signature(spec))
    # The sheet prints each tempo as a whole number. The exact tempo every hit's
    # offset below is worked out at is the sounding tempo: the one grid tempo,
    # or every tempo of the file's own map at the offset it takes effect.
    for offset, sounding in [(0.0, grid_bpm)] if grid_bpm else _tempo_changes(pm):
        mark = metronome_mark(sounding)
        if not shows_tempo:
            mark.numberImplicit = True
            mark.style.hideObjectOnPrint = True
        part.insert(offset, mark)
    return part, padding


def _fill(part: Any, groups: list[tuple[float, float, list[Any]]]) -> None:
    """Insert each group of heads at its offset, one head as a note and
    several as a ``PercussionChord`` carrying their mean velocity, each held
    until the next group at the latest."""
    from music21 import percussion

    from ..midi_read import carry_chord_velocity

    for index, (start, dur, heads) in enumerate(groups):
        if index + 1 < len(groups):
            gap = groups[index + 1][0] - start
            dur = max(_MIN_QL, min(dur, gap))
        if len(heads) == 1:
            element = heads[0]
        else:
            element = percussion.PercussionChord(heads)
            carry_chord_velocity(element)
        element.duration.quarterLength = dur
        part.insert(start, element)


def _bar(part: Any, padding: float) -> None:
    """Bar the filled staff on its time signatures (4/4 until the first one);
    with a pickup, move the music ``padding`` later and open on the pickup
    bar, as :func:`..bar_lines.bar_like_source` bars the pitched staves."""
    from ..bar_lines import (
        open_with_pickup,
        pickup_bar_fits,
        shift_after_pickup,
        snap_part_meters,
    )

    if padding:
        shift_after_pickup(part, padding)
    snap_part_meters(part)
    part.makeMeasures(inPlace=True)
    if padding and pickup_bar_fits(part, padding):
        open_with_pickup(part, padding)


def _kit_groups(hits: list[_Hit]) -> list[tuple[float, float, list[Any]]]:
    """Simultaneous kit hits grouped, identical staff positions deduped, each
    head as loud as the loudest hit it stands for."""
    grouped: list[tuple[float, float, dict[int, int]]] = []
    for start, dur, raw, velocity, _name in hits:
        pitch = canonical_drum_pitch(raw)
        if grouped and abs(grouped[-1][0] - start) < 1e-9:
            heads_at = grouped[-1][2]
            heads_at[pitch] = max(heads_at.get(pitch, 0), velocity)
            grouped[-1] = (grouped[-1][0], max(grouped[-1][1], dur), heads_at)
        else:
            grouped.append((start, dur, {pitch: velocity}))
    return [
        (start, dur, [_make_unpitched(p, v) for p, v in pitches.items()])
        for start, dur, pitches in grouped
    ]


def _one_line_groups(
    hits: list[_Hit], voice: OrchestralPercussion
) -> list[tuple[float, float, list[Any]]]:
    """Hits of one orchestral instrument, one head per onset on the line, as
    loud as the loudest hit there."""
    step, octave = _ONE_LINE_POSITION
    merged: list[tuple[float, float, int]] = []
    for start, dur, _raw, velocity, _name in hits:
        if merged and abs(merged[-1][0] - start) < 1e-9:
            held = merged[-1]
            merged[-1] = (held[0], max(held[1], dur), max(held[2], velocity))
        else:
            merged.append((start, dur, velocity))
    return [
        (start, dur, [_unpitched_at(step, octave, voice.notehead, velocity)])
        for start, dur, velocity in merged
    ]


def build_percussion_part(
    midi_path: Path,
    *,
    title: str = "Drums",
    bpm: Optional[float] = None,
    time_signatures: Optional[list[tuple[float, str]]] = None,
    shows_tempo: bool = True,
    hits: Optional[list[_Hit]] = None,
) -> Any:
    """Build a ``music21.stream.Part`` percussion staff from a drum MIDI.

    PercussionClef + UnpitchedPercussion instrument, every time signature of
    the file (from every track, each with its grouping) at the bar line it
    takes effect on (4/4 when it states none), a roll's pickup as the pickup
    bar, and every tempo of its tempo map at its offset. With ``bpm`` the
    staff is laid out at that tempo instead: each hit sits at ``seconds * bpm
    / 60`` quarters and one mark sounds at ``bpm``, so a band score can put
    the kit on the same beat grid as its other staves.
    ``time_signatures`` (``(offset, spec)`` pairs on that grid, a spec being
    ``"n/d"`` or a grouped ``"n/d g+g"``) bars the staff by a band score's
    shared meter map in place of the file's own. With ``shows_tempo`` False
    the mark sounds but is not printed, for a staff that is not the one
    carrying the score's tempo. ``hits`` (from :func:`_raw_hits`) limits the
    staff to those hits; every hit of the file by default. Every hit becomes a
    ``note.Unpitched`` at its DRUM_STAFF position (x / circle-x heads for
    cymbals), start/end quantised to 1/16 (min 0.25 QL, clipped to the next
    onset so nothing overlaps), simultaneous hits merged into a
    ``percussion.PercussionChord``. Each head carries the velocity of its hit,
    the loudest where several hits land on one staff position. The part is
    barred (``makeMeasures``).
    """
    import pretty_midi
    from music21 import instrument

    pm = pretty_midi.PrettyMIDI(str(midi_path))
    grid_bpm = float(bpm) if bpm is not None and bpm > 0 else None
    part, padding = _staff(
        pm,
        name=title or "Drums",
        short=(title or "Drums")[:6],
        instrument=instrument.UnpitchedPercussion(),
        grid_bpm=grid_bpm,
        time_signatures=time_signatures,
        midi_path=midi_path,
        shows_tempo=shows_tempo,
    )
    _fill(part, _kit_groups(hits if hits is not None else _raw_hits(pm, grid_bpm)))
    _bar(part, padding)
    return part


def build_orchestral_percussion_parts(
    midi_path: Path,
    *,
    bpm: Optional[float] = None,
    time_signatures: Optional[list[tuple[float, str]]] = None,
    shows_tempo: bool = True,
) -> tuple[list[Any], list[_Hit]]:
    """One staff per orchestral percussion instrument the drum MIDI plays.

    A hit belongs to an instrument of :data:`ORCHESTRAL_PERCUSSION` when its
    track is named for it (:func:`orchestral_voice_for_track`) or its GM
    pitch is one only that instrument uses (:func:`orchestral_voice_for_pitch`).
    Each staff is a one-line percussion staff carrying the instrument's full
    and short name, every time signature, the pickup and the tempo, barred as
    the kit staff is; with shows_tempo the first staff prints the tempo,
    the others carry it unprinted. Returns ``(parts in ORCHESTRAL_PERCUSSION order, the
    hits left for the kit)``.
    """
    import pretty_midi

    pm = pretty_midi.PrettyMIDI(str(midi_path))
    grid_bpm = float(bpm) if bpm is not None and bpm > 0 else None
    by_voice: dict[str, list[_Hit]] = {}
    kit: list[_Hit] = []
    for hit in _raw_hits(pm, grid_bpm):
        voice = _orchestral_voice(hit)
        if voice is None:
            kit.append(hit)
        else:
            by_voice.setdefault(voice.key, []).append(hit)
    parts: list[Any] = []
    for key, voice in ORCHESTRAL_PERCUSSION.items():
        voice_hits = by_voice.get(key)
        if not voice_hits:
            continue
        part, padding = _staff(
            pm,
            name=voice.name,
            short=voice.short,
            instrument=_music21_instrument(voice.instrument, voice.name, voice.short),
            grid_bpm=grid_bpm,
            time_signatures=time_signatures,
            midi_path=midi_path,
            # Only the first staff made prints the tempo.
            shows_tempo=shows_tempo and not parts,
            one_line=True,
        )
        _fill(part, _one_line_groups(voice_hits, voice))
        _bar(part, padding)
        parts.append(part)
    return parts, kit


def build_percussion_score(
    midi_path: Path, *, title: str = "", orchestral: bool = False
) -> Any:
    """A ``music21.stream.Score`` of the drum MIDI (what ``midi_to_musicxml``
    writes for one): the kit staff of :func:`build_percussion_part`. With
    ``orchestral`` each orchestral percussion instrument the file plays gets
    its own staff first (:func:`build_orchestral_percussion_parts`), the
    first of them printing the tempo, and the kit staff holds what is left,
    when anything is."""
    from music21 import metadata, stream

    score = stream.Score()
    score.insert(0, metadata.Metadata())
    score.metadata.title = title or "Drums"
    if not orchestral:
        score.insert(0, build_percussion_part(midi_path, title="Drums"))
        return score
    parts, kit = build_orchestral_percussion_parts(midi_path)
    for part in parts:
        score.insert(0, part)
    if kit or not parts:
        score.insert(
            0,
            build_percussion_part(
                midi_path, title="Drums", hits=kit, shows_tempo=not parts
            ),
        )
    return score
