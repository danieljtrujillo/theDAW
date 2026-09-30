"""FastAPI router for symbolic notation artifacts and conversions."""

from __future__ import annotations

import io
import json
import logging
import mimetypes
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any, Mapping, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from backend.lib.cross_site import (
    refuse_cross_site,
    require_loopback_launch_or_pairing_token,
)
from backend.modules.library.router import get_store as get_library_store

from .arrangers.score_arrange import STYLES as ARRANGEMENT_STYLES
from .engine import (
    _chart_artist,
    _ENGRAVE_ENGINES,
    _musicxml_prolog_extras,
    _register_conversion,
    _scored_name,
    _set_musicxml_composer,
    _song_slug,
    _splice_musicxml_prolog_extras,
    capabilities,
    drop_superseded_recovery_rows,
    convert_score,
    legacy_sheet_midi,
    midi_to_arrangement,
    midi_to_musicxml,
    midi_to_tabs,
    part_names,
    register_on_disk_artifacts,
    rewrite_sheet_from_midi,
    sheet_output_path,
    stage_parts,
)
from .sheet_pitch import legacy_sounding_pitch

log = logging.getLogger(__name__)

router = APIRouter()


# Output file extension for each supported export format.
_EXT_FOR_FORMAT = {
    "musicxml": ".musicxml",
    "abc": ".abc",
    "pdf": ".pdf",
    "svg": ".svg",
    # The Unity flying-notation chart. Double extension so it is obvious on disk
    # that the payload is JSON while still identifying what kind of JSON.
    "notechart": ".notechart.json",
    # A zipped Beat Saber custom level (Info.dat + <Difficulty>.dat + song.ogg).
    "beatsaber": ".beatsaber.zip",
    # The score as MIDI at the pitch every part sounds (one track per part,
    # tempo and meter maps): exporters/sounding_midi.py.
    "midi": ".sounding.mid",
    # The score rendered by MuseScore 4 with Muse Sounds. The WAV is written
    # here, copied into a new Library entry, and removed (musescore_render).
    "audio": ".wav",
}

# The one export target this router writes itself (exporters/sounding_midi.py)
# rather than through ``convert_score``.
SOUNDING_MIDI_FORMAT = "midi"

# Formats written into their own sub-directory of notation/ (the Beat Saber
# writer leaves the unzipped level folder beside the zip, which would clutter
# the flat notation/ listing).
_SUBDIR_FOR_FORMAT = {"beatsaber": "beatsaber"}

# Chord-track file name suffix (the CHORDS play-along document).
_CHORDTRACK_SUFFIX = ".chordtrack.json"
_CHORDTRACK_METHODS = ("auto", "harmony", "chroma")
_CHORDTRACK_RESOLUTIONS = ("beat", "bar")


def _entry_title(store: Any, entry_id: str) -> str:
    entry = store.get_entry(entry_id)
    return str(getattr(entry, "title", "") or "") if entry is not None else ""


# Name fields to parse for the auto-guess, best first -- mirrors
# ``identity._NAME_KEYS`` (private, so kept local rather than imported).
_IDENTITY_NAME_KEYS = ("title", "filename", "audio_filename", "media_filename")


def _identity_field(entry: Any, key: str) -> str:
    """Read one string field off a DB entry row, checking ``metadata_json``
    when the key is not one of the row's own columns.

    Mirrors :func:`backend.modules.notation.identity._lookup`'s two-shape
    read (top-level column, then a JSON-string or dict ``metadata_json``)
    without pulling that private helper in -- the same convention
    ``engine._lookup_field`` already uses for the columns it needs.
    """
    if not isinstance(entry, Mapping):
        value = getattr(entry, key, None)
        if value:
            return str(value).strip()
        raw_meta = getattr(entry, "metadata_json", None)
    else:
        value = entry.get(key)
        if value:
            return str(value).strip()
        raw_meta = entry.get("metadata_json")

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


def _parts_option(options: Optional[dict[str, Any]]) -> list[int]:
    """``options["parts"]`` as a de-duplicated list of ints (request order),
    or ``[]``: absent, empty, not a list, or nothing in it is an int."""
    raw = (options or {}).get("parts")
    if not isinstance(raw, list):
        return []
    out: list[int] = []
    for p in raw:
        try:
            idx = int(p)
        except (TypeError, ValueError):
            continue
        if idx not in out:
            out.append(idx)
    return out


def _parse_parts_query(parts: Optional[str]) -> list[int]:
    """``?parts=0,2`` -> ``[0, 2]``; 422 on anything that is not ints."""
    if parts is None or not parts.strip():
        return []
    try:
        return _parts_option({"parts": [int(p) for p in parts.split(",") if p.strip()]})
    except ValueError as exc:
        raise HTTPException(
            422, f"parts must be comma-separated ints: {parts!r}"
        ) from exc


def _parts_suffix(source_path: Path, parts: list[int]) -> str:
    """A file-name tag for a part-scoped export: the kept parts' names slugged
    (``Bass``, ``Lead-Bass``), ``p<idx>`` for an unnamed or unknown part."""
    names = part_names(source_path)
    tags = [
        _song_slug(names[i] if 0 <= i < len(names) else "", fallback=f"p{i}")
        for i in parts
    ]
    return "-".join(tags)[:80]


def _export_artifact_id(source_id: str, fmt: str, parts: list[int]) -> str:
    """``<source>__<fmt>`` for the whole sheet; ``<source>__<fmt>__p0-2`` for a
    part-scoped export, so it never overwrites the whole-sheet row."""
    if not parts:
        return f"{source_id}__{fmt}"
    return f"{source_id}__{fmt}__p{'-'.join(str(i) for i in parts)}"


class ExportRequest(BaseModel):
    source_artifact_id: str
    format: str
    # Per-format export options. Every format reads `parts` (indices in
    # <part-list> order) to export only those parts, and pdf/svg read `engine`
    # ('osmd'|'musescore') to pin an engraver. Beat Saber also reads:
    # difficulties (list of Easy/Normal/Hard/Expert/ExpertPlus), version (2|3),
    # bpm_source ('analysis'|'chart') and include_audio.
    options: dict[str, Any] = Field(default_factory=dict)


class ChordsRequest(BaseModel):
    source: str = "auto"
    source_artifact_id: Optional[str] = None
    include_sevenths: bool = True
    resolution: str = "beat"


class TabsRequest(BaseModel):
    source_artifact_id: Optional[str] = None
    midi_id: Optional[str] = None
    instrument: str = "guitar"
    tuning_name: Optional[str] = None
    tuning: Optional[list[int]] = None
    capo: int = 0
    difficulty: str = "medium"


class ArrangeRequest(BaseModel):
    style: str
    source_artifact_id: Optional[str] = None
    source_artifact_ids: Optional[list[str]] = None
    midi_id: Optional[str] = None
    # Band score: source artifact id -> orchestral registry instrument id
    # (backend/modules/notation/instruments.py). A source left out keeps the
    # staff named and clefed from its file.
    instruments: Optional[dict[str, str]] = None


def _resolve_midi_artifact_path(store: Any, entry_id: str, artifact_id: str) -> Path:
    artifact = store.db.get_notation_artifact(artifact_id)
    if (
        artifact is None
        or artifact.get("entry_id") != entry_id
        or artifact.get("kind") != "midi"
    ):
        raise HTTPException(404, f"MIDI artifact {artifact_id!r} not found for entry")
    path = Path(artifact.get("path") or "")
    if not path.is_file():
        raise HTTPException(404, f"MIDI file missing on disk: {path}")
    return path


