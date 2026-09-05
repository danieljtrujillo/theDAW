"""Beat Saber mapping (``exporters/beatsaber_map.py``) and level writer
(``exporters/beatsaber.py``).

Both run against the real note-chart exporter on synthetic MIDI written into
``tmp_path`` (the same fixtures ``tests/test_notechart.py`` uses), so the
mapping is tested on the document the writer really receives. Nothing here
needs model weights or ffmpeg; the one ffmpeg case is skip-gated.
"""

from __future__ import annotations

import json
import math
import struct
import wave
import zipfile
from pathlib import Path
from typing import Any

import pretty_midi  # type: ignore[import]
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.notation.exporters import beatsaber, beatsaber_map
from backend.modules.notation.exporters.beatsaber import (
    beat_time,
    build_difficulty_dat,
    build_info_dat,
    normalise_difficulties,
    write_beatsaber,
)
from backend.modules.notation.exporters.beatsaber_map import (
    BS_DEFAULTS,
    DIFFICULTIES,
    DIFFICULTY_NAMES,
    MIN_GAP,
    assign,
    is_candidate,
    notes_for_level,
)
from backend.modules.notation.exporters.notechart import build_notechart
from tests.test_notechart import _SCALE, _write_scale_midi

# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------


def _events(chart: dict[str, Any]):
    for part in chart["parts"]:
        for event in part["events"]:
            yield event


def _notes(chart: dict[str, Any]) -> list[dict[str, Any]]:
    return [e for e in _events(chart) if not e["isRest"]]


def _write_two_part_midi(path: Path, *, tempo: float = 120.0) -> None:
    """The scale in one instrument and the same scale an octave lower in a
    second one, so the chart has two parts with a clear register split."""
    pm = pretty_midi.PrettyMIDI(initial_tempo=tempo)
    high = pretty_midi.Instrument(program=0, name="Lead")
    low = pretty_midi.Instrument(program=33, name="Bass")
    for i, pitch in enumerate(_SCALE):
        start = i * 0.5
        high.notes.append(
            pretty_midi.Note(velocity=100, pitch=pitch, start=start, end=start + 0.5)
        )
        low.notes.append(
            pretty_midi.Note(
                velocity=100, pitch=pitch - 12, start=start, end=start + 0.5
            )
        )
    pm.instruments.append(high)
    pm.instruments.append(low)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


def _write_dense_midi(path: Path, *, tempo: float = 120.0, count: int = 32) -> None:
    """Sixteenth notes (125 ms apart at 120 BPM) so the per-hand gap rule has
    something to thin out."""
    pm = pretty_midi.PrettyMIDI(initial_tempo=tempo)
    inst = pretty_midi.Instrument(program=0)
    for i in range(count):
        start = i * 0.125
        inst.notes.append(
            pretty_midi.Note(
                velocity=100, pitch=60 + (i % 5), start=start, end=start + 0.125
            )
        )
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


def _write_sine_wav(path: Path, seconds: float = 1.0, sr: int = 22050) -> None:
    frames = int(seconds * sr)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(
            b"".join(
                struct.pack("<h", int(12000 * math.sin(2 * math.pi * 440 * n / sr)))
                for n in range(frames)
            )
        )


def _scale_chart(tmp_path: Path, **kwargs: Any) -> dict[str, Any]:
    midi = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi)
    return build_notechart(midi, title="t", artist="a", entry_id="e", **kwargs)


def _ids_at(chart: dict[str, Any], level: int) -> set[tuple[int, int]]:
    return {
        (part["index"], e["id"])
        for part in chart["parts"]
        for e in notes_for_level([part], level)
    }


# --------------------------------------------------------------------------
# mapping invariants
# --------------------------------------------------------------------------


