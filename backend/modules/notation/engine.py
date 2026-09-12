"""Symbolic notation conversion helpers.

This is the conversion backbone for the notation module. It makes MIDI
artifacts first-class notation artifacts and converts between symbolic
formats:

  - ``musicxml`` is produced directly by ``music21``.
  - ``abc`` is written by :mod:`.exporters.abc_writer`, because music21 parses
    ABC but cannot write it.
  - ``pdf`` and ``svg`` are engraved by either engraver: the frontend's
    OpenSheetMusicDisplay run headlessly via :mod:`.pdf_render` first (the
    engraver the SCORE tab draws with, so a downloaded sheet matches the one on
    screen and no MuseScore install is required), and the MuseScore CLI when
    that renderer is missing or its render fails. ``options["engine"]``
    ('osmd' | 'musescore') forces one. With neither present the target returns
    ``ok=False`` naming both options so callers degrade rather than raise.
  - ``notechart`` is the Unity flying-notation chart (timecode + spelled
    notes), written by :mod:`.exporters.notechart`.
  - ``beatsaber`` is a Beat Saber custom level (Info.dat + difficulty .dat +
    song.ogg, zipped) written by :mod:`.exporters.beatsaber` from the same
    note chart.
  - ``chordtrack`` (the CHORDS play-along document) is built by the router's
    ``/chords`` route through :mod:`.exporters.chordtrack`; it is listed here
    so the capabilities probe and the artifact kinds know about it.

A drum-kit MIDI (``is_drum`` instrument, or a ``midis`` row transcribed by the
``drum-onsets`` engine) is engraved as an unpitched percussion staff via
:mod:`.arrangers.percussion` instead of being parsed as pitches.

Any of musicxml / abc / pdf / svg / notechart can be scoped to a subset of the
sheet's parts with ``options["parts"]`` (indices in ``<part-list>`` order, the
order the SCORE tab lists them in): :func:`stage_parts` writes a MusicXML
holding only those parts beside the output and the normal converter runs on
that file, so one part exports to any format the whole sheet does.

Heavier engines (MT3, Audiveris, alphaTab tab export) belong behind the same
module/sidecar boundary and plug into ``convert_score`` later.
"""

from __future__ import annotations

import importlib.util
import logging
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, NamedTuple, Optional, Sequence

from backend.modules.library.db import LibraryDB

from . import pdf_render

log = logging.getLogger(__name__)

# The user is GANTASMO; sheets always carry a composer credit, so this is the
# floor when no artist is configured (Settings -> notation.artist).
DEFAULT_ARTIST = "GANTASMO"

# Media file extensions that must never appear in a sheet title (e.g. an
# imported track called "Foo.wav" should be titled "Foo"). Symbolic source
# extensions are included too so a MIDI-derived title is never "...mid".
_MEDIA_EXTENSIONS = (
    ".wav",
    ".mp3",
    ".flac",
    ".ogg",
    ".oga",
    ".m4a",
    ".aac",
    ".aif",
    ".aiff",
    ".opus",
    ".wma",
    ".alac",
    ".mp4",
    ".mov",
    ".webm",
    ".mkv",
    ".m4v",
    ".avi",
    ".mid",
    ".midi",
    ".musicxml",
    ".xml",
)

# music21's placeholders for an untitled fragment / unset composer.
_PLACEHOLDER_TITLES = frozenset({"music21 fragment", "music21"})

# Leading track numbers carried in from ripped/downloaded filenames:
# "04 - Song", "04. Song", "04_Song", "1-04 - Song", "[04] Song", "A4. Song".
# A separator after the number is REQUIRED, which is what keeps a title that
# genuinely opens on a number intact: "99 Luftballons", "7 Nation Army",
# "24K Magic" and "1979" carry no separator, so none of them match.
_TRACK_BRACKETED_RE = re.compile(
    r"^\s*[\[(]\s*(?:\d{1,2}[-.])?\d{1,3}\s*[\])]\s*[-–—._]*\s*"
)
_TRACK_NUMBERED_RE = re.compile(
    r"^\s*(?:(?:\d{1,2}[-.])?\d{1,3}|[A-Ha-h]\d{1,2})\s*[-–—._)]+\s*"
)
# A Unicode word character that is neither a digit nor an underscore, i.e. a
# letter in any script.
_HAS_LETTER_RE = re.compile(r"[^\W\d_]")


def strip_track_prefix(title: str) -> str:
    """Drop a leading track number from a song title.

    Bails out when the remainder carries no letters, so an all-numeric title
    survives whole (``1-800-273-8255``, ``24 - 7``).
    """
    stripped = _TRACK_NUMBERED_RE.sub("", _TRACK_BRACKETED_RE.sub("", title), count=1)
    if stripped != title and _HAS_LETTER_RE.search(stripped):
        return stripped.strip()
    return title


def clean_title(title: str) -> str:
    """Sanitize a song title for display + engraving.

    Drops a trailing media file extension (the user never wants ``.wav`` /
    ``.mp3`` on a sheet) and a leading track number ("04 - Song"), and treats
    music21's ``Music21 Fragment`` placeholder as empty. Returns ``""`` when
    nothing meaningful remains.
    """
    t = (title or "").strip()
    if not t:
        return ""
    low = t.lower()
    for ext in _MEDIA_EXTENSIONS:
        if low.endswith(ext):
            t = t[: -len(ext)].rstrip()
            break
    if t.strip().lower() in _PLACEHOLDER_TITLES:
        return ""
    return strip_track_prefix(t.strip())


def artist_name() -> str:
    """The global artist/composer name (Settings -> notation.artist), stamped
    onto every generated sheet as the composer credit. Falls back to
    :data:`DEFAULT_ARTIST` so a sheet is never credited to "Music21"."""
    try:
        from backend.modules.settings.router import get_store as get_settings_store

        section = get_settings_store().get_section("notation")
        name = str((section or {}).get("artist", "") or "").strip()
    except Exception:
        name = ""
    return name or DEFAULT_ARTIST


# Targets music21 can write directly from a parsed score. ABC is deliberately
# NOT here: music21's ConverterABC is input-only (registerOutputExtensions is
# empty and it defines no write()), so asking music21 for ABC silently wrote
# repr(stream) to the file and reported success. It routes to the local writer
# in exporters/abc_writer.py instead.
_MUSIC21_FORMATS = frozenset({"musicxml"})
# The engraved targets: what the MuseScore CLI CAN write, and equally what the
# headless OSMD renderer (pdf_render) writes. convert_score tries OSMD first
# for both, because it is the engraver the SCORE tab draws with, and falls
# back to MuseScore when OSMD is missing or fails; options["engine"] forces one.
_MUSESCORE_FORMATS = frozenset({"pdf", "svg"})
_ENGRAVE_ENGINES = ("osmd", "musescore")
# Formats that can be scoped to a subset of parts through options["parts"]
# (stage_parts filters the sheet, then the ordinary converter runs on it).
# beatsaber has its own part filter inside the level writer.
_PART_SCOPED_FORMATS = frozenset({"musicxml", "abc", "pdf", "svg", "notechart"})
# The Unity flying-notation chart (timecode + notes), written by exporters/notechart.
_NOTECHART_FORMATS = frozenset({"notechart"})
# Map an output format to the artifact ``kind`` stored in the DB.
_KIND_FOR_FORMAT = {
    "musicxml": "musicxml",
    "abc": "abc",
    "pdf": "pdf",
    "svg": "svg",
    "notechart": "notechart",
    "beatsaber": "beatsaber",
    "chordtrack": "chordtrack",
}
# The Beat Saber custom-level zip, written by exporters/beatsaber from a chart.
_BEATSABER_FORMATS = frozenset({"beatsaber"})
# What backend/modules/midi/drums.py stamps on the ``midis`` row (and the
# mirrored notation artifact) of a stem it transcribed as a drum kit. Kept as a
# literal so the notation engine never imports the librosa-backed transcriber.
_DRUM_MIDI_ENGINE = "drum-onsets"

