"""A clip keeps its time stretch, its warp markers and its fade shapes in a .tasmo.

The EDIT save writes ``time_stretch_rate``, ``stretch_mode``, ``warp_markers``
and ``fade_in_curve`` / ``fade_out_curve`` on each clip that has them. Pydantic
drops a key its model does not declare, so before ``Clip`` had them a
stretched clip reopened at its source's speed and every fade linear. A file
written before them loads with all of them unset.
"""

from __future__ import annotations

import os
import tempfile

from backend.modules.project.tasmo_file import TasmoFile
from backend.modules.project.tasmo_project import Clip, TasmoProject, Track


def _save_and_load(project: TasmoProject) -> TasmoProject:
    path = os.path.join(tempfile.mkdtemp(), "timing.tasmo")
    TasmoFile.save(project, path)
    loaded, _manifest = TasmoFile.load(path)
    return loaded


def test_a_clip_keeps_its_stretch_warp_and_fade_shapes() -> None:
    clip = Clip(
        id="c1",
        name="Loop",
        clip_type="audio",
        track_id="t1",
        start_time=2.0,
        end_time=6.0,
        fade_in=0.25,
        fade_out=0.5,
        time_stretch_rate=0.5,
        stretch_mode="repitch",
        warp_markers=[{"source_sec": 1.0, "target_sec": 1.5}],
        fade_in_curve="exponential",
        fade_out_curve="equal-power",
    )
    project = TasmoProject(project_name="Timing")
    project.tracks.append(Track(id="t1", name="Loop", type="audio", clips=[clip]))

    back = _save_and_load(project).tracks[0].clips[0]

    assert back.time_stretch_rate == 0.5
    assert back.stretch_mode == "repitch"
    assert back.warp_markers == [{"source_sec": 1.0, "target_sec": 1.5}]
    assert back.fade_in_curve == "exponential"
    assert back.fade_out_curve == "equal-power"


def test_a_clip_written_before_its_timing_was_saved_loads_unstretched() -> None:
    legacy = {
        "project_name": "Old",
        "tracks": [
            {
                "id": "t1",
                "name": "Gtr",
                "type": "audio",
                "clips": [
                    {"id": "c1", "name": "c", "clip_type": "audio", "track_id": "t1"}
                ],
            }
        ],
    }
    clip = TasmoProject.model_validate(legacy).tracks[0].clips[0]
    assert clip.time_stretch_rate is None
    assert clip.stretch_mode is None
    assert clip.fade_in_curve is None
    assert clip.fade_out_curve is None
