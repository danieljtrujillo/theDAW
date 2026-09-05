"""FastAPI router for symbolic notation artifacts and conversions."""

from __future__ import annotations

import io
import json
import logging
import mimetypes
import zipfile
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from backend.modules.library.router import get_store as get_library_store

from .arrangers.score_arrange import STYLES as ARRANGEMENT_STYLES
from .engine import (
    capabilities,
    convert_score,
    midi_to_arrangement,
    midi_to_musicxml,
    midi_to_tabs,
    register_existing_midis,
    register_on_disk_artifacts,
)

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
}

# Formats written into their own sub-directory of notation/ (the Beat Saber
# writer leaves the unzipped level folder beside the zip, which would clutter
# the flat notation/ listing).
_SUBDIR_FOR_FORMAT = {"beatsaber": "beatsaber"}

# Chord-track file name suffix (the CHORDS play-along document).
_CHORDTRACK_SUFFIX = ".chordtrack.json"
_CHORDTRACK_METHODS = ("auto", "harmony", "chroma")
_CHORDTRACK_RESOLUTIONS = ("beat", "bar")


def _song_slug(title: str, fallback: str = "score") -> str:
    """Filesystem-safe, readable slug of a song title for score filenames."""
    cleaned = "".join(c if (c.isalnum() or c in " -_") else "_" for c in (title or ""))
    cleaned = "_".join(cleaned.split())  # collapse whitespace runs to one "_"
    cleaned = cleaned.strip("_-")
    return cleaned[:60] or fallback


def _entry_title(store: Any, entry_id: str) -> str:
    entry = store.get_entry(entry_id)
    return str(getattr(entry, "title", "") or "") if entry is not None else ""


def _scored_name(slug: str, base: str) -> str:
    """Prefix ``base`` with the song slug unless it already leads with it,
    so the file (and its download name) carries the originating song."""
    if slug and not base.lower().startswith(slug.lower()):
        return f"{slug}__{base}"
    return base


class ExportRequest(BaseModel):
    source_artifact_id: str
    format: str
    # Per-format export options. Beat Saber reads: difficulties (list of
    # Easy/Normal/Hard/Expert/ExpertPlus), version (2|3), bpm_source
    # ('analysis'|'chart'), parts (chart part indices) and include_audio.
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
    return capabilities()


@router.get("/{entry_id}/artifacts")
def list_artifacts(entry_id: str, kind: Optional[str] = None) -> dict[str, Any]:
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    if store.get_entry(entry_id) is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")
    register_existing_midis(store.db, entry_id)
    # Self-heal: the legacy mirror above only replays the ``midis`` table, so an
    # entry whose rows were lost while its files survived would list as empty
    # forever. Scanning the entry's own directories recovers those, and it only
    # runs when the DB really has nothing, so the normal path stays a plain read.
    if not store.db.list_notation_artifacts(entry_id):
        entry_dir = store._dir_for(entry_id)  # noqa: SLF001 - existing module convention
        if entry_dir is not None:
            recovered = register_on_disk_artifacts(store.db, entry_dir, entry_id)
            if recovered:
                log.info(
                    "notation: recovered %d on-disk artifact(s) for %s",
                    len(recovered),
                    entry_id,
                )
    artifacts = store.db.list_notation_artifacts(entry_id, kind=kind)
    return {"entry_id": entry_id, "artifacts": artifacts, "count": len(artifacts)}


@router.post("/reindex")
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


@router.post("/{entry_id}/from-midi/{midi_id}")
def convert_midi_artifact(entry_id: str, midi_id: str) -> dict[str, Any]:
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    entry = store.get_entry(entry_id)
    if entry is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")
    title = str(getattr(entry, "title", "") or "")
    slug = _song_slug(title)
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
    output = entry_dir / "notation" / _scored_name(slug, f"{midi_id}.musicxml")
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


@router.post("/{entry_id}/export")
def export_artifact(entry_id: str, body: ExportRequest) -> dict[str, Any]:
    """Export an existing notation artifact (MIDI or MusicXML) to another
    format and register the result. Targets: musicxml, abc, pdf, svg."""
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
    output = out_dir / _scored_name(slug, f"{source_path.stem}{ext}")

    # Audio context for the chart-based targets (notechart duration, Beat Saber
    # song.ogg + Info.dat BPM). Harmless for the symbolic formats.
    audio_path = store.get_audio_path(entry_id)
    duration = getattr(entry, "duration", None) if entry is not None else None
    audio_duration_sec = float(duration) if duration else None
    analysis = store.db.get_analysis(entry_id)
    analysis_bpm: Optional[float] = None
    if analysis and analysis.get("bpm"):
        try:
            analysis_bpm = float(analysis["bpm"])
        except (TypeError, ValueError):
            analysis_bpm = None

    result = convert_score(
        store.db,
        entry_id=entry_id,
        source_path=source_path,
        fmt=fmt,
        output_path=output,
        source_ref=body.source_artifact_id,
        artifact_id=f"{body.source_artifact_id}__{fmt}",
        title=title,
        options=dict(body.options or {}),
        audio_path=audio_path,
        audio_duration_sec=audio_duration_sec,
        analysis_bpm=analysis_bpm,
    )
    if not result.get("ok"):
        raise HTTPException(501, result)
    return result


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
    candidates = store.db.list_notation_artifacts(entry_id, kind="musicxml")
    for artifact in reversed(candidates):  # list is oldest-first
        if _artifact_metadata(artifact).get("style") != "lead-sheet":
            continue
        if Path(artifact.get("path") or "").is_file():
            return artifact
    return None


@router.post("/{entry_id}/chords")
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


@router.post("/{entry_id}/tabs")
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


@router.post("/{entry_id}/arrange")
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
    )
    if not result.get("ok"):
        raise HTTPException(501, result)
    return result


@router.post("/backfill")
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


@router.get("/pack/{artifact_id}")
def download_score_pack(artifact_id: str) -> Response:
    """Download a score as a zip of the source plus a PDF. The PDF is engraved
    by the MuseScore CLI when available; without it the zip still carries the
    MusicXML so the download never fails."""
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    artifact = store.db.get_notation_artifact(artifact_id)
    if artifact is None:
        raise HTTPException(404, f"artifact {artifact_id!r} not found")
    src = Path(artifact.get("path") or "")
    if not src.is_file():
        raise HTTPException(404, f"artifact file missing on disk: {src}")

    entry_id = str(artifact.get("entry_id") or "")
    slug = _song_slug(_entry_title(store, entry_id)) or src.stem
    members: list[tuple[Path, str]] = [(src, f"{slug}{src.suffix}")]

    # Engrave a PDF from a MusicXML sheet when MuseScore is installed.
    if artifact.get("kind") == "musicxml":
        entry_dir = store._dir_for(entry_id)  # noqa: SLF001 - module convention
        if entry_dir is not None:
            pdf_out = entry_dir / "notation" / f"{src.stem}.pdf"
            result = convert_score(
                store.db,
                entry_id=entry_id,
                source_path=src,
                fmt="pdf",
                output_path=pdf_out,
                source_ref=artifact_id,
                artifact_id=f"{artifact_id}__pdf",
                title=_entry_title(store, entry_id),
            )
            if result.get("ok"):
                pdf_path = Path(result.get("path") or pdf_out)
                if pdf_path.is_file():
                    members.append((pdf_path, f"{slug}.pdf"))

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path, arcname in members:
            if path.is_file():
                zf.write(path, arcname=arcname)
    buf.seek(0)
    return Response(
        content=buf.read(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{slug}_score.zip"'},
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
    elif kind in ("abc", "alphatex"):
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
