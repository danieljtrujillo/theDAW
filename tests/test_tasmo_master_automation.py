"""The master chains and the editor's automation lanes survive a .tasmo round trip.

A `.tasmo` could carry a track's insert chain but nothing about the MASTER bus,
and nothing about automation in the shape the editor holds it. Two different
failures came out of that: the editor does not clear the master chains on load,
so the master rack of whatever was open before stayed on the project the user
opened next (and was then saved into it), while it DOES clear the automation
lanes, so an automated fader ride was simply gone.

These pin the schema half: the `ChainEntry` / `EditorAutomationLane` models, the
three project fields, the structural check on a lane's points, and that an old
file — one with none of the three keys — still validates and loads with them as
None (which is what tells the frontend to leave the live state alone).
"""

import os
import sys
import tempfile

import pytest
from pydantic import ValidationError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.modules.project.tasmo_file import TasmoFile  # noqa: E402
from backend.modules.project.tasmo_project import (  # noqa: E402
    AutomationLaneTarget,
    ChainEntry,
    ChainVst,
    EditorAutomationLane,
    EditorAutomationPoint,
    TasmoProject,
    Track,
)


def _project() -> TasmoProject:
    """A master rack, one hosted plugin, and two lanes riding them."""
    p = TasmoProject(project_name="Mastered", tempo=124.0)
    p.tracks.append(Track(id="t1", name="Drums", type="audio"))
    p.master_fx_chain = [
        ChainEntry(id="mfx1", effect="reverb_delay", params={"decay": 0.4}),
        ChainEntry(id="mfx2", effect="eq_mid", params={"gain": 3.0}, enabled=False),
    ]
    p.master_vst_chain = [
        ChainEntry(
            id="mv1",
            effect="vst3",
            vst=ChainVst(
                plugin_path="C:/VST3/Pro-Q.vst3",
                plugin_name="Pro-Q",
                raw_state="YmFzZTY0",
            ),
            label="Pro-Q 4",
        )
    ]
    p.automation_lanes = [
        EditorAutomationLane(
            id="l1",
            target=AutomationLaneTarget(kind="trackVolume", track_id="t1"),
            points=[
                EditorAutomationPoint(t=0.0, v=0.8),
                EditorAutomationPoint(t=4.0, v=0.2, curve=0.5),
            ],
        ),
        EditorAutomationLane(
            id="l2",
            target=AutomationLaneTarget(
                kind="masterFx", entry_id="mfx1", param_key="decay"
            ),
            points=[EditorAutomationPoint(t=1.0, v=0.3)],
            enabled=False,
        ),
    ]
    return p


def test_defaults_say_the_file_is_silent_not_empty():
    """None and [] mean different things, so the default must be None.

    The frontend leaves the live master rack alone for None (a file written
    before this existed) and clears it for [] (a project that has no master FX).
    A defaulted empty list would make every old file claim the second.
    """
    empty = TasmoProject(project_name="x")
    assert empty.master_fx_chain is None
    assert empty.master_vst_chain is None
    assert empty.automation_lanes is None
    # An entry is enabled and plugin-less until the file says otherwise.
    entry = ChainEntry(id="e", effect="delay")
    assert entry.enabled is True
    assert entry.params == {}
    assert entry.vst is None
    assert entry.label is None
    # A plugin that has never had its editor opened carries no state blob.
    assert ChainVst().raw_state is None
    # A lane the user emptied but did not delete is a valid lane.
    lane = EditorAutomationLane(id="l")
    assert lane.points == []
    assert lane.enabled is True
    assert lane.target.kind == ""


