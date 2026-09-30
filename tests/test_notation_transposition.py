"""Transposing instruments read and write at the right pitch.

A part for a B-flat clarinet, a clarinet in A, a horn in F, a trumpet, a
piccolo or a contrabass is printed at written pitch, with a ``<transpose>``
saying how far it sounds from the page. These tests replay the app's flows on
such parts:

  - sheet import: a MusicXML engraved elsewhere -> ``parse_score_path`` -> roll
    notes, which the roll plays as they are;
  - MAKE SHEET: a MIDI (sounding pitch, General MIDI program) -> MusicXML ->
    read back by a notation reader and by the sheet import;
  - the note chart, ABC and arrangements of such a sheet.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

import pretty_midi
import pytest

from backend.modules.library.db import LibraryDB
from backend.modules.notation.engine import convert_score, midi_to_arrangement
from backend.modules.notation.exporters.notechart import build_notechart
from backend.modules.sheetimport.parser import parse_score_path

_STEP_SEMITONES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

# name -> (instrument name, <diatonic>, <chromatic>, <octave-change>,
#          written note (step, alter, octave), the MIDI pitch it sounds)
PARTS = {
    "clarinet-bb": ("Clarinet in B-flat", -1, -2, 0, ("D", 0, 4), 60),
    "clarinet-a": ("Clarinet in A", -2, -3, 0, ("E", -1, 4), 60),
    "horn-f": ("Horn in F", -4, -7, 0, ("G", 0, 4), 60),
    "trumpet-bb": ("Trumpet in B-flat", -1, -2, 0, ("D", 0, 5), 72),
    "piccolo": ("Piccolo", 0, 0, 1, ("C", 0, 5), 84),
    "contrabass": ("Contrabass", 0, 0, -1, ("C", 0, 3), 36),
}


def _written_midi(step: str, alter: int, octave: int) -> int:
    return (octave + 1) * 12 + _STEP_SEMITONES[step] + alter


def _sheet(
    path: Path,
    name: str,
    diatonic: int,
    chromatic: int,
    octave_change: int,
    written: tuple[str, int, int],
    *,
    fifths: int = 0,
) -> Path:
    """A one-bar MusicXML part as an engraver writes one for a transposing
    instrument: the written note, the key as the player reads it, and the
    ``<transpose>`` from the page to the sound."""
    step, alter, octave = written
    alter_xml = f"<alter>{alter}</alter>" if alter else ""
    octave_xml = (
        f"<octave-change>{octave_change}</octave-change>" if octave_change else ""
    )
    path.write_text(
        f"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>{name}</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <key><fifths>{fifths}</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
        <transpose>
          <diatonic>{diatonic}</diatonic>
          <chromatic>{chromatic}</chromatic>
          {octave_xml}
        </transpose>
      </attributes>
      <note>
        <pitch><step>{step}</step>{alter_xml}<octave>{octave}</octave></pitch>
        <duration>4</duration>
        <type>whole</type>
      </note>
    </measure>
  </part>
</score-partwise>
""",
        encoding="utf-8",
    )
    return path


@pytest.mark.parametrize("key", sorted(PARTS))
def test_sheet_import_reads_the_pitch_that_sounds(tmp_path: Path, key: str):
    name, diatonic, chromatic, octave_change, written, sounding = PARTS[key]
    sheet = _sheet(
        tmp_path / f"{key}.musicxml", name, diatonic, chromatic, octave_change, written
    )
    result = parse_score_path(str(sheet))
    assert [n["pitch"] for n in result["tracks"][0]["notes"]] == [sounding]


def test_sheet_import_reports_the_concert_key(tmp_path: Path):
    """A B-flat clarinet part in F major (one flat) sounds in E-flat major."""
    sheet = _sheet(
        tmp_path / "clarinet.musicxml",
        "Clarinet in B-flat",
        -1,
        -2,
        0,
        ("D", 0, 4),
        fifths=-1,
    )
    result = parse_score_path(str(sheet))
    assert result["detected_key"] == "E- major"


# General MIDI program -> (the pitch it sounds, the written pitch its part prints)
PROGRAMS = {
    "clarinet": (71, 60, 62),
    "horn": (60, 60, 67),
    "trumpet": (56, 72, 74),
    "piccolo": (72, 84, 72),
    "contrabass": (43, 36, 48),
}


