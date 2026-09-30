"""Timeline markers and the loop region survive a .tasmo save/load.

`locators` existed on the model but nothing ever wrote it, and there was no
`loop` field at all — so a saved session reopened with every marker and the
transport's cycle region gone (the editor clears both on load). These pin the
schema half of that: the `Loop` model, the project-level `loop`/`locators`
fields, and that an old file — one with neither key — still validates and loads
with the defaults.
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.modules.project.tasmo_file import TasmoFile  # noqa: E402
from backend.modules.project.tasmo_project import (  # noqa: E402
    Locator,
    Loop,
    TasmoProject,
    Track,
)


def _project() -> TasmoProject:
    """One track, two markers and a cycle region the user left switched off."""
    p = TasmoProject(project_name="Markers", tempo=124.0)
    p.tracks.append(Track(id="t1", name="Drums", type="audio"))
    p.locators.append(Locator(id="m1", name="Intro", position=0.0))
    p.locators.append(Locator(id="m2", name="Drop", position=12.5, color="#ec4899"))
    p.loop = Loop(enabled=False, start_sec=2.0, end_sec=8.0)
    return p


def test_loop_defaults():
    lp = Loop()
    assert lp.enabled is False
    assert lp.start_sec == 0.0
    assert lp.end_sec == 0.0
    # The project has no loop and no markers until something writes them.
    empty = TasmoProject(project_name="x")
    assert empty.loop is None
    assert empty.locators == []


def test_markers_and_loop_round_trip_through_a_file():
    project = _project()
    path = os.path.join(tempfile.mkdtemp(), "markers.tasmo")
    TasmoFile.save(project, path)
    loaded, _manifest = TasmoFile.load(path)

    assert [locator.id for locator in loaded.locators] == ["m1", "m2"]
    assert loaded.locators[0].name == "Intro"
    assert loaded.locators[0].position == 0.0
    assert loaded.locators[0].color is None
    assert loaded.locators[1].position == 12.5
    assert loaded.locators[1].color == "#ec4899"

    # `enabled` is stored apart from the bounds, so a region the user switched
    # off comes back off WITH its bounds rather than as no region at all.
    assert loaded.loop is not None
    assert loaded.loop.enabled is False
    assert loaded.loop.start_sec == 2.0
    assert loaded.loop.end_sec == 8.0


def test_an_enabled_loop_survives_a_dump_and_revalidate():
    p = TasmoProject(project_name="Cycle")
    p.loop = Loop(enabled=True, start_sec=1.5, end_sec=5.0)
    dumped = p.model_dump()
    assert dumped["loop"] == {"enabled": True, "start_sec": 1.5, "end_sec": 5.0}
    again = TasmoProject.model_validate(dumped)
    assert again.loop is not None
    assert again.loop.enabled is True
    assert again.loop.start_sec == 1.5


def test_a_file_written_before_markers_and_the_loop_were_saved_still_loads():
    """No `locators` key and no `loop` — the pre-batch-10 shape."""
    legacy = {
        "project_name": "Old",
        "tempo": 90.0,
        "tracks": [{"id": "t1", "name": "Gtr", "type": "audio"}],
    }
    loaded = TasmoProject.model_validate(legacy)
    assert loaded.locators == []
    assert loaded.loop is None
    # And the format is unchanged: no version bump comes with these fields.
    assert loaded.format_version == 1


def test_a_half_written_loop_still_validates():
    """A hand-edited file naming only one bound keeps the model's defaults."""
    loaded = TasmoProject.model_validate(
        {"project_name": "Hand", "loop": {"start_sec": 4.0}}
    )
    assert loaded.loop is not None
    assert loaded.loop.enabled is False
    assert loaded.loop.start_sec == 4.0
    assert loaded.loop.end_sec == 0.0
