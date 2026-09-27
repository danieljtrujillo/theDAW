"""The orchestral instrument registry: one record per instrument a part can be.

Each record names the music21 instrument class it is built on and takes that
class's name, General MIDI program and transposition unless the row states its
own. The row adds what music21 leaves out: the family and the score order,
the abbreviation printed on every system after the first, the clefs the part
reads in (the usual one first), the number of staves, the practical range and
the sound bank.

Conventions every record follows:

  - ``transposition`` is the interval from the written pitch to the pitch that
    sounds, as music21 states it (``M-2`` for a B-flat clarinet, ``P8`` for a
    piccolo). ``semitones`` is the same interval counted in semitones, so
    ``sounding = written + semitones``.
  - ``range_low`` / ``range_high`` are the practical range at SOUNDING pitch,
    as MIDI note numbers, which is what a MIDI file and the piano roll hold.
  - ``program`` is 0-based General MIDI. ``bank`` is the SoundFont bank: 0 for
    the General MIDI melodic set, 128 for the percussion kits.
  - An unpitched percussion record plays on the drum channel with the
    Orchestral kit (bank 128, program 48 of GeneralUser GS, the bank the app
    ships), and ``kit_pitch`` is the key that sounds it in that kit. The
    Orchestral kit is not the GM Standard kit: its keys 49-53 are timpani, and
    its concert cymbals sit on 57 and 59.

music21 disagrees with orchestral practice in a few places; each row that
overrides it says so in :data:`_ROWS` (the contrabassoon sounds an octave
below written; the celesta, xylophone and glockenspiel sound above it; the
guitars and the electric bass sound an octave below it).

The frontend mirror ``frontend/src/lib/orchestraData.ts`` is generated from
this module (``python -m backend.modules.notation.instruments``), and
``tests/test_orchestra_registry.py`` fails when the two differ.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

# Families in score order, with the label a picker prints.
FAMILIES: tuple[tuple[str, str], ...] = (
    ("woodwinds", "Woodwinds"),
    ("brass", "Brass"),
    ("percussion", "Percussion"),
    ("keyboards", "Harp and keyboards"),
    ("band", "Band"),
    ("voices", "Voices"),
    ("strings", "Strings"),
)
_FAMILY_IDS = tuple(f for f, _ in FAMILIES)

# The clefs a record may name, as the music21 sign/line/octave they build, and
# the window of SOUNDING pitches each shows with no more than three ledger
# lines above or below the staff (for an untransposed part).
CLEFS: dict[str, tuple[str, int, int]] = {
    "treble": ("G", 2, 0),
    "treble8vb": ("G", 2, -1),
    "alto": ("C", 3, 0),
    "tenor": ("C", 4, 0),
    "bass": ("F", 4, 0),
    "percussion": ("percussion", 3, 0),
}
CLEF_WINDOWS: dict[str, tuple[int, int]] = {
    "treble": (53, 88),  # F3 .. E6
    "treble8vb": (41, 76),  # F2 .. E5
    "alto": (43, 77),  # G2 .. F5
    "tenor": (40, 74),  # E2 .. D5
    "bass": (33, 67),  # A1 .. G4
}

# The bank and program of GeneralUser GS's Orchestral kit and Standard kit.
PERCUSSION_BANK = 128
ORCHESTRAL_KIT = 48
STANDARD_KIT = 0

# The file the frontend mirror is generated into, relative to the repo root.
FRONTEND_MIRROR = Path("frontend") / "src" / "lib" / "orchestraData.ts"


# What a part name keeps when it is matched against the registry: lower case,
# letters, digits, the accented letters of the aliases, the flat sign, spaces
# and hyphens. The frontend mirror carries this pattern.
MATCH_PATTERN = r"[^a-z0-9äöüéè♭ -]+"


def normalize_name(text: str) -> str:
    """``text`` as :func:`guess_from_name` compares it."""
    return re.sub(r"\s+", " ", re.sub(MATCH_PATTERN, " ", text.lower())).strip()


@dataclass(frozen=True)
class OrchestraInstrument:
    id: str
    family: str
    order: int
    name: str
    abbreviation: str
    music21_class: str
    transposition: str
    semitones: int
    clefs: tuple[str, ...]
    staves: int
    range_low: int
    range_high: int
    program: int
    bank: int
    percussion: bool
    kit_pitch: Optional[int]
    aliases: tuple[str, ...]

    def written(self, sounding: int) -> int:
        """The written MIDI pitch of a sounding one."""
        return sounding - self.semitones

    def sounding(self, written: int) -> int:
        """The sounding MIDI pitch of a written one."""
        return written + self.semitones

    def in_range(self, sounding: int) -> bool:
        return self.range_low <= sounding <= self.range_high

    @property
    def match_keys(self) -> tuple[str, ...]:
        """The names a part name is matched against: the id, the full name,
        each alias and an abbreviation of three letters or more ("Vln.",
        "Timp."; a one-letter one such as "S." would match any stray letter)."""
        keys = {
            normalize_name(self.id.replace("-", " ")),
            normalize_name(self.name),
            *map(normalize_name, self.aliases),
        }
        abbreviation = normalize_name(self.abbreviation)
        if len(abbreviation.replace(" ", "")) >= 3:
            keys.add(abbreviation)
        return tuple(sorted(k for k in keys if k))

    def record(self) -> dict[str, Any]:
        """The record as the frontend mirror holds it (camelCase keys)."""
        return {
            "id": self.id,
            "family": self.family,
            "order": self.order,
            "name": self.name,
            "abbreviation": self.abbreviation,
            "music21Class": self.music21_class,
            "transposition": self.transposition,
            "semitones": self.semitones,
            "clefs": list(self.clefs),
            "staves": self.staves,
            "rangeLow": self.range_low,
            "rangeHigh": self.range_high,
            "program": self.program,
            "bank": self.bank,
            "percussion": self.percussion,
            "kitPitch": self.kit_pitch,
            "aliases": list(self.aliases),
            "matchKeys": list(self.match_keys),
        }


@dataclass(frozen=True)
class _Row:
    id: str
    cls: str
    family: str
    name: str
    abbreviation: str
    clefs: tuple[str, ...]
    low: int
    high: int
    staves: int = 1
    # Overrides of the music21 class; None keeps music21's value.
    program: Optional[int] = None
    transposition: Optional[str] = None
    bank: int = 0
    kit_pitch: Optional[int] = None
    percussion: bool = False
    aliases: tuple[str, ...] = ()


def _kit(
    id: str, cls: str, name: str, abbreviation: str, key: int, *aliases: str
) -> _Row:
    """An unpitched percussion row played by the Orchestral kit's ``key``."""
    return _Row(
        id,
        cls,
        "percussion",
        name,
        abbreviation,
        ("percussion",),
        key,
        key,
        program=ORCHESTRAL_KIT,
        bank=PERCUSSION_BANK,
        kit_pitch=key,
        percussion=True,
        aliases=aliases,
    )


