"""MIDI parts with no rendered audio, and the marks on a kept render, through a
.tasmo file.

A piano-roll clip in EDIT plays live on EDIT's synths and holds rendered audio
only as an optional cache, so SAVE writes a MIDI part that holds none with
``audio_file`` None and its notes. The file must keep that part as it was
written (no audio, its notes and instrument) beside an audio clip whose
embedded file is relinked on load, and a part saved with its render must still
come back with that render.

The first two tests guard backend behaviour that predates optional renders
(``Clip.audio_file`` was already optional). The route tests replay the request
SAVE sends (``POST /api/project/save-session``: parts with ``audio_file`` None
and no file, a part holding a render with its file) and read it back through
``POST /api/project/load``. They also carry the two marks a kept render has:
``render_stale`` (the render was out of date when saved, so the part reopens
stale and EDIT renders it again) and ``render_auto`` (EDIT made it only
because the part could not play live, so it is dropped once the part plays
live). Without the two fields on ``Clip``, the model drops both keys and a
stale render reopens as current.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.project import media_access
from backend.modules.project import router as project_router
from backend.modules.project.router import router as project_api

MIDI_NOTES = [
    {"note": 67, "step": 0, "length": 4, "velocity": 90},
    {"note": 71, "step": 4, "length": 4, "velocity": 90},
]


def _project(live_part: dict, audio_clip: dict):
    from backend.modules.project.tasmo_project import TasmoProject

    return TasmoProject.model_validate(
        json.loads(
            json.dumps(
                {
                    "project_name": "Symphony",
                    "tempo": 96.0,
                    "time_signature": [4, 4],
                    "tracks": [
                        {
                            "id": "vn",
                            "name": "Violin I",
                            "type": "audio",
                            "instrument_program": 40,
                            "clips": [live_part],
                        },
                        {
                            "id": "dr",
                            "name": "Drums",
                            "type": "audio",
                            "clips": [audio_clip],
                        },
                    ],
                }
            )
        )
    )


def _live_part(**extra):
    return {
        "id": "m1",
        "name": "Violin I",
        "clip_type": "midi",
        "track_id": "vn",
        "start_time": 0.0,
        "end_time": 2.5,
        "audio_file": None,
        "midi_notes": MIDI_NOTES,
        "instrument_program": 40,
        "rendered_program": None,
        **extra,
    }


def _audio_clip():
    return {
        "id": "a1",
        "name": "Drums",
        "clip_type": "audio",
        "track_id": "dr",
        "start_time": 0.0,
        "end_time": 1.0,
        "audio_file": "audio/a1.wav",
    }


def test_a_live_midi_part_saves_no_audio_and_loads_as_written(tmp_path):
    from backend.modules.project.tasmo_file import TasmoFile

    project = _project(_live_part(), _audio_clip())
    path = tmp_path / "symphony.tasmo"
    TasmoFile.save(project, str(path), audio_files={"a1.wav": b"RIFF-drums"})
    loaded, manifest = TasmoFile.load(str(path), media_dir=str(tmp_path / "media"))
    assert manifest["audio_mode"] == "embedded"
    part = loaded.tracks[0].clips[0]
    assert part.audio_file is None, "a part with no render has no audio to relink"
    assert part.midi_notes == MIDI_NOTES
    assert part.instrument_program == 40
    assert loaded.tracks[0].instrument_program == 40
    drums = loaded.tracks[1].clips[0]
    assert drums.audio_file is not None and drums.audio_file.endswith("a1.wav")
    assert (tmp_path / "media" / "a1.wav").read_bytes() == b"RIFF-drums"


def test_a_part_saved_with_its_render_keeps_it(tmp_path):
    from backend.modules.project.tasmo_file import TasmoFile

    project = _project(
        _live_part(audio_file="audio/m1.wav", rendered_program=40), _audio_clip()
    )
    path = tmp_path / "rendered.tasmo"
    TasmoFile.save(
        project,
        str(path),
        audio_files={"a1.wav": b"RIFF-drums", "m1.wav": b"RIFF-violin"},
    )
    loaded, _ = TasmoFile.load(str(path), media_dir=str(tmp_path / "media"))
    part = loaded.tracks[0].clips[0]
    assert part.audio_file is not None and part.audio_file.endswith("m1.wav")
    assert (tmp_path / "media" / "m1.wav").read_bytes() == b"RIFF-violin"
    assert part.rendered_program == 40
    assert part.midi_notes == MIDI_NOTES


# ---------------------------------------------------------------------------
# Through the routes SAVE and OPEN use
# ---------------------------------------------------------------------------


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """The project router as this machine's own UI reaches it (a loopback peer),
    with the recent list and the /clip-audio allowlist in ``tmp_path``."""
    monkeypatch.setattr(media_access, "_ROOTS_STATE", tmp_path / "media_roots.json")
    monkeypatch.setattr(media_access, "_session_roots", [])
    monkeypatch.setattr(project_router, "_RECENT_PATH", tmp_path / "recent.json")
    monkeypatch.setattr(project_router, "_recent_files", [])
    monkeypatch.setattr(project_router, "_recent_seen", None)
    app = FastAPI()
    app.include_router(project_api, prefix="/api/project")
    return TestClient(app, client=("127.0.0.1", 51000))


def _score_payload() -> dict:
    """What captureEditorSession writes for a score of three parts: a violin
    that plays live (no audio), a viola holding a render saved out of date, and
    a part with no instrument holding a render EDIT made so it could be heard."""
    return {
        "project_name": "Symphony",
        "tempo": 96,
        "tracks": [
            {
                "id": "vn",
                "name": "Violin I",
                "type": "audio",
                "instrument_program": 40,
                "clips": [
                    _live_part(render_stale=False, render_auto=False),
                    {
                        **_live_part(),
                        "id": "va",
                        "name": "Viola",
                        "audio_file": "audio/va.wav",
                        "instrument_program": 41,
                        "rendered_program": 41,
                        "render_stale": True,
                        "render_auto": False,
                    },
                ],
            },
            {
                "id": "bare",
                "name": "Sketch",
                "type": "audio",
                "clips": [
                    {
                        **_live_part(),
                        "id": "hum",
                        "name": "Sketch",
                        "track_id": "bare",
                        "audio_file": "audio/hum.wav",
                        "instrument_program": None,
                        "render_stale": False,
                        "render_auto": True,
                    }
                ],
            },
        ],
    }


def _save(client: TestClient, path: Path, project: dict, files: list[str]):
    return client.post(
        "/api/project/save-session",
        data={"path": str(path)},
        files=[
            (
                "project",
                ("project.json", json.dumps(project).encode(), "application/json"),
            )
        ]
        + [("files", (name, b"RIFF" + name.encode(), "audio/wav")) for name in files],
    )


def _load(client: TestClient, path: Path) -> dict:
    resp = client.post("/api/project/load", json={"path": str(path)})
    assert resp.status_code == 200, resp.text
    return resp.json()["project"]


def test_save_session_keeps_live_parts_and_the_marks_on_kept_renders(
    client: TestClient, tmp_path: Path
) -> None:
    out = tmp_path / "score.tasmo"
    resp = _save(client, out, _score_payload(), ["va.wav", "hum.wav"])
    assert resp.status_code == 200, resp.text

    back = _load(client, out)
    clips = {c["id"]: c for t in back["tracks"] for c in t["clips"]}
    violin, viola, hum = clips["m1"], clips["va"], clips["hum"]
    assert violin["audio_file"] is None, "a live part saves and reopens with no audio"
    assert violin["midi_notes"] == MIDI_NOTES
    assert violin["instrument_program"] == 40
    assert violin["render_stale"] is False and violin["render_auto"] is False
    assert viola["audio_file"] and viola["audio_file"].endswith("va.wav")
    assert viola["render_stale"] is True, "a render saved out of date reopens stale"
    assert viola["render_auto"] is False
    assert viola["midi_notes"] == MIDI_NOTES
    assert hum["audio_file"] and hum["audio_file"].endswith("hum.wav")
    assert hum["render_auto"] is True, "a render made to be heard keeps its mark"
    assert hum["instrument_program"] is None


def test_a_payload_without_the_marks_reopens_its_renders_current_and_kept(
    client: TestClient, tmp_path: Path
) -> None:
    project = _score_payload()
    for track in project["tracks"]:
        for clip in track["clips"]:
            clip.pop("render_stale", None)
            clip.pop("render_auto", None)
    out = tmp_path / "older.tasmo"
    resp = _save(client, out, project, ["va.wav", "hum.wav"])
    assert resp.status_code == 200, resp.text
    back = _load(client, out)
    for track in back["tracks"]:
        for clip in track["clips"]:
            assert clip["render_stale"] is False, clip["id"]
            assert clip["render_auto"] is False, clip["id"]