@router.get("")
@router.get("/")
def get_capabilities() -> dict[str, Any]:
    from .score_import import IMPORT_SUFFIXES, MAX_IMPORT_BYTES

    caps = capabilities()
    caps["score_import"] = {
        "extensions": list(IMPORT_SUFFIXES),
        "max_bytes": MAX_IMPORT_BYTES,
        "corpus": bool(caps.get("music21")),
    }
    return caps


def _import_error(exc: Exception) -> HTTPException:
    status = int(getattr(exc, "status", 422) or 422)
    return HTTPException(status, str(exc))


@router.post(
    "/import",
    dependencies=[
        Depends(refuse_cross_site),
        Depends(require_loopback_launch_or_pairing_token),
    ],
)
async def import_score_file(file: UploadFile = File(...)) -> dict[str, Any]:
    """Import a score file as a composition entry of its own.

    Takes ``.musicxml``, ``.xml``, ``.mxl``, ``.krn`` or ``.abc``, at most
    ``MAX_IMPORT_BYTES``. music21 parses it; the entry keeps the original file
    and a MusicXML sheet for the SCORE tab, titled and credited from the
    file's own metadata (see :mod:`.score_import`). Guarded like every other
    route that writes a file: a page outside theDAW is refused, and so is a
    LAN caller without the launch or pairing token. Only the final component
    of the uploaded name is read, and only for its suffix and display name;
    every file is written under the new entry's own ``notation/`` folder.
    """
    from .score_import import (
        IMPORT_SUFFIXES,
        MAX_IMPORT_BYTES,
        ScoreImportError,
        import_kind,
        import_score_upload,
        safe_filename,
    )

    name = safe_filename(file.filename or "")
    if import_kind(name) is None:
        raise HTTPException(
            415,
            f"{name or 'the file'} is not a score file; import takes "
            f"{', '.join(IMPORT_SUFFIXES)}",
        )
    data = await file.read(MAX_IMPORT_BYTES + 1)
    if not data:
        raise HTTPException(400, "Empty file")
    if len(data) > MAX_IMPORT_BYTES:
        raise HTTPException(413, "Score file too large")
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    try:
        return await run_in_threadpool(import_score_upload, store, data, name)
    except ScoreImportError as exc:
        raise _import_error(exc) from exc


@router.get("/corpus")
def search_corpus(q: str = "", limit: int = 50) -> dict[str, Any]:
    """Search the music21 corpus bundled with music21 (composer, title,
    movement, path; case-insensitive). Each result carries the ``id``
    ``POST /corpus/open`` takes."""
    from backend.modules.sheetimport.corpus import search

    try:
        return search(q, limit)
    except ImportError as exc:
        raise HTTPException(503, f"music21 is not available: {exc}") from exc


class CorpusOpenRequest(BaseModel):
    id: str


@router.post(
    "/corpus/open",
    dependencies=[
        Depends(refuse_cross_site),
        Depends(require_loopback_launch_or_pairing_token),
    ],
)
def open_corpus_piece(body: CorpusOpenRequest) -> dict[str, Any]:
    """Import one corpus piece (an ``id`` from ``GET /corpus``) as a
    composition entry, the same way ``POST /import`` imports a file."""
    from .score_import import ScoreImportError, import_corpus_piece

    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    try:
        return import_corpus_piece(store, body.id)
    except ScoreImportError as exc:
        raise _import_error(exc) from exc


@router.get("/musescore")
def get_musescore() -> dict[str, Any]:
    """Whether a score can be rendered to audio here: ``{found, path,
    muse_sounds, reason}`` for MuseScore 4 and Muse Sounds
    (:func:`.musescore_render.musescore_status`); ``reason`` is empty when the
    "audio" export can run, and says what is missing otherwise."""
    from .musescore_render import musescore_status

    return musescore_status()


def _entry_known(store: Any, entry_id: str) -> bool:
    """Whether ``entry_id`` is known to the library at all: a DB row OR an
    on-disk entry directory, whichever answers first.

    Neither source alone is authoritative. ``engine.register_on_disk_artifacts``
    documents (its own "FOREIGN KEY onto entries(id)" comment) that the
    library can legitimately surface a directory present on disk that
    indexing has not committed to the DB yet -- checking only
    ``store.db.get_entry`` would 404 that real, if momentary, state. Checking
    only the filesystem-backed ``store.get_entry`` has the opposite gap: it
    404s an indexed entry whose directory or metadata.json is unreadable.
    ``/{entry_id}/artifacts`` and ``/{entry_id}/identity`` both call this, so
    they agree on which entries exist.
    """
    return (
        store.db.get_entry(entry_id) is not None
        or store.get_entry(entry_id) is not None
    )


@router.get("/{entry_id}/artifacts")
def list_artifacts(entry_id: str, kind: Optional[str] = None) -> dict[str, Any]:
    """A pure read of the entry's registered artifacts (SCORE-009).

    This used to self-heal on every call -- mirroring the legacy ``midis``
    table and, when the DB had nothing at all, scanning the entry's own
    directories for files whose rows were lost. Both are real recovery paths,
    but a GET must not write: they now live only where a caller means to
    trigger recovery -- ``POST /reindex`` (below) for the on-disk scan, and
    the score-generation job (``library.store._generate_score_for_entry``)
    for the legacy-``midis`` mirror, which runs it before the sheet it is
    about to add would need it listed.

    Existence is checked via :func:`_entry_known` (DB row OR on-disk
    directory), the same check ``/{entry_id}/identity`` uses. An entry known
    only on disk (not yet indexed) answers here with an empty list rather
    than 404 -- ``store.db.list_notation_artifacts`` naturally returns ``[]``
    for an id with no rows, which is the honest answer for that entry, not
    an error.
    """
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    if not _entry_known(store, entry_id):
        raise HTTPException(404, f"entry {entry_id!r} not found")
    # One canonical artifact per file: a legacy library can still hold a
    # filename-derived ``recovered-from-disk`` row beside the real row for the
    # same file until the consolidator retires it. Both rows are kept in the DB;
    # only the shadowed one is withheld from the response. Coverage is computed
    # over the entry's WHOLE listing so a ``kind`` filter cannot hide the real
    # row that shadows a recovery row.
    artifacts = drop_superseded_recovery_rows(
        store.db.list_notation_artifacts(entry_id)
    )
    if kind:
        artifacts = [a for a in artifacts if a.get("kind") == kind]
    # A sheet an older build wrote at sounding pitch says so, and whether the
    # MIDI it came from is here to rewrite it (POST .../rewrite-from-midi).
    # Both are reads of the sheet's own bytes and the rows above.
    for artifact in artifacts:
        if artifact.get("kind") != "musicxml":
            continue
        # An imported sheet is the user's own file (or one written from it at
        # written pitch), never a sheet an older build of this app wrote.
        legacy = not _artifact_metadata(artifact).get(
            "imported"
        ) and legacy_sounding_pitch(Path(str(artifact.get("path") or "")))
        artifact["legacy_sounding_pitch"] = legacy
        artifact["rewrite_from_midi"] = (
            legacy and legacy_sheet_midi(store.db, artifact) is not None
        )
    return {"entry_id": entry_id, "artifacts": artifacts, "count": len(artifacts)}


