"""A session clip's follow action survives a .tasmo save/load.

Batch 8 made the clip-launch grid representable — a clip's column, scene row and
slot all round-trip. A follow action is the other half of what a session grid is:
without it a saved set reopens with every column playing one clip forever, since
the rule that moved it on lived only in the browser tab.

These pin the schema half: the nested ``FollowAction`` model, its presence on
``Clip``, and — the reason every field is defaulted — that a file written before
follow actions existed, or one carrying only part of the shape, still validates
instead of taking the whole project down with it.
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.modules.project.tasmo_file import TasmoFile  # noqa: E402
from backend.modules.project.tasmo_project import (  # noqa: E402
    Clip,
    FollowAction,
    FollowAfter,
    TasmoProject,
    Track,
)


def _clip(clip_id: str, scene: int, follow: FollowAction | None) -> Clip:
    return Clip(
        id=clip_id,
        name=f"Cell {scene}",
        clip_type="audio",
        track_id="t1",
        start_time=0.0,
        end_time=4.0,
        track_index=0,
        scene_index=scene,
        slot_index=scene,
        follow_action=follow,
    )


def _project() -> TasmoProject:
    """One column, three cells: a bars rule, a plays rule, and no rule at all."""
    p = TasmoProject(project_name="Follow", tempo=124.0, scenes=["A", "B", "C"])
    track = Track(id="t1", name="Drums", type="audio")
    track.clips.append(
        _clip(
            "c1",
            0,
            FollowAction(
                after=FollowAfter(bars=2, beats=1), a="next", b="stop", chance=0.35
            ),
        )
    )
    track.clips.append(
        _clip("c2", 1, FollowAction(after=FollowAfter(plays=3), a="again", chance=1.0))
    )
    track.clips.append(_clip("c3", 2, None))
    p.tracks.append(track)
    return p


def test_follow_action_defaults():
    """Every field defaults, which is what lets a partial entry validate."""
    assert Clip(id="c", name="n", clip_type="audio", track_id="t").follow_action is None
    fa = FollowAction()
    assert fa.a == ""
    assert fa.b is None
    assert fa.chance == 1.0
    assert fa.after.bars is None
    assert fa.after.beats is None
    assert fa.after.plays is None


def test_follow_actions_round_trip_through_a_file():
    path = os.path.join(tempfile.mkdtemp(), "follow.tasmo")
    TasmoFile.save(_project(), path)
    loaded, _manifest = TasmoFile.load(path)

    clips = {c.id: c for c in loaded.tracks[0].clips}
    assert len(clips) == 3

    first = clips["c1"].follow_action
    assert first is not None
    assert first.a == "next"
    assert first.b == "stop"
    assert first.chance == 0.35
    assert first.after.bars == 2
    assert first.after.beats == 1
    assert first.after.plays is None

    second = clips["c2"].follow_action
    assert second is not None
    assert second.a == "again"
    assert second.b is None
    assert second.after.plays == 3

    # Per clip, not per track: the third cell keeps no rule of its own.
    assert clips["c3"].follow_action is None

    # And the placement it hangs off is still intact.
    assert [clips[i].scene_index for i in ("c1", "c2", "c3")] == [0, 1, 2]


def test_follow_action_survives_model_dump():
    """The save route validates a JSON dict, so the dumped shape is the contract."""
    dumped = _project().model_dump()
    written = dumped["tracks"][0]["clips"][0]["follow_action"]
    assert written == {
        "after": {"bars": 2.0, "beats": 1.0, "plays": None},
        "a": "next",
        "b": "stop",
        "chance": 0.35,
    }
    revalidated = TasmoProject.model_validate(dumped)
    assert revalidated.tracks[0].clips[0].follow_action.a == "next"
    assert dumped["tracks"][0]["clips"][2]["follow_action"] is None


def test_a_file_written_before_follow_actions_existed_still_loads():
    """No `follow_action` key anywhere — the pre-batch-9 clip shape."""
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
                        "name": "Riff",
                        "clip_type": "audio",
                        "track_id": "t1",
                        "scene_index": 0,
                    }
                ],
            }
        ],
    }
    loaded = TasmoProject.model_validate(legacy)
    assert loaded.tracks[0].clips[0].follow_action is None
    assert loaded.tracks[0].clips[0].scene_index == 0


def test_a_partial_follow_action_validates_instead_of_failing_the_project():
    """A half-written entry must not cost the user the whole file.

    Storage is tolerant; the frontend's `parseFollowAction` is the strict half
    and turns anything it cannot act on into no rule at all.
    """
    partial = {
        "project_name": "Partial",
        "tracks": [
            {
                "id": "t1",
                "name": "Gtr",
                "type": "audio",
                "clips": [
                    {
                        "id": "c1",
                        "name": "Riff",
                        "clip_type": "audio",
                        "track_id": "t1",
                        "follow_action": {},
                    },
                    {
                        "id": "c2",
                        "name": "Riff 2",
                        "clip_type": "audio",
                        "track_id": "t1",
                        "follow_action": {"a": "sideways"},
                    },
                ],
            }
        ],
    }
    loaded = TasmoProject.model_validate(partial)
    empty = loaded.tracks[0].clips[0].follow_action
    assert empty is not None
    assert empty.a == ""
    assert empty.after.bars is None
    # An action name the backend has never heard of is stored verbatim; only the
    # app decides whether it means anything.
    assert loaded.tracks[0].clips[1].follow_action.a == "sideways"