def test_every_event_carries_typed_fields_in_range(tmp_path: Path):
    chart = _scale_chart(tmp_path)
    seen_candidate = False
    for event in _events(chart):
        for key in BS_DEFAULTS:
            assert key in event, key
            assert isinstance(event[key], int) and not isinstance(event[key], bool)
        assert 0 <= event["bsLine"] <= 3
        assert 0 <= event["bsLayer"] <= 2
        assert event["bsColor"] in (0, 1)
        assert 0 <= event["bsCut"] <= 8
        assert -1 <= event["bsMinDifficulty"] <= 4
        if event["isRest"]:
            assert event["bsMinDifficulty"] == -1
        elif event["bsMinDifficulty"] >= 0:
            seen_candidate = True
    assert seen_candidate
    assert chart["stats"]["beatSaberCandidates"] > 0
    assert chart["schemaVersion"] == 1


def test_is_candidate_excludes_what_can_never_be_a_block():
    base = {
        "isRest": False,
        "isGrace": False,
        "tie": "",
        "tupletBracket": "",
        "chordId": -1,
        "isChordRoot": False,
    }
    assert is_candidate(dict(base), False) is True
    assert is_candidate(dict(base, isRest=True), False) is False
    assert is_candidate(dict(base, isGrace=True), False) is False
    assert is_candidate(dict(base, tie="stop"), False) is False
    assert is_candidate(dict(base, tie="continue"), False) is False
    assert is_candidate(dict(base, tie="start"), False) is True
    assert is_candidate(dict(base, tupletBracket="irrational"), False) is False
    assert is_candidate(dict(base, chordId=3, isChordRoot=False), False) is False
    assert is_candidate(dict(base, chordId=3, isChordRoot=True), False) is True
    assert is_candidate(dict(base), True) is False


def test_difficulty_sets_are_monotone(tmp_path: Path):
    midi = tmp_path / "midi" / "dense.mid"
    _write_dense_midi(midi)
    chart = build_notechart(midi, title="t", artist="a", entry_id="e")
    for level in range(4):
        assert _ids_at(chart, level) <= _ids_at(chart, level + 1)
    # The dense pattern must actually be thinned somewhere, or the rule is dead.
    assert len(_ids_at(chart, 0)) < len(_ids_at(chart, 4))
    per = chart["stats"]["beatSaberCandidates"]
    assert len(_ids_at(chart, 4)) == per


@pytest.mark.parametrize("level", [0, 1])
def test_per_hand_gap_is_respected(tmp_path: Path, level: int):
    midi = tmp_path / "midi" / "dense.mid"
    _write_dense_midi(midi)
    chart = build_notechart(midi, title="t", artist="a", entry_id="e")
    kept = notes_for_level(chart["parts"], level)
    assert kept
    last: dict[int, float] = {}
    for event in kept:
        hand = event["bsColor"]
        if hand in last:
            assert event["onsetSecRaw"] - last[hand] >= MIN_GAP[level] - 1e-9
        last[hand] = event["onsetSecRaw"]


def test_two_parts_put_the_lower_part_on_the_red_saber(tmp_path: Path):
    midi = tmp_path / "midi" / "duo.mid"
    _write_two_part_midi(midi)
    chart = build_notechart(midi, title="t", artist="a", entry_id="e")
    assert len(chart["parts"]) == 2
    by_mean = sorted(
        chart["parts"],
        key=lambda p: (
            sum(e["midi"] for e in p["events"] if not e["isRest"])
            / max(1, len([e for e in p["events"] if not e["isRest"]]))
        ),
    )
    low, high = by_mean
    low_notes = [e for e in low["events"] if e["bsMinDifficulty"] >= 0]
    high_notes = [e for e in high["events"] if e["bsMinDifficulty"] >= 0]
    assert low_notes and high_notes
    assert {e["bsColor"] for e in low_notes} == {0}
    assert {e["bsColor"] for e in high_notes} == {1}
    # Red lives on the left half of the grid, blue on the right.
    assert {e["bsLine"] for e in low_notes} <= {0, 1}
    assert {e["bsLine"] for e in high_notes} <= {2, 3}


