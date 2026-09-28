"""Expression marks between a MIDI's playing and a sheet, both ways.

MIDI to sheet: velocities become dynamics and hairpins, short notes staccato,
overlapping notes a slur (``notation.expression.add_expression`` and the
engine's MusicXML export). Sheet to MIDI: printed dynamics, a hairpin and
staccato become velocities and lengths in the sheet import
(``sheetimport.parser.parse_score_path``).
"""

from __future__ import annotations

from pathlib import Path

import pretty_midi
from music21 import converter, dynamics, meter, note, spanner, stream

from backend.modules.notation import engine as notation_engine
from backend.modules.notation.expression import (
    add_expression,
    expression_enabled,
    level_for_velocity,
)
from backend.modules.sheetimport.parser import parse_score_path


def _score(notes: list[tuple[float, float, int, int]]) -> stream.Score:
    """One flat 4/4 part; each note is (onset, length, pitch, velocity) in
    quarters, as ``midi_read.read_midi`` leaves a MIDI."""
    score = stream.Score()
    part = stream.Part()
    part.insert(0, meter.TimeSignature("4/4"))
    for onset, length, pitch, velocity in notes:
        n = note.Note(pitch, quarterLength=length)
        n.volume.velocity = velocity
        part.insert(onset, n)
    score.insert(0, part)
    return score


def _marks(score: stream.Score) -> list[str]:
    flat = score.parts[0].flatten()
    return [d.value for d in flat.getElementsByClass(dynamics.Dynamic)]


def _spanners(score: stream.Score, cls: type) -> list:
    return [sp for sp in score.parts[0].spannerBundle if isinstance(sp, cls)]


def test_a_velocity_ramp_prints_a_crescendo_from_p_to_f():
    velocities = [round(40 + i * 60 / 7) for i in range(8)]
    assert velocities[0] == 40 and velocities[-1] == 100
    score = _score([(i, 1.0, 60 + i, v) for i, v in enumerate(velocities)])

    add_expression(score)

    hairpins = _spanners(score, dynamics.Crescendo)
    assert len(hairpins) == 1
    assert len(hairpins[0].getSpannedElements()) == 8
    assert _marks(score) == ["p", "f"], "the levels the hairpin passes are not marked"


def test_a_steady_level_prints_one_mark_through_jitter():
    score = _score([(i, 1.0, 60, 70 + (3 if i % 2 else 0)) for i in range(12)])

    add_expression(score)

    assert _marks(score) == ["mp"]
    assert not _spanners(score, dynamics.DynamicWedge)


def test_a_new_level_held_for_a_run_is_marked_where_it_starts():
    velocities = [50] * 6 + [100] * 6
    score = _score([(i, 1.0, 60, v) for i, v in enumerate(velocities)])

    add_expression(score)

    flat = score.parts[0].flatten()
    marks = [
        (d.value, d.getOffsetBySite(flat))
        for d in flat.getElementsByClass(dynamics.Dynamic)
    ]
    assert marks == [("p", 0.0), ("f", 6.0)]


def test_short_notes_get_staccato_and_fill_their_slot():
    score = _score([(i, 0.3, 60 + i, 80) for i in range(8)])

    counts = add_expression(score)

    notes = list(score.parts[0].flatten().notes)
    assert counts["staccato"] == 7, "the last note has no next onset to judge by"
    for n in notes[:-1]:
        assert [type(a).__name__ for a in n.articulations] == ["Staccato"]
        assert n.duration.quarterLength == 1.0


def test_overlapping_notes_get_one_slur_over_the_run():
    score = _score([(i, 1.2, 60 + i, 80) for i in range(6)])

    counts = add_expression(score)

    slurs = _spanners(score, spanner.Slur)
    assert counts["slurs"] == 1 and len(slurs) == 1
    assert len(slurs[0].getSpannedElements()) == 6
    lengths = [n.duration.quarterLength for n in score.parts[0].flatten().notes]
    assert lengths[:-1] == [1.0] * 5, "each slurred note ends where the next begins"


def test_a_full_note_on_the_downbeat_of_a_detached_line_gets_tenuto():
    notes = [(i, 0.6, 60 + i, 80) for i in range(8)]
    notes[4] = (4, 1.0, 64, 80)
    score = _score(notes)

    add_expression(score)

    flat = list(score.parts[0].flatten().notes)
    names = [[type(a).__name__ for a in n.articulations] for n in flat]
    assert names[4] == ["Tenuto"]
    assert all(not n for i, n in enumerate(names) if i != 4)


def test_a_part_with_its_own_dynamics_keeps_them():
    score = _score([(i, 1.0, 60, round(40 + i * 10)) for i in range(8)])
    score.parts[0].insert(0, dynamics.Dynamic("ff"))

    add_expression(score)

    assert _marks(score) == ["ff"]