# Score order is the order of this table. Ranges are sounding MIDI numbers.
_ROWS: tuple[_Row, ...] = (
    # ── woodwinds ──
    _Row(
        "piccolo",
        "Piccolo",
        "woodwinds",
        "Piccolo",
        "Picc.",
        ("treble",),
        74,
        106,
        aliases=("ottavino", "petite flute"),
    ),
    _Row(
        "flute",
        "Flute",
        "woodwinds",
        "Flute",
        "Fl.",
        ("treble",),
        60,
        96,
        aliases=("flauto", "flöte", "flote"),
    ),
    _Row(
        "oboe",
        "Oboe",
        "woodwinds",
        "Oboe",
        "Ob.",
        ("treble",),
        58,
        91,
        aliases=("hautbois", "oboi"),
    ),
    _Row(
        "english-horn",
        "EnglishHorn",
        "woodwinds",
        "English Horn",
        "E.H.",
        ("treble",),
        52,
        84,
        aliases=("cor anglais", "corno inglese", "englischhorn"),
    ),
    _Row(
        "clarinet-bb",
        "Clarinet",
        "woodwinds",
        "Clarinet in B♭",
        "Cl.",
        ("treble",),
        50,
        91,
        aliases=(
            "clarinet",
            "clarinetto",
            "klarinette",
            "clarinette",
            "clarinet in b-flat",
            "clarinet in bb",
            "b-flat clarinet",
            "bb clarinet",
        ),
    ),
    # music21's Clarinet is the B-flat instrument; the A clarinet sounds a minor third below written.
    _Row(
        "clarinet-a",
        "Clarinet",
        "woodwinds",
        "Clarinet in A",
        "Cl.",
        ("treble",),
        49,
        89,
        transposition="m-3",
        aliases=("clarinet in a", "a clarinet"),
    ),
    _Row(
        "bass-clarinet",
        "BassClarinet",
        "woodwinds",
        "Bass Clarinet",
        "B. Cl.",
        ("treble", "bass"),
        34,
        77,
        aliases=("clarinetto basso", "bassklarinette", "clarinette basse"),
    ),
    _Row(
        "soprano-sax",
        "SopranoSaxophone",
        "woodwinds",
        "Soprano Saxophone",
        "S. Sax.",
        ("treble",),
        56,
        88,
        aliases=("soprano sax",),
    ),
    _Row(
        "alto-sax",
        "AltoSaxophone",
        "woodwinds",
        "Alto Saxophone",
        "A. Sax.",
        ("treble",),
        49,
        81,
        aliases=("alto sax", "saxophone", "sax"),
    ),
    _Row(
        "tenor-sax",
        "TenorSaxophone",
        "woodwinds",
        "Tenor Saxophone",
        "T. Sax.",
        ("treble",),
        44,
        76,
        aliases=("tenor sax",),
    ),
    _Row(
        "baritone-sax",
        "BaritoneSaxophone",
        "woodwinds",
        "Baritone Saxophone",
        "Bar. Sax.",
        ("treble",),
        37,
        69,
        aliases=("baritone sax", "bari sax"),
    ),
    _Row(
        "bassoon",
        "Bassoon",
        "woodwinds",
        "Bassoon",
        "Bsn.",
        ("bass", "tenor", "treble"),
        34,
        75,
        aliases=("fagotto", "fagott", "basson"),
    ),
    # music21 writes the contrabassoon untransposed; it sounds an octave below written.
    _Row(
        "contrabassoon",
        "Contrabassoon",
        "woodwinds",
        "Contrabassoon",
        "Cbsn.",
        ("bass",),
        22,
        55,
        transposition="P-8",
        aliases=("contrafagotto", "kontrafagott", "double bassoon"),
    ),
    # ── brass ──
    _Row(
        "horn",
        "Horn",
        "brass",
        "Horn in F",
        "Hn.",
        ("treble", "bass"),
        35,
        77,
        aliases=("french horn", "corno", "horn", "cor"),
    ),
    _Row(
        "trumpet-bb",
        "Trumpet",
        "brass",
        "Trumpet in B♭",
        "Tpt.",
        ("treble",),
        52,
        82,
        aliases=(
            "trumpet",
            "tromba",
            "trompete",
            "trompette",
            "trumpet in b-flat",
            "trumpet in bb",
            "b-flat trumpet",
        ),
    ),
    # music21's Trumpet is the B-flat instrument; the C trumpet sounds as written.
    _Row(
        "trumpet-c",
        "Trumpet",
        "brass",
        "Trumpet in C",
        "Tpt.",
        ("treble",),
        54,
        84,
        transposition="P1",
        aliases=("trumpet in c", "c trumpet"),
    ),
    _Row(
        "trombone",
        "Trombone",
        "brass",
        "Trombone",
        "Tbn.",
        ("bass", "tenor"),
        40,
        74,
        aliases=("trombone", "posaune", "tenor trombone"),
    ),
    _Row(
        "bass-trombone",
        "BassTrombone",
        "brass",
        "Bass Trombone",
        "B. Tbn.",
        ("bass",),
        34,
        70,
        aliases=("bassposaune", "trombone basso"),
    ),
    _Row(
        "tuba",
        "Tuba",
        "brass",
        "Tuba",
        "Tba.",
        ("bass",),
        28,
        65,
        aliases=("basstuba",),
    ),
    # ── percussion ──
    _Row(
        "timpani",
        "Timpani",
        "percussion",
        "Timpani",
        "Timp.",
        ("bass",),
        38,
        60,
        aliases=("timpano", "pauken", "timbales", "kettledrums"),
    ),
    # music21 writes the mallets untransposed; the glockenspiel sounds two octaves above written, the xylophone one.
    _Row(
        "glockenspiel",
        "Glockenspiel",
        "percussion",
        "Glockenspiel",
        "Glock.",
        ("treble",),
        79,
        108,
        transposition="P15",
        aliases=("campanelli", "orchestra bells"),
    ),
    _Row(
        "xylophone",
        "Xylophone",
        "percussion",
        "Xylophone",
        "Xyl.",
        ("treble",),
        65,
        108,
        transposition="P8",
        aliases=("xilofono", "xylophon"),
    ),
    _Row(
        "vibraphone",
        "Vibraphone",
        "percussion",
        "Vibraphone",
        "Vib.",
        ("treble",),
        53,
        89,
        aliases=("vibes", "vibrafono"),
    ),
    _Row(
        "marimba",
        "Marimba",
        "percussion",
        "Marimba",
        "Mar.",
        ("treble", "bass"),
        36,
        96,
        staves=2,
        aliases=("marimbaphone",),
    ),
    _Row(
        "tubular-bells",
        "TubularBells",
        "percussion",
        "Tubular Bells",
        "T. Bells",
        ("treble",),
        60,
        77,
        aliases=("chimes", "campane", "röhrenglocken"),
    ),
    _kit(
        "snare-drum",
        "SnareDrum",
        "Snare Drum",
        "S.D.",
        38,
        "snare",
        "tamburo",
        "caisse claire",
        "kleine trommel",
        "side drum",
    ),
    _kit(
        "bass-drum",
        "BassDrum",
        "Bass Drum",
        "B.D.",
        36,
        "gran cassa",
        "grosse caisse",
        "große trommel",
        "grosse trommel",
    ),
    _kit(
        "crash-cymbals",
        "CrashCymbals",
        "Crash Cymbals",
        "Cym.",
        59,
        "cymbals",
        "piatti",
        "becken",
        "cymbales",
    ),
    _kit(
        "suspended-cymbal",
        "SuspendedCymbal",
        "Suspended Cymbal",
        "Sus. Cym.",
        57,
        "sus cym",
        "piatto sospeso",
    ),
    _kit("triangle", "Triangle", "Triangle", "Tri.", 81, "triangolo", "triangel"),
    _kit(
        "tambourine",
        "Tambourine",
        "Tambourine",
        "Tamb.",
        54,
        "tamburino",
        "tambour de basque",
        "tamburin",
    ),
    _kit(
        "woodblock",
        "Woodblock",
        "Wood Block",
        "W.B.",
        76,
        "wood block",
        "blocco di legno",
        "holzblock",
    ),
    _kit(
        "castanets",
        "Castanets",
        "Castanets",
        "Cast.",
        39,
        "castagnette",
        "kastagnetten",
        "castagnettes",
    ),
    _kit(
        "sleigh-bells",
        "SleighBells",
        "Sleigh Bells",
        "Sl. B.",
        83,
        "jingle bells",
        "sonagli",
        "schellen",
    ),
    # ── harp and keyboards ──
    _Row(
        "harp",
        "Harp",
        "keyboards",
        "Harp",
        "Hp.",
        ("treble", "bass"),
        23,
        104,
        staves=2,
        aliases=("arpa", "harfe", "harpe"),
    ),
    # music21 writes the celesta untransposed; it sounds an octave above written.
    _Row(
        "celesta",
        "Celesta",
        "keyboards",
        "Celesta",
        "Cel.",
        ("treble", "bass"),
        60,
        108,
        staves=2,
        transposition="P8",
        aliases=("celeste",),
    ),
    _Row(
        "piano",
        "Piano",
        "keyboards",
        "Piano",
        "Pno.",
        ("treble", "bass"),
        21,
        108,
        staves=2,
        aliases=("pianoforte", "klavier", "grand piano", "keys"),
    ),
    _Row(
        "harpsichord",
        "Harpsichord",
        "keyboards",
        "Harpsichord",
        "Hpd.",
        ("treble", "bass"),
        29,
        89,
        staves=2,
        aliases=("cembalo", "clavecin"),
    ),
    _Row(
        "organ",
        "PipeOrgan",
        "keyboards",
        "Organ",
        "Org.",
        ("treble", "bass"),
        36,
        96,
        staves=2,
        aliases=("organo", "orgel", "orgue", "pipe organ"),
    ),
    # ── band ──
    # music21 writes the guitars and the electric bass untransposed; each sounds an octave below written.
    _Row(
        "electric-guitar",
        "ElectricGuitar",
        "band",
        "Electric Guitar",
        "E. Gtr.",
        ("treble",),
        40,
        88,
        transposition="P-8",
        aliases=("electric guitar", "e-gitarre", "guitar"),
    ),
    _Row(
        "acoustic-guitar",
        "AcousticGuitar",
        "band",
        "Acoustic Guitar",
        "Gtr.",
        ("treble",),
        40,
        83,
        transposition="P-8",
        aliases=("classical guitar", "chitarra", "gitarre", "nylon guitar"),
    ),
    _Row(
        "electric-bass",
        "ElectricBass",
        "band",
        "Electric Bass",
        "E. Bass",
        ("bass",),
        28,
        67,
        transposition="P-8",
        aliases=("bass guitar", "e-bass", "electric bass"),
    ),
    _Row(
        "drum-kit",
        "UnpitchedPercussion",
        "band",
        "Drum Kit",
        "D. Kit",
        ("percussion",),
        35,
        81,
        program=STANDARD_KIT,
        bank=PERCUSSION_BANK,
        percussion=True,
        aliases=("drums", "drum set", "drumset", "kit", "schlagzeug"),
    ),
    # ── voices ──
    _Row(
        "voice",
        "Vocalist",
        "voices",
        "Voice",
        "Vo.",
        ("treble",),
        48,
        84,
        aliases=("vocals", "vocal", "lead vocal", "singer", "voce"),
    ),
    _Row(
        "soprano",
        "Soprano",
        "voices",
        "Soprano",
        "S.",
        ("treble",),
        60,
        84,
        aliases=("sopran",),
    ),
    _Row(
        "mezzo-soprano",
        "MezzoSoprano",
        "voices",
        "Mezzo-soprano",
        "Mez.",
        ("treble",),
        57,
        81,
        aliases=("mezzo",),
    ),
    _Row(
        "alto",
        "Alto",
        "voices",
        "Alto",
        "A.",
        ("treble",),
        53,
        77,
        aliases=("contralto", "alt"),
    ),
    _Row(
        "tenor",
        "Tenor",
        "voices",
        "Tenor",
        "T.",
        ("treble8vb", "bass"),
        48,
        72,
        aliases=("tenore", "ténor"),
    ),
    _Row(
        "baritone",
        "Baritone",
        "voices",
        "Baritone",
        "Bar.",
        ("bass",),
        43,
        67,
        aliases=("baritono", "bariton"),
    ),
    _Row(
        "bass-voice",
        "Bass",
        "voices",
        "Bass",
        "B.",
        ("bass",),
        40,
        64,
        aliases=("basso", "bass voice"),
    ),
    _Row(
        "choir",
        "Choir",
        "voices",
        "Choir",
        "Ch.",
        ("treble", "bass"),
        40,
        84,
        staves=2,
        aliases=("chorus", "coro", "chor", "choeur", "satb"),
    ),
    # ── strings ──
    _Row(
        "violin",
        "Violin",
        "strings",
        "Violin",
        "Vln.",
        ("treble",),
        55,
        100,
        aliases=("violino", "violine", "violon", "geige", "vl"),
    ),
    _Row(
        "viola",
        "Viola",
        "strings",
        "Viola",
        "Vla.",
        ("alto", "treble"),
        48,
        88,
        aliases=("bratsche", "alto (viola)"),
    ),
    _Row(
        "cello",
        "Violoncello",
        "strings",
        "Violoncello",
        "Vc.",
        ("bass", "tenor", "treble"),
        36,
        81,
        aliases=("cello", "violoncelle", "vc"),
    ),
    _Row(
        "contrabass",
        "Contrabass",
        "strings",
        "Contrabass",
        "Cb.",
        ("bass",),
        28,
        67,
        aliases=(
            "double bass",
            "contrabbasso",
            "kontrabass",
            "string bass",
            "upright bass",
            "kb",
        ),
    ),
)


