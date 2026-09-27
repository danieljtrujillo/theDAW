"""The orchestral instrument registry and its frontend mirror.

The registry (backend/modules/notation/instruments.py) is the one source of
truth for what a part is; the frontend reads a generated copy of it
(frontend/src/lib/orchestraData.ts). These tests fail when the copy drifts,
when a record disagrees with the music21 class it is built on without saying
so, and when a program, bank or kit key does not sound in the SoundFont the
app ships.
"""

from __future__ import annotations

import re
import struct
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest  # type: ignore[import]

from backend.modules.notation import instruments as reg

REPO = Path(__file__).resolve().parents[1]
SOUNDFONT = REPO / "frontend" / "public" / "soundfonts" / "gm.sf3"


def test_backend_resolves_to_this_checkout():
    assert Path(reg.__file__).resolve().is_relative_to(REPO)


def test_frontend_mirror_is_generated_from_the_backend():
    mirror = REPO / reg.FRONTEND_MIRROR
    assert mirror.is_file(), "run: python -m backend.modules.notation.instruments"
    assert mirror.read_text(encoding="utf-8") == reg.frontend_module_text(), (
        "frontend/src/lib/orchestraData.ts differs from the backend registry; "
        "regenerate it with: python -m backend.modules.notation.instruments"
    )


def test_ids_unique_and_families_in_score_order():
    records = reg.instruments()
    ids = [r.id for r in records]
    assert len(ids) == len(set(ids))
    assert [r.order for r in records] == list(range(len(records)))
    family_ids = [f for f, _label in reg.FAMILIES]
    runs = [
        r.family
        for i, r in enumerate(records)
        if i == 0 or records[i - 1].family != r.family
    ]
    assert runs == [f for f in family_ids if f in runs], (
        "a family's records must be contiguous, in score order"
    )
    assert set(runs) == set(family_ids)


def test_every_record_is_complete():
    for r in reg.instruments():
        assert r.name and r.abbreviation, r.id
        assert r.clefs and all(c in reg.CLEFS for c in r.clefs), r.id
        assert r.staves in (1, 2), r.id
        assert 0 <= r.range_low <= r.range_high <= 127, r.id
        assert 0 <= r.program <= 127, r.id
        assert r.bank in (0, reg.PERCUSSION_BANK), r.id
        if r.percussion:
            assert r.bank == reg.PERCUSSION_BANK and r.clefs == ("percussion",), r.id
        else:
            assert r.range_high - r.range_low >= 12, r.id
            # The usual clef shows part of the range without ledger-line towers.
            low, high = reg.sounding_window(r, r.clefs[0])
            assert low <= r.range_high and high >= r.range_low, r.id
        if r.kit_pitch is not None:
            assert r.range_low == r.range_high == r.kit_pitch, r.id


def test_records_follow_music21_unless_they_override_it():
    """Name-independent facts come from the music21 class; a row that states
    its own program or transposition is the documented exception."""
    from music21 import instrument

    overridden_transpositions = set()
    for row, record in zip(reg._ROWS, reg.instruments()):
        base = getattr(instrument, row.cls)()
        assert record.music21_class == row.cls
        if row.program is None:
            assert record.program == base.midiProgram, row.id
        if row.transposition is None:
            want = base.transposition.directedName if base.transposition else "P1"
            assert record.transposition == want, row.id
        else:
            overridden_transpositions.add(row.id)
    # Where music21 is wrong for the orchestra, and the A clarinet / C trumpet.
    assert overridden_transpositions == {
        "clarinet-a",
        "contrabassoon",
        "trumpet-c",
        "glockenspiel",
        "xylophone",
        "celesta",
        "electric-guitar",
        "acoustic-guitar",
        "electric-bass",
    }


