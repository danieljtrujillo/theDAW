"""A bus keeps its sends, and a track or a bus its sidechain keys, in a .tasmo.

A track already wrote its output and its sends; a bus wrote only its output,
and no strip wrote the sidechain keys it feeds, so a project reopened with
every bus send and every sidechain gone. ``Bus.send_amounts`` and
``sidechain_keys`` on ``Track`` and ``Bus`` carry them. A file written before
them loads a bus with its output and nothing else.
"""

from __future__ import annotations

import os
import tempfile

from backend.modules.project.tasmo_file import TasmoFile
from backend.modules.project.tasmo_project import (
    Bus,
    SidechainKey,
    TasmoProject,
    Track,
)


def _save_and_load(project: TasmoProject) -> TasmoProject:
    path = os.path.join(tempfile.mkdtemp(), "edges.tasmo")
    TasmoFile.save(project, path)
    loaded, _manifest = TasmoFile.load(path)
    return loaded


def test_bus_sends_and_sidechain_keys_survive_a_save() -> None:
    project = TasmoProject(project_name="Routing")
    project.tracks.append(
        Track(
            id="kick",
            name="Kick",
            type="audio",
            output_routing="drums",
            sidechain_keys=[SidechainKey(target="verb", entry_id="fx-gate")],
        )
    )
    project.tracks.append(Track(id="bass", name="Bass", type="audio"))
    project.buses.append(
        Bus(
            id="drums",
            name="Drums",
            send_amounts={"verb": 0.3},
            sidechain_keys=[SidechainKey(target="bass", entry_id="fx-comp")],
        )
    )
    project.buses.append(Bus(id="verb", name="Verb"))

    loaded = _save_and_load(project)

    kick = loaded.tracks[0]
    assert [(k.target, k.entry_id) for k in kick.sidechain_keys] == [
        ("verb", "fx-gate")
    ]
    drums = loaded.buses[0]
    assert drums.send_amounts == {"verb": 0.3}
    assert [(k.target, k.entry_id) for k in drums.sidechain_keys] == [
        ("bass", "fx-comp")
    ]
    assert loaded.buses[1].send_amounts == {}
    assert loaded.buses[1].sidechain_keys == []


def test_a_file_written_before_bus_edges_were_saved_still_loads() -> None:
    legacy = {
        "project_name": "Old",
        "tracks": [{"id": "t1", "name": "Gtr", "type": "audio"}],
        "buses": [{"id": "b1", "name": "B"}],
    }
    project = TasmoProject.model_validate(legacy)
    assert project.tracks[0].sidechain_keys == []
    assert project.buses[0].send_amounts == {}
    assert project.buses[0].sidechain_keys == []


def test_a_half_written_sidechain_key_still_validates() -> None:
    """Storage stays tolerant; the app's reader drops a key that names nothing."""
    track = Track.model_validate(
        {"id": "t", "name": "T", "type": "audio", "sidechain_keys": [{}]}
    )
    assert [(k.target, k.entry_id) for k in track.sidechain_keys] == [("", "")]