def _build(row: _Row, order: int) -> OrchestraInstrument:
    from music21 import instrument, interval

    base = getattr(instrument, row.cls)()
    program = row.program if row.program is not None else base.midiProgram
    if program is None:
        raise ValueError(f"{row.id}: music21 {row.cls} has no MIDI program; state one")
    if row.transposition is not None:
        transposition = row.transposition
    elif base.transposition is not None:
        transposition = base.transposition.directedName
    else:
        transposition = "P1"
    semitones = int(interval.Interval(transposition).semitones)
    return OrchestraInstrument(
        id=row.id,
        family=row.family,
        order=order,
        name=row.name,
        abbreviation=row.abbreviation,
        music21_class=row.cls,
        transposition=transposition,
        semitones=semitones,
        clefs=row.clefs,
        staves=row.staves,
        range_low=row.low,
        range_high=row.high,
        program=int(program),
        bank=row.bank,
        percussion=row.percussion,
        kit_pitch=row.kit_pitch,
        aliases=row.aliases,
    )


@lru_cache(maxsize=1)
def instruments() -> tuple[OrchestraInstrument, ...]:
    """Every record, in score order."""
    return tuple(_build(row, i) for i, row in enumerate(_ROWS))


def by_id(instrument_id: str) -> Optional[OrchestraInstrument]:
    return next((i for i in instruments() if i.id == instrument_id), None)


