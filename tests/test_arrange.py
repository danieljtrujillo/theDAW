"""Tests for the rule-based score arrangers.

music21 is a core dependency, so these run the real arrange → MusicXML path
end-to-end against synthetic polyphonic MIDIs and assert the artifact, part
counts, and valid MusicXML output.
"""

from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import pretty_midi
import pytest  # type: ignore[import]

from backend.modules.library.db import LibraryDB
from backend.modules.notation.arrangers.percussion import (
    DRUM_STAFF,
    build_percussion_part,
    is_drum_midi,
)
from backend.modules.notation.arrangers.score_arrange import (
    _CLEF_WINDOWS,
    arrange,
    fold_into_window,
)
from backend.modules.notation.engine import midi_to_arrangement


def _write_poly_midi(path: Path) -> None:
    """A four-beat phrase of low+high dyads so reductions split across staves."""
    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    inst = pretty_midi.Instrument(program=0)
    lows = [48, 50, 52, 53]
    highs = [72, 74, 76, 77]
    for i in range(4):
        start = i * 0.5
        inst.notes.append(pretty_midi.Note(100, lows[i], start, start + 0.5))
        inst.notes.append(pretty_midi.Note(100, highs[i], start, start + 0.5))
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


def _write_line_midi(path: Path, pitches: list[int]) -> None:
    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    inst = pretty_midi.Instrument(program=0)
    for i, pitch in enumerate(pitches):
        start = i * 0.5
        inst.notes.append(pretty_midi.Note(100, pitch, start, start + 0.5))
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


def _write_triad_midi(path: Path) -> None:
    """Two whole-note triads (C major then F major) for clean chord symbols."""
    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    inst = pretty_midi.Instrument(program=0)
    for beat, triad in enumerate([[60, 64, 67], [65, 69, 72]]):
        start = beat * 1.0
        for pitch in triad:
            inst.notes.append(pretty_midi.Note(100, pitch, start, start + 1.0))
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


def _read_musicxml(path: Path) -> str:
    return Path(path).read_text(encoding="utf-8", errors="ignore").lower()


