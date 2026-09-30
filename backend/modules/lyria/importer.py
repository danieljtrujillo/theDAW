"""INT-002 -- bring the embedded Lyria sidecar's generations into the library.

The Lyria module is spawn-and-iframe: the child app keeps its OWN library under
its own ``generations/`` folder, so a track generated in the panel was invisible
to theDAW's catalog, lineage, EDIT, stems and export. Suno does the opposite --
``backend/modules/suno/router.py`` downloads a finished clip and registers it
through ``library.store.import_blob`` -- and this module is the same move for
Lyria, with one difference: nothing here talks to a paid provider or to any host
but the sidecar's own loopback origin.

The flow, per :func:`sync_generations`:

  1. Nothing is listening on the sidecar's port, or what listens there does
     not answer as Lyria (``sidecar._is_lyria_server``) -> no-op, with a
     reason. The sidecar is started by the panel, never by a sync.
  2. ``GET http://127.0.0.1:<port>/api/generations`` -- the unmodified app's
     own listing, newest first.
  3. Ids already in the seen map (``data/lyria_imports.json``, a
     ``{lyria_id: library_entry_id}`` dict) are skipped, so a sync run every
     30 s by the panel imports each track exactly once.
  4. ``provider == "mock"`` entries are locally synthesized test audio and are
     skipped unless the caller explicitly asks for them. The sidecar defaults
     to mock (see ``sidecar.is_mock``), so importing them by default would fill
     a user's library with sine waves.
  5. The audio is downloaded from the SIDECAR'S OWN ORIGIN ONLY. ``audioUrl``
     comes off the wire, so it is resolved against that origin and then
     re-checked: a scheme, host or port that is not the loopback sidecar is
     refused rather than fetched. theDAW's own backend is on loopback too, so
     the port is part of the check and not just the host.
  6. ``import_blob`` does blocking disk I/O (it writes the audio, reads the
     file's embedded tags, extracts cover art and syncs a DB row), so it runs
     through ``asyncio.to_thread`` and never on the event loop.
  7. The mapping is written atomically (temp sibling + ``os.replace``, via
     ``backend.lib.atomic``) after EVERY import, so a crash mid-run cannot
     re-import the tracks that already landed.

One ``asyncio.Lock`` serializes the whole sync. Syncs are user-triggered (a
button) or a 30 s panel timer, never hot, so holding it across the network
waits costs nothing and is the only way two concurrent callers cannot both pass
the seen-map check for the same id and import it twice.

The tags every imported entry carries -- ``lyria``, ``lyriaid:<id>``,
``lyria-provider:<gemini|openrouter|mock>`` -- are what
``library.provider._legacy_lyria`` reads to badge the track "Lyria 3 Pro", and
what a future lineage edge would resolve a parent by (the ``sunoid:`` pattern).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urljoin, urlparse

import httpx

from backend.lib import paths
from backend.lib.atomic import atomic_write

from . import sidecar

log = logging.getLogger(__name__)

#: Serializes the whole sync. See the module docstring.
_sync_lock = asyncio.Lock()

#: Test/verification override for the seen map's location, so a run can keep
#: its bookkeeping out of theDAW's real ``data/`` tree.
SEEN_MAP_ENV = "theDAW_LYRIA_IMPORTS_FILE"

#: The only hosts an ``audioUrl`` may resolve to. The port is checked too --
#: theDAW's own backend answers on loopback.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})

#: The two formats the sidecar produces, and the mime each is imported under.
MIME_BY_FORMAT: dict[str, str] = {"mp3": "audio/mpeg", "wav": "audio/wav"}

#: Listing is a small JSON body; a download is a whole song.
LIST_TIMEOUT_SEC = 30.0
DOWNLOAD_TIMEOUT_SEC = 120.0

#: What a filename may keep. Everything else collapses to '_'.
_UNSAFE_NAME = re.compile(r"[^A-Za-z0-9 ._-]+")
_RUNS_OF_SPACE = re.compile(r"\s+")


# ---------------------------------------------------------------------------
# The seen map: {lyria_id: library_entry_id}
# ---------------------------------------------------------------------------


def seen_map_path() -> Path:
    """Where the ``{lyria_id: library_entry_id}`` map lives.

    ``theDAW_LYRIA_IMPORTS_FILE`` wins so a test or a live smoke-check can
    point it at a temp file; otherwise it follows the writable data root like
    every other registry (never the project root's data folder directly -- see
    ``backend/lib/paths.py``).
    """
    configured = os.getenv(SEEN_MAP_ENV)
    if configured:
        return Path(configured).expanduser().resolve()
    return paths.data_path("lyria_imports.json")


def load_seen_map() -> dict[str, str]:
    """The persisted map, or ``{}`` when it is missing or unreadable.

    A hand-edited or truncated file must never stop a sync -- the worst case
    of reading it as empty is that a track is imported a second time, which is
    strictly better than the panel's sync button raising forever.
    """
    path = seen_map_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception as exc:  # a bad file is an empty map
        log.warning("lyria.importer: unreadable seen map %s: %s", path, exc)
        return {}
    if not isinstance(raw, dict):
        return {}
    return {str(k): str(v) for k, v in raw.items() if k and v}


def save_seen_map(seen: dict[str, str]) -> None:
    """Persist the map so a reader sees the old file or the new one."""
    atomic_write(
        seen_map_path(), json.dumps(seen, indent=2, sort_keys=True), encoding="utf-8"
    )


def imports_summary() -> dict[str, Any]:
    """The seen map's COUNTS and ids -- what ``GET /api/lyria/imports`` returns.

    Never audio and never a prompt: this answers "how much of the sidecar's
    library is already in theDAW's", nothing more.
    """
    seen = load_seen_map()
    return {
        "count": len(seen),
        "lyria_ids": sorted(seen),
        "entry_ids": sorted({str(v) for v in seen.values()}),
    }


# ---------------------------------------------------------------------------
# Shaping one generation into an import
# ---------------------------------------------------------------------------


def _text(value: Any) -> str:
    return str(value).strip() if isinstance(value, (str, int, float)) else ""


def safe_stem(value: str, fallback: str) -> str:
    """``value`` as a filename stem: no separators, no control characters.

    ``import_blob`` truncates the stem to 80 characters itself; doing it here
    too keeps the name we hand it and the name it writes the same string.
    """
    cleaned = _UNSAFE_NAME.sub("_", value or "")
    cleaned = _RUNS_OF_SPACE.sub(" ", cleaned).strip(" ._-")[:80].strip(" ._-")
    return cleaned or fallback


def analysis_notes(analysis: Any) -> str:
    """The sidecar's own analysis as one line: "Genre / mood / BPM / key".

    Only the parts that are actually there, so a generation with no analysis
    block gets '' and the entry's notes stay empty rather than reading " /  / ".
    """
    if not isinstance(analysis, dict):
        return ""
    parts: list[str] = []
    for key in ("genre", "mood"):
        value = _text(analysis.get(key))
        if value:
            parts.append(value)
    bpm = analysis.get("bpm")
    if isinstance(bpm, (int, float)) and not isinstance(bpm, bool):
        # A numeric 0 means "not detected", never "zero beats a minute" -- and
        # it must not fall through to the string branch, which would read it
        # as the text "0" and write "0 BPM" into the entry's notes.
        if bpm > 0:
            parts.append(f"{int(round(bpm))} BPM")
    elif _text(bpm):
        parts.append(f"{_text(bpm)} BPM")
    musical_key = _text(analysis.get("key"))
    if musical_key:
        parts.append(musical_key)
    return " / ".join(parts)


def _format_of(item: dict[str, Any], audio_url: str) -> str:
    """ "mp3" or "wav" -- the declared format, else the url's suffix, else wav."""
    declared = _text(item.get("format")).lower()
    if declared in MIME_BY_FORMAT:
        return declared
    suffix = Path(urlparse(audio_url).path).suffix.lstrip(".").lower()
    return suffix if suffix in MIME_BY_FORMAT else "wav"