@pytest.mark.parametrize(
    ("instrument_id", "semitones", "clef"),
    [
        ("clarinet-bb", -2, "treble"),
        ("clarinet-a", -3, "treble"),
        ("horn", -7, "treble"),
        ("english-horn", -7, "treble"),
        ("trumpet-bb", -2, "treble"),
        ("trumpet-c", 0, "treble"),
        ("piccolo", 12, "treble"),
        ("contrabass", -12, "bass"),
        ("contrabassoon", -12, "bass"),
        ("alto-sax", -9, "treble"),
        ("baritone-sax", -21, "treble"),
        ("viola", 0, "alto"),
        ("cello", 0, "bass"),
        ("tenor", 0, "treble8vb"),
        ("glockenspiel", 24, "treble"),
    ],
)
def test_transpositions_and_usual_clefs(instrument_id: str, semitones: int, clef: str):
    record = reg.by_id(instrument_id)
    assert record is not None
    assert record.semitones == semitones
    assert record.clefs[0] == clef
    assert record.written(record.sounding(60)) == 60


def _soundfont_presets() -> dict[tuple[int, int], set[int]]:
    """``{(bank, program): keys that sound}`` read from the bundled SF3."""
    data = SOUNDFONT.read_bytes()
    pdta = data.find(b"pdta")

    def chunk(tag: bytes, size: int) -> list[bytes]:
        at = data.find(tag, pdta)
        n = struct.unpack("<I", data[at + 4 : at + 8])[0]
        body = data[at + 8 : at + 8 + n]
        return [body[k : k + size] for k in range(0, n, size)]

    phdr, pbag, pgen = chunk(b"phdr", 38), chunk(b"pbag", 4), chunk(b"pgen", 4)
    inst, ibag, igen = chunk(b"inst", 22), chunk(b"ibag", 4), chunk(b"igen", 4)

    def u16(raw: bytes, at: int = 0) -> int:
        return struct.unpack("<H", raw[at : at + 2])[0]

    def gens(bags: list[bytes], table: list[bytes], i: int) -> dict[int, int]:
        out = {}
        for g in range(u16(bags[i]), u16(bags[i + 1])):
            op, amount = struct.unpack("<HH", table[g])
            out[op] = amount
        return out

    def key_range(amount: int | None) -> tuple[int, int]:
        return (0, 127) if amount is None else (amount & 255, amount >> 8)

    presets: dict[tuple[int, int], set[int]] = {}
    for i in range(len(phdr) - 1):
        program, bank, first = struct.unpack("<HHH", phdr[i][20:26])
        keys: set[int] = set()
        for zone in range(first, u16(phdr[i + 1], 24)):
            g = gens(pbag, pgen, zone)
            if 41 not in g:  # no instrument: a global zone
                continue
            plo, phi = key_range(g.get(43))
            index = g[41]
            for izone in range(u16(inst[index], 20), u16(inst[index + 1], 20)):
                h = gens(ibag, igen, izone)
                if 53 not in h:  # no sample: a global zone
                    continue
                ilo, ihi = key_range(h.get(43))
                keys.update(range(max(plo, ilo), min(phi, ihi) + 1))
        presets[(bank, program)] = keys
    return presets


@pytest.mark.skipif(not SOUNDFONT.is_file(), reason="bundled SoundFont not present")
def test_every_program_bank_and_kit_key_sounds_in_the_bundled_soundfont():
    presets = _soundfont_presets()
    for r in reg.instruments():
        assert (r.bank, r.program) in presets, (
            f"{r.id}: bank {r.bank} program {r.program} missing"
        )
        keys = presets[(r.bank, r.program)]
        if r.kit_pitch is not None:
            assert r.kit_pitch in keys, f"{r.id}: kit key {r.kit_pitch} is silent"
        elif not r.percussion:
            assert keys & set(range(r.range_low, r.range_high + 1)), r.id


