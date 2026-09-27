"""A piano-roll lane's own time (its meter map and tuplet ratio) through a .tasmo file.

The frontend writes each lane as {id, name, cycle_steps} plus "meter_map" and
"tuplet" when the lane keeps a time of its own; the file must hand both back
unchanged, and a lane written before them must still load as it was.
"""

import json


def test_lane_time_survives_a_tasmo_round_trip(tmp_path):
    from backend.modules.project.tasmo_file import TasmoFile
    from backend.modules.project.tasmo_project import TasmoProject

    lanes = [
        {"id": 0, "name": "A", "cycle_steps": None},
        {
            "id": 1,
            "name": "B",
            "cycle_steps": 16,
            "meter_map": [
                {"bar": 0, "meter": {"num": 7, "den": 8, "groups": [3, 2, 2]}}
            ],
            "tuplet": {"n": 3, "m": 2},
        },
        {"id": 2, "name": "C", "cycle_steps": None},
    ]
    payload = {
        "project_name": "Lanes",
        "tempo": 120.0,
        "tracks": [
            {
                "id": "t1",
                "name": "Roll",
                "type": "audio",
                "clips": [
                    {
                        "id": "c1",
                        "name": "roll",
                        "clip_type": "midi",
                        "track_id": "t1",
                        "midi_notes": [
                            {"note": 60, "step": 0, "length": 2, "velocity": 90}
                        ],
                        "total_steps": 32,
                        "lanes": lanes,
                    }
                ],
            }
        ],
    }
    project = TasmoProject.model_validate(json.loads(json.dumps(payload)))
    path = tmp_path / "lanes.tasmo"
    TasmoFile.save(project, str(path))
    loaded, _ = TasmoFile.load(str(path))
    clip = loaded.tracks[0].clips[0]
    assert clip.lanes == lanes
    dumped = json.loads(json.dumps(loaded.model_dump()))["tracks"][0]["clips"][0]
    assert dumped["lanes"][1]["tuplet"] == {"n": 3, "m": 2}
    assert dumped["lanes"][1]["meter_map"][0]["meter"]["groups"] == [3, 2, 2]
    # Lane C was written with neither key and comes back with neither.
    assert "tuplet" not in dumped["lanes"][2]
    assert "meter_map" not in dumped["lanes"][2]