def _program_midi(path: Path, program: int, pitch: int) -> Path:
    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    inst = pretty_midi.Instrument(program=program)
    inst.notes.append(pretty_midi.Note(90, pitch, 0.0, 2.0))
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))
    return path


def _db(tmp_path: Path) -> LibraryDB:
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "song"})
    return db


def _make_sheet(tmp_path: Path, midi: Path) -> Path:
    result = convert_score(
        _db(tmp_path),
        entry_id="song",
        source_path=midi,
        fmt="musicxml",
        output_path=tmp_path / "notation" / f"{midi.stem}.musicxml",
    )
    assert result["ok"] is True, result
    return Path(result["path"])


@pytest.mark.parametrize("key", sorted(PROGRAMS))
def test_make_sheet_writes_the_written_pitch_its_transpose_states(
    tmp_path: Path, key: str
):
    """MIDI -> MAKE SHEET -> a reader applies <transpose> -> the MIDI's pitch;
    then the sheet import of that sheet gives the MIDI's pitch back."""
    program, sounding, written = PROGRAMS[key]
    sheet = _make_sheet(
        tmp_path, _program_midi(tmp_path / "midi" / f"{key}.mid", program, sounding)
    )
    root = ET.parse(sheet).getroot()
    pitch = root.find(".//note/pitch")
    assert pitch is not None
    alter = int(float(pitch.findtext("alter") or 0))
    printed = _written_midi(
        pitch.findtext("step") or "", alter, int(pitch.findtext("octave") or 0)
    )
    transpose = root.find(".//transpose")
    assert transpose is not None
    shift = int(transpose.findtext("chromatic") or 0) + 12 * int(
        transpose.findtext("octave-change") or 0
    )
    assert printed == written
    assert printed + shift == sounding
    back = parse_score_path(str(sheet))
    assert [n["pitch"] for n in back["tracks"][0]["notes"]] == [sounding]


def test_note_chart_of_a_clarinet_sheet_sounds_and_spells_as_printed(tmp_path: Path):
    """An imported B-flat clarinet sheet: the chart places the written D4 and
    plays (``midi``) the C4 it sounds."""
    sheet = _sheet(
        tmp_path / "clarinet.musicxml", "Clarinet in B-flat", -1, -2, 0, ("D", 0, 4)
    )
    chart = build_notechart(sheet, title="t", artist="a", entry_id="song")
    notes = [e for e in chart["parts"][0]["events"] if not e["isRest"]]
    assert [(e["step"], e["octave"], e["midi"]) for e in notes] == [("D", 4, 60)]


def test_note_chart_agrees_with_the_sheet_made_from_the_same_midi(tmp_path: Path):
    """MIDI -> MAKE SHEET; a chart of the MIDI and a chart of the sheet show the
    same written notes and play the same sounding pitches."""
    midi = tmp_path / "midi" / "clarinet.mid"
    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    inst = pretty_midi.Instrument(program=71)
    for i, pitch in enumerate((60, 62, 64, 65)):
        inst.notes.append(pretty_midi.Note(90, pitch, i * 0.5, i * 0.5 + 0.5))
    pm.instruments.append(inst)
    midi.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(midi))
    sheet = _make_sheet(tmp_path, midi)
    charts = [
        build_notechart(
            source, title="t", artist="a", entry_id="song", raw_midi_path=midi
        )
        for source in (midi, sheet)
    ]
    for chart in charts:
        notes = [e for e in chart["parts"][0]["events"] if not e["isRest"]]
        assert [(e["step"], e["alter"], e["octave"]) for e in notes] == [
            ("D", 0, 4),
            ("E", 0, 4),
            ("F", 1, 4),
            ("G", 0, 4),
        ]
        assert [e["midi"] for e in notes] == [60, 62, 64, 65]
        # Every note pairs with its recorded onset, which is at sounding pitch.
        assert chart["quantization"]["matchedRawEvents"] == 4


