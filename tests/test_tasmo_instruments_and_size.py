"""A .tasmo keeps every part's instrument, folder and tempo, and a large
arrangement saves at all.

Three defects, each replayed in the order the app hits it:

- The ``Track`` and ``Clip`` models had no ``instrument_program``,
  ``rendered_program``, ``source_bpm``, ``parent_track_id`` or ``is_folder``,
  so pydantic dropped whatever the frontend sent and a reopened project put
  every part on the default instrument, at the project tempo, at the root.
  An audio clip's beat-matched ``bpm`` and ``library_entry_id`` were dropped
  the same way.
- ``/save-session`` read the project JSON as a multipart TEXT field, which
  Starlette holds to 1 MB, so a project of about 9,000 notes failed with "Part
  exceeded maximum size" before the handler ran. It also accepted at most 1000
  file parts (one per clip and per take).
- ``TasmoFile.save`` opened the destination for writing first, so a save that
  failed part way left the user's project truncated.
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import msgpack
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.project import media_access
from backend.modules.project import router as project_router
from backend.modules.project.router import router as project_api
from backend.modules.project.tasmo_file import TasmoFile
from backend.modules.project.tasmo_project import Clip, TasmoProject, Track

MB = 1024 * 1024


@pytest.fixture(autouse=True)
def _isolated_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep the recent list and the /clip-audio allowlist in ``tmp_path``: a
    save through the router writes both."""
    monkeypatch.setattr(media_access, "_ROOTS_STATE", tmp_path / "media_roots.json")
    monkeypatch.setattr(media_access, "_session_roots", [])
    monkeypatch.setattr(project_router, "_RECENT_PATH", tmp_path / "recent.json")
    monkeypatch.setattr(project_router, "_recent_files", [])
    monkeypatch.setattr(project_router, "_recent_seen", None)


def _client() -> TestClient:
    """This machine's own UI: a loopback peer, same-origin."""
    client = TestClient(FastAPI(), client=("127.0.0.1", 51000))
    client.app.include_router(project_api, prefix="/api/project")
    return client


def _note(i: int) -> dict:
    """A roll note as the frontend writes it: steps, ticks at 960 PPQ, and on
    every seventh note a channel and expression."""
    n = {
        "note": 36 + i % 60,
        "step": i / 4,
        "length": 0.25,
        "velocity": 100,
        "tick": i * 60,
        "ticks": 60,
    }
    if i % 7 == 0:
        n["channel"] = 1 + i % 16
        n["expr"] = {"pressure": 0.5, "timbre": 0.25, "pitch_bend": -0.5}
    return n


def _project(notes: list[dict], *, clips: int = 1) -> dict:
    """The payload captureEditorSession builds: a folder, a string part inside
    it on its own program, and its clips with their own program and tempo."""
    return {
        "project_name": "Symphony",
        "tempo": 120,
        "tracks": [
            {
                "id": "f1",
                "name": "Strings",
                "type": "audio",
                "is_folder": True,
                "collapsed": True,
                "clips": [],
            },
            {
                "id": "t1",
                "name": "Violins",
                "type": "audio",
                "instrument_program": 40,
                "parent_track_id": "f1",
                "is_folder": False,
                "collapsed": False,
                "clips": [
                    {
                        "id": f"c{k}",
                        "name": f"phrase {k}",
                        "clip_type": "midi",
                        "track_id": "t1",
                        "audio_file": f"audio/c{k}.wav",
                        "midi_notes": notes if k == 0 else None,
                        "total_steps": 16,
                        "instrument_program": 42,
                        "rendered_program": 42,
                        "source_bpm": 90.5,
                    }
                    for k in range(clips)
                ],
            },
        ],
    }


def _load(client: TestClient, path: Path) -> dict:
    resp = client.post("/api/project/load", json={"path": str(path)})
    assert resp.status_code == 200, resp.text
    return resp.json()["project"]


# ---------------------------------------------------------------------------
# Instruments, tempo and folders on the models
# ---------------------------------------------------------------------------


