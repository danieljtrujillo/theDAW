"""An index over the user's own media folders, keyed by entry id.

The library serves an entry from the entry's own directory. Entries exist
whose bytes were never written there -- catalogued from a provider that kept
the audio behind a URL, imported as metadata, restored from a backup that
carried the database and not the files -- and for those the only copy on this
machine is a file in the user's own media folders, under a name the entry
never recorded.

Two id shapes survive in those filenames, so both are indexed:

``<anything> <36-char uuid><anything>.<ext>``
    The entry id in full, anywhere in the name.

``<title> [<first 8 hex of the entry id>].<ext>``
    The short tag a library export writes when the full id would make the
    name unwieldy. Eight hex digits collide about as often as you would
    expect across a few hundred thousand files, which is why a collision has
    an explicit rule rather than a coin toss: a file that carries the FULL id
    wins, and between two that do not, the newest wins.

The walk is one pass with :func:`os.scandir` over every configured root, and
it is slow -- a few hundred thousand files on a spinning disk is minutes. So
nothing waits for it. :func:`start_scan` hands it to a daemon thread, and
:func:`lookup` answers ``None`` until the index exists: a request that
arrives first gets exactly the behaviour it got before this module existed.

Configuration, in order of precedence:

``theDAW_MEDIA_ROOTS``
    ``os.pathsep``-separated absolute folders. Wins outright when set.

``settings.library.media_roots``
    The list Settings -> Storage edits.

Nothing here is provider-specific: a folder of media files named after entry
ids is a folder of media files named after entry ids.
"""

from __future__ import annotations

import logging
import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Optional

log = logging.getLogger(__name__)

#: ``os.pathsep``-separated absolute folders. Set = the only roots consulted.
ENV_VAR = "theDAW_MEDIA_ROOTS"

#: Where the same list lives in ``data/settings.json`` when the env var is not
#: set (Settings -> Storage -> Media roots).
SETTINGS_SECTION = "library"
SETTINGS_KEY = "media_roots"

#: How often a lookup is allowed to re-stat the roots to notice that one of
#: them changed. Cheap (one stat per root), but not per request.
SIGNATURE_CHECK_SEC = 30.0

#: Folder under the writable data tree holding browser-playable remuxes of
#: files the library only references. See :func:`playable_cache_dir`.
PLAYABLE_CACHE_DIRNAME = "playable-cache"

_UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
#: ``[c27de18c]`` immediately before the extension, and nowhere else.
_ID8_RE = re.compile(r"\[([0-9a-fA-F]{8})\]\s*$")


def media_extensions() -> frozenset[str]:
    """Every container the library recognises, audio and visual.

    Derived from the store's own tables at call time rather than copied, so
    it cannot fall behind them -- and imported lazily because the store
    imports this module.
    """
    from .store import AUDIO_EXTS, _MEDIA_EXTS

    return frozenset(AUDIO_EXTS) | frozenset(_MEDIA_EXTS)


@dataclass(slots=True)
class MediaIndex:
    """One finished walk. Paths are plain ``str``: 170,000 ``Path`` objects
    cost several times what the strings do, and every consumer wants a
    ``Path`` for exactly one of them."""

    roots: tuple[str, ...]
    signature: tuple[tuple[str, Optional[float]], ...]
    by_full_id: dict[str, str] = field(default_factory=dict)
    by_id8: dict[str, str] = field(default_factory=dict)
    files: int = 0
    ambiguous: int = 0
    built_at: float = field(default_factory=time.time)
    duration_sec: float = 0.0


_lock = threading.Lock()
_index: Optional[MediaIndex] = None
_scanning = False
_scan_thread: Optional[threading.Thread] = None
_last_signature_check = 0.0
#: Why the last walk produced no index. Without this a failed scan and a scan
#: that has not started are the same "ready: false" and the Settings panel can
#: only say "not indexed yet" about a disk that went away.
_last_error: Optional[str] = None