MUSESCORE_DOWNLOAD_URL = "https://musescore.org/download"

# MuseScore CLI binary names on PATH, newest first.
_MUSESCORE_NAMES = (
    "MuseScore4",
    "MuseScore4.exe",
    "MuseScore3",
    "MuseScore3.exe",
    "mscore",
    "mscore4portable",
    "musescore",
    "musescore4",
    "MuseScore4Portable",
)


def _musescore_settings_path() -> str:
    """The MuseScore path the user chose in Settings (notation.musescore_path),
    or ``""``. Read like :func:`artist_name` reads the artist: never raises."""
    try:
        from backend.modules.settings.router import get_store as get_settings_store

        section = get_settings_store().get_section("notation")
        return str((section or {}).get("musescore_path", "") or "").strip()
    except Exception:
        return ""


def _musescore_install_candidates() -> list[Path]:
    """Where MuseScore lands when it is installed but not on PATH, per platform.

    Windows paths are built from the environment (%ProgramFiles% is not always
    ``C:\\Program Files``); the Store alias, scoop and chocolatey shims are
    included. Globs (``/opt/MuseScore*``, ``~/Downloads/MuseScore*.AppImage``)
    are expanded newest-first so a freshly downloaded AppImage wins.
    """
    home = Path.home()
    out: list[Path] = []
    if sys.platform == "win32":
        env = os.environ
        roots = [
            env.get("ProgramFiles", r"C:\Program Files"),
            env.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
        ]
        for root in roots:
            out.append(Path(root) / "MuseScore 4" / "bin" / "MuseScore4.exe")
            out.append(Path(root) / "MuseScore 3" / "bin" / "MuseScore3.exe")
        local = env.get("LOCALAPPDATA")
        if local:
            out.append(
                Path(local) / "Programs" / "MuseScore 4" / "bin" / "MuseScore4.exe"
            )
            out.append(Path(local) / "Microsoft" / "WindowsApps" / "MuseScore4.exe")
        profile = env.get("USERPROFILE")
        if profile:
            out.append(
                Path(profile)
                / "scoop"
                / "apps"
                / "musescore"
                / "current"
                / "bin"
                / "MuseScore4.exe"
            )
        program_data = env.get("ProgramData")
        if program_data:
            out.append(Path(program_data) / "chocolatey" / "bin" / "MuseScore4.exe")
        return out
    if sys.platform == "darwin":
        for base in (Path("/Applications"), home / "Applications"):
            for version in ("4", "3"):
                out.append(
                    base / f"MuseScore {version}.app" / "Contents" / "MacOS" / "mscore"
                )
        return out
    out += [
        Path("/usr/bin/mscore4portable"),
        Path("/snap/bin/musescore"),
        Path("/snap/bin/mscore"),
        Path("/var/lib/flatpak/exports/bin/org.musescore.MuseScore"),
        home / ".local/share/flatpak/exports/bin/org.musescore.MuseScore",
    ]
    globbed: list[Path] = []
    for pattern_root, pattern in (
        (Path("/opt"), "MuseScore*/bin/mscore*"),
        (home / "Applications", "MuseScore*.AppImage"),
        (home / "Downloads", "MuseScore*.AppImage"),
    ):
        try:
            globbed += [p for p in pattern_root.glob(pattern) if p.is_file()]
        except OSError:
            continue
    globbed.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return out + globbed


def musescore_command() -> Optional[list[str]]:
    """The argv prefix that runs the MuseScore CLI, or ``None`` when none is
    found.

    Search order: the ``MUSESCORE_BIN`` environment variable, the path chosen
    in Settings (notation.musescore_path), the CLI names on PATH, then the
    standard install locations for this platform. Every candidate must be an
    existing file. Detection is deliberately independent of music21's stored
    UserSettings, which can hold a stale or malformed path.
    """
    override = os.environ.get("MUSESCORE_BIN")
    if override and Path(override).is_file():
        return [override]
    chosen = _musescore_settings_path()
    if chosen and Path(chosen).expanduser().is_file():
        return [str(Path(chosen).expanduser())]
    for name in _MUSESCORE_NAMES:
        found = shutil.which(name)
        if found and Path(found).is_file():
            return [found]
    for candidate in _musescore_install_candidates():
        if candidate.is_file():
            return [str(candidate)]
    return None


def musescore_binary() -> Optional[str]:
    """The MuseScore executable's display path (the first element of
    :func:`musescore_command`), or ``None``."""
    command = musescore_command()
    return command[0] if command else None


def _musescore_version(binary: str) -> str:
    try:
        proc = subprocess.run(
            [binary, "--version"],
            capture_output=True,
            text=True,
            timeout=20,
            stdin=subprocess.DEVNULL,
        )
        text = (proc.stdout or proc.stderr or "unknown").strip()
        return text.splitlines()[0][:80] if text else "unknown"
    except (subprocess.TimeoutExpired, OSError):
        return "unknown"


def capabilities() -> dict[str, Any]:
    from .arrangers.guitar_tab import TUNINGS as TAB_TUNINGS
    from .arrangers.score_arrange import STYLES as ARRANGEMENT_STYLES

    from .exporters.beatsaber import find_ffmpeg

    musescore = musescore_binary()
    osmd = pdf_render.available()
    formats = [
        "midi",
        "musicxml",
        "abc",
        "json",
        "alphatex",
        "notechart",
        "beatsaber",
        "chordtrack",
    ]
    # PDF and SVG each come from EITHER engraver: the headless OSMD renderer
    # first (the SCORE tab's own engraver, so the sheet matches the screen),
    # MuseScore when OSMD is missing or fails. Either one present is enough to
    # offer both formats; `engravers` lists what is available, in the order
    # convert_score tries them, so the UI can say which engine will draw.
    engravers = [
        engine
        for engine, present in (("osmd", osmd["ok"]), ("musescore", musescore))
        if present
    ]
    if engravers:
        formats += ["pdf", "svg"]
    return {
        "ok": True,
        "music21": importlib.util.find_spec("music21") is not None,
        "musescore": musescore is not None,
        "musescore_path": musescore,
        "musescore_download_url": MUSESCORE_DOWNLOAD_URL,
        "osmd_pdf": osmd["ok"],
        "node": osmd["node"],
        "engravers": {"pdf": list(engravers), "svg": list(engravers)},
        "engines": {
            "midi_to_musicxml": "music21",
            "midi_to_tabs": "fretboard-dp",
            "midi_to_arrangement": "music21-arrange",
            "score_to_pdf": engravers[0] if engravers else None,
            "score_to_svg": engravers[0] if engravers else None,
            "score_to_notechart": "notechart",
            "score_to_beatsaber": "beatsaber",
            "chords": "chordtrack",
            "future": ["mt3-sidecar", "audiveris-sidecar", "guitarpro-export"],
        },
        "formats": formats,
        # song.ogg for a Beat Saber level needs ffmpeg; the UI shows the pack
        # card's audio status from this.
        "ffmpeg": find_ffmpeg() is not None,
        "tab_tunings": sorted(TAB_TUNINGS.keys()),
        # Low string first, MIDI numbers; the chord-diagram generator builds
        # shapes for any tuning listed here.
        "tab_tuning_pitches": {
            name: [int(p) for p in pitches] for name, pitches in TAB_TUNINGS.items()
        },
        "arrangement_styles": list(ARRANGEMENT_STYLES),
    }


