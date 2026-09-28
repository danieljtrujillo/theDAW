""".tasmo keeps a voice's sound bank, a track's MIDI output and the project
tuning, and a file written before them still loads on the bundled bank at
A = 440."""

from __future__ import annotations

from backend.modules.project.tasmo_project import Clip, TasmoProject, Track


def _project(**extra) -> TasmoProject:
    clip = Clip(
        id="c1",
        name="Violins",
        clip_type="midi",
        track_id="t1",
        instrument_program=48,
        instrument_bank=2,
        instrument_bank_id="sb-0123456789ab",
    )
    track = Track(
        id="t1",
        name="Strings",
        type="midi",
        clips=[clip],
        instrument_program=40,
        instrument_bank=1,
        instrument_bank_id="sb-0123456789ab",
        midi_out={
            "port_id": "out-1",
            "port_label": "loopMIDI",
            "channel": 3,
            "clock": True,
        },
        mpe_channels=6,
        articulation_switch="uacc",
    )
    return TasmoProject(tracks=[track], **extra)


def test_the_sound_fields_survive_a_round_trip() -> None:
    tuning = {"reference_hz": 415.0, "temperament": "werckmeister3", "root": 0}
    back = TasmoProject.model_validate(_project(tuning=tuning).model_dump())
    track = back.tracks[0]
    assert (track.instrument_bank, track.instrument_bank_id, track.mpe_channels) == (
        1,
        "sb-0123456789ab",
        6,
    )
    assert track.midi_out == {
        "port_id": "out-1",
        "port_label": "loopMIDI",
        "channel": 3,
        "clock": True,
    }
    clip = track.clips[0]
    assert (clip.instrument_program, clip.instrument_bank, clip.instrument_bank_id) == (
        48,
        2,
        "sb-0123456789ab",
    )
    assert back.tuning == tuning
    assert track.articulation_switch == "uacc"


def test_a_file_from_before_sound_banks_loads_on_the_bundled_bank_at_a440() -> None:
    old = TasmoProject.model_validate(
        {
            "tracks": [
                {
                    "id": "t1",
                    "name": "Piano",
                    "type": "midi",
                    "instrument_program": 0,
                    "clips": [
                        {
                            "id": "c1",
                            "name": "c",
                            "clip_type": "midi",
                            "track_id": "t1",
                            "instrument_program": 1,
                        }
                    ],
                }
            ]
        }
    )
    t = old.tracks[0]
    assert (t.instrument_bank, t.instrument_bank_id, t.midi_out, t.mpe_channels) == (
        None,
        None,
        None,
        None,
    )
    assert t.clips[0].instrument_bank_id is None
    assert old.tuning is None
    assert t.articulation_switch is None