def for_program(
    program: int, *, bank: int = 0, percussion: bool = False
) -> Optional[OrchestraInstrument]:
    """The first record in score order that plays ``program`` in ``bank``.
    A drum-channel part (``percussion``) is the drum kit, whatever its program."""
    if percussion:
        return by_id("drum-kit")
    return next(
        (
            i
            for i in instruments()
            if i.program == program and i.bank == bank and not i.percussion
        ),
        None,
    )


def guess_from_name(text: str) -> Optional[OrchestraInstrument]:
    """The record a part name names: one of its :attr:`match_keys` as a whole
    word, the longest match winning ("Bass Clarinet 1" is the bass clarinet,
    not the bass voice) and the earlier record in score order on a tie. None
    when nothing matches. The frontend runs the same match over the same keys
    (``guessInstrument`` in ``frontend/src/lib/orchestra.ts``)."""
    hay = f" {normalize_name(text)} "
    best: Optional[tuple[int, int, OrchestraInstrument]] = None
    for inst in instruments():
        for key in inst.match_keys:
            if f" {key} " in hay:
                rank = (len(key), -inst.order)
                if best is None or rank > best[:2]:
                    best = (rank[0], rank[1], inst)
    return best[2] if best else None


def match_music21(inst: Any) -> Optional[OrchestraInstrument]:
    """The record for a music21 ``Instrument`` read from a file: by its part or
    instrument name first, then by its class, then by its MIDI program."""
    for text in (
        getattr(inst, "partName", None),
        getattr(inst, "instrumentName", None),
    ):
        if text:
            hit = guess_from_name(str(text))
            if hit is not None:
                return hit
    for record in instruments():
        if type(inst).__name__ == record.music21_class:
            return record
    program = getattr(inst, "midiProgram", None)
    if program is not None:
        return for_program(int(program))
    return None