@router.get("/{entry_id}/identity")
def get_identity(entry_id: str) -> dict[str, Any]:
    """The notation artist/title resolution for an entry (SCORE-001).

    ``override_artist`` / ``override_title`` are the user's manual corrections
    (the DETAILS inspector's identity form, persisted through
    ``PATCH /api/library/entries/{id}`` -> ``notation_artist`` /
    ``notation_title``, see ``library.store.USER_MUTABLE_FIELDS``).
    ``auto_artist`` / ``auto_title`` are what :func:`.identity.split_artist_title`
    parses from the entry's own name with no override applied -- empty when
    the split is not confident.

    Existence is checked via :func:`_entry_known` (DB row OR on-disk
    directory), the same check ``/{entry_id}/artifacts`` uses. The DB row is
    still preferred for the actual fields when it exists -- it is the only
    place ``metadata_json`` (where a saved override lives) is available --
    falling back to the on-disk record's plain title for the auto-guess when
    the entry is known only on disk: there cannot be a saved override yet if
    there is no DB row to have saved it into.
    """
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    entry = store.db.get_entry(entry_id)
    if entry is None:
        entry = store.get_entry(entry_id)
    if entry is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")

    from . import identity

    override_artist = _identity_field(entry, identity.OVERRIDE_ARTIST_KEY)
    override_title = _identity_field(entry, identity.OVERRIDE_TITLE_KEY)

    raw_name = ""
    for key in _IDENTITY_NAME_KEYS:
        raw_name = _identity_field(entry, key)
        if raw_name:
            break
    auto_artist, auto_title = identity.split_artist_title(raw_name)

    return {
        "entry_id": entry_id,
        "override_artist": override_artist,
        "override_title": override_title,
        "auto_artist": auto_artist,
        "auto_title": auto_title,
    }


@router.post(
    "/reindex",
    dependencies=[
        Depends(refuse_cross_site),
        Depends(require_loopback_launch_or_pairing_token),
    ],
)
def reindex_artifacts() -> dict[str, Any]:
    """Re-register every notation artifact found on disk across the library.

    Recovers scores and MIDI whose ``notation_artifacts`` rows were lost while
    the files survived. Idempotent: already-registered artifacts are skipped, so
    this is safe to run repeatedly.
    """
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    entries = store.list_entries()
    scanned = 0
    recovered_total = 0
    entries_touched = 0
    for entry in entries:
        entry_id = str(getattr(entry, "id", "") or "")
        if not entry_id:
            continue
        entry_dir = store._dir_for(entry_id)  # noqa: SLF001 - existing module convention
        if entry_dir is None:
            continue
        scanned += 1
        recovered = register_on_disk_artifacts(store.db, entry_dir, entry_id)
        if recovered:
            entries_touched += 1
            recovered_total += len(recovered)
    log.info(
        "notation reindex: %d artifact(s) recovered across %d of %d entries scanned",
        recovered_total,
        entries_touched,
        scanned,
    )
    return {
        "ok": True,
        "entries_scanned": scanned,
        "entries_recovered": entries_touched,
        "artifacts_recovered": recovered_total,
    }


@router.post(
    "/{entry_id}/from-midi/{midi_id}",
    dependencies=[
        Depends(refuse_cross_site),
        Depends(require_loopback_launch_or_pairing_token),
    ],
)
def convert_midi_artifact(entry_id: str, midi_id: str) -> dict[str, Any]:
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    entry = store.get_entry(entry_id)
    if entry is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")
    title = str(getattr(entry, "title", "") or "")
    midi_row = None
    for row in store.db.list_midis(entry_id):
        if row.get("id") == midi_id:
            midi_row = row
            break
    if midi_row is None:
        raise HTTPException(404, f"midi {midi_id!r} not found for entry {entry_id!r}")
    entry_dir = store._dir_for(entry_id)  # noqa: SLF001 - existing module convention
    if entry_dir is None:
        raise HTTPException(500, f"entry directory missing for {entry_id!r}")
    # engine.sheet_output_path is the single naming authority for this sheet
    # (the notation backfill writes the same artifact id through it too). It only
    # returns None when the entry has no directory, which is already a 500 above.
    output = sheet_output_path(store, entry_id, midi_id)
    assert output is not None  # entry_dir checked non-None directly above
    result = midi_to_musicxml(
        store.db,
        entry_id=entry_id,
        midi_path=Path(midi_row.get("midi_path") or ""),
        output_path=output,
        source_ref=midi_id,
        artifact_id=f"{midi_id}__musicxml",
        title=title,
    )
    if not result.get("ok"):
        raise HTTPException(501, result)
    return result


@router.post(
    "/{entry_id}/rewrite-from-midi/{artifact_id}",
    dependencies=[
        Depends(refuse_cross_site),
        Depends(require_loopback_launch_or_pairing_token),
    ],
)
def rewrite_legacy_sheet(entry_id: str, artifact_id: str) -> dict[str, Any]:
    """Engrave a sheet an older build wrote at sounding pitch again from its
    MIDI, at written pitch, over the same file (the SCORE tab's "Rewrite from
    MIDI"). The old file is kept until the new one is written; see
    :func:`.engine.rewrite_sheet_from_midi`."""
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    artifact = store.db.get_notation_artifact(artifact_id)
    if artifact is None or artifact.get("entry_id") != entry_id:
        raise HTTPException(404, f"artifact {artifact_id!r} not found for entry")
    if artifact.get("kind") != "musicxml":
        raise HTTPException(400, f"artifact {artifact_id!r} is not a MusicXML sheet")
    result = rewrite_sheet_from_midi(
        store.db, artifact, title=_entry_title(store, entry_id)
    )
    if not result.get("ok"):
        reason = result.get("reason")
        status = (
            409
            if reason == "not-legacy"
            else 404
            if reason in ("no-midi", "not-a-sheet")
            else 500
        )
        raise HTTPException(status, result)
    log.info("notation: rewrote %s from its MIDI at written pitch", artifact_id)
    return result


