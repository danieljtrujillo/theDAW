"""A band score whose staves are given instruments from the orchestral registry.

The SCORE maker sends, for each stem MIDI, the registry instrument its staff
is written for. The staff then carries the instrument's name, abbreviation,
clef and transposition, the staves sit in score order, and each family of two
or more staves is bracketed.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

import pretty_midi
from fastapi.testclient import TestClient

from backend.modules.library.db import LibraryDB
from backend.modules.notation.arrangers.score_arrange import arrange
from backend.modules.notation.engine import midi_to_arrangement
from tests.test_notation import notation_client  # noqa: F401 - pytest fixture


def _line(path: Path, pitches: list[int], *, program: int = 0) -> Path:
    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    inst = pretty_midi.Instrument(program=program)
    for i, pitch in enumerate(pitches):
        inst.notes.append(pretty_midi.Note(100, pitch, i * 0.5, i * 0.5 + 0.5))
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))
    return path


def _stems(root: Path) -> dict[str, Path]:
    return {
        "low": _line(root / "Song__low.mid", [36, 43, 48, 43]),
        "reed": _line(root / "Song__reed.mid", [62, 64, 65, 67]),  # sounding D4..G4
        "high": _line(root / "Song__high.mid", [67, 69, 71, 72]),
        "full": _line(root / "Song__full.mid", [60, 64, 67, 72]),
    }


def _write(score, path: Path) -> ET.Element:
    path.parent.mkdir(parents=True, exist_ok=True)
    written = score.write("musicxml", fp=str(path))
    return ET.parse(Path(written) if written else path).getroot()


def _part_names(root: ET.Element) -> list[str]:
    return [sp.findtext("part-name") for sp in root.iter("score-part")]


def _first_pitch(root: ET.Element, index: int) -> tuple[str, str]:
    part = list(root.iter("part"))[index]
    p = next(part.iter("pitch"))
    return p.findtext("step"), p.findtext("octave")


def test_staves_take_registry_names_clefs_and_score_order(tmp_path: Path):
    s = _stems(tmp_path / "midi")
    result = arrange(
        [s["low"], s["reed"], s["high"], s["full"]],
        "band-score",
        instruments=["cello", "clarinet-bb", "violin", "piano"],
    )
    assert result["ok"] is True, result
    stats = result["stats"]
    # The whole-mix stem is kept: the reader gave it an instrument.
    assert stats["skipped"] == []
    assert stats["instruments"] == {
        "Clarinet in B♭": "clarinet-bb",
        "Piano": "piano",
        "Violin": "violin",
        "Violoncello": "cello",
    }
    assert stats["clefs"]["Violoncello"] == "bass"
    assert stats["clefs"]["Violin"] == "treble"
    assert stats["groups"] == 1  # violin + cello; clarinet and piano stand alone

    root = _write(result["score"], tmp_path / "out" / "band.musicxml")
    assert _part_names(root) == ["Clarinet in B♭", "Piano", "Violin", "Violoncello"]
    abbreviations = [sp.findtext("part-abbreviation") for sp in root.iter("score-part")]
    assert abbreviations == ["Cl.", "Pno.", "Vln.", "Vc."]

    # The clarinet part is written a whole step above the pitch that sounds.
    clarinet = list(root.iter("part"))[0]
    assert clarinet.findtext(".//transpose/chromatic") == "-2"
    assert _first_pitch(root, 0) == ("E", "4"), "sounding D4 is written E4"
    # The cello part reads in the bass clef and is untransposed.
    cello = list(root.iter("part"))[3]
    assert cello.findtext(".//clef/sign") == "F"
    assert cello.find(".//transpose") is None
    assert _first_pitch(root, 3) == ("C", "2")

    groups = [g for g in root.iter("part-group") if g.get("type") == "start"]
    assert len(groups) == 1
    assert groups[0].findtext("group-symbol") == "bracket"
    assert groups[0].findtext("group-name") == "Strings"


def test_two_staves_of_one_instrument_are_numbered(tmp_path: Path):
    s = _stems(tmp_path / "midi")
    result = arrange(
        [s["high"], s["reed"]],
        "band-score",
        instruments=["violin", "violin"],
    )
    assert result["ok"] is True, result
    root = _write(result["score"], tmp_path / "out" / "violins.musicxml")
    assert _part_names(root) == ["Violin 1", "Violin 2"]
    abbreviations = [sp.findtext("part-abbreviation") for sp in root.iter("score-part")]
    assert abbreviations == ["Vln. 1", "Vln. 2"]


def test_unassigned_staves_follow_in_file_order(tmp_path: Path):
    s = _stems(tmp_path / "midi")
    result = arrange(
        [s["high"], s["low"], s["reed"]],
        "band-score",
        instruments=[None, "cello", None],
    )
    assert result["ok"] is True, result
    root = _write(result["score"], tmp_path / "out" / "mixed.musicxml")
    assert _part_names(root) == ["Violoncello", "Song__high", "Song__reed"]


def test_folds_into_the_instrument_range(tmp_path: Path):
    """A stem assigned to the violin never writes a note below its G3."""
    low = _line(tmp_path / "midi" / "Song__wide.mid", [40, 45, 67, 72])
    result = arrange([low], "band-score", instruments=["violin"])
    assert result["ok"] is True, result
    pitches = [int(p.midi) for p in result["score"].flatten().pitches]
    assert min(pitches) >= 55, pitches


def test_drum_kit_on_a_pitched_drum_transcription_is_still_skipped(tmp_path: Path):
    """The maker gives the drums stem the drum kit by default. When that stem
    is basic-pitch notes with no kit data, the kit cannot be written from it,
    so the staff is left out as it was before instruments existed."""
    from backend.modules.notation.arrangers.percussion import is_drum_midi

    drums = _line(tmp_path / "midi" / "drums.mid", [24, 55, 79, 88])
    bass = _line(tmp_path / "midi" / "bass.mid", [36, 38, 40, 41])
    assert is_drum_midi(drums) is False
    result = arrange(
        [drums, bass], "band-score", instruments=["drum-kit", "electric-bass"]
    )
    assert result["ok"] is True, result
    assert result["stats"]["skipped"] == ["drums"]
    assert result["stats"]["instruments"] == {"Electric Bass": "electric-bass"}


def test_unknown_instrument_is_an_error(tmp_path: Path):
    s = _stems(tmp_path / "midi")
    result = arrange([s["high"]], "band-score", instruments=["theremin"])
    assert result["ok"] is False
    assert "unknown instrument" in result["error"]


def test_no_instruments_keeps_file_names(tmp_path: Path):
    s = _stems(tmp_path / "midi")
    result = arrange([s["low"], s["high"]], "band-score")
    assert result["ok"] is True, result
    assert "instruments" not in result["stats"]
    root = _write(result["score"], tmp_path / "out" / "plain.musicxml")
    assert _part_names(root) == ["Song__low", "Song__high"]


def test_midi_to_arrangement_writes_a_transposing_score(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    s = _stems(tmp_path / "midi")
    result = midi_to_arrangement(
        db,
        entry_id="track",
        sources=[s["reed"], s["low"]],
        style="band-score",
        output_path=tmp_path / "notation" / "band.musicxml",
        source_ref="reed_mid",
        instruments=["horn", "contrabass"],
    )
    assert result["ok"] is True, result
    root = ET.parse(result["path"]).getroot()
    assert _part_names(root) == ["Horn in F", "Contrabass"]
    parts = list(root.iter("part"))
    assert parts[0].findtext(".//transpose/chromatic") == "-7"
    assert parts[1].findtext(".//transpose/chromatic") == "0"
    assert parts[1].findtext(".//transpose/octave-change") == "-1"


def test_arrange_route_passes_instruments_by_artifact(
    notation_client: TestClient,  # noqa: F811 - pytest fixture
    tmp_path: Path,
):
    from backend.modules.library import router as library_router_module
    from tests.test_library_store import _seed_generate_entry

    _seed_generate_entry(tmp_path, "job_oi", 0)
    entry_id = "job_oi_00"
    store = library_router_module.get_store()
    entry_dir = tmp_path / "job_oi" / "00"
    s = _stems(entry_dir / "midi")
    for key in ("low", "high"):
        store.db.add_notation_artifact(
            artifact_id=f"{key}_mid", entry_id=entry_id, kind="midi", path=str(s[key])
        )

    r = notation_client.post(
        f"/api/notation/{entry_id}/arrange",
        json={
            "style": "band-score",
            "source_artifact_ids": ["low_mid", "high_mid"],
            "instruments": {"low_mid": "cello", "high_mid": "flute"},
        },
    )
    assert r.status_code == 200, r.text
    root = ET.parse(r.json()["path"]).getroot()
    assert _part_names(root) == ["Flute", "Violoncello"]

    bad = notation_client.post(
        f"/api/notation/{entry_id}/arrange",
        json={
            "style": "band-score",
            "source_artifact_ids": ["low_mid"],
            "instruments": {"low_mid": "theremin"},
        },
    )
    assert bad.status_code == 422
    stray = notation_client.post(
        f"/api/notation/{entry_id}/arrange",
        json={
            "style": "band-score",
            "source_artifact_ids": ["low_mid"],
            "instruments": {"other_mid": "cello"},
        },
    )
    assert stray.status_code == 422