def register_existing_midis(db: LibraryDB, entry_id: str) -> list[dict[str, Any]]:
    """Mirror legacy ``midis`` rows into ``notation_artifacts``.

    This preserves current MIDI APIs while making the new notation API useful
    immediately for entries that already have MIDI conversions.
    """
    created: list[dict[str, Any]] = []
    for midi in db.list_midis(entry_id):
        midi_id = str(midi.get("id") or "")
        midi_path = str(midi.get("midi_path") or "")
        if not midi_id or not midi_path:
            continue
        artifact_id = f"{midi_id}__artifact_midi"
        db.add_notation_artifact(
            artifact_id=artifact_id,
            entry_id=entry_id,
            kind="midi",
            path=midi_path,
            source_ref=str(midi.get("source_ref") or midi.get("source") or ""),
            engine=str(midi.get("engine") or ""),
            engine_version=str(midi.get("engine_version") or ""),
            metadata={
                "legacy_midi_id": midi_id,
                "notes_count": midi.get("notes_count"),
            },
        )
        created.append(db.get_notation_artifact(artifact_id) or {})
    return created


# Symbolic + engraved files recoverable from disk, mapped to the artifact
# ``kind`` the notation API serves them as.
_KIND_FOR_SUFFIX = {
    ".mid": "midi",
    ".midi": "midi",
    ".musicxml": "musicxml",
    ".xml": "musicxml",
    ".alphatex": "alphatex",
    ".abc": "abc",
    ".pdf": "pdf",
    ".svg": "svg",
}

# Double-extension JSON/zip payloads, matched on the lower-cased file name
# BEFORE the plain-suffix map (``.json`` alone is deliberately unmapped: an
# entry directory holds plenty of JSON that is not a notation artifact).
_KIND_FOR_COMPOUND_SUFFIX = (
    (".chordtrack.json", "chordtrack"),
    (".beatsaber.zip", "beatsaber"),
    (".notechart.json", "notechart"),
)

# Entry sub-directories that hold notation artifacts.
_ARTIFACT_SUBDIRS = ("notation", "midi")
# Beat Saber levels are written one directory deeper (notation/beatsaber/); the
# unzipped level folder beside each zip is skipped because it is not a file.
_ARTIFACT_NESTED_SUBDIRS = ("notation/beatsaber",)

# The timed lyrics document lives at the entry ROOT (``<entry>/lyrics.json``),
# not under notation/. It is recovered as its own kind under a fixed id so the
# lyrics workflow can rely on exactly one row per entry.
_LYRICS_FILENAME = "lyrics.json"
_LYRICS_KIND = "lyrics"


def lyrics_artifact_id(entry_id: str) -> str:
    """The one notation artifact id a recovered ``<entry>/lyrics.json`` gets."""
    return f"{entry_id}__lyrics__lyrics"


def _kind_and_stem_for_file(path: Path) -> tuple[Optional[str], str]:
    """Artifact ``kind`` and id stem for a file on disk, or ``(None, stem)``
    when the file is not a notation artifact."""
    name = path.name.lower()
    for suffix, kind in _KIND_FOR_COMPOUND_SUFFIX:
        if name.endswith(suffix):
            return kind, path.name[: -len(suffix)]
    return _KIND_FOR_SUFFIX.get(path.suffix.lower()), path.stem


def register_on_disk_artifacts(
    db: LibraryDB, entry_dir: Path, entry_id: str
) -> list[dict[str, Any]]:
    """Register notation artifacts present on disk but missing a DB row.

    Every conversion writes its file AND a ``notation_artifacts`` row, so the
    two normally stay in step. They come apart whenever a row is lost while the
    file survives (a rebuilt or restored ``library.db``, a hand-copied entry
    directory), and nothing recovered from that state: the only re-registration
    path, :func:`register_existing_midis`, mirrors the legacy ``midis`` table,
    so an empty table mirrors to nothing while real scores sit on disk and the
    SCORE tab shows the entry as having none.

    This walks the entry's own directories instead, making the files the source
    of truth. Artifact ids follow the same scheme ``_register_conversion`` uses
    and the insert is INSERT OR REPLACE, so repeat runs are a no-op and a later
    real conversion overwrites the recovered row rather than duplicating it.
    """
    # notation_artifacts.entry_id is a FOREIGN KEY onto entries(id), and the
    # library can surface records that have no row yet (a directory present on
    # disk that indexing has not committed). Inserting for one of those raises
    # IntegrityError and would abort a whole-library sweep partway through, so
    # skip an entry the DB does not know about and let indexing catch it later.
    if db.get_entry(entry_id) is None:
        return []
    recovered: list[dict[str, Any]] = []

    def _recover(artifact_id: str, kind: str, path: Path, source_dir: str) -> None:
        if db.get_notation_artifact(artifact_id) is not None:
            return
        db.add_notation_artifact(
            artifact_id=artifact_id,
            entry_id=entry_id,
            kind=kind,
            path=str(path),
            source_ref=str(path),
            engine="recovered-from-disk",
            engine_version="1",
            metadata={"recovered": True, "source_dir": source_dir},
        )
        row = db.get_notation_artifact(artifact_id)
        if row:
            recovered.append(row)

    for sub in _ARTIFACT_SUBDIRS + _ARTIFACT_NESTED_SUBDIRS:
        directory = entry_dir / sub
        if not directory.is_dir():
            continue
        for path in sorted(directory.iterdir()):
            if not path.is_file():
                continue
            kind, stem = _kind_and_stem_for_file(path)
            if kind is None:
                continue
            _recover(f"{entry_id}__{stem}__{kind}", kind, path, sub)

    lyrics = entry_dir / _LYRICS_FILENAME
    if lyrics.is_file():
        _recover(lyrics_artifact_id(entry_id), _LYRICS_KIND, lyrics, "")
    return recovered


def raw_midi_for(
    db: LibraryDB, source_ref: Optional[str]
) -> tuple[Optional[Path], str]:
    """The raw (unquantised) MIDI behind a notation source, if any.

    A chart or Beat Saber level built from a MusicXML sheet still wants the
    transcription's real onsets (``onsetSecRaw``), so this walks one step up the
    lineage: a ``musicxml`` artifact's ``source_ref`` is normally the ``midi``
    artifact it was engraved from. Returns ``(path, artifact_id)`` when that
    MIDI exists on disk, else ``(None, "")``.
    """
    if not source_ref:
        return None, ""
    art = db.get_notation_artifact(source_ref)
    if not art:
        return None, ""
    kind = str(art.get("kind") or "")
    if kind == "midi":
        path = Path(str(art.get("path") or ""))
        return (
            (path, str(art.get("id") or source_ref)) if path.is_file() else (None, "")
        )
    if kind == "musicxml":
        parent_ref = str(art.get("source_ref") or "")
        parent = db.get_notation_artifact(parent_ref) if parent_ref else None
        if parent and parent.get("kind") == "midi":
            path = Path(str(parent.get("path") or ""))
            if path.is_file():
                return path, str(parent.get("id") or parent_ref)
    return None, ""


def is_drum_source(db: LibraryDB, source_path: Path, source_ref: Optional[str]) -> bool:
    """True when a MIDI source should be engraved as a percussion staff.

    Either the file itself is a drum kit (``arrangers.percussion.is_drum_midi``:
    an ``is_drum`` instrument, or kit pitches in a drum-named file) or the
    ``midis`` row / mirrored notation artifact it came from was written by the
    ``drum-onsets`` transcriber. MusicXML sources are never drums here (their
    percussion clef is already in the file).
    """
    if source_path.suffix.lower() not in (".mid", ".midi"):
        return False
    if source_ref:
        try:
            art = db.get_notation_artifact(source_ref)
            if art and str(art.get("engine") or "") == _DRUM_MIDI_ENGINE:
                return True
            midi_row = db.get_midi(source_ref)
            if midi_row and str(midi_row.get("engine") or "") == _DRUM_MIDI_ENGINE:
                return True
        except Exception as exc:  # noqa: BLE001 - lineage lookup is best-effort
            log.debug(
                "notation: drum lineage lookup failed for %s: %s", source_ref, exc
            )
    from .arrangers.percussion import is_drum_midi

    return is_drum_midi(source_path)