def music21_clef(clef_id: str) -> Any:
    """The music21 clef a record's clef id names."""
    from music21 import clef

    if clef_id == "percussion":
        return clef.PercussionClef()
    sign, line, octave = CLEFS[clef_id]
    return clef.clefFromString(f"{sign}{line}", octaveShift=octave)


def to_music21(record: OrchestraInstrument) -> Any:
    """A music21 instrument for ``record``: its class, with the registry's
    name, abbreviation, program, transposition and range."""
    from music21 import instrument, interval, pitch

    inst = getattr(instrument, record.music21_class)()
    inst.partName = record.name
    inst.partAbbreviation = record.abbreviation
    inst.instrumentName = record.name
    inst.instrumentAbbreviation = record.abbreviation
    inst.midiProgram = record.program
    if record.percussion:
        inst.midiChannel = 9
    inst.transposition = (
        None if record.semitones == 0 else interval.Interval(record.transposition)
    )
    if not record.percussion:
        inst.lowestNote = pitch.Pitch(midi=record.written(record.range_low))
        inst.highestNote = pitch.Pitch(midi=record.written(record.range_high))
    return inst


def sounding_window(record: OrchestraInstrument, clef_id: str) -> tuple[int, int]:
    """The sounding pitches ``clef_id`` shows for ``record`` within three ledger
    lines, cut to the record's practical range when at least an octave of it
    is left."""
    low, high = CLEF_WINDOWS[clef_id]
    low, high = low + record.semitones, high + record.semitones
    cut = (max(low, record.range_low), min(high, record.range_high))
    return cut if cut[1] - cut[0] >= 12 else (low, high)


