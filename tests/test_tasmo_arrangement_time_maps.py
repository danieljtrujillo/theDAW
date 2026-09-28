"""The EDIT arrangement's tempo map and meter map through a .tasmo file.

The frontend writes the project's "tempo_map" ([{beat, bpm, curve?,
fermata?}]) and "meter_map" ([{bar, meter: {num, den, groups}}]) beside
"tempo" (the start tempo) and "time_signature" (bar 1's meter). The file must
hand both maps back unchanged, and a file written before them must still load
with both keys None so the reader falls back to tempo and time_signature.
"""

import json

TEMPO_MAP = [
    {"beat": 0, "bpm": 96},
    {"beat": 16, "bpm": 96, "curve": "linear"},
    {"beat": 30, "bpm": 72},
    {"beat": 40, "bpm": 132},
    {"beat": 44, "bpm": 132, "fermata": {"beats": 2, "stretch": 3}},
]
METER_MAP = [
    {"bar": 0, "meter": {"num": 4, "den": 4, "groups": []}},
    {"bar": 4, "meter": {"num": 7, "den": 8, "groups": [3, 2, 2]}},
    {"bar": 8, "meter": {"num": 5, "den": 4, "groups": []}},
]


def _payload(**extra):
    return {
        "project_name": "Symphony",
        "tempo": 96.0,
        "time_signature": [4, 4],
        "tracks": [],
        **extra,
    }


def test_arrangement_maps_survive_a_tasmo_round_trip(tmp_path):
    from backend.modules.project.tasmo_file import TasmoFile
    from backend.modules.project.tasmo_project import TasmoProject

    project = TasmoProject.model_validate(
        json.loads(json.dumps(_payload(tempo_map=TEMPO_MAP, meter_map=METER_MAP)))
    )
    path = tmp_path / "symphony.tasmo"
    TasmoFile.save(project, str(path))
    loaded, _ = TasmoFile.load(str(path))
    assert loaded.tempo_map == TEMPO_MAP
    assert loaded.meter_map == METER_MAP
    dumped = json.loads(json.dumps(loaded.model_dump()))
    assert dumped["tempo_map"][4]["fermata"] == {"beats": 2, "stretch": 3}
    assert dumped["meter_map"][1]["meter"]["groups"] == [3, 2, 2]
    assert dumped["tempo"] == 96.0
    assert dumped["time_signature"] == [4, 4]


def test_a_file_written_before_the_maps_loads_with_none(tmp_path):
    from backend.modules.project.tasmo_file import TasmoFile
    from backend.modules.project.tasmo_project import TasmoProject

    project = TasmoProject.model_validate(_payload(time_signature=[7, 8]))
    path = tmp_path / "legacy.tasmo"
    TasmoFile.save(project, str(path))
    loaded, _ = TasmoFile.load(str(path))
    assert loaded.tempo_map is None
    assert loaded.meter_map is None
    assert loaded.time_signature == [7, 8]