_MUSICXML_SUFFIXES = (".musicxml", ".xml")


def _is_musicxml(path: Path) -> bool:
    return path.suffix.lower() in _MUSICXML_SUFFIXES


def _stage_musicxml(source_path: Path, scratch: Path, title: str) -> Path:
    """Write ``source_path`` (any music21-readable source, normally MIDI) as a
    MusicXML file at ``scratch``, titled + credited, and return ``scratch``.

    The engravers read MusicXML only. The file is written beside the caller's
    output and the caller removes it afterwards; it is never registered as an
    artifact, because a DB row must not point at a path that is then deleted.
    Raises on a music21 failure so the caller reports it.
    """
    from music21 import converter  # type: ignore[import]

    staged_score = converter.parse(str(source_path))
    clean = clean_title(title)
    if clean:
        try:
            from music21.metadata import Metadata  # type: ignore[import]

            if staged_score.metadata is None:
                staged_score.insert(0, Metadata())
            staged_score.metadata.title = clean
            staged_score.metadata.composer = artist_name()
        except Exception as exc:  # noqa: BLE001 - titling is best-effort
            log.debug("notation: staging title skipped: %s", exc)
    scratch.parent.mkdir(parents=True, exist_ok=True)
    staged_score.write("musicxml", fp=str(scratch))
    return scratch


class StagedParts(NamedTuple):
    """What :func:`stage_parts` produced: the filtered MusicXML, the title it
    was stamped with, and ``[{"index", "name"}]`` for the parts it kept."""

    path: Path
    title: str
    parts: list[dict[str, Any]]


def _part_list_names(root: ET.Element) -> list[str]:
    names: list[str] = []
    part_list = root.find("part-list")
    for score_part in part_list.findall("score-part") if part_list is not None else []:
        name = score_part.findtext("part-name") or score_part.findtext(
            "part-abbreviation"
        )
        names.append(" ".join((name or "").split()))
    return names


def part_names(source_path: Path) -> list[str]:
    """The ``<part-name>`` of every ``<score-part>`` of a MusicXML file, in
    ``<part-list>`` order (``""`` for an unnamed part); ``[]`` for a source
    that is not MusicXML or cannot be parsed. The router names a part-scoped
    export's file from this."""
    if not _is_musicxml(source_path):
        return []
    try:
        return _part_list_names(ET.parse(str(source_path)).getroot())
    except (ET.ParseError, OSError):
        return []


def stage_parts(
    source_path: Path,
    part_indices: Sequence[int],
    title: str = "",
    *,
    output_path: Path,
) -> StagedParts:
    """Write a MusicXML holding only the parts at ``part_indices`` beside
    ``output_path`` (``<stem>__parts_src.musicxml``) and return it.

    Indices count ``<score-part>`` entries of ``<part-list>`` in document
    order, which is the order the SCORE tab lists parts in
    (``parseMusicXmlPartList``) and the order music21's ``score.parts`` and the
    note chart's ``_parts_of`` walk. Out-of-range indices are dropped;
    ``ValueError`` when no part survives.

    The filtering is done on the XML itself rather than through a music21
    round trip, so the kept parts are engraved exactly as they are in the whole
    sheet: same spacing, same beaming, same layout hints. A source that is not
    MusicXML (a MIDI) is first staged through music21 by :func:`_stage_musicxml`.

    The title is ``clean_title(title)`` (the sheet's own ``<work-title>`` when
    that is empty) with `` · <Part name>`` appended when exactly one part is
    kept, so the engraved page says which part it is. The caller deletes the
    staged file in a ``finally`` and never registers it.
    """
    scratch = output_path.with_name(f"{output_path.stem}__parts_src.musicxml")
    midi_scratch: Optional[Path] = None
    try:
        source = source_path
        if not _is_musicxml(source_path):
            midi_scratch = output_path.with_name(
                f"{output_path.stem}__parts_midi_src.musicxml"
            )
            source = _stage_musicxml(source_path, midi_scratch, title)
        tree = ET.parse(str(source))
        root = tree.getroot()
        if root.tag != "score-partwise":
            raise ValueError(
                f"part-scoped export needs a partwise MusicXML score, got <{root.tag}>"
            )
        part_list = root.find("part-list")
        if part_list is None:
            raise ValueError("the MusicXML has no <part-list>")
        score_parts = part_list.findall("score-part")
        names = _part_list_names(root)
        wanted: list[int] = []
        for raw in part_indices:
            idx = int(raw)
            if 0 <= idx < len(score_parts) and idx not in wanted:
                wanted.append(idx)
        wanted.sort()
        if not wanted:
            raise ValueError(
                f"no part at index {list(part_indices)} in a sheet of "
                f"{len(score_parts)} part(s)"
            )
        keep_ids = {score_parts[i].get("id") or "" for i in wanted}

        # <part-group> brackets may enclose a part that is gone; drop them all
        # rather than leave a start with no stop (the bracket says nothing on
        # a one- or two-part sheet anyway).
        for child in list(part_list):
            if child.tag == "part-group":
                part_list.remove(child)
            elif child.tag == "score-part" and (child.get("id") or "") not in keep_ids:
                part_list.remove(child)
        for part in list(root.findall("part")):
            if (part.get("id") or "") not in keep_ids:
                root.remove(part)

        # Title: the song name (or the sheet's own) plus the part's name when
        # exactly one is kept. Composer = the configured artist, as every other
        # sheet is credited.
        work = root.find("work")
        existing = (
            " ".join((work.findtext("work-title") or "").split())
            if work is not None
            else ""
        )
        base = clean_title(title) or clean_title(existing)
        stamped = base
        if len(wanted) == 1 and names[wanted[0]]:
            stamped = f"{base} · {names[wanted[0]]}" if base else names[wanted[0]]
        if stamped:
            if work is None:
                work = ET.Element("work")
                root.insert(0, work)
            work_title = work.find("work-title")
            if work_title is None:
                work_title = ET.SubElement(work, "work-title")
            work_title.text = stamped
        identification = root.find("identification")
        if identification is None:
            # score-partwise orders: work, movement-number, movement-title,
            # identification, ... so it goes right after the last of those.
            identification = ET.Element("identification")
            after = -1
            for pos, child in enumerate(list(root)):
                if child.tag in ("work", "movement-number", "movement-title"):
                    after = pos
            root.insert(after + 1, identification)
        composer = next(
            (
                c
                for c in identification.findall("creator")
                if c.get("type") == "composer"
            ),
            None,
        )
        if composer is None:
            composer = ET.Element("creator", {"type": "composer"})
            identification.insert(0, composer)
        composer.text = artist_name()

        scratch.parent.mkdir(parents=True, exist_ok=True)
        tree.write(str(scratch), encoding="UTF-8", xml_declaration=True)
        kept = [{"index": i, "name": names[i]} for i in wanted]
        return StagedParts(scratch, stamped, kept)
    finally:
        if midi_scratch is not None:
            midi_scratch.unlink(missing_ok=True)


_stage_parts = stage_parts


def _requested_parts(options: Optional[dict[str, Any]]) -> list[int]:
    """``options["parts"]`` as ints, or ``[]`` (absent, empty, or not a list)."""
    parts = (options or {}).get("parts")
    if not isinstance(parts, list) or not parts:
        return []
    out: list[int] = []
    for p in parts:
        try:
            out.append(int(p))
        except (TypeError, ValueError):
            continue
    return out