def test_single_part_alternates_hands_in_onset_order(tmp_path: Path):
    chart = _scale_chart(tmp_path)
    kept = [e for e in _notes(chart) if e["bsMinDifficulty"] >= 0]
    kept.sort(key=lambda e: e["onsetSecRaw"])
    assert [e["bsColor"] for e in kept] == [i % 2 for i in range(len(kept))]


def test_ascending_scale_cuts_up_after_the_first_note(tmp_path: Path):
    chart = _scale_chart(tmp_path)
    kept = [e for e in _notes(chart) if e["bsMinDifficulty"] >= 0]
    kept.sort(key=lambda e: e["onsetSecRaw"])
    first_seen: set[int] = set()
    for event in kept:
        hand = event["bsColor"]
        if hand not in first_seen:
            first_seen.add(hand)
            assert event["bsCut"] == beatsaber_map.CUT_ANY
        else:
            assert event["bsCut"] == beatsaber_map.CUT_UP


def test_layer_follows_the_staff_position():
    parts = [
        {
            "isPercussion": False,
            "events": [
                {
                    "isRest": False,
                    "isGrace": False,
                    "tie": "",
                    "tupletBracket": "",
                    "chordId": -1,
                    "isChordRoot": False,
                    "midi": 60,
                    "staffStep": step,
                    "onsetSecRaw": i * 1.0,
                    "onsetBeats": i * 2.0,
                }
                for i, step in enumerate((-2, 0, 2, 6, 7, 12))
            ],
        }
    ]
    assign(parts)
    assert [e["bsLayer"] for e in parts[0]["events"]] == [0, 0, 1, 1, 2, 2]


def test_percussion_parts_are_never_blocks(tmp_path: Path):
    midi = tmp_path / "midi" / "kit.mid"
    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    kit = pretty_midi.Instrument(program=0, is_drum=True, name="Drums")
    for i in range(8):
        kit.notes.append(
            pretty_midi.Note(velocity=100, pitch=36, start=i * 0.5, end=i * 0.5 + 0.1)
        )
    pm.instruments.append(kit)
    midi.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(midi))
    chart = build_notechart(midi, title="t", artist="a", entry_id="e")
    assert chart["parts"][0]["isPercussion"] is True
    assert {e["bsMinDifficulty"] for e in _events(chart)} == {-1}
    assert chart["stats"]["beatSaberCandidates"] == 0
    assert notes_for_level(chart["parts"], 4) == []


def test_assign_is_idempotent(tmp_path: Path):
    chart = _scale_chart(tmp_path)
    before = json.dumps(chart["parts"], sort_keys=True)
    stats = assign(chart["parts"])
    assert json.dumps(chart["parts"], sort_keys=True) == before
    assert stats["candidates"] == chart["stats"]["beatSaberCandidates"]
    assert list(stats["perDifficulty"]) == DIFFICULTY_NAMES
    counts = [stats["perDifficulty"][name] for name in DIFFICULTY_NAMES]
    assert counts == sorted(counts)


# --------------------------------------------------------------------------
# .dat writers
# --------------------------------------------------------------------------


def test_v2_difficulty_dat_times_are_beats_of_the_raw_onset(tmp_path: Path):
    performed = tmp_path / "midi" / "played.mid"
    _write_scale_midi(performed, shift=0.03)
    chart = _scale_chart(
        tmp_path, raw_midi_path=performed, raw_midi_artifact_id="played"
    )
    assert chart["quantization"]["rawIsQuantized"] is False
    bpm = 97.0
    dat = build_difficulty_dat(chart, 4, bpm=bpm, version=2)
    assert dat["_version"] == "2.0.0"
    assert dat["_events"] == [] and dat["_obstacles"] == []
    kept = notes_for_level(chart["parts"], 4)
    assert len(dat["_notes"]) == len(kept) > 0
    offset = chart["timing"]["audioOffsetSec"]
    for note, event in zip(dat["_notes"], kept):
        assert note["_time"] == round((event["onsetSecRaw"] + offset) * bpm / 60, 4)
        assert note["_lineIndex"] == event["bsLine"]
        assert note["_lineLayer"] == event["bsLayer"]
        assert note["_type"] == event["bsColor"]
        assert note["_cutDirection"] == event["bsCut"]
        assert set(note) == {
            "_time",
            "_lineIndex",
            "_lineLayer",
            "_type",
            "_cutDirection",
        }
    times = [n["_time"] for n in dat["_notes"]]
    assert times == sorted(times)
    # The raw shift is visible in the beat grid: no note sits on beat 0.
    assert times[0] > 0


