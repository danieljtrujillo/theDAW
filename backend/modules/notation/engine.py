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
    own ``/chords`` route through :mod:`.exporters.chordtrack`, not by
    ``/export`` -- it has no entry in :func:`capabilities`'s ``formats``
    list; look for ``caps["chords"]`` instead.

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
import json
import logging
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import uuid
import xml.dom.minidom as minidom
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any, Mapping, NamedTuple, Optional, Sequence

from backend.modules.library.db import LibraryDB, normalize_artifact_path

from . import pdf_render
from .midi_read import is_midi, read_score
from .tempo_marks import engrave_tempo_marks, restore_sounding_tempi
from backend.lib.atomic import atomic_replace
from backend.lib.launch_token import child_env

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


_XML10_VALID_CHARS_LOW = chr(0x09) + chr(0x0A) + chr(0x0D)
_XML10_INVALID_CHAR_RE = re.compile(
    "[^"
    + _XML10_VALID_CHARS_LOW
    + chr(0x20)
    + "-"
    + chr(0xD7FF)
    + chr(0xE000)
    + "-"
    + chr(0xFFFD)
    + chr(0x10000)
    + "-"
    + chr(0x10FFFF)
    + "]"
)


def _strip_invalid_xml_chars(text: str) -> str:
    """Drop every character outside the XML 1.0 Char production.

    ElementTree happily assigns any Python str to el.text and only
    discovers a bare control character (the C0 range below tab/LF/CR,
    and 0x0B/0x0C/0x0E-0x1F) or a lone UTF-16 surrogate is unrepresentable
    when it serializes -- by then the caller already has a document that
    corrupts on write. Called on title/composer before either reaches
    el.text so the bytes that hit disk are always well-formed XML.
    """
    return _XML10_INVALID_CHAR_RE.sub("", text)


def _strip_score_part_names(score: Any) -> None:
    """Strip XML-1.0-invalid characters from every part/instrument name on a
    music21 ``Score`` before it reaches the writer.

    ``partName``/``instrumentName`` (and their abbreviations) come straight
    from the source file -- a MIDI track-name meta event, for example -- and
    are never routed through :func:`_strip_invalid_xml_chars` the way
    title/composer are. music21's MusicXML writer does not escape, substitute,
    or drop invalid characters itself, so an unstripped control character
    (e.g. ``b"Gui\\x01tar"``) reaches ``<part-name>`` raw and the file fails to
    parse.
    """
    for part in score.parts:
        for attr in ("partName", "partAbbreviation"):
            value = getattr(part, attr, None)
            if isinstance(value, str):
                setattr(part, attr, _strip_invalid_xml_chars(value))
        for inst in part.recurse().getElementsByClass("Instrument"):
            for attr in (
                "partName",
                "partAbbreviation",
                "instrumentName",
                "instrumentAbbreviation",
            ):
                value = getattr(inst, attr, None)
                if isinstance(value, str):
                    setattr(inst, attr, _strip_invalid_xml_chars(value))


def _validate_written_musicxml(path: Path) -> None:
    """Parse-validate a MusicXML file just written to disk (plain or the
    compressed ``.mxl`` zip container).

    Neither music21's writer nor a hand-filtered ``ElementTree`` rewrite
    applies any XML-1.0 validity check of its own, so this is called on
    every MusicXML file this module writes before the caller may register or
    move it -- an unstripped source-derived string can never result in a
    corrupt artifact being registered. Raises :class:`ValueError` when the
    file is not well-formed; the caller decides what to do with the bad
    file.
    """
    try:
        if path.suffix.lower() == ".mxl":
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
                if not rootfile:
                    raise ValueError(
                        "compressed musicxml has no rootfile in META-INF/container.xml"
                    )
                ET.fromstring(archive.read(rootfile))
        else:
            ET.fromstring(path.read_bytes())
    except (
        ET.ParseError,
        zipfile.BadZipFile,
        zipfile.LargeZipFile,
        KeyError,
        OSError,
        RuntimeError,
    ) as exc:
        raise ValueError(f"musicxml failed to write as well-formed XML: {exc}") from exc


def _strip_score_lyrics(score: Any) -> None:
    """Strip XML-1.0-invalid characters from every note's lyric text on a
    music21 ``Score`` before it reaches the writer.

    Lyric text (a MIDI ``lyrics`` meta event, for example) reaches
    ``<lyric><text>`` raw otherwise. ``Lyric`` is not a stream element, so
    ``score.recurse().getElementsByClass("Lyric")`` finds nothing -- lyrics
    live on each note's own ``.lyrics`` list instead.
    """
    for n in score.recurse().notes:
        for ly in getattr(n, "lyrics", None) or []:
            if isinstance(getattr(ly, "text", None), str):
                ly.text = _strip_invalid_xml_chars(ly.text)


_METADATA_TEXT_ATTRS = (
    "title",
    "movementName",
    "movementNumber",
    "composer",
    "lyricist",
    "copyright",
)


def _strip_score_metadata(score: Any) -> None:
    """Strip XML-1.0-invalid characters from every text field on a music21
    ``Score``'s ``metadata`` before it reaches the writer.

    ``score.metadata`` carries source-derived strings the same way part
    names and lyrics do (a raw song title stamped unfiltered by
    :func:`.arrangers.score_arrange._new_score`, for example) but was never
    routed through :func:`_strip_invalid_xml_chars`.
    """
    md = getattr(score, "metadata", None)
    if md is None:
        return
    for attr in _METADATA_TEXT_ATTRS:
        value = getattr(md, attr, None)
        if isinstance(value, str):
            setattr(md, attr, _strip_invalid_xml_chars(value))


