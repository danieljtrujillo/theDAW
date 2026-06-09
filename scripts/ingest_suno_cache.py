"""Ingest songs from a SunoHarvester API-compatible cache into the DAW library.

Reads the cache JSON, deduplicates by title (keeps the most recent),
selects the N most recent entries, and writes metadata.json directories
into the library root so the library store picks them up on reindex.

No audio is downloaded — each entry stores a cdn_audio_url that the
library audio endpoint proxies on first play.

Usage:
    python scripts/ingest_suno_cache.py [--cache PATH] [--limit N]
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

# CHANGED: new script — bulk-imports Suno cache entries as CDN-backed
# library entries (no audio download, proxied on demand).

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

log = logging.getLogger(__name__)

DEFAULT_CACHE = (
    Path(os.environ.get("SUNO_CACHE_PATH", ""))
    or Path.home()
    / "Documents"
    / "GitHub"
    / "SunoHarvester"
    / "cache"
    / "main"
    / "library_cache_API_COMPATIBLE.json"
)


def load_cache(path: Path) -> list[dict]:
    # CHANGED: stream-parse with ijson to avoid MemoryError on 150k+ entry files.
    try:
        import ijson
    except ImportError:
        # Fallback: parse with json in chunks won't work — install ijson.
        import subprocess

        subprocess.check_call([sys.executable, "-m", "pip", "install", "ijson"])
        import ijson

    songs = []
    with open(path, "r", encoding="utf-8") as f:
        for song in ijson.items(f, "songs.item"):
            songs.append(song)
    return songs


def dedupe_by_title(songs: list[dict], limit: int) -> list[dict]:
    """Sort by created_at desc, keep first occurrence of each title."""
    songs_sorted = sorted(
        songs,
        key=lambda s: s.get("created_at") or "",
        reverse=True,
    )
    seen_titles: set[str] = set()
    result: list[dict] = []
    for s in songs_sorted:
        title = (s.get("title") or "").strip().lower()
        if not title:
            continue
        if s.get("status") != "complete":
            continue
        if not s.get("audio_url"):
            continue
        if title in seen_titles:
            continue
        seen_titles.add(title)
        result.append(s)
        if len(result) >= limit:
            break
    return result


def ingest(songs: list[dict], library_root: Path) -> int:
    """Write metadata.json for each song into library_root/<id>/."""
    count = 0
    for song in songs:
        song_id = song.get("id")
        if not song_id:
            continue

        entry_dir = library_root / song_id
        meta_path = entry_dir / "metadata.json"
        if meta_path.exists():
            continue

        entry_dir.mkdir(parents=True, exist_ok=True)

        meta_block = song.get("metadata") or {}
        inferred = song.get("inferred") or {}
        style = meta_block.get("style") or ""
        lyrics = meta_block.get("lyrics") or ""
        prompt = meta_block.get("description") or style

        tags = ["suno", f"sunoid:{song_id}"]
        genre = inferred.get("genre")
        if genre:
            tags.append(genre)
        mood = inferred.get("mood")
        if mood:
            tags.append(mood)
        for st in inferred.get("style_tags") or []:
            if st and st not in tags:
                tags.append(st)

        meta = {
            "id": song_id,
            "title": song.get("title") or f"suno_{song_id[:8]}",
            "prompt": prompt,
            "negative_prompt": "",
            "model": "suno",
            "duration": 0.0,
            "steps": 0,
            "cfg": 0.0,
            "seed": 0,
            "mime_type": "audio/mpeg",
            "audio_filename": f"{song_id}.mp3",
            "favorite": False,
            "rating": None,
            "tags": tags,
            "notes": "",
            "source": "import",
            "timestamp": song.get("created_at") or "",
            "created_at": song.get("created_at") or "",
            "cdn_audio_url": song.get("audio_url") or "",
            "lyrics": lyrics,
            "style": style,
            "inferred": inferred,
            "metadata": meta_block,
        }

        meta_path.write_text(
            json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        count += 1

    return count


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Ingest SunoHarvester cache into DAW library"
    )
    parser.add_argument(
        "--cache", type=Path, default=DEFAULT_CACHE, help="Path to cache JSON"
    )
    parser.add_argument("--limit", type=int, default=5000, help="Max entries to import")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if not args.cache.is_file():
        log.error("Cache file not found: %s", args.cache)
        sys.exit(1)

    log.info("Loading cache from %s ...", args.cache)
    songs = load_cache(args.cache)
    log.info("Loaded %d total songs", len(songs))

    selected = dedupe_by_title(songs, args.limit)
    log.info("Selected %d songs (deduped by title, most recent first)", len(selected))

    from backend.modules.library.store import default_library_root

    library_root = default_library_root(PROJECT_ROOT)
    log.info("Library root: %s", library_root)

    count = ingest(selected, library_root)
    log.info(
        "Wrote %d new metadata entries (skipped %d already-existing)",
        count,
        len(selected) - count,
    )

    # Trigger DB reindex so they show up immediately.
    from backend.modules.library.store import LibraryStore

    store = LibraryStore(library_root)
    indexed = store.reindex()
    log.info("Reindexed %d total library entries", indexed)


if __name__ == "__main__":
    main()