def test_master_chains_and_lanes_round_trip_through_a_file():
    project = _project()
    path = os.path.join(tempfile.mkdtemp(), "master.tasmo")
    TasmoFile.save(project, path)
    loaded, _manifest = TasmoFile.load(path)

    assert loaded.master_fx_chain is not None
    assert [e.id for e in loaded.master_fx_chain] == ["mfx1", "mfx2"]
    assert loaded.master_fx_chain[0].params == {"decay": 0.4}
    assert loaded.master_fx_chain[1].enabled is False

    # The plugin's dialed-in state is the whole reason the master VST chain is
    # worth persisting; `EffectChainNode` has nowhere to put an opaque blob.
    assert loaded.master_vst_chain is not None
    assert loaded.master_vst_chain[0].vst is not None
    assert loaded.master_vst_chain[0].vst.raw_state == "YmFzZTY0"
    assert loaded.master_vst_chain[0].vst.plugin_name == "Pro-Q"
    assert loaded.master_vst_chain[0].label == "Pro-Q 4"

    assert loaded.automation_lanes is not None
    assert [lane.id for lane in loaded.automation_lanes] == ["l1", "l2"]
    first = loaded.automation_lanes[0]
    assert first.target.kind == "trackVolume"
    assert first.target.track_id == "t1"
    # The per-point curve survives: without it every reloaded segment is linear
    # and the ride the user shaped plays differently than the one they saved.
    assert first.points[0].curve is None
    assert first.points[1].curve == 0.5
    second = loaded.automation_lanes[1]
    assert second.enabled is False
    assert (second.target.entry_id, second.target.param_key) == ("mfx1", "decay")


def test_an_empty_chain_survives_a_dump_and_revalidate():
    """[] must come back as [], not as None — it is what clears the master."""
    p = TasmoProject(project_name="Bare")
    p.master_fx_chain = []
    p.master_vst_chain = []
    p.automation_lanes = []
    dumped = p.model_dump()
    assert dumped["master_fx_chain"] == []
    again = TasmoProject.model_validate(dumped)
    assert again.master_fx_chain == []
    assert again.master_vst_chain == []
    assert again.automation_lanes == []


def test_a_file_written_before_the_master_chains_were_saved_still_loads():
    """None of the three keys — the pre-batch-10 shape."""
    legacy = {
        "project_name": "Old",
        "tempo": 90.0,
        "tracks": [{"id": "t1", "name": "Gtr", "type": "audio"}],
    }
    loaded = TasmoProject.model_validate(legacy)
    assert loaded.master_fx_chain is None
    assert loaded.master_vst_chain is None
    assert loaded.automation_lanes is None
    # The flat importer `automation` list is a DIFFERENT field and is untouched.
    assert loaded.automation == []
    # And the format is unchanged: no version bump comes with these fields.
    assert loaded.format_version == 1


def test_a_lane_whose_points_do_not_ascend_is_refused():
    """The points are a curve, read by walking neighbouring pairs."""
    with pytest.raises(ValidationError) as excinfo:
        EditorAutomationLane(
            id="bad",
            points=[
                EditorAutomationPoint(t=2.0, v=0.0),
                EditorAutomationPoint(t=1.0, v=1.0),
            ],
        )
    assert "ascend" in str(excinfo.value)
    # A duplicated boundary is the same problem: a segment with no length.
    with pytest.raises(ValidationError):
        EditorAutomationLane(
            id="dup",
            points=[
                EditorAutomationPoint(t=1.0, v=0.0),
                EditorAutomationPoint(t=1.0, v=1.0),
            ],
        )


def test_a_non_finite_point_is_refused():
    """JSON has no NaN but msgpack does, and NaN compares false against
    everything — it would slip past the ascending check and sample nowhere."""
    with pytest.raises(ValidationError) as excinfo:
        EditorAutomationLane(
            id="nan", points=[EditorAutomationPoint(t=float("nan"), v=0.0)]
        )
    assert "non-finite" in str(excinfo.value)
    with pytest.raises(ValidationError):
        EditorAutomationLane(
            id="inf", points=[EditorAutomationPoint(t=0.0, v=float("inf"))]
        )
    with pytest.raises(ValidationError):
        EditorAutomationLane(
            id="curve",
            points=[EditorAutomationPoint(t=0.0, v=0.0, curve=float("nan"))],
        )


def test_a_hand_edited_lane_still_validates():
    """Storage is tolerant about WHAT a lane targets; the app is the strict
    half, dropping a lane that resolves against nothing in the loaded project."""
    loaded = TasmoProject.model_validate(
        {
            "project_name": "Hand",
            "automation_lanes": [
                {"id": "l", "target": {"kind": "nonsense", "track_id": "gone"}}
            ],
        }
    )
    assert loaded.automation_lanes is not None
    assert loaded.automation_lanes[0].target.kind == "nonsense"
    assert loaded.automation_lanes[0].points == []
