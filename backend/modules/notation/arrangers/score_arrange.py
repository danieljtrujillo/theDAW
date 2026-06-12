"""Rule-based score arrangers.

Transforms symbolic music (one or more MIDIs) into different playable
arrangements rendered as MusicXML:

  - ``lead-sheet``      melody (skyline) plus chord symbols
  - ``piano-reduction`` two-staff grand-staff reduction split at middle C
  - ``simplified``      single-staff melody only, quantized
  - ``band-score``      one staff per source stem

Pure music21; no new dependencies. Each builder returns a ``music21`` score
that the engine writes to MusicXML, so the results render in the existing
OpenSheetMusicDisplay viewer.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

STYLES = ("lead-sheet", "piano-reduction", "simplified", "band-score")

# Pitches at or above middle C (MIDI 60) go to the treble staff.
_TREBLE_BASS_SPLIT = 60


def arrange(sources: list[Path], style: str, *, title: str = "") -> dict[str, Any]:
    """Build an arrangement of ``style`` from one or more source MIDIs.

    Returns a result dict; on success it carries the music21 ``score`` for the
    caller to write. Never raises.
    """
    style = style.lower().strip()
    if style not in STYLES:
        return {"ok": False, "error": f"unknown arrangement style: {style!r}"}
    try:
        from music21 import converter  # type: ignore[import]
    except ImportError:
        return {"ok": False, "error": "music21 is not installed."}

    paths = [Path(s) for s in sources]
    if not paths:
        return {"ok": False, "error": "no source provided"}
    for path in paths:
        if not path.is_file():
            return {"ok": False, "error": f"source not found: {path}"}

    try:
        if style == "band-score":
            score = _band_score(paths, title)
        else:
            base = converter.parse(str(paths[0]))
            try:
                base = base.quantize((4, 3), inPlace=False, recurse=True)
            except Exception as exc:  # noqa: BLE001 - quantize is best-effort
                log.debug("arrange: quantize skipped for %s: %s", paths[0], exc)
            if style == "piano-reduction":
                score = _piano_reduction(base, title)
            elif style == "lead-sheet":
                score = _lead_sheet(base, title)
            else:
                score = _simplified(base, title)
    except Exception as exc:  # noqa: BLE001
        log.warning("arrange: %s failed: %s", style, exc)
        return {"ok": False, "error": repr(exc)}

    note_count = len(score.flatten().notes)
    if note_count == 0:
        return {"ok": False, "error": "no notes found in source(s)"}
    return {
        "ok": True,
        "style": style,
        "score": score,
        "stats": {"parts": len(score.parts), "notes": note_count},
    }


def _skyline_chords(base: Any) -> list[Any]:
    """Collapse a score to vertical sonorities with absolute offsets."""
    from music21 import chord  # type: ignore[import]

    flat = base.chordify().flatten()
    return list(flat.getElementsByClass(chord.Chord))


def _voice(pitches: list[Any], quarter_length: float) -> Any:
    from music21 import chord, note  # type: ignore[import]

    if len(pitches) == 1:
        element = note.Note(pitches[0])
    else:
        element = chord.Chord(pitches)
    element.duration.quarterLength = quarter_length or 1.0
    return element


def _new_score(title: str, fallback: str) -> Any:
    from music21 import metadata, stream  # type: ignore[import]

    score = stream.Score()
    score.insert(0, metadata.Metadata())
    score.metadata.title = title or fallback
    return score


def _piano_reduction(base: Any, title: str) -> Any:
    from music21 import clef, stream  # type: ignore[import]

    treble = stream.Part()
    treble.partName = "Piano R.H."
    treble.insert(0, clef.TrebleClef())
    bass = stream.Part()
    bass.partName = "Piano L.H."
    bass.insert(0, clef.BassClef())

    for sonority in _skyline_chords(base):
        ql = sonority.duration.quarterLength
        high = sorted(
            (p for p in sonority.pitches if p.midi >= _TREBLE_BASS_SPLIT),
            key=lambda p: p.midi,
        )
        low = sorted(
            (p for p in sonority.pitches if p.midi < _TREBLE_BASS_SPLIT),
            key=lambda p: p.midi,
        )
        if high:
            treble.insert(sonority.offset, _voice(high, ql))
        if low:
            bass.insert(sonority.offset, _voice(low, ql))

    score = _new_score(title, "Piano Reduction")
    score.insert(0, treble)
    score.insert(0, bass)
    return score


def _simplified(base: Any, title: str) -> Any:
    from music21 import clef, note, stream  # type: ignore[import]

    melody = stream.Part()
    melody.partName = "Melody"
    melody.insert(0, clef.TrebleClef())
    for sonority in _skyline_chords(base):
        top = max(sonority.pitches, key=lambda p: p.midi)
        element = note.Note(top)
        element.duration.quarterLength = sonority.duration.quarterLength or 1.0
        melody.insert(sonority.offset, element)

    score = _new_score(title, "Simplified Melody")
    score.insert(0, melody)
    return score


def _safe_chord_symbol(sonority: Any) -> Any:
    """Return a renderable ChordSymbol for a sonority, or None.

    music21's ``chordSymbolFromChord`` returns an "unidentified" symbol for
    chords it can't name, and inserting one crashes MusicXML export with
    "no pitches in chord". This rebuilds from the figure and verifies it.
    """
    from music21 import harmony  # type: ignore[import]

    try:
        figure = getattr(harmony.chordSymbolFromChord(sonority), "figure", "") or ""
    except Exception:  # noqa: BLE001 - many chords have no clean symbol
        return None
    if not figure or "Cannot Be Identified" in figure:
        return None
    try:
        clean = harmony.ChordSymbol(figure)
    except Exception:  # noqa: BLE001
        return None
    return clean if clean.pitches else None


def _lead_sheet(base: Any, title: str) -> Any:
    from music21 import clef, note, stream  # type: ignore[import]

    lead = stream.Part()
    lead.partName = "Lead"
    lead.insert(0, clef.TrebleClef())
    last_figure = None
    for sonority in _skyline_chords(base):
        top = max(sonority.pitches, key=lambda p: p.midi)
        element = note.Note(top)
        element.duration.quarterLength = sonority.duration.quarterLength or 1.0
        lead.insert(sonority.offset, element)
        # A triad is the minimum for a meaningful, identifiable chord symbol.
        if len(sonority.pitches) >= 3:
            symbol = _safe_chord_symbol(sonority)
            if symbol is not None and symbol.figure != last_figure:
                lead.insert(sonority.offset, symbol)
                last_figure = symbol.figure

    score = _new_score(title, "Lead Sheet")
    score.insert(0, lead)
    return score


def _band_score(paths: list[Path], title: str) -> Any:
    from music21 import chord, clef, converter, stream  # type: ignore[import]

    score = _new_score(title, "Band Score")
    for index, path in enumerate(paths):
        source = converter.parse(str(path))
        try:
            source = source.quantize((4, 3), inPlace=False, recurse=True)
        except Exception as exc:  # noqa: BLE001 - quantize is best-effort
            log.debug("arrange: quantize skipped for %s: %s", path, exc)
        # Rebuild each stem into a fresh part (as the other builders do) so the
        # MusicXML writer bars it with a consistent time signature. Inserting
        # chordify()'s pre-measured stream directly produced scores OSMD could
        # not render ("Cannot read properties of undefined (reading
        # 'denominator')").
        part = stream.Part()
        part.partName = path.stem[:24] or f"Part {index + 1}"
        part.insert(0, clef.TrebleClef())
        for sonority in source.chordify().flatten().getElementsByClass(chord.Chord):
            part.insert(
                sonority.offset,
                _voice(list(sonority.pitches), sonority.duration.quarterLength),
            )
        score.insert(0, part)
    return score