def test_instruments_tempo_and_folders_round_trip_through_the_archive(
    tmp_path: Path,
) -> None:
    project = TasmoProject.model_validate(_project([_note(0)]))
    out = tmp_path / "song.tasmo"
    TasmoFile.save(project, str(out))
    loaded, _ = TasmoFile.load(str(out))

    folder, violins = loaded.tracks
    assert folder.is_folder is True
    assert folder.collapsed is True
    assert violins.instrument_program == 40
    assert violins.parent_track_id == "f1"
    assert violins.is_folder is False
    clip = violins.clips[0]
    assert clip.instrument_program == 42
    assert clip.rendered_program == 42
    assert clip.source_bpm == 90.5
    # The saved note keeps its ticks, channel and expression.
    assert clip.midi_notes[0]["channel"] == 1
    assert clip.midi_notes[0]["expr"] == {
        "pressure": 0.5,
        "timbre": 0.25,
        "pitch_bend": -0.5,
    }
    assert clip.midi_notes[0]["ticks"] == 60


def test_a_file_written_before_these_fields_still_opens() -> None:
    """Every new field is defaulted, so an older .tasmo validates and loads
    flat, on the global instrument, at the project tempo."""
    track = Track.model_validate(
        {"id": "t", "name": "Piano", "type": "audio", "clips": []}
    )
    assert track.instrument_program is None
    assert track.is_percussion is False
    assert track.synth_reverb_send is None
    assert track.parent_track_id is None
    assert track.is_folder is False
    assert track.collapsed is False
    clip = Clip.model_validate(
        {"id": "c", "name": "riff", "clip_type": "midi", "track_id": "t"}
    )
    assert clip.instrument_program is None
    assert clip.rendered_program is None
    assert clip.rendered_percussion is False
    assert clip.source_bpm is None
    assert clip.bpm is None
    assert clip.library_entry_id is None
    assert clip.roll_notes is None
    project = TasmoProject.model_validate({"project_name": "old"})
    assert project.roll_voice is None


def test_a_track_reverb_send_is_kept() -> None:
    """The symphony template's CC 91 of 0 is a value, not an absence."""
    track = Track.model_validate(
        {"id": "t", "name": "Violin I", "type": "midi", "synth_reverb_send": 0}
    )
    assert track.synth_reverb_send == 0
    assert track.model_dump()["synth_reverb_send"] == 0


def test_the_roll_voice_round_trips_through_the_archive(tmp_path: Path) -> None:
    """The piano roll's own voice (the Vocal2MIDI panel's Roll voice) was not
    part of the model, so pydantic dropped it and a reopened project's roll
    played on the picker's program."""
    project = TasmoProject.model_validate(
        {**_project([_note(0)]), "roll_voice": {"program": 48}}
    )
    out = tmp_path / "voice.tasmo"
    TasmoFile.save(project, str(out))
    loaded, _ = TasmoFile.load(str(out))
    assert loaded.roll_voice is not None
    assert loaded.roll_voice.program == 48
    picker = TasmoProject.model_validate({"roll_voice": {"program": None}})
    assert picker.roll_voice is not None
    assert picker.roll_voice.program is None


