"""A piano-roll clip's note ticks survive a .tasmo save and load.

The roll writes each note's ``tick`` and ``ticks`` (960 to the quarter) beside
its ``step`` and ``length``, so a recorded note shorter than a 16th reopens at
its own length. The backend holds a clip's notes as plain dicts; these pin that
the two keys go through validation, the file and ``model_dump`` untouched, and
that a note written before them (step and length only) loads as it did.
"""

import os
import tempfile

from backend.modules.project.tasmo_file import TasmoFile
from backend.modules.project.tasmo_project import Clip, TasmoProject, Track

# A take at 120 BPM as the roll saves it: an 8th, a flam 38 ticks late, a 32nd.
TICKED = [
    {"note": 60, "step": 0, "length": 2, "velocity": 100, "tick": 0, "ticks": 480},
    {
        "note": 64,
        "step": 38 / 240,
        "length": 442 / 240,
        "velocity": 90,
        "tick": 38,
        "ticks": 442,
    },
    {"note": 72, "step": 4, "length": 0.5, "velocity": 70, "tick": 960, "ticks": 120},
]
LEGACY = [{"note": 60, "step": 0, "length": 2, "velocity": 100}]


def _project() -> TasmoProject:
    p = TasmoProject(project_name="Take", tempo=120.0)
    track = Track(id="t1", name="Keys", type="midi")
    track.clips.append(
        Clip(
            id="c1",
            name="MIDI take 1",
            clip_type="midi",
            track_id="t1",
            end_time=1.0,
            midi_notes=[dict(n) for n in TICKED],
            roll_notes=[dict(n) for n in TICKED],
            total_steps=7,
        )
    )
    track.clips.append(
        Clip(
            id="c2",
            name="Old clip",
            clip_type="midi",
            track_id="t1",
            end_time=1.0,
            midi_notes=[dict(n) for n in LEGACY],
            roll_notes=[dict(n) for n in LEGACY],
        )
    )
    p.tracks.append(track)
    return p


def test_note_ticks_survive_model_dump_and_validation():
    """The save route validates the JSON the roll sends, so the dumped shape is the contract."""
    dumped = _project().model_dump()
    clip = dumped["tracks"][0]["clips"][0]
    assert clip["midi_notes"] == TICKED
    assert clip["roll_notes"] == TICKED
    revalidated = TasmoProject.model_validate(dumped)
    assert revalidated.tracks[0].clips[0].roll_notes == TICKED


def test_note_ticks_round_trip_through_a_file():
    path = os.path.join(tempfile.mkdtemp(), "take.tasmo")
    TasmoFile.save(_project(), path)
    loaded, _manifest = TasmoFile.load(path)
    clips = {c.id: c for c in loaded.tracks[0].clips}
    assert clips["c1"].midi_notes == TICKED
    assert clips["c1"].roll_notes == TICKED
    # A note written before the ticks loads with step and length only.
    assert clips["c2"].midi_notes == LEGACY
    assert clips["c2"].roll_notes == LEGACY