def resolve_audio_url(raw: Any, origin: str, port: int) -> Optional[str]:
    """The absolute URL to download from, or None when it is not the sidecar's.

    ``audioUrl`` is a relative ``/generations/<id>.<ext>`` in every response the
    unmodified app produces, but it arrives over HTTP and is therefore untrusted
    input: an absolute url (or a protocol-relative ``//host/...``, which
    ``urljoin`` promotes to one) would otherwise make this function a
    server-side request forgery primitive. theDAW's own backend listens on
    loopback as well, so the PORT is part of the answer and not just the host.
    """
    value = _text(raw)
    if not value:
        return None
    absolute = urljoin(origin, value)
    parsed = urlparse(absolute)
    if parsed.scheme not in ("http", "https"):
        return None
    if (parsed.hostname or "").lower() not in _LOOPBACK_HOSTS:
        return None
    if (parsed.port or (443 if parsed.scheme == "https" else 80)) != port:
        return None
    return absolute


def build_metadata(item: dict[str, Any], gen_id: str) -> dict[str, Any]:
    """The ``import_blob`` metadata for one generation.

    ``source`` is 'generate' because that is what it was -- a model made this
    audio, it was not dragged in -- and ``model`` is the bare "lyria" that
    ``db.infer_provider`` and ``provider._legacy_lyria`` both read.
    """
    analysis = item.get("analysis")
    analysis = analysis if isinstance(analysis, dict) else {}
    title = (
        _text(item.get("title"))
        or _text(analysis.get("title"))
        or f"lyria_{gen_id[:8]}"
    )
    duration = item.get("durationSeconds")
    provider = _text(item.get("provider")).lower() or "unknown"
    return {
        "title": title,
        "prompt": _text(item.get("prompt")),
        "lyrics": _text(item.get("lyrics")),
        "model": "lyria",
        "duration": (
            float(duration)
            if isinstance(duration, (int, float)) and not isinstance(duration, bool)
            else 0.0
        ),
        "source": "generate",
        "tags": ["lyria", f"lyriaid:{gen_id}", f"lyria-provider:{provider}"],
        "notes": analysis_notes(analysis),
    }