@router.post(
    "/{entry_id}/export",
    dependencies=[
        Depends(refuse_cross_site),
        Depends(require_loopback_launch_or_pairing_token),
    ],
)
def export_artifact(entry_id: str, body: ExportRequest) -> dict[str, Any]:
    """Export an existing notation artifact (MIDI or MusicXML) to another
    format and register the result. Targets: the keys of ``_EXT_FOR_FORMAT``
    (musicxml, abc, pdf, svg, notechart, beatsaber, midi, audio). ``pdf``
    and ``svg`` are engraved by the headless OSMD renderer, or by MuseScore
    when that is missing (``options.engine`` pins one). ``midi`` is the score
    at sounding pitch, one track per part (:func:`_export_sounding_midi`).
    ``audio`` is rendered by MuseScore 4 with Muse Sounds into a new Library
    entry; its result carries ``library_entry_id`` in place of an artifact.

    ``options.parts`` (a non-empty list of part indices, ``<part-list>``
    order) scopes any format to those parts. The file is then named
    ``<stem>__<part slug>`` and the artifact ``<source>__<fmt>__p<i-j>``, so
    a per-part export sits beside the whole-sheet one instead of replacing it.
    """
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    if store.get_entry(entry_id) is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")

    fmt = body.format.lower().strip()
    ext = _EXT_FOR_FORMAT.get(fmt)
    if ext is None:
        raise HTTPException(422, f"unsupported export format: {body.format!r}")

    source = store.db.get_notation_artifact(body.source_artifact_id)
    if source is None or source.get("entry_id") != entry_id:
        raise HTTPException(
            404,
            f"artifact {body.source_artifact_id!r} not found for entry {entry_id!r}",
        )
    source_path = Path(source.get("path") or "")
    if not source_path.is_file():
        raise HTTPException(404, f"artifact file missing on disk: {source_path}")

    entry_dir = store._dir_for(entry_id)  # noqa: SLF001 - existing module convention
    if entry_dir is None:
        raise HTTPException(500, f"entry directory missing for {entry_id!r}")
    entry = store.get_entry(entry_id)
    title = str(getattr(entry, "title", "") or "") if entry is not None else ""
    slug = _song_slug(title)
    out_dir = entry_dir / "notation"
    subdir = _SUBDIR_FOR_FORMAT.get(fmt)
    if subdir:
        out_dir = out_dir / subdir
    parts = _parts_option(body.options)
    part_tag = _parts_suffix(source_path, parts) if parts else ""
    base = (
        f"{source_path.stem}__{part_tag}{ext}"
        if part_tag
        else f"{source_path.stem}{ext}"
    )
    output = out_dir / _scored_name(slug, base)

    # Audio context for the chart-based targets (notechart duration, Beat Saber
    # song.ogg + Info.dat BPM). Harmless for the symbolic formats.
    if fmt == SOUNDING_MIDI_FORMAT:
        result = _export_sounding_midi(
            store.db,
            entry_id=entry_id,
            source_path=source_path,
            output_path=output,
            source_ref=body.source_artifact_id,
            artifact_id=_export_artifact_id(body.source_artifact_id, fmt, parts),
            parts=parts,
            title=title,
        )
        if not result.get("ok"):
            raise HTTPException(501, result)
        return result

    audio_path = store.get_audio_path(entry_id)
    duration = getattr(entry, "duration", None) if entry is not None else None
    audio_duration_sec = float(duration) if duration else None
    analysis_bpm = _analysis_bpm(store, entry_id)

    result = convert_score(
        store.db,
        entry_id=entry_id,
        source_path=source_path,
        fmt=fmt,
        output_path=output,
        source_ref=body.source_artifact_id,
        artifact_id=_export_artifact_id(body.source_artifact_id, fmt, parts),
        title=title,
        options=dict(body.options or {}),
        audio_path=audio_path,
        audio_duration_sec=audio_duration_sec,
        analysis_bpm=analysis_bpm,
    )
    if not result.get("ok"):
        raise HTTPException(501, result)
    return result


def _export_sounding_midi(
    db: Any,
    *,
    entry_id: str,
    source_path: Path,
    output_path: Path,
    source_ref: str,
    artifact_id: str,
    parts: list[int],
    title: str,
) -> dict[str, Any]:
    """Write the score as MIDI at sounding pitch (``exporters.sounding_midi``)
    and register it as a ``midi`` artifact. ``parts`` scopes it to those
    parts the way every other target is scoped: :func:`.engine.stage_parts`
    filters the sheet, the writer reads the staged file, and the staged file
    is removed afterwards and never registered."""
    from .exporters.sounding_midi import ENGINE, ENGINE_VERSION, write_sounding_midi

    staged_path: Optional[Path] = None
    extra: dict[str, Any] = {"sounding_pitch": True}
    try:
        source = source_path
        if parts:
            entry = db.get_entry(entry_id) if entry_id else None
            try:
                staged = stage_parts(
                    source_path,
                    parts,
                    title,
                    output_path=output_path,
                    artist=_chart_artist(entry),
                )
            except Exception as exc:
                return {"ok": False, "engine": ENGINE, "error": str(exc) or repr(exc)}
            staged_path = source = staged.path
            extra["parts"] = staged.parts
        result = write_sounding_midi(source, output_path)
    finally:
        if staged_path is not None:
            staged_path.unlink(missing_ok=True)
    if not result.get("ok"):
        return result
    extra["tracks"] = result.get("tracks", [])
    registered = _register_conversion(
        db,
        entry_id=entry_id,
        fmt=SOUNDING_MIDI_FORMAT,
        final_path=Path(str(result["path"])),
        source_path=source_path,
        source_ref=source_ref,
        artifact_id=artifact_id,
        engine=ENGINE,
        engine_version=ENGINE_VERSION,
        extra_metadata=extra,
    )
    registered["tracks"] = extra["tracks"]
    return registered


