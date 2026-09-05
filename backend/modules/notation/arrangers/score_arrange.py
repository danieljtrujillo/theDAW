"""Rule-based score arrangers.

Transforms symbolic music (one or more MIDIs) into different playable
arrangements rendered as MusicXML:

  - ``lead-sheet``      melody (skyline) plus chord symbols
  - ``piano-reduction`` two-staff grand-staff reduction split at middle C
  - ``simplified``      single-staff melody only, quantized
  - ``band-score``      one staff per source stem (percussion staff for drum
                        MIDIs, clef by register, redundant 'full' mix skipped)

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

# Band-score register control. A stem whose median pitch is below A3 (57)
# reads on a bass clef. Each clef gets a window of three ledger lines above
# and below the staff; pitches outside it are folded by octave INTO the
# window (pitch class preserved, register normalised), because basic-pitch
# stems span MIDI 22-101 and a ten-ledger-line stack under a treble staff
# inflates every system past the page.
_BAND_BASS_CLEF_BELOW = 57
_CLEF_WINDOWS: dict[str, tuple[int, int]] = {
    "G": (53, 88),  # F3 .. E6 on a treble staff
    "F": (33, 67),  # A1 .. G4 on a bass staff
}
# Keep the lowest pitch plus the top three: a sane skyline and measure width.
_BAND_MAX_CHORD = 4
# Stem names that are a second transcription of the whole mix; redundant
# beside the real stems (measured Jaccard 0.47 against the stem union) and
# always the tallest staff.
_MIX_STEM_NAMES = frozenset({"full", "mix", "master"})


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

    extra_stats: dict[str, Any] = {}
    try:
        if style == "band-score":
            score, extra_stats = _band_score(paths, title)
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
            # Re-quantize AFTER the merge. These styles all route through
            # _skyline_chords -> chordify(), which slices a new sonority at every
            # onset boundary across every part. When the source mixes duple and
            # triple positions (which the (4, 3) grid above permits by design),
            # those slice widths are differences between the two grids and are
            # not representable as a plain note value, so music21 renders them as
            # nonsense tuplets: 12:7, 24:19, 11:8, 17:16. Snapping the assembled
            # score back onto the same grid removes the slicing artifacts while
            # leaving real triplets alone. Measured on a live piano-reduction:
            # irrational tuplet notes 8 -> 0, total tuplets 690 -> 214, note
            # count unchanged at 1183.
            try:
                score = score.quantize((4, 3), inPlace=False, recurse=True)
            except Exception as exc:  # noqa: BLE001 - quantize is best-effort
                log.debug("arrange: post-merge quantize skipped for %s: %s", style, exc)
    except Exception as exc:  # noqa: BLE001
        log.warning("arrange: %s failed: %s", style, exc)
        return {"ok": False, "error": repr(exc)}

    note_count = len(score.flatten().notes)
    if note_count == 0:
        return {"ok": False, "error": "no notes found in source(s)"}
    stats: dict[str, Any] = {"parts": len(score.parts), "notes": note_count}
    stats.update(extra_stats)
    return {"ok": True, "style": style, "score": score, "stats": stats}


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


def _stem_base(path: Path) -> str:
    """Normalised stem name: lower-case, last ``__``-separated segment
    (``Song__full`` -> ``full``)."""
    stem = path.stem.lower().strip()
    if "__" in stem:
        stem = stem.rsplit("__", 1)[-1]
    return stem


def _is_mix_stem(path: Path) -> bool:
    return _stem_base(path) in _MIX_STEM_NAMES


def _is_drum_named(path: Path) -> bool:
    base = _stem_base(path)
    return "drum" in base or "percussion" in base


def _clef_for_pitches(midis: list[int]) -> str:
    """'F' (bass) when the median pitch sits below A3, else 'G' (treble)."""
    if not midis:
        return "G"
    ordered = sorted(midis)
    median = ordered[len(ordered) // 2]
    return "F" if median < _BAND_BASS_CLEF_BELOW else "G"


def fold_into_window(midi: int, low: int, high: int) -> int:
    """Move ``midi`` by whole octaves until it lies in ``[low, high]``.

    The window is always at least an octave wide, so the result is unique.
    """
    while midi < low:
        midi += 12
    while midi > high:
        midi -= 12
    return midi


def _band_voice(
    pitches: list[Any], quarter_length: float, window: tuple[int, int]
) -> tuple[Any, int]:
    """One band-score sonority: pitches folded into the clef window, deduped,
    capped at ``_BAND_MAX_CHORD`` (lowest + top three). Returns the element and
    the number of pitches that were folded."""
    from music21 import pitch as m21pitch  # type: ignore[import]

    low, high = window
    folded = 0
    seen: set[int] = set()
    kept: list[int] = []
    for p in pitches:
        midi = int(p.midi)
        target = fold_into_window(midi, low, high)
        if target != midi:
            folded += 1
        if target not in seen:
            seen.add(target)
            kept.append(target)
    kept.sort()
    if len(kept) > _BAND_MAX_CHORD:
        kept = [kept[0]] + kept[-(_BAND_MAX_CHORD - 1) :]
    return _voice([m21pitch.Pitch(midi=m) for m in kept], quarter_length), folded


def _band_score(paths: list[Path], title: str) -> tuple[Any, dict[str, Any]]:
    """One staff per stem.

    * With more than one source, a whole-mix stem (``full``/``mix``/``master``)
      is skipped: it duplicates the real stems and is always the tallest staff.
    * A drum-kit MIDI (``is_drum`` instruments, or GM kit pitches in a file
      named like a drum stem) becomes an unpitched percussion staff.
    * A drum-NAMED stem that is NOT kit data (a pitched transcription of a
      drum stem: hundreds of spurious notes across five octaves) is skipped
      when other stems exist: omitting is honest, chordifying is garbage.
    * Every other stem picks its clef from its median pitch, folds outliers by
      octave into a three-ledger-line window and caps chords at four pitches.

    Returns ``(score, stats)`` with ``stats = {skipped, skip_reasons, clefs,
    folded_notes}``.
    """
    from music21 import chord, clef, converter, stream  # type: ignore[import]

    from .percussion import build_percussion_part, is_drum_midi

    score = _new_score(title, "Band Score")
    skipped: list[str] = []
    skip_reasons: dict[str, str] = {}
    clefs: dict[str, str] = {}
    folded_total = 0
    multi = len(paths) > 1

    for index, path in enumerate(paths):
        part_name = path.stem[:24] or f"Part {index + 1}"
        drum_kit = is_drum_midi(path)
        if multi and not drum_kit and _is_mix_stem(path):
            skipped.append(path.stem)
            skip_reasons[path.stem] = "whole-mix transcription duplicates the stems"
            continue
        if multi and not drum_kit and _is_drum_named(path):
            skipped.append(path.stem)
            skip_reasons[path.stem] = (
                "pitched transcription of a drum stem (no kit data)"
            )
            continue

        if drum_kit:
            part = build_percussion_part(path, title=part_name)
            clefs[part_name] = "percussion"
            score.insert(0, part)
            continue

        source = converter.parse(str(path))
        try:
            source = source.quantize((4, 3), inPlace=False, recurse=True)
        except Exception as exc:  # noqa: BLE001 - quantize is best-effort
            log.debug("arrange: quantize skipped for %s: %s", path, exc)
        sonorities = list(source.chordify().flatten().getElementsByClass(chord.Chord))
        clef_sign = _clef_for_pitches(
            [int(p.midi) for sonority in sonorities for p in sonority.pitches]
        )
        window = _CLEF_WINDOWS[clef_sign]
        # Rebuild each stem into a fresh part (as the other builders do) so the
        # MusicXML writer bars it with a consistent time signature. Inserting
        # chordify()'s pre-measured stream directly produced scores OSMD could
        # not render ("Cannot read properties of undefined (reading
        # 'denominator')").
        part = stream.Part()
        part.partName = part_name
        part.partAbbreviation = part_name[:6]
        part.insert(0, clef.BassClef() if clef_sign == "F" else clef.TrebleClef())
        for sonority in sonorities:
            element, folded = _band_voice(
                list(sonority.pitches), sonority.duration.quarterLength, window
            )
            folded_total += folded
            part.insert(sonority.offset, element)
        clefs[part_name] = clef_sign
        score.insert(0, part)

    stats: dict[str, Any] = {
        "skipped": skipped,
        "skip_reasons": skip_reasons,
        "clefs": clefs,
        "folded_notes": folded_total,
    }
    return score, stats
