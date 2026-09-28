"""The piano roll's parts in a .tasmo, and a score's parts with their instruments.

- A roll bounced to EDIT puts each part on a clip of its own, and each clip
  carries ``roll_part`` (the roll document shared by every part's clip, the
  part's id, place and settings), so opening one clip in the roll opens every
  part. The ``Clip`` model had no such field, so pydantic dropped it and a
  reopened project opened each clip as a roll of one part.
- The records the app's own SAVE posts (tests/fixtures/
  roll_part_session_from_frontend.json, written and checked by
  frontend/src/lib/rollPartSave.test.ts) keep a part's controller changes and
  its bank select LSB through /save-session and /load.
- The sheet importer returned each part's name and notes only, so a quartet
  opened on one instrument. Each track now carries the registry instrument
  (``instrument``), its GM ``program`` and ``percussion``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.modules.project.tasmo_file import TasmoFile
from backend.modules.project.tasmo_project import Clip, TasmoProject


def _clip(cid: str, part: dict | None) -> dict:
    clip = {
        "id": cid,
        "name": cid,
        "clip_type": "midi",
        "track_id": "t1",
        "audio_file": f"audio/{cid}.wav",
        "midi_notes": [{"note": 60, "step": 0, "length": 2, "velocity": 90}],
        "total_steps": 16,
    }
    if part is not None:
        clip["roll_part"] = part
    return clip


PART = {
    "doc": "roll-1",
    "id": "part-vc",
    "order": 1,
    "name": "Violoncello",
    "program": 42,
    "bank": 0,
    "channel": None,
    "color": "#22d3ee",
    "mute": False,
    "solo": True,
    "instrument_id": "cello",
}


def test_a_roll_part_round_trips_through_the_archive(tmp_path: Path) -> None:
    project = TasmoProject.model_validate(
        {
            "project_name": "Parts",
            "tempo": 100,
            "tracks": [
                {
                    "id": "t1",
                    "name": "Violoncello",
                    "type": "audio",
                    "clips": [_clip("c1", PART)],
                }
            ],
        }
    )
    out = tmp_path / "parts.tasmo"
    TasmoFile.save(project, str(out))
    loaded, _ = TasmoFile.load(str(out))
    assert loaded.tracks[0].clips[0].roll_part == PART


# Written by frontend/src/lib/rollPartSave.test.ts from the SAVE button's own
# action (projectStore.save): the project it posted and the names of the audio
# files beside it. That test fails when the part records it posts stop matching
# this file, and reads the saved records back through the app's own reopen.
FRONTEND_PARTS = (
    Path(__file__).parent / "fixtures" / "roll_part_session_from_frontend.json"
)


def test_the_apps_part_records_keep_their_controllers_and_bank_lsb(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The part records the app really sends (a violin part with its sustain
    pedal, volume, pan and expression changes on the roll's 960 PPQ clock and
    an XG bank LSB, and a cello part with neither) go through /save-session
    and /load and come back exactly as sent, so a reopened clip still renders
    and exports them."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.modules.project import media_access
    from backend.modules.project import router as project_router
    from backend.modules.project.router import router as project_api

    # A save through the router writes the recent list and the /clip-audio allowlist: both stay in tmp_path.
    monkeypatch.setattr(media_access, "_ROOTS_STATE", tmp_path / "media_roots.json")
    monkeypatch.setattr(media_access, "_session_roots", [])
    monkeypatch.setattr(project_router, "_RECENT_PATH", tmp_path / "recent.json")
    monkeypatch.setattr(project_router, "_recent_files", [])
    monkeypatch.setattr(project_router, "_recent_seen", None)

    fixture = json.loads(FRONTEND_PARTS.read_text(encoding="utf-8"))
    sent = fixture["project"]
    records = [c.get("roll_part") for t in sent["tracks"] for c in t["clips"]]
    # The fixture holds what the check is for; a fixture rewritten from a build
    # that stopped writing either field fails here.
    violin, cello = records
    assert violin["bank_lsb"] == 3
    assert [c["controller"] for c in violin["controls"]] == [7, 10, 64, 64, 11]
    assert "bank_lsb" not in cello and "controls" not in cello

    client = TestClient(FastAPI(), client=("127.0.0.1", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    out = tmp_path / "parts.tasmo"
    resp = client.post(
        "/api/project/save-session",
        data={"path": str(out)},
        files=[
            ("project", ("project.json", json.dumps(sent).encode(), "application/json"))
        ]
        + [("files", (name, b"RIFF", "audio/wav")) for name in fixture["files"]],
    )
    assert resp.status_code == 200, resp.text
    back = client.post("/api/project/load", json={"path": str(out)})
    assert back.status_code == 200, back.text
    reopened = [
        c.get("roll_part") for t in back.json()["project"]["tracks"] for c in t["clips"]
    ]
    assert reopened == records


def test_a_clip_written_before_parts_has_no_part() -> None:
    clip = Clip.model_validate(_clip("old", None))
    assert clip.roll_part is None


def _quartet(path: Path) -> Path:
    """A score of a violin, a viola, a cello and a snare drum, as MusicXML."""
    from music21 import instrument, meter, note, stream

    score = stream.Score()
    for inst, pitch in (
        (instrument.Violin(), "E5"),
        (instrument.Viola(), "C4"),
        (instrument.Violoncello(), "C3"),
        (instrument.SnareDrum(), "D4"),
    ):
        part = stream.Part()
        part.partName = inst.instrumentName
        part.insert(0, inst)
        measure = stream.Measure(number=1)
        measure.append(meter.TimeSignature("3/4"))
        for _ in range(3):
            measure.append(note.Note(pitch, quarterLength=1))
        part.append(measure)
        score.insert(0, part)
    out = path / "quartet.musicxml"
    score.write("musicxml", fp=str(out))
    return out


def test_each_score_part_carries_its_instrument(tmp_path: Path) -> None:
    from backend.modules.sheetimport.parser import parse_score_path

    result = parse_score_path(str(_quartet(tmp_path)))
    tracks = result["tracks"]
    assert [t["instrument"] for t in tracks] == [
        "violin",
        "viola",
        "cello",
        "snare-drum",
    ]
    assert [t["program"] for t in tracks[:3]] == [40, 41, 42]
    assert [t["percussion"] for t in tracks] == [False, False, False, True]
    assert all(len(t["notes"]) == 3 for t in tracks)