def _write_musicxml(score: Any, path: Path, *, what: str) -> Path:
    """The single MusicXML writer: every place in this module that writes a
    music21 ``Score`` as MusicXML goes through this function, and nothing
    else in this module may call ``score.write("musicxml", ...)`` directly.

    Strips every source-derived string that becomes XML text (part /
    instrument names via :func:`_strip_score_part_names`, lyric text via
    :func:`_strip_score_lyrics`, metadata text via
    :func:`_strip_score_metadata`), then writes to a uuid-suffixed temp file
    beside the real destination (never into ``path`` itself) and
    parse-validates that temp file. Only once validation passes is the temp
    file atomically replaced onto ``path`` (or ``path`` with ``.musicxml``
    appended, when ``path`` had no suffix of its own -- matching what
    music21's own writer does with a suffix-less ``fp``). On a validation
    failure the temp file is removed and a :class:`ValueError` is raised,
    prefixed with ``what`` (what failed and for which export); whatever was
    already at the destination -- a previous good export, on a re-export --
    is left byte-identical. Returns the path the artifact now lives at.
    """
    _strip_score_part_names(score)
    _strip_score_lyrics(score)
    _strip_score_metadata(score)
    final_path = path if path.suffix else path.with_suffix(".musicxml")
    final_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = final_path.with_name(
        f".{final_path.stem}.{uuid.uuid4().hex}{final_path.suffix}"
    )
    written_path = tmp
    try:
        written = score.write("musicxml", fp=str(tmp))
        written_path = Path(written) if written else tmp
        try:
            _validate_written_musicxml(written_path)
        except ValueError as exc:
            written_path.unlink(missing_ok=True)
            raise ValueError(f"{what}: {exc}") from exc
        atomic_replace(written_path, final_path)
        if written_path != tmp:
            tmp.unlink(missing_ok=True)
    except BaseException:
        tmp.unlink(missing_ok=True)
        written_path.unlink(missing_ok=True)
        raise
    return final_path


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
    return _strip_invalid_xml_chars(strip_track_prefix(t.strip()))


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
    return _strip_invalid_xml_chars(name) or DEFAULT_ARTIST


def _chart_artist(entry: Optional[Any]) -> str:
    """The artist to stamp on a generated note chart / Beat Saber level.

    :mod:`.identity` splits the entry's own name ("Artist - Song") or reads
    the user's per-entry override; when that is confident it names the actual
    performer, which the single global composer credit (:func:`artist_name`)
    never could. ``identity`` answers "" rather than guess, so that empty
    case -- and a caller with no entry row to read -- falls back to
    :func:`artist_name` exactly as :mod:`.identity`'s own docstring promises.
    """
    from . import identity

    if entry is not None:
        parsed_artist, _ = identity.resolve_identity(entry)
        if parsed_artist:
            return _strip_invalid_xml_chars(parsed_artist)
    return artist_name()


def _chart_title(entry: Optional[Any], title: str) -> str:
    """The title to stamp on a generated note chart / Beat Saber level.

    NOTE: this only titles those two chart-based targets, not the engraved
    PDF/SVG/MusicXML/ABC sheet -- those still take their title straight from
    the caller's ``title`` argument (:func:`_stage_musicxml`,
    :func:`_convert_with_music21`, :func:`stage_parts`). Wiring this in there
    too is a separate change; if that ever happens, update this note.

    An explicit override title (the DETAILS identity form's ``notation_title``,
    read via :mod:`.identity`) always wins, even when the user did not also
    set an override artist -- :func:`.identity.resolve_identity` preserves it
    regardless. Otherwise, when the entry's own name carries a confident
    "Artist - Song" split, the chart is titled with the SONG half only
    (:mod:`.identity` already resolved it alongside the artist). When neither
    applies -- no override, no confident split, or no entry to read -- this
    falls back exactly as before this function existed: the caller's own
    ``title`` argument, cleaned.
    """
    from . import identity

    if entry is not None:
        override_title = _lookup_field(
            entry, identity.OVERRIDE_TITLE_KEY
        ) or _lookup_metadata_field(entry, identity.OVERRIDE_TITLE_KEY)
        if override_title:
            return _strip_invalid_xml_chars(override_title)
        parsed_artist, parsed_title = identity.resolve_identity(entry)
        if parsed_artist and parsed_title:
            return _strip_invalid_xml_chars(parsed_title)
    return clean_title(title)


# mimetypes.guess_type is registry-based and disagrees with itself per OS: on
# this Windows machine ``.mp3`` guesses "audio/mp3" (not the IANA-registered
# "audio/mpeg") and ``.m4a`` guesses "video/m4a". A note chart's audio MIME
# type has to be stable across machines, so the audio extensions this app
# actually deals with are looked up here FIRST; ``mimetypes`` is only the
# fallback for anything else.
_AUDIO_MIME_BY_EXTENSION = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".aac": "audio/aac",
    ".aif": "audio/aiff",
    ".aiff": "audio/aiff",
}


def _guess_audio_mime(filename: str) -> str:
    """The MIME type for an audio filename: the fixed table above first,
    ``mimetypes.guess_type`` for anything not in it."""
    suffix = Path(filename).suffix.lower()
    fixed = _AUDIO_MIME_BY_EXTENSION.get(suffix)
    if fixed:
        return fixed
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or ""


def _chart_audio_block(entry: Optional[Any]) -> Optional[dict[str, Any]]:
    """Filename + MIME type for a note chart's ``audio`` block, read off the
    entry's own library record so the chart names the real source file
    instead of leaving those fields blank. ``None`` when there is no entry to
    read, so the chart writer falls back to its own (empty) defaults.

    The MIME type prefers the entry's own ``mime_type`` (metadata_json), then
    a guess from the filename's extension (:func:`_guess_audio_mime`), and
    only then the DB ``mime`` column -- that column defaults to
    ``"audio/wav"`` regardless of the real file (library/db.py), so it is the
    least trustworthy of the three.
    """
    if entry is None:
        return None
    filename = str(_lookup_field(entry, "audio_filename") or "")
    mime = _lookup_metadata_field(entry, "mime_type")
    if not mime and filename:
        mime = _guess_audio_mime(filename)
    if not mime:
        mime = str(_lookup_field(entry, "mime") or "")
    if not filename and not mime:
        return None
    return {"filename": filename, "mimeType": mime}