def test_piano_reduction_splits_into_two_staves(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    midi = tmp_path / "midi" / "poly.mid"
    _write_poly_midi(midi)

    result = midi_to_arrangement(
        db,
        entry_id="track",
        sources=[midi],
        style="piano-reduction",
        output_path=tmp_path / "notation" / "poly__piano.musicxml",
        source_ref="poly_mid",
        artifact_id="poly__piano__musicxml",
    )

    assert result["ok"] is True, result
    assert result["stats"]["parts"] == 2
    assert "score-partwise" in _read_musicxml(Path(result["path"]))

    artifacts = db.list_notation_artifacts("track", kind="musicxml")
    assert len(artifacts) == 1
    assert artifacts[0]["engine"] == "music21-arrange"

    related = db.list_relations(from_id="poly_mid")
    assert any(r["kind"] == "arranged_as_notation" for r in related)


def test_lead_sheet_produces_single_part(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    midi = tmp_path / "poly.mid"
    _write_poly_midi(midi)

    result = midi_to_arrangement(
        db,
        entry_id="track",
        sources=[midi],
        style="lead-sheet",
        output_path=tmp_path / "notation" / "poly__lead.musicxml",
        source_ref="poly_mid",
    )
    assert result["ok"] is True, result
    assert result["stats"]["parts"] == 1
    assert "score-partwise" in _read_musicxml(Path(result["path"]))


def test_lead_sheet_emits_chord_symbols_for_triads(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    midi = tmp_path / "triads.mid"
    _write_triad_midi(midi)

    result = midi_to_arrangement(
        db,
        entry_id="track",
        sources=[midi],
        style="lead-sheet",
        output_path=tmp_path / "notation" / "triads__lead.musicxml",
        source_ref="triads_mid",
    )
    assert result["ok"] is True, result
    xml = _read_musicxml(Path(result["path"]))
    assert "score-partwise" in xml
    # At least one identifiable chord symbol (<harmony>) was written.
    assert "<harmony" in xml


def test_simplified_keeps_top_line(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    midi = tmp_path / "poly.mid"
    _write_poly_midi(midi)

    result = midi_to_arrangement(
        db,
        entry_id="track",
        sources=[midi],
        style="simplified",
        output_path=tmp_path / "notation" / "poly__simple.musicxml",
        source_ref="poly_mid",
    )
    assert result["ok"] is True, result
    assert result["stats"]["parts"] == 1
    # Skyline keeps the four high notes, one per beat.
    assert result["stats"]["notes"] == 4


def test_band_score_one_part_per_stem(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    midi_a = tmp_path / "midi" / "stem_a.mid"
    midi_b = tmp_path / "midi" / "stem_b.mid"
    _write_line_midi(midi_a, [60, 62, 64, 65])
    _write_line_midi(midi_b, [36, 38, 40, 41])

    result = midi_to_arrangement(
        db,
        entry_id="track",
        sources=[midi_a, midi_b],
        style="band-score",
        output_path=tmp_path / "notation" / "band.musicxml",
        source_ref="stem_a_mid",
    )
    assert result["ok"] is True, result
    assert result["stats"]["parts"] == 2
    xml = _read_musicxml(Path(result["path"]))
    assert "score-partwise" in xml
    # A complete time signature must be present, or OSMD fails to render with
    # "Cannot read properties of undefined (reading 'denominator')".
    assert "<beat-type>" in xml


def test_arrange_rejects_unknown_style(tmp_path: Path):
    midi = tmp_path / "poly.mid"
    _write_poly_midi(midi)
    result = arrange([midi], "orchestral-mega-suite")
    assert result["ok"] is False
    assert "unknown arrangement style" in result["error"]


def test_arrange_missing_source(tmp_path: Path):
    result = arrange([tmp_path / "nope.mid"], "simplified")
    assert result["ok"] is False
    assert "not found" in result["error"]


# --------------------------------------------------------------------------
# Band-score register / stem filtering / percussion (overflow fix + drums D2)
# --------------------------------------------------------------------------

_STEP_SEMITONES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def _write_drum_midi(path: Path, hits: list[tuple[float, int]] | None = None) -> None:
    """A General-MIDI drum-kit file (``is_drum=True``): kick on every beat,
    closed hat on every eighth, snare on 2 and 4, one bar at 120 BPM."""
    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    inst = pretty_midi.Instrument(program=0, is_drum=True, name="Drums")
    if hits is None:
        hits = []
        for beat in range(4):
            t = beat * 0.5
            hits.append((t, 36))
            hits.append((t, 42))
            hits.append((t + 0.25, 42))
            if beat in (1, 3):
                hits.append((t, 38))
    for start, pitch in hits:
        inst.notes.append(pretty_midi.Note(100, pitch, start, start + 0.1))
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


def _write_chord_midi(path: Path, chords: list[list[int]]) -> None:
    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    inst = pretty_midi.Instrument(program=0)
    for i, pitches in enumerate(chords):
        start = i * 1.0
        for pitch in pitches:
            inst.notes.append(pretty_midi.Note(100, pitch, start, start + 1.0))
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


def _write_score(score, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    written = score.write("musicxml", fp=str(path))
    return Path(written) if written else path


def _xml_parts(path: Path) -> dict[str, ET.Element]:
    """part-name -> <part> element of a score-partwise file."""
    root = ET.parse(path).getroot()
    names: dict[str, str] = {}
    for sp in root.iter("score-part"):
        names[sp.get("id", "")] = (sp.findtext("part-name") or "").strip()
    return {names.get(p.get("id", ""), p.get("id", "")): p for p in root.iter("part")}


def _clef_sign(part: ET.Element) -> str:
    sign = part.find(".//clef/sign")
    return (sign.text or "").strip() if sign is not None else ""


def _pitched_midis(part: ET.Element) -> list[int]:
    out: list[int] = []
    for pitch in part.iter("pitch"):
        step = (pitch.findtext("step") or "C").strip()
        octave = int(pitch.findtext("octave") or "4")
        alter = int(float(pitch.findtext("alter") or "0"))
        out.append(_STEP_SEMITONES[step] + alter + (octave + 1) * 12)
    return out


def _chord_groups(part: ET.Element) -> list[list[int]]:
    """Groups of simultaneous pitched notes (a <note> without <chord/> starts
    a new group)."""
    groups: list[list[int]] = []
    for note in part.iter("note"):
        pitch = note.find("pitch")
        if pitch is None:
            continue
        midi = _pitched_midis(note)[0]
        if note.find("chord") is not None and groups:
            groups[-1].append(midi)
        else:
            groups.append([midi])
    return groups


def test_fold_into_window_keeps_pitch_class():
    for low, high in _CLEF_WINDOWS.values():
        for midi in (0, 24, 40, 60, 88, 105, 127):
            folded = fold_into_window(midi, low, high)
            assert low <= folded <= high
            assert folded % 12 == midi % 12
    # Already inside: untouched.
    assert fold_into_window(60, 53, 88) == 60


def test_band_score_skips_full_when_stems_present(tmp_path: Path):
    full = tmp_path / "midi" / "full.mid"
    bass = tmp_path / "midi" / "bass.mid"
    guitar = tmp_path / "midi" / "guitar.mid"
    _write_line_midi(full, [36, 60, 64, 72])
    _write_line_midi(bass, [36, 38, 40, 41])
    _write_line_midi(guitar, [67, 69, 71, 72])

    result = arrange([full, bass, guitar], "band-score")
    assert result["ok"] is True, result
    assert result["stats"]["parts"] == 2
    assert "full" in result["stats"]["skipped"]
    assert "full" in result["stats"]["skip_reasons"]
    assert set(result["stats"]["clefs"]) == {"bass", "guitar"}

    # A lone full.mid is never filtered away.
    alone = arrange([full], "band-score")
    assert alone["ok"] is True, alone
    assert alone["stats"]["parts"] == 1
    assert alone["stats"]["skipped"] == []


def test_band_score_skips_pitched_drum_transcription(tmp_path: Path):
    """A stem NAMED drums that carries pitched basic-pitch output (no kit data)
    is omitted rather than chordified onto a staff."""
    drums = tmp_path / "midi" / "drums.mid"
    bass = tmp_path / "midi" / "bass.mid"
    _write_line_midi(drums, [24, 55, 79, 88])  # five-octave garbage
    _write_line_midi(bass, [36, 38, 40, 41])
    assert is_drum_midi(drums) is False

    result = arrange([drums, bass], "band-score")
    assert result["ok"] is True, result
    assert result["stats"]["parts"] == 1
    assert "drums" in result["stats"]["skipped"]
    assert list(result["stats"]["clefs"]) == ["bass"]
    assert result["stats"]["clefs"]["bass"] == "F"


def test_band_score_drums_become_percussion_staff(tmp_path: Path):
    drums = tmp_path / "midi" / "drums.mid"
    bass = tmp_path / "midi" / "bass.mid"
    _write_drum_midi(drums)
    _write_line_midi(bass, [36, 38, 40, 41])
    assert is_drum_midi(drums) is True

    result = arrange([drums, bass], "band-score")
    assert result["ok"] is True, result
    assert result["stats"]["parts"] == 2
    assert result["stats"]["skipped"] == []
    assert result["stats"]["clefs"]["drums"] == "percussion"
    assert result["stats"]["clefs"]["bass"] == "F"

    path = _write_score(result["score"], tmp_path / "notation" / "band.musicxml")
    xml = path.read_text(encoding="utf-8", errors="ignore")
    assert "<sign>percussion</sign>" in xml
    assert "<unpitched>" in xml
    # music21 writes <notehead parentheses="no">x</notehead>; match the value.
    assert re.search(r"<notehead[^>]*>x</notehead>", xml)
    parts = _xml_parts(path)
    drum_part = parts["drums"]
    assert _clef_sign(drum_part) == "percussion"
    # Hi-hat (42) sits on G5 with an x head; kick (36) on F4 with a normal head.
    hat_step, hat_oct, _ = DRUM_STAFF[42]
    kick_step, kick_oct, _ = DRUM_STAFF[36]
    displays = {
        (u.findtext("display-step"), int(u.findtext("display-octave") or 0))
        for u in drum_part.iter("unpitched")
    }
    assert (hat_step, hat_oct) in displays
    assert (kick_step, kick_oct) in displays
    assert not list(drum_part.iter("pitch"))
    # Simultaneous kick + hat were merged into a percussion chord.
    assert any(n.find("chord") is not None for n in drum_part.iter("note"))
    # A complete time signature must be present for OSMD.
    assert "<beat-type>" in xml


def test_band_score_lone_drum_midi_is_percussion(tmp_path: Path):
    drums = tmp_path / "midi" / "kit.mid"
    _write_drum_midi(drums)
    result = arrange([drums], "band-score")
    assert result["ok"] is True, result
    assert result["stats"]["parts"] == 1
    assert list(result["stats"]["clefs"].values()) == ["percussion"]
    assert result["stats"]["notes"] > 0


def test_build_percussion_part_quantises_and_merges(tmp_path: Path):
    drums = tmp_path / "kit.mid"
    # Kick + open hat together at t=0, crash alone at t=1.0 (beat 3).
    _write_drum_midi(drums, [(0.0, 36), (0.0, 46), (1.0, 49)])
    part = build_percussion_part(drums, title="Kit")
    from music21 import clef, percussion  # type: ignore[import]

    assert part.partName == "Kit"
    assert part.recurse().getElementsByClass(clef.PercussionClef)
    chords = list(part.recurse().getElementsByClass(percussion.PercussionChord))
    assert len(chords) == 1
    assert sorted(n.notehead for n in chords[0].notes) == ["circle-x", "normal"]
    hits = list(part.flatten().notes)
    assert len(hits) == 2
    assert [float(h.offset) for h in hits] == [0.0, 2.0]
    # 0.1 s hits quantise to a sixteenth (the 0.25 QL floor); gaps become rests.
    assert all(float(h.duration.quarterLength) == 0.25 for h in hits)


def test_band_score_clef_by_register(tmp_path: Path):
    low = tmp_path / "midi" / "low.mid"
    high = tmp_path / "midi" / "high.mid"
    _write_line_midi(low, [36, 38, 40, 43, 45])
    _write_line_midi(high, [67, 69, 71, 74, 79])

    result = arrange([low, high], "band-score")
    assert result["ok"] is True, result
    assert result["stats"]["clefs"] == {"low": "F", "high": "G"}
    path = _write_score(result["score"], tmp_path / "notation" / "clefs.musicxml")
    parts = _xml_parts(path)
    assert _clef_sign(parts["low"]) == "F"
    assert _clef_sign(parts["high"]) == "G"


def test_band_score_folds_outliers_into_window(tmp_path: Path):
    wide = tmp_path / "midi" / "wide.mid"
    other = tmp_path / "midi" / "other.mid"
    _write_line_midi(wide, [72, 24, 105, 76])  # median 74 -> treble
    _write_line_midi(other, [60, 62, 64, 65])

    result = arrange([wide, other], "band-score")
    assert result["ok"] is True, result
    assert result["stats"]["clefs"]["wide"] == "G"
    assert result["stats"]["folded_notes"] == 2
    path = _write_score(result["score"], tmp_path / "notation" / "fold.musicxml")
    midis = _pitched_midis(_xml_parts(path)["wide"])
    assert len(midis) == 4  # sonority count unchanged
    low, high = _CLEF_WINDOWS["G"]
    assert all(low <= m <= high for m in midis)
    assert sorted(m % 12 for m in midis) == sorted(p % 12 for p in [72, 24, 105, 76])
    assert 60 in midis  # 24 (C1) landed on C4


def test_band_score_caps_chord_size(tmp_path: Path):
    cluster = tmp_path / "midi" / "cluster.mid"
    other = tmp_path / "midi" / "other.mid"
    nine = [48, 50, 52, 53, 55, 57, 59, 60, 62]
    _write_chord_midi(cluster, [nine, nine])
    _write_line_midi(other, [60, 62, 64, 65])

    result = arrange([cluster, other], "band-score")
    assert result["ok"] is True, result
    path = _write_score(result["score"], tmp_path / "notation" / "cap.musicxml")
    groups = _chord_groups(_xml_parts(path)["cluster"])
    assert groups, "expected chord groups"
    for group in groups:
        assert len(group) <= 4
        assert min(group) == 48  # lowest retained
        assert max(group) == 62  # top kept


def test_band_score_stats_survive_midi_to_arrangement(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    full = tmp_path / "midi" / "full.mid"
    bass = tmp_path / "midi" / "bass.mid"
    _write_line_midi(full, [36, 60, 64, 72])
    _write_line_midi(bass, [36, 38, 40, 41])

    result = midi_to_arrangement(
        db,
        entry_id="track",
        sources=[full, bass],
        style="band-score",
        output_path=tmp_path / "notation" / "band.musicxml",
        source_ref="full_mid",
    )
    assert result["ok"] is True, result
    assert result["stats"]["skipped"] == ["full"]
    artifacts = db.list_notation_artifacts("track", kind="musicxml")
    meta = artifacts[0]["metadata_json"]
    if isinstance(meta, str):
        meta = json.loads(meta)
    assert meta["stats"]["skipped"] == ["full"]


_REAL_MIDI_DIR = (
    Path(__file__).resolve().parents[1]
    / "data"
    / "generations"
    / "c9609a4d0c68405bb1c18f2f332061e5"
    / "midi"
)


@pytest.mark.skipif(
    not (_REAL_MIDI_DIR / "full.mid").is_file(),
    reason="real band-score regression data not present",
)
def test_band_score_real_entry_fits_clef_windows(tmp_path: Path):
    sources = sorted(_REAL_MIDI_DIR.glob("*.mid"))
    result = arrange(sources, "band-score")
    assert result["ok"] is True, result
    assert result["stats"]["parts"] <= 5
    assert "full" in result["stats"]["skipped"]
    path = _write_score(result["score"], tmp_path / "notation" / "real.musicxml")
    for name, part in _xml_parts(path).items():
        sign = _clef_sign(part)
        if sign == "percussion":
            continue
        assert sign in _CLEF_WINDOWS, (name, sign)
        low, high = _CLEF_WINDOWS[sign]
        midis = _pitched_midis(part)
        assert midis, name
        assert all(low <= m <= high for m in midis), name
        assert all(len(g) <= 4 for g in _chord_groups(part)), name