def best_clef(record: OrchestraInstrument, pitches: list[int]) -> str:
    """The record's clef that shows the most of ``pitches`` (sounding MIDI)
    within three ledger lines; the usual clef on a tie or with no pitches."""
    usable = [c for c in record.clefs if c in CLEF_WINDOWS]
    if not usable:
        return record.clefs[0]
    best = usable[0]
    best_count = -1
    for clef_id in usable:
        low, high = sounding_window(record, clef_id)
        count = sum(1 for p in pitches if low <= p <= high)
        if count > best_count:
            best, best_count = clef_id, count
    return best


def family_label(family: str) -> str:
    return dict(FAMILIES)[family]


def registry_json() -> str:
    """The registry as the JSON the frontend mirror embeds."""
    payload = {
        "matchPattern": MATCH_PATTERN,
        "families": [{"id": f, "label": label} for f, label in FAMILIES],
        "instruments": [i.record() for i in instruments()],
    }
    return json.dumps(payload, indent=2, ensure_ascii=False)


def frontend_module_text() -> str:
    """The full text of ``frontend/src/lib/orchestraData.ts``."""
    return (
        "// Generated by `python -m backend.modules.notation.instruments` from\n"
        "// backend/modules/notation/instruments.py. Do not edit by hand:\n"
        "// tests/test_orchestra_registry.py fails when this file and the backend differ.\n"
        f"export const ORCHESTRA_DATA = {registry_json()} as const;\n"
    )


def write_frontend_mirror(root: Path) -> Path:
    """Write the frontend mirror under the repo ``root``."""
    target = root / FRONTEND_MIRROR
    target.write_text(frontend_module_text(), encoding="utf-8", newline="\n")
    return target


def _check() -> None:
    families = [i.family for i in instruments()]
    for family in families:
        if family not in _FAMILY_IDS:
            raise ValueError(f"unknown family {family!r}")
    seen = [f for i, f in enumerate(families) if i == 0 or families[i - 1] != f]
    if seen != [f for f in _FAMILY_IDS if f in seen]:
        raise ValueError("families must be contiguous and in score order")


if __name__ == "__main__":  # pragma: no cover - developer tool
    _check()
    repo = Path(__file__).resolve().parents[3]
    print(write_frontend_mirror(repo))
    sys.exit(0)