@pytest.mark.parametrize(
    ("text", "want"),
    [
        ("Violin I", "violin"),
        ("Violin II", "violin"),
        ("Vln. 2", "violin"),
        ("Viola", "viola"),
        ("Violoncello", "cello"),
        ("Double Bass", "contrabass"),
        ("Bass Clarinet 1", "bass-clarinet"),
        ("Clarinet in A", "clarinet-a"),
        ("Clarinet in Bb 2", "clarinet-bb"),
        ("Horn in F 3", "horn"),
        ("Trumpet in C", "trumpet-c"),
        ("Tenor Sax", "tenor-sax"),
        ("Timp.", "timpani"),
        ("Große Trommel", "bass-drum"),
        ("Piano", "piano"),
        ("drums", "drum-kit"),
        ("vocals", "voice"),
        ("Bass", "bass-voice"),
    ],
)
def test_guess_from_part_names(text: str, want: str):
    hit = reg.guess_from_name(text)
    assert hit is not None and hit.id == want, (text, hit)


def test_guess_returns_none_for_unknown_names():
    assert reg.guess_from_name("Theremin") is None
    assert reg.guess_from_name("") is None


def test_match_music21_reads_an_openscore_quartet_and_gm_programs():
    """The four parts of a string quartet as MusicXML names them, and the
    General MIDI programs an orchestral MIDI file carries."""
    from music21 import instrument

    quartet = []
    for part_name in ("Violin I", "Violin II", "Viola", "Violoncello"):
        inst = instrument.Instrument()
        inst.partName = part_name
        quartet.append(reg.match_music21(inst).id)
    assert quartet == ["violin", "violin", "viola", "cello"]
    assert reg.match_music21(instrument.Clarinet()).id == "clarinet-bb"
    unnamed = instrument.Instrument()
    unnamed.midiProgram = 60
    assert reg.match_music21(unnamed).id == "horn"
    assert reg.for_program(73).id == "flute"
    assert reg.for_program(0, percussion=True).id == "drum-kit"
    assert reg.for_program(48, bank=reg.PERCUSSION_BANK) is None


def test_best_clef_picks_the_clef_that_shows_the_notes():
    cello = reg.by_id("cello")
    assert reg.best_clef(cello, [36, 43, 48, 55]) == "bass"
    assert reg.best_clef(cello, [62, 64, 67, 69, 72]) == "tenor"
    assert reg.best_clef(cello, []) == "bass"
    viola = reg.by_id("viola")
    assert reg.best_clef(viola, [76, 79, 81, 84, 86]) == "treble"


def test_to_music21_writes_a_transposed_part(tmp_path: Path):
    """A B-flat clarinet part at sounding pitch is written a whole step up
    under <transpose chromatic -2>, named and abbreviated from the registry."""
    from music21 import note, stream

    record = reg.by_id("clarinet-bb")
    part = stream.Part()
    part.atSoundingPitch = True
    part.insert(0, reg.to_music21(record))
    part.insert(0, reg.music21_clef("treble"))
    part.append(note.Note(60, quarterLength=4))  # sounding C4
    score = stream.Score([part])
    path = tmp_path / "cl.musicxml"
    score.write("musicxml", fp=str(path))
    root = ET.parse(path).getroot()
    assert root.find(".//part-name").text == "Clarinet in B♭"
    assert root.find(".//part-abbreviation").text == "Cl."
    assert root.find(".//transpose/chromatic").text == "-2"
    step = root.find(".//note/pitch/step").text
    octave = root.find(".//note/pitch/octave").text
    assert (step, octave) == ("D", "4"), "written a whole step above the sound"
    program = root.find(".//midi-instrument/midi-program").text
    assert int(program) == record.program + 1  # MusicXML counts programs from 1


def test_mirror_data_matches_records():
    """The embedded JSON parses back to exactly the records (guards a hand edit
    that keeps the header but changes a value)."""
    import json

    text = (REPO / reg.FRONTEND_MIRROR).read_text(encoding="utf-8")
    body = re.search(r"ORCHESTRA_DATA = (\{.*\}) as const;", text, re.S)
    assert body is not None
    data = json.loads(body.group(1))
    assert data["matchPattern"] == reg.MATCH_PATTERN
    assert data["instruments"] == [r.record() for r in reg.instruments()]