def _set_error(message: Optional[str]) -> None:
    global _last_error
    with _lock:
        _last_error = message


# ---- configuration ---------------------------------------------------------


def normalize_roots(values: list[str]) -> list[str]:
    """One canonical spelling per folder, in first-seen order.

    ``D:\\music``, ``D:\\music\\`` and ``d:\\music`` are one root, and walking
    them three times would index every file three times and report two
    "collisions" that are the same file. Case is folded for the comparison
    only -- the stored string keeps the spelling the user typed, minus the
    trailing separator -- because Windows paths are case-insensitive but what
    the Settings panel shows should still look like what was entered.

    A root INSIDE another root is dropped for the same reason: the outer walk
    already reaches it.
    """
    cleaned: list[tuple[str, str]] = []
    seen: set[str] = set()
    for value in values:
        raw = value.strip().strip('"')
        if not raw:
            continue
        absolute = os.path.normpath(os.path.abspath(os.path.expanduser(raw)))
        key = os.path.normcase(absolute)
        if key in seen:
            continue
        seen.add(key)
        cleaned.append((absolute, key))
    out: list[str] = []
    for absolute, key in cleaned:
        parent = next(
            (
                other
                for _, other in cleaned
                if other != key and key.startswith(other.rstrip(os.sep) + os.sep)
            ),
            None,
        )
        if parent is not None:
            log.info(
                "media_roots: %s is inside %s; the outer root covers it",
                absolute,
                parent,
            )
            continue
        out.append(absolute)
    return out


def validate_roots(values: list[str]) -> list[str]:
    """``normalize_roots``, refusing anything that cannot be walked.

    Raises ``ValueError`` naming the offending entry. A relative path is
    refused rather than resolved, because the CWD a background thread resolves
    it against is not the one the user was thinking of, and a path that is not
    a folder right now is a typo far more often than it is a drive about to be
    plugged in.
    """
    for value in values:
        if not isinstance(value, str):
            raise ValueError(f"{value!r} is not a folder path")
        raw = value.strip().strip('"')
        if not raw:
            continue
        if not os.path.isabs(os.path.expanduser(raw)):
            raise ValueError(f"{raw!r} is not an absolute path")
    roots = normalize_roots(values)
    for root in roots:
        if not os.path.isdir(root):
            raise ValueError(f"{root!r} is not a folder on this machine")
    return roots


def _accept_roots(values: list[str], source: str) -> list[str]:
    """``validate_roots`` per entry, dropping (and naming) the ones it refuses.

    Reading roots must never raise -- a bad entry in the environment or in a
    hand-edited settings.json would otherwise take the whole index down, and
    with it every entry that HAS a good root. The PATCH path still answers 400
    so a root typed into Settings is rejected where the user can see it; this
    is the same rule applied where there is nobody to tell.
    """
    kept: list[str] = []
    for value in values:
        try:
            kept.extend(validate_roots([value]))
        except ValueError as exc:
            log.warning("media_roots: ignoring a root from %s (%s)", source, exc)
    return normalize_roots(kept)


def configured_roots() -> list[str]:
    """The folders to index, env first. Never raises: a settings store that
    cannot be read is the same as no roots configured."""
    raw = os.getenv(ENV_VAR)
    if raw:
        return _accept_roots(raw.split(os.pathsep), ENV_VAR)
    try:
        from backend.modules.settings.router import get_store as get_settings_store

        value = get_settings_store().get_value(SETTINGS_SECTION, SETTINGS_KEY, [])
    except Exception:  # noqa: BLE001 -- settings are optional for serving audio
        log.debug("media_roots: settings unavailable", exc_info=True)
        return []
    if not isinstance(value, list):
        return []
    return _accept_roots(
        [v for v in value if isinstance(v, str)],
        f"settings.{SETTINGS_SECTION}.{SETTINGS_KEY}",
    )