def convert_score(
    db: LibraryDB,
    *,
    entry_id: str,
    source_path: Path,
    fmt: str,
    output_path: Path,
    source_ref: Optional[str] = None,
    artifact_id: Optional[str] = None,
    title: str = "",
    options: Optional[dict[str, Any]] = None,
    audio_path: Optional[Path] = None,
    audio_duration_sec: Optional[float] = None,
    analysis_bpm: Optional[float] = None,
) -> dict[str, Any]:
    """Convert a symbolic source (MIDI or MusicXML) to another notation format
    and register the result as a notation artifact.

    ``music21`` handles ``musicxml`` directly and ``abc`` is written by
    :mod:`.exporters.abc_writer` (music21 cannot write ABC). ``pdf`` and
    ``svg`` are engraved by the headless OSMD renderer (:mod:`.pdf_render`)
    first and by the MuseScore CLI when that renderer is missing or fails
    (``options["engine"]`` forces one); with neither present they return
    ``ok=False`` naming both rather than raising. When ``title`` is given it is
    stamped on the score so the rendered sheet shows the originating song's
    name.

    ``options["parts"]`` (indices in ``<part-list>`` order) scopes
    musicxml / abc / pdf / svg / notechart to those parts: the sheet is
    filtered by :func:`stage_parts`, the converter runs on the staged file, and
    the artifact's metadata records ``parts: [{"index", "name"}]``. The staged
    file is removed afterwards and never registered. ``beatsaber`` applies its
    own part filter inside the level writer.

    The other ``options`` (per-format export options), ``audio_path``,
    ``audio_duration_sec`` and ``analysis_bpm`` are consumed by the chart-based
    targets (``notechart``, ``beatsaber``); the other formats ignore them.
    """
    fmt = fmt.lower().strip()
    if not source_path.is_file():
        return {"ok": False, "error": f"source not found: {source_path}"}

    parts = _requested_parts(options)
    if parts and fmt in _PART_SCOPED_FORMATS:
        if importlib.util.find_spec("music21") is None and not _is_musicxml(
            source_path
        ):
            return {"ok": False, "error": "music21 is not installed."}
        try:
            staged = stage_parts(source_path, parts, title, output_path=output_path)
        except Exception as exc:  # noqa: BLE001 - report, never raise into the route
            log.warning("notation: part staging failed for %s: %s", source_path, exc)
            return {"ok": False, "engine": "music21", "error": str(exc) or repr(exc)}
        try:
            if fmt == "musicxml":
                # The staged sheet IS the export: move it into place.
                output_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(staged.path), str(output_path))
                return _register_conversion(
                    db,
                    entry_id=entry_id,
                    fmt="musicxml",
                    final_path=output_path,
                    source_path=source_path,
                    source_ref=source_ref,
                    artifact_id=artifact_id,
                    engine="music21",
                    engine_version=_music21_version(),
                    extra_metadata={"parts": staged.parts},
                )
            result = _convert_one(
                db,
                entry_id=entry_id,
                source_path=staged.path,
                fmt=fmt,
                output_path=output_path,
                source_ref=source_ref,
                artifact_id=artifact_id,
                title=staged.title,
                options=options,
                audio_path=audio_path,
                audio_duration_sec=audio_duration_sec,
                analysis_bpm=analysis_bpm,
                register_source=source_path,
                extra_metadata={"parts": staged.parts},
            )
        finally:
            staged.path.unlink(missing_ok=True)
        return result

    return _convert_one(
        db,
        entry_id=entry_id,
        source_path=source_path,
        fmt=fmt,
        output_path=output_path,
        source_ref=source_ref,
        artifact_id=artifact_id,
        title=title,
        options=options,
        audio_path=audio_path,
        audio_duration_sec=audio_duration_sec,
        analysis_bpm=analysis_bpm,
    )


def _music21_version() -> str:
    try:
        import music21  # type: ignore[import]

        return str(getattr(music21, "__version__", "unknown"))
    except ImportError:
        return "unknown"