def test_a_hand_edited_roll_voice_opens_the_project_on_the_picker(
    tmp_path: Path,
) -> None:
    """A roll_voice program that is not a whole GM number failed TasmoProject
    validation, so one damaged setting refused the whole file. It now reads as
    None (follow the picker), the reading the frontend gives it."""
    tracks = len(_project([_note(0)])["tracks"])
    for bad in (40.5, 200, -1, "strings", True):
        project = TasmoProject.model_validate(
            {**_project([_note(0)]), "roll_voice": {"program": bad}}
        )
        assert project.roll_voice is not None
        assert project.roll_voice.program is None, bad
        assert len(project.tracks) == tracks
    whole = TasmoProject.model_validate({"roll_voice": {"program": 48.0}})
    assert whole.roll_voice is not None
    assert whole.roll_voice.program == 48

    # A file on disk whose project record was edited by hand still opens.
    out = tmp_path / "hand.tasmo"
    TasmoFile.save(
        TasmoProject.model_validate(
            {**_project([_note(0)]), "roll_voice": {"program": 71}}
        ),
        str(out),
    )
    with zipfile.ZipFile(out) as zf:
        entries = {name: zf.read(name) for name in zf.namelist()}
    record = msgpack.unpackb(entries["project.msgpack"], raw=False)
    record["roll_voice"] = {"program": 40.5}
    entries["project.msgpack"] = msgpack.packb(record, use_bin_type=True)
    with zipfile.ZipFile(out, "w") as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    loaded, _ = TasmoFile.load(str(out))
    assert loaded.roll_voice is not None
    assert loaded.roll_voice.program is None
    assert len(loaded.tracks) == tracks


# ---------------------------------------------------------------------------
# The payload the frontend really sends
# ---------------------------------------------------------------------------

# Written by frontend/src/lib/projectImport.instruments.test.ts from the SAVE
# button's own action (projectStore.save): the project part it posted and the
# names of the audio files beside it. That test fails when the payload stops
# matching this file, so the two suites check the same bytes.
FRONTEND_PAYLOAD = (
    Path(__file__).parent / "fixtures" / "tasmo_session_from_frontend.json"
)

# What a reopen must hand back exactly as the frontend wrote it.
_KEPT_TRACK = (
    "instrument_program",
    "is_percussion",
    "parent_track_id",
    "is_folder",
    "collapsed",
)
_KEPT_CLIP = (
    "instrument_program",
    "rendered_program",
    "rendered_percussion",
    "render_stale",
    "render_auto",
    "instrument_bank",
    "rendered_bank",
    "source_bpm",
    "bpm",
    "library_entry_id",
    "midi_notes",
    "roll_notes",
    "lanes",
    "total_steps",
    "meter_map",
    "pickup_steps",
    "tempo_map",
    "roll_markers",
)


