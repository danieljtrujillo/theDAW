"""Filesystem-backed library store.

Layout under the library root (default: `<project>/data/generations/`,
overridable via `STABLEDAW_GENERATIONS_DIR`):

    <library_root>/
        <entry_id>/
            metadata.json     # entry record (see ENTRY_FIELDS below)
            <audio_filename>  # the audio file
            [spectrogram_*.png ...]   # optional, written by the generate flow

For generate outputs `entry_id = "{job_id}_{index:02d}"`. For imports we
mint a UUID. The `metadata.json` is the source of truth — any user-mutable
field (favorite, rating, tags, notes) is merged in there.

This module is intentionally storage-only: it does NOT depend on FastAPI
so it can be reused by an eventual `S3Provider` / `DriveProvider` that
swaps the filesystem operations for cloud APIs.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Optional

log = logging.getLogger(__name__)


# Fields a frontend client is allowed to modify on an entry. Everything
# else in metadata.json is owned by the backend (filenames, paths,
# timestamps, the generation params we recorded at save time).
# `chimera_sources` is included because the backend doesn't know about
# the user-facing Chimera stack labels at generation time — the frontend
# PATCHes them after the mashup runs.
USER_MUTABLE_FIELDS: frozenset[str] = frozenset(
    {"favorite", "rating", "tags", "notes", "title", "chimera_sources"}
)


@dataclass
class LibraryRecord:
    """Public-facing entry record. Mirrors the frontend `LibraryEntry` interface
    minus the inline `audioBlob` — clients fetch the audio via the
    `audio_url` field instead."""

    id: str
    title: str
    prompt: str
    negative_prompt: str
    model: str
    duration: float
    steps: int
    cfg: float
    seed: int
    audio_url: str
    audio_filename: str
    mime_type: str
    file_size_bytes: int
    timestamp: str
    favorite: bool
    rating: Optional[str]
    tags: list[str]
    notes: str
    source: str
    chimera_sources: list[str] = field(default_factory=list)
    # Optional pointers to extra artifacts on disk.
    spectrogram_paths: dict[str, Optional[str]] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "prompt": self.prompt,
            "negative_prompt": self.negative_prompt,
            "model": self.model,
            "duration": self.duration,
            "steps": self.steps,
            "cfg": self.cfg,
            "seed": self.seed,
            "audio_url": self.audio_url,
            "audio_filename": self.audio_filename,
            "mime_type": self.mime_type,
            "file_size_bytes": self.file_size_bytes,
            "timestamp": self.timestamp,
            "favorite": self.favorite,
            "rating": self.rating,
            "tags": list(self.tags),
            "notes": self.notes,
            "source": self.source,
            "chimera_sources": list(self.chimera_sources),
            "spectrogram_paths": dict(self.spectrogram_paths),
        }


def default_library_root(project_root: Path) -> Path:
    """Resolve the library root path. Env override wins; otherwise it lives
    alongside the existing generate artifacts so old data is picked up."""
    configured = os.getenv("STABLEDAW_GENERATIONS_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return project_root / "data" / "generations"


def _audio_url_for(api_prefix: str, entry_id: str) -> str:
    return f"{api_prefix}/audio/{entry_id}"


def _metadata_path(entry_dir: Path) -> Path:
    return entry_dir / "metadata.json"


def _read_metadata(entry_dir: Path) -> Optional[dict[str, Any]]:
    p = _metadata_path(entry_dir)
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        log.warning("library.store: failed to read %s: %s", p, e)
        return None


def _write_metadata(entry_dir: Path, payload: dict[str, Any]) -> None:
    p = _metadata_path(entry_dir)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(p)


def _resolve_audio_file(entry_dir: Path, meta: dict[str, Any]) -> Optional[Path]:
    """Resolve the audio file for an entry. Try the metadata-declared name
    first, then any first audio file in the entry directory."""
    declared = meta.get("filename") or meta.get("audio_filename")
    if declared:
        candidate = entry_dir / declared
        if candidate.is_file():
            return candidate
    for path in entry_dir.iterdir():
        if path.is_file() and path.suffix.lower() in {
            ".wav",
            ".mp3",
            ".flac",
            ".ogg",
            ".m4a",
        }:
            return path
    return None


def _record_from_metadata(
    entry_dir: Path,
    meta: dict[str, Any],
    api_prefix: str,
) -> Optional[LibraryRecord]:
    """Build a LibraryRecord from a metadata.json payload. Returns None if
    the directory has no resolvable audio file."""
    entry_id = entry_dir.name
    audio_file = _resolve_audio_file(entry_dir, meta)
    if audio_file is None:
        return None

    try:
        size = audio_file.stat().st_size
    except OSError:
        size = 0

    timestamp = meta.get("timestamp")
    if not timestamp:
        # Fall back to saved_at unix seconds → ISO.
        saved_at = meta.get("saved_at")
        if isinstance(saved_at, (int, float)):
            timestamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(saved_at)) + "Z"
        else:
            try:
                timestamp = (
                    time.strftime(
                        "%Y-%m-%dT%H:%M:%S", time.gmtime(audio_file.stat().st_mtime)
                    )
                    + "Z"
                )
            except OSError:
                timestamp = ""

    # Older metadata used `model_name` and `cfg_scale`; the new convention is
    # `model` and `cfg`. Read both so the library list works for entries
    # written before this refactor.
    model = meta.get("model") or meta.get("model_name") or ""
    cfg_val = meta.get("cfg")
    if cfg_val is None:
        cfg_val = meta.get("cfg_scale", 0.0)

    return LibraryRecord(
        id=entry_id,
        title=str(meta.get("title") or meta.get("filename") or audio_file.name),
        prompt=str(meta.get("prompt") or ""),
        negative_prompt=str(meta.get("negative_prompt") or ""),
        model=str(model),
        duration=float(meta.get("duration") or 0.0),
        steps=int(meta.get("steps") or 0),
        cfg=float(cfg_val or 0.0),
        seed=int(meta.get("seed") or 0),
        audio_url=_audio_url_for(api_prefix, entry_id),
        audio_filename=audio_file.name,
        mime_type=str(meta.get("mime_type") or "audio/wav"),
        file_size_bytes=size,
        timestamp=timestamp,
        favorite=bool(meta.get("favorite", False)),
        rating=meta.get("rating")
        if meta.get("rating") in ("like", "dislike")
        else None,
        tags=list(meta.get("tags") or []),
        notes=str(meta.get("notes") or ""),
        source=str(meta.get("source") or "generate"),
        chimera_sources=list(meta.get("chimera_sources") or []),
        spectrogram_paths=dict(meta.get("spectrogram_paths") or {}),
    )


class LibraryStore:
    """Filesystem-backed library. Thread-safe enough for FastAPI's
    threadpool — every operation re-reads the relevant directory.
    For a long-running server with thousands of entries we would add an
    in-memory index, but at the current scale this is fine."""

    def __init__(self, root: Path, api_prefix: str = "/api/library") -> None:
        self.root = root
        self.api_prefix = api_prefix
        self.root.mkdir(parents=True, exist_ok=True)

    # ---- Read ---------------------------------------------------------------

    def list_entries(self) -> list[LibraryRecord]:
        if not self.root.is_dir():
            return []
        out: list[LibraryRecord] = []
        for child in sorted(self.root.iterdir()):
            if not child.is_dir():
                continue
            # Generate flow has been writing data/generations/<job_id>/<index>/
            # i.e. nested two levels. Walk down one if we see no metadata.json
            # at the top.
            direct_meta = _read_metadata(child)
            if direct_meta is not None:
                record = _record_from_metadata(child, direct_meta, self.api_prefix)
                if record is not None:
                    out.append(record)
                continue
            for inner in sorted(child.iterdir()):
                if not inner.is_dir():
                    continue
                meta = _read_metadata(inner)
                if meta is None:
                    continue
                # Synthesize entry_id from the nested structure so listing
                # is stable across reads.
                entry_id = f"{child.name}_{inner.name}"
                # Build a record but force the id we synthesized.
                record = _record_from_metadata(inner, meta, self.api_prefix)
                if record is None:
                    continue
                record.id = entry_id
                record.audio_url = _audio_url_for(self.api_prefix, entry_id)
                out.append(record)
        return out

    def get_entry(self, entry_id: str) -> Optional[LibraryRecord]:
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return None
        meta = _read_metadata(entry_dir)
        if meta is None:
            return None
        record = _record_from_metadata(entry_dir, meta, self.api_prefix)
        if record is not None:
            record.id = entry_id
            record.audio_url = _audio_url_for(self.api_prefix, entry_id)
        return record

    def get_audio_path(self, entry_id: str) -> Optional[Path]:
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return None
        meta = _read_metadata(entry_dir) or {}
        return _resolve_audio_file(entry_dir, meta)

    # ---- Write --------------------------------------------------------------

    def update_entry(
        self, entry_id: str, patch: dict[str, Any]
    ) -> Optional[LibraryRecord]:
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return None
        meta = _read_metadata(entry_dir)
        if meta is None:
            return None
        for key in USER_MUTABLE_FIELDS:
            if key not in patch:
                continue
            meta[key] = patch[key]
        # Sanitize types we expose.
        if "favorite" in meta:
            meta["favorite"] = bool(meta["favorite"])
        if "tags" in meta:
            meta["tags"] = [str(t) for t in (meta["tags"] or [])]
        if "notes" in meta:
            meta["notes"] = str(meta["notes"] or "")
        if "chimera_sources" in meta:
            raw = meta["chimera_sources"] or []
            if not isinstance(raw, list):
                raw = []
            meta["chimera_sources"] = [str(s) for s in raw]
        if meta.get("rating") not in ("like", "dislike", None):
            meta["rating"] = None
        _write_metadata(entry_dir, meta)
        return self.get_entry(entry_id)

    def delete_entry(self, entry_id: str) -> bool:
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return False
        try:
            shutil.rmtree(entry_dir)
            return True
        except OSError as e:
            log.warning("library.store: failed to delete %s: %s", entry_dir, e)
            return False

    def import_blob(
        self,
        audio_bytes: bytes,
        filename: str,
        mime_type: str,
        metadata: Optional[dict[str, Any]] = None,
    ) -> LibraryRecord:
        entry_id = uuid.uuid4().hex
        entry_dir = self.root / entry_id
        entry_dir.mkdir(parents=True, exist_ok=True)
        suffix = Path(filename).suffix.lower() or ".wav"
        safe_name = Path(filename).stem[:80] or "import"
        target_name = f"{safe_name}{suffix}"
        target_path = entry_dir / target_name
        target_path.write_bytes(audio_bytes)

        record_meta: dict[str, Any] = {
            "id": entry_id,
            "filename": target_name,
            "audio_filename": target_name,
            "mime_type": mime_type,
            "title": metadata.get("title") if metadata else target_name,
            "prompt": metadata.get("prompt", "") if metadata else "",
            "negative_prompt": metadata.get("negative_prompt", "") if metadata else "",
            "model": metadata.get("model", "import") if metadata else "import",
            "duration": metadata.get("duration", 0.0) if metadata else 0.0,
            "steps": metadata.get("steps", 0) if metadata else 0,
            "cfg": metadata.get("cfg", 0.0) if metadata else 0.0,
            "seed": metadata.get("seed", 0) if metadata else 0,
            "favorite": False,
            "rating": None,
            "tags": list(metadata.get("tags", [])) if metadata else [],
            "notes": metadata.get("notes", "") if metadata else "",
            "source": metadata.get("source", "import") if metadata else "import",
            "chimera_sources": list(metadata.get("chimera_sources", []))
            if metadata
            else [],
            "saved_at": time.time(),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        _write_metadata(entry_dir, record_meta)
        record = _record_from_metadata(entry_dir, record_meta, self.api_prefix)
        assert record is not None, "freshly imported entry must resolve"
        record.id = entry_id
        record.audio_url = _audio_url_for(self.api_prefix, entry_id)
        return record

    # ---- Helpers ------------------------------------------------------------

    def _dir_for(self, entry_id: str) -> Optional[Path]:
        # Direct (import or single-level generate) layout.
        direct = self.root / entry_id
        if direct.is_dir() and _metadata_path(direct).is_file():
            return direct
        # Nested generate layout: "<job_id>_<index>" maps to "<job_id>/<index>".
        if "_" in entry_id:
            job_id, _, index = entry_id.rpartition("_")
            nested = self.root / job_id / index
            if nested.is_dir() and _metadata_path(nested).is_file():
                return nested
        return None

    def all_ids(self) -> Iterable[str]:
        for record in self.list_entries():
            yield record.id
