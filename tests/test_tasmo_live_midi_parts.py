"""MIDI parts with no rendered audio through a .tasmo file.

A piano-roll clip in EDIT plays live on EDIT's synths and holds rendered audio
only as an optional cache, so SAVE writes a MIDI part that holds none with
``audio_file`` None and its notes. The file must keep that part as it was
written (no audio, its notes and instrument) beside an audio clip whose
embedded file is relinked on load, and a part saved with its render must still
come back with that render.
"""

import json

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