def test_v3_difficulty_dat_shape(tmp_path: Path):
    chart = _scale_chart(tmp_path)
    dat = build_difficulty_dat(chart, 4, bpm=120.0, version=3)
    assert dat["version"] == "3.2.0"
    assert dat["bpmEvents"] == [{"b": 0.0, "m": 120.0}]
    for key in (
        "rotationEvents",
        "colorNotes",
        "bombNotes",
        "obstacles",
        "sliders",
        "burstSliders",
        "waypoints",
        "basicBeatmapEvents",
        "colorBoostBeatmapEvents",
        "lightColorEventBoxGroups",
        "lightRotationEventBoxGroups",
        "lightTranslationEventBoxGroups",
    ):
        assert isinstance(dat[key], list), key
    assert dat["basicEventTypesWithKeywords"] == {"d": []}
    assert dat["useNormalEventsAsCompatibleEvents"] is False
    assert dat["colorNotes"]
    for note in dat["colorNotes"]:
        assert set(note) == {"b", "x", "y", "c", "d", "a"}
        assert 0 <= note["x"] <= 3 and 0 <= note["y"] <= 2
        assert note["c"] in (0, 1) and 0 <= note["d"] <= 8 and note["a"] == 0
    v2 = build_difficulty_dat(chart, 4, bpm=120.0, version=2)
    assert [n["b"] for n in dat["colorNotes"]] == [n["_time"] for n in v2["_notes"]]


def test_difficulty_dat_respects_part_filter(tmp_path: Path):
    midi = tmp_path / "midi" / "duo.mid"
    _write_two_part_midi(midi)
    chart = build_notechart(midi, title="t", artist="a", entry_id="e")
    both = build_difficulty_dat(chart, 4, bpm=120.0, version=2)["_notes"]
    only_first = build_difficulty_dat(chart, 4, bpm=120.0, version=2, part_indices=[0])[
        "_notes"
    ]
    assert 0 < len(only_first) < len(both)
    assert len({n["_type"] for n in only_first}) == 1


def test_difficulty_dat_rejects_bad_inputs(tmp_path: Path):
    chart = _scale_chart(tmp_path)
    with pytest.raises(ValueError):
        build_difficulty_dat(chart, 1, bpm=120.0, version=4)
    with pytest.raises(ValueError):
        build_difficulty_dat(chart, 1, bpm=0.0, version=2)


def test_beat_time_arithmetic():
    assert beat_time(0.0, 120.0) == 0.0
    assert beat_time(1.0, 120.0) == 2.0
    assert beat_time(0.5, 90.0) == 0.75
    assert beat_time(1 / 3, 120.0) == 0.6667


def test_normalise_difficulties():
    assert normalise_difficulties(None) == ["Normal", "Hard"]
    assert normalise_difficulties([]) == ["Normal", "Hard"]
    assert normalise_difficulties(["bogus"]) == ["Normal", "Hard"]
    assert normalise_difficulties(["expert+", "easy", "Easy"]) == ["Easy", "ExpertPlus"]
    assert normalise_difficulties(["Expert Plus", "hard"]) == ["Hard", "ExpertPlus"]


# --------------------------------------------------------------------------
# Info.dat
# --------------------------------------------------------------------------


