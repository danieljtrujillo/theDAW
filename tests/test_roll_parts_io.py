"""The piano roll's parts in a .tasmo, and a score's parts with their instruments.

- A roll bounced to EDIT puts each part on a clip of its own, and each clip
  carries ``roll_part`` (the roll document shared by every part's clip, the
  part's id, place and settings), so opening one clip in the roll opens every
  part. The ``Clip`` model had no such field, so pydantic dropped it and a
  reopened project opened each clip as a roll of one part.
- The sheet importer returned each part's name and notes only, so a quartet
  opened on one instrument. Each track now carries the registry instrument
  (``instrument``), its GM ``program`` and ``percussion``.
"""

from __future__ import annotations

from pathlib import Path

from backend.modules.project.tasmo_file import TasmoFile
from backend.modules.project.tasmo_project import Clip, TasmoProject


def _clip(cid: str, part: dict | None) -> dict:
    clip = {
        "id": cid,
        "name": cid,
        "clip_type": "midi",
        "track_id": "t1",
        "audio_file": f"audio/{cid}.wav",
        "midi_notes": [{"note": 60, "step": 0, "length": 2, "velocity": 90}],
        "total_steps": 16,
    }
    if part is not None:
        clip["roll_part"] = part
    return clip


PART = {
    "doc": "roll-1",
    "id": "part-vc",
    "order": 1,
    "name": "Violoncello",
    "program": 42,
    "bank": 0,
    "channel": None,
    "color": "#22d3ee",
    "mute": False,
    "solo": True,
    "instrument_id": "cello",
}


def test_a_roll_part_round_trips_through_the_archive(tmp_path: Path) -> None:
    project = TasmoProject.model_validate(
        {
            "project_name": "Parts",
            "tempo": 100,
            "tracks": [
                {
                    "id": "t1",
                    "name": "Violoncello",
                    "type": "audio",
                    "clips": [_clip("c1", PART)],
                }
            ],
        }
    )
    out = tmp_path / "parts.tasmo"
    TasmoFile.save(project, str(out))
    loaded, _ = TasmoFile.load(str(out))
    assert loaded.tracks[0].clips[0].roll_part == PART


def test_a_clip_written_before_parts_has_no_part() -> None:
    clip = Clip.model_validate(_clip("old", None))
    assert clip.roll_part is None


def _quartet(path: Path) -> Path:
    """A score of a violin, a viola, a cello and a snare drum, as MusicXML."""
    from music21 import instrument, meter, note, stream

    score = stream.Score()
    for inst, pitch in (
        (instrument.Violin(), "E5"),
        (instrument.Viola(), "C4"),
        (instrument.Violoncello(), "C3"),
        (instrument.SnareDrum(), "D4"),
    ):
        part = stream.Part()
        part.partName = inst.instrumentName
        part.insert(0, inst)
        measure = stream.Measure(number=1)
        measure.append(meter.TimeSignature("3/4"))
        for _ in range(3):
            measure.append(note.Note(pitch, quarterLength=1))
        part.append(measure)
        score.insert(0, part)
    out = path / "quartet.musicxml"
    score.write("musicxml", fp=str(out))
    return out


def test_each_score_part_carries_its_instrument(tmp_path: Path) -> None:
    from backend.modules.sheetimport.parser import parse_score_path

    result = parse_score_path(str(_quartet(tmp_path)))
    tracks = result["tracks"]
    assert [t["instrument"] for t in tracks] == [
        "violin",
        "viola",
        "cello",
        "snare-drum",
    ]
    assert [t["program"] for t in tracks[:3]] == [40, 41, 42]
    assert [t["percussion"] for t in tracks] == [False, False, False, True]
    assert all(len(t["notes"]) == 3 for t in tracks)