def _import_blob_sync(
    audio_bytes: bytes, filename: str, mime_type: str, metadata: dict[str, Any]
) -> str:
    """``import_blob`` through the library module's own store singleton.

    Imported inside the call, exactly as ``suno/router.py`` does it: the lyria
    module must not import the library module at module scope, and the store is
    built lazily by ``library.router.get_store``.
    """
    from backend.modules.library.router import get_store

    return get_store().import_blob(audio_bytes, filename, mime_type, metadata).id


# ---------------------------------------------------------------------------
# The sync
# ---------------------------------------------------------------------------


async def sync_generations(include_mock: bool = False) -> dict[str, Any]:
    """Import every sidecar generation theDAW's library does not have yet.

    Returns ``{"imported": [library_entry_id, ...], "skipped": n}`` and, when
    nothing could be done at all, a ``"reason"``. Idempotent: a second call
    with no new generations imports nothing.

    ``include_mock`` opts in to ``provider == "mock"`` entries -- locally
    synthesized test audio the sidecar produces in its default cost-safe mode.
    The panel's automatic syncs never pass it.
    """
    cfg = sidecar.resolve_config()
    port = cfg.port
    # A blocking socket connect (0.4 s timeout) -- off the event loop, like
    # every other sidecar call reached from a route.
    listening = await asyncio.to_thread(sidecar._port_is_listening, port)
    if not listening:
        return {"imported": [], "skipped": 0, "reason": "sidecar not running"}
    # An open port is not proof it is Lyria: another program on the port would
    # be asked for /api/generations every 30 s. The same identity check probe()
    # and ensure_running() use (a blocking HTTP call, so off the loop too).
    if not await asyncio.to_thread(sidecar._is_lyria_server, port):
        return {
            "imported": [],
            "skipped": 0,
            "reason": f"port {port} is held by a program that is not Lyria",
        }

    origin = f"http://127.0.0.1:{port}"
    async with _sync_lock:
        return await _sync_locked(origin, port, include_mock)


async def _sync_locked(origin: str, port: int, include_mock: bool) -> dict[str, Any]:
    """The body of :func:`sync_generations`, under ``_sync_lock``.

    The seen map is re-read HERE rather than by the caller: a second sync that
    queued on the lock must see everything the first one just imported, or the
    two would both import the same ids.
    """
    seen = load_seen_map()
    imported: list[str] = []
    skipped = 0

    async with httpx.AsyncClient(
        timeout=LIST_TIMEOUT_SEC,
        # Our own loopback child is never reached through a proxy -- the same
        # reason sidecar._is_lyria_server bypasses the system proxy settings.
        trust_env=False,
        follow_redirects=False,
    ) as client:
        try:
            resp = await client.get(f"{origin}/api/generations")
            resp.raise_for_status()
            payload = resp.json()
        except Exception as exc:  # a sync never raises at a route
            log.warning("lyria.importer: could not list generations: %s", exc)
            return {"imported": [], "skipped": 0, "reason": f"listing failed: {exc}"}

        generations = payload.get("generations") if isinstance(payload, dict) else None
        if not isinstance(generations, list):
            return {
                "imported": [],
                "skipped": 0,
                "reason": "sidecar returned no generations list",
            }

        for item in generations:
            if not isinstance(item, dict):
                skipped += 1
                continue
            gen_id = _text(item.get("id"))
            if not gen_id or gen_id in seen:
                skipped += 1
                continue
            if _text(item.get("provider")).lower() == "mock" and not include_mock:
                skipped += 1
                continue

            audio_url = resolve_audio_url(item.get("audioUrl"), origin, port)
            if audio_url is None:
                log.warning(
                    "lyria.importer: refusing %s -- audioUrl is not the sidecar's "
                    "own loopback origin",
                    gen_id,
                )
                skipped += 1
                continue

            try:
                audio = await client.get(audio_url, timeout=DOWNLOAD_TIMEOUT_SEC)
                audio.raise_for_status()
                audio_bytes = audio.content
            except Exception as exc:  # one bad download, not a run
                log.warning("lyria.importer: download failed for %s: %s", gen_id, exc)
                skipped += 1
                continue
            if not audio_bytes:
                skipped += 1
                continue

            fmt = _format_of(item, audio_url)
            filename = f"{safe_stem(_text(item.get('title')), gen_id)}.{fmt}"
            metadata = build_metadata(item, gen_id)
            try:
                entry_id = await asyncio.to_thread(
                    _import_blob_sync,
                    audio_bytes,
                    filename,
                    MIME_BY_FORMAT[fmt],
                    metadata,
                )
            except Exception as exc:  # one bad entry, not a run
                log.warning("lyria.importer: import failed for %s: %s", gen_id, exc)
                skipped += 1
                continue

            seen[gen_id] = entry_id
            imported.append(entry_id)
            # Persisted per entry, not once at the end: a crash between the
            # import and the write is what re-imports a track on the next sync.
            try:
                save_seen_map(seen)
            except Exception as exc:
                log.warning("lyria.importer: could not persist seen map: %s", exc)

    return {"imported": imported, "skipped": skipped}