def test_info_dat_has_the_required_keys_and_one_beatmap_per_difficulty():
    info = build_info_dat(
        song_name="Song",
        artist="Artist",
        bpm=128.0,
        difficulties=["Hard", "Easy", "nope"],
        version=2,
        has_audio=True,
    )
    for key in (
        "_version",
        "_songName",
        "_songSubName",
        "_songAuthorName",
        "_levelAuthorName",
        "_beatsPerMinute",
        "_shuffle",
        "_shufflePeriod",
        "_previewStartTime",
        "_previewDuration",
        "_songFilename",
        "_coverImageFilename",
        "_environmentName",
        "_allDirectionsEnvironmentName",
        "_songTimeOffset",
        "_difficultyBeatmapSets",
    ):
        assert key in info, key
    assert info["_version"] == "2.0.0"
    assert info["_songName"] == "Song"
    assert info["_songAuthorName"] == "Artist"
    assert info["_beatsPerMinute"] == 128.0
    assert info["_songFilename"] == "song.ogg"
    sets = info["_difficultyBeatmapSets"]
    assert len(sets) == 1
    assert sets[0]["_beatmapCharacteristicName"] == "Standard"
    beatmaps = sets[0]["_difficultyBeatmaps"]
    assert [b["_difficulty"] for b in beatmaps] == ["Easy", "Hard"]
    ranks = {name: rank for name, rank, _ in DIFFICULTIES}
    for beatmap in beatmaps:
        name = beatmap["_difficulty"]
        assert beatmap["_beatmapFilename"] == f"{name}.dat"
        assert beatmap["_difficultyRank"] == ranks[name]
        assert beatmap["_noteJumpMovementSpeed"] > 0
        assert beatmap["_noteJumpStartBeatOffset"] == 0


# --------------------------------------------------------------------------
# zip writer
# --------------------------------------------------------------------------