def test_the_frontend_payload_saves_and_reopens_with_every_field(
    tmp_path: Path,
) -> None:
    """The models ignore keys they do not know, so a key the frontend renamed
    was dropped without an error, and a value of the wrong type (a program of
    40.5) refused the whole save with 400. Both are checked on the payload the
    app sends: every key is one the models keep, the save goes through, and a
    reopen returns each instrument, folder, tempo and note list unchanged."""
    fixture = json.loads(FRONTEND_PAYLOAD.read_text(encoding="utf-8"))
    sent = fixture["project"]
    assert set(sent) <= set(TasmoProject.model_fields), set(sent) - set(
        TasmoProject.model_fields
    )
    for track in sent["tracks"]:
        assert set(track) <= set(Track.model_fields), set(track) - set(
            Track.model_fields
        )
        for clip in track["clips"]:
            assert set(clip) <= set(Clip.model_fields), set(clip) - set(
                Clip.model_fields
            )

    out = tmp_path / "fixture.tasmo"
    client = _client()
    resp = client.post(
        "/api/project/save-session",
        data={"path": str(out)},
        files=[
            ("project", ("project.json", json.dumps(sent).encode(), "application/json"))
        ]
        + [("files", (name, b"RIFF", "audio/wav")) for name in fixture["files"]],
    )
    assert resp.status_code == 200, resp.text

    back = _load(client, out)
    assert len(back["tracks"]) == len(sent["tracks"])
    for t_sent, t_back in zip(sent["tracks"], back["tracks"], strict=True):
        for key in _KEPT_TRACK:
            assert t_back[key] == t_sent[key], (t_sent["id"], key)
        assert len(t_back["clips"]) == len(t_sent["clips"])
        for c_sent, c_back in zip(t_sent["clips"], t_back["clips"], strict=True):
            for key in _KEPT_CLIP:
                if key in c_sent:
                    assert c_back[key] == c_sent[key], (c_sent["id"], key)
    # The fixture covers what the check is for: a folder, a program, an audio
    # clip's tempo tag, beat-matched tempo and library entry, a roll-only clip
    # and a note with channel and expression.
    clips = {c["id"]: c for t in back["tracks"] for c in t["clips"]}
    assert back["tracks"][0]["is_folder"] is True
    assert back["tracks"][1]["instrument_program"] == 40
    assert clips["tagged"]["source_bpm"] == 92
    assert clips["tagged"]["bpm"] == 124
    assert clips["tagged"]["library_entry_id"] == "lib-7"
    # A looping lane keeps its roll notes and writes the notes it plays as
    # midi_notes, the list a build older than roll_notes reads.
    assert [n["step"] for n in clips["looped"]["midi_notes"]] == [0, 4, 8, 12]
    assert clips["looped"]["roll_notes"][0]["lane"] == 1
    assert clips["plain"]["midi_notes"][1]["channel"] == 3
    # A roll part's Bank on its clip, and the bank its audio was rendered in.
    assert clips["plain"]["instrument_bank"] == 1
    assert clips["plain"]["rendered_bank"] == 1
    assert clips["looped"]["instrument_bank"] is None
    assert clips["plain"]["midi_notes"][1]["expr"]["pitch_bend"] == -0.5
    # A roll clip's tempo map: a ramp and a fermata on the tempo it ramps to.
    assert clips["plain"]["tempo_map"][1] == {"beat": 2, "bpm": 90, "curve": "linear"}
    assert clips["plain"]["tempo_map"][3]["fermata"] == {"beats": 1, "stretch": 2}
    assert clips["looped"]["tempo_map"] is None
    # A roll clip's ruler markers: a movement, a FORM section, the user's own.
    assert clips["plain"]["roll_markers"] == [
        {"id": "mk-1", "tick": 0, "name": "I. Allegro", "kind": "movement"},
        {
            "id": "form-0",
            "tick": 960,
            "name": "Intro",
            "kind": "section",
            "origin": "form",
        },
        {"id": "mk-2", "tick": 3840, "name": "B", "kind": "section"},
    ]
    assert clips["looped"]["roll_markers"] is None
    # A render saved out of date reopens stale, and one EDIT made only so a
    # part could be heard keeps that mark, so each part renders or drops it.
    assert clips["looped"]["render_stale"] is True
    assert clips["edited"]["render_auto"] is True
    assert clips["plain"]["render_stale"] is False
    # A drum track keeps its flag and its kit, and its clip's kit render.
    drums = next(t for t in back["tracks"] if t["id"] == "d1")
    assert drums["is_percussion"] is True
    assert drums["instrument_program"] == 25
    assert clips["kit"]["rendered_percussion"] is True
    # The piano roll's own voice rides at the top level.
    assert back["roll_voice"] == sent["roll_voice"] == {"program": None}
    # So do the arrangement's tempo map and meter map.
    assert back["tempo_map"] == sent["tempo_map"] == [{"beat": 0, "bpm": 120}]
    assert back["meter_map"] == sent["meter_map"]
    assert back["meter_map"][0]["meter"] == {"num": 4, "den": 4, "groups": []}


# ---------------------------------------------------------------------------
# /save-session: the project as a file part, of any size
# ---------------------------------------------------------------------------