def test_expression_option_defaults_on():
    assert expression_enabled(None) is True
    assert expression_enabled({}) is True
    assert expression_enabled({"expression": False}) is False
    assert expression_enabled({"expression": "off"}) is False
    assert level_for_velocity(40) == "p" and level_for_velocity(100) == "f"


class _NoDrums:
    def get_midi(self, _ref):
        return None

    def get_notation_artifact(self, _ref):
        return None


def _write_ramp_midi(path: Path) -> Path:
    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    inst = pretty_midi.Instrument(program=0)
    for i in range(8):
        velocity = round(40 + i * 60 / 7)
        # 0.25 s at 120 BPM is half a quarter: every note but the last is staccato.
        inst.notes.append(pretty_midi.Note(velocity, 60 + i, i * 0.5, i * 0.5 + 0.2))
    pm.instruments.append(inst)
    pm.write(str(path))
    return path


def _export(tmp_path: Path, monkeypatch, options) -> str:
    midi = _write_ramp_midi(tmp_path / "ramp.mid")
    registered: dict = {}

    def fake_register(_db, **kwargs):
        registered.update(kwargs)
        return {"ok": True, "path": str(kwargs["final_path"])}

    monkeypatch.setattr(notation_engine, "_register_conversion", fake_register)
    result = notation_engine._convert_with_music21(
        _NoDrums(),
        entry_id="e",
        source_path=midi,
        fmt="musicxml",
        output_path=tmp_path / "ramp.musicxml",
        source_ref=None,
        artifact_id=None,
        title="Ramp",
        options=options,
    )
    assert result["ok"], result
    return (tmp_path / "ramp.musicxml").read_text(encoding="utf-8")


def test_the_musicxml_export_of_a_midi_prints_its_expression(tmp_path, monkeypatch):
    xml = _export(tmp_path, monkeypatch, None)

    assert '<wedge type="crescendo"' in xml or 'type="crescendo"' in xml
    assert "<p />" in xml and "<f />" in xml
    assert xml.count("<staccato") == 7
    back = converter.parse(str(tmp_path / "ramp.musicxml"))
    assert [d.value for d in back.flatten().getElementsByClass(dynamics.Dynamic)] == [
        "p",
        "f",
    ]


def test_the_expression_option_turns_the_marks_off(tmp_path, monkeypatch):
    xml = _export(tmp_path, monkeypatch, {"expression": False})

    assert "crescendo" not in xml
    assert "<staccato" not in xml


_SHEET = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Flute</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <direction placement="below"><direction-type><dynamics><p/></dynamics></direction-type></direction>
      <direction placement="below"><direction-type><wedge type="crescendo"/></direction-type></direction>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
      <direction placement="below"><direction-type><wedge type="stop"/></direction-type></direction>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
    </measure>
    <measure number="2">
      <direction placement="below"><direction-type><dynamics><f/></dynamics></direction-type></direction>
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>
        <notations><articulations><staccato/></articulations></notations></note>
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>A</step><octave>5</octave></pitch><duration>2</duration><type>half</type>
        <notations><articulations><staccato/></articulations></notations></note>
    </measure>
  </part>
</score-partwise>
"""


def test_sheet_import_plays_dynamics_a_hairpin_and_staccato(tmp_path):
    sheet = tmp_path / "flute.musicxml"
    sheet.write_text(_SHEET, encoding="utf-8")

    parsed = parse_score_path(str(sheet))

    notes = parsed["tracks"][0]["notes"]
    velocities = [n["velocity"] for n in notes]
    assert velocities[0] == 48, "p"
    assert velocities[:4] == sorted(velocities[:4]) and velocities[3] > velocities[0]
    assert velocities[4:] == [96, 96, 96], "f after the hairpin"
    lengths = [n["length"] for n in notes]
    steps = parsed["steps_per_quarter"]
    assert lengths[4] < lengths[5] == steps, "staccato quarter sounds shorter"
    assert lengths[6] < 2 * steps, "staccato half sounds shorter"
    cc11 = parsed["tracks"][0]["cc11"]
    values = [p["value"] for p in cc11]
    assert values[0] == 48 and values[-1] == 96
    assert values == sorted(values)


def test_sheet_import_keeps_a_notes_own_velocity(tmp_path):
    sheet = tmp_path / "own.musicxml"
    sheet.write_text(
        _SHEET.replace(
            "<note><pitch><step>C</step>", '<note dynamics="50"><pitch><step>C</step>'
        ),
        encoding="utf-8",
    )

    notes = parse_score_path(str(sheet))["tracks"][0]["notes"]

    assert notes[0]["velocity"] == round(50 * 90 / 100), (
        "dynamics=50 is half of forte (90)"
    )
