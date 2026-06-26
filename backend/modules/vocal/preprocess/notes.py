"""Vocal-to-MIDI notes via the existing basic-pitch engine, parsed to artifact Notes.

Reuses backend/modules/midi convert_to_midi to write a MIDI file, then parses it
with mido into project-relative-millisecond notes. Returns [] when basic-pitch is
not installed; it never triggers a surprise pip install (auto_install=False).
"""

from __future__ import annotations

import importlib.util
import logging
import tempfile
from pathlib import Path

from ..schema import Note

log = logging.getLogger(__name__)


def extract_notes(audio_path: Path) -> list[Note]:
    if importlib.util.find_spec("mido") is None:
        return []
    from backend.modules.midi.engine import convert_to_midi

    p = Path(audio_path)
    if not p.is_file():
        return []
    with tempfile.TemporaryDirectory() as td:
        mid_path = Path(td) / "notes.mid"
        res = convert_to_midi(p, mid_path, hint="auto", auto_install=False)
        if not res.get("ok") or not mid_path.is_file():
            log.info(
                "vocal.notes: basic-pitch unavailable/failed: %s", res.get("error")
            )
            return []
        return _parse_midi(mid_path)


def _parse_midi(mid_path: Path) -> list[Note]:
    import mido

    try:
        mid = mido.MidiFile(str(mid_path))
    except Exception:
        return []
    tpb = mid.ticks_per_beat or 480
    notes: list[Note] = []
    for track in mid.tracks:
        cur_tempo = 500000  # default 120 BPM until a set_tempo arrives
        elapsed_ms = 0.0
        active: dict[int, tuple[int, int]] = {}
        for msg in track:
            elapsed_ms += mido.tick2second(msg.time, tpb, cur_tempo) * 1000.0
            if msg.type == "set_tempo":
                cur_tempo = msg.tempo
            elif msg.type == "note_on" and msg.velocity > 0:
                active[msg.note] = (int(elapsed_ms), int(msg.velocity))
            elif msg.type == "note_off" or (
                msg.type == "note_on" and msg.velocity == 0
            ):
                started = active.pop(msg.note, None)
                if started is not None:
                    start_ms, vel = started
                    notes.append(
                        Note(
                            start_ms=start_ms,
                            end_ms=int(elapsed_ms),
                            pitch=int(msg.note),
                            velocity=vel,
                        )
                    )
    notes.sort(key=lambda n: n.start_ms)
    return notes
