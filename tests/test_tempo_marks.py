"""An engraved sheet prints its metronome mark as a whole number.

A beat-tracked drum stem declares the tempo the tracker measured
(129.1992446150832 BPM on "Everything is Chrome in the Future"), and each hit's
quarter-note offset is worked out at that tempo. The sheet prints
``quarter = 129``. The direction's ``<sound tempo>`` keeps the measured tempo,
and every reader of the sheet (note chart, sheet import, a MusicXML re-export)
still times it at the measured tempo, so nothing drifts off the audio.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

import pretty_midi
import pytest

from backend.modules.library.db import LibraryDB
from backend.modules.notation.arrangers.score_arrange import STYLES
from backend.modules.notation.engine import (
    convert_score,
    midi_to_arrangement,
    midi_to_musicxml,
    stage_parts,
)
from backend.modules.notation.exporters.notechart import build_notechart
from backend.modules.sheetimport.parser import parse_score_path

# The tempo the Chrome drum MIDI declares: 464399 microseconds per quarter.
MEASURED_BPM = 60_000_000 / 464_399


def _write_kit(path: Path) -> None:
    """Four bars of kick and snare with a closed hat on every beat."""
    pm = pretty_midi.PrettyMIDI(initial_tempo=MEASURED_BPM)
    kit = pretty_midi.Instrument(program=0, is_drum=True, name="Drums")
    beat = 60.0 / MEASURED_BPM
    for i in range(16):
        start = i * beat
        kick_or_snare = 36 if i % 2 == 0 else 38
        kit.notes.append(pretty_midi.Note(100, kick_or_snare, start, start + 0.1))
        kit.notes.append(pretty_midi.Note(90, 42, start, start + 0.1))
    pm.instruments.append(kit)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


def _write_chords(path: Path) -> None:
    """Four half-note triads, so every arrangement style has notes to set."""
    pm = pretty_midi.PrettyMIDI(initial_tempo=MEASURED_BPM)
    inst = pretty_midi.Instrument(program=0, name="Keys")
    half = 120.0 / MEASURED_BPM
    triads = [[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67]]
    for i, triad in enumerate(triads):
        start = i * half
        for pitch in triad:
            inst.notes.append(pretty_midi.Note(100, pitch, start, start + half))
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


def _declared_bpm(path: Path) -> float:
    """The tempo a written MIDI declares (whole microseconds per quarter)."""
    _times, tempi = pretty_midi.PrettyMIDI(str(path)).get_tempo_changes()
    return float(tempi[0])


def _marks(path: Path) -> list[tuple[str, str]]:
    """``(<per-minute> text, <sound tempo>)`` for every metronome direction."""
    marks: list[tuple[str, str]] = []
    for direction in ET.parse(str(path)).getroot().iter("direction"):
        printed = direction.findtext("direction-type/metronome/per-minute")
        if printed is None:
            continue
        sound = direction.find("sound")
        marks.append((printed.strip(), "" if sound is None else sound.get("tempo", "")))
    return marks


def _db(tmp_path: Path) -> LibraryDB:
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    return db


def _arrange(tmp_path: Path, db: LibraryDB, style: str) -> Path:
    drums = tmp_path / "midi" / "drums.mid"
    keys = tmp_path / "midi" / "piano.mid"
    _write_kit(drums)
    _write_chords(keys)
    result = midi_to_arrangement(
        db,
        entry_id="track",
        sources=[drums, keys] if style == "band-score" else [keys],
        style=style,
        output_path=tmp_path / "notation" / f"song__{style}.musicxml",
        title="Song",
    )
    assert result["ok"] is True, result
    return Path(result["path"])


def test_band_score_prints_a_whole_number_and_sounds_the_measured_tempo(
    tmp_path: Path,
):
    sheet = _arrange(tmp_path, _db(tmp_path), "band-score")
    bpm = _declared_bpm(tmp_path / "midi" / "drums.mid")
    assert bpm != round(bpm)

    marks = _marks(sheet)
    assert marks, "the band score lost its metronome mark"
    for printed, sounding in marks:
        assert printed == "129"
        assert float(sounding) == pytest.approx(bpm, abs=1e-9)


@pytest.mark.parametrize("style", STYLES)
def test_no_arrangement_prints_a_fractional_mark(tmp_path: Path, style: str):
    sheet = _arrange(tmp_path, _db(tmp_path), style)
    for printed, _sounding in _marks(sheet):
        assert printed.isdigit(), (style, printed)


@pytest.mark.parametrize("kind", ["drums", "keys"])
def test_midi_to_musicxml_prints_a_whole_number(tmp_path: Path, kind: str):
    midi = tmp_path / "midi" / f"{kind}.mid"
    (_write_kit if kind == "drums" else _write_chords)(midi)
    bpm = _declared_bpm(midi)

    result = midi_to_musicxml(
        _db(tmp_path),
        entry_id="track",
        midi_path=midi,
        output_path=tmp_path / "notation" / f"{kind}.musicxml",
        title="Song",
    )
    assert result["ok"] is True, result

    marks = _marks(Path(result["path"]))
    assert marks
    for printed, sounding in marks:
        assert printed == "129"
        # music21 reads a MIDI tempo to 0.01 BPM; the percussion arranger
        # reads it exactly.
        assert float(sounding) == pytest.approx(bpm, abs=0.005)


def test_a_midi_staged_for_engraving_prints_a_whole_number(tmp_path: Path):
    keys = tmp_path / "midi" / "piano.mid"
    _write_chords(keys)
    bpm = _declared_bpm(keys)

    staged = stage_parts(
        keys, [0], "Song", output_path=tmp_path / "notation" / "song__piano.pdf"
    )
    try:
        marks = _marks(staged.path)
    finally:
        staged.path.unlink(missing_ok=True)
    assert marks
    for printed, sounding in marks:
        assert printed == "129"
        assert float(sounding) == pytest.approx(bpm, abs=0.005)


def test_reading_the_sheet_back_keeps_the_measured_tempo(tmp_path: Path):
    db = _db(tmp_path)
    sheet = _arrange(tmp_path, db, "band-score")
    bpm = _declared_bpm(tmp_path / "midi" / "drums.mid")

    chart = build_notechart(sheet, title="Song", artist="GANTASMO", entry_id="track")
    # The chart stores six decimals.
    assert chart["tempoMap"][0]["bpm"] == pytest.approx(bpm, abs=1e-6)

    imported = parse_score_path(str(sheet))
    assert imported["bpm"] == pytest.approx(bpm, abs=5e-4)

    exported = convert_score(
        db,
        entry_id="track",
        source_path=sheet,
        fmt="musicxml",
        output_path=tmp_path / "export" / "song.musicxml",
        title="Song",
    )
    assert exported["ok"] is True, exported
    marks = _marks(Path(exported["path"]))
    assert marks
    for printed, sounding in marks:
        assert printed == "129"
        assert float(sounding) == pytest.approx(bpm, abs=1e-9)
