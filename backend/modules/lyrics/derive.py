"""Untimed lyrics derived from what the library already knows about a song.

Server twin of the frontend's ``deriveLyrics`` ordering: the entry's own
``lyrics`` field first (Suno imports land there through the metadata
flatten), then the analyzer's embedded tags, then ``lyrics:`` tags. Notes are
NEVER used automatically; they are only offered back as a candidate.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from .schema import LyricsDoc, join_lines, split_text

log = logging.getLogger(__name__)

_TAG_PREFIXES = ("lyrics:", "lyric:")


def _embedded_lyrics(store: Any, entry_id: str) -> str:
    db = getattr(store, "db", None)
    if db is None or not hasattr(db, "get_analysis"):
        return ""
    try:
        row = db.get_analysis(entry_id)
    except Exception as e:  # noqa: BLE001 - derivation is best effort
        log.info("lyrics: analysis read failed for %s: %s", entry_id, e)
        return ""
    if not row:
        return ""
    raw = row.get("embedded_tags_json")
    if not raw:
        return ""
    try:
        tags = json.loads(raw)
    except (TypeError, ValueError):
        return ""
    if not isinstance(tags, dict):
        return ""
    value = tags.get("lyrics") or tags.get("lyric")
    return value if isinstance(value, str) else ""


def _tag_lyrics(tags: list[str]) -> str:
    found: list[str] = []
    for tag in tags or []:
        low = str(tag).lower()
        for prefix in _TAG_PREFIXES:
            if low.startswith(prefix):
                found.append(str(tag)[len(prefix) :].strip())
                break
    return "\n".join(v for v in found if v)


def derive_untimed_doc(store: Any, entry_id: str) -> tuple[LyricsDoc, Optional[str]]:
    """``(doc, notes_candidate)``. Raises KeyError for an unknown entry."""
    record = store.get_entry(entry_id)
    if record is None:
        raise KeyError(entry_id)
    text = ""
    source = ""
    plain = str(getattr(record, "lyrics", "") or "")
    if plain.strip():
        text = plain
        source = "suno" if getattr(record, "model", "") == "suno" else "manual"
    if not text:
        embedded = _embedded_lyrics(store, entry_id)
        if embedded.strip():
            text, source = embedded, "embedded"
    if not text:
        tagged = _tag_lyrics(list(getattr(record, "tags", []) or []))
        if tagged.strip():
            text, source = tagged, "tags"
    lines = split_text(text)
    doc = LyricsDoc(
        entry_id=entry_id,
        source=source,
        text=join_lines(lines),
        lines=lines,
    )
    notes_candidate: Optional[str] = None
    if not doc.text.strip():
        notes = str(getattr(record, "notes", "") or "")
        if sum(1 for ln in notes.splitlines() if ln.strip()) >= 3:
            notes_candidate = notes
    return doc, notes_candidate