def _convert_one(
    db: LibraryDB,
    *,
    entry_id: str,
    source_path: Path,
    fmt: str,
    output_path: Path,
    source_ref: Optional[str],
    artifact_id: Optional[str],
    title: str,
    options: Optional[dict[str, Any]],
    audio_path: Optional[Path],
    audio_duration_sec: Optional[float],
    analysis_bpm: Optional[float],
    register_source: Optional[Path] = None,
    extra_metadata: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Route one (already staged, if part-scoped) source to its converter.

    ``register_source`` is the path the artifact's ``metadata.source`` and
    lineage relation record when ``source_path`` is a staging file; the
    converters otherwise record the file they read.
    """
    if fmt == "abc":
        return _convert_to_abc(
            db,
            entry_id=entry_id,
            source_path=source_path,
            output_path=output_path,
            source_ref=source_ref,
            artifact_id=artifact_id,
            title=title,
            register_source=register_source,
            extra_metadata=extra_metadata,
        )
    if fmt in _MUSIC21_FORMATS:
        return _convert_with_music21(
            db,
            entry_id=entry_id,
            source_path=source_path,
            fmt=fmt,
            output_path=output_path,
            source_ref=source_ref,
            artifact_id=artifact_id,
            title=title,
        )
    if fmt in _MUSESCORE_FORMATS:
        return _engrave(
            db,
            fmt=fmt,
            entry_id=entry_id,
            source_path=source_path,
            output_path=output_path,
            source_ref=source_ref,
            artifact_id=artifact_id,
            title=title,
            options=options,
            register_source=register_source,
            extra_metadata=extra_metadata,
        )
    if fmt in _NOTECHART_FORMATS:
        return _convert_to_notechart(
            db,
            entry_id=entry_id,
            source_path=source_path,
            output_path=output_path,
            source_ref=source_ref,
            artifact_id=artifact_id,
            title=title,
            audio_duration_sec=audio_duration_sec,
            register_source=register_source,
            extra_metadata=extra_metadata,
        )
    if fmt in _BEATSABER_FORMATS:
        return _convert_to_beatsaber(
            db,
            entry_id=entry_id,
            source_path=source_path,
            output_path=output_path,
            source_ref=source_ref,
            artifact_id=artifact_id,
            title=title,
            options=options,
            audio_path=audio_path,
            audio_duration_sec=audio_duration_sec,
            analysis_bpm=analysis_bpm,
        )
    return {"ok": False, "error": f"unsupported notation format: {fmt!r}"}


_ENGRAVE_NOTHING_HINT = (
    "needs the OSMD renderer (node + frontend dependencies) or MuseScore "
    f"(install MuseScore 4 from {MUSESCORE_DOWNLOAD_URL}, set the MuseScore "
    "path in Settings, or set MUSESCORE_BIN)"
)


def _engrave(
    db: LibraryDB,
    *,
    fmt: str,
    entry_id: str,
    source_path: Path,
    output_path: Path,
    source_ref: Optional[str] = None,
    artifact_id: Optional[str] = None,
    title: str = "",
    options: Optional[dict[str, Any]] = None,
    register_source: Optional[Path] = None,
    extra_metadata: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Engrave a PDF or SVG: the frontend's OSMD first (the engraver the SCORE
    tab draws with), MuseScore when OSMD is unavailable or its render fails.

    ``options["engine"]`` ('osmd' | 'musescore') pins one engraver; an
    unavailable pinned engraver is an error, not a silent switch. Both
    engravers read MusicXML only, so a MIDI source is staged through music21
    first. That staging file is written beside the output and removed
    afterwards, and it is deliberately NOT registered as an artifact:
    registering it would leave a DB row pointing at a path this function then
    deletes.
    """
    forced = str((options or {}).get("engine") or "").lower().strip() or None
    if forced is not None and forced not in _ENGRAVE_ENGINES:
        return {
            "ok": False,
            "engine": forced,
            "error": f"unknown engraver {forced!r}; use one of {_ENGRAVE_ENGINES}",
        }
    osmd_ok = bool(pdf_render.available()["ok"])
    musescore = musescore_command()
    try_osmd = forced in (None, "osmd") and osmd_ok
    try_musescore = forced in (None, "musescore") and musescore is not None
    if not try_osmd and not try_musescore:
        if forced == "osmd":
            error = f"the OSMD renderer is unavailable: {pdf_render.available()}"
        elif forced == "musescore":
            error = _MUSESCORE_NOT_FOUND
        else:
            error = f"{fmt.upper()} export {_ENGRAVE_NOTHING_HINT}"
        return {"ok": False, "engine": forced or "osmd", "error": error}

    source = source_path
    scratch: Optional[Path] = None
    if not _is_musicxml(source_path):
        if importlib.util.find_spec("music21") is None:
            return {"ok": False, "engine": "osmd", "error": "music21 is not installed."}
        scratch = output_path.with_name(f"{output_path.stem}__osmd_src.musicxml")
        try:
            source = _stage_musicxml(source_path, scratch, title)
        except Exception as exc:  # noqa: BLE001
            log.warning("notation: %s staging failed for %s: %s", fmt, source_path, exc)
            return {"ok": False, "engine": "osmd", "error": repr(exc)}

    try:
        errors: list[str] = []
        if try_osmd:
            render = (
                pdf_render.render_musicxml_pdf
                if fmt == "pdf"
                else pdf_render.render_musicxml_svg
            )
            result = render(source, output_path, artist=artist_name())
            if result.get("ok"):
                registered = _register_conversion(
                    db,
                    entry_id=entry_id,
                    fmt=fmt,
                    final_path=output_path,
                    source_path=register_source or source_path,
                    source_ref=source_ref,
                    artifact_id=artifact_id,
                    engine="osmd",
                    engine_version=pdf_render.renderer_version(),
                    extra_metadata=extra_metadata,
                )
                registered["pages"] = result.get("pages", 0)
                return registered
            errors.append(f"OSMD: {result.get('error') or 'render failed'}")
            if try_musescore:
                log.warning(
                    "notation: OSMD %s render failed for %s, trying MuseScore: %s",
                    fmt,
                    source_path,
                    errors[-1],
                )
        if try_musescore:
            result = _convert_with_musescore(
                db,
                entry_id=entry_id,
                source_path=source,
                fmt=fmt,
                output_path=output_path,
                source_ref=source_ref,
                artifact_id=artifact_id,
                register_source=register_source or source_path,
                extra_metadata=extra_metadata,
            )
            if result.get("ok"):
                return result
            errors.append(f"MuseScore: {result.get('error') or 'render failed'}")
        return {
            "ok": False,
            "engine": "osmd" if try_osmd else "musescore",
            "error": "; ".join(errors)
            or f"{fmt.upper()} export {_ENGRAVE_NOTHING_HINT}",
        }
    finally:
        if scratch is not None:
            scratch.unlink(missing_ok=True)


def _convert_to_pdf(db: LibraryDB, **kwargs: Any) -> dict[str, Any]:
    """Engrave a PDF: OSMD first, MuseScore second (see :func:`_engrave`)."""
    return _engrave(db, fmt="pdf", **kwargs)


def _convert_to_svg(db: LibraryDB, **kwargs: Any) -> dict[str, Any]:
    """Engrave an SVG (page 1; MuseScore writes ``<stem>-N.svg`` per page,
    OSMD the same): OSMD first, MuseScore second (see :func:`_engrave`)."""
    return _engrave(db, fmt="svg", **kwargs)


def _convert_to_notechart(
    db: LibraryDB,
    *,
    entry_id: str,
    source_path: Path,
    output_path: Path,
    source_ref: Optional[str] = None,
    artifact_id: Optional[str] = None,
    title: str = "",
    audio_duration_sec: Optional[float] = None,
    register_source: Optional[Path] = None,
    extra_metadata: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Write the Unity flying-notation chart (timecode + spelled notes).

    When the source is a MusicXML sheet engraved from a MIDI artifact, that
    MIDI is handed to the chart builder so every event also carries its raw
    (unquantised) onset — what the play-along judge and Beat Saber map against.
    ``register_source`` / ``extra_metadata`` come from a part-scoped export
    (the chart was built from a staged file; the artifact records the sheet).
    """
    try:
        from .exporters.notechart import write_notechart

        raw_midi_path, raw_midi_artifact_id = raw_midi_for(db, source_ref)
        result = write_notechart(
            source_path,
            output_path,
            title=clean_title(title),
            artist=artist_name(),
            entry_id=entry_id,
            audio_duration_sec=audio_duration_sec,
            source_artifact_id=source_ref or "",
            raw_midi_path=raw_midi_path,
            raw_midi_artifact_id=raw_midi_artifact_id,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("notation: notechart export failed for %s: %s", source_path, exc)
        return {"ok": False, "engine": "notechart", "error": repr(exc)}
    if not result.get("ok"):
        return {"ok": False, "engine": "notechart", **result}

    registered = _register_conversion(
        db,
        entry_id=entry_id,
        fmt="notechart",
        final_path=output_path,
        source_path=register_source or source_path,
        source_ref=source_ref,
        artifact_id=artifact_id,
        engine="notechart",
        engine_version="1",
        extra_metadata=extra_metadata,
    )
    registered["stats"] = result.get("stats", {})
    return registered


# Info.dat's ``_version`` for the levels this engine writes; also the artifact's
# engine_version so a later map-format change is visible per artifact.
BEATSABER_ENGINE_VERSION = "2.0.0"
DEFAULT_BEATSABER_DIFFICULTIES = ("Normal", "Hard")


def _first_tempo_bpm(chart: dict[str, Any]) -> float:
    """The chart's first tempo-map BPM (120 when the chart carries none)."""
    for entry in chart.get("tempoMap") or []:
        try:
            bpm = float(entry.get("bpm") or 0.0)
        except (TypeError, ValueError, AttributeError):
            continue
        if bpm > 0:
            return bpm
    return 120.0


def _convert_to_beatsaber(
    db: LibraryDB,
    *,
    entry_id: str,
    source_path: Path,
    output_path: Path,
    source_ref: Optional[str] = None,
    artifact_id: Optional[str] = None,
    title: str = "",
    options: Optional[dict[str, Any]] = None,
    audio_path: Optional[Path] = None,
    audio_duration_sec: Optional[float] = None,
    analysis_bpm: Optional[float] = None,
) -> dict[str, Any]:
    """Write a Beat Saber custom level (zip) from a MIDI/MusicXML source.

    The note chart is built in memory (the same document ``notechart`` writes,
    so the web HIGHWAY's 'blocks' skin and the level agree note for note) and
    handed to :func:`.exporters.beatsaber.write_beatsaber`. Info.dat carries ONE
    constant BPM: the analysis BPM by default (``bpm_source`` 'analysis') so the
    in-game grid matches the recording, else the chart's first tempo.
    """
    opts = dict(options or {})
    try:
        from .exporters.beatsaber import write_beatsaber
        from .exporters.notechart import build_notechart

        raw_midi_path, raw_midi_artifact_id = raw_midi_for(db, source_ref)
        clean = clean_title(title)
        chart = build_notechart(
            source_path,
            title=clean,
            artist=artist_name(),
            entry_id=entry_id,
            audio_duration_sec=audio_duration_sec,
            source_artifact_id=source_ref or "",
            raw_midi_path=raw_midi_path,
            raw_midi_artifact_id=raw_midi_artifact_id,
        )
    except Exception as exc:  # noqa: BLE001 - report, never raise into the route
        log.warning(
            "notation: beatsaber chart build failed for %s: %s", source_path, exc
        )
        return {"ok": False, "engine": "beatsaber", "error": repr(exc)}

    bpm_source = str(opts.get("bpm_source") or "analysis").lower().strip()
    chart_bpm = _first_tempo_bpm(chart)
    if bpm_source == "analysis" and analysis_bpm and float(analysis_bpm) > 0:
        bpm = float(analysis_bpm)
    else:
        bpm = chart_bpm
        bpm_source = "chart"
    try:
        version = int(opts.get("version") or 2)
    except (TypeError, ValueError):
        version = 2
    difficulties = opts.get("difficulties") or list(DEFAULT_BEATSABER_DIFFICULTIES)
    parts = opts.get("parts")
    part_indices: Optional[list[int]] = None
    if isinstance(parts, list) and parts:
        part_indices = [int(p) for p in parts]

    result = write_beatsaber(
        chart,
        output_path,
        song_name=clean or "Untitled",
        artist=artist_name(),
        bpm=bpm,
        bpm_source=bpm_source,
        difficulties=[str(d) for d in difficulties],
        version=version,
        audio_path=audio_path,
        include_audio=bool(opts.get("include_audio", True)),
        part_indices=part_indices,
    )
    if not result.get("ok"):
        return {"ok": False, "engine": "beatsaber", **result}

    extra = {
        key: result.get(key)
        for key in (
            "difficulties",
            "note_counts",
            "bpm",
            "bpm_source",
            "version",
            "song_ogg",
            "warning",
            "parts",
            "folder",
        )
    }
    extra["chart_bpm"] = chart_bpm
    registered = _register_conversion(
        db,
        entry_id=entry_id,
        fmt="beatsaber",
        final_path=Path(result.get("path") or output_path),
        source_path=source_path,
        source_ref=source_ref,
        artifact_id=artifact_id,
        engine="beatsaber",
        engine_version=BEATSABER_ENGINE_VERSION,
        extra_metadata=extra,
    )
    registered.update(extra)
    return registered


def _convert_to_abc(
    db: LibraryDB,
    *,
    entry_id: str,
    source_path: Path,
    output_path: Path,
    source_ref: Optional[str] = None,
    artifact_id: Optional[str] = None,
    title: str = "",
    register_source: Optional[Path] = None,
    extra_metadata: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Write ABC from a symbolic source using the local ABC writer.

    music21 parses the source; the text is produced by
    :func:`.exporters.abc_writer.score_to_abc` because music21 has no ABC
    writer. A score with no notes raises rather than registering an empty file.
    ``register_source`` / ``extra_metadata`` come from a part-scoped export.
    """
    if importlib.util.find_spec("music21") is None:
        return {
            "ok": False,
            "engine": "abc-writer",
            "error": "music21 is not installed.",
            "hint": "uv sync --group dev",
        }
    try:
        from music21 import converter  # type: ignore[import]

        from .exporters.abc_writer import score_to_abc

        score = converter.parse(str(source_path))
        try:
            score = score.quantize((4, 3), inPlace=False, recurse=True)
        except Exception as exc:  # noqa: BLE001 - quantize is best-effort
            log.debug("notation: abc quantize skipped for %s: %s", source_path, exc)
        text = score_to_abc(
            score,
            title=clean_title(title),
            composer=artist_name(),
        )
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(text, encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        log.warning("notation: abc export failed for %s: %s", source_path, exc)
        return {"ok": False, "engine": "abc-writer", "error": repr(exc)}

    return _register_conversion(
        db,
        entry_id=entry_id,
        fmt="abc",
        final_path=output_path,
        source_path=register_source or source_path,
        source_ref=source_ref,
        artifact_id=artifact_id,
        engine="abc-writer",
        engine_version="1",
        extra_metadata=extra_metadata,
    )


def _convert_with_music21(
    db: LibraryDB,
    *,
    entry_id: str,
    source_path: Path,
    fmt: str,
    output_path: Path,
    source_ref: Optional[str],
    artifact_id: Optional[str],
    title: str = "",
) -> dict[str, Any]:
    try:
        from music21 import converter  # type: ignore[import]
        import music21  # type: ignore[import]
    except ImportError:
        return {
            "ok": False,
            "engine": "music21",
            "error": "music21 is not installed. Install it to enable symbolic export.",
        }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    percussion = False
    try:
        if is_drum_source(db, source_path, source_ref):
            # A kit MIDI parsed as pitches puts the kick on F2 and the hat on
            # F#3 — pitched garbage. Engrave it as an unpitched percussion staff
            # (PercussionClef + <unpitched> hits with x heads); the helper already
            # quantises to 1/16, so no second quantize pass.
            from .arrangers.percussion import build_percussion_score

            percussion = True
            score = build_percussion_score(source_path, title=clean_title(title))
        else:
            score = converter.parse(str(source_path))
            if score is None:
                raise ValueError(f"music21 could not parse {source_path}")
            # Quantize raw transcriptions to clean, notatable rhythms. Best-effort.
            try:
                score = score.quantize((4, 3), inPlace=False, recurse=True)
            except Exception as exc:  # noqa: BLE001 - quantize is best-effort
                log.debug(
                    "notation: music21 quantize skipped for %s: %s", source_path, exc
                )
        if score is None:
            raise ValueError(f"music21 quantize produced no score for {source_path}")
        # Stamp the originating song's name (and the artist as composer) so the
        # engraved sheet is titled + credited — raw MIDI carries neither, which
        # is why untitled sheets showed music21's "Music21 Fragment" placeholder
        # and a "Music21" composer. The composer is ALWAYS overwritten (never
        # left as music21's default); the title drops any media extension.
        clean = clean_title(title)
        composer = artist_name()
        try:
            from music21.metadata import Metadata  # type: ignore[import]

            md = score.metadata
            if md is None:
                md = Metadata()
                score.insert(0, md)
            # Only the work title (song name); deliberately NOT movementName.
            # music21 writes title -> <work-title> AND movementName ->
            # <movement-title>; OSMD (and MuseScore) render work-title as the
            # Title and movement-title as the Subtitle, so setting both to the
            # song name prints the title twice. The artist is the composer; the
            # viewer places it under the title via the subtitle slot.
            if clean:
                md.title = clean
            md.composer = composer
        except Exception as exc:  # noqa: BLE001 - titling is best-effort
            log.debug("notation: could not set title on %s: %s", output_path, exc)
        written = score.write(fmt, fp=str(output_path))
    except Exception as exc:  # noqa: BLE001
        log.warning("notation: %s export failed for %s: %s", fmt, source_path, exc)
        return {"ok": False, "engine": "music21", "error": repr(exc)}

    final_path = Path(written) if written else output_path
    return _register_conversion(
        db,
        entry_id=entry_id,
        fmt=fmt,
        final_path=final_path,
        source_path=source_path,
        source_ref=source_ref,
        artifact_id=artifact_id,
        engine="music21",
        engine_version=str(getattr(music21, "__version__", "unknown")),
        extra_metadata={"percussion": True} if percussion else None,
    )


_MUSESCORE_NOT_FOUND = (
    f"MuseScore was not found. Install MuseScore 4 ({MUSESCORE_DOWNLOAD_URL}), "
    "set the MuseScore path in Settings, or set MUSESCORE_BIN."
)


def _convert_with_musescore(
    db: LibraryDB,
    *,
    entry_id: str,
    source_path: Path,
    fmt: str,
    output_path: Path,
    source_ref: Optional[str],
    artifact_id: Optional[str],
    register_source: Optional[Path] = None,
    extra_metadata: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Engrave ``fmt`` ("pdf" or "svg") with the MuseScore CLI.

    ``register_source`` is what the artifact records as its source when
    ``source_path`` is a staging file (a MIDI staged as MusicXML, or a
    part-filtered sheet) that the caller deletes afterwards.
    """
    if fmt not in _MUSESCORE_FORMATS:
        return {
            "ok": False,
            "engine": "musescore",
            "error": f"MuseScore engraves {sorted(_MUSESCORE_FORMATS)}, not {fmt!r}",
        }
    command = musescore_command()
    if command is None:
        return {"ok": False, "engine": "musescore", "error": _MUSESCORE_NOT_FOUND}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    try:
        proc = subprocess.run(
            [*command, "-o", str(output_path), str(source_path)],
            capture_output=True,
            text=True,
            timeout=180,
            stdin=subprocess.DEVNULL,
            creationflags=creationflags,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        return {"ok": False, "engine": "musescore", "error": repr(exc)}

    final_path = output_path
    # MuseScore paginates SVG output as ``<stem>-1.svg``; take the first page.
    if fmt == "svg" and not final_path.is_file():
        paged = output_path.with_name(f"{output_path.stem}-1{output_path.suffix}")
        if paged.is_file():
            final_path = paged
    if proc.returncode != 0 or not final_path.is_file():
        detail = (proc.stderr or proc.stdout or "musescore produced no output").strip()
        return {"ok": False, "engine": "musescore", "error": detail[-400:]}

    return _register_conversion(
        db,
        entry_id=entry_id,
        fmt=fmt,
        final_path=final_path,
        source_path=register_source or source_path,
        source_ref=source_ref,
        artifact_id=artifact_id,
        engine="musescore",
        engine_version=_musescore_version(command[0]),
        extra_metadata=extra_metadata,
    )


def _register_conversion(
    db: LibraryDB,
    *,
    entry_id: str,
    fmt: str,
    final_path: Path,
    source_path: Path,
    source_ref: Optional[str],
    artifact_id: Optional[str],
    engine: str,
    engine_version: str,
    extra_metadata: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    kind = _KIND_FOR_FORMAT.get(fmt, fmt)
    art_id = artifact_id or f"{entry_id}__{final_path.stem}__{kind}"
    metadata: dict[str, Any] = {"source": str(source_path), "format": fmt}
    if extra_metadata:
        # Per-format facts the SCORE tab's cards read (Beat Saber difficulties,
        # note counts, song.ogg status ...). ``source``/``format`` always win.
        metadata = {**extra_metadata, **metadata}
    db.add_notation_artifact(
        artifact_id=art_id,
        entry_id=entry_id,
        kind=kind,
        path=str(final_path),
        source_ref=source_ref or str(source_path),
        engine=engine,
        engine_version=engine_version,
        metadata=metadata,
    )
    db.add_relation(
        from_id=source_ref or str(source_path),
        to_id=art_id,
        kind="rendered_as_notation",
        metadata={"format": fmt, "engine": engine},
    )
    return {
        "ok": True,
        "artifact": db.get_notation_artifact(art_id),
        "path": str(final_path),
        "engine": engine,
    }


def midi_to_musicxml(
    db: LibraryDB,
    *,
    entry_id: str,
    midi_path: Path,
    output_path: Path,
    source_ref: Optional[str] = None,
    artifact_id: Optional[str] = None,
    title: str = "",
) -> dict[str, Any]:
    """Convert a MIDI file to MusicXML and register the artifact.

    Retained for backwards compatibility with the original ``from-midi``
    route; it delegates to :func:`convert_score`. New callers should prefer
    ``convert_score`` directly so they can target any supported format.
    """
    if not midi_path.is_file():
        return {"ok": False, "error": f"midi not found: {midi_path}"}
    return convert_score(
        db,
        entry_id=entry_id,
        source_path=midi_path,
        fmt="musicxml",
        output_path=output_path,
        source_ref=source_ref,
        artifact_id=artifact_id,
        title=title,
    )


def midi_to_tabs(
    db: LibraryDB,
    *,
    entry_id: str,
    midi_path: Path,
    output_path: Path,
    instrument: str = "guitar",
    tuning: Optional[list[int]] = None,
    tuning_name: Optional[str] = None,
    capo: int = 0,
    difficulty: str = "medium",
    title: str = "",
    source_ref: Optional[str] = None,
    artifact_id: Optional[str] = None,
) -> dict[str, Any]:
    """Arrange a MIDI file into tablature, write alphaTex, and register it as a
    notation artifact of kind ``alphatex``."""
    from .arrangers.guitar_tab import arrange_tabs

    if not midi_path.is_file():
        return {"ok": False, "error": f"midi not found: {midi_path}"}

    result = arrange_tabs(
        midi_path,
        instrument=instrument,
        tuning=tuning,
        tuning_name=tuning_name,
        capo=capo,
        difficulty=difficulty,
        # Cleaned here rather than in the arranger so alphaTex's \title carries
        # the same song name the engraved sheet does. Raw entry titles reach
        # this function straight off the filename, so without this a tab prints
        # "04 - Song.mp3" while the MusicXML sheet beside it prints "Song".
        title=clean_title(title),
    )
    if not result.get("ok"):
        return result

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(result["alphatex"], encoding="utf-8")

    art_id = artifact_id or f"{entry_id}__{output_path.stem}__alphatex"
    db.add_notation_artifact(
        artifact_id=art_id,
        entry_id=entry_id,
        kind="alphatex",
        path=str(output_path),
        source_ref=source_ref or str(midi_path),
        engine="fretboard-dp",
        engine_version="1",
        metadata={
            "instrument": result["instrument"],
            "tuning": result["tuning"],
            "tuning_name": result["tuning_name"],
            "capo": result["capo"],
            "difficulty": result["difficulty"],
            "stats": result["stats"],
        },
    )
    db.add_relation(
        from_id=source_ref or str(midi_path),
        to_id=art_id,
        kind="tabbed_as_notation",
        metadata={"format": "alphatex", "instrument": result["instrument"]},
    )
    return {
        "ok": True,
        "artifact": db.get_notation_artifact(art_id),
        "path": str(output_path),
        "stats": result["stats"],
        "tuning_name": result["tuning_name"],
    }


def midi_to_arrangement(
    db: LibraryDB,
    *,
    entry_id: str,
    sources: list[Path],
    style: str,
    output_path: Path,
    source_ref: Optional[str] = None,
    artifact_id: Optional[str] = None,
    title: str = "",
) -> dict[str, Any]:
    """Arrange one or more source MIDIs into a MusicXML score of ``style`` and
    register it as a ``musicxml`` notation artifact."""
    from .arrangers.score_arrange import arrange

    result = arrange(sources, style=style, title=title)
    if not result.get("ok"):
        return result

    try:
        import music21  # type: ignore[import]
    except ImportError:
        return {"ok": False, "error": "music21 is not installed."}

    # Credit the artist as composer on the arrangement too, and re-stamp a
    # cleaned title (the arranger sets it from the song name, which may carry a
    # media extension).
    clean = clean_title(title)
    composer = artist_name()
    try:
        from music21.metadata import Metadata  # type: ignore[import]

        sc = result["score"]
        md = sc.metadata
        if md is None:
            md = Metadata()
            sc.insert(0, md)
        # Title only (not movementName) so the song name isn't printed twice; see
        # the note in _convert_with_music21. Artist is the composer credit.
        if clean:
            md.title = clean
        md.composer = composer
    except Exception as exc:  # noqa: BLE001 - crediting is best-effort
        log.debug("notation: could not set composer on arrangement: %s", exc)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        written = result["score"].write("musicxml", fp=str(output_path))
    except Exception as exc:  # noqa: BLE001
        log.warning("notation: arrangement write failed for %s: %s", output_path, exc)
        return {"ok": False, "engine": "music21-arrange", "error": repr(exc)}

    final_path = Path(written) if written else output_path
    art_id = artifact_id or f"{entry_id}__{output_path.stem}__{style}__musicxml"
    db.add_notation_artifact(
        artifact_id=art_id,
        entry_id=entry_id,
        kind="musicxml",
        path=str(final_path),
        source_ref=source_ref or str(sources[0]),
        engine="music21-arrange",
        engine_version=str(getattr(music21, "__version__", "unknown")),
        metadata={
            "style": style,
            "stats": result["stats"],
            "sources": [str(s) for s in sources],
        },
    )
    db.add_relation(
        from_id=source_ref or str(sources[0]),
        to_id=art_id,
        kind="arranged_as_notation",
        metadata={"style": style, "engine": "music21-arrange"},
    )
    return {
        "ok": True,
        "artifact": db.get_notation_artifact(art_id),
        "path": str(final_path),
        "style": style,
        "stats": result["stats"],
    }
