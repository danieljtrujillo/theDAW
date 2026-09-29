"""A VST3 insert on a track or a bus keeps its dialled-in sound through a .tasmo.

The save writes the state the plugin's window or live host captured
(``raw_state``) and the host that captured it (``state_host``) on the insert's
``vst_state``. Pydantic drops a key its model does not declare, so before
``VstPluginState`` had both fields every insert reopened at its defaults. A
file written before them still loads, with neither.
"""

from __future__ import annotations

import os
import tempfile

from backend.modules.project.tasmo_file import TasmoFile
from backend.modules.project.tasmo_project import (
    Bus,
    EffectChainNode,
    TasmoProject,
    Track,
    VstPluginState,
)


def _save_and_load(project: TasmoProject) -> TasmoProject:
    path = os.path.join(tempfile.mkdtemp(), "inserts.tasmo")
    TasmoFile.save(project, path)
    loaded, _manifest = TasmoFile.load(path)
    return loaded


def _vst_node(node_id: str, state: str | None, host: str | None) -> EffectChainNode:
    return EffectChainNode(
        id=node_id,
        node_type="vst3",
        effect_name="Pro-Q 3",
        parameters={"0": 0.5},
        vst_state=VstPluginState(
            plugin_path="C:/VST3/FabFilter Pro-Q 3.vst3",
            plugin_name="Pro-Q 3",
            parameters={"0": 0.5},
            raw_state=state,
            state_host=host,
        ),
    )


def test_a_vst_insert_keeps_its_state_on_a_track_and_a_bus() -> None:
    project = TasmoProject(project_name="Inserts")
    project.tracks.append(
        Track(
            id="t1",
            name="Vocal",
            type="audio",
            effect_chain=[_vst_node("fx-t1", "VFJBQ0s=", "thedaw")],
        )
    )
    project.buses.append(
        Bus(
            id="b1",
            name="Drum Bus",
            effect_chain=[_vst_node("fx-b1", "QlVT", "pedalboard")],
        )
    )

    loaded = _save_and_load(project)

    track_vst = loaded.tracks[0].effect_chain[0].vst_state
    assert track_vst is not None
    assert track_vst.raw_state == "VFJBQ0s="
    assert track_vst.state_host == "thedaw"
    bus_vst = loaded.buses[0].effect_chain[0].vst_state
    assert bus_vst is not None
    assert bus_vst.raw_state == "QlVT"
    assert bus_vst.state_host == "pedalboard"


def test_an_insert_saved_before_its_state_was_written_loads_at_its_defaults() -> None:
    legacy = {
        "project_name": "Old",
        "tracks": [
            {
                "id": "t1",
                "name": "Gtr",
                "type": "audio",
                "effect_chain": [
                    {
                        "node_type": "vst3",
                        "effect_name": "Amp",
                        "vst_state": {"plugin_path": "C:/a.vst3", "plugin_name": "Amp"},
                    }
                ],
            }
        ],
    }
    vst = TasmoProject.model_validate(legacy).tracks[0].effect_chain[0].vst_state
    assert vst is not None
    assert vst.raw_state is None
    assert vst.state_host is None