def test_a_100k_note_project_saves_as_a_file_part_and_reopens(tmp_path: Path) -> None:
    """The frontend posts the project JSON as a Blob (a file part). 100,000
    notes is several megabytes, far past the 1 MB a text field may hold."""
    notes = [_note(i) for i in range(100_000)]
    body = json.dumps(_project(notes)).encode()
    assert len(body) > 5 * MB
    out = tmp_path / "big.tasmo"
    client = _client()

    resp = client.post(
        "/api/project/save-session",
        data={"path": str(out)},
        files=[
            ("project", ("project.json", body, "application/json")),
            ("files", ("c0.wav", b"RIFF-audio", "audio/wav")),
        ],
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["path"] == str(out)

    project = _load(client, out)
    clip = project["tracks"][1]["clips"][0]
    assert len(clip["midi_notes"]) == 100_000
    assert clip["midi_notes"][-1] == notes[-1]
    assert clip["midi_notes"][7]["expr"]["pitch_bend"] == -0.5
    assert clip["instrument_program"] == 42
    assert project["tracks"][1]["parent_track_id"] == "f1"
    with zipfile.ZipFile(out) as zf:
        assert zf.read("audio/c0.wav") == b"RIFF-audio"


def test_the_same_project_as_a_text_field_is_what_failed(tmp_path: Path) -> None:
    """The shape every save before this sent: the JSON as a plain field. Past
    1 MB the form parser refuses it, which is the failure the file part
    removes. A small text field is still read, for a caller that sends one."""
    client = _client()
    big = json.dumps(_project([_note(i) for i in range(20_000)]))
    assert len(big) > MB
    resp = client.post(
        "/api/project/save-session",
        data={"project": big, "path": str(tmp_path / "big.tasmo")},
    )
    assert resp.status_code == 400
    assert not (tmp_path / "big.tasmo").exists()

    small = tmp_path / "small.tasmo"
    resp = client.post(
        "/api/project/save-session",
        data={"project": json.dumps(_project([_note(0)])), "path": str(small)},
    )
    assert resp.status_code == 200, resp.text
    assert _load(client, small)["tracks"][1]["clips"][0]["source_bpm"] == 90.5


def test_more_than_a_thousand_clip_uploads_save(tmp_path: Path) -> None:
    """One file part per clip and per take: an arrangement of 1,200 clips ran
    into Starlette's default of 1000 file parts ("Too many files")."""
    out = tmp_path / "many.tasmo"
    project = _project([_note(0)], clips=1_200)
    resp = _client().post(
        "/api/project/save-session",
        data={"path": str(out)},
        files=[("project", ("project.json", json.dumps(project), "application/json"))]
        + [("files", (f"c{k}.wav", b"x", "audio/wav")) for k in range(1_200)],
    )
    assert resp.status_code == 200, resp.text
    with zipfile.ZipFile(out) as zf:
        assert sum(n.startswith("audio/") for n in zf.namelist()) == 1_200


def test_a_missing_or_broken_project_part_is_refused(tmp_path: Path) -> None:
    client = _client()
    out = tmp_path / "x.tasmo"
    resp = client.post("/api/project/save-session", data={"path": str(out)})
    assert resp.status_code == 422
    resp = client.post(
        "/api/project/save-session",
        files=[("project", ("project.json", b"{}", "application/json"))],
    )
    assert resp.status_code == 422
    resp = client.post(
        "/api/project/save-session",
        data={"path": str(out)},
        files=[("project", ("project.json", b"{not json", "application/json"))],
    )
    assert resp.status_code == 400
    assert not out.exists()


# ---------------------------------------------------------------------------
# A failed save leaves the file that was there
# ---------------------------------------------------------------------------


class _Unwritable:
    """An upload value zipfile cannot write, so the save fails part way,
    after the manifest and project are already in the archive."""


def test_a_save_that_fails_part_way_leaves_the_previous_file(tmp_path: Path) -> None:
    out = tmp_path / "song.tasmo"
    first = TasmoProject.model_validate(_project([_note(0)]))
    TasmoFile.save(first, str(out))
    before = out.read_bytes()

    second = TasmoProject.model_validate(_project([_note(1), _note(2)]))
    with pytest.raises(TypeError):
        TasmoFile.save(
            second,
            str(out),
            audio_files={"ok.wav": b"RIFF", "bad.wav": _Unwritable()},
        )
    assert out.read_bytes() == before
    loaded, _ = TasmoFile.load(str(out))
    assert loaded.tracks[1].clips[0].midi_notes == [_note(0)]
    # No temp file is left beside it.
    assert sorted(p.name for p in tmp_path.iterdir() if p.suffix == ".tmp") == []