def _lookup_field(entry: Any, key: str) -> str:
    """Read one string field off an entry dict (a DB row) or object
    attribute, mirroring :func:`.identity._lookup`'s two shapes without
    pulling that private helper in."""
    if isinstance(entry, Mapping):
        value = entry.get(key)
    else:
        value = getattr(entry, key, None)
    return str(value).strip() if value else ""


def _lookup_metadata_field(entry: Any, key: str) -> str:
    """Read one string field from an entry's ``metadata_json`` blob only
    (never a top-level column), mirroring :func:`.identity._lookup`'s
    metadata_json probing without pulling that private helper in. The blob
    arrives either as a parsed mapping or as a JSON string (a raw DB row)."""
    if entry is None:
        return ""
    raw_meta: Any = (
        entry.get("metadata_json")
        if isinstance(entry, Mapping)
        else getattr(entry, "metadata_json", None)
    )
    nested: Optional[Mapping[str, Any]] = None
    if isinstance(raw_meta, str) and raw_meta.strip():
        try:
            parsed = json.loads(raw_meta)
        except ValueError:
            parsed = None
        if isinstance(parsed, Mapping):
            nested = parsed
    elif isinstance(raw_meta, Mapping):
        nested = raw_meta
    if nested is not None and nested.get(key):
        return str(nested[key]).strip()
    return ""


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
            encoding="utf-8",
            errors="replace",
            timeout=20,
            stdin=subprocess.DEVNULL,
            env=child_env(),
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
    # What ``POST /{entry_id}/export`` (``_EXT_FOR_FORMAT``) actually accepts,
    # plus pdf/svg below when an engraver is present. "midi", "json" and
    # "alphatex" are artifact *kinds* this module already produces (a
    # registered MIDI, a note chart's raw dict, a tab arrangement) but none of
    # them is an /export target -- advertising them here promised a
    # conversion the route then rejected with 422. "chordtrack" is likewise
    # not an /export target: chord tracks are built through their own
    # POST /{entry_id}/chords route (see ``caps["chords"]`` below).
    formats = [
        "musicxml",
        "abc",
        "notechart",
        "beatsaber",
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
        # Chord tracks are always buildable (pure-Python writer, like
        # notechart/beatsaber) but reach the entry through their own
        # POST /{entry_id}/chords route rather than /export, so they get
        # their own capability flag instead of a "formats" entry.
        "chords": True,
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
    # Existing rows keyed by the FILE they point at. Mirroring is idempotent by
    # id, but a file already represented by a different row (a create-scheme or
    # consolidated canonical row) must not gain a second row here — that is how
    # duplicate artifacts came back after every consolidation.
    holder_for_path = {
        normalize_artifact_path(str(row.get("path") or "")): (
            str(row.get("id") or ""),
            str(row.get("engine") or "").strip().lower(),
        )
        for row in db.list_notation_artifacts(entry_id)
    }
    for midi in db.list_midis(entry_id):
        midi_id = str(midi.get("id") or "")
        midi_path = str(midi.get("midi_path") or "")
        if not midi_id or not midi_path:
            continue
        artifact_id = f"{midi_id}__artifact_midi"
        holder = holder_for_path.get(normalize_artifact_path(midi_path))
        # A file already represented by a REAL row must not gain a second row.
        # A ``recovered-from-disk`` holder is different: it is the filename-derived
        # stand-in, it carries no legacy_midi_id, and the ``/from-midi`` route
        # cannot resolve a midi id through it. The mirror is the canonical
        # representation of a MIDI the library owns, so it is written anyway and
        # the recovery row is left for the consolidator to retire.
        if (
            holder is not None
            and holder[0] != artifact_id
            and holder[1] != _RECOVERED_ENGINE
        ):
            log.debug(
                "notation: %s already represents %s; skipping mirror row %s",
                holder[0],
                midi_path,
                artifact_id,
            )
            continue
        holder_for_path[normalize_artifact_path(midi_path)] = (artifact_id, "")
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


def _song_slug(title: str, fallback: str = "score") -> str:
    """Filesystem-safe, readable slug of a song title for score filenames."""
    cleaned = "".join(c if (c.isalnum() or c in " -_") else "_" for c in (title or ""))
    cleaned = "_".join(cleaned.split())  # collapse whitespace runs to one "_"
    cleaned = cleaned.strip("_-")
    return cleaned[:60] or fallback


def _scored_name(slug: str, base: str) -> str:
    """Prefix ``base`` with the song slug unless it already leads with it,
    so the file (and its download name) carries the originating song."""
    if slug and not base.lower().startswith(slug.lower()):
        return f"{slug}__{base}"
    return base


def sheet_output_path(store: Any, entry_id: str, midi_id: str) -> Optional[Path]:
    """THE on-disk path of the MusicXML sheet engraved from ``midi_id``.

    Both writers of that sheet -- the ``/from-midi`` route and the notation
    backfill -- register the SAME artifact id, so they must agree on the
    filename or they ping-pong the sheet between two names on alternating runs
    and leave a rowless copy behind. They also have to read the title from the
    SAME place: the entry record (metadata.json chain), not the entries table,
    because the two can diverge. This function is that single agreement.

    ``None`` when the entry has no directory.
    """
    entry_dir = store._dir_for(entry_id)  # noqa: SLF001 - module convention
    if entry_dir is None:
        return None
    entry = store.get_entry(entry_id)
    title = str(getattr(entry, "title", "") or "") if entry is not None else ""
    return (
        entry_dir / "notation" / _scored_name(_song_slug(title), f"{midi_id}.musicxml")
    )


# The engine value register_on_disk_artifacts stamps on a recovered row.
_RECOVERED_ENGINE = "recovered-from-disk"


def lyrics_artifact_id(entry_id: str) -> str:
    """The one notation artifact id a recovered ``<entry>/lyrics.json`` gets."""
    return f"{entry_id}__lyrics__lyrics"


def _kind_and_stem_for_file(path: Path) -> tuple[Optional[str], str]:
    """Artifact ``kind`` and id stem for a file on disk, or ``(None, stem)``
    when the file is not a notation artifact.

    A leading-dot filename is never a real artifact -- it is the naming
    convention :func:`_write_musicxml` uses for its in-progress temp file
    (``.<stem>.<uuid>.musicxml``), and a leaked one (a crash between the
    write and the ``try`` that now guards it, or a name a future writer
    invents the same way) must never be registered as a notation artifact.
    """
    if path.name.startswith("."):
        return None, path.stem
    name = path.name.lower()
    for suffix, kind in _KIND_FOR_COMPOUND_SUFFIX:
        if name.endswith(suffix):
            return kind, path.name[: -len(suffix)]
    return _KIND_FOR_SUFFIX.get(path.suffix.lower()), path.stem


def drop_superseded_recovery_rows(
    artifacts: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Hide a ``recovered-from-disk`` row from a LISTING when a real row already
    covers the same file.

    Rows are never deleted -- a legacy library can hold both a filename-derived
    recovery row and the real row (mirror or create-path) for one file until the
    consolidator retires the former. The recovery row is the wrong one to serve:
    it carries no ``legacy_midi_id`` and its ``source_ref`` is an absolute path,
    so a client that reads the FIRST midi artifact of an entry (rows come back
    oldest-first, and the recovery row is usually older) would try to resolve a
    filesystem path as a midi id, and an "arrange from all MIDI" action would
    arrange the same file twice.

    Returns the list in its original order, minus those shadowed rows.
    """
    # normalize_artifact_path does a realpath syscall, so each row is normalized
    # exactly once and both passes read the same precomputed value.
    scanned = [
        (
            artifact,
            str(artifact.get("engine") or "").strip().lower() == _RECOVERED_ENGINE,
            normalize_artifact_path(str(artifact.get("path") or "")),
        )
        for artifact in artifacts
    ]
    covered = {path for _, is_recovered, path in scanned if not is_recovered and path}
    return [
        artifact
        for artifact, is_recovered, path in scanned
        if not (is_recovered and path in covered)
    ]


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
    # Recovery is idempotent by derived id, but the SAME file is also reachable
    # under a create-scheme id, so recovering it again would duplicate the
    # artifact on every bundle/reindex/artifacts read. Track what each file is
    # already represented by and skip those.
    holder_for_path = {
        normalize_artifact_path(str(row.get("path") or "")): str(row.get("id") or "")
        for row in db.list_notation_artifacts(entry_id)
    }
    # A MIDI the library OWNS (it has a ``midis`` row) is represented canonically
    # by register_existing_midis' mirror, which carries the legacy midi id the
    # ``/from-midi`` route resolves through. This scan runs FIRST on bundle and
    # reindex, so recovering such a file here would plant a filename-derived row
    # that permanently displaces that mirror. Leave owned MIDI to the mirror.
    owned_midi_paths = {
        normalize_artifact_path(str(row.get("midi_path") or ""))
        for row in db.list_midis(entry_id)
    }
    owned_midi_paths.discard("")

    def _recover(artifact_id: str, kind: str, path: Path, source_dir: str) -> None:
        if db.get_notation_artifact(artifact_id) is not None:
            return
        normalized = normalize_artifact_path(str(path))
        if normalized in owned_midi_paths:
            log.debug(
                "notation: %s is an owned MIDI; leaving it to the mirror row", path
            )
            return
        holder = holder_for_path.get(normalized)
        if holder is not None:
            log.debug(
                "notation: %s already represents %s; not recovering as %s",
                holder,
                path,
                artifact_id,
            )
            return
        holder_for_path[normalized] = artifact_id
        db.add_notation_artifact(
            artifact_id=artifact_id,
            entry_id=entry_id,
            kind=kind,
            path=str(path),
            source_ref=str(path),
            engine=_RECOVERED_ENGINE,
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


def _stage_musicxml(
    source_path: Path, scratch: Path, title: str, *, artist: str = ""
) -> Path:
    """Write ``source_path`` (any music21-readable source, normally MIDI) as a
    MusicXML file at ``scratch``, titled + credited, and return ``scratch``.

    ``artist`` is the composer credit to stamp; callers resolve it once via
    :func:`_chart_artist` (falls back to the global :func:`artist_name` when
    empty) so every staged copy of the same entry carries the same credit.

    The engravers read MusicXML only. The file is written beside the caller's
    output and the caller removes it afterwards; it is never registered as an
    artifact, because a DB row must not point at a path that is then deleted.
    Raises on a music21 failure so the caller reports it.
    """
    staged_score = read_score(source_path)
    clean = clean_title(title)
    if clean:
        try:
            from music21.metadata import Metadata  # type: ignore[import]

            if staged_score.metadata is None:
                staged_score.insert(0, Metadata())
            staged_score.metadata.title = clean
            staged_score.metadata.composer = artist or artist_name()
        except Exception as exc:  # noqa: BLE001 - titling is best-effort
            log.debug("notation: staging title skipped: %s", exc)
    engrave_tempo_marks(staged_score)
    return _write_musicxml(
        staged_score, scratch, what=f"staging {source_path.name} as musicxml"
    )


_MUSICXML_DECL_RE = re.compile(rb"\A\s*<\?xml[^>]*\?>")


def _quote_doctype_literal(value: str) -> str:
    """Quote a DOCTYPE ``PubidChar``/``SystemLiteral`` value, choosing a
    quote character not present in ``value``.

    ``xml.dom.minidom.DocumentType.writexml`` (and therefore
    ``DocumentType.toxml()``) always wraps both the public and system
    identifiers in single quotes with no escaping -- see the CPython stdlib
    source (``writer.write("%s  PUBLIC '%s'%s  '%s'" % (...))``). An
    apostrophe is a legal ``PubidChar`` and legal inside a double-quoted
    ``SystemLiteral``, so a value containing one (e.g. a Windows path like
    ``Bob's Scores``) round-trips through ``toxml()`` into an unescaped
    single-quoted literal, corrupting the XML. A double quote cannot appear
    in a ``PubidChar``, so the double-quoted branch below is always safe for
    a public id; for a system id (which may contain either quote character,
    just not both) this still covers every value minidom itself accepts.
    """
    if "'" in value and '"' in value:
        raise ValueError(
            f"cannot quote DOCTYPE literal {value!r}: contains both quote "
            "characters (unreachable from a SystemLiteral/PubidChar a real "
            "parser can produce -- see this function's docstring)"
        )
    if "'" in value:
        return '"%s"' % value
    return "'%s'" % value


def _musicxml_prolog_extras(raw: bytes) -> bytes:
    """The DOCTYPE declaration and any comments (or processing instructions)
    that sit between the XML declaration and the root element of a MusicXML
    file, re-encoded to UTF-8 and joined with newlines.

    ``ElementTree`` has no representation for either -- a plain
    ``ET.parse`` / ``tree.write`` round trip silently drops both. This
    locates the root element BY POSITION FROM A REAL XML PARSER
    (``xml.dom.minidom``, which models both the ``DocumentType`` and any
    pre-root ``Comment``/processing-instruction nodes, and decodes the
    document per its own declared encoding -- UTF-8 BOM included, unlike a
    byte-level regex scan, which neither recognises a BOM nor stops at a
    pre-root comment containing ``<`` (e.g. a URL) rather than scanning
    through it). Each node is then re-serialized as UTF-8, so the extras
    are always safe to splice into a UTF-8 body (e.g.
    ``ET.write(..., encoding="UTF-8")`` output).

    Returns ``b""`` when ``raw`` cannot be parsed this way (malformed XML,
    no root element) or there is nothing before the root to preserve --
    the lossy-but-valid fallback -- rather than ever produce a corrupt
    splice.

    Only pre-root nodes are captured (the loop below stops at ``root``): a
    comment or processing instruction AFTER the root element is dropped,
    same as a plain ``ET`` round trip. Lossy but still valid XML, so this
    is left as-is.
    """
    try:
        doc = minidom.parseString(raw)
    except Exception:
        return b""
    root = doc.documentElement
    if root is None:
        return b""
    pieces: list[bytes] = []
    for node in doc.childNodes:
        if node is root:
            break
        if node.nodeType == node.DOCUMENT_TYPE_NODE:
            # Built by hand rather than ``node.toxml()``: minidom's own
            # writer always single-quotes both identifiers with no
            # escaping, which corrupts the DOCTYPE for any value (e.g. a
            # file path) containing an apostrophe. See
            # ``_quote_doctype_literal``. Note ``node.name`` comes back
            # prefix-stripped for a namespaced root (e.g. ``mx:score``
            # captures as just ``score``) while the ``ET`` rewrite emits
            # ``ns0:score`` -- harmless, since root-element-type agreement
            # between the DOCTYPE and the document is a Validity
            # Constraint, not a Well-Formedness one, and neither parser
            # used here validates.
            if node.publicId:
                piece = (
                    f"<!DOCTYPE {node.name} PUBLIC "
                    f"{_quote_doctype_literal(node.publicId)} "
                    f"{_quote_doctype_literal(node.systemId or '')}"
                )
            elif node.systemId:
                piece = (
                    f"<!DOCTYPE {node.name} SYSTEM "
                    f"{_quote_doctype_literal(node.systemId)}"
                )
            else:
                piece = f"<!DOCTYPE {node.name}"
            if node.internalSubset is not None:
                piece += f" [{node.internalSubset}]"
            piece += ">"
        elif node.nodeType == node.COMMENT_NODE:
            piece = f"<!--{node.data}-->"
        elif node.nodeType == node.PROCESSING_INSTRUCTION_NODE:
            piece = f"<?{node.target} {node.data}?>"
        else:
            continue
        pieces.append(piece.encode("utf-8"))
    return b"\n".join(pieces).strip(b"\r\n")


def _splice_musicxml_prolog_extras(body: bytes, extras: bytes) -> bytes:
    """Insert ``extras`` (see :func:`_musicxml_prolog_extras`) right after
    ``body``'s own XML declaration.

    ``body`` is assumed to be ``ElementTree``'s own clean UTF-8 output
    (``tree.write(..., encoding="UTF-8")``), so its declaration always
    matches ``_MUSICXML_DECL_RE`` from the very first byte -- no BOM, no
    leading whitespace to confuse the match.
    """
    if not extras:
        return body
    decl_match = _MUSICXML_DECL_RE.match(body)
    decl_end = decl_match.end() if decl_match else 0
    return body[:decl_end] + b"\n" + extras + b"\n" + body[decl_end:].lstrip(b"\r\n")


def _set_musicxml_composer(root: ET.Element, composer: str) -> None:
    """Set (or create) ``<identification><creator type="composer">`` on a
    parsed ``<score-partwise>`` root, in place -- and remove every OTHER
    ``type="composer"`` creator, so a sheet some other tool wrote with more
    than one never keeps a stale second credit beside the one just set.

    Shared by :func:`stage_parts` (filtering a whole sheet down to a part
    subset), :func:`_engrave` (re-crediting an already-MusicXML source
    before handing it to the MuseScore CLI, which reads the composer straight
    off the file and has no ``--artist`` override the way the OSMD renderer
    does), and the ``/pack`` route's non-part-scoped re-credit.
    """
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
    composer_creators = [
        c
        for c in identification.findall("creator")
        if (c.get("type") or "composer").strip().lower() == "composer"
    ]
    if composer_creators:
        creator, extras = composer_creators[0], composer_creators[1:]
    else:
        creator = ET.Element("creator", {"type": "composer"})
        identification.insert(0, creator)
        extras = []
    creator.text = composer
    for extra in extras:
        identification.remove(extra)


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
    artist: str = "",
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
    kept, so the engraved page says which part it is. ``artist`` is the
    composer credit to stamp (falls back to the global :func:`artist_name`
    when empty, exactly as before this parameter existed) -- callers resolve
    it once via :func:`_chart_artist` so the filtered sheet carries the same
    credit as the whole one. The caller deletes the staged file in a
    ``finally`` and never registers it.
    """
    scratch = output_path.with_name(f"{output_path.stem}__parts_src.musicxml")
    midi_scratch: Optional[Path] = None
    try:
        source = source_path
        if not _is_musicxml(source_path):
            midi_scratch = output_path.with_name(
                f"{output_path.stem}__parts_midi_src.musicxml"
            )
            midi_scratch = source = _stage_musicxml(
                source_path, midi_scratch, title, artist=artist
            )
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
        _set_musicxml_composer(root, artist or artist_name())

        scratch.parent.mkdir(parents=True, exist_ok=True)
        tree.write(str(scratch), encoding="UTF-8", xml_declaration=True)
        try:
            _validate_written_musicxml(scratch)
        except ValueError as exc:
            # A control character reached the staged XML (composer/title
            # credit) despite the chokepoint strip -- never hand callers a
            # StagedParts pointing at a file no XML parser accepts.
            scratch.unlink(missing_ok=True)
            raise ValueError(
                f"part-scoped MusicXML failed to stage as well-formed XML: {exc}"
            ) from exc
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

    # Resolved ONCE, early, and threaded through every converter below so one
    # entry carries one credit everywhere -- the identity split (or the
    # global composer, when it has none to offer) rather than each converter
    # separately (and, before this, inconsistently) calling artist_name().
    entry = db.get_entry(entry_id) if entry_id else None
    artist = _chart_artist(entry)

    parts = _requested_parts(options)
    if parts and fmt in _PART_SCOPED_FORMATS:
        if importlib.util.find_spec("music21") is None and not _is_musicxml(
            source_path
        ):
            return {"ok": False, "error": "music21 is not installed."}
        try:
            staged = stage_parts(
                source_path, parts, title, output_path=output_path, artist=artist
            )
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
                artist=artist,
                entry=entry,
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
        artist=artist,
        entry=entry,
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
    artist: str = "",
    entry: Optional[Any] = None,
) -> dict[str, Any]:
    """Route one (already staged, if part-scoped) source to its converter.

    ``register_source`` is the path the artifact's ``metadata.source`` and
    lineage relation record when ``source_path`` is a staging file; the
    converters otherwise record the file they read. ``artist`` and ``entry``
    are what :func:`convert_score` already resolved once (``entry`` via
    ``db.get_entry(entry_id)``, ``artist`` via :func:`_chart_artist`); the
    chart-based converters below take ``entry`` too so they never re-read it.
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
            artist=artist,
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
            artist=artist,
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
            artist=artist,
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
            artist=artist,
            entry=entry,
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
            artist=artist,
            entry=entry,
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
    artist: str = "",
) -> dict[str, Any]:
    """Engrave a PDF or SVG: the frontend's OSMD first (the engraver the SCORE
    tab draws with), MuseScore when OSMD is unavailable or its render fails.

    ``options["engine"]`` ('osmd' | 'musescore') pins one engraver; an
    unavailable pinned engraver is an error, not a silent switch. A tab
    source (``.alphatex``) is handed to the renderer as-is: it reads it
    through alphaTab (see :mod:`.pdf_render`), never through music21, which
    cannot parse alphaTex and has no tab source to stage a MusicXML from.
    Every other source is MusicXML or MIDI; OSMD reads MusicXML only, so a
    MIDI source is staged through music21 into MusicXML first, REGARDLESS of
    which engraver ends up rendering it (even a forced ``options["engine"]:
    "musescore"``, which could otherwise read the MIDI directly) -- staging
    also stamps the title and composer credit, which the engravers would
    otherwise print un-credited. That staging file is written beside the
    output and removed afterwards, and it is deliberately NOT registered as
    an artifact: registering it would leave a DB row pointing at a path this
    function then deletes.

    ``artist`` is the composer credit :func:`convert_score` already resolved
    once via :func:`_chart_artist`. The OSMD renderer takes it as an explicit
    ``artist=`` argument; MuseScore has no such override and reads the
    composer straight off the file, so an ALREADY-MusicXML source (one that
    skipped the staging above) gets it re-stamped onto a throwaway MuseScore
    scratch copy, mirroring how :func:`stage_parts` re-credits a filtered
    sheet. A MIDI source's staged copy is already credited by
    :func:`_stage_musicxml` and needs no second copy.
    """
    forced = str((options or {}).get("engine") or "").lower().strip() or None
    if forced is not None and forced not in _ENGRAVE_ENGINES:
        return {
            "ok": False,
            "engine": forced,
            "error": f"unknown engraver {forced!r}; use one of {_ENGRAVE_ENGINES}",
        }
    is_tab_source = source_path.suffix.lower() == ".alphatex"
    osmd_ok = bool(pdf_render.available()["ok"])
    musescore = musescore_command()
    try_osmd = forced in (None, "osmd") and osmd_ok
    # MuseScore has no alphaTex reader; a tab source can only be engraved by
    # the alphaTab-capable OSMD path above.
    try_musescore = (
        forced in (None, "musescore") and musescore is not None and not is_tab_source
    )
    if not try_osmd and not try_musescore:
        if forced == "osmd":
            error = f"the OSMD renderer is unavailable: {pdf_render.available()}"
        elif forced == "musescore":
            error = (
                "tablature (.alphatex) cannot be engraved by MuseScore; use the "
                "OSMD engraver"
                if is_tab_source
                else _MUSESCORE_NOT_FOUND
            )
        elif is_tab_source:
            # MuseScore has no alphaTex reader and was therefore never a
            # candidate for this source -- naming it here (the generic hint
            # below mentions both engravers) would be misleading.
            error = (
                f"{fmt.upper()} export of a tab (.alphatex) source needs the "
                f"OSMD renderer: {pdf_render.available()}"
            )
        else:
            error = f"{fmt.upper()} export {_ENGRAVE_NOTHING_HINT}"
        return {"ok": False, "engine": forced or "osmd", "error": error}

    credited_artist = artist or artist_name()
    source = source_path
    scratch: Optional[Path] = None
    musescore_scratch: Optional[Path] = None
    try:
        if not _is_musicxml(source_path) and not is_tab_source:
            if importlib.util.find_spec("music21") is None:
                return {
                    "ok": False,
                    "engine": "osmd",
                    "error": "music21 is not installed.",
                }
            scratch = output_path.with_name(f"{output_path.stem}__staged_src.musicxml")
            try:
                scratch = source = _stage_musicxml(
                    source_path, scratch, title, artist=credited_artist
                )
            except Exception as exc:  # noqa: BLE001
                log.warning(
                    "notation: %s staging failed for %s: %s", fmt, source_path, exc
                )
                return {"ok": False, "engine": "osmd", "error": repr(exc)}

        errors: list[str] = []
        if try_osmd:
            render = (
                pdf_render.render_musicxml_pdf
                if fmt == "pdf"
                else pdf_render.render_musicxml_svg
            )
            result = render(source, output_path, artist=credited_artist)
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
            musescore_source = source
            if scratch is None and _is_musicxml(source_path):
                # ``source`` is still the ORIGINAL MusicXML file (nothing was
                # staged above) -- MuseScore reads its composer straight off
                # the file and has no ``--artist`` override, so it is
                # re-credited onto a throwaway copy exactly as
                # :func:`stage_parts` re-credits a filtered sheet.
                try:
                    musescore_scratch = output_path.with_name(
                        f"{output_path.stem}__musescore_src.musicxml"
                    )
                    tree = ET.parse(str(source))
                    _set_musicxml_composer(tree.getroot(), credited_artist)
                    musescore_scratch.parent.mkdir(parents=True, exist_ok=True)
                    tree.write(
                        str(musescore_scratch), encoding="UTF-8", xml_declaration=True
                    )
                    musescore_source = musescore_scratch
                except Exception as exc:  # noqa: BLE001 - crediting is best-effort
                    log.debug(
                        "notation: MuseScore re-credit skipped for %s: %s",
                        source,
                        exc,
                    )
                    if musescore_scratch is not None:
                        musescore_scratch.unlink(missing_ok=True)
                    musescore_scratch = None
                    musescore_source = source
            result = _convert_with_musescore(
                db,
                entry_id=entry_id,
                source_path=musescore_source,
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
        if musescore_scratch is not None:
            musescore_scratch.unlink(missing_ok=True)


def _convert_to_pdf(db: LibraryDB, **kwargs: Any) -> dict[str, Any]:
    """Engrave a PDF: OSMD first, MuseScore second (see :func:`_engrave`)."""
    return _engrave(db, fmt="pdf", **kwargs)


def _convert_to_svg(db: LibraryDB, **kwargs: Any) -> dict[str, Any]:
    """Engrave an SVG (page 1; MuseScore writes ``<stem>-N.svg`` per page,
    OSMD the same): OSMD first, MuseScore second (see :func:`_engrave`)."""
    return _engrave(db, fmt="svg", **kwargs)


def _with_part_scope_suffix(
    title: str, extra_metadata: Optional[dict[str, Any]]
) -> str:
    """Append `` · <part name>`` to ``title`` when ``extra_metadata["parts"]``
    (set by :func:`convert_score`'s part-scoped branch from
    :attr:`StagedParts.parts`) names exactly one part.

    ``_chart_title`` resolves a chart's title from the entry's own identity
    (an override, or a confident "Artist - Song" split) rather than from the
    raw ``title`` string a part-scoped export bakes the suffix into
    (:func:`stage_parts`) -- so that suffix has to be re-applied here, after
    the identity resolution, to whatever title identity produced. Mirrors
    :func:`stage_parts`'s own suffix exactly (`` · <name>``, same separator).

    Idempotent: when identity has no confident split (or no entry), its
    fallback IS the raw ``title`` -- which, for a part-scoped export, is
    :func:`stage_parts`'s OWN already-suffixed ``StagedParts.title``. Without
    this check that would double the suffix (``"Song · Lead · Lead"``).
    """
    parts = (extra_metadata or {}).get("parts") or []
    if len(parts) != 1:
        return title
    part_name = str(parts[0].get("name") or "")
    if not part_name:
        return title
    suffix = f" · {part_name}"
    if title.endswith(suffix):
        return title
    return f"{title}{suffix}" if title else part_name


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
    artist: str = "",
    entry: Optional[Any] = None,
) -> dict[str, Any]:
    """Write the Unity flying-notation chart (timecode + spelled notes).

    When the source is a MusicXML sheet engraved from a MIDI artifact, that
    MIDI is handed to the chart builder so every event also carries its raw
    (unquantised) onset — what the play-along judge and Beat Saber map against.
    ``register_source`` / ``extra_metadata`` come from a part-scoped export
    (the chart was built from a staged file; the artifact records the sheet) --
    ``register_source`` names the real, un-staged source so the chart's
    ``source.sourcePath`` never carries a ``__parts_..._src.musicxml``
    scratch filename, and ``extra_metadata["parts"]`` restores the single-part
    `` · <name>`` title suffix (see :func:`_with_part_scope_suffix`).
    ``artist`` and ``entry`` are what :func:`convert_score` already resolved
    once (``entry`` via ``db.get_entry(entry_id)``, ``artist`` via
    :func:`_chart_artist`); this never re-reads the row.
    """
    try:
        from .exporters.notechart import write_notechart

        raw_midi_path, raw_midi_artifact_id = raw_midi_for(db, source_ref)
        chart_title = _with_part_scope_suffix(
            _chart_title(entry, title), extra_metadata
        )
        result = write_notechart(
            source_path,
            output_path,
            title=chart_title,
            artist=artist,
            entry_id=entry_id,
            audio_duration_sec=audio_duration_sec,
            source_artifact_id=source_ref or "",
            source_rel_path=(register_source or source_path).name,
            raw_midi_path=raw_midi_path,
            raw_midi_artifact_id=raw_midi_artifact_id,
            audio=_chart_audio_block(entry),
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
    artist: str = "",
    entry: Optional[Any] = None,
) -> dict[str, Any]:
    """Write a Beat Saber custom level (zip) from a MIDI/MusicXML source.

    The note chart is built in memory (the same document ``notechart`` writes,
    so the web HIGHWAY's 'blocks' skin and the level agree note for note) and
    handed to :func:`.exporters.beatsaber.write_beatsaber`. Info.dat carries ONE
    constant BPM: the analysis BPM by default (``bpm_source`` 'analysis') so the
    in-game grid matches the recording, else the chart's first tempo.
    ``artist`` and ``entry`` are what :func:`convert_score` already resolved
    once (``entry`` via ``db.get_entry(entry_id)``, ``artist`` via
    :func:`_chart_artist`); this never re-reads the row. ``options["parts"]``
    is beatsaber's own part filter (it is not part of
    :data:`_PART_SCOPED_FORMATS`, so it never goes through
    :func:`stage_parts`); a single filtered part's name -- read from the
    unfiltered chart's own ``parts`` list, built before filtering -- is
    appended to the title the same way :func:`_with_part_scope_suffix` does
    for a notechart.
    """
    opts = dict(options or {})
    try:
        from .exporters.beatsaber import write_beatsaber
        from .exporters.notechart import build_notechart

        raw_midi_path, raw_midi_artifact_id = raw_midi_for(db, source_ref)
        chart_artist = artist
        clean = _chart_title(entry, title)
        chart = build_notechart(
            source_path,
            title=clean,
            artist=chart_artist,
            entry_id=entry_id,
            audio_duration_sec=audio_duration_sec,
            source_artifact_id=source_ref or "",
            raw_midi_path=raw_midi_path,
            raw_midi_artifact_id=raw_midi_artifact_id,
            audio=_chart_audio_block(entry),
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
    if part_indices and len(part_indices) == 1:
        chart_parts = chart.get("parts") or []
        part_name = str(
            next(
                (
                    p.get("name")
                    for p in chart_parts
                    if p.get("index") == part_indices[0]
                ),
                "",
            )
            or ""
        )
        if part_name:
            clean = f"{clean} · {part_name}" if clean else part_name
            chart.setdefault("source", {})["title"] = clean

    result = write_beatsaber(
        chart,
        output_path,
        song_name=clean or "Untitled",
        artist=chart_artist,
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
    artist: str = "",
) -> dict[str, Any]:
    """Write ABC from a symbolic source using the local ABC writer.

    music21 parses the source; the text is produced by
    :func:`.exporters.abc_writer.score_to_abc` because music21 has no ABC
    writer. A score with no notes raises rather than registering an empty file.
    ``register_source`` / ``extra_metadata`` come from a part-scoped export.
    ``artist`` is the composer credit (falls back to the global
    :func:`artist_name` when empty).
    """
    if importlib.util.find_spec("music21") is None:
        return {
            "ok": False,
            "engine": "abc-writer",
            "error": "music21 is not installed.",
            "hint": "uv sync --group dev",
        }
    try:
        from .exporters.abc_writer import score_to_abc

        score = read_score(source_path)
        try:
            score = score.quantize((4, 3), inPlace=False, recurse=True)
        except Exception as exc:  # noqa: BLE001 - quantize is best-effort
            log.debug("notation: abc quantize skipped for %s: %s", source_path, exc)
        if is_midi(source_path):
            # A MIDI reads as unbarred parts; the ABC body is written bar by bar.
            score.makeNotation(inPlace=True)
        text = score_to_abc(
            score,
            title=clean_title(title),
            composer=artist or artist_name(),
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
    artist: str = "",
) -> dict[str, Any]:
    try:
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
            score = read_score(source_path)
            if score is None:
                raise ValueError(f"music21 could not parse {source_path}")
            # A MusicXML source's marks lose their <sound tempo> in music21's
            # reader; put it back so the sheet written below still carries it.
            restore_sounding_tempi(score, source_path)
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
        composer = artist or artist_name()
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
        engrave_tempo_marks(score)
        final_path = _write_musicxml(
            score, output_path, what=f"{fmt} export of {source_path.name}"
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("notation: %s export failed for %s: %s", fmt, source_path, exc)
        return {"ok": False, "engine": "music21", "error": repr(exc)}

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
    creationflags = (
        getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
    )
    try:
        proc = subprocess.run(
            [*command, "-o", str(output_path), str(source_path)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
            stdin=subprocess.DEVNULL,
            creationflags=creationflags,
            env=child_env(),
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
    reference_bpm: Optional[float] = None,
) -> dict[str, Any]:
    """Arrange one or more source MIDIs into a MusicXML score of ``style`` and
    register it as a ``musicxml`` notation artifact.

    ``reference_bpm`` is the song's analysed tempo; a band score lays every
    staff out at it (see :func:`.arrangers.score_arrange.arrange`)."""
    from .arrangers.score_arrange import arrange

    result = arrange(sources, style=style, title=title, reference_bpm=reference_bpm)
    if not result.get("ok"):
        return result

    try:
        import music21  # type: ignore[import]
    except ImportError:
        return {"ok": False, "error": "music21 is not installed."}

    # Credit the artist as composer on the arrangement too, and re-stamp a
    # cleaned title (the arranger sets it from the song name, which may carry a
    # media extension). Resolved via the entry's own identity split, same as
    # every other export (:func:`_chart_artist`), not the bare global name.
    entry = db.get_entry(entry_id) if entry_id else None
    clean = clean_title(title)
    composer = _chart_artist(entry)
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

    try:
        engrave_tempo_marks(result["score"])
        final_path = _write_musicxml(
            result["score"], output_path, what=f"{style} arrangement export"
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("notation: arrangement write failed for %s: %s", output_path, exc)
        return {"ok": False, "engine": "music21-arrange", "error": repr(exc)}

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
