"""A score written as a MIDI file at the pitch every part sounds.

MusicXML holds a part for a transposing instrument at written pitch, with a
``<transpose>`` from the page to the sound: a B-flat clarinet's written D5
sounds C5, a horn in F sounds a fifth below the page. A MIDI file states no
transposition, so every note has to be the one that sounds. This writer reads
the score, moves every part to sounding pitch with music21's
``toSoundingPitch`` (the part's instrument transposition and any ottava), and
writes:

  - one track per part, named after the part and carrying its General MIDI
    program (a part with no instrument plays program 0, acoustic grand);
  - a conductor track holding every tempo mark and every time signature at
    its own offset (music21's ``conductorStream``), so the tempo map and the
    meter map both survive.

music21's MIDI writer plays out repeats (``prepareStreamForMidi`` calls
``expandRepeats``), so the file is the piece as performed.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from backend.lib.atomic import atomic_write

log = logging.getLogger(__name__)

ENGINE = "music21-midi"
ENGINE_VERSION = "1"


def _first_score(parsed: Any) -> Any:
    """A score from what music21 parsed: an ABC book or a MusicXML opus
    parses as an ``Opus`` of scores, and the first one is the piece."""
    from music21 import stream

    if isinstance(parsed, stream.Opus):
        scores = list(parsed.scores)
        if not scores:
            raise ValueError("the file holds no score")
        return scores[0]
    return parsed


def _name_and_program(score: Any) -> list[dict[str, Any]]:
    """Give every part an instrument that names it and states a program, and
    return ``[{"index", "name", "program", "percussion"}]`` in part order.

    The track name music21 writes is the instrument's ``bestName()``, which
    reads ``partName`` first, so the part's own name is copied onto an
    instrument that has none. A part with no instrument at all gets a plain
    one at offset 0.
    """
    from music21 import instrument, stream

    parts = list(score.parts) if isinstance(score, stream.Score) else [score]
    tracks: list[dict[str, Any]] = []
    for index, part in enumerate(parts):
        found = part.recurse().getElementsByClass(instrument.Instrument)
        inst = found.first() if found else None
        part_name = str(getattr(part, "partName", "") or "").strip()
        if inst is None:
            inst = instrument.Instrument()
            part.insert(0, inst)
        name = (
            part_name
            or str(inst.partName or "").strip()
            or str(inst.instrumentName or "").strip()
            or f"Part {index + 1}"
        )
        if not inst.partName:
            inst.partName = name
        if inst.midiProgram is None:
            inst.midiProgram = 0
        tracks.append(
            {
                "index": index,
                "name": name,
                "program": int(inst.midiProgram),
                "percussion": isinstance(inst, instrument.UnpitchedPercussion),
            }
        )
    return tracks


def write_sounding_midi(source_path: Path, output_path: Path) -> dict[str, Any]:
    """Write ``source_path`` (any score music21 reads: MusicXML, ``.mxl``,
    kern, ABC or MIDI) to ``output_path`` as a MIDI file at sounding pitch.

    Returns ``{"ok": True, "path", "engine", "tracks": [...]}`` or
    ``{"ok": False, "engine", "error"}``; never raises into a route.
    """
    try:
        from music21.midi import translate

        from ..midi_read import read_score
        from ..tempo_marks import restore_sounding_tempi

        score = _first_score(read_score(Path(source_path)))
        # A sheet engraved here prints a whole-number tempo and keeps the exact
        # one in <sound tempo>, which music21's reader drops.
        restore_sounding_tempi(score, Path(source_path))
        score.toSoundingPitch(inPlace=True)
        tracks = _name_and_program(score)
        if not score.recurse().notes:
            raise ValueError("the score holds no notes")
        midi_file = translate.streamToMidiFile(score)
        atomic_write(output_path, midi_file.writestr())
    except Exception as exc:
        # Reported to the caller (the /export route answers 501 with it).
        log.warning(
            "notation: sounding MIDI export failed for %s: %s", source_path, exc
        )
        return {"ok": False, "engine": ENGINE, "error": str(exc) or repr(exc)}
    return {"ok": True, "path": str(output_path), "engine": ENGINE, "tracks": tracks}