def _signature(roots: list[str]) -> tuple[tuple[str, Optional[float]], ...]:
    """The root list plus each root's own mtime -- enough to notice a folder
    added, removed, or given a new top-level child, and one stat per root."""
    out: list[tuple[str, Optional[float]]] = []
    for root in roots:
        try:
            out.append((root, os.stat(root).st_mtime))
        except OSError:
            out.append((root, None))
    return tuple(out)


#: An entry id that is safe to use as ONE path segment. Every id this library
#: mints is a uuid or "<job>_<index>"; anything else arrives off the wire.
_SAFE_SEGMENT_RE = re.compile(r"[A-Za-z0-9._-]+")


def playable_cache_dir(entry_id: str) -> Optional[Path]:
    """Where a remux of an out-of-tree file is cached, or None.

    An entry whose audio lives in a media root is REFERENCED, not owned: the
    library must not write a decoded WAV into its folder just because the
    browser cannot open AIFF. The cache goes in the writable data tree
    instead, keyed by entry, so it is still one remux per file and still
    deletable by hand.

    None when the id cannot be a folder name. ``entry_id`` comes straight off
    the URL, and ``data_path(PLAYABLE_CACHE_DIRNAME, "../..")`` is a folder
    somewhere else entirely -- a caller that gets None serves the original
    bytes instead, which costs a browser-unplayable file and nothing else.
    """
    if (
        not entry_id
        # "." and ".." are the two the filesystem names, but "..." and every
        # longer run are just as much "not a folder anyone meant".
        or entry_id.strip(".") == ""
        or not _SAFE_SEGMENT_RE.fullmatch(entry_id)
    ):
        log.debug("media_roots: %r cannot be a cache folder name", entry_id)
        return None
    from backend.lib import paths

    return paths.data_path(PLAYABLE_CACHE_DIRNAME, entry_id)


def path_is_within(path: Path, parent: Path) -> bool:
    """Whether ``path`` sits inside ``parent``. False (never raises) for two
    paths on different drives, which is exactly the case this exists for."""
    try:
        return os.path.normcase(os.path.abspath(str(path))).startswith(
            os.path.normcase(os.path.abspath(str(parent))).rstrip(os.sep) + os.sep
        )
    except (OSError, ValueError):  # pragma: no cover - defensive
        return False


# ---- the walk --------------------------------------------------------------


def _scan_files(root: str) -> Iterator[os.DirEntry]:
    """Every file under ``root``, depth-first, without following directory
    links. A junction or symlinked directory is skipped rather than walked:
    an index that never finishes because two folders point at each other is
    worse than one that misses a linked subtree the user can add as its own
    root. Hardlinked and symlinked FILES index normally."""
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                            continue
                        if not entry.is_file():
                            continue
                    except OSError:
                        continue
                    yield entry
        except OSError as exc:
            log.warning("media_roots: cannot read %s (%s)", current, exc)


def _keys_for(stem: str) -> tuple[Optional[str], list[str]]:
    """``(full id, [id8 keys])`` for a filename stem, all lowercase."""
    full_match = _UUID_RE.search(stem)
    full = full_match.group(0).lower() if full_match else None
    id8s: list[str] = []
    if full:
        id8s.append(full[:8])
    tag = _ID8_RE.search(stem)
    if tag:
        tagged = tag.group(1).lower()
        if tagged not in id8s:
            id8s.append(tagged)
    return full, id8s


def _mtime(path: str) -> float:
    try:
        return os.stat(path).st_mtime
    except OSError:
        return 0.0


