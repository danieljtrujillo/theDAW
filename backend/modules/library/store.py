"""Filesystem-backed library store.

Layout under the library root (default: `<project>/data/generations/`,
overridable via `theDAW_GENERATIONS_DIR`):

    <library_root>/
        <entry_id>/
            metadata.json     # entry record (see ENTRY_FIELDS below)
            <audio_filename>  # the audio file
            [spectrogram_*.png ...]   # optional, written by the generate flow

For generate outputs `entry_id = "{job_id}_{index:02d}"`. For imports we
mint a UUID. The `metadata.json` is the source of truth — any user-mutable
field (favorite, rating, tags, notes, lyrics) is merged in there.

This module is intentionally storage-only: it does NOT depend on FastAPI
so it can be reused by an eventual `S3Provider` / `DriveProvider` that
swaps the filesystem operations for cloud APIs.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import threading
import time
import uuid
from contextlib import nullcontext
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Optional

from . import media_roots
from .db import (
    DEFAULT_DELETE_BATCH,
    DEFAULT_SORT,
    DISK_READ_PENDING_KEY,
    EntryFilters,
    LibraryDB,
    LibraryProgress,
    bounded_provider_slug,
    derived_provider_wire,
    resolved_provider_slug,
)
from .provider import (
    ProviderInfo,
    curated_fields,
    detect_provider,
    detection_outranks,
    provider_wire_fields,
)
from backend.lib import paths

log = logging.getLogger(__name__)

#: How many failures one bulk import reports back. The list is for a human
#: reading a progress panel, not a log; a folder of 200,000 files with a bad
#: drive would otherwise return 200,000 strings.
MAX_IMPORT_ERRORS = 50

#: Ceiling on how many new/changed entries a single :meth:`LibraryStore.reindex`
#: call may enqueue for background analysis. Above this, NONE are enqueued --
#: the user's rule is never to mass re-analyze, and a lost or empty DB next to
#: an existing 200,000-entry library would otherwise queue the whole thing the
#: moment analysis is enabled once. This is also :meth:`reindex`'s default
#: ``max_enqueue``, so a bare, uncapped call cannot happen by accident; the
#: `/reindex` route imports this constant rather than defining its own.
MAX_REINDEX_ANALYSIS_ENQUEUE = 500


# Fields a frontend client is allowed to modify on an entry. Everything
# else in metadata.json is owned by the backend (filenames, paths,
# timestamps, the generation params we recorded at save time).
# `chimera_sources` is included because the backend doesn't know about
# the user-facing Chimera stack labels at generation time — the frontend
# PATCHes them after the mashup runs.
# `lyrics` is the plain (untimed) lyrics text: the user's own words, edited
# from the Details / SING surfaces. The lyrics module mirrors the text of
# `<entry>/lyrics.json` into it on every save, so it never diverges from
# the timed document. Suno imports already carry it via `_flatten_suno_meta`.
# `notation_artist` / `notation_title` are the DETAILS identity form's manual
# overrides for the notation engine's artist/title guess (see
# frontend/src/components/layout/DetailsView.tsx, `saveIdentity`) — the notation
# routes (T08) and identity resolver (T09) read these off metadata.json.
USER_MUTABLE_FIELDS: frozenset[str] = frozenset(
    {
        "favorite",
        "rating",
        "tags",
        "notes",
        "title",
        "chimera_sources",
        "lyrics",
        "notation_artist",
        "notation_title",
    }
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
    # Plain lyrics text (see USER_MUTABLE_FIELDS). '' when the entry has none.
    lyrics: str = ""
    # Optional pointers to extra artifacts on disk.
    spectrogram_paths: dict[str, Optional[str]] = field(default_factory=dict)
    # Media (video / image) entries. 'audio' keeps the original contract;
    # 'video' / 'image' carry a stream URL, a poster thumbnail, pixel
    # dimensions, and an alpha flag (overlay-capable when True).
    kind: str = "audio"
    media_url: Optional[str] = None
    thumb_url: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    has_alpha: bool = False
    # Album/track artwork for an audio entry, extracted from the file's
    # embedded picture at import. None when the track has none, so the UI
    # can draw its placeholder without probing the route for a 404.
    cover_url: Optional[str] = None
    # Where the track came from -- Suno, Bandcamp, a DAW nobody recognises --
    # as decided by `provider.py` from what the file itself carried. All four
    # are None for a track whose origin nothing says, which is the normal case
    # for the user's own renders. `source` is a DIFFERENT axis and is
    # unchanged: it stays generate / studio / import.
    provider: Optional[str] = None
    provider_label: Optional[str] = None
    provider_is_ai: Optional[bool] = None
    provider_id: Optional[str] = None

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
            "lyrics": self.lyrics,
            "spectrogram_paths": dict(self.spectrogram_paths),
            "kind": self.kind,
            "media_url": self.media_url,
            "thumb_url": self.thumb_url,
            "width": self.width,
            "height": self.height,
            "has_alpha": self.has_alpha,
            "cover_url": self.cover_url,
            "provider": self.provider,
            "provider_label": self.provider_label,
            "provider_is_ai": self.provider_is_ai,
            "provider_id": self.provider_id,
        }


def default_library_root() -> Path:
    """Resolve the library root path. ``theDAW_GENERATIONS_DIR`` wins;
    otherwise it lives alongside the existing generate artifacts, under the
    writable data root (which is NOT the install directory when that is
    read-only — see backend.lib.paths)."""
    return paths.library_root()


def _audio_url_for(api_prefix: str, entry_id: str) -> str:
    return f"{api_prefix}/audio/{entry_id}"


def _media_url_for(api_prefix: str, entry_id: str) -> str:
    return f"{api_prefix}/media/{entry_id}"


def _thumb_url_for(api_prefix: str, entry_id: str) -> str:
    return f"{api_prefix}/media/{entry_id}/thumb"


# Normalised cover art for an audio entry. One fixed name, chosen by us: the
# filename and MIME string embedded next to the picture are attacker-supplied
# and never reach the filesystem.
COVER_FILENAME = "cover.jpg"


def _cover_url_for(api_prefix: str, entry_id: str) -> str:
    return f"{api_prefix}/audio/{entry_id}/cover"


def _cover_url_if_present(
    entry_dir: Path, api_prefix: str, entry_id: str
) -> Optional[str]:
    """The cover URL when the entry has artwork on disk, else None — one stat,
    mirroring how the media poster is surfaced.

    The URL carries the cover's mtime, so refreshing an entry's art produces a
    NEW url. Without it a re-read would write different bytes behind an
    unchanged ``src`` and every browser on screen would keep showing the old
    picture out of its cache.
    """
    try:
        stamp = int((entry_dir / COVER_FILENAME).stat().st_mtime * 1000)
    except OSError:
        return None
    return f"{_cover_url_for(api_prefix, entry_id)}?v={stamp}"


def extract_cover_for(entry_dir: Path, audio_path: Path) -> bool:
    """Pull the front cover out of ``audio_path`` into ``entry_dir``.

    Best-effort by design: a track with no picture is the normal case, and a
    corrupt or absurd one must never fail an import. Returns True only when a
    normalised cover was written.
    """
    from .tags import extract_embedded_cover, write_cover_image

    data = extract_embedded_cover(audio_path)
    if not data:
        return False
    return write_cover_image(data, entry_dir / COVER_FILENAME)


_MEDIA_EXTS = {
    ".mp4",
    ".webm",
    ".mov",
    ".mkv",
    ".m4v",
    ".avi",
    ".ogv",
    ".png",
    ".webp",
    ".gif",
    ".jpg",
    ".jpeg",
    ".bmp",
    ".avif",
    ".apng",
}


def _resolve_media_file(entry_dir: Path, meta: dict[str, Any]) -> Optional[Path]:
    """Resolve a video/image file for a media entry: the declared name
    first, then the first recognized media file in the directory (our own
    derived images — the poster thumbnail and the cover art — are skipped)."""
    declared = meta.get("media_filename") or meta.get("filename")
    if declared:
        candidate = entry_dir / declared
        if candidate.is_file():
            return candidate
    for path in sorted(entry_dir.iterdir()):
        if path.name in ("thumb.jpg", COVER_FILENAME):
            continue
        if path.is_file() and path.suffix.lower() in _MEDIA_EXTS:
            return path
    return None


def _metadata_path(entry_dir: Path) -> Path:
    return entry_dir / "metadata.json"


def _is_entry_dir(path: Path) -> bool:
    """Whether ``path`` is an entry directory: exists, is a directory, holds a
    metadata.json. Answers False rather than raising for a name the filesystem
    will not take. ``Path.is_dir`` swallows ENOENT and friends but not
    ENAMETOOLONG, so a 4 KB id straight off the wire used to stat() its way to
    a 500 on Linux — Windows refuses the name quietly, which is why it only
    ever showed on CI. An id the disk cannot hold is not an entry.
    """
    try:
        return path.is_dir() and _metadata_path(path).is_file()
    except (OSError, ValueError):
        return False


#: Why :func:`_read_metadata_checked` came back empty. ``""`` means it did
#: not: the value is a real dict.
META_READ_OK = ""
META_READ_MISSING = "missing"
#: The file could not be OPENED or read. Transient by nature -- on Windows a
#: sharing violation during another writer's rename, an antivirus pass, a
#: momentarily unavailable network drive -- so a caller must not conclude
#: anything durable about the entry from it.
META_READ_IO = "io"
#: The file was read and is not JSON. That is a property of the bytes on disk
#: and stays true until someone changes them.
META_READ_PARSE = "parse"


def _meta_stamp(entry_dir: Path) -> Optional[tuple[int, int]]:
    """``(mtime_ns, size)`` of an entry's ``metadata.json``, or None.

    The cheap identity of the bytes a previous read gave up on: a memo keyed
    with this retries the moment the file is repaired, and costs one stat
    rather than a full read plus a log line while it is not.
    """
    try:
        st = _metadata_path(entry_dir).stat()
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


def _read_metadata_checked(
    entry_dir: Path,
) -> tuple[Optional[dict[str, Any]], str]:
    """:func:`_read_metadata`, plus WHY it failed.

    Callers that remember a failure need to tell a damaged file (durable)
    from a file they could not open this instant (transient); blacklisting
    an entry for a sharing violation would take it out of service for the
    life of the process. Returns one of the ``META_READ_*`` reasons.
    """
    p = _metadata_path(entry_dir)
    if not p.is_file():
        return None, META_READ_MISSING
    try:
        text = p.read_text(encoding="utf-8")
    except OSError as e:
        log.warning("library.store: failed to read %s: %s", p, e)
        return None, META_READ_IO
    try:
        return json.loads(text), META_READ_OK
    except json.JSONDecodeError as e:
        log.warning("library.store: failed to read %s: %s", p, e)
        return None, META_READ_PARSE


def _read_metadata(entry_dir: Path) -> Optional[dict[str, Any]]:
    return _read_metadata_checked(entry_dir)[0]


def _write_metadata(entry_dir: Path, payload: dict[str, Any]) -> None:
    """Write one entry's ``metadata.json`` atomically.

    The temp file is UNIQUE per write, not the fixed ``metadata.json.tmp``
    this used to reuse. Two writers of the same entry shared that one path:
    both opened it, their bytes interleaved, and whichever finished second
    renamed the mixture over the real file -- permanent corruption of the
    title, tags, lyrics and prompt of an entry nobody was even editing. The
    process id and thread id make the name readable in a directory listing
    when something does go wrong; the random tail makes it unique regardless.
    (``tags.write_cover_image`` names its temp file the same way, for the same
    reason.)

    The name stays in the entry's own directory so ``Path.replace`` is a
    same-filesystem rename, which is atomic: a reader sees the old file or the
    new one, never a partial write. A failed write takes its temp file with
    it rather than leaving an orphan behind for the next backup or bundle to
    pick up.
    """
    p = _metadata_path(entry_dir)
    tmp = p.with_name(
        f"{p.name}.{os.getpid()}.{threading.get_ident()}.{uuid.uuid4().hex[:8]}.tmp"
    )
    try:
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(p)
    except BaseException:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


# One table, because these two drifted apart: the folder importer accepted ten
# extensions while the entry resolver accepted seventeen, so a .caf or a
# 64-bit .w64 added by hand resolved fine and was invisible to folder import.
# Keyed with the dot, the way Path.suffix reports it.
AUDIO_MIME_BY_EXT: dict[str, str] = {
    ".wav": "audio/wav",
    ".wave": "audio/wav",
    ".w64": "audio/x-wav",  # Sony Wave64 — the >4GB WAV a long float session reaches for
    ".rf64": "audio/x-wav",  # RF64, the BWF-compatible answer to the same limit
    ".bwf": "audio/wav",  # Broadcast Wave: WAV plus a bext chunk
    ".caf": "audio/x-caf",
    ".aif": "audio/aiff",
    ".aiff": "audio/aiff",
    ".aifc": "audio/aiff",
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/opus",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wma": "audio/x-ms-wma",
}

#: Every container the library will take. Derived, so it cannot fall behind
#: the mime table the way the folder importer's own copy did.
AUDIO_EXTS = frozenset(AUDIO_MIME_BY_EXT)


def _resolve_audio_file(entry_dir: Path, meta: dict[str, Any]) -> Optional[Path]:
    """Resolve the audio file for an entry. Try the metadata-declared name
    first, then any first audio file in the entry directory."""
    # Reference-in-place entry (folder -> playlist): the audio lives OUTSIDE the
    # library at source_path and is never copied in. Resolve straight to it so
    # serving, analysis, and listing all read the original file.
    source_path = meta.get("source_path")
    if source_path:
        ref = Path(source_path)
        if ref.is_file():
            return ref
    declared = meta.get("filename") or meta.get("audio_filename")
    if declared:
        candidate = entry_dir / declared
        if candidate.is_file():
            return candidate
    for path in entry_dir.iterdir():
        if path.is_file() and path.suffix.lower() in AUDIO_EXTS:
            return path
    return None


# ---- Provider labeling ------------------------------------------------------
#
# `provider.py` decides WHAT a track's provider is. The helpers below are the
# only places the library acts on that answer, so an entry labeled at import
# and the same entry labeled while being read can never disagree.
#
# Neither derivation opens a file or reads another row.
# :func:`_apply_provider_labels` runs once per imported entry, over tags its
# caller has already read; :func:`_provider_wire` runs per entry on the read
# path, over the metadata that entry already carries. That is what makes
# labeling the existing library free: no backfill pass, no re-analysis, no
# audio re-read.
#
# Derivation alone was not enough, because two things have to agree about one
# entry: the label it is SHOWN with (Python, here) and the slug the list filter
# FILES it under (:data:`~.db.PROVIDER_SQL`, which sees only the entry's own
# row). An entry whose sole evidence is the tag blob in its analysis row was
# shown as "suno" and filed under "import", so it answered to no provider
# filter at all. :meth:`LibraryStore.record_detected_providers` closes that:
# the FIRST read that derives a better answer writes it into the entry's
# metadata -- once, never overwriting, metadata only -- and from then on
# PROVIDER_SQL files the row under the slug it is shown with. Still no
# backfill: only rows a request was already returning are ever touched.
#
# Where that answer LIVES is the resolved ``entries.provider`` column. Every
# writer here fills it from the metadata it is already holding (the DB layer
# does it inside ``_entry_row`` and ``set_entry_metadata``), and
# :meth:`LibraryStore._fill_provider_column` resolves the rows that predate the
# column as reads return them. Nothing re-reads a file to do it and nothing
# looks for candidates: the metadata was parsed to build the response either
# way.

#: Curated embedded fields that fill one of the entry's OWN fields when the
#: caller left it empty.
_CURATED_ENTRY_FIELDS: tuple[str, ...] = (
    "prompt",
    "negative_prompt",
    "model",
    "lyrics",
)

#: Curated embedded fields stored beside the entry under their own name.
#: `created_at`, `bpm` and `key` are deliberately absent: `created_at` is what
#: the timestamp fallback in :func:`_record_from_metadata` reads, and bpm/key
#: belong to the analysis row, which MEASURES them from the audio rather than
#: taking the file's word for it. Both remain readable in `embedded_tags`.
_CURATED_EXTRA_FIELDS: tuple[str, ...] = (
    "provider_id",
    "style",
    "model_version",
    "artist",
    "parent_id",
    "is_instrumental",
)


#: Ceiling on the free text a provider answer may carry: the display label and
#: the evidence that decided it. Both can come straight out of an arbitrary
#: embedded frame of an imported file -- an unrecognised ``generator`` value
#: becomes its own label, and the evidence quotes the frame that named it -- so
#: a file with a multi-kilobyte tag would otherwise put that text in every list
#: response, in ``metadata.json`` forever, and in the ``metadata_json`` column
#: that PROVIDER_SQL's ``instr`` scans on every filtered list. 200 characters is
#: far more than any real provider name or frame needs.
PROVIDER_TEXT_MAX = 200


#: How long a provider write-through failure keeps an entry out of the way.
#: Long enough that a read-only library costs nothing per request, short
#: enough that remounting the volume repairs itself without a restart.
PROVIDER_WRITE_RETRY_SECONDS = 300.0

#: How many rows ONE read may resolve into the ``provider`` column. A page is
#: under this by construction (the endpoint's own ceiling is 500), so it never
#: bites there; it exists for the legacy unpaged listing, which returns the
#: WHOLE library and must stay a read of 200,000 rows rather than become a
#: 200,000-row migration. Rows it skips are resolved by the paged reads that
#: follow, each for the page it was already serving -- the same bound, and the
#: same reason, as ``router.MAX_PROVIDER_WRITEBACK``.
MAX_PROVIDER_COLUMN_FILL = 500

#: Ceiling on the provider SLUG -- ``provider.PROVIDER_SLUG_MAX``. Unlike the
#: label this is an identifier: it is compared in SQL, filed under, sent as a
#: query parameter and stored in an INDEXED column. An unrecognised generator
#: frame becomes its own slug, so without a bound a file with a multi-kilobyte
#: frame would mint a multi-kilobyte identifier.
#:
#: ``provider.py`` applies this at the SOURCE, where a slug is minted;
#: ``db.bounded_provider_slug`` applies it at the two boundaries where a slug
#: reaches storage or the wire, so a value that arrived some other way -- a
#: hand-edited ``metadata.json``, a row written by an older build -- is bounded
#: too. One rule, spelled once, and idempotent, so applying it twice is
#: applying it once.


def _bounded_text(value: Any) -> Any:
    """One free-text provider field, clipped to :data:`PROVIDER_TEXT_MAX`.
    Non-strings (None) pass through untouched.

    The clip is stripped, because the cut can land mid-word and leave a
    trailing space: ``provider._text`` strips whatever it reads back, so an
    unstripped clip would be stored one way and shown another the next time
    the entry is read. Clipping to a form that survives its own round trip is
    what makes stored and shown the same string.
    """
    if isinstance(value, str) and len(value) > PROVIDER_TEXT_MAX:
        return value[:PROVIDER_TEXT_MAX].strip()
    return value


def _bounded_slug(value: str) -> str:
    """A provider slug clipped to :data:`PROVIDER_SLUG_MAX`, still a slug.

    One implementation, in the DB layer, because the same bound has to hold on
    the value written into the indexed ``entries.provider`` column and on the
    value put on the wire; two spellings of one rule is how they drift. Returns
    "" rather than None here, which is what this module's callers test for.
    """
    return bounded_provider_slug(value) or ""


def bounded_provider_info(info: Optional[ProviderInfo]) -> Optional[ProviderInfo]:
    """One detection with every free-text field bounded, or None.

    The ONE place a provider answer is bounded, so the slug filed in SQL, the
    label shown in a list row and the values written to ``metadata.json`` are
    always the same strings. Returns None when the slug bounds away to
    nothing -- a detection with no usable identifier is not an answer, and
    must upgrade neither the wire nor the stored metadata.
    """
    if info is None:
        return None
    slug = _bounded_slug(info.provider)
    if not slug:
        return None
    return replace(
        info,
        provider=slug,
        label=_bounded_text(info.label),
        evidence=_bounded_text(info.evidence),
    )


def bounded_provider_wire_fields(info: Optional[ProviderInfo]) -> dict[str, Any]:
    """:func:`~.provider.provider_wire_fields` over a bounded detection.

    Every path that SHOWS or STORES a provider answer goes through this one
    function -- the import labeler, the read-path derivation, the write-through
    and the router -- so the slug and label in an entry's metadata and the slug
    and label in the response are always the same strings.
    """
    return provider_wire_fields(bounded_provider_info(info))


def _is_unset(value: Any) -> bool:
    """Whether a metadata field is absent rather than answered. ``False`` is an
    answer (an explicitly non-instrumental track), so only None and the empty
    string count as unset."""
    return value is None or value == ""


def _audio_row_columns(meta: Mapping[str, Any]) -> tuple[str, str]:
    """The ``(model, source)`` an AUDIO entry's ROW holds, from its metadata.

    ONE spelling of the two falsy defaults, because the provider rule is only
    consistent while everything reads the same pair. ``metadata.json`` may
    carry no ``source`` (a native generation writes none), a null one or an
    empty string, and :func:`_record_from_metadata` turns all three into
    'generate' -- as does the DB-row path, and the router derives from the
    loaded row. A labeler that read the RAW dict instead would derive the
    fallback for the same entry, let a theDAW frame outrank it and store a
    provider the rest of the system contradicts.

    ``model`` keeps the pre-refactor ``model_name`` spelling, for the same
    reason the record does: entries written before that rename still resolve.
    """
    model = meta.get("model") or meta.get("model_name") or ""
    return str(model), str(meta.get("source") or "generate")


def _apply_provider_labels(
    record_meta: dict[str, Any],
    embedded: Mapping[str, Any],
    meta_in: Mapping[str, Any],
) -> None:
    """Label one entry being built from a file, in place.

    ``record_meta`` is the ``metadata.json`` about to be written, ``embedded``
    whatever the tag reader returned for the file, and ``meta_in`` the caller's
    own metadata, which wins over anything the file claims about itself.

    An empty ``embedded`` is still worth a call: the legacy markers a
    pre-existing entry carries (``source`` of "suno", a ``suno_id``, a ``suno``
    tag) live in ``record_meta``. When nothing identifies the track, NOTHING is
    written -- an unlabeled entry keeps the metadata it always had.

    Shared by every import path, so a track uploaded through ``import_blob``
    and the same track registered in place come out labeled identically.

    A detection the ``(model, source)`` derivation outranks
    (:func:`~.provider.detection_outranks`, the same rule the read path's
    ``router._derive_provider`` applies) writes no PROVIDER -- not the four
    wire fields, not the provider tag. The entry keeps the label its columns
    imply, which is the label the list filter, the facet and the badge already
    show it under.

    The curated fields are written either way. They describe the SONG -- the
    prompt, the style, the lyrics, the model version the file names -- and
    none of them claims a provider, so which label won the rank is no reason
    to throw the file's own account of its music away.

    The derivation reads :func:`_audio_row_columns`, not ``record_meta``
    directly: both call sites build an audio entry, and the row it becomes
    normalises a missing, null or empty ``source`` to 'generate'.
    """
    # Bounded up front, so the slug stored, the slug tagged and the slug on
    # the wire are one string -- and a detection whose slug bounds away to
    # nothing labels nothing at all.
    info = bounded_provider_info(detect_provider(embedded, record_meta))
    if info is None:
        return
    derived = derived_provider_wire(*_audio_row_columns(record_meta))
    outranks = detection_outranks(
        info, str(derived["provider"]), bool(derived["provider_is_ai"])
    )
    if outranks:
        record_meta.update(bounded_provider_wire_fields(info))

    curated = curated_fields(embedded, info)
    for name in _CURATED_ENTRY_FIELDS:
        # The caller's explicit value wins; otherwise the curated value wins
        # over the raw frame the generic `_pick` fallback found, because the
        # curated table knows which of a provider's frames actually holds it.
        if _is_unset(curated.get(name)) or not _is_unset(meta_in.get(name)):
            continue
        record_meta[name] = curated[name]
    for name in _CURATED_EXTRA_FIELDS:
        if not _is_unset(record_meta.get(name)) or _is_unset(curated.get(name)):
            continue
        record_meta[name] = curated[name]

    # The provider is a tag too, so the existing tag filter and the search
    # index find these tracks without a new mechanism. Compared case-folded:
    # a user who already tagged the track "Suno" does not get a second one.
    # Skipped with the wire fields: a tag for a label the entry is not shown
    # under would make the tag filter and the provider filter disagree.
    if not outranks:
        return
    tags = list(record_meta.get("tags") or [])
    if info.provider not in {str(tag).strip().lower() for tag in tags}:
        record_meta["tags"] = [*tags, info.provider]


def _provider_wire(
    meta: Mapping[str, Any], *, source: str = "", model: str = ""
) -> dict[str, Any]:
    """The four provider wire fields for one entry, from its stored row.

    Derivation only -- no file is opened, no second row is read -- so every one
    of the ~200,000 entries already in the library is labeled as it is read,
    with no migration and no backfill.

    Two steps, matching the two halves of :data:`~.db.PROVIDER_SQL` exactly, so
    an entry's label is always the slug the list filter files it under:

    1. what the metadata names -- a stored ``provider`` or the legacy Suno
       markers -- via :func:`~.provider.detect_provider`, which also knows the
       track's own provider id. This is the same answer
       :func:`~.db.resolved_provider_slug` writes into the ``provider`` column,
       computed from the same dict by the same function;
    2. failing that, :func:`~.db.infer_provider` over ``model`` / ``source``,
       the twin of :data:`~.db.PROVIDER_FALLBACK_SQL` and the rule the
       catalogue has always shown these tracks under.

    ``source`` and ``model`` are the ``entries`` columns, used when
    ``metadata.json`` carries none of its own -- the column is the truth for a
    row rebuilt from the DB.

    They reach step 2 ONLY. Step 1 is handed the metadata dict exactly as
    stored, because :func:`~.db.resolved_provider_slug` computes the
    ``provider`` COLUMN from that same raw dict: a default injected here and
    not there is a rule that answers on the wire and not in SQL, which is the
    split this function's whole shape exists to prevent. The defaults belong
    to the fallback, whose SQL twin reads the columns they came from.
    """
    row_source = str(meta.get("source") or source or "")
    row_model = str(meta.get("model") or model or "")
    info = bounded_provider_info(detect_provider({}, meta))
    if info is not None:
        return bounded_provider_wire_fields(info)
    # No ``suno_id`` argument: an entry carrying one never reaches here,
    # because `detect_provider` above answers "suno" for it. The fallback is
    # the columns alone, in both languages.
    return derived_provider_wire(row_model, row_source)


def _detected_provider_meta(info: ProviderInfo) -> dict[str, Any]:
    """What a read-time detection leaves in an entry's metadata.

    The four wire fields exactly as :func:`~.provider.provider_wire_fields`
    produced them -- so the label the row is shown with and the label stored
    for :data:`~.db.PROVIDER_SQL` are the same four values, not two
    independently computed ones -- plus how the answer was reached, which
    matters once a slug can come from a uuid frame or from a domain in a
    comment. Nothing else: no tag, no timestamp, no curated field. Import-time
    behaviour (:func:`_apply_provider_labels`) is where those belong.

    Keys whose value is None are DROPPED rather than written. This dict is
    merged over an entry's stored metadata, and a detection that could not
    find a provider id ("no answer") must not erase one the entry already
    has: absent means absent, not "known to be nothing".
    """
    fields = {
        **bounded_provider_wire_fields(info),
        "provider_confidence": info.confidence,
        "provider_evidence": _bounded_text(info.evidence),
    }
    return {k: v for k, v in fields.items() if v is not None}


def _flatten_suno_meta(meta: dict[str, Any]) -> dict[str, Any]:
    """Suno API-compatible format normalization: if metadata came from a Suno
    External API cache (has an "inferred" dict), flatten inferred fields to
    top-level so downstream field reads work. No-op on normal theDAW metadata
    (no "inferred" key exists). Shallow-copies before mutating so the caller's
    dict keeps DB fidelity."""
    inferred = meta.get("inferred")
    if not isinstance(inferred, dict):
        return meta
    meta = dict(meta)
    for k, v in inferred.items():
        if meta.get(k) is None:
            meta[k] = v

    # Pull nested Suno API metadata.metadata fields up to top-level.
    # Only runs when "inferred" was present (Suno format marker).
    api_meta = meta.get("metadata")
    if isinstance(api_meta, dict):
        if api_meta.get("lyrics") and not meta.get("lyrics"):
            meta["lyrics"] = api_meta["lyrics"]
        if api_meta.get("style") and not meta.get("style"):
            meta["style"] = api_meta["style"]
        if api_meta.get("description") and not meta.get("prompt"):
            meta["prompt"] = api_meta["description"]
    return meta


def _record_from_metadata(
    entry_dir: Path,
    meta: dict[str, Any],
    api_prefix: str,
) -> Optional[LibraryRecord]:
    """Build a LibraryRecord from a metadata.json payload. Returns None if
    the directory has no resolvable audio file AND no CDN URL fallback."""
    meta = _flatten_suno_meta(meta)

    entry_id = entry_dir.name

    # Media (video / image) entries take a separate path: they resolve a
    # media file (not audio), carry a poster thumbnail + dimensions, and
    # stream from /media/<id> rather than /audio/<id>.
    kind = str(meta.get("kind") or "audio")
    if kind in ("video", "image"):
        return _media_record_from_metadata(entry_dir, meta, api_prefix, kind)

    audio_file = _resolve_audio_file(entry_dir, meta)

    # CHANGED: allow CDN-only entries (no local audio file) when a
    # cdn_audio_url is present in metadata — used by Suno cache import.
    if audio_file is None and not meta.get("cdn_audio_url"):
        return None

    size = 0
    audio_fname = ""
    if audio_file is not None:
        try:
            size = audio_file.stat().st_size
        except OSError:
            size = 0
        audio_fname = audio_file.name
    else:
        audio_fname = meta.get("audio_filename") or f"{entry_id}.mp3"

    timestamp = meta.get("timestamp")
    if not timestamp:
        # Fall back to created_at ISO string (Suno cache format).
        created_at_str = meta.get("created_at")
        if isinstance(created_at_str, str) and created_at_str:
            timestamp = created_at_str
        else:
            # Fall back to saved_at unix seconds → ISO.
            saved_at = meta.get("saved_at")
            if isinstance(saved_at, (int, float)):
                timestamp = (
                    time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(saved_at)) + "Z"
                )
            elif audio_file is not None:
                try:
                    timestamp = (
                        time.strftime(
                            "%Y-%m-%dT%H:%M:%S", time.gmtime(audio_file.stat().st_mtime)
                        )
                        + "Z"
                    )
                except OSError:
                    timestamp = ""
            else:
                timestamp = ""

    # Older metadata used `model_name` and `cfg_scale`; the new convention is
    # `model` and `cfg`. `model` reads both (in `_audio_row_columns`, which the
    # import labeler shares) so the library list works for entries written
    # before this refactor.
    model, row_source = _audio_row_columns(meta)
    cfg_val = meta.get("cfg")
    if cfg_val is None:
        cfg_val = meta.get("cfg_scale", 0.0)

    return LibraryRecord(
        id=entry_id,
        title=str(meta.get("title") or meta.get("filename") or audio_fname),
        prompt=str(meta.get("prompt") or ""),
        negative_prompt=str(meta.get("negative_prompt") or ""),
        model=str(model),
        duration=float(meta.get("duration") or 0.0),
        steps=int(meta.get("steps") or 0),
        cfg=float(cfg_val or 0.0),
        seed=int(meta.get("seed") or 0),
        audio_url=_audio_url_for(api_prefix, entry_id),
        audio_filename=audio_fname,
        mime_type=str(meta.get("mime_type") or "audio/mpeg"),
        file_size_bytes=size,
        timestamp=timestamp,
        favorite=bool(meta.get("favorite", False)),
        rating=meta.get("rating")
        if meta.get("rating") in ("like", "dislike")
        else None,
        tags=list(meta.get("tags") or []),
        notes=str(meta.get("notes") or ""),
        source=row_source,
        chimera_sources=list(meta.get("chimera_sources") or []),
        lyrics=str(meta.get("lyrics") or ""),
        spectrogram_paths=dict(meta.get("spectrogram_paths") or {}),
        cover_url=_cover_url_if_present(entry_dir, api_prefix, entry_id),
        # The SAME pair the record's own `model` / `source` above were built
        # from -- one call to `_audio_row_columns`, which the import labeler
        # shares. `metadata.json` for a native generation carries no `source`
        # key at all (see `backend/server.py`), and the DB row for it holds
        # 'generate', so deriving from "" here would label the entry `thedaw`
        # on the wire while `PROVIDER_SQL`, the list path and the `provider=`
        # filter all said stable-audio for the same entry.
        **_provider_wire(meta, source=row_source, model=model),
    )


def _media_record_from_metadata(
    entry_dir: Path,
    meta: dict[str, Any],
    api_prefix: str,
    kind: str,
) -> Optional[LibraryRecord]:
    """Build a LibraryRecord for a video/image entry. Returns None when no
    media file resolves on disk."""
    entry_id = entry_dir.name
    media_file = _resolve_media_file(entry_dir, meta)
    if media_file is None:
        return None

    try:
        size = media_file.stat().st_size
    except OSError:
        size = 0

    timestamp = meta.get("timestamp")
    if not timestamp:
        saved_at = meta.get("saved_at")
        if isinstance(saved_at, (int, float)):
            timestamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(saved_at)) + "Z"
        else:
            timestamp = ""

    has_thumb = (entry_dir / "thumb.jpg").is_file()
    # audio_url points at the media stream too, so generic consumers that
    # read audio_url never hit an empty/broken URL for a media entry.
    media_url = _media_url_for(api_prefix, entry_id)

    return LibraryRecord(
        id=entry_id,
        title=str(meta.get("title") or media_file.name),
        prompt=str(meta.get("prompt") or ""),
        negative_prompt=str(meta.get("negative_prompt") or ""),
        model=str(meta.get("model") or "import"),
        duration=float(meta.get("duration") or 0.0),
        steps=0,
        cfg=0.0,
        seed=0,
        audio_url=media_url,
        audio_filename=media_file.name,
        mime_type=str(meta.get("mime_type") or ""),
        file_size_bytes=size,
        timestamp=timestamp,
        favorite=bool(meta.get("favorite", False)),
        rating=None,
        tags=list(meta.get("tags") or []),
        notes=str(meta.get("notes") or ""),
        source=str(meta.get("source") or "import"),
        chimera_sources=[],
        lyrics=str(meta.get("lyrics") or ""),
        spectrogram_paths={},
        kind=kind,
        media_url=media_url,
        thumb_url=_thumb_url_for(api_prefix, entry_id) if has_thumb else None,
        width=_int_or_none(meta.get("width")),
        height=_int_or_none(meta.get("height")),
        has_alpha=bool(meta.get("has_alpha", False)),
        # The same defaults this record's own `source` / `model` fields use.
        **_provider_wire(
            meta,
            source=str(meta.get("source") or "import"),
            model=str(meta.get("model") or "import"),
        ),
    )


def _int_or_none(v: Any) -> Optional[int]:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _record_from_db_row(
    row: dict[str, Any],
    entry_dir: Path,
    api_prefix: str,
    *,
    unresolved: Optional[dict[str, str]] = None,
) -> LibraryRecord:
    """Build a record from ONE ``entries`` row plus its directory.

    The shared core of :meth:`LibraryStore.list_entries_fast` (whole table) and
    :meth:`LibraryStore.list_entries_page` (one page), so a paged list can
    never disagree with the unpaged one about what an entry looks like. Only
    the fields with no column -- tags, lyrics, mime, media dimensions -- come
    out of ``metadata_json``.

    ``unresolved``, when given, collects ``{id: slug}`` for a row whose
    metadata NAMES a provider that the row's ``provider`` column has not
    recorded -- a row imported or labeled before the column existed. It is
    filled here rather than by a second pass because the metadata has just
    been parsed to build the record: the caller gets the answer for free and
    adds no query to find it. See
    :meth:`LibraryStore._fill_provider_column`.
    """
    entry_id = str(row["id"])
    kind = str(row.get("kind") or "audio")
    try:
        meta = json.loads(row.get("metadata_json") or "{}")
    except (TypeError, json.JSONDecodeError):
        meta = {}
    if not isinstance(meta, dict):
        meta = {}
    if unresolved is not None and not str(row.get("provider") or "").strip():
        # Resolved from the RAW stored dict, before the Suno-cache flattening
        # below -- which is what `_entry_row` writes the column from. The
        # column and the metadata it was resolved from must be two views of one
        # answer, so both sides have to read the same dict; resolving from the
        # flattened copy would make an entry's column depend on which writer
        # got there first.
        slug = resolved_provider_slug(meta)
        if slug:
            unresolved[entry_id] = slug
    meta = _flatten_suno_meta(meta)
    is_media = kind in ("video", "image")
    if is_media:
        media_url: Optional[str] = _media_url_for(api_prefix, entry_id)
        audio_url = media_url
        thumb_url = (
            _thumb_url_for(api_prefix, entry_id)
            if (entry_dir / "thumb.jpg").is_file()
            else None
        )
        cover_url: Optional[str] = None
    else:
        media_url = None
        audio_url = _audio_url_for(api_prefix, entry_id)
        thumb_url = None
        cover_url = _cover_url_if_present(entry_dir, api_prefix, entry_id)
    # mime_type must come from metadata, not the DB mime column:
    # upsert_entry coerces an empty mime to 'audio/wav', which would
    # break the walk's '' default for media and 'audio/mpeg' for audio.
    mime_default = "" if is_media else "audio/mpeg"
    return LibraryRecord(
        id=entry_id,
        title=str(row.get("title") or ""),
        prompt=str(row.get("prompt") or ""),
        negative_prompt=str(row.get("negative_prompt") or ""),
        model=str(row.get("model") or ""),
        duration=float(row.get("duration_sec") or 0.0),
        steps=int(row.get("steps") or 0),
        cfg=float(row.get("cfg") or 0.0),
        seed=int(row.get("seed") or 0),
        audio_url=audio_url,
        audio_filename=str(row.get("audio_filename") or ""),
        mime_type=str(meta.get("mime_type") or mime_default),
        file_size_bytes=int(row.get("file_size_bytes") or 0),
        timestamp=str(row.get("timestamp") or ""),
        favorite=bool(row.get("favorite")),
        rating=None if is_media else row.get("rating"),
        tags=list(meta.get("tags") or []),
        notes=str(row.get("notes") or ""),
        source=str(row.get("source") or "generate"),
        chimera_sources=[] if is_media else list(meta.get("chimera_sources") or []),
        lyrics=str(meta.get("lyrics") or ""),
        spectrogram_paths={} if is_media else dict(meta.get("spectrogram_paths") or {}),
        kind=kind,
        media_url=media_url,
        thumb_url=thumb_url,
        width=_int_or_none(meta.get("width")) if is_media else None,
        height=_int_or_none(meta.get("height")) if is_media else None,
        has_alpha=bool(meta.get("has_alpha", False)) if is_media else False,
        cover_url=cover_url,
        # The row's columns are the truth here: `source` is what a legacy Suno
        # entry was marked with and `model` is what the derivation reads.
        # metadata.json usually repeats both, but need not.
        **_provider_wire(
            meta,
            source=str(row.get("source") or ""),
            model=str(row.get("model") or ""),
        ),
    )


def _db_payload(record: LibraryRecord, meta: dict[str, Any]) -> dict[str, Any]:
    """The flattened payload ``LibraryDB.upsert_entry`` takes for one record.
    Shared by the single-record sync and the bulk import so a row written in
    bulk is indistinguishable from one written on its own."""
    return {
        "id": record.id,
        "kind": record.kind,
        "title": record.title,
        "prompt": record.prompt,
        "negative_prompt": record.negative_prompt,
        "model": record.model,
        "duration": record.duration,
        "steps": record.steps,
        "cfg": record.cfg,
        "seed": record.seed,
        "mime_type": record.mime_type,
        "audio_filename": record.audio_filename,
        "file_size_bytes": record.file_size_bytes,
        "source": record.source,
        "favorite": record.favorite,
        "rating": record.rating,
        "notes": record.notes,
        "timestamp": record.timestamp,
        "tags": list(record.tags),
        "metadata_json": meta,
    }


def _chimera_edges(entry_id: str, meta: dict[str, Any]) -> list[tuple[str, str, str]]:
    """``chimera_sources`` as directed lineage edges."""
    sources = meta.get("chimera_sources") or []
    if not isinstance(sources, list):
        return []
    return [(str(label), entry_id, "chimera_source_of") for label in sources if label]


def _reference_metadata(
    src: Path,
    entry_id: str,
    meta_in: dict[str, Any],
    *,
    embedded: Optional[Mapping[str, Any]] = None,
) -> dict[str, Any]:
    """The ``metadata.json`` for a reference-in-place entry. Shared by
    :meth:`LibraryStore.register_reference` and the bulk importer.

    ``embedded`` is the file's tags when the caller has already read them.
    The bulk importer passes none by default and MUST keep doing so: reading
    tags means opening every one of 200,000 source files, which is the same
    reason it leaves ``extract_covers`` off. Labeling still runs without them,
    from the markers ``meta_in`` carries.
    """
    # Unreachable from folder import, which filters on AUDIO_EXTS — but this
    # is public, so an unknown container gets the honest generic answer
    # rather than being labelled an MP3.
    mime = AUDIO_MIME_BY_EXT.get(src.suffix.lower(), "application/octet-stream")
    meta: dict[str, Any] = {
        "id": entry_id,
        "source_path": str(src.resolve()),
        "filename": src.name,
        "audio_filename": src.name,
        "mime_type": mime,
        "title": meta_in.get("title") or src.stem,
        "prompt": "",
        "negative_prompt": "",
        "model": "reference",
        "duration": 0.0,
        "steps": 0,
        "cfg": 0.0,
        "seed": 0,
        "favorite": False,
        "rating": None,
        "tags": list(meta_in.get("tags", [])),
        "notes": meta_in.get("notes", ""),
        "source": meta_in.get("source", "folder"),
        "chimera_sources": [],
        "saved_at": time.time(),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if embedded:
        meta["embedded_tags"] = dict(embedded)
    _apply_provider_labels(meta, embedded or {}, meta_in)
    return meta


@dataclass
class BulkDeleteResult:
    """What one batched delete did.

    ``deleted`` counts entries that are fully gone -- rows AND, where there was
    one, the library folder. ``failed`` holds ``{"id", "error"}`` for every id
    that is not, in the order they were asked for, so
    ``deleted + len(failed) == len(requested unique ids)`` always holds and a
    caller that truncates the list can still say how many it hid.
    """

    deleted: int = 0
    failed: list[dict[str, str]] = field(default_factory=list)


def _contains(root_normcase: str, candidate: Path) -> bool:
    """Whether ``candidate`` resolves to something strictly inside the library
    root.

    The guard on every ``rmtree`` this module performs in bulk. Entry ids come
    off the wire and :meth:`LibraryStore._dir_for` simply joins them onto the
    root, so an id carrying ``..`` names a directory outside the library that
    exists and holds a ``metadata.json`` -- the user's own music folder, say.
    Resolving first (which collapses ``..`` AND follows a symlink planted in
    the library) and comparing case-normalised prefixes is what makes the
    answer about the real target rather than the spelling. The root itself is
    not "inside" itself: deleting it is never what was asked for.
    """
    try:
        target = os.path.normcase(str(candidate.resolve()))
    except OSError:
        return False
    return target.startswith(root_normcase + os.sep)


@dataclass
class BulkImportResult:
    """What one batched reference-import pass did.

    ``skipped`` is files already registered (a re-run over the same folder),
    ``failed`` files that could not be registered at all. ``errors`` is capped
    at :data:`MAX_IMPORT_ERRORS` while ``failed`` keeps counting."""

    created: list[LibraryRecord] = field(default_factory=list)
    skipped: int = 0
    failed: int = 0
    errors: list[str] = field(default_factory=list)

    def note_failure(self, message: str) -> None:
        self.failed += 1
        if len(self.errors) < MAX_IMPORT_ERRORS:
            self.errors.append(message)


class ImportJob:
    """A folder import running off the request thread.

    Mutated by the worker and read by whatever polls ``GET
    /import-jobs/{id}``, so every read and write of the counters goes through
    one lock and :meth:`snapshot` hands back a consistent picture rather than
    a half-updated one. Cancellation is an ``Event``: the worker checks it
    BETWEEN batches, so a cancel never tears a transaction in half -- the
    batch in flight finishes and is kept."""

    def __init__(self, job_id: str, folder: str, *, recursive: bool = True) -> None:
        self.id = job_id
        self.folder = folder
        self.recursive = bool(recursive)
        self._lock = threading.Lock()
        self._cancel = threading.Event()
        self.status = "queued"
        self.seen = 0
        self.created = 0
        self.skipped = 0
        self.failed = 0
        self.errors: list[str] = []
        self.started_at: Optional[float] = None
        self.finished_at: Optional[float] = None

    def cancel(self) -> None:
        """Ask the job to stop.

        A job still QUEUED has no worker to notice the flag -- the background
        consumer may be minutes away from picking it up -- so it is settled
        here and :meth:`LibraryStore.run_import_job` short-circuits when it
        eventually runs. A RUNNING job keeps its status until the worker
        reaches the next batch boundary, so the reported status is never ahead
        of what actually stopped."""
        self._cancel.set()
        with self._lock:
            if self.status == "queued":
                self.status = "cancelled"
                self.finished_at = time.time()

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    @property
    def finished(self) -> bool:
        with self._lock:
            return self.status in ("done", "failed", "cancelled")

    def begin(self) -> None:
        with self._lock:
            self.status = "running"
            self.started_at = time.time()

    def set_seen(self, seen: int) -> None:
        with self._lock:
            self.seen = int(seen)

    def merge(self, result: BulkImportResult) -> None:
        with self._lock:
            self.created += len(result.created)
            self.skipped += result.skipped
            self.failed += result.failed
            for message in result.errors:
                if len(self.errors) < MAX_IMPORT_ERRORS:
                    self.errors.append(message)

    def finish(self, status: str, *, error: Optional[str] = None) -> None:
        with self._lock:
            self.status = status
            self.finished_at = time.time()
            if error and len(self.errors) < MAX_IMPORT_ERRORS:
                self.errors.append(error)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "job_id": self.id,
                "folder": self.folder,
                "status": self.status,
                "seen": self.seen,
                "created": self.created,
                "skipped": self.skipped,
                "failed": self.failed,
                "errors": list(self.errors),
                "started_at": self.started_at,
                "finished_at": self.finished_at,
            }


class ImportJobRegistry:
    """In-process register of import jobs, newest last.

    Deliberately not persisted: a job is a view onto work that only exists
    while the process does, and the library itself (metadata.json + the DB) is
    what survives a restart. Bounded so a long-lived server that imports a
    folder a day does not accumulate handles forever."""

    def __init__(self, max_jobs: int = 50) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, ImportJob] = {}
        self._max_jobs = int(max_jobs)

    def create(self, *, folder: str, recursive: bool = True) -> ImportJob:
        job = ImportJob(uuid.uuid4().hex, folder, recursive=recursive)
        with self._lock:
            self._jobs[job.id] = job
            self._prune()
        return job

    def register(self, job: Any) -> Any:
        """Adopt an already-built job so it shows up on the import-job routes.

        :meth:`create` mints an :class:`ImportJob`, which is a folder import.
        The Suno stage/promote jobs are a different shape but the same
        lifecycle, and the user should be able to poll and cancel them at the
        one place every other import lives. Anything with ``id``, ``finished``,
        ``cancel()`` and ``snapshot()`` fits here -- that is the whole contract
        the routes and :meth:`_prune` use.
        """
        with self._lock:
            self._jobs[job.id] = job
            self._prune()
        return job

    def get(self, job_id: str) -> Optional[ImportJob]:
        with self._lock:
            return self._jobs.get(job_id)

    def _prune(self) -> None:
        if len(self._jobs) <= self._max_jobs:
            return
        for job_id, job in list(self._jobs.items()):
            if len(self._jobs) <= self._max_jobs:
                break
            if job.finished:
                self._jobs.pop(job_id, None)


_import_jobs = ImportJobRegistry()


def get_import_jobs() -> ImportJobRegistry:
    return _import_jobs


class LibraryStore:
    """Filesystem-backed library with an attached SQLite query layer.

    Filesystem (``<root>/<entry_id>/metadata.json`` + audio) remains the
    durable source of truth. SQLite at ``<root>/library.db`` (overridable
    via ``db_path``) is a write-through query accelerator + the home for
    analysis / stems / midi / relations tables that have no filesystem
    representation.

    On init we open the DB, run schema migrations, and — if the DB is
    empty but filesystem entries exist, or a previous read of them was cut
    short — read every ``metadata.json`` into it (:meth:`read_disk_into_db`)
    so the query layer is immediately useful without a manual step. The
    backend constructs the store on a thread of its own
    (``router.start_opening``), so neither the upgrade nor this read holds its
    startup; ``progress`` is what the LIBRARY tab's progress bar reads
    meanwhile. Setting ``db_path=False`` disables the DB entirely (only for
    unit tests that pre-date the DB; the default tests run with the DB in
    tmp_path)."""

    def __init__(
        self,
        root: Path,
        api_prefix: str = "/api/library",
        db_path: Optional[Path] | bool = None,
        *,
        build_search_in_background: bool = False,
        progress: Optional[LibraryProgress] = None,
    ) -> None:
        self.root = root
        self.api_prefix = api_prefix
        self.root.mkdir(parents=True, exist_ok=True)

        if db_path is False:
            self.db: Optional[LibraryDB] = None
        else:
            resolved_db_path = (
                db_path if isinstance(db_path, Path) else self.root / "library.db"
            )
            self.db = LibraryDB(
                resolved_db_path,
                build_search_in_background=build_search_in_background,
                progress=progress,
            )
            # Read the disk into a fresh DB so the query layer is hot. This
            # runs any time the DB is empty -- first boot, but also a lost,
            # deleted, or rebuilt DB file next to a library that already has
            # 200,000 entries on disk -- and whenever the flag says a read
            # like that was cut short.
            try:
                if (
                    self.db.get_flag(DISK_READ_PENDING_KEY) is not None
                    or self.db.count_entries() == 0
                ):
                    self.read_disk_into_db()
            except BaseException:
                # Nobody gets this store, so nobody else would close its
                # database: its connection, and a search index build it
                # started, would outlive the failed open, one more for every
                # retry. The flag keeps a cut-short read resumable.
                self.db.close()
                raise

        #: Entry ids whose missing cover art has already been looked for, so a
        #: track that simply has none costs one tag read per process rather
        #: than one per request. See :meth:`get_cover_path`.
        self._cover_attempts: set[str] = set()

        #: Serializes read-modify-write of any entry's ``metadata.json``.
        #:
        #: Every library endpoint is a sync ``def``, so FastAPI runs them
        #: concurrently on its threadpool, and the writers here are all
        #: read -> mutate -> write of a whole JSON document. Unlocked, a user
        #: PATCH that lands between another writer's read and write is
        #: overwritten ON DISK by the stale copy -- and disk is the source of
        #: truth, so ``reindex()`` cannot repair it; it would faithfully copy
        #: the loss into the DB. An ``RLock`` because these calls nest
        #: (:meth:`update_entry` re-reads through :meth:`get_entry` while
        #: holding it).
        #:
        #: LOCK ORDER: this lock is always taken BEFORE ``LibraryDB._writelock``
        #: (a holder may call :meth:`_sync_record_to_db` or
        #: :meth:`~.db.LibraryDB.set_entry_metadata` inside its critical
        #: section) and never the other way round -- ``db.py`` imports nothing
        #: from this module and holds no reference to a store, so no DB call
        #: can call back in here and invert the order. Background job enqueues
        #: stay OUTSIDE the critical section.
        self._meta_lock = threading.RLock()

        #: Entry id -> the ``(mtime_ns, size)`` of the ``metadata.json`` that
        #: would not PARSE. A damaged file is skipped rather than rewritten,
        #: and remembering it keeps that skip from costing a failed read and a
        #: log line on every subsequent request. Keyed on the file's stamp, not
        #: just the id, so a repaired file is picked up on the next read
        #: instead of staying blacklisted for the life of the process -- and
        #: only ever written for a PARSE failure: an OSError here is a sharing
        #: violation during another writer's rename, an antivirus pass, a
        #: network drive blinking, and says nothing durable about the entry.
        self._unparsable_meta: dict[str, tuple[int, int]] = {}

        #: Entry id -> the monotonic time its provider write LAST failed with
        #: an OSError. A read-only library or a full volume fails every row of
        #: every page; without this, each list request would re-attempt up to
        #: 500 doomed file writes. Retried after
        #: :data:`PROVIDER_WRITE_RETRY_SECONDS` so the entry recovers on its
        #: own once the volume is writable again.
        self._provider_write_failed: dict[str, float] = {}

        #: Entry ids whose provider question is settled for this process: the
        #: stored answer is already right, or it is somebody else's answer and
        #: will never be touched. Checked before anything is read from disk, so
        #: a row the read path keeps re-deriving costs nothing after the first
        #: look.
        self._provider_settled: set[str] = set()

    # ---- Read ---------------------------------------------------------------

    def _iter_disk_entries(
        self,
        kinds: Optional[Iterable[str]] = None,
        *,
        progress: Optional[LibraryProgress] = None,
    ) -> Iterator[tuple[LibraryRecord, dict[str, Any], Path]]:
        """Walk the filesystem yielding ``(record, metadata, entry_dir)``.

        The single place the on-disk layout is interpreted. Yielding the parsed
        metadata alongside the record is what lets :meth:`reindex` read each
        ``metadata.json`` ONCE -- it used to walk with ``list_entries`` and
        then read every file a second time to get the same dict back.

        ``progress`` gets a ``read`` task counted in top-level folders -- the
        one number known before the walk starts -- with every entry found
        counted alongside as an item.
        """
        if not self.root.is_dir():
            return
        kind_set = set(kinds) if kinds is not None else None
        # Folders only: library.db and its -wal/-shm sit beside them.
        folders = [child for child in sorted(self.root.iterdir()) if child.is_dir()]
        if progress is not None:
            progress.begin("read", len(folders))
        for child in folders:
            if progress is not None:
                # Counted as the folder is reached: a generator stops where
                # its consumer stops, so a count after the yield would lag.
                progress.advance("read", 1)
            # Generate flow has been writing data/generations/<job_id>/<index>/
            # i.e. nested two levels. Walk down one if we see no metadata.json
            # at the top.
            direct_meta = _read_metadata(child)
            if direct_meta is not None:
                record = _record_from_metadata(child, direct_meta, self.api_prefix)
                if record is not None and (kind_set is None or record.kind in kind_set):
                    if progress is not None:
                        progress.advance("read", items=1)
                    yield record, direct_meta, child
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
                if kind_set is not None and record.kind not in kind_set:
                    continue
                record.id = entry_id
                if record.kind == "audio":
                    record.audio_url = _audio_url_for(self.api_prefix, entry_id)
                    if record.cover_url:
                        record.cover_url = _cover_url_if_present(
                            inner, self.api_prefix, entry_id
                        )
                else:
                    record.media_url = _media_url_for(self.api_prefix, entry_id)
                    record.audio_url = record.media_url
                if progress is not None:
                    progress.advance("read", items=1)
                yield record, meta, inner

    def list_entries(
        self, kinds: Optional[Iterable[str]] = None
    ) -> list[LibraryRecord]:
        """List entries, optionally restricted to a set of ``kind`` values
        ('audio' | 'video' | 'image'). ``kinds=None`` returns every kind
        (used by reindex); callers that want the historical audio-only
        behavior pass ``kinds={'audio'}``."""
        return [record for record, _meta, _dir in self._iter_disk_entries(kinds)]

    def list_entries_fast(
        self, kinds: Optional[Iterable[str]] = None
    ) -> list[LibraryRecord]:
        """DB-backed sibling of :meth:`list_entries` for the hot ``/entries``
        endpoint: ONE ``entries`` SELECT plus one directory stat per row,
        instead of reading and JSON-parsing every ``metadata.json`` off disk.
        Falls back to the filesystem walk when the DB is disabled. Sizes and
        timestamps come from the DB snapshot, so a file changed behind the
        store's back stays stale until :meth:`reindex`."""
        if self.db is None:
            return self.list_entries(kinds)
        kind_set = set(kinds) if kinds is not None else None
        out: list[LibraryRecord] = []
        unresolved: dict[str, str] = {}
        for row in self.db.list_entries():
            entry_id = str(row["id"])
            kind = str(row.get("kind") or "audio")
            if kind_set is not None and kind not in kind_set:
                continue
            # The walk hides entries whose folder was deleted by hand;
            # _dir_for preserves that with a stat instead of a metadata read
            # (it also resolves the nested "<job_id>/<index>" generate layout
            # that a plain root/<id> check would miss).
            entry_dir = self._dir_for(entry_id)
            if entry_dir is None:
                continue
            out.append(
                _record_from_db_row(
                    row,
                    entry_dir,
                    self.api_prefix,
                    unresolved=(
                        unresolved
                        if len(unresolved) < MAX_PROVIDER_COLUMN_FILL
                        else None
                    ),
                )
            )
        self._fill_provider_column(unresolved)
        # The walk emits entries in sorted(root.iterdir()) order; sorting by
        # id mirrors that (entry ids are the directory names).
        out.sort(key=lambda r: r.id)
        return out

    def list_entries_page(
        self,
        filters: EntryFilters,
        *,
        sort: str = DEFAULT_SORT,
        limit: int = 200,
        offset: int = 0,
    ) -> list[LibraryRecord]:
        """Records for ONE page, in the order SQL returned them.

        The filtering, searching, sorting and slicing all happen in the
        database; the only per-row work here is the directory stat that
        resolves cover art, and it runs at most ``limit`` times instead of once
        per entry in the library.

        An entry whose folder was deleted by hand is omitted, exactly as
        :meth:`list_entries_fast` omits it — so a page can be shorter than
        ``limit`` while the caller's ``total`` still counts the row. Catching
        that in the count would mean the per-row filesystem access this whole
        path exists to avoid.

        Rows whose metadata names a provider the ``provider`` column has not
        recorded yet are resolved here, bounded to this page — except under an
        active provider filter, where a page must never rewrite its own result
        set (see :meth:`_fill_provider_column`).
        """
        if self.db is None:
            raise RuntimeError("paged listing needs the library DB")
        out: list[LibraryRecord] = []
        unresolved: dict[str, str] = {}
        for row in self.db.list_entries_page(
            filters, sort=sort, limit=limit, offset=offset
        ):
            entry_dir = self._dir_for(str(row["id"]))
            if entry_dir is None:
                continue
            out.append(
                _record_from_db_row(
                    row,
                    entry_dir,
                    self.api_prefix,
                    unresolved=None if filters.provider else unresolved,
                )
            )
        self._fill_provider_column(unresolved)
        return out

    def get_entry(self, entry_id: str) -> Optional[LibraryRecord]:
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return None
        meta = _read_metadata(entry_dir)
        if meta is None:
            return None
        record = _record_from_metadata(entry_dir, meta, self.api_prefix)
        if record is None:
            return None
        # The nested "<job>/<index>" layout resolves against the inner dir, so
        # every per-entry URL is re-stamped with the id callers actually use.
        record.id = entry_id
        if record.kind in ("video", "image"):
            # A media entry streams from /media/<id>. This used to rewrite
            # audio_url to the audio route unconditionally, so the single-entry
            # read disagreed with both list paths, which set audio_url ==
            # media_url. (The old URL did resolve — /audio/<id> falls back to
            # the declared filename and happily serves the mp4 — so this is a
            # consistency fix, not a 404 fix.)
            record.media_url = _media_url_for(self.api_prefix, entry_id)
            record.audio_url = record.media_url
            if record.thumb_url:
                record.thumb_url = _thumb_url_for(self.api_prefix, entry_id)
        else:
            record.audio_url = _audio_url_for(self.api_prefix, entry_id)
            if record.cover_url:
                record.cover_url = _cover_url_if_present(
                    entry_dir, self.api_prefix, entry_id
                )
        return record

    def get_audio_path(self, entry_id: str) -> Optional[Path]:
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return None
        meta = _read_metadata(entry_dir) or {}
        resolved = _resolve_audio_file(entry_dir, meta)
        if resolved is not None:
            return resolved
        # The entry is real but its bytes were never written here. The user's
        # own media folders are asked next -- referenced in place, exactly as
        # a folder import's `source_path` is: nothing is copied in, nothing is
        # written to the entry, and the metadata is not touched. An id that is
        # not an entry at all still answers None above, so this cannot invent
        # a library member out of a stray file.
        return media_roots.lookup(entry_id, extensions=AUDIO_EXTS)

    def get_media_path(self, entry_id: str) -> Optional[Path]:
        """Resolve the video/image file for a media entry (None for audio
        entries or unknown ids)."""
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return None
        meta = _read_metadata(entry_dir) or {}
        if str(meta.get("kind") or "audio") not in ("video", "image"):
            return None
        resolved = _resolve_media_file(entry_dir, meta)
        if resolved is not None:
            return resolved
        return media_roots.lookup(entry_id, extensions=_MEDIA_EXTS)

    def get_thumb_path(self, entry_id: str) -> Optional[Path]:
        """Resolve the poster thumbnail for a media entry, if one exists."""
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return None
        thumb = entry_dir / "thumb.jpg"
        return thumb if thumb.is_file() else None

    def get_cover_path(
        self, entry_id: str, *, extract_missing: bool = False
    ) -> Optional[Path]:
        """Resolve the cover art for an entry, if the track had any.

        A bulk folder import skips cover extraction — reading tags off 200,000
        files up front is most of the import. With ``extract_missing`` the
        serving route pays that cost lazily instead: the FIRST request for an
        entry with no cover on disk reads its embedded art and writes it.
        Guarded per process, so a track that simply has no picture costs one
        tag read, not one per request.
        """
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return None
        cover = entry_dir / COVER_FILENAME
        if cover.is_file():
            return cover
        if not extract_missing or entry_id in self._cover_attempts:
            return None
        self._cover_attempts.add(entry_id)
        meta = _read_metadata(entry_dir) or {}
        if str(meta.get("kind") or "audio") != "audio":
            return None
        audio_path = _resolve_audio_file(entry_dir, meta)
        if audio_path is None or not extract_cover_for(entry_dir, audio_path):
            return None
        return cover if cover.is_file() else None

    # ---- Write --------------------------------------------------------------

    def update_entry(
        self, entry_id: str, patch: dict[str, Any]
    ) -> Optional[LibraryRecord]:
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return None
        # One writer at a time per entry, across the WHOLE read-modify-write:
        # this edit must not be built on a copy another writer is about to
        # replace, and must not be replaced by one. See `_meta_lock`.
        with self._meta_lock:
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
            if "lyrics" in meta:
                meta["lyrics"] = str(meta["lyrics"] or "")
            if "notation_artist" in meta:
                meta["notation_artist"] = str(meta["notation_artist"] or "")
            if "notation_title" in meta:
                meta["notation_title"] = str(meta["notation_title"] or "")
            if "chimera_sources" in meta:
                raw = meta["chimera_sources"] or []
                if not isinstance(raw, list):
                    raw = []
                meta["chimera_sources"] = [str(s) for s in raw]
            if meta.get("rating") not in ("like", "dislike", None):
                meta["rating"] = None
            _write_metadata(entry_dir, meta)
            record = self.get_entry(entry_id)
            if record is not None:
                self._sync_record_to_db(record, meta)
        # Favoriting a track gives it the full treatment — stems, MIDI, and a
        # score — so a starred track is always fully analyzed and notated. Each
        # job is idempotent (skipped if the artifact exists) and runs on the
        # idle-gated, serialized background queue (stems -> midi -> score).
        if bool(patch.get("favorite")):
            _maybe_enqueue_stems(self, entry_id, source="favorite", force=True)
            _maybe_enqueue_lyrics(self, entry_id, source="favorite", force=True)
            _maybe_enqueue_midi(self, entry_id, source="favorite", force=True)
            _maybe_enqueue_score(self, entry_id, source="favorite", force=True)
        return record

    def record_detected_providers(self, detected: Mapping[str, ProviderInfo]) -> int:
        """Persist a provider the READ path worked out, once, per entry.

        Sits beside :meth:`update_entry` rather than inside it because this is
        not an edit and must not look like one. A user PATCH rewrites columns
        through ``upsert_entry`` (moving ``updated_at``), rebuilds the tag and
        search indexes, and can enqueue stems/lyrics/midi/score. None of that
        happens here: the entry's ``metadata.json`` gains the ``provider*``
        keys and :meth:`~.db.LibraryDB.set_entry_metadata` writes the same
        dict into the row's ``metadata_json`` column, so the two copies of an
        entry's metadata stay in agreement and nothing else moves. No job is
        enqueued, no notification is fired, ``timestamp`` is untouched, and no
        sort order can notice.

        Why it exists: the label an entry is SHOWN with is derived in Python
        from its analysis row's tag blob, while the ``provider=`` list filter
        is SQL over the entry row alone (:data:`~.db.PROVIDER_SQL`). Until the
        derived answer is stored, those two disagree forever and the entry
        answers to no provider filter. Writing it once ends the disagreement.

        Bounded and idempotent:

        * only the ids the caller passes -- the rows a request was already
          returning -- are considered; nothing here searches for candidates,
        * an entry whose stored metadata already names a provider is skipped,
          so the user's answer, the importer's answer, and this method's own
          answer from an earlier read are all safe, and a second call for the
          same entry writes nothing,
        * a REFERENCE-IN-PLACE entry keeps its source file untouched: the only
          file written is ``metadata.json`` inside the entry's own folder
          under the library root, and there is no code path here that reads
          ``source_path``,
        * an entry whose ``metadata.json`` cannot be PARSED is skipped and
          remembered against that file's stamp, so a damaged file is never
          rewritten from a guess, is not re-read on the next request, and is
          picked up again the moment it is repaired. An entry that merely
          could not be OPENED this instant is skipped and NOT remembered,
        * an entry whose file write fails keeps its place for
          :data:`PROVIDER_WRITE_RETRY_SECONDS` before being tried again, so a
          read-only library costs one attempt per row per five minutes rather
          than one per row per request.

        The DB mirror is one small transaction PER ENTRY rather than one per
        batch. That is deliberate: batching it outside the per-entry lock is
        what would let two threads update one row's column out of order, and
        the writes are tiny -- no revision bump, no index, no tag rebuild.

        Concurrency: ``_meta_lock`` is held across ONE entry's read, merge,
        file write and DB mirror, and released before the next -- so a
        500-row first view can never hold a user's PATCH off for the length
        of a batch, and the never-overwrite test is made on the read INSIDE
        the lock rather than on an earlier snapshot. The DB mirror sits in
        the same critical section as the file write so the two copies of one
        entry's metadata cannot be updated out of order by two threads.

        Returns how many entries were written. Per-entry filesystem failures
        are counted and reported once at debug level, never per row; the
        caller (a read) swallows the rest, so a read-only library or a locked
        database costs nothing but today's behaviour.
        """
        if not detected:
            return 0
        written = 0
        failed = 0
        now = time.monotonic()
        for entry_id, info in detected.items():
            if info is None or entry_id in self._provider_settled:
                continue
            last_failure = self._provider_write_failed.get(entry_id)
            if last_failure is not None:
                if now - last_failure < PROVIDER_WRITE_RETRY_SECONDS:
                    continue
                del self._provider_write_failed[entry_id]
            entry_dir = self._dir_for(entry_id)
            if entry_dir is None:
                continue
            if self._unparsable_meta.get(entry_id) == _meta_stamp(entry_dir):
                # Same damaged bytes as last time: one stat, no read, no log.
                continue
            with self._meta_lock:
                stamp = _meta_stamp(entry_dir)
                meta, why = _read_metadata_checked(entry_dir)
                if meta is None:
                    if why == META_READ_PARSE and stamp is not None:
                        # Damaged: remembered against THESE bytes, so a
                        # repaired file is read again rather than blacklisted.
                        self._unparsable_meta[entry_id] = stamp
                    # An IO error says nothing durable -- never memoized.
                    continue
                stored = meta.get("provider")
                if not _is_unset(stored):
                    if not self._mirror_settled_provider(entry_id, meta, stored, info):
                        failed += 1
                    continue
                merged = {**meta, **_detected_provider_meta(info)}
                try:
                    _write_metadata(entry_dir, merged)
                except OSError:
                    self._provider_write_failed[entry_id] = now
                    failed += 1
                    continue
                # The durable copy is written; the entry counts as recorded.
                written += 1
                # Disk first, then the mirror, both inside the lock -- the
                # order update_entry uses. If the mirror fails the row is
                # labeled on disk and not yet in the column, which the NEXT
                # read repairs (see _mirror_settled_provider).
                if not self._mirror_metadata(entry_id, merged):
                    failed += 1
        if failed:
            log.debug(
                "library.store: could not record a detected provider for %d entries",
                failed,
            )
        return written

    def _fill_provider_column(self, provider_by_id: Mapping[str, str]) -> int:
        """Record, once, the provider that rows already carry in their metadata.

        The lazy half of the ``entries.provider`` column. Rows written since
        the column existed have it set by their own writer; rows older than it
        carry the answer in ``metadata_json`` and NULL in the column, and are
        resolved HERE -- the first time a request returns them, from the
        metadata that request had already parsed. No query looks for
        candidates, no file is opened and nothing walks the library, so an
        untouched 200,000-entry library costs exactly one UPDATE per row that
        is actually looked at, ever.

        Until a row is resolved, :data:`~.db.PROVIDER_SQL` answers for it with
        the fallback over its ``model`` / ``source`` columns. That is a
        consistent answer, not a missing one: the list filter, its count and
        the facet all read the same expression, so the row is returned by,
        counted in and faceted under one slug at every moment -- the slug the
        catalogue has always shown an unlabeled entry under. What changes when
        it resolves is WHICH slug, and that is why a provider-FILTERED page
        never fills: it would refile rows out of the result set the user is
        looking at, exactly as a read-time relabel would (see
        :meth:`~.router._attach_analysis`).

        Never raises: a read-only volume or a locked database leaves the
        column NULL and the fallback answering, which is what happened before
        this existed. Returns how many rows were filled.
        """
        if not provider_by_id or self.db is None:
            return 0
        try:
            return self.db.fill_entry_providers(provider_by_id)
        except Exception as e:  # noqa: BLE001 - a read never fails on a write
            log.debug(
                "library.store: could not resolve the provider column for "
                "%d entries: %s: %s",
                len(provider_by_id),
                type(e).__name__,
                e,
            )
            return 0

    def _mirror_metadata(self, entry_id: str, meta: dict[str, Any]) -> bool:
        """Copy one entry's metadata into its ``metadata_json`` column.

        Its own try/except, because the mirror of ONE row failing must not
        abort the rest of a page: the next row's disk write is independent and
        should still happen. Returns whether the column now matches disk.
        """
        if self.db is None:
            return True
        try:
            self.db.set_entry_metadata({entry_id: meta})
        except Exception as e:
            log.debug("library.store: metadata mirror failed for %s: %s", entry_id, e)
            return False
        return True

    def _mirror_settled_provider(
        self,
        entry_id: str,
        meta: dict[str, Any],
        stored: Any,
        info: ProviderInfo,
    ) -> bool:
        """Handle an entry whose DISK metadata already names a provider.

        Two cases, and the difference matters:

        * The stored slug IS what was just detected. Then the only reason the
          read path keeps deriving it is that the ``metadata_json`` COLUMN is
          behind -- an earlier mirror failed after its file write, and the
          never-overwrite rule would otherwise make that permanent: disk says
          "labeled", so no later read could ever repair the column, and the
          row would answer to no provider filter for good. The disk dict is
          mirrored as-is (never a fresh merge -- disk is the source of truth)
          to close the gap.
        * The stored slug is something ELSE. That is a real answer, the
          user's or an importer's, and it wins. Nothing is written, ever.

        Either way the entry is settled for this process, so no later request
        reads its file again -- including when the repair itself fails, which
        is one attempt per process by design and otherwise waits for a restart
        or a ``reindex()``. Returns whether the column is in agreement.
        """
        self._provider_settled.add(entry_id)
        if str(stored).strip().lower() != info.provider.strip().lower():
            return True
        return self._mirror_metadata(entry_id, meta)

    def delete_entry(self, entry_id: str) -> bool:
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return False
        try:
            shutil.rmtree(entry_dir)
        except OSError as e:
            log.warning("library.store: failed to delete %s: %s", entry_dir, e)
            return False
        if self.db is not None:
            self.db.delete_entry(entry_id)
        return True

    def delete_entries_bulk(
        self, entry_ids: Iterable[str], *, batch: int = DEFAULT_DELETE_BATCH
    ) -> BulkDeleteResult:
        """Delete many entries. One DB transaction per batch, filesystem after.

        ``batch`` is how many entries share a transaction; the DB layer caps it
        at the SQL parameter ceiling, so a larger value simply commits more
        often rather than failing.

        Removes exactly what :meth:`delete_entry` removes, per entry: the
        entry's own folder under the library root, plus its rows. In
        particular, for a REFERENCE-IN-PLACE entry -- one registered from the
        user's own music folder, whose ``source_path`` points outside the
        library -- the folder holds only ``metadata.json`` and any extracted
        cover, so the user's audio file is never a candidate for removal. There
        is no code path here that reads ``source_path``, by design.

        Three rules make this safe to point at 200,000 rows:

        * **Containment.** Every directory is resolved and proved to be inside
          the library root before anything is removed (:func:`_contains`). An
          id that escapes is refused outright -- its rows are left alone too,
          so the entry stays visible instead of half-deleted.
        * **Order.** The rows are committed first, the folder goes after. A
          crash between the two leaves an orphan folder, which is harmless and
          re-importable; the other order would leave a row pointing at audio
          that no longer exists.
        * **Isolation.** A failure is recorded against its id and the rest of
          the request continues. Nothing aborts the batch.

        A row whose folder was deleted by hand is still cleared: those rows are
        skipped by the listing but counted in its ``total``, so leaving them
        would mean "Clear all" never finishes. An id with neither a row nor a
        folder is reported as a failure -- there was nothing to delete.
        """
        ordered = list(dict.fromkeys(str(entry_id) for entry_id in entry_ids))
        result = BulkDeleteResult()
        if not ordered:
            return result

        known = self.db.existing_entry_ids(ordered) if self.db is not None else set()
        root_normcase = os.path.normcase(str(self.root.resolve()))

        # Classify first, so a refused id never reaches a DELETE.
        targets: list[tuple[str, Optional[Path]]] = []
        for entry_id in ordered:
            entry_dir = self._dir_for(entry_id)
            if entry_dir is not None and not _contains(root_normcase, entry_dir):
                log.warning(
                    "library.store: refusing bulk delete of %r: %s is outside %s",
                    entry_id,
                    entry_dir,
                    self.root,
                )
                result.failed.append(
                    {
                        "id": entry_id,
                        "error": "resolved path is outside the library root",
                    }
                )
                continue
            if entry_dir is None and entry_id not in known:
                result.failed.append({"id": entry_id, "error": "no such library entry"})
                continue
            targets.append((entry_id, entry_dir))

        size = max(1, int(batch))
        # One WAL checkpoint for the whole request, not one per batch.
        deferred = self.db.checkpoint_once() if self.db is not None else nullcontext()
        with deferred:
            for start in range(0, len(targets), size):
                chunk = targets[start : start + size]
                if self.db is not None:
                    # One transaction, one revision bump, for this whole chunk.
                    self.db.delete_entries_bulk(
                        [entry_id for entry_id, _ in chunk], batch=len(chunk)
                    )
                for entry_id, entry_dir in chunk:
                    if entry_dir is None:
                        result.deleted += 1
                        continue
                    try:
                        shutil.rmtree(entry_dir)
                    except OSError as e:
                        log.warning(
                            "library.store: deleted row %r but failed to remove %s: %s",
                            entry_id,
                            entry_dir,
                            e,
                        )
                        result.failed.append(
                            {"id": entry_id, "error": f"could not remove folder: {e}"}
                        )
                        continue
                    result.deleted += 1
        return result

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

        # Read any embedded metadata (e.g., ID3 TXXX:prompt from an
        # AI-generated MP3) and merge with caller-supplied metadata.
        # Caller wins for explicit fields; embedded fills the gaps.
        from .tags import extract_embedded_tags

        embedded = extract_embedded_tags(target_path)
        # Same frames, the other half of what they carry: the front cover.
        # Written before the record is built so the first response already
        # says the entry has artwork.
        extract_cover_for(entry_dir, target_path)
        meta_in = dict(metadata or {})

        def _pick(field: str, embedded_keys: list[str], default: Any) -> Any:
            if field in meta_in and meta_in[field] not in (None, ""):
                return meta_in[field]
            for ek in embedded_keys:
                if ek in embedded and embedded[ek]:
                    return embedded[ek]
            return default

        title_default = embedded.get("title") or target_name
        record_meta: dict[str, Any] = {
            "id": entry_id,
            "filename": target_name,
            "audio_filename": target_name,
            "mime_type": mime_type,
            "title": _pick("title", ["title"], title_default),
            "prompt": _pick("prompt", ["prompt"], ""),
            "negative_prompt": _pick("negative_prompt", ["negative_prompt"], ""),
            # Read like every other field the caller may supply: without this
            # key an uploader's own lyrics were dropped on the floor, and the
            # curated ones a provider file carries had nothing to fill.
            "lyrics": _pick("lyrics", ["lyrics"], ""),
            "model": _pick("model", ["model", "generator"], "import"),
            "duration": meta_in.get("duration", 0.0),
            "steps": meta_in.get("steps", 0),
            "cfg": meta_in.get("cfg", 0.0),
            "seed": meta_in.get("seed", 0),
            "favorite": False,
            "rating": None,
            "tags": list(meta_in.get("tags", [])),
            "notes": meta_in.get("notes", ""),
            "source": meta_in.get("source", "import"),
            "chimera_sources": list(meta_in.get("chimera_sources", [])),
            "saved_at": time.time(),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "embedded_tags": embedded,
        }
        # Who made this, and the fields of the file that describe the SONG.
        # `source` above is untouched: an import stays an import.
        _apply_provider_labels(record_meta, embedded, meta_in)
        # New entry id: nothing else can be mid-write on this
        # file. Locked anyway, so that EVERY metadata.json write
        # in this module happens under the lock.
        with self._meta_lock:
            _write_metadata(entry_dir, record_meta)
        record = _record_from_metadata(entry_dir, record_meta, self.api_prefix)
        assert record is not None, "freshly imported entry must resolve"
        record.id = entry_id
        record.audio_url = _audio_url_for(self.api_prefix, entry_id)
        self._sync_record_to_db(record, record_meta)
        # Opt-in: enqueue background analysis / stems / midi if the
        # user has those toggles on (defaults are all OFF).
        # Serial idle queue, in this order: stems first (everything after
        # wants the vocal / the parts), lyrics next (the song is singable
        # sooner than it is notated), then MIDI and the sheet.
        _maybe_enqueue_analysis(self, entry_id, source="import")
        _maybe_enqueue_stems(self, entry_id, source="import")
        _maybe_enqueue_lyrics(self, entry_id, source="import")
        _maybe_enqueue_midi(self, entry_id, source="import")
        _maybe_enqueue_score(self, entry_id, source="import")
        _maybe_enqueue_shards(self, entry_id, source="import")
        return record

    def register_reference(
        self,
        source_path: str,
        metadata: Optional[dict[str, Any]] = None,
    ) -> Optional[LibraryRecord]:
        """Register an on-disk audio file as a library entry WITHOUT copying it
        (reference-in-place). Only a small metadata.json is written into the
        library; the audio is served / analysed straight from ``source_path``.
        Used by the folder -> playlist feature. Returns None when the path is
        not a file.

        The file's own tags are read here, the way they are for an upload: this
        path already opens the file for its cover art, so a track registered in
        place is identified and curated exactly like one copied in. The BULK
        sibling below does neither, by design."""
        from .tags import extract_embedded_tags

        src = Path(source_path)
        if not src.is_file():
            return None
        # Registering the same file twice must not make two entries of it. The
        # bulk sibling has always skipped an already-registered ``source_path``
        # (a re-run over a folder is a no-op); doing it here too is what makes
        # two callers racing on one file -- two browser tabs opening the same
        # performance set -- land on one entry instead of two, whatever order
        # they interleave in. The claim is the DB row, not a lock.
        wanted_source = str((metadata or {}).get("source") or "folder")
        if self.db is not None:
            existing = self.db.entry_id_for_source_path(
                str(src.resolve()), wanted_source
            )
            if existing:
                record = self.get_entry(existing)
                if record is not None:
                    return record
        entry_id = uuid.uuid4().hex
        entry_dir = self.root / entry_id
        entry_dir.mkdir(parents=True, exist_ok=True)
        record_meta = _reference_metadata(
            src,
            entry_id,
            dict(metadata or {}),
            embedded=extract_embedded_tags(src),
        )
        # The audio stays where it is, but its artwork is copied in: the cover
        # has to live under the library root for the route to serve it. A
        # folder import runs this per file — a track with no picture costs a
        # tag read, and one with a picture pays the normalise it needs.
        extract_cover_for(entry_dir, src)
        # New entry id: nothing else can be mid-write on this
        # file. Locked anyway, so that EVERY metadata.json write
        # in this module happens under the lock.
        with self._meta_lock:
            _write_metadata(entry_dir, record_meta)
        record = _record_from_metadata(entry_dir, record_meta, self.api_prefix)
        if record is None:
            return None
        record.id = entry_id
        record.audio_url = _audio_url_for(self.api_prefix, entry_id)
        self._sync_record_to_db(record, record_meta)
        # Reference tracks still benefit from BG analysis (BPM/key for mixing);
        # it reads get_audio_path, which now resolves to the external file.
        _maybe_enqueue_analysis(self, entry_id, source="import")
        return record

    def register_references_bulk(
        self,
        paths: Iterable[Any],
        *,
        defer_jobs: bool = True,
        extract_covers: bool = False,
        source: str = "folder",
        batch: int = 1000,
        known_source_paths: Optional[set[str]] = None,
    ) -> BulkImportResult:
        """Register many on-disk files as reference-in-place entries.

        The batched sibling of :meth:`register_reference`, for the folder
        import that has to survive ~200,000 files. Three things are different,
        and all three are why the per-file version cannot be used at that size:

        * DB writes go through ``upsert_entries_bulk``, so ``batch`` files
          share ONE transaction and one ``library_revision`` bump instead of
          one each.
        * ``extract_covers`` is off: reading embedded artwork means opening and
          parsing every source file. :meth:`get_cover_path` picks it up lazily
          when a cover is actually asked for. It gates the file's TAGS for the
          same reason -- with it off, an entry is labeled from what the caller
          says about it and from nothing else, and a provider that only the
          file knows about is picked up later, at read time, from the tags the
          analysis pass stores. Nothing here re-reads 200,000 files.
        * ``defer_jobs`` is on: 200,000 queued analysis jobs would saturate the
          serial background queue for days. The user runs analysis when they
          want it.

        Already-registered files (matched on the resolved ``source_path``) are
        skipped, which makes a re-run over the same folder a no-op and makes a
        cancelled import resumable. ``known_source_paths``, when given, is both
        read AND extended with what this call registers, so a caller looping
        over batches pays for the lookup scan once.
        """
        from .tags import extract_embedded_tags

        if self.db is None:
            raise RuntimeError("bulk import needs the library DB")
        result = BulkImportResult()
        known = (
            known_source_paths
            if known_source_paths is not None
            else self.db.registered_source_paths()
        )
        buffered: list[tuple[LibraryRecord, dict[str, Any]]] = []

        def flush() -> None:
            if not buffered:
                return
            self.db.upsert_entries_bulk(
                [_db_payload(record, meta) for record, meta in buffered],
                batch=len(buffered),
            )
            for record, _meta in buffered:
                result.created.append(record)
                if not defer_jobs:
                    _maybe_enqueue_analysis(self, record.id, source="import")
            buffered.clear()

        for raw in paths:
            src = Path(raw)
            try:
                if not src.is_file():
                    result.note_failure(f"not a file: {src}")
                    continue
                resolved = str(src.resolve())
                if resolved in known:
                    result.skipped += 1
                    continue
                entry_id = uuid.uuid4().hex
                entry_dir = self.root / entry_id
                entry_dir.mkdir(parents=True, exist_ok=True)
                record_meta = _reference_metadata(
                    src,
                    entry_id,
                    {"source": source},
                    embedded=extract_embedded_tags(src) if extract_covers else None,
                )
                if extract_covers:
                    extract_cover_for(entry_dir, src)
                # New entry id: nothing else can be mid-write on this
                # file. Locked anyway, so that EVERY metadata.json write
                # in this module happens under the lock.
                with self._meta_lock:
                    _write_metadata(entry_dir, record_meta)
                record = _record_from_metadata(entry_dir, record_meta, self.api_prefix)
                if record is None:
                    result.note_failure(f"unreadable after registering: {src}")
                    continue
                record.id = entry_id
                record.audio_url = _audio_url_for(self.api_prefix, entry_id)
                buffered.append((record, record_meta))
                known.add(resolved)
            except OSError as e:
                result.note_failure(f"{src}: {e}")
                continue
            if len(buffered) >= batch:
                flush()
        flush()
        return result

    def run_import_job(self, job: ImportJob, *, batch: int = 1000) -> ImportJob:
        """Run one folder import to completion, synchronously.

        Called from a worker thread (see the router's ``?async=1`` path), which
        is why it takes no event loop and never raises: every outcome is
        recorded on ``job``. Cancellation is honoured BETWEEN batches, so the
        transaction in flight always commits — a cancelled import leaves a
        consistent, resumable library rather than a partial batch.
        """
        if job.cancelled:
            job.finish("cancelled")
            return job
        job.begin()
        try:
            root = Path(job.folder)
            if not root.is_dir():
                job.finish("failed", error=f"not a folder: {job.folder}")
                return job
            walk = root.rglob("*") if job.recursive else root.iterdir()
            files = sorted(
                (p for p in walk if p.is_file() and p.suffix.lower() in AUDIO_EXTS),
                key=lambda p: str(p).lower(),
            )
            job.set_seen(len(files))
            known = self.db.registered_source_paths() if self.db is not None else set()
            for start in range(0, len(files), batch):
                if job.cancelled:
                    job.finish("cancelled")
                    return job
                job.merge(
                    self.register_references_bulk(
                        [str(p) for p in files[start : start + batch]],
                        batch=batch,
                        known_source_paths=known,
                    )
                )
            job.finish("cancelled" if job.cancelled else "done")
        except Exception as e:  # noqa: BLE001 - a job records its failure, never raises
            log.warning("library.store: import job %s failed: %s", job.id, e)
            job.finish("failed", error=repr(e))
        return job

    def import_media(
        self,
        media_bytes: bytes,
        filename: str,
        mime_type: str,
        metadata: Optional[dict[str, Any]] = None,
    ) -> LibraryRecord:
        """Import a video or image as a library entry (kind='video'|'image').

        Stores the original file untouched, probes it for dimensions /
        duration / alpha, and renders a poster thumbnail. None of the
        audio analysis/stems/midi pipelines run for media. Raises
        ValueError for an unrecognized media extension.
        """
        from . import media as media_probe

        kind = media_probe.classify_ext(filename)
        if kind is None:
            raise ValueError(
                f"unrecognized media type for {filename!r} "
                "(expected a video or image file)"
            )

        entry_id = uuid.uuid4().hex
        entry_dir = self.root / entry_id
        entry_dir.mkdir(parents=True, exist_ok=True)
        suffix = Path(filename).suffix.lower()
        safe_name = Path(filename).stem[:80] or "media"
        target_name = f"{safe_name}{suffix}"
        target_path = entry_dir / target_name
        target_path.write_bytes(media_bytes)

        probe = media_probe.probe_media(target_path, kind)
        thumb_path = entry_dir / "thumb.jpg"
        media_probe.make_thumbnail(target_path, kind, thumb_path)

        meta_in = dict(metadata or {})
        record_meta: dict[str, Any] = {
            "id": entry_id,
            "kind": kind,
            "filename": target_name,
            "media_filename": target_name,
            "mime_type": mime_type or "",
            "title": meta_in.get("title") or safe_name,
            "prompt": meta_in.get("prompt", ""),
            "negative_prompt": "",
            "model": meta_in.get("model", "import"),
            "duration": probe.get("duration") or 0.0,
            "favorite": False,
            "rating": None,
            "tags": list(meta_in.get("tags", [])),
            "notes": meta_in.get("notes", ""),
            "source": meta_in.get("source", "import"),
            "width": probe.get("width"),
            "height": probe.get("height"),
            "has_alpha": bool(probe.get("has_alpha")),
            "saved_at": time.time(),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        # New entry id: nothing else can be mid-write on this
        # file. Locked anyway, so that EVERY metadata.json write
        # in this module happens under the lock.
        with self._meta_lock:
            _write_metadata(entry_dir, record_meta)
        record = _media_record_from_metadata(
            entry_dir, record_meta, self.api_prefix, kind
        )
        assert record is not None, "freshly imported media must resolve"
        self._sync_record_to_db(record, record_meta)
        return record

    # ---- Cover art ----------------------------------------------------------

    def attach_cover(
        self, entry_id: str, image_bytes: Optional[bytes] = None
    ) -> Optional[str]:
        """Attach or refresh one entry's cover art, replacing any existing one.

        With ``image_bytes`` the caller's picture is normalised and written;
        without, the entry's audio file is re-read for an embedded front cover.
        Returns the cover URL on success, None when the entry is unknown, is
        not an audio entry, has no audio to read, or carries nothing usable as
        artwork.

        Audio only, deliberately: a video/image entry posters itself from
        ``thumb.jpg`` and every read path reports ``cover_url`` as None for it,
        so writing art here would leave bytes on disk that nothing can ever
        show.
        """
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return None
        meta = _read_metadata(entry_dir) or {}
        if str(meta.get("kind") or "audio") != "audio":
            return None
        if image_bytes is not None:
            from .tags import write_cover_image

            written = write_cover_image(image_bytes, entry_dir / COVER_FILENAME)
        else:
            audio_path = self.get_audio_path(entry_id)
            if audio_path is None:
                return None
            written = extract_cover_for(entry_dir, audio_path)
        if not written:
            return None
        return _cover_url_if_present(entry_dir, self.api_prefix, entry_id)

    def backfill_covers(
        self, *, overwrite: bool = False, limit: Optional[int] = None
    ) -> dict[str, int]:
        """Re-read embedded artwork for audio entries that predate cover art.

        Idempotent: entries that already have a cover are skipped unless
        ``overwrite``. Returns per-outcome counts so the caller can report
        what a maintenance pass actually did.
        """
        counts = {"scanned": 0, "written": 0, "skipped": 0, "no_cover": 0}
        for record in self.list_entries_fast(kinds={"audio"}):
            if limit is not None and counts["scanned"] >= limit:
                break
            entry_dir = self._dir_for(record.id)
            if entry_dir is None:
                continue
            counts["scanned"] += 1
            if not overwrite and (entry_dir / COVER_FILENAME).is_file():
                counts["skipped"] += 1
                continue
            audio_path = self.get_audio_path(record.id)
            if audio_path is None or not extract_cover_for(entry_dir, audio_path):
                counts["no_cover"] += 1
                continue
            counts["written"] += 1
        return counts

    # ---- DB sync / reindex --------------------------------------------------

    def _sync_record_to_db(
        self,
        record: LibraryRecord,
        meta: dict[str, Any],
    ) -> None:
        if self.db is None:
            return
        try:
            self.db.upsert_entry(_db_payload(record, meta))
        except Exception as e:
            log.warning("library.store: db upsert failed for %s: %s", record.id, e)

        # Chimera sources → directed lineage edges.
        for from_id, to_id, kind in _chimera_edges(record.id, meta):
            try:
                self.db.add_relation(from_id=from_id, to_id=to_id, kind=kind)
            except Exception as e:
                log.debug(
                    "library.store: relation insert failed for %s→%s: %s",
                    from_id,
                    to_id,
                    e,
                )

    def reindex(
        self,
        *,
        batch: int = 1000,
        enqueue_analysis: bool = False,
        max_enqueue: Optional[int] = MAX_REINDEX_ANALYSIS_ENQUEUE,
        report: Optional[dict[str, Any]] = None,
        progress: Optional[LibraryProgress] = None,
    ) -> int:
        """Walk the filesystem and upsert every entry into the DB.
        Returns the number of entries indexed. Idempotent.

        One ``metadata.json`` read per entry (the walk hands its parsed dict
        straight through) and one transaction per ``batch``. It used to read
        every file twice and commit once per entry, which on a 200,000-entry
        library is 400,000 reads and 200,000 fsyncs.

        ``enqueue_analysis`` defaults to ``False``: a bare ``reindex()`` call
        must never enqueue anything. A caller opts IN explicitly. When it is
        ``True``, new or changed entries (by
        :meth:`LibraryDB.new_or_changed_entry_ids`) are enqueued for
        background analysis the same way import does (LIB-002) -- still
        gated by the ``analysis.auto_on_import`` setting inside
        :func:`_maybe_enqueue_analysis`, so opting in is still a no-op unless
        the user also enabled that setting. An unchanged entry is never
        re-enqueued, so re-running reindex over a stable library queues
        nothing. Enqueuing happens only AFTER every batch has been upserted
        (not per-batch), so it can be capped atomically across the whole
        call.

        ``max_enqueue`` (default :data:`MAX_REINDEX_ANALYSIS_ENQUEUE`) caps
        how many new/changed entries may be enqueued in one call: if MORE
        than that many changed, NONE are enqueued -- a mass re-analysis is
        exactly what the "never mass re-analyze" rule forbids, so this fails
        closed rather than queueing a partial batch. Pass ``max_enqueue=None``
        to disable the cap entirely. Ids are stopped from accumulating in
        memory once the running total exceeds the cap (the outcome is
        already decided at that point), though the exact count is still
        tracked for the report.

        ``report``, when given, is filled in place with ``{'changed': int,
        'enqueued': int, 'analysis_skipped': int}`` -- ``enqueued`` counts
        only jobs :func:`_maybe_enqueue_analysis` actually handed to the
        background queue, not every id it was offered -- so a caller
        (``POST /api/library/reindex``) can report what happened without
        changing this method's ``int`` return value, which existing callers
        rely on.

        ``progress``, when given, gets the walk's ``read`` task (see
        :meth:`_iter_disk_entries`); the caller finishes it.
        """
        if self.db is None:
            return 0
        count = 0
        next_log = 5000
        payloads: list[dict[str, Any]] = []
        edges: list[tuple[str, str, str]] = []
        all_changed_ids: list[str] = []
        changed_count = 0

        def flush() -> None:
            nonlocal payloads, changed_count
            if not payloads:
                return
            if enqueue_analysis:
                batch_changed = self.db.new_or_changed_entry_ids(payloads)
                changed_count += len(batch_changed)
                if max_enqueue is None or changed_count <= max_enqueue:
                    all_changed_ids.extend(batch_changed)
                # else: already over the cap -- the whole run will be
                # skipped, so stop growing the list; changed_count keeps
                # counting for an accurate report.
            self.db.upsert_entries_bulk(payloads, batch=len(payloads))
            payloads = []

        for record, meta, _entry_dir in self._iter_disk_entries(progress=progress):
            payloads.append(_db_payload(record, meta))
            edges.extend(_chimera_edges(record.id, meta))
            count += 1
            if len(payloads) >= batch:
                flush()
            if count >= next_log:
                log.info("library.store: reindexed %d entries", count)
                next_log += 5000
        flush()
        self.db.add_relations_bulk(edges)

        enqueued = 0
        skipped = 0
        if enqueue_analysis and changed_count:
            if max_enqueue is not None and changed_count > max_enqueue:
                skipped = changed_count
            else:
                for entry_id in all_changed_ids:
                    if _maybe_enqueue_analysis(self, entry_id, source="import"):
                        enqueued += 1
        if report is not None:
            report["changed"] = changed_count
            report["enqueued"] = enqueued
            report["analysis_skipped"] = skipped
        return count

    def read_disk_into_db(self) -> int:
        """Read every ``metadata.json`` into the DB: what a first start, or a
        start beside a lost ``library.db``, needs before the list shows
        anything. Returns the number of entries read.

        :data:`~.db.DISK_READ_PENDING_KEY` is written before the walk and
        removed after its last batch, so a read cut short by a close, a crash
        or a kill runs again on the next start; every batch it did commit is
        kept and simply upserted again. Without the flag the next start saw a
        non-empty database and never read the rest.

        With no stored rows every entry looks "new", so this never enqueues
        analysis: that would queue the entire library the instant the app
        opens, not just what actually changed. A user wanting analysis on a
        manual reindex opts in via POST /reindex?analyze=true.
        """
        if self.db is None:
            return 0
        progress = self.db.progress
        self.db.set_flag(DISK_READ_PENDING_KEY, str(time.time()))
        try:
            count = self.reindex(enqueue_analysis=False, progress=progress)
        finally:
            progress.finish("read")
        self.db.set_flag(DISK_READ_PENDING_KEY, None)
        log.info("library.store: read %d entries from disk into the database", count)
        return count

    # ---- Helpers ------------------------------------------------------------

    def _dir_for(self, entry_id: str) -> Optional[Path]:
        # Direct (import or single-level generate) layout.
        direct = self.root / entry_id
        if _is_entry_dir(direct):
            return direct
        # Nested generate layout: "<job_id>_<index>" maps to "<job_id>/<index>".
        if "_" in entry_id:
            job_id, _, index = entry_id.rpartition("_")
            nested = self.root / job_id / index
            if _is_entry_dir(nested):
                return nested
        return None

    def all_ids(self) -> Iterable[str]:
        for record in self.list_entries():
            yield record.id


def _maybe_enqueue_analysis(
    store: "LibraryStore",
    entry_id: str,
    *,
    source: str,
) -> bool:
    """If feature settings have ``analysis.auto_on_<source>`` enabled,
    queue a background analysis job. Failures here never block the
    import / generate flow — analysis is opt-in enrichment.

    ``source`` is either ``"import"`` or ``"generate"``. Returns ``True``
    only when a job was actually handed to the background queue -- callers
    that report a count (e.g. ``reindex()``'s ``analysis_enqueued``) must
    count real enqueues, not attempts skipped by the settings gate, a
    missing audio file, or a queue failure.
    """
    db = store.db
    if db is None:
        return False
    try:
        from backend.core.background_workers import get_background_queue
        from backend.modules.settings.router import get_store as get_settings_store
    except ImportError:
        return False

    try:
        settings = get_settings_store().get_section("analysis")
    except Exception:
        return False

    key = f"auto_on_{source}"
    if not settings.get(key, False):
        return False

    audio_path = store.get_audio_path(entry_id)
    if audio_path is None:
        return False
    entry_dir = store._dir_for(entry_id)
    metadata_path = (entry_dir / "metadata.json") if entry_dir else None

    async def _run() -> None:
        import asyncio

        from backend.modules.analysis.engine import analyze_and_persist

        # The job waits for an idle moment, and the library can be closed or
        # replaced meanwhile (a library folder change, a retried open). Its
        # entry belongs to the database it was queued for; that one is gone.
        if db.closed:
            log.info(
                "library.store: analysis for %s skipped: its library was closed",
                entry_id,
            )
            return

        # Off the loop, like every other job here. The queue's consumer awaits
        # job.fn directly, so a coroutine that does its CPU work inline stalls
        # the whole event loop — not just analysis, every request behind it.
        # analyze_and_persist runs librosa.pyin, whose numba Viterbi pass holds
        # the GIL for its entire run: 6-18 s per track, and every row re-runs
        # when ANALYSIS_VERSION changes.
        await asyncio.to_thread(
            analyze_and_persist,
            db,
            entry_id,
            audio_path,
            metadata_path=metadata_path,
            settings=settings,
            # The store whose metadata lock must serialise this write. Passed
            # explicitly: this is the main background writer, and the engine's
            # router-singleton fallback is for scripts, not for this path.
            store=store,
        )

    try:
        get_background_queue().enqueue(f"analysis:{entry_id}", _run)
    except Exception as e:
        log.debug("library.store: failed to enqueue analysis for %s: %s", entry_id, e)
        return False
    return True


def _maybe_enqueue_stems(
    store: "LibraryStore",
    entry_id: str,
    *,
    source: str,
    force: bool = False,
) -> None:
    """If feature settings have ``stems.auto_on_<source>`` enabled, queue
    a background stem-separation job. Heavy work — relies on the
    integration-package sidecar. ``force`` bypasses the settings gate (used
    when favoriting a track), but the job is still skipped when the entry
    already has stems."""
    if store.db is None:
        return
    try:
        from backend.core.background_workers import get_background_queue
        from backend.modules.settings.router import get_store as get_settings_store
    except ImportError:
        return

    try:
        settings = get_settings_store().get_section("stems")
    except Exception:
        settings = {}

    key = f"auto_on_{source}"
    if not force and not settings.get(key, False):
        return

    # Idempotent: never re-separate an entry that already has stems.
    try:
        if store.db.list_stems(entry_id):
            return
    except Exception:
        pass

    audio_path = store.get_audio_path(entry_id)
    entry_dir = store._dir_for(entry_id)
    if audio_path is None or entry_dir is None:
        return

    stem_count = int(settings.get("default_count") or 4)

    async def _run() -> None:
        from backend.core import pipeline

        # Device and quality come from the settings inside; a separation the
        # user started meanwhile (SING's ALIGN, a manual run) is joined.
        await pipeline.ensure_stems(entry_id, stems=stem_count)

    try:
        get_background_queue().enqueue(f"stems:{entry_id}", _run)
    except Exception as e:
        log.debug("library.store: failed to enqueue stems for %s: %s", entry_id, e)


def _maybe_enqueue_shards(
    store: "LibraryStore",
    entry_id: str,
    *,
    source: str,
    force: bool = False,
) -> None:
    """If ``shards.auto_on_<source>`` is on, queue the Shard Index cut for the
    entry (docs/design/loom.md). Last in the chain so it sees stems when the
    user has those on too; otherwise it shards the mix and is re-cut later."""
    if store.db is None:
        return
    try:
        from backend.core.background_workers import get_background_queue
        from backend.modules.settings.router import get_store as get_settings_store
    except ImportError:
        return
    try:
        settings = get_settings_store().get_section("shards")
    except Exception:
        settings = {}
    if not force and not settings.get(f"auto_on_{source}", False):
        return
    try:
        if store.db.list_shards(entry_id):
            return
    except Exception:
        pass

    async def _run() -> None:
        from backend.core import pipeline

        await pipeline.ensure_shards(entry_id)

    try:
        get_background_queue().enqueue(f"shards:{entry_id}", _run)
    except Exception as e:
        log.debug("library.store: failed to enqueue shards for %s: %s", entry_id, e)


def _maybe_enqueue_midi(
    store: "LibraryStore",
    entry_id: str,
    *,
    source: str,
    force: bool = False,
) -> None:
    """If feature settings have ``midi.auto_on_<source>`` enabled, queue
    a background MIDI-conversion job. Reads ``midi.from_stems`` to
    decide whether to also convert each stem. ``force`` bypasses the settings
    gate (used when favoriting), but the job is still skipped when the entry
    already has MIDI."""
    if store.db is None:
        return
    try:
        from backend.core.background_workers import get_background_queue
        from backend.modules.settings.router import get_store as get_settings_store
    except ImportError:
        return

    try:
        settings = get_settings_store().get_section("midi")
    except Exception:
        settings = {}

    key = f"auto_on_{source}"
    if not force and not settings.get(key, False):
        return

    # Idempotent: never re-transcribe an entry that already has MIDI.
    try:
        if store.db.list_midis(entry_id):
            return
    except Exception:
        pass

    audio_path = store.get_audio_path(entry_id)
    entry_dir = store._dir_for(entry_id)
    if audio_path is None or entry_dir is None:
        return

    from_stems_flag = bool(settings.get("from_stems", True))

    async def _run() -> None:
        from backend.core import pipeline

        # Off the event loop (the coordinator threads it), on the GPU lane,
        # after any stem separation in flight, and never twice for one entry.
        await pipeline.ensure_midi(entry_id, from_stems=from_stems_flag)

    try:
        get_background_queue().enqueue(f"midi:{entry_id}", _run)
    except Exception as e:
        log.debug("library.store: failed to enqueue midi for %s: %s", entry_id, e)


def _maybe_enqueue_lyrics(
    store: "LibraryStore",
    entry_id: str,
    *,
    source: str,
    force: bool = False,
) -> None:
    """If ``lyrics.auto_on_<source>`` is on and the entry has lyric text
    (a Suno import, an embedded tag, the notes), queue an ALIGN so the song
    is ready to sing along to without a click: whisper times the user's own
    words against the vocal stem. With ``lyrics.auto_transcribe`` on, an
    entry with no text is transcribed instead. Skipped when a timed
    document exists, or whisper is not installed. ``force`` bypasses the
    settings gate (favoriting)."""
    if store.db is None:
        return
    try:
        from backend.core.background_workers import get_background_queue
        from backend.modules.settings.router import get_store as get_settings_store
    except ImportError:
        return
    try:
        settings = get_settings_store().get_section("lyrics")
    except Exception:
        settings = {}
    if not force and not settings.get(f"auto_on_{source}", False):
        return
    record = store.get_entry(entry_id)
    has_text = bool(str(getattr(record, "lyrics", "") or "").strip())
    if not has_text and not settings.get("auto_transcribe", False):
        return

    async def _run() -> None:
        from backend.core import pipeline

        await pipeline.ensure_lyrics(entry_id)

    try:
        get_background_queue().enqueue(f"lyrics:{entry_id}", _run)
    except Exception as e:
        log.debug("library.store: failed to enqueue lyrics for %s: %s", entry_id, e)


def _generate_score_for_entry(
    store: "LibraryStore", entry_id: str, entry_dir: Path
) -> None:
    """Generate a MusicXML sheet from the entry's first MIDI, stamped with the
    song title. No-op if the entry already has a sheet or has no MIDI. Runs in
    a worker thread (music21 parse is CPU-bound)."""
    if store.db is None:
        return
    try:
        from backend.modules.notation.engine import (
            midi_to_musicxml,
            register_existing_midis,
        )
    except Exception:
        return
    try:
        register_existing_midis(store.db, entry_id)
        if store.db.list_notation_artifacts(entry_id, kind="musicxml"):
            return  # already scored
        target = None
        for midi in store.db.list_midis(entry_id):
            path = midi.get("midi_path") or ""
            if path and Path(path).is_file():
                target = midi
                break
        if target is None:
            return  # nothing to score
        record = store.get_entry(entry_id)
        title = str(getattr(record, "title", "") or "")
        midi_id = str(target.get("id") or "")
        output = entry_dir / "notation" / f"{midi_id}.musicxml"
        midi_to_musicxml(
            store.db,
            entry_id=entry_id,
            midi_path=Path(target["midi_path"]),
            output_path=output,
            source_ref=midi_id,
            artifact_id=f"{midi_id}__musicxml",
            title=title,
        )
    except Exception as e:  # noqa: BLE001 - best-effort background work
        log.debug("library.store: auto-score failed for %s: %s", entry_id, e)


def _maybe_enqueue_score(
    store: "LibraryStore",
    entry_id: str,
    *,
    source: str,
    force: bool = False,
) -> None:
    """Queue a background job that turns the entry's MIDI into a titled sheet.
    Auto-score defaults ON (sheets are cheap music21 work and the job only acts
    when a MIDI already exists and no sheet does). ``force`` bypasses the
    settings gate (used when favoriting). Enqueued AFTER any MIDI job so the
    serial idle queue runs MIDI first, then this finds its output."""
    if store.db is None:
        return
    try:
        from backend.core.background_workers import get_background_queue
        from backend.modules.settings.router import get_store as get_settings_store
    except ImportError:
        return

    if not force:
        try:
            settings = get_settings_store().get_section("notation")
        except Exception:
            settings = {}
        if not settings.get(f"auto_on_{source}", True):
            return

    entry_dir = store._dir_for(entry_id)
    if entry_dir is None:
        return

    async def _run() -> None:
        import asyncio

        await asyncio.to_thread(_generate_score_for_entry, store, entry_id, entry_dir)

    try:
        get_background_queue().enqueue(f"score:{entry_id}", _run)
    except Exception as e:
        log.debug("library.store: failed to enqueue score for %s: %s", entry_id, e)
