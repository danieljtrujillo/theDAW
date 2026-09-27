"""Which pitch a MusicXML sheet holds: written, or the pitch that sounds.

MusicXML stores a part for a transposing instrument at written pitch, with a
``<transpose>`` from the page to the sound, and music21 reads every MusicXML
part that way (``atSoundingPitch`` False).

Older builds of theDAW wrote MAKE SHEET's MIDI parts at the pitch they sound
under that ``<transpose>``: music21's MIDI reader leaves ``atSoundingPitch`` as
``'unknown'``, and its writer moves only a part marked as sounding to written
pitch. A clarinet, horn, trumpet, saxophone, English horn, piccolo, contrabass
or banjo part on such a sheet reads a transposition off.

Every sheet this build writes carries ``<miscellaneous-field
name="thedaw-pitch">written</miscellaneous-field>`` (:func:`stamp_written_pitch`).
A sheet that music21 encoded, that carries a ``<transpose>`` and has no stamp is
one of those older sheets: in every flow the app offered that wrote a
music21 MusicXML with a transposing part, the part came from a MIDI. The
whole-sheet XML of a MusicXML artifact is a plain download and a one-part XML
is cut from the XML itself, so neither was re-encoded by music21, and an
arrangement's parts carry no instrument. :func:`mark_legacy_sounding_pitch`
marks such a score as sounding pitch, so music21's ``toSoundingPitch`` leaves
it alone and ``toWrittenPitch`` moves it to the pitch its ``<transpose>``
states.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

PITCH_FIELD = "thedaw-pitch"
WRITTEN = "written"

_MUSICXML_SUFFIXES = (".musicxml", ".xml")
_TRANSPOSE_RE = re.compile(rb"<transpose[\s>]")
_MUSIC21_RE = re.compile(rb"<software>\s*music21")
_STAMP_RE = re.compile(rb"<miscellaneous-field\s+name=\"" + PITCH_FIELD.encode())


def stamp_written_pitch(score: Any) -> None:
    """Record on ``score``'s metadata that its parts are at written pitch, as
    music21's writer leaves every part it writes. The writer emits the record
    as a ``<miscellaneous-field>``, which music21 reads back as custom
    metadata, so a sheet re-read and re-written keeps one stamp."""
    from music21 import metadata

    if score.metadata is None:
        score.insert(0, metadata.Metadata())
    score.metadata.setCustom(PITCH_FIELD, WRITTEN)


def legacy_sounding_pitch(path: Path) -> bool:
    """True for a sheet an older build wrote with transposing parts at the pitch
    they sound: an uncompressed MusicXML encoded by music21, carrying a
    ``<transpose>`` and no :data:`PITCH_FIELD` stamp."""
    if Path(path).suffix.lower() not in _MUSICXML_SUFFIXES:
        return False
    try:
        data = Path(path).read_bytes()
    except OSError as exc:
        log.debug("sheet_pitch: could not read %s: %s", path, exc)
        return False
    return (
        _TRANSPOSE_RE.search(data) is not None
        and _MUSIC21_RE.search(data) is not None
        and _STAMP_RE.search(data) is None
    )


def mark_legacy_sounding_pitch(score: Any, path: Path) -> bool:
    """Mark ``score``, read from ``path``, and each of its parts as sounding
    pitch when :func:`legacy_sounding_pitch` says the file holds it. Returns
    whether it did."""
    if score is None or not legacy_sounding_pitch(path):
        return False
    score.atSoundingPitch = True
    for part in getattr(score, "parts", ()):
        part.atSoundingPitch = True
    return True
