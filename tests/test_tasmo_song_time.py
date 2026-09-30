""".tasmo keeps where an audio clip sits in its library song's time, so a
reopened stem still beat-matches and still takes the song's tempo; a file
written before it loads with none, and a broken one is refused."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.modules.project.tasmo_project import Clip, TasmoProject, Track


def _clip(**extra) -> Clip:
    return Clip(
        id="c1",
        name="Song · drums",
        clip_type="audio",
        track_id="t1",
        start_time=2.0,
        end_time=180.0,
        audio_file="audio/c1.wav",
        offset_into_source=0.5,
        **extra,
    )


def _project(clip: Clip) -> TasmoProject:
    return TasmoProject(
        tracks=[Track(id="t1", name="Drums", type="audio", clips=[clip])]
    )


def test_song_time_survives_a_round_trip() -> None:
    # A drums stem of a song, beat matched from 103.36 to 120 (a stretch of
    # 120 / 103.36 that started half a second into the song).
    song_time = {
        "entry_id": "5b4390f8ff1c4de0af3e3e0533f0d152",
        "bpm": 103.359375,
        "offset_sec": 0.5,
        "rate": 120 / 103.359375,
    }
    dumped = _project(_clip(song_time=song_time)).model_dump(mode="json")
    back = TasmoProject.model_validate(dumped)
    st = back.tracks[0].clips[0].song_time
    assert st is not None
    assert st.entry_id == "5b4390f8ff1c4de0af3e3e0533f0d152"
    assert st.bpm == pytest.approx(103.359375)
    assert st.offset_sec == pytest.approx(0.5)
    assert st.rate == pytest.approx(120 / 103.359375)


def test_a_file_written_before_song_time_loads_with_none() -> None:
    back = TasmoProject.model_validate(
        _project(_clip()).model_dump(
            mode="json", exclude={"tracks": {0: {"clips": {0: {"song_time"}}}}}
        )
    )
    assert back.tracks[0].clips[0].song_time is None


def test_a_song_time_with_no_tempo_keeps_its_place() -> None:
    back = _clip(song_time={"entry_id": "e1", "bpm": None}).song_time
    assert back is not None
    assert (back.bpm, back.offset_sec, back.rate) == (None, 0.0, 1.0)


@pytest.mark.parametrize(
    "bad",
    [
        {"entry_id": "e1", "rate": 0},
        {"entry_id": "e1", "rate": -1.5},
        {"entry_id": "e1", "offset_sec": float("nan")},
        {"bpm": 120},
    ],
)
def test_a_song_time_that_cannot_map_the_audio_is_refused(bad: dict) -> None:
    with pytest.raises(ValidationError):
        _clip(song_time=bad)
