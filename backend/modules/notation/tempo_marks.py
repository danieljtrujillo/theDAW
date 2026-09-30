"""Metronome marks the way an engraved sheet prints them.

A transcription declares the tempo it was measured at (129.1992446150832 BPM
for a beat-tracked drum stem), and every note's quarter-note offset is worked
out at that tempo. A sheet prints a whole number. MusicXML keeps the two apart:
``<metronome><per-minute>`` is the printed number and the same direction's
``<sound tempo>`` is the tempo that plays. music21 writes the first from
``MetronomeMark.number`` and the second from ``numberSounding``, so an engraved
mark carries the whole number as ``number`` and the measured tempo as
``numberSounding``.

music21 reads ``<sound tempo>`` only from a direction that has no
``<metronome>``, so a sheet read back has lost its sounding tempo.
:func:`restore_sounding_tempi` puts it back wherever the printed number is that
tempo rounded to a whole number, which is exactly what
:func:`engrave_tempo_marks` writes. A sheet whose printed number is anything
else keeps the printed number, as music21 reads it.
"""

from __future__ import annotations

import logging
import math
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)

_MUSICXML_SUFFIXES = (".musicxml", ".xml")
_COMPRESSED_MUSICXML_SUFFIX = ".mxl"


def printed_number(value: float) -> int:
    """The whole number a sheet prints for a tempo of ``value``; halves round up."""
    return int(math.floor(float(value) + 0.5))


def engrave_mark(mark: Any) -> None:
    """Print ``mark`` as a whole number and keep its exact value as the tempo
    that sounds. A mark that is already whole, or states no number, is left
    as it is."""
    number = getattr(mark, "number", None)
    if number is None or getattr(mark, "numberImplicit", False):
        return
    printed = printed_number(number)
    if printed <= 0 or printed == number:
        return
    if mark.numberSounding is None:
        mark.numberSounding = number
    mark.number = printed


def metronome_mark(bpm: float) -> Any:
    """A quarter-note ``MetronomeMark`` that prints ``bpm`` rounded to a whole
    number and sounds at ``bpm``."""
    from music21 import tempo

    mark = tempo.MetronomeMark(number=bpm)
    engrave_mark(mark)
    return mark


def engrave_tempo_marks(score: Any) -> Any:
    """Apply :func:`engrave_mark` to every metronome mark in ``score`` and
    return ``score``. Call it on a score just before it is written as MusicXML."""
    from music21 import tempo

    for mark in score.recurse().getElementsByClass(tempo.MetronomeMark):
        engrave_mark(mark)
    return score


def _musicxml_root(path: Path) -> Optional[ET.Element]:
    """The ``<score-partwise>`` element of a MusicXML file (plain or ``.mxl``),
    or None for any other file or one that cannot be read."""
    suffix = path.suffix.lower()
    try:
        if suffix in _MUSICXML_SUFFIXES:
            return ET.parse(str(path)).getroot()
        if suffix == _COMPRESSED_MUSICXML_SUFFIX:
            with zipfile.ZipFile(path) as archive:
                container = ET.fromstring(archive.read("META-INF/container.xml"))
                rootfile = next(
                    (
                        element.get("full-path")
                        for element in container.iter()
                        if element.tag.endswith("rootfile") and element.get("full-path")
                    ),
                    None,
                )
                if rootfile:
                    return ET.fromstring(archive.read(rootfile))
    except (ET.ParseError, OSError, KeyError, zipfile.BadZipFile) as exc:
        log.debug("tempo marks: could not read %s: %s", path, exc)
    return None


def _sounding_tempi(root: ET.Element) -> dict[tuple[int, float], set[float]]:
    """``(measure index in its part, printed number) -> {<sound tempo>}`` for
    every one-beat-unit metronome direction that also carries a sound tempo."""
    table: dict[tuple[int, float], set[float]] = {}
    for part in root.findall("part"):
        for index, measure in enumerate(part.findall("measure")):
            for direction in measure.findall("direction"):
                sound = direction.find("sound")
                sound_tempo = sound.get("tempo") if sound is not None else None
                metronomes = direction.findall("direction-type/metronome")
                if not sound_tempo or len(metronomes) != 1:
                    continue
                if len(metronomes[0].findall("beat-unit")) != 1:
                    continue
                try:
                    printed = float(metronomes[0].findtext("per-minute") or "")
                    sounding = float(sound_tempo)
                except ValueError:
                    continue
                if not (math.isfinite(printed) and math.isfinite(sounding)):
                    continue
                if printed > 0 and sounding > 0:
                    table.setdefault((index, printed), set()).add(sounding)
    return table


def restore_sounding_tempi(score: Any, source_path: Path) -> int:
    """Give each metronome mark music21 read from ``source_path`` the
    ``<sound tempo>`` of its own direction, when the mark's printed number is
    that tempo rounded to a whole number.

    A mark is matched to its direction by measure index and printed number.
    Returns how many marks now carry a sounding tempo. A source that is not
    MusicXML changes nothing.
    """
    root = _musicxml_root(Path(source_path))
    if root is None:
        return 0
    table = _sounding_tempi(root)
    if not table:
        return 0

    from music21 import stream, tempo

    restored = 0
    for part in getattr(score, "parts", None) or []:
        for index, measure in enumerate(part.getElementsByClass(stream.Measure)):
            for mark in measure.recurse().getElementsByClass(tempo.MetronomeMark):
                if mark.number is None or mark.numberSounding is not None:
                    continue
                values = table.get((index, float(mark.number)))
                if not values or len(values) != 1:
                    continue
                sounding = tempo.convertTempoByReferent(
                    next(iter(values)), 1.0, mark.referent.quarterLength
                )
                if sounding == mark.number or printed_number(sounding) != mark.number:
                    continue
                mark.numberSounding = sounding
                restored += 1
    return restored