def test_write_beatsaber_without_ffmpeg_ships_a_readme(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(beatsaber, "find_ffmpeg", lambda: None)
    chart = _scale_chart(tmp_path)
    audio = tmp_path / "audio.wav"
    _write_sine_wav(audio)
    zip_path = tmp_path / "notation" / "beatsaber" / "song__scale.beatsaber.zip"

    result = write_beatsaber(
        chart,
        zip_path,
        song_name="Song",
        artist="Artist",
        bpm=120.0,
        bpm_source="analysis",
        difficulties=[],
        version=2,
        audio_path=audio,
    )
    assert result["ok"] is True, result
    assert result["difficulties"] == ["Normal", "Hard"]
    assert result["song_ogg"] is False
    assert result["warning"]
    assert result["bpm"] == 120.0 and result["bpm_source"] == "analysis"
    assert result["version"] == 2
    assert result["parts"] == [p["name"] for p in chart["parts"]]
    assert set(result["note_counts"]) == {"Normal", "Hard"}
    assert result["note_counts"]["Hard"] >= result["note_counts"]["Normal"] > 0

    assert zip_path.is_file()
    folder = Path(result["folder"])
    assert folder.name == "song__scale"
    with zipfile.ZipFile(zip_path) as zf:
        assert zf.testzip() is None
        names = set(zf.namelist())
        assert names == {
            "song__scale/Info.dat",
            "song__scale/Normal.dat",
            "song__scale/Hard.dat",
            "song__scale/README.txt",
        }
        info = json.loads(zf.read("song__scale/Info.dat"))
        normal = json.loads(zf.read("song__scale/Normal.dat"))
    assert [
        b["_difficulty"]
        for b in info["_difficultyBeatmapSets"][0]["_difficultyBeatmaps"]
    ] == ["Normal", "Hard"]
    assert len(normal["_notes"]) == result["note_counts"]["Normal"]


def test_write_beatsaber_v3_and_part_filter(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(beatsaber, "find_ffmpeg", lambda: None)
    midi = tmp_path / "midi" / "duo.mid"
    _write_two_part_midi(midi)
    chart = build_notechart(midi, title="t", artist="a", entry_id="e")
    zip_path = tmp_path / "duo.beatsaber.zip"
    result = write_beatsaber(
        chart,
        zip_path,
        song_name="Duo",
        artist="a",
        bpm=120.0,
        bpm_source="chart",
        difficulties=["ExpertPlus"],
        version=3,
        audio_path=None,
        include_audio=False,
        part_indices=[1],
    )
    assert result["ok"] is True, result
    assert result["parts"] == [chart["parts"][1]["name"]]
    with zipfile.ZipFile(zip_path) as zf:
        dat = json.loads(zf.read("duo/ExpertPlus.dat"))
    assert dat["version"] == "3.2.0"
    assert len(dat["colorNotes"]) == result["note_counts"]["ExpertPlus"] > 0


def test_write_beatsaber_rejects_bad_version_and_bpm(tmp_path: Path):
    chart = _scale_chart(tmp_path)
    bad = write_beatsaber(
        chart,
        tmp_path / "x.beatsaber.zip",
        song_name="s",
        artist="a",
        bpm=120.0,
        bpm_source="chart",
        difficulties=["Normal"],
        version=4,
        audio_path=None,
    )
    assert bad["ok"] is False and "version" in bad["error"]
    bad = write_beatsaber(
        chart,
        tmp_path / "x.beatsaber.zip",
        song_name="s",
        artist="a",
        bpm=0,
        bpm_source="chart",
        difficulties=["Normal"],
        version=2,
        audio_path=None,
    )
    assert bad["ok"] is False and "bpm" in bad["error"]
    assert not (tmp_path / "x.beatsaber.zip").exists()


@pytest.mark.skipif(beatsaber.find_ffmpeg() is None, reason="ffmpeg not on PATH")
def test_write_beatsaber_encodes_song_ogg_when_ffmpeg_exists(tmp_path: Path):
    chart = _scale_chart(tmp_path)
    audio = tmp_path / "audio.wav"
    _write_sine_wav(audio, seconds=1.0)
    zip_path = tmp_path / "song.beatsaber.zip"
    result = write_beatsaber(
        chart,
        zip_path,
        song_name="Song",
        artist="Artist",
        bpm=120.0,
        bpm_source="analysis",
        difficulties=["Normal"],
        version=2,
        audio_path=audio,
    )
    assert result["ok"] is True, result
    assert result["song_ogg"] is True
    assert result["warning"] == ""
    with zipfile.ZipFile(zip_path) as zf:
        names = set(zf.namelist())
        assert "song/song.ogg" in names
        assert "song/README.txt" not in names
        assert zf.getinfo("song/song.ogg").file_size > 0


# --------------------------------------------------------------------------
# route (lands with W2-BACKEND: engine.convert_score 'beatsaber' + router options)
# --------------------------------------------------------------------------


def test_export_route_returns_a_beatsaber_artifact(tmp_path: Path, monkeypatch):
    from backend.modules.library import router as library_router_module
    from backend.modules.notation import router as notation_router_module
    from tests.test_library_store import _seed_generate_entry

    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    monkeypatch.setattr(beatsaber, "find_ffmpeg", lambda: None)

    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    app.include_router(notation_router_module.router, prefix="/api/notation")
    client = TestClient(app)

    _seed_generate_entry(tmp_path, "job_bs", 0)
    entry_id = "job_bs_00"
    store = library_router_module.get_store()
    assert store.get_entry(entry_id) is not None
    entry_dir = tmp_path / "job_bs" / "00"

    midi = entry_dir / "midi" / "scale.mid"
    _write_scale_midi(midi)
    store.db.add_notation_artifact(
        artifact_id="scale_mid",
        entry_id=entry_id,
        kind="midi",
        path=str(midi),
        engine="test",
    )

    r = client.post(
        f"/api/notation/{entry_id}/export",
        json={
            "source_artifact_id": "scale_mid",
            "format": "beatsaber",
            "options": {"difficulties": ["Normal", "Hard"], "version": 2},
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    artifact = body["artifact"]
    assert artifact["kind"] == "beatsaber"
    assert artifact["path"].endswith(".beatsaber.zip")
    meta = artifact.get("metadata_json") or artifact.get("metadata") or {}
    if isinstance(meta, str):
        meta = json.loads(meta)
    assert meta["format"] == "beatsaber"
    assert set(meta["note_counts"]) == {"Normal", "Hard"}
    assert Path(artifact["path"]).is_file()