def _build_index(roots: list[str]) -> MediaIndex:
    """Walk every root once. Never raises for a root that disappears mid-walk;
    the rest of the index is still worth having."""
    started = time.monotonic()
    index = MediaIndex(roots=tuple(roots), signature=_signature(roots))
    exts = media_extensions()
    # Rank per id8 key: 1 when the winning file carries the full id, else 0.
    # An mtime comparison costs a stat, so it is paid only on a collision
    # between two files of equal rank -- a few hundred stats, not 170,000.
    id8_rank: dict[str, int] = {}
    first_ambiguity: Optional[tuple[str, str, str]] = None

    for root in roots:
        if not os.path.isdir(root):
            log.warning("media_roots: %s is not a folder; skipped", root)
            continue
        for entry in _scan_files(root):
            name = entry.name
            dot = name.rfind(".")
            if dot <= 0 or name[dot:].lower() not in exts:
                continue
            full, id8s = _keys_for(name[:dot])
            if full is None and not id8s:
                continue
            index.files += 1
            path = entry.path
            if full is not None:
                previous = index.by_full_id.get(full)
                if previous is None:
                    index.by_full_id[full] = path
                elif previous != path and _mtime(path) > _mtime(previous):
                    index.by_full_id[full] = path
            has_full = 1 if full is not None else 0
            for key in id8s:
                previous = index.by_id8.get(key)
                if previous is None:
                    index.by_id8[key] = path
                    id8_rank[key] = has_full
                    continue
                if previous == path:
                    continue
                index.ambiguous += 1
                if first_ambiguity is None:
                    first_ambiguity = (key, previous, path)
                previous_rank = id8_rank.get(key, 0)
                if has_full > previous_rank or (
                    has_full == previous_rank and _mtime(path) > _mtime(previous)
                ):
                    index.by_id8[key] = path
                    id8_rank[key] = has_full

    index.duration_sec = time.monotonic() - started
    if first_ambiguity is not None:
        # Once per scan, with one worked example. Per-collision logging on a
        # 170,000-file tree is a log nobody can read.
        key, kept_or_dropped, other = first_ambiguity
        log.info(
            "media_roots: %d short-id collision(s); the full id wins, else the "
            "newest file. First: [%s] matched %s and %s",
            index.ambiguous,
            key,
            kept_or_dropped,
            other,
        )
    log.info(
        "media_roots: indexed %d file(s) from %d root(s) in %.1fs "
        "(%d full ids, %d short ids)",
        index.files,
        len(roots),
        index.duration_sec,
        len(index.by_full_id),
        len(index.by_id8),
    )
    return index


# ---- scanning --------------------------------------------------------------


def _run_scan(roots: list[str]) -> None:
    global _index, _scanning, _last_error
    built: Optional[MediaIndex] = None
    failure: Optional[str] = None
    try:
        built = _build_index(roots)
    except Exception as exc:  # noqa: BLE001 -- a daemon thread must not raise
        log.warning("media_roots: the scan failed", exc_info=True)
        failure = f"{type(exc).__name__}: {exc}"
    with _lock:
        if built is not None:
            _index = built
        _last_error = failure
        _scanning = False


def start_scan(*, force: bool = False) -> bool:
    """Start a walk on a daemon thread and return immediately.

    Returns True when this call started one. A scan already running is left
    alone (a second walk over the same tree would only slow the first), and
    without ``force`` an index that is already built is kept.
    """
    global _scanning, _scan_thread
    roots = configured_roots()
    with _lock:
        if _scanning:
            return False
        if _index is not None and not force:
            return False
        if not roots:
            _index_empty(roots)
            return False
        _scanning = True
        thread = threading.Thread(
            target=_run_scan, args=(roots,), name="library-media-roots", daemon=True
        )
        _scan_thread = thread
    thread.start()
    return True


def _index_empty(roots: list[str]) -> None:
    """Record 'no roots configured' as a finished, empty index. Caller holds
    the lock. Without this a lookup would re-read the settings on every
    request for a user who has configured nothing."""
    global _index
    _index = MediaIndex(roots=tuple(roots), signature=_signature(roots))


