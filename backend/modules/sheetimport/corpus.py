"""Search and open the score corpus that ships inside music21.

music21's core corpus holds Bach chorales, Palestrina, Monteverdi, Classical
string quartets, folk-tune books and more, all public domain. Its metadata
bundle (``music21.corpus.corpora.CoreCorpus().metadataBundle``) lists every
piece with its composer, title, movement and part count; reading it from disk
takes a few seconds, so it is read once per process (:func:`core_bundle`) and
a search answer is kept per query (:func:`search`).

A piece is named by its corpus path id (``MetadataEntry.corpusPath``, e.g.
``bach_bwv66_6_mxl``, or ``airdsAirs_book4_abc_706`` for one tune of an ABC
book). :func:`open_piece` parses it and hands back the original file's bytes
when the piece is a whole file of a type the score import keeps.
"""

from __future__ import annotations

import logging
import threading
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)

#: The most results one search returns.
MAX_RESULTS = 200
#: The shortest query that is searched; one letter matches most of the corpus.
MIN_QUERY_CHARS = 2

_BUNDLE_LOCK = threading.Lock()


@lru_cache(maxsize=1)
def _load_core_bundle() -> Any:
    from music21.corpus import corpora

    bundle = corpora.CoreCorpus().metadataBundle
    log.info(
        "sheetimport: music21 core corpus metadata loaded (%d pieces)", len(bundle)
    )
    return bundle


def core_bundle() -> Any:
    """The core corpus metadata bundle, read from disk on the first call only.

    The lock keeps two first requests from both paying the multi-second read.
    """
    with _BUNDLE_LOCK:
        return _load_core_bundle()


@lru_cache(maxsize=1)
def _entries_by_id() -> dict[str, Any]:
    return {str(entry.corpusPath): entry for entry in core_bundle()}


def _text(value: Any) -> str:
    return str(value or "").strip()


def describe(entry: Any) -> dict[str, Any]:
    """One corpus piece as the search answer lists it."""
    md = entry.metadata
    source = Path(str(entry.sourcePath))
    movement = _text(getattr(md, "movementName", None)) if md is not None else ""
    number = _text(getattr(md, "movementNumber", None)) if md is not None else ""
    title = _text(getattr(md, "title", None)) if md is not None else ""
    if not title:
        # Many corpus files carry no title; the movement name (often the file
        # name) is what names them.
        title = movement or source.stem
        movement = ""
    parts = getattr(md, "numberOfParts", None) if md is not None else None
    return {
        "id": str(entry.corpusPath),
        "composer": _text(getattr(md, "composer", None)) if md is not None else "",
        "title": title,
        "movement": movement or number,
        "parts": int(parts) if isinstance(parts, int) else None,
        "path": source.as_posix(),
        "number": entry.number,
        "format": source.suffix.lower().lstrip("."),
    }


@lru_cache(maxsize=128)
def _search_ids(query: str) -> tuple[str, ...]:
    bundle = core_bundle()
    return tuple(str(entry.corpusPath) for entry in bundle.search(query))


def search(query: str, limit: int = 50) -> dict[str, Any]:
    """Pieces whose metadata or path matches ``query`` (case-insensitive,
    every field), composers first, at most ``limit`` of them.

    Returns ``{"query", "total", "results"}``; a query shorter than
    :data:`MIN_QUERY_CHARS` answers no results.
    """
    q = " ".join(str(query or "").split()).lower()
    limit = max(1, min(int(limit), MAX_RESULTS))
    if len(q) < MIN_QUERY_CHARS:
        return {"query": q, "total": 0, "results": []}
    ids = _search_ids(q)
    by_id = _entries_by_id()
    rows = [describe(by_id[i]) for i in ids if i in by_id]
    # A named composer first, then by composer, title and movement, so the
    # list reads as a catalogue rather than in bundle order.
    rows.sort(
        key=lambda r: (
            not r["composer"],
            r["composer"].lower(),
            r["title"].lower(),
            r["movement"].lower(),
        )
    )
    return {"query": q, "total": len(rows), "results": rows[:limit]}


def resolve(piece_id: str) -> Optional[Any]:
    """The bundle entry for a corpus path id, or None."""
    return _entries_by_id().get(str(piece_id or "").strip())


def source_file(entry: Any) -> Path:
    """The absolute path of a corpus entry's file."""
    from music21 import common

    source = Path(str(entry.sourcePath))
    return source if source.is_absolute() else Path(common.getCorpusFilePath()) / source


def open_piece(
    piece_id: str, keep_suffixes: tuple[str, ...]
) -> tuple[Any, dict[str, Any], Optional[tuple[bytes, str]]]:
    """Parse one corpus piece.

    Returns ``(score, description, original)``. ``original`` is the file's
    ``(bytes, suffix)`` when the piece is the whole file and its suffix is in
    ``keep_suffixes``; None for a tune cut from a multi-tune book, or a file
    type the import does not keep. Raises ``KeyError`` for an unknown id.
    """
    entry = resolve(piece_id)
    if entry is None:
        raise KeyError(piece_id)
    score = entry.parse()
    path = source_file(entry)
    original: Optional[tuple[bytes, str]] = None
    suffix = path.suffix.lower()
    if entry.number is None and suffix in keep_suffixes and path.is_file():
        original = (path.read_bytes(), suffix)
    return score, describe(entry), original
