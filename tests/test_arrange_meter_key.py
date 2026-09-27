"""Every arranger style keeps the source's meter, key, tempo and dynamics.

Each style writes fresh music21 parts. These tests replay what the SCORE tab
does: a MIDI with changing odd meters (7/8, 5/8, 11/16, 7/8) in E-flat major
goes through ``midi_to_arrangement`` and the MusicXML it writes is read back
bar by bar, as a notation reader would.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

import pretty_midi
import pytest  # type: ignore[import]

from backend.modules.library.db import LibraryDB
from backend.modules.notation.arrangers.percussion import build_percussion_part
from backend.modules.notation.engine import convert_score, midi_to_arrangement

BPM = 90.0
SECONDS_PER_QUARTER = 60.0 / BPM
BARS = [(7, 8), (5, 8), (11, 16), (7, 8)]
# E-flat major: pretty_midi key number 3, three flats.
E_FLAT_MAJOR = 3
E_FLAT_FIFTHS = "-3"
# One struck chord per bar, each louder than the last.
VELOCITIES = [30, 60, 90, 120]


def _bar_starts() -> list[float]:
    """The quarter-note offset of each bar of ``BARS``."""
    starts, at = [], 0.0
    for numerator, denominator in BARS:
        starts.append(at)
        at += numerator * 4.0 / denominator
    return starts


def _write_meter_midi(
    path: Path, *, drums: bool = False, meters: bool = True, bpm: float = BPM
) -> None:
    """A bar-per-chord MIDI in ``BARS``: E-flat triads over a low E-flat, or a
    snare hit per bar for ``drums``. ``meters`` False writes no time or key
    signature (as basic-pitch writes a stem), ``bpm`` the tempo the file
    declares; every note still starts at the second its bar starts at ``BPM``.
    """
    pm = pretty_midi.PrettyMIDI(initial_tempo=bpm)
    starts = _bar_starts()
    if meters:
        for (numerator, denominator), start in zip(BARS, starts):
            pm.time_signature_changes.append(
                pretty_midi.TimeSignature(
                    numerator, denominator, start * SECONDS_PER_QUARTER
                )
            )
        if not drums:
            pm.key_signature_changes.append(pretty_midi.KeySignature(E_FLAT_MAJOR, 0.0))
    inst = pretty_midi.Instrument(program=0, is_drum=drums, name=path.stem)
    for velocity, start in zip(VELOCITIES, starts):
        on = start * SECONDS_PER_QUARTER
        off = (start + 0.5) * SECONDS_PER_QUARTER
        pitches = [38] if drums else [51, 63, 67, 70]
        for pitch in pitches:
            inst.notes.append(pretty_midi.Note(velocity, pitch, on, off))
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


def _parts(path: Path) -> list[ET.Element]:
    return list(ET.parse(path).getroot().iter("part"))


def _times(part: ET.Element) -> list[tuple[int, str]]:
    """``(measure index, "n/d")`` for every <time> in ``part``."""
    out = []
    for index, measure in enumerate(part.findall("measure")):
        for time in measure.iter("time"):
            out.append(
                (index, f"{time.findtext('beats')}/{time.findtext('beat-type')}")
            )
    return out


def _fifths(part: ET.Element) -> list[str]:
    return [fifths.text or "" for fifths in part.iter("fifths")]


def _sound_tempi(part: ET.Element) -> list[float]:
    return [float(s.get("tempo")) for s in part.iter("sound") if s.get("tempo")]


def _printed_tempi(part: ET.Element) -> list[str]:
    return [m.findtext("per-minute") or "" for m in part.iter("metronome")]


def _bar_dynamics(part: ET.Element) -> list[set[str]]:
    """The ``dynamics`` attributes of the struck notes in each bar."""
    out = []
    for measure in part.findall("measure"):
        out.append(
            {
                note.get("dynamics", "")
                for note in measure.findall("note")
                if note.find("rest") is None
            }
        )
    return out


def _expected_dynamics() -> list[set[str]]:
    # music21 writes velocity v as v / 90 * 100 (music21.volume, 90 = 100%).
    return [{f"{v / 90 * 100:.2f}"} for v in VELOCITIES]


EXPECTED_TIMES = [(i, f"{n}/{d}") for i, (n, d) in enumerate(BARS)]


def _arrange(tmp_path: Path, style: str, sources: list[Path]) -> Path:
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "song"})
    result = midi_to_arrangement(
        db,
        entry_id="song",
        sources=sources,
        style=style,
        output_path=tmp_path / "notation" / f"{style}.musicxml",
    )
    assert result["ok"] is True, result
    return Path(result["path"])


def _assert_single_source_style(tmp_path: Path, style: str, n_parts: int) -> None:
    source = tmp_path / "midi" / "odd.mid"
    _write_meter_midi(source)
    parts = _parts(_arrange(tmp_path, style, [source]))
    assert len(parts) == n_parts
    for part in parts:
        assert _times(part) == EXPECTED_TIMES
        assert _fifths(part) == [E_FLAT_FIFTHS]
        assert _sound_tempi(part) == [BPM]
    # One staff prints the tempo; the rest carry it unprinted.
    assert [_printed_tempi(part) for part in parts] == [["90"]] + [[]] * (n_parts - 1)
    # The treble staff of every style holds the struck E-flat triad of each bar.
    assert _bar_dynamics(parts[0]) == _expected_dynamics()


def test_lead_sheet_keeps_odd_meters_key_tempo_and_dynamics(tmp_path: Path):
    _assert_single_source_style(tmp_path, "lead-sheet", 1)


def test_simplified_keeps_odd_meters_key_tempo_and_dynamics(tmp_path: Path):
    _assert_single_source_style(tmp_path, "simplified", 1)


def test_piano_reduction_keeps_odd_meters_key_tempo_and_dynamics(tmp_path: Path):
    _assert_single_source_style(tmp_path, "piano-reduction", 2)
    # The left hand's low E-flat keeps its velocity too.
    parts = _parts(tmp_path / "notation" / "piano-reduction.musicxml")
    assert _bar_dynamics(parts[1]) == _expected_dynamics()


def test_band_score_bars_every_staff_by_the_drum_meter_map(tmp_path: Path):
    """A drum stem at the analysed tempo states the meter; a basic-pitch stem
    at 120 BPM states none. Every staff is barred by the one map, keyed by the
    pitched stem that states a key, and struck as loud as its notes."""
    drums = tmp_path / "midi" / "song__drums.mid"
    keys = tmp_path / "midi" / "song__keys.mid"
    other = tmp_path / "midi" / "song__other.mid"
    _write_meter_midi(drums, drums=True)
    _write_meter_midi(keys)
    _write_meter_midi(other, meters=False, bpm=120.0)
    parts = _parts(_arrange(tmp_path, "band-score", [drums, keys, other]))
    assert len(parts) == 3
    by_name = dict(zip(["drums", "keys", "other"], parts))
    for part in parts:
        assert _times(part) == EXPECTED_TIMES
        assert len(part.findall("measure")) == len(BARS)
        # The drum stem states the tempo in whole microseconds per quarter.
        assert _sound_tempi(part)[0] == pytest.approx(BPM, abs=1e-3)
        assert _bar_dynamics(part) == _expected_dynamics()
    assert _fifths(by_name["keys"]) == [E_FLAT_FIFTHS]
    assert _fifths(by_name["other"]) == [E_FLAT_FIFTHS]
    assert _printed_tempi(by_name["drums"]) == ["90"]
    assert _printed_tempi(by_name["keys"]) == []
    assert _printed_tempi(by_name["other"]) == []


def test_percussion_staff_takes_every_time_signature(tmp_path: Path):
    from music21 import meter  # type: ignore[import]

    drums = tmp_path / "kit.mid"
    _write_meter_midi(drums, drums=True)
    part = build_percussion_part(drums, title="Kit")
    flat = part.flatten()
    stated = [
        (float(ts.getOffsetBySite(flat)), ts.ratioString)
        for ts in flat.getElementsByClass(meter.TimeSignature)
    ]
    assert stated == [(start, f"{n}/{d}") for start, (n, d) in zip(_bar_starts(), BARS)]


def test_drum_sheet_keeps_each_hit_velocity(tmp_path: Path):
    """MAKE SHEET on a drum MIDI: a ghost snare and an accented kick + snare
    keep their loudness on the percussion staff."""
    drums = tmp_path / "midi" / "kit.mid"
    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    kit = pretty_midi.Instrument(program=0, is_drum=True)
    kit.notes.append(pretty_midi.Note(20, 38, 0.0, 0.1))
    kit.notes.append(pretty_midi.Note(120, 36, 0.5, 0.6))
    kit.notes.append(pretty_midi.Note(100, 38, 0.5, 0.6))
    pm.instruments.append(kit)
    drums.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(drums))
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "song"})
    result = convert_score(
        db,
        entry_id="song",
        source_path=drums,
        fmt="musicxml",
        output_path=tmp_path / "notation" / "kit.musicxml",
    )
    assert result["ok"] is True, result
    notes = [
        n
        for n in ET.parse(result["path"]).getroot().iter("note")
        if n.find("rest") is None
    ]
    # The ghost snare alone, then the kick + snare chord at their mean.
    assert [n.get("dynamics") for n in notes] == [
        f"{20 / 90 * 100:.2f}",
        f"{110 / 90 * 100:.2f}",
        f"{110 / 90 * 100:.2f}",
    ]


def test_plain_sheet_writes_the_velocity_of_a_chord(tmp_path: Path):
    """MAKE SHEET on a pitched MIDI: a chord's heads reach the sheet with the
    mean of their velocities, a lone note with its own."""
    source = tmp_path / "midi" / "chords.mid"
    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    piano = pretty_midi.Instrument(program=0)
    piano.notes.append(pretty_midi.Note(40, 60, 0.0, 0.5))
    piano.notes.append(pretty_midi.Note(110, 64, 0.0, 0.5))
    piano.notes.append(pretty_midi.Note(70, 67, 0.5, 1.0))
    pm.instruments.append(piano)
    source.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(source))
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "song"})
    result = convert_score(
        db,
        entry_id="song",
        source_path=source,
        fmt="musicxml",
        output_path=tmp_path / "notation" / "chords.musicxml",
    )
    assert result["ok"] is True, result
    notes = [
        n
        for n in ET.parse(result["path"]).getroot().iter("note")
        if n.find("rest") is None
    ]
    assert [n.get("dynamics") for n in notes] == [
        f"{75 / 90 * 100:.2f}",
        f"{75 / 90 * 100:.2f}",
        f"{70 / 90 * 100:.2f}",
    ]
