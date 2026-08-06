"""Symbolic notation conversion helpers.

This is the conversion backbone for the notation module. It makes MIDI
artifacts first-class notation artifacts and converts between symbolic
formats:

  - ``musicxml`` is produced directly by ``music21``.
  - ``abc`` is written by :mod:`.exporters.abc_writer`, because music21 parses
    ABC but cannot write it.
  - ``pdf`` is engraved headlessly by the frontend's OpenSheetMusicDisplay via
    :mod:`.pdf_render`, so a downloaded sheet matches the SCORE tab exactly and
    no MuseScore install is required.
  - ``svg`` is engraved by the MuseScore CLI when it is installed; without it
    that target returns ``ok=False`` with an install hint so callers degrade
    gracefully rather than raising.
  - ``notechart`` is the Unity flying-notation chart (timecode + spelled
    notes), written by :mod:`.exporters.notechart`.

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
from pathlib import Path
from typing import Any, Optional

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
# Targets that require the MuseScore CLI. PDF is deliberately NOT here: it is
# engraved headlessly by the frontend's OpenSheetMusicDisplay (see pdf_render),
# which is the same engraver the SCORE tab draws with, so a downloaded sheet
# matches the one on screen and PDF works on a machine with no MuseScore.
_MUSESCORE_FORMATS = frozenset({"svg"})
# The Unity flying-notation chart (timecode + notes), written by exporters/notechart.
_NOTECHART_FORMATS = frozenset({"notechart"})
# Map an output format to the artifact ``kind`` stored in the DB.
_KIND_FOR_FORMAT = {
    "musicxml": "musicxml",
    "abc": "abc",
    "pdf": "pdf",
    "svg": "svg",
    "notechart": "notechart",
}

# MuseScore CLI binary names, newest first, and common Windows install paths.
_MUSESCORE_NAMES = (
    "MuseScore4",
    "MuseScore4.exe",
    "MuseScore3",
    "MuseScore3.exe",
    "mscore",
    "musescore",
)
_MUSESCORE_WINDOWS_PATHS = (
    r"C:\Program Files\MuseScore 4\bin\MuseScore4.exe",
    r"C:\Program Files\MuseScore 3\bin\MuseScore3.exe",
)


def musescore_binary() -> Optional[str]:
    """Locate a MuseScore CLI binary, or return ``None`` when none is found.

    Detection is deliberately independent of music21's stored UserSettings,
    which can hold a stale or malformed path. ``MUSESCORE_BIN`` overrides
    everything when it points at a real file.
    """
    override = os.environ.get("MUSESCORE_BIN")
    if override and Path(override).is_file():
        return override
    for name in _MUSESCORE_NAMES:
        found = shutil.which(name)
        if found:
            return found
    for candidate in _MUSESCORE_WINDOWS_PATHS:
        if Path(candidate).is_file():
            return candidate
    return None


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

    musescore = musescore_binary()
    osmd = pdf_render.available()
    formats = ["midi", "musicxml", "abc", "json", "alphatex", "notechart"]
    # PDF comes from the headless OSMD renderer, so it no longer depends on a
    # MuseScore install; MuseScore is still what engraves SVG.
    if osmd["ok"]:
        formats.append("pdf")
    if musescore is not None:
        formats.append("svg")
        if not osmd["ok"]:
            formats.append("pdf")
    return {
        "ok": True,
        "music21": importlib.util.find_spec("music21") is not None,
        "musescore": musescore is not None,
        "musescore_path": musescore,
        "osmd_pdf": osmd["ok"],
        "node": osmd["node"],
        "engines": {
            "midi_to_musicxml": "music21",
            "midi_to_tabs": "fretboard-dp",
            "midi_to_arrangement": "music21-arrange",
            "score_to_pdf": "osmd"
            if osmd["ok"]
            else ("musescore" if musescore else None),
            "score_to_notechart": "notechart",
            "future": ["mt3-sidecar", "audiveris-sidecar", "guitarpro-export"],
        },
        "formats": formats,
        "tab_tunings": sorted(TAB_TUNINGS.keys()),
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

# Entry sub-directories that hold notation artifacts.
_ARTIFACT_SUBDIRS = ("notation", "midi")


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
    for sub in _ARTIFACT_SUBDIRS:
        directory = entry_dir / sub
        if not directory.is_dir():
            continue
        for path in sorted(directory.iterdir()):
            if not path.is_file():
                continue
            kind = _KIND_FOR_SUFFIX.get(path.suffix.lower())
            if kind is None:
                continue
            artifact_id = f"{entry_id}__{path.stem}__{kind}"
            if db.get_notation_artifact(artifact_id) is not None:
                continue
            db.add_notation_artifact(
                artifact_id=artifact_id,
                entry_id=entry_id,
                kind=kind,
                path=str(path),
                source_ref=str(path),
                engine="recovered-from-disk",
                engine_version="1",
                metadata={"recovered": True, "source_dir": sub},
            )
            row = db.get_notation_artifact(artifact_id)
            if row:
                recovered.append(row)
    return recovered


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
) -> dict[str, Any]:
    """Convert a symbolic source (MIDI or MusicXML) to another notation format
    and register the result as a notation artifact.

    ``music21`` handles ``musicxml`` directly and ``abc`` is written by
    :mod:`.exporters.abc_writer` (music21 cannot write ABC). ``pdf`` and ``svg``
    are engraved by the MuseScore CLI when installed; without it they return
    ``ok=False`` with an install hint. When ``title`` is given it is stamped on
    the score so the rendered sheet shows the originating song's name.
    """
    fmt = fmt.lower().strip()
    if not source_path.is_file():
        return {"ok": False, "error": f"source not found: {source_path}"}
    if fmt == "abc":
        return _convert_to_abc(
            db,
            entry_id=entry_id,
            source_path=source_path,
            output_path=output_path,
            source_ref=source_ref,
            artifact_id=artifact_id,
            title=title,
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
    if fmt == "pdf":
        return _convert_to_pdf(
            db,
            entry_id=entry_id,
            source_path=source_path,
            output_path=output_path,
            source_ref=source_ref,
            artifact_id=artifact_id,
            title=title,
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
        )
    if fmt in _MUSESCORE_FORMATS:
        return _convert_with_musescore(
            db,
            entry_id=entry_id,
            source_path=source_path,
            fmt=fmt,
            output_path=output_path,
            source_ref=source_ref,
            artifact_id=artifact_id,
        )
    return {"ok": False, "error": f"unsupported notation format: {fmt!r}"}


def _convert_to_pdf(
    db: LibraryDB,
    *,
    entry_id: str,
    source_path: Path,
    output_path: Path,
    source_ref: Optional[str] = None,
    artifact_id: Optional[str] = None,
    title: str = "",
) -> dict[str, Any]:
    """Engrave a PDF with the frontend's OSMD, the engraver the SCORE tab uses.

    OSMD needs MusicXML, so a MIDI source is staged through music21 first. That
    staging file is written beside the output and removed afterwards, and it is
    deliberately NOT registered as an artifact: registering it would leave a DB
    row pointing at a path this function then deletes.
    """
    source = source_path
    scratch: Optional[Path] = None
    if source_path.suffix.lower() not in (".musicxml", ".xml"):
        if importlib.util.find_spec("music21") is None:
            return {"ok": False, "engine": "osmd", "error": "music21 is not installed."}
        scratch = output_path.with_name(f"{output_path.stem}__osmd_src.musicxml")
        try:
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
                    log.debug("notation: pdf staging title skipped: %s", exc)
            scratch.parent.mkdir(parents=True, exist_ok=True)
            staged_score.write("musicxml", fp=str(scratch))
            source = scratch
        except Exception as exc:  # noqa: BLE001
            log.warning("notation: pdf staging failed for %s: %s", source_path, exc)
            return {"ok": False, "engine": "osmd", "error": repr(exc)}

    result = pdf_render.render_musicxml_pdf(source, output_path, artist=artist_name())
    if scratch is not None and scratch.is_file():
        scratch.unlink(missing_ok=True)
    if not result.get("ok"):
        return {
            "ok": False,
            "engine": "osmd",
            "error": result.get("error") or "render failed",
        }

    registered = _register_conversion(
        db,
        entry_id=entry_id,
        fmt="pdf",
        final_path=output_path,
        source_path=source_path,
        source_ref=source_ref,
        artifact_id=artifact_id,
        engine="osmd",
        engine_version=pdf_render.renderer_version(),
    )
    registered["pages"] = result.get("pages", 0)
    return registered


def _convert_to_notechart(
    db: LibraryDB,
    *,
    entry_id: str,
    source_path: Path,
    output_path: Path,
    source_ref: Optional[str] = None,
    artifact_id: Optional[str] = None,
    title: str = "",
) -> dict[str, Any]:
    """Write the Unity flying-notation chart (timecode + spelled notes)."""
    try:
        from .exporters.notechart import write_notechart

        result = write_notechart(
            source_path,
            output_path,
            title=clean_title(title),
            artist=artist_name(),
            entry_id=entry_id,
            source_artifact_id=source_ref or "",
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
        source_path=source_path,
        source_ref=source_ref,
        artifact_id=artifact_id,
        engine="notechart",
        engine_version="1",
    )
    registered["stats"] = result.get("stats", {})
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
) -> dict[str, Any]:
    """Write ABC from a symbolic source using the local ABC writer.

    music21 parses the source; the text is produced by
    :func:`.exporters.abc_writer.score_to_abc` because music21 has no ABC
    writer. A score with no notes raises rather than registering an empty file.
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
        source_path=source_path,
        source_ref=source_ref,
        artifact_id=artifact_id,
        engine="abc-writer",
        engine_version="1",
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
    try:
        score = converter.parse(str(source_path))
        if score is None:
            raise ValueError(f"music21 could not parse {source_path}")
        # Quantize raw transcriptions to clean, notatable rhythms. Best-effort.
        try:
            score = score.quantize((4, 3), inPlace=False, recurse=True)
        except Exception as exc:  # noqa: BLE001 - quantize is best-effort
            log.debug("notation: music21 quantize skipped for %s: %s", source_path, exc)
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
) -> dict[str, Any]:
    binary = musescore_binary()
    if binary is None:
        return {
            "ok": False,
            "engine": "musescore",
            "error": (
                "MuseScore CLI not found. Install MuseScore 4 or set the "
                "MUSESCORE_BIN environment variable to enable PDF/SVG export."
            ),
        }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        proc = subprocess.run(
            [binary, "-o", str(output_path), str(source_path)],
            capture_output=True,
            text=True,
            timeout=180,
            stdin=subprocess.DEVNULL,
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
        source_path=source_path,
        source_ref=source_ref,
        artifact_id=artifact_id,
        engine="musescore",
        engine_version=_musescore_version(binary),
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
) -> dict[str, Any]:
    kind = _KIND_FOR_FORMAT.get(fmt, fmt)
    art_id = artifact_id or f"{entry_id}__{final_path.stem}__{kind}"
    db.add_notation_artifact(
        artifact_id=art_id,
        entry_id=entry_id,
        kind=kind,
        path=str(final_path),
        source_ref=source_ref or str(source_path),
        engine=engine,
        engine_version=engine_version,
        metadata={"source": str(source_path), "format": fmt},
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