def _artifact_metadata(artifact: dict[str, Any]) -> dict[str, Any]:
    """The parsed ``metadata_json`` of a notation artifact row (``{}`` when
    missing or unparsable)."""
    raw = artifact.get("metadata_json") or artifact.get("metadata") or {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return {}
    return raw if isinstance(raw, dict) else {}


# ``_musicxml_prolog_extras`` / ``_splice_musicxml_prolog_extras`` live in
# ``.engine`` (imported above) so ``backfill.py``'s in-place ``_rewrite_titles``
# -- the same ElementTree round trip, run over the user's real library files --
# shares the identical, well-formedness-safe implementation rather than a
# second copy that could drift.


def _analysis_bpm(store: Any, entry_id: str) -> Optional[float]:
    """The entry's analysed tempo, checked the way the MIDI runner checks the
    tempo it stamps on the entry's MIDI (``analysis.tempo.analysis_tempo``):
    an estimate outside the sane range gives way to the beat list's own
    tempo. None when neither is usable."""
    from backend.modules.analysis.tempo import analysis_tempo

    return analysis_tempo(store.db.get_analysis(entry_id)).bpm


def _find_lead_sheet(
    store: Any, entry_id: str, source_artifact_id: Optional[str]
) -> Optional[dict[str, Any]]:
    """The MusicXML artifact the chord track reads ``<harmony>`` from.

    An explicit ``source_artifact_id`` must be a MusicXML artifact of this entry
    whose file exists (404 otherwise); with none given, the newest ``musicxml``
    artifact arranged in the ``lead-sheet`` style that still exists on disk is
    used, or ``None`` when the entry has no lead sheet.
    """
    if source_artifact_id:
        artifact = store.db.get_notation_artifact(source_artifact_id)
        if (
            artifact is None
            or artifact.get("entry_id") != entry_id
            or artifact.get("kind") != "musicxml"
        ):
            raise HTTPException(
                404, f"MusicXML artifact {source_artifact_id!r} not found for entry"
            )
        if not Path(artifact.get("path") or "").is_file():
            raise HTTPException(
                404, f"artifact file missing on disk: {artifact.get('path')}"
            )
        return artifact
    # Same one-canonical-artifact-per-file rule the listing route applies, so a
    # shadowed recovered-from-disk row is never chosen as a chord-track source.
    candidates = drop_superseded_recovery_rows(
        store.db.list_notation_artifacts(entry_id, kind="musicxml")
    )
    for artifact in reversed(candidates):  # list is oldest-first
        if _artifact_metadata(artifact).get("style") != "lead-sheet":
            continue
        if Path(artifact.get("path") or "").is_file():
            return artifact
    return None


@router.post(
    "/{entry_id}/chords",
    dependencies=[
        Depends(refuse_cross_site),
        Depends(require_loopback_launch_or_pairing_token),
    ],
)
def make_chords(entry_id: str, body: ChordsRequest) -> dict[str, Any]:
    """Build the entry's chord track (``gantasmo.chordtrack``) and register it
    as a ``chordtrack`` notation artifact.

    ``source`` 'harmony' reads the ``<harmony>`` symbols of a lead sheet,
    'chroma' estimates chords from the audio (seeded by the analysis row when
    present), 'auto' prefers the lead sheet when it carries symbols. 404 when
    nothing can be derived; 501 with the builder's error dict on failure.
    """
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    # An entry whose audio file is gone still resolves to its directory (and is
    # never indexed into the DB), so the directory is the existence check here;
    # the audio-less case is reported below as 'no audio', which is the useful
    # answer. The DB row is required only to register the result (FK).
    entry_dir = store._dir_for(entry_id)  # noqa: SLF001 - existing module convention
    if entry_dir is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")

    source = (body.source or "auto").lower().strip()
    if source not in _CHORDTRACK_METHODS:
        raise HTTPException(
            422, f"unknown chord source {body.source!r}; expected {_CHORDTRACK_METHODS}"
        )
    resolution = (body.resolution or "beat").lower().strip()
    if resolution not in _CHORDTRACK_RESOLUTIONS:
        raise HTTPException(
            422,
            f"unknown resolution {body.resolution!r}; expected {_CHORDTRACK_RESOLUTIONS}",
        )

    lead_sheet = _find_lead_sheet(store, entry_id, body.source_artifact_id)
    audio_path = store.get_audio_path(entry_id)
    analysis_row = store.db.get_analysis(entry_id)

    if source == "harmony" and lead_sheet is None:
        raise HTTPException(
            404, "no lead sheet for this entry; ARRANGE lead-sheet first"
        )
    if source == "chroma" and audio_path is None:
        raise HTTPException(404, "no audio for this entry")
    if lead_sheet is None and audio_path is None:
        raise HTTPException(
            404,
            "no audio and no lead sheet for this entry; nothing to derive chords from",
        )
    if store.db.get_entry(entry_id) is None:
        raise HTTPException(404, f"entry {entry_id!r} is not indexed in the library")

    from .exporters.chordtrack import write_chordtrack

    entry = store.get_entry(entry_id)
    title = str(getattr(entry, "title", "") or "") if entry is not None else ""
    slug = _song_slug(title)
    output = entry_dir / "notation" / f"{slug}__chords{_CHORDTRACK_SUFFIX}"
    lead_id = str(lead_sheet.get("id") or "") if lead_sheet else ""
    result = write_chordtrack(
        output,
        entry_id=entry_id,
        audio_path=audio_path,
        analysis_row=analysis_row,
        lead_sheet_path=Path(str(lead_sheet["path"])) if lead_sheet else None,
        method=source,
        include_sevenths=bool(body.include_sevenths),
        resolution=resolution,
        source_artifact_id=lead_id,
    )
    if not result.get("ok"):
        raise HTTPException(501, result)

    artifact_id = f"{entry_id}__chords__chordtrack"
    source_ref = lead_id or (str(audio_path) if audio_path else "")
    store.db.add_notation_artifact(
        artifact_id=artifact_id,
        entry_id=entry_id,
        kind="chordtrack",
        path=str(result.get("path") or output),
        source_ref=source_ref or None,
        engine=str(result.get("engine") or "chordtrack"),
        engine_version=str(result.get("engine_version") or "1"),
        metadata={
            "format": "chordtrack",
            "method": result.get("method"),
            "stats": result.get("stats", {}),
            "source": source,
            "resolution": resolution,
            "include_sevenths": bool(body.include_sevenths),
            "lead_sheet_artifact_id": lead_id,
        },
    )
    if source_ref:
        store.db.add_relation(
            from_id=source_ref,
            to_id=artifact_id,
            kind="charted_as_chords",
            metadata={"method": result.get("method"), "engine": "chordtrack"},
        )
    return {
        "ok": True,
        "artifact": store.db.get_notation_artifact(artifact_id),
        "path": str(result.get("path") or output),
        "engine": "chordtrack",
        "method": result.get("method"),
        "stats": result.get("stats", {}),
    }


@router.post(
    "/{entry_id}/tabs",
    dependencies=[
        Depends(refuse_cross_site),
        Depends(require_loopback_launch_or_pairing_token),
    ],
)
def make_tabs(entry_id: str, body: TabsRequest) -> dict[str, Any]:
    """Arrange a MIDI artifact into guitar/bass tablature (alphaTex).

    The source MIDI is either a notation artifact (``source_artifact_id`` of
    kind ``midi``) or a legacy ``midi_id``."""
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    entry = store.get_entry(entry_id)
    if entry is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")

    midi_path: Optional[Path] = None
    source_ref: Optional[str] = None
    stem: Optional[str] = None
    if body.source_artifact_id:
        artifact = store.db.get_notation_artifact(body.source_artifact_id)
        if (
            artifact is None
            or artifact.get("entry_id") != entry_id
            or artifact.get("kind") != "midi"
        ):
            raise HTTPException(
                404, f"MIDI artifact {body.source_artifact_id!r} not found for entry"
            )
        midi_path = Path(artifact.get("path") or "")
        source_ref = body.source_artifact_id
        stem = midi_path.stem
    elif body.midi_id:
        midi_row = None
        for row in store.db.list_midis(entry_id):
            if row.get("id") == body.midi_id:
                midi_row = row
                break
        if midi_row is None:
            raise HTTPException(404, f"midi {body.midi_id!r} not found for entry")
        midi_path = Path(midi_row.get("midi_path") or "")
        source_ref = body.midi_id
        stem = body.midi_id
    else:
        raise HTTPException(422, "source_artifact_id or midi_id is required")

    if midi_path is None or not midi_path.is_file():
        raise HTTPException(404, f"MIDI file missing on disk: {midi_path}")

    entry_dir = store._dir_for(entry_id)  # noqa: SLF001 - existing module convention
    if entry_dir is None:
        raise HTTPException(500, f"entry directory missing for {entry_id!r}")
    slug = _song_slug(str(getattr(entry, "title", "") or ""))
    output = (
        entry_dir
        / "notation"
        / _scored_name(slug, f"{stem}__{body.instrument}.alphatex")
    )
    result = midi_to_tabs(
        store.db,
        entry_id=entry_id,
        midi_path=midi_path,
        output_path=output,
        instrument=body.instrument,
        tuning=body.tuning,
        tuning_name=body.tuning_name,
        capo=body.capo,
        difficulty=body.difficulty,
        title=str(getattr(entry, "title", "") or ""),
        source_ref=source_ref,
        artifact_id=f"{source_ref}__{body.instrument}__alphatex",
    )
    if not result.get("ok"):
        raise HTTPException(501, result)
    return result


@router.post(
    "/{entry_id}/arrange",
    dependencies=[
        Depends(refuse_cross_site),
        Depends(require_loopback_launch_or_pairing_token),
    ],
)
def make_arrangement(entry_id: str, body: ArrangeRequest) -> dict[str, Any]:
    """Arrange MIDI artifact(s) into a MusicXML score.

    Styles: lead-sheet, piano-reduction, simplified, band-score. ``band-score``
    takes ``source_artifact_ids`` (one staff per stem MIDI); the others take a
    single ``source_artifact_id`` or legacy ``midi_id``."""
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    entry = store.get_entry(entry_id)
    if entry is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")

    style = body.style.lower().strip()
    if style not in ARRANGEMENT_STYLES:
        raise HTTPException(422, f"unknown arrangement style: {body.style!r}")

    sources: list[Path] = []
    source_ref: Optional[str] = None
    if body.source_artifact_ids:
        for artifact_id in body.source_artifact_ids:
            sources.append(_resolve_midi_artifact_path(store, entry_id, artifact_id))
        source_ref = body.source_artifact_ids[0]
    elif body.source_artifact_id:
        sources.append(
            _resolve_midi_artifact_path(store, entry_id, body.source_artifact_id)
        )
        source_ref = body.source_artifact_id
    elif body.midi_id:
        midi_row = None
        for row in store.db.list_midis(entry_id):
            if row.get("id") == body.midi_id:
                midi_row = row
                break
        if midi_row is None:
            raise HTTPException(404, f"midi {body.midi_id!r} not found for entry")
        path = Path(midi_row.get("midi_path") or "")
        if not path.is_file():
            raise HTTPException(404, f"MIDI file missing on disk: {path}")
        sources.append(path)
        source_ref = body.midi_id
    else:
        raise HTTPException(422, "source_artifact_id(s) or midi_id is required")

    staff_instruments: Optional[list[Optional[str]]] = None
    if body.instruments:
        from .instruments import by_id

        ids = body.source_artifact_ids or []
        stray = sorted(set(body.instruments) - set(ids))
        if stray:
            raise HTTPException(
                422, f"instruments name artifacts that are not sources: {stray}"
            )
        unknown = sorted(
            {v for v in body.instruments.values() if v and by_id(v) is None}
        )
        if unknown:
            raise HTTPException(422, f"unknown instrument(s): {unknown}")
        staff_instruments = [body.instruments.get(i) or None for i in ids]

    entry_dir = store._dir_for(entry_id)  # noqa: SLF001 - existing module convention
    if entry_dir is None:
        raise HTTPException(500, f"entry directory missing for {entry_id!r}")
    slug = _song_slug(str(getattr(entry, "title", "") or ""))
    output = (
        entry_dir
        / "notation"
        / _scored_name(slug, f"{sources[0].stem}__{style}.musicxml")
    )
    result = midi_to_arrangement(
        store.db,
        entry_id=entry_id,
        sources=sources,
        style=style,
        output_path=output,
        source_ref=source_ref,
        title=str(getattr(entry, "title", "") or ""),
        artifact_id=f"{source_ref}__{style}__musicxml",
        # A band score lays every staff out at the song's tempo, so its bars
        # line up with the audio whatever tempo each stem MIDI was written at.
        reference_bpm=_analysis_bpm(store, entry_id),
        instruments=staff_instruments,
    )
    if not result.get("ok"):
        raise HTTPException(501, result)
    return result


@router.post(
    "/backfill",
    dependencies=[
        Depends(refuse_cross_site),
        Depends(require_loopback_launch_or_pairing_token),
    ],
)
def backfill() -> dict[str, Any]:
    """Ensure every entry with MIDI has a titled sheet, and fix the placeholder
    title on existing sheets. Enqueued on the idle-gated background queue so a
    large library never blocks; falls back to running inline if the queue is
    unavailable."""
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    from .backfill import backfill_scores

    try:
        from backend.core.background_workers import get_background_queue

        async def _run() -> None:
            import asyncio

            await asyncio.to_thread(backfill_scores, store)

        get_background_queue().enqueue("notation:backfill", _run)
        return {"queued": True}
    except Exception:
        # No queue available — run synchronously and return the tallies.
        return {"queued": False, **backfill_scores(store)}


def _stamp_pack_engrave_inputs(
    db: Any,
    artifact_id: str,
    *,
    title: str,
    artist: str,
    rendered_engine: str,
    osmd_available: bool,
) -> None:
    """Merge the inputs a PDF was just engraved with onto its artifact row's
    ``metadata_json`` (SCORE-008 follow-up), so a later ``/pack`` call can
    tell whether the identity/engraver inputs it would use NOW still match
    what was actually stamped on the file -- mtime freshness alone missed a
    DETAILS identity-form edit, which touches no file, so the pack kept
    shipping a PDF credited to the old artist/title forever.

    ``rendered_engine`` is the engraver that ACTUALLY ran (``result["engine"]``
    from :func:`convert_score`, "osmd" or "musescore"), not the ``?engine=``
    pin -- when unpinned, the pin is always ``""`` regardless of which one
    ran, so stamping the pin here would make a MuseScore-rendered PDF
    indistinguishable from an OSMD one once OSMD becomes available again
    (see :func:`_pack_engine_still_fresh`).

    ``osmd_available`` is the OBSERVED ``capabilities()["osmd_pdf"]`` at the
    moment this render happened, not just whether OSMD is the one that ended
    up rendering. OSMD can be advertised available yet still fail to render
    THIS particular source, falling back to MuseScore every time; comparing
    only "is OSMD unavailable right now" against that fallback made the pack
    look stale on every single call once OSMD's global capability was True,
    even though nothing about that failure had changed. Recording the
    capability actually observed at render time lets
    :func:`_pack_engine_still_fresh` treat the cached PDF as fresh for as
    long as that observation still matches, and stale only when it changes.

    The row already exists (``convert_score`` -> ``_engrave`` ->
    ``_register_conversion`` -> ``add_notation_artifact`` created or
    replaced it); this re-calls the same public ``add_notation_artifact``
    primitive ``_register_conversion`` itself uses, with the SAME path/
    engine/engine_version/source_ref, only adding the three ``pack_*`` keys
    to its metadata. Passing back the unchanged path means
    ``add_notation_artifact``'s supersede-on-path-change logic is a no-op
    here (same path in and out), so this never moves anything to
    ``deprecated/``.

    Accepted trade: ``add_notation_artifact`` hardcodes ``created_at`` to
    "now" on every call (it takes no ``created_at`` override -- that would be
    a ``library/db.py`` change, out of this fix's write set), so this SECOND
    write re-bumps the row's ``created_at`` a moment after
    ``_register_conversion``'s own write already bumped it once, which can
    reorder this entry's artifact listing (``list_notation_artifacts`` sorts
    by ``created_at``). This is only ever reachable immediately after a
    GENUINE fresh engrave (the caller only reaches this branch when
    ``pdf_path is None`` forced a real re-render this same request) -- never
    when an existing PDF is simply reused -- so the bump lands within the
    same request as, and reflects, an engrave event that really did just
    happen; it is not a reorder triggered by a mere read.
    """
    row = db.get_notation_artifact(artifact_id)
    if row is None:
        return
    meta = _artifact_metadata(row)
    meta["pack_title"] = title
    meta["pack_artist"] = artist
    meta["pack_engine"] = rendered_engine
    meta["pack_osmd_available"] = osmd_available
    db.add_notation_artifact(
        artifact_id=artifact_id,
        entry_id=str(row.get("entry_id") or ""),
        kind=str(row.get("kind") or ""),
        path=str(row.get("path") or ""),
        source_ref=row.get("source_ref"),
        engine=str(row.get("engine") or ""),
        engine_version=str(row.get("engine_version") or ""),
        metadata=meta,
    )


def _pack_engine_still_fresh(
    cached_engine: str,
    forced_engine: str,
    cached_osmd_available: Optional[bool] = None,
) -> bool:
    """Whether a cached pack PDF's ``pack_engine`` (the engraver that
    actually rendered it, see :func:`_stamp_pack_engrave_inputs`) is still
    the one ``/pack`` would use right now.

    Pinned (``forced_engine`` set): an exact match, same as title/artist --
    a pin change is always a miss.

    Unpinned: OSMD is always the preferred engraver (:func:`convert_score`
    tries it first), so a PDF OSMD rendered is fresh regardless of anything
    else. A PDF MuseScore rendered is compared against ``cached_osmd_available``
    -- the ``capabilities()["osmd_pdf"]`` OBSERVED at the render that
    produced it, not just "is OSMD unavailable right now": OSMD can be
    advertised available yet still fail to render this particular source,
    so checking only the live capability made the pack look stale on every
    call forever once OSMD's global capability turned True, even though
    nothing about that per-source failure had changed. It is fresh only
    while the live capability still matches what was observed at render
    time; a genuine change (OSMD truly returning, or going away) makes it
    stale so the better engraver gets tried again. ``None`` (a pre-existing
    row from before ``pack_osmd_available`` was stamped at all) falls back
    to the old signal: fresh only while OSMD is still unavailable.
    """
    if forced_engine:
        return cached_engine == forced_engine
    if cached_engine == "osmd":
        return True
    osmd_now = bool(capabilities().get("osmd_pdf"))
    if cached_osmd_available is None:
        return not osmd_now
    return osmd_now == bool(cached_osmd_available)


@router.get("/pack/{artifact_id}")
def download_score_pack(
    artifact_id: str, parts: Optional[str] = None, engine: Optional[str] = None
) -> Response:
    """Download a score as a zip of the symbolic source plus a PDF.

    The PDF is engraved by ``convert_score`` "pdf" (the headless OSMD renderer,
    MuseScore when that is missing); with neither engraver the zip still
    carries the source so the download never fails. A ``musicxml`` artifact
    packs as MusicXML + PDF, a ``midi`` artifact as MIDI + PDF (the sheet is
    staged through music21 on the way). ``?parts=0,2`` (indices in
    ``<part-list>`` order) scopes both members to those parts: the MusicXML in
    the zip is the filtered sheet and the PDF is engraved from it. The staged
    files never outlive the request and are never registered. ``?engine=osmd``
    or ``?engine=musescore`` pins the PDF engraver, like ``/export`` does.
    """
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    artifact = store.db.get_notation_artifact(artifact_id)
    if artifact is None:
        raise HTTPException(404, f"artifact {artifact_id!r} not found")
    src = Path(artifact.get("path") or "")
    if not src.is_file():
        raise HTTPException(404, f"artifact file missing on disk: {src}")
    indices = _parse_parts_query(parts)
    forced_engine = (engine or "").lower().strip()
    if forced_engine and forced_engine not in _ENGRAVE_ENGINES:
        # Validated up front, not left to convert_score/_engrave: an
        # unrecognised value used to pass straight through options["engine"],
        # _engrave would answer ok=False, and /pack quietly dropped the PDF
        # and returned a 200 zip with only the source -- unlike /export,
        # which at least surfaces the ok=False as a 501.
        raise HTTPException(
            422, f"unknown engraver {engine!r}; use one of {_ENGRAVE_ENGINES}"
        )

    entry_id = str(artifact.get("entry_id") or "")
    title = _entry_title(store, entry_id)
    # Resolved ONCE and reused for both the staged MusicXML's credit and the
    # PDF's -- convert_score resolves this identically (via _chart_artist)
    # internally for the PDF, but /pack needs its OWN copy up front to know,
    # before engraving, whether a cached PDF's stamped credit still matches.
    pack_entry = store.db.get_entry(entry_id) if entry_id else None
    pack_artist = _chart_artist(pack_entry)
    slug = _song_slug(title) or src.stem
    kind = str(artifact.get("kind") or "")
    symbolic = kind in ("musicxml", "midi")
    part_tag = _parts_suffix(src, indices) if indices and symbolic else ""
    name_stem = f"{slug}__{part_tag}" if part_tag else slug
    entry_dir = store._dir_for(entry_id)  # noqa: SLF001 - module convention
    members: list[tuple[str, bytes]] = []

    if part_tag:
        # The filtered sheet is the zip's MusicXML. Read it into memory and
        # remove it BEFORE the PDF export, which stages under the same name.
        if entry_dir is None:
            raise HTTPException(500, f"entry directory missing for {entry_id!r}")
        stage_out = entry_dir / "notation" / f"{src.stem}__{part_tag}.musicxml"
        try:
            staged = stage_parts(
                src, indices, title, output_path=stage_out, artist=pack_artist
            )
        except Exception as exc:  # noqa: BLE001 - a bad part list is a 422
            raise HTTPException(
                422, f"could not scope {src.name} to parts {indices}: {exc}"
            ) from exc
        try:
            members.append((f"{name_stem}.musicxml", staged.path.read_bytes()))
        finally:
            staged.path.unlink(missing_ok=True)
    else:
        # The whole (un-scoped) source, verbatim for a MIDI artifact. A
        # MusicXML artifact is re-credited in memory first: it may have been
        # engraved before this ticket, or its entry's DETAILS identity may
        # have been edited since -- neither touches this file on disk, so
        # shipping it verbatim would pack a stale composer beside a PDF that
        # (via convert_score -> _chart_artist) already carries the current
        # one. ``stage_parts`` above does the equivalent re-credit for the
        # part-scoped case.
        member_bytes = src.read_bytes()
        if kind == "musicxml":
            try:
                prolog_extras = _musicxml_prolog_extras(member_bytes)
                # insert_comments=True: a plain ElementTree parse drops every
                # comment INSIDE the root too (not just the pre-root ones
                # ``prolog_extras`` preserves) -- music21, the writer this
                # module uses for every generated sheet, emits interior
                # separator comments even in a trivial fragment.
                comment_parser = ET.XMLParser(
                    target=ET.TreeBuilder(insert_comments=True)
                )
                tree = ET.parse(str(src), parser=comment_parser)
                _set_musicxml_composer(tree.getroot(), pack_artist)
                buf = io.BytesIO()
                tree.write(buf, encoding="UTF-8", xml_declaration=True)
                member_bytes = _splice_musicxml_prolog_extras(
                    buf.getvalue(), prolog_extras
                )
                try:
                    ET.fromstring(member_bytes)
                except ET.ParseError:
                    # The splice itself failed to parse -- fall back to the
                    # ET-only serialization (no DOCTYPE/prolog extras, but
                    # always well-formed on its own). Re-validate THAT too:
                    # if the failure came from injected text (a control
                    # character in pack_artist) rather than the prolog
                    # splice, buf.getvalue() is equally unparseable and must
                    # never ship as a zip member.
                    member_bytes = buf.getvalue()
                    try:
                        ET.fromstring(member_bytes)
                    except ET.ParseError:
                        # Neither form parses: ship the original file bytes
                        # (uncredited) rather than a corrupt zip member.
                        member_bytes = src.read_bytes()
            except (ET.ParseError, ValueError):
                pass
        members.append((f"{name_stem}{src.suffix}", member_bytes))

    # The PDF. An existing artifact is reused only when it is fresh in every
    # sense (SCORE-008 + follow-up): its file is not older than `src`, AND
    # the title/artist/engraver it was actually stamped with (recorded on its
    # own metadata_json by _stamp_pack_engrave_inputs below) still match what
    # would be used right now. mtime alone missed a DETAILS identity-form
    # edit: saving a new notation_artist/notation_title never touches the
    # source file, so a stale credit would otherwise ship forever. A pinned-
    # engraver change (``?engine=``) is likewise treated as a miss, not
    # silently re-rendered with the other engraver; unpinned, a PDF MuseScore
    # rendered while OSMD was unavailable is a miss too once OSMD returns
    # (see :func:`_pack_engine_still_fresh`).
    if symbolic and entry_dir is not None:
        pdf_name = f"{src.stem}__{part_tag}.pdf" if part_tag else f"{src.stem}.pdf"
        pdf_out = entry_dir / "notation" / pdf_name
        pdf_artifact_id = _export_artifact_id(artifact_id, "pdf", indices)
        pdf_path: Optional[Path] = None
        existing_pdf = store.db.get_notation_artifact(pdf_artifact_id)
        if existing_pdf is not None:
            candidate = Path(existing_pdf.get("path") or "")
            existing_meta = _artifact_metadata(existing_pdf)
            try:
                fresh = (
                    candidate.is_file()
                    and candidate.stat().st_mtime >= src.stat().st_mtime
                    and existing_meta.get("pack_title") == title
                    and existing_meta.get("pack_artist") == pack_artist
                    and _pack_engine_still_fresh(
                        str(existing_meta.get("pack_engine") or ""),
                        forced_engine,
                        existing_meta.get("pack_osmd_available"),
                    )
                )
            except OSError:
                fresh = False
            if fresh:
                pdf_path = candidate
        if pdf_path is None:
            pdf_options: dict[str, Any] = {}
            if indices:
                pdf_options["parts"] = indices
            if forced_engine:
                pdf_options["engine"] = forced_engine
            osmd_available_now = bool(capabilities().get("osmd_pdf"))
            result = convert_score(
                store.db,
                entry_id=entry_id,
                source_path=src,
                fmt="pdf",
                output_path=pdf_out,
                source_ref=artifact_id,
                artifact_id=pdf_artifact_id,
                title=title,
                options=pdf_options or None,
            )
            if result.get("ok"):
                candidate = Path(result.get("path") or pdf_out)
                if candidate.is_file():
                    pdf_path = candidate
                    _stamp_pack_engrave_inputs(
                        store.db,
                        pdf_artifact_id,
                        title=title,
                        artist=pack_artist,
                        rendered_engine=str(result.get("engine") or forced_engine),
                        # A ``?engine=musescore`` pin never gives OSMD a
                        # chance to run, so `osmd_available_now` here would
                        # only mean "OSMD is globally advertised", not "OSMD
                        # was tried and lost" -- stamping it True made a
                        # forced-MuseScore render look, to a LATER unpinned
                        # request, exactly like a genuine unpinned OSMD
                        # failure, permanently pinning that unpinned request
                        # to the MuseScore PDF. Only an unpinned request (or
                        # one explicitly pinned to "osmd") ever means OSMD
                        # was actually tried and did not win.
                        osmd_available=osmd_available_now
                        and forced_engine in ("", "osmd"),
                    )
        if pdf_path is not None:
            members.append((f"{name_stem}.pdf", pdf_path.read_bytes()))

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for arcname, payload in members:
            zf.writestr(arcname, payload)
    buf.seek(0)
    return Response(
        content=buf.read(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{name_stem}_score.zip"'
        },
    )


@router.get("/file/{artifact_id}")
def get_artifact_file(artifact_id: str) -> FileResponse:
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    artifact = store.db.get_notation_artifact(artifact_id)
    if artifact is None:
        raise HTTPException(404, f"artifact {artifact_id!r} not found")
    path = Path(artifact.get("path") or "")
    if not path.is_file():
        raise HTTPException(404, f"artifact file missing on disk: {path}")
    mime, _ = mimetypes.guess_type(str(path))
    kind = artifact.get("kind")
    if kind == "musicxml":
        mime = "application/vnd.recordare.musicxml+xml"
    elif kind == "mxl":
        mime = "application/vnd.recordare.musicxml"
    elif kind in ("abc", "alphatex", "kern"):
        mime = "text/plain; charset=utf-8"
    elif kind in ("chordtrack", "notechart", "lyrics"):
        mime = "application/json"
    elif kind == "beatsaber":
        mime = "application/zip"
    # Name the download after the originating song so saved sheets are
    # identifiable even for artifacts created before song-prefixed filenames.
    slug = _song_slug(_entry_title(store, str(artifact.get("entry_id") or "")))
    download_name = _scored_name(slug, path.name)
    return FileResponse(
        path=str(path),
        media_type=mime or "application/octet-stream",
        filename=download_name,
    )


class PerformRequest(BaseModel):
    source_artifact_id: str
    # Quarters per minute for a sheet that prints no tempo; the entry's
    # analysed BPM when absent, and the performer's default after that.
    bpm: Optional[float] = Field(default=None, gt=0, le=1000)


@router.post(
    "/{entry_id}/perform",
    dependencies=[
        Depends(refuse_cross_site),
        Depends(require_loopback_launch_or_pairing_token),
    ],
)
def perform_artifact(entry_id: str, body: PerformRequest) -> dict[str, Any]:
    """Play a MusicXML sheet as an expressive MIDI (the SCORE tab's EXPORT >
    PERFORM): ritardandos into cadences, fermatas held, phrase downbeats
    leaned on, articulation and dynamics as printed (see :mod:`.perform`).
    The MIDI is written beside the entry's other exports and registered as a
    ``midi`` artifact ``<source>__performed_midi``, so it lists and opens like
    any other MIDI of the entry. It writes a file, so it answers only to this
    machine's own UI, the desktop shell or a paired device."""
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    if store.get_entry(entry_id) is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")

    source = store.db.get_notation_artifact(body.source_artifact_id)
    if source is None or source.get("entry_id") != entry_id:
        raise HTTPException(
            404,
            f"artifact {body.source_artifact_id!r} not found for entry {entry_id!r}",
        )
    if source.get("kind") != "musicxml":
        raise HTTPException(
            422,
            f"artifact {body.source_artifact_id!r} is a {source.get('kind')!r}; "
            "PERFORM plays a MusicXML sheet",
        )
    source_path = Path(source.get("path") or "")
    if not source_path.is_file():
        raise HTTPException(404, f"artifact file missing on disk: {source_path}")

    entry_dir = store._dir_for(entry_id)  # the route family's own convention
    if entry_dir is None:
        raise HTTPException(500, f"entry directory missing for {entry_id!r}")
    slug = _song_slug(_entry_title(store, entry_id))
    output = (
        entry_dir
        / "notation"
        / _scored_name(slug, f"{source_path.stem}__performed.mid")
    )

    from .perform import perform_to_artifact

    result = perform_to_artifact(
        store.db,
        entry_id=entry_id,
        source_path=source_path,
        output_path=output,
        source_ref=body.source_artifact_id,
        artifact_id=f"{body.source_artifact_id}__performed_midi",
        qpm=body.bpm or _analysis_bpm(store, entry_id),
    )
    if not result.get("ok"):
        raise HTTPException(501, result)
    return result