def test_note_chart_keeps_an_8va_passage_at_the_pitch_it_sounds(tmp_path: Path):
    """A piano sheet with an 8va line: MusicXML stores those notes at the pitch
    they sound, and the chart plays them there."""
    from music21 import instrument, note, spanner, stream

    score = stream.Score()
    part = stream.Part()
    part.insert(0, instrument.Piano())
    notes = [note.Note(n, quarterLength=1) for n in ("C4", "D4", "E4", "F4")]
    for n in notes:
        part.append(n)
    part.append(note.Note("G4", quarterLength=4))
    ottava = spanner.Ottava(*notes)
    ottava.type = "8va"
    part.insert(0, ottava)
    score.insert(0, part)
    score.atSoundingPitch = True
    sheet = tmp_path / "piano.musicxml"
    score.write("musicxml", fp=str(sheet))
    chart = build_notechart(sheet, title="t", artist="a", entry_id="song")
    notes_out = [e for e in chart["parts"][0]["events"] if not e["isRest"]]
    assert [e["midi"] for e in notes_out] == [72, 74, 76, 77, 67]
    assert [n["pitch"] for n in parse_score_path(str(sheet))["tracks"][0]["notes"]] == [
        72,
        74,
        76,
        77,
        67,
    ]


def test_abc_of_a_clarinet_sheet_is_at_concert_pitch(tmp_path: Path):
    """ABC states no transposition: the clarinet's written D4 in F major is
    written as the C4 it sounds, in E-flat major."""
    sheet = _sheet(
        tmp_path / "clarinet.musicxml",
        "Clarinet in B-flat",
        -1,
        -2,
        0,
        ("D", 0, 4),
        fifths=-1,
    )
    result = convert_score(
        _db(tmp_path),
        entry_id="song",
        source_path=sheet,
        fmt="abc",
        output_path=tmp_path / "notation" / "clarinet.abc",
    )
    assert result["ok"] is True, result
    lines = Path(result["path"]).read_text(encoding="utf-8").splitlines()
    assert "K:Eb" in lines
    body = lines[lines.index("K:Eb") + 1]
    assert body.startswith("C")


def test_arrangement_of_a_clarinet_sheet_is_at_concert_pitch(tmp_path: Path):
    """An arrangement's parts carry no transposing instrument, so they print
    the clarinet's written D4 as the C4 it sounds, in its concert key."""
    sheet = _sheet(
        tmp_path / "clarinet.musicxml",
        "Clarinet in B-flat",
        -1,
        -2,
        0,
        ("D", 0, 4),
        fifths=-1,
    )
    result = midi_to_arrangement(
        _db(tmp_path),
        entry_id="song",
        sources=[sheet],
        style="simplified",
        output_path=tmp_path / "notation" / "simplified.musicxml",
    )
    assert result["ok"] is True, result
    root = ET.parse(result["path"]).getroot()
    assert root.find(".//transpose") is None
    assert [f.text for f in root.iter("fifths")] == ["-3"]
    pitch = root.find(".//note/pitch")
    assert pitch is not None
    assert (pitch.findtext("step"), pitch.findtext("octave")) == ("C", "4")


def _clarinet_scale_midi(path: Path) -> Path:
    """A General MIDI clarinet (program 71) playing C4 D4 E4 F4 at sounding
    pitch, as a transcription or a DAW writes it."""
    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    inst = pretty_midi.Instrument(program=71)
    for i, pitch in enumerate((60, 62, 64, 65)):
        inst.notes.append(pretty_midi.Note(90, pitch, i * 0.5, i * 0.5 + 0.5))
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))
    return path


def _older_build_sheet(midi: Path, sheet: Path) -> Path:
    """MAKE SHEET as the build before the pitch fix wrote it: ``read_midi``
    left each part at music21's ``'unknown'`` pitch state, so the writer printed
    it at the pitch it sounds under the clarinet's ``<transpose>``, and nothing
    stamped the sheet."""
    from backend.modules.notation.midi_read import read_midi

    score = read_midi(midi)
    score.atSoundingPitch = "unknown"
    for part in score.parts:
        part.atSoundingPitch = "unknown"
    score = score.quantize((4, 3), inPlace=False, recurse=True)
    sheet.parent.mkdir(parents=True, exist_ok=True)
    score.write("musicxml", fp=str(sheet))
    return sheet


def _printed(root: ET.Element) -> list[tuple[str, int, int]]:
    """``(step, alter, octave)`` of every pitched note the sheet prints."""
    return [
        (
            pitch.findtext("step") or "",
            int(float(pitch.findtext("alter") or 0)),
            int(pitch.findtext("octave") or 0),
        )
        for pitch in root.iter("pitch")
    ]


