"""Takes and the comp survive a .tasmo save/load.

A clip could carry exactly one audio file, so recording a second pass over the
same bars had nowhere to live: alternate takes and the comp across them existed
only in the browser tab and were thrown away by every save. These pin the
schema half of that — the `Take` / `CompRegion` models, the three defaulted
`Clip` fields, the structural rules a comp has to satisfy, and that a file
written before any of it existed still validates and loads unchanged.

The format version does NOT move with these fields: a reader that ignores them
still gets a correct project, because the clip's own `audio_file` and
`offset_into_source` already name the take it is playing.
"""

import os
import sys
import tempfile

import pytest
from pydantic import ValidationError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.modules.project.tasmo_file import TasmoFile  # noqa: E402
from backend.modules.project.tasmo_project import (  # noqa: E402
    Clip,
    CompRegion,
    Take,
    TasmoProject,
    Track,
)


def _take(idx: int) -> Take:
    return Take(
        id=f"tk{idx}",
        name=f"Take {idx}",
        audio_file=f"audio/c1-tk{idx}.wav",
        mime_type="audio/wav",
        offset_into_source=0.25 * idx,
        source_duration=4.0 + idx,
    )


def _comped_clip() -> Clip:
    """A clip with three takes and a comp that switches between two of them."""
    return Clip(
        id="c1",
        name="Vocal",
        clip_type="audio",
        track_id="t1",
        start_time=1.0,
        end_time=5.0,
        audio_file="audio/c1.wav",
        offset_into_source=0.25,
        takes=[_take(0), _take(1), _take(2)],
        comp=[
            CompRegion(start_sec=0.0, take_index=0),
            CompRegion(start_sec=1.5, take_index=2, crossfade_sec=0.02),
        ],
        active_take_index=1,
    )


def _project() -> TasmoProject:
    p = TasmoProject(project_name="Comped", tempo=96.0)
    p.tracks.append(Track(id="t1", name="Vox", type="audio", clips=[_comped_clip()]))
    return p


def test_a_clip_without_takes_has_all_three_fields_absent():
    clip = Clip(id="c1", name="Loop", clip_type="audio", track_id="t1")
    assert clip.takes is None
    assert clip.comp is None
    assert clip.active_take_index is None


def test_takes_and_comp_round_trip_through_a_file():
    path = os.path.join(tempfile.mkdtemp(), "comped.tasmo")
    TasmoFile.save(_project(), path)
    loaded, _manifest = TasmoFile.load(path)

    clip = loaded.tracks[0].clips[0]
    assert [t.id for t in clip.takes or []] == ["tk0", "tk1", "tk2"]
    assert clip.takes is not None
    assert clip.takes[1].name == "Take 1"
    assert clip.takes[1].audio_file == "audio/c1-tk1.wav"
    assert clip.takes[1].mime_type == "audio/wav"
    assert clip.takes[1].offset_into_source == 0.25
    assert clip.takes[1].source_duration == 5.0
    # The comp is the boundary list, in order, with the crossfade on the
    # boundary it belongs to.
    assert [(r.start_sec, r.take_index, r.crossfade_sec) for r in clip.comp or []] == [
        (0.0, 0, 0.0),
        (1.5, 2, 0.02),
    ]
    assert clip.active_take_index == 1
    # The clip's own audio reference is untouched by any of this — it still
    # names the take the clip is playing.
    assert clip.audio_file == "audio/c1.wav"
    assert clip.offset_into_source == 0.25


def test_the_three_fields_survive_a_dump_and_revalidate():
    dumped = _comped_clip().model_dump()
    assert dumped["comp"] == [
        {"start_sec": 0.0, "take_index": 0, "crossfade_sec": 0.0},
        {"start_sec": 1.5, "take_index": 2, "crossfade_sec": 0.02},
    ]
    assert dumped["active_take_index"] == 1
    again = Clip.model_validate(dumped)
    assert [t.id for t in again.takes or []] == ["tk0", "tk1", "tk2"]
    assert again.comp is not None and again.comp[1].crossfade_sec == 0.02


def test_a_half_written_take_keeps_the_models_defaults():
    """A hand-edited file naming only a take id still validates."""
    clip = Clip.model_validate(
        {
            "id": "c1",
            "name": "x",
            "clip_type": "audio",
            "track_id": "t1",
            "takes": [{"id": "only"}],
        }
    )
    assert clip.takes is not None
    take = clip.takes[0]
    assert take.name == ""
    assert take.audio_file is None
    assert take.mime_type == ""
    assert take.offset_into_source == 0.0
    assert take.source_duration == 0.0
    # No comp, so nothing to validate against the single take.
    assert clip.comp is None


def test_a_comp_whose_regions_do_not_ascend_is_rejected():
    with pytest.raises(ValidationError) as excinfo:
        Clip.model_validate(
            {
                "id": "c1",
                "name": "x",
                "clip_type": "audio",
                "track_id": "t1",
                "takes": [{"id": "a"}, {"id": "b"}],
                "comp": [
                    {"start_sec": 0.0, "take_index": 0},
                    {"start_sec": 2.0, "take_index": 1},
                    {"start_sec": 1.0, "take_index": 0},
                ],
            }
        )
    assert "must ascend by start_sec" in str(excinfo.value)


