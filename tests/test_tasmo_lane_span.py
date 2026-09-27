"""A piano-roll clip's lane spans survive a .tasmo save and load.

MATCH limits a song's polymeter lane to the bars of the meter segment it was
heard in, and the METER face's SPAN does the same by hand; the roll writes that
as ``span_start`` and ``span_end`` (steps, ``span_end`` None = the clip's end)
beside the lane's ``cycle_steps``. The backend holds lanes as plain dicts;
these pin that the two keys go through validation, the file and
``model_dump`` untouched, and that a lane written before them loads as it did.
"""

import os
import tempfile

from backend.modules.project.tasmo_file import TasmoFile
from backend.modules.project.tasmo_project import Clip, TasmoProject, Track

SPANNED = [
    {"id": 0, "name": "A", "cycle_steps": None},
    {"id": 1, "name": "Low", "cycle_steps": 20, "span_start": 58, "span_end": 114},
    {"id": 2, "name": "High", "cycle_steps": 6, "span_start": 64, "span_end": None},
]
LEGACY = [
    {"id": 0, "name": "A", "cycle_steps": None},
    {"id": 1, "name": "B", "cycle_steps": 12},
]


def _project() -> TasmoProject:
    p = TasmoProject(project_name="Spans", tempo=120.0)
    track = Track(id="t1", name="Keys", type="midi")
    for cid, lanes in (("c1", SPANNED), ("c2", LEGACY)):
        track.clips.append(
            Clip(
                id=cid,
                name=cid,
                clip_type="midi",
                track_id="t1",
                end_time=1.0,
                midi_notes=[{"note": 60, "step": 0, "length": 1, "velocity": 90}],
                lanes=[dict(lane) for lane in lanes],
                total_steps=128,
            )
        )
    p.tracks.append(track)
    return p


def test_lane_spans_survive_model_dump_and_validation():
    dumped = _project().model_dump()
    assert dumped["tracks"][0]["clips"][0]["lanes"] == SPANNED
    revalidated = TasmoProject.model_validate(dumped)
    assert revalidated.tracks[0].clips[0].lanes == SPANNED


def test_lane_spans_round_trip_through_a_file():
    path = os.path.join(tempfile.mkdtemp(), "spans.tasmo")
    TasmoFile.save(_project(), path)
    loaded, _manifest = TasmoFile.load(path)
    clips = {c.id: c for c in loaded.tracks[0].clips}
    assert clips["c1"].lanes == SPANNED
    # A lane written before spans loads with its cycle only.
    assert clips["c2"].lanes == LEGACY