def test_a_sheet_an_older_build_made_still_reads_at_the_pitch_it_sounds(
    tmp_path: Path,
):
    """A clarinet sheet an older build made from a MIDI holds sounding pitch
    under its <transpose>. Opened in this build: the import and the note chart
    give the MIDI's pitches, the chart pairs every recorded onset, the chart
    places the written notes, and MAKE SHEET of it prints written pitch."""
    midi = _clarinet_scale_midi(tmp_path / "midi" / "clarinet.mid")
    sheet = _older_build_sheet(midi, tmp_path / "notation" / "clarinet.musicxml")
    old = sheet.read_bytes()
    assert b"<transpose>" in old and b"thedaw-pitch" not in old
    assert _printed(ET.parse(sheet).getroot()) == [
        ("C", 0, 4),
        ("D", 0, 4),
        ("E", 0, 4),
        ("F", 0, 4),
    ]

    imported = parse_score_path(str(sheet))
    assert [n["pitch"] for n in imported["tracks"][0]["notes"]] == [60, 62, 64, 65]

    chart = build_notechart(
        sheet, title="t", artist="a", entry_id="song", raw_midi_path=midi
    )
    notes = [e for e in chart["parts"][0]["events"] if not e["isRest"]]
    assert [e["midi"] for e in notes] == [60, 62, 64, 65]
    assert [(e["step"], e["alter"], e["octave"]) for e in notes] == [
        ("D", 0, 4),
        ("E", 0, 4),
        ("F", 1, 4),
        ("G", 0, 4),
    ]
    assert chart["quantization"]["matchedRawEvents"] == 4

    remade = convert_score(
        _db(tmp_path),
        entry_id="song",
        source_path=sheet,
        fmt="musicxml",
        output_path=tmp_path / "notation" / "clarinet__remade.musicxml",
    )
    assert remade["ok"] is True, remade
    root = ET.parse(remade["path"]).getroot()
    assert _printed(root) == [("D", 0, 4), ("E", 0, 4), ("F", 1, 4), ("G", 0, 4)]
    back = parse_score_path(str(remade["path"]))
    assert [n["pitch"] for n in back["tracks"][0]["notes"]] == [60, 62, 64, 65]


def test_every_sheet_this_build_writes_is_stamped_once_even_one_part_of_it(
    tmp_path: Path,
):
    """MAKE SHEET stamps the sheet as written pitch; MAKE SHEET of that sheet
    keeps one stamp; the one-part XML cut from it keeps the stamp, so the part
    still imports at the pitch it sounds."""
    midi = _clarinet_scale_midi(tmp_path / "midi" / "clarinet.mid")
    sheet = _make_sheet(tmp_path, midi)
    assert sheet.read_bytes().count(b'name="thedaw-pitch"') == 1

    remade = convert_score(
        _db(tmp_path),
        entry_id="song",
        source_path=sheet,
        fmt="musicxml",
        output_path=tmp_path / "notation" / "clarinet__remade.musicxml",
    )
    assert remade["ok"] is True, remade
    assert Path(remade["path"]).read_bytes().count(b'name="thedaw-pitch"') == 1

    one_part = convert_score(
        _db(tmp_path),
        entry_id="song",
        source_path=sheet,
        fmt="musicxml",
        output_path=tmp_path / "notation" / "clarinet__part.musicxml",
        options={"parts": [0]},
    )
    assert one_part["ok"] is True, one_part
    cut = Path(one_part["path"])
    assert b'name="thedaw-pitch"' in cut.read_bytes()
    back = parse_score_path(str(cut))
    assert [n["pitch"] for n in back["tracks"][0]["notes"]] == [60, 62, 64, 65]


def test_chord_track_of_a_clarinet_lead_sheet_is_at_concert_pitch(tmp_path: Path):
    """A B-flat clarinet lead sheet prints D major over its written D4; the
    chord track, which sounds with the audio, reads the C major it sounds."""
    from backend.modules.notation.exporters.chordtrack import build_chordtrack

    sheet = tmp_path / "clarinet_lead.musicxml"
    sheet.write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>Clarinet in B-flat</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <key><fifths>2</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
        <transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose>
      </attributes>
      <harmony><root><root-step>D</root-step></root><kind>major</kind></harmony>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
    <measure number="2">
      <harmony><root><root-step>A</root-step></root><kind>major</kind></harmony>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>
""",
        encoding="utf-8",
    )
    doc = build_chordtrack(
        entry_id="e",
        audio_path=None,
        analysis_row=None,
        lead_sheet_path=sheet,
        method="harmony",
    )
    assert [c["symbol"] for c in doc["chords"]] == ["C", "G"]
    assert [c["rootPc"] for c in doc["chords"]] == [0, 7]