def test_two_regions_at_the_same_instant_are_rejected():
    """A duplicated boundary describes a region with no length."""
    with pytest.raises(ValidationError) as excinfo:
        Clip.model_validate(
            {
                "id": "c1",
                "name": "x",
                "clip_type": "audio",
                "track_id": "t1",
                "takes": [{"id": "a"}, {"id": "b"}],
                "comp": [
                    {"start_sec": 0.0, "take_index": 0},
                    {"start_sec": 0.0, "take_index": 1},
                ],
            }
        )
    assert "must ascend by start_sec" in str(excinfo.value)


@pytest.mark.parametrize("bad_index", [2, -1])
def test_a_comp_region_naming_a_take_that_is_not_there_is_rejected(bad_index):
    with pytest.raises(ValidationError) as excinfo:
        Clip.model_validate(
            {
                "id": "c1",
                "name": "x",
                "clip_type": "audio",
                "track_id": "t1",
                "takes": [{"id": "a"}, {"id": "b"}],
                "comp": [{"start_sec": 0.0, "take_index": bad_index}],
            }
        )
    assert "but the clip has 2 take(s)" in str(excinfo.value)


def test_a_comp_with_no_takes_at_all_is_rejected():
    with pytest.raises(ValidationError):
        Clip.model_validate(
            {
                "id": "c1",
                "name": "x",
                "clip_type": "audio",
                "track_id": "t1",
                "comp": [{"start_sec": 0.0, "take_index": 0}],
            }
        )


@pytest.mark.parametrize("field", ["start_sec", "crossfade_sec"])
def test_a_non_finite_comp_boundary_is_rejected(field):
    """msgpack carries NaN, and NaN compares false against every bound — it
    would slip past the ascending check and then place a segment nowhere."""
    region = {"start_sec": 0.0, "take_index": 0, "crossfade_sec": 0.0}
    region[field] = float("nan")
    with pytest.raises(ValidationError) as excinfo:
        Clip.model_validate(
            {
                "id": "c1",
                "name": "x",
                "clip_type": "audio",
                "track_id": "t1",
                "takes": [{"id": "a"}],
                "comp": [region],
            }
        )
    assert "non-finite start_sec/crossfade_sec" in str(excinfo.value)


@pytest.mark.parametrize("bad_index", [3, -1])
def test_an_active_take_index_naming_no_take_is_rejected(bad_index):
    """It says which take the clip's own audio_file mirrors, so out of range
    means the clip's audio and its take list disagree about what is playing."""
    with pytest.raises(ValidationError) as excinfo:
        Clip.model_validate(
            {
                "id": "c1",
                "name": "x",
                "clip_type": "audio",
                "track_id": "t1",
                "takes": [{"id": "a"}, {"id": "b"}],
                "active_take_index": bad_index,
            }
        )
    assert "names no take, the clip has 2" in str(excinfo.value)


def test_an_active_take_index_on_a_clip_with_no_takes_is_left_alone():
    """Nothing to disagree with: a stray index on a takeless clip is inert, and
    a file is not worth refusing over it."""
    clip = Clip.model_validate(
        {
            "id": "c1",
            "name": "x",
            "clip_type": "audio",
            "track_id": "t1",
            "active_take_index": 4,
        }
    )
    assert clip.takes is None
    assert clip.active_take_index == 4


def test_a_file_written_before_takes_existed_still_loads():
    """No `takes`, no `comp`, no `active_take_index` — the pre-batch-10 shape."""
    legacy = {
        "project_name": "Old",
        "tempo": 90.0,
        "tracks": [
            {
                "id": "t1",
                "name": "Gtr",
                "type": "audio",
                "clips": [
                    {
                        "id": "c1",
                        "name": "riff",
                        "clip_type": "audio",
                        "track_id": "t1",
                        "audio_file": "/tmp/riff.wav",
                        "offset_into_source": 0.5,
                    }
                ],
            }
        ],
    }
    loaded = TasmoProject.model_validate(legacy)
    clip = loaded.tracks[0].clips[0]
    assert clip.takes is None
    assert clip.comp is None
    assert clip.active_take_index is None
    # Loading it changed nothing else about the clip...
    assert clip.audio_file == "/tmp/riff.wav"
    assert clip.offset_into_source == 0.5
    # ...and the format is unchanged: no version bump comes with these fields.
    assert loaded.format_version == 1


def test_takes_without_a_comp_are_a_plain_take_switch():
    """Several takes and no comp is take SWITCHING, which is always valid."""
    clip = Clip.model_validate(
        {
            "id": "c1",
            "name": "x",
            "clip_type": "audio",
            "track_id": "t1",
            "takes": [{"id": "a"}, {"id": "b"}, {"id": "c"}],
            "active_take_index": 2,
            "comp": [],
        }
    )
    assert clip.comp == []
    assert clip.active_take_index == 2