def scan_now() -> Optional[MediaIndex]:
    """Walk synchronously and install the result. For tests and for a caller
    that has already decided to wait -- no request path calls this. Returns
    None when the walk failed; the reason is in :func:`status`."""
    global _index, _scanning, _last_error
    roots = configured_roots()
    with _lock:
        _scanning = True
    try:
        built = _build_index(roots)
    except Exception as exc:  # noqa: BLE001 -- same contract as the thread
        log.warning("media_roots: the scan failed", exc_info=True)
        with _lock:
            _last_error = f"{type(exc).__name__}: {exc}"
            _scanning = False
        return None
    with _lock:
        _index = built
        _last_error = None
        _scanning = False
    return built


def reset() -> None:
    """Forget the index and any scan state. Tests only."""
    global _index, _scanning, _scan_thread, _last_signature_check, _last_error
    with _lock:
        _index = None
        _scanning = False
        _scan_thread = None
        _last_signature_check = 0.0
        _last_error = None


def _maybe_refresh(current: MediaIndex) -> None:
    """Notice that a root changed and start a rescan -- on a thread of its own.

    ``lookup`` is called from ``stream_audio``, which is ``async def``: one
    ``os.stat`` of a sleeping external drive on the event loop stalls every
    other request in the process. So the caller only arms the check; the stat
    and the rescan decision happen elsewhere. The caller keeps reading the
    index it already has -- a stale hit is a real file, and a miss costs
    exactly what a miss cost before.
    """
    global _last_signature_check
    now = time.monotonic()
    if now - _last_signature_check < SIGNATURE_CHECK_SEC:
        return
    # Claimed BEFORE the thread starts, so a burst of lookups arms it once.
    _last_signature_check = now
    signature = current.signature

    def _check() -> None:
        try:
            if _signature(configured_roots()) != signature:
                log.info("media_roots: a root changed; rescanning in the background")
                start_scan(force=True)
        except Exception:  # noqa: BLE001 -- a daemon thread must not raise
            log.debug("media_roots: the staleness check failed", exc_info=True)

    threading.Thread(
        target=_check, name="library-media-roots-check", daemon=True
    ).start()


# ---- lookup ----------------------------------------------------------------


def lookup(
    entry_id: str, *, extensions: Optional[frozenset[str] | set[str]] = None
) -> Optional[Path]:
    """The indexed file for ``entry_id``, full id first then its first eight
    hex digits, or None.

    Never blocks and never walks: before the first scan finishes this is
    ``None``, which is the behaviour the library had before the index
    existed. ``extensions`` (lowercase, with the dot) filters the hit, so an
    audio lookup cannot answer with the entry's video.
    """
    if not entry_id:
        return None
    with _lock:
        index = _index
    if index is None:
        return None
    _maybe_refresh(index)
    key = entry_id.strip().lower()
    found = index.by_full_id.get(key)
    if found is None and _UUID_RE.fullmatch(key):
        # Only a uuid entry id has a "first eight hex" to match on. A generate
        # id ("job_alpha_00") has eight leading characters like anything else,
        # and letting those index into the short-id table is how an unrelated
        # "[deadbeef]" file becomes somebody's audio.
        found = index.by_id8.get(key[:8])
    if found is None:
        return None
    if extensions is not None:
        dot = found.rfind(".")
        if dot <= 0 or found[dot:].lower() not in extensions:
            return None
    path = Path(found)
    # The index can outlive the file: a user moves a folder between scans.
    return path if path.is_file() else None


def status() -> dict:
    """What the Settings panel shows: the roots, how big the index is, how
    old it is, and whether a walk is running right now."""
    with _lock:
        index = _index
        scanning = _scanning
        error = _last_error
    return {
        "roots": configured_roots(),
        "ready": index is not None,
        "scanning": scanning,
        "error": error,
        "files": index.files if index is not None else 0,
        "full_ids": len(index.by_full_id) if index is not None else 0,
        "short_ids": len(index.by_id8) if index is not None else 0,
        "ambiguous": index.ambiguous if index is not None else 0,
        "age_seconds": (
            round(max(0.0, time.time() - index.built_at), 3)
            if index is not None
            else None
        ),
        "scan_seconds": round(index.duration_sec, 3) if index is not None else None,
    }
