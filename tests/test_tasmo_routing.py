"""Routing and buses survive a .tasmo save/load.

Before this, a track's `output_routing` / `send_amounts` existed on the model but
there was nowhere for a bus to live, so a project whose tracks fed buses reloaded
with every edge pointing at the master. These tests pin the schema half of that:
the `Bus` model, the project-level `buses` list, and that an old file — one with
neither key — still validates and loads with the defaults.
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.modules.project.tasmo_file import TasmoFile  # noqa: E402
from backend.modules.project.tasmo_project import (  # noqa: E402
    Bus,
    EffectChainNode,
    TasmoProject,
    Track,
)


def _project() -> TasmoProject:
    """Two tracks, one bus with an FX entry; drums out to the bus, vocal sending to it."""
    p = TasmoProject(project_name="Routing", tempo=124.0)
    p.buses.append(
        Bus(
            id="bus-1",
            name="Drum Bus",
            volume=0.7,
            mute=True,
            output_routing=None,
            effect_chain=[
                EffectChainNode(
                    node_type="builtin",
                    effect_name="reverb",
                    parameters={"mix": 0.4},
                    id="fx-1",
                )
            ],
        )
    )
    p.tracks.append(Track(id="t1", name="Drums", type="audio", output_routing="bus-1"))
    p.tracks.append(
        Track(id="t2", name="Vocal", type="audio", send_amounts={"bus-1": 0.4})
    )
    return p


def test_bus_defaults():
    b = Bus(id="b", name="B")
    assert b.volume == 1.0
    assert b.mute is False
    assert b.output_routing is None
    assert b.effect_chain == []
    assert TasmoProject(project_name="x").buses == []


def test_buses_and_track_routing_round_trip_through_a_file():
    project = _project()
    path = os.path.join(tempfile.mkdtemp(), "routing.tasmo")
    TasmoFile.save(project, path)
    loaded, _manifest = TasmoFile.load(path)

    assert len(loaded.buses) == 1
    bus = loaded.buses[0]
    assert bus.id == "bus-1"
    assert bus.name == "Drum Bus"
    assert bus.volume == 0.7
    assert bus.mute is True
    assert bus.output_routing is None
    assert [n.effect_name for n in bus.effect_chain] == ["reverb"]
    assert bus.effect_chain[0].parameters == {"mix": 0.4}
    assert bus.effect_chain[0].id == "fx-1"

    by_id = {t.id: t for t in loaded.tracks}
    assert by_id["t1"].output_routing == "bus-1"
    assert by_id["t1"].send_amounts == {}
    assert by_id["t2"].output_routing is None
    assert by_id["t2"].send_amounts == {"bus-1": 0.4}


def test_a_bus_may_feed_another_bus():
    p = TasmoProject(project_name="Nested")
    p.buses.append(Bus(id="a", name="A", output_routing="b"))
    p.buses.append(Bus(id="b", name="B"))
    dumped = p.model_dump()
    assert dumped["buses"][0]["output_routing"] == "b"
    assert TasmoProject.model_validate(dumped).buses[0].output_routing == "b"


def test_a_file_written_before_buses_existed_still_loads():
    """No `buses` key, no `output_routing`, no `send_amounts` — the pre-batch-8 shape."""
    legacy = {
        "project_name": "Old",
        "tempo": 90.0,
        "tracks": [{"id": "t1", "name": "Gtr", "type": "audio"}],
    }
    loaded = TasmoProject.model_validate(legacy)
    assert loaded.buses == []
    assert loaded.tracks[0].output_routing is None
    assert loaded.tracks[0].send_amounts == {}
