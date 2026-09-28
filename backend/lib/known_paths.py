"""The paths theDAW has installed, saved, exported, opened or been shown.

The app knows where everything it writes lands and what every picker returned.
This module remembers those paths so the next picker starts in the right folder
and a "Recent" menu can hand a file straight back:

  - a recent list per kind (``audio``, ``tasmo``, ``backup-zip`` ...), newest
    first, capped at ``MAX_PER_KIND``;
  - the last folder per kind, which a picker for that kind starts in;
  - the user's projects folder, and where each catalog asset was installed;
  - one-time save grants for paths the user chose in a native Save dialog.

Everything but the grants persists in one small JSON file under the data root.
It is read on every call, so a test that points ``_STORE_PATH`` somewhere else
takes effect at once. Every public function swallows its own IO errors:
remembering a path must never fail the request that produced it.

Security. The server binds 0.0.0.0 and ``/api/places/file`` streams a remembered
file to whoever asks for it, so a remembered path is servable only when its
source is in ``SERVABLE_SOURCES``: a path the user chose in a native dialog, a
file the app wrote or installed, or a download the desktop shell finished and
vouched for with its launch token. A path named in a request body is recorded
as ``client`` and stays unservable. The backup module leaves this file out of
every archive and ignores it in one, so a restore cannot set a source.

Writes follow the same rule: ``/api/places/save`` needs the nonce a native Save
dialog issued for that exact path, once, and never for a file type that runs as
a program (``BLOCKED_SAVE_EXTS``). Grants live in memory only.

Network shares and device paths (``\\\\server\\share``, ``//server/share``,
``\\\\?\\``, ``\\\\.\\``) are never remembered, shown or touched: checking one
exists reaches another machine, and on Windows it sends the user's credentials
there.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import re
import secrets
import threading
import time
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from backend.lib import paths
from backend.lib.atomic import atomic_write

log = logging.getLogger(__name__)

__all__ = [
    "BLOCKED_SAVE_EXTS",
    "EXTENSION_KINDS",
    "MAX_PER_KIND",
    "SERVABLE_SOURCES",
    "consume_save_grant",
    "default_folder",
    "find_servable",
    "grant_save",
    "installed_asset_path",
    "is_blocked_save_path",
    "is_remote_or_device_path",
    "kind_for_path",
    "last_folder",
    "peek_save_grant",
    "projects_dir",
    "projects_dir_configured",
    "recent",
    "record",
    "record_folder",
    "set_installed_asset",
    "set_projects_dir",
    "set_store_path_for_tests",
]

# None means "paths.data_path('known_paths.json') at call time", which follows a
# relocated data root. Tests monkeypatch this to a file under tmp_path.
_STORE_PATH: Path | None = None

MAX_PER_KIND = 30
# Kinds come from backend callers and from /api/places/record bodies. The cap
# keeps a caller inventing kinds from growing the file without bound; the kind
# touched longest ago is dropped first.
MAX_KINDS = 64
MAX_RECENT_LIMIT = 200
MAX_PATH_CHARS = 4096
SAVE_GRANT_SECONDS = 600.0
# Two Save dialogs answered with the same path each get a grant; this bounds how
# many stay live for one path.
MAX_GRANTS_PER_PATH = 8

# Sources whose files /api/places/file may serve. Each is a path the user chose
# in a native dialog ('pick', 'save'), a file the app wrote or installed
# ('install', 'gan', 'sway-save'), or a finished download the desktop shell
# vouched for with its launch token ('download'). Every other source, 'client'
# above all, is remembered for pickers and menus and never served.
SERVABLE_SOURCES = frozenset(
    {"install", "save", "pick", "gan", "sway-save", "download"}
)

# File types /api/places/save never writes: each one runs as a program or
# script when opened, or when it lands in a Startup folder.
BLOCKED_SAVE_EXTS = frozenset(
    {
        ".exe",
        ".bat",
        ".cmd",
        ".com",
        ".ps1",
        ".psm1",
        ".vbs",
        ".vbe",
        ".js",
        ".jse",
        ".wsf",
        ".wsh",
        ".hta",
        ".lnk",
        ".scr",
        ".msi",
        ".msp",
        ".dll",
        ".cpl",
        ".reg",
        ".jar",
        ".sh",
        ".app",
        ".desktop",
        ".url",
        ".pif",
        # Windows launchers and script hosts beyond the common ones.
        ".appref-ms",
        ".application",
        ".chm",
        ".gadget",
        ".inf",
        ".msc",
        ".ps1xml",
        ".psd1",
        ".py",
        ".pyw",
        ".scf",
        ".sct",
        ".settingcontent-ms",
        ".shb",
        ".shs",
        ".ws",
        ".wsb",
        ".wsc",
        ".xll",
    }
)

# A recorded file with this name is a VST Foundry export, so its folder is also
# where the Foundry import picker opens.
FOUNDRY_EXPORT_NAME = "project.json"

# A kind with no folder of its own starts where this other kind last was.
_FOLDER_FALLBACKS = {
    "foundry-export": "json",
    "nodefi-set": "json",
    "v2m-recordings": "json",
    "meter-map": "json",
    "lineage-json": "json",
    "library-metadata": "json",
}

_KIND_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,47}$")

# Two leading separators, in any mix: a UNC share, or a Win32 device path
# (\\?\, \\.\), which are UNC-shaped.
_REMOTE_RE = re.compile(r"^[\\/]{2}")

_DAW_PROJECT_EXTS = (
    ".als",
    ".rpp",
    ".rpp-bak",
    ".flp",
    ".aup3",
    ".aup",
    ".sesx",
    ".bwproject",
    ".dawproject",
    ".avc",
    ".logicx",
    ".cpr",
    ".ptx",
    ".pts",
    ".swayproj",
)

_EXT_GROUPS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("tasmo", (".tasmo",)),
    ("gan", (".gan",)),
    ("sway", (".sway",)),
    ("ares", (".ares",)),
    ("daw-project", _DAW_PROJECT_EXTS),
    (
        "audio",
        (
            ".wav",
            ".wave",
            ".w64",
            ".rf64",
            ".bwf",
            ".caf",
            ".aif",
            ".aiff",
            ".aifc",
            ".mp3",
            ".flac",
            ".ogg",
            ".oga",
            ".opus",
            ".m4a",
            ".aac",
            ".wma",
            ".webm",
            ".weba",
        ),
    ),
    ("midi", (".mid", ".midi", ".smf")),
    ("soundfont", (".sf2", ".sf3", ".dls")),
    (
        "score",
        (".musicxml", ".mxl", ".xml", ".abc", ".krn", ".pdf", ".svg", ".alphatex"),
    ),
    ("lyrics", (".lrc", ".txt")),
    ("json", (".json",)),
    ("image", (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif")),
    ("video", (".mp4", ".mov", ".mkv", ".m4v", ".avi", ".ogv")),
    ("zip", (".zip",)),
    ("checkpoint", (".safetensors", ".ckpt", ".pt", ".bin")),
    ("apk", (".apk",)),
)

_KIND_BY_EXT: dict[str, str] = {ext: kind for kind, exts in _EXT_GROUPS for ext in exts}

# Every kind kind_for_path derives from an extension.
EXTENSION_KINDS = frozenset(kind for kind, _ in _EXT_GROUPS)

# Data-root folders a format installs into (see backend/modules/assets/catalog.py).
_DATA_FOLDERS = {"gan": "plugins", "sway": "sway-projects", "ares": "volumetric"}
# Kinds whose picker starts in the user's Downloads folder.
_DOWNLOADS_KINDS = frozenset(
    {
        "audio",
        "midi",
        "score",
        "lyrics",
        "json",
        "image",
        "video",
        "zip",
        "apk",
        "download",
        "meter-report",
    }
)

_LOCK = threading.Lock()

# Normalized path -> [(nonce, monotonic expiry)]. Memory only: a grant is the
# user's answer to a dialog shown by this process, and it must not outlive the
# process.
_GRANTS: dict[str, list[tuple[str, float]]] = {}
_GRANT_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _clock() -> float:
    """Monotonic seconds for grant expiry. A function so tests can move time."""
    return time.monotonic()


def _timestamp() -> float:
    """Wall-clock seconds stored as an entry's ``at``."""
    return time.time()


def _store_path() -> Path:
    return (
        _STORE_PATH if _STORE_PATH is not None else paths.data_path("known_paths.json")
    )


def set_store_path_for_tests(path: str | os.PathLike[str] | None) -> None:
    """Point the store at ``path`` (None restores the data-root default) and
    drop every save grant."""
    global _STORE_PATH
    _STORE_PATH = Path(path) if path is not None else None
    with _GRANT_LOCK:
        _GRANTS.clear()


def is_remote_or_device_path(path: Any) -> bool:
    """True for a network share (``\\\\server\\share``, ``//server/share``) or a
    Windows device path (``\\\\?\\``, ``\\\\.\\``).

    Decided from the text alone, so asking never touches the filesystem."""
    try:
        text = os.fspath(path)
    except TypeError:
        return False
    return isinstance(text, str) and bool(_REMOTE_RE.match(text.lstrip()))


def _absolute(path: Any) -> str | None:
    """``path`` as an absolute, normalized string, or None when it cannot be one
    or names a network share or device path."""
    try:
        text = os.fspath(path)
    except TypeError:
        return None
    if not isinstance(text, str) or not text.strip():
        return None
    if len(text) > MAX_PATH_CHARS or "\x00" in text:
        return None
    if is_remote_or_device_path(text):
        return None
    try:
        absolute = os.path.abspath(os.path.expanduser(text))
    except (OSError, ValueError):
        return None
    # A home folder or working directory on a share makes a local-looking
    # spelling remote.
    return None if is_remote_or_device_path(absolute) else absolute


def _key(path: Any) -> str | None:
    """The comparison form of a path: absolute, ``..`` collapsed, case-folded
    where the filesystem is case-insensitive."""
    absolute = _absolute(path)
    return os.path.normcase(absolute) if absolute is not None else None


def _exists(path: str | os.PathLike[str]) -> bool:
    try:
        return os.path.exists(path)
    except (OSError, ValueError):
        return False


def _isfile(path: str | os.PathLike[str]) -> bool:
    try:
        return os.path.isfile(path)
    except (OSError, ValueError):
        return False


def _isdir(path: str | os.PathLike[str]) -> bool:
    try:
        return os.path.isdir(path)
    except (OSError, ValueError):
        return False


def _valid_kind(kind: Any) -> bool:
    return isinstance(kind, str) and bool(_KIND_RE.match(kind))


def _ext(path: str) -> str:
    return os.path.splitext(os.path.normpath(path))[1].lower()


def _normalize_exts(exts: Iterable[str] | str | None) -> frozenset[str] | None:
    """Lowercase extensions with a leading dot; None (no filter) when empty."""
    if exts is None:
        return None
    if isinstance(exts, str):
        exts = exts.split(",")
    out: set[str] = set()
    for raw in exts:
        if not isinstance(raw, str):
            continue
        ext = raw.strip().lower()
        if ext:
            out.add(ext if ext.startswith(".") else f".{ext}")
    return frozenset(out) or None


def _cap_kinds(mapping: dict[str, Any]) -> None:
    """Drop the kinds touched longest ago. Callers re-insert a kind they touch,
    so dict order is least recently touched first."""
    while len(mapping) > MAX_KINDS:
        del mapping[next(iter(mapping))]


def _public(entry: dict[str, Any], servable_keys: set[str] | None = None) -> dict:
    out = dict(entry)
    key = os.path.normcase(entry["path"])
    has_source = (
        key in servable_keys
        if servable_keys is not None
        else entry["source"] in SERVABLE_SOURCES
    )
    out["servable"] = has_source and _isfile(entry["path"])
    return out


def _local_text(value: Any) -> bool:
    """A non-empty string that does not name a share or device path."""
    return (
        isinstance(value, str) and bool(value) and not is_remote_or_device_path(value)
    )


# ---------------------------------------------------------------------------
# The store
# ---------------------------------------------------------------------------


def _empty_store() -> dict[str, Any]:
    return {"version": 1, "recent": {}, "folders": {}, "settings": {}, "installed": {}}


def _clean_entry(item: Any, kind: str) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    path = item.get("path")
    source = item.get("source")
    at = item.get("at")
    if not _local_text(path) or not isinstance(source, str):
        return None
    if isinstance(at, bool) or not isinstance(at, (int, float)):
        return None
    name = item.get("name")
    return {
        "path": path,
        "name": name if isinstance(name, str) and name else os.path.basename(path),
        "kind": kind,
        "source": source,
        "at": float(at),
    }


def _load() -> dict[str, Any]:
    """The persisted store, with malformed parts dropped. Call under ``_LOCK``.

    A share or device path is dropped too, so a store written before this rule
    existed never makes a later read reach another machine."""
    store = _empty_store()
    target = _store_path()
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return store
    except (OSError, ValueError) as e:
        log.warning("known_paths: could not read %s: %s", target, e)
        return store
    if not isinstance(raw, dict):
        return store

    recent_raw = raw.get("recent")
    if isinstance(recent_raw, dict):
        for kind, items in recent_raw.items():
            if not _valid_kind(kind) or not isinstance(items, list):
                continue
            clean = [e for e in (_clean_entry(i, kind) for i in items) if e]
            if clean:
                store["recent"][kind] = clean[:MAX_PER_KIND]

    folders_raw = raw.get("folders")
    if isinstance(folders_raw, dict):
        store["folders"] = {
            k: v for k, v in folders_raw.items() if _valid_kind(k) and _local_text(v)
        }

    settings_raw = raw.get("settings")
    if isinstance(settings_raw, dict):
        store["settings"] = {
            k: v for k, v in settings_raw.items() if isinstance(k, str)
        }

    installed_raw = raw.get("installed")
    if isinstance(installed_raw, dict):
        store["installed"] = {
            k: v
            for k, v in installed_raw.items()
            if isinstance(k, str) and k and _local_text(v)
        }
    return store


def _save(store: dict[str, Any]) -> None:
    """Write the store atomically. Call under ``_LOCK``. Never raises."""
    target = _store_path()
    try:
        atomic_write(target, json.dumps(store, indent=2))
    except OSError as e:
        log.warning("known_paths: could not write %s: %s", target, e)


def _read() -> dict[str, Any]:
    with _LOCK:
        return _load()


# ---------------------------------------------------------------------------
# Kinds and folders
# ---------------------------------------------------------------------------


def kind_for_path(path: str | os.PathLike[str]) -> str:
    """The kind a path belongs to, by extension; ``folder`` for a directory.

    A directory with a DAW project extension (a Logic ``.logicx`` bundle) is a
    ``daw-project``. A share or device path is never checked on disk.
    """
    try:
        text = os.fspath(path)
    except TypeError:
        return "file"
    if not isinstance(text, str) or not text.strip():
        return "file"
    suffix = _ext(text)
    if not is_remote_or_device_path(text) and _isdir(text):
        return "daw-project" if suffix in _DAW_PROJECT_EXTS else "folder"
    return _KIND_BY_EXT.get(suffix, "file")


def _stored_projects_dir(store: dict[str, Any]) -> Path | None:
    configured = store["settings"].get("projects_dir")
    if _local_text(configured) and Path(configured).is_absolute():
        return Path(configured)
    return None


def projects_dir() -> Path:
    """The folder .tasmo projects are saved and installed into."""
    stored = _stored_projects_dir(_read())
    if stored is not None:
        return stored
    return Path.home() / "Documents" / "theDAW Projects"


def projects_dir_configured() -> bool:
    """True when ``set_projects_dir`` stored a folder that ``projects_dir``
    uses; False while the default is in effect."""
    return _stored_projects_dir(_read()) is not None


def set_projects_dir(path: str | os.PathLike[str]) -> Path:
    """Store the user's projects folder. Raises ValueError unless ``path`` is an
    absolute folder on this computer; a failed write is logged and the folder is
    still returned."""
    try:
        text = os.fspath(path)
    except TypeError:
        text = ""
    if not isinstance(text, str) or not text.strip() or "\x00" in text:
        raise ValueError("The projects folder must be an absolute path.")
    if is_remote_or_device_path(text):
        raise ValueError("The projects folder must be a folder on this computer.")
    candidate = Path(os.path.expanduser(text))
    if not candidate.is_absolute():
        raise ValueError("The projects folder must be an absolute path.")
    chosen = Path(os.path.normpath(candidate))
    if is_remote_or_device_path(str(chosen)):
        raise ValueError("The projects folder must be a folder on this computer.")
    with _LOCK:
        store = _load()
        store["settings"]["projects_dir"] = str(chosen)
        _save(store)
    return chosen


def _home_folder(name: str) -> str | None:
    try:
        folder = Path.home() / name
    except RuntimeError:
        return None
    return str(folder) if _isdir(folder) else None


def default_folder(kind: str | None) -> str | None:
    """Where a picker for ``kind`` starts before the user has chosen anything."""
    if kind == "tasmo":
        return str(projects_dir())
    if kind in _DATA_FOLDERS:
        return str(paths.data_path(_DATA_FOLDERS[kind]))
    if kind in ("backup-zip", "backup-dest"):
        return _home_folder("Documents")
    if kind == "library-folder":
        return _home_folder("Music")
    if kind in _DOWNLOADS_KINDS:
        return _home_folder("Downloads")
    return None


def last_folder(kind: str | None) -> str | None:
    """The folder the last path of this kind was in, while it still exists.

    A kind with a fallback kind (``foundry-export`` and the JSON export kinds
    fall back to ``json``) then takes that kind's last folder; otherwise
    ``default_folder(kind)``."""
    if isinstance(kind, str) and kind:
        folder = _read()["folders"].get(kind)
        if folder and _isdir(folder):
            return folder
    fallback = _FOLDER_FALLBACKS.get(kind) if isinstance(kind, str) else None
    if fallback is not None:
        folder = last_folder(fallback)
        if folder:
            return folder
    return default_folder(kind)


def record_folder(kind: str, folder: str | os.PathLike[str]) -> None:
    """Make ``folder`` the last folder for ``kind``. Ignored unless the folder
    exists, as for a Save dialog whose file has not been written yet."""
    absolute = _absolute(folder)
    if not _valid_kind(kind) or absolute is None or not _isdir(absolute):
        return
    with _LOCK:
        store = _load()
        folders = store["folders"]
        folders.pop(kind, None)
        folders[kind] = absolute
        _cap_kinds(folders)
        _save(store)


# ---------------------------------------------------------------------------
# Recent paths
# ---------------------------------------------------------------------------


def record(
    path: str | os.PathLike[str],
    kind: str | None = None,
    source: str = "client",
    update_folder: bool = True,
) -> dict[str, Any] | None:
    """Remember a path that exists on disk. Returns the stored entry (with its
    computed ``servable``), or None when nothing is at ``path`` or it names a
    share or device path.

    The entry goes to the front of its kind's list. With ``update_folder`` the
    path's folder also becomes that kind's last folder, and a file named
    ``project.json`` makes its folder the ``foundry-export`` folder as well; a
    copy the app keeps for itself passes False so pickers keep the user's
    folder. A kind that is missing or malformed is taken from the extension.
    Recording a path again moves it to the front; when the earlier entry had a
    servable source and this one does not, the earlier source is kept, so
    re-recording a picked file from the client never takes it out of a Recent
    menu.
    """
    absolute = _absolute(path)
    if absolute is None or not _exists(absolute):
        return None
    if not _valid_kind(kind):
        kind = kind_for_path(absolute)
    if not isinstance(source, str) or not source:
        source = "client"
    key = os.path.normcase(absolute)
    is_dir = _isdir(absolute)
    folder = absolute if is_dir else os.path.dirname(absolute)
    foundry_export = (
        not is_dir and os.path.basename(absolute).lower() == FOUNDRY_EXPORT_NAME
    )
    entry: dict[str, Any] = {
        "path": absolute,
        "name": os.path.basename(absolute) or absolute,
        "kind": kind,
        "source": source,
        "at": _timestamp(),
    }
    with _LOCK:
        store = _load()
        lists = store["recent"]
        kept: list[dict[str, Any]] = []
        for old in lists.pop(kind, []):
            if os.path.normcase(old["path"]) != key:
                kept.append(old)
            elif (
                old["source"] in SERVABLE_SOURCES
                and entry["source"] not in SERVABLE_SOURCES
            ):
                entry["source"] = old["source"]
        lists[kind] = [entry, *kept][:MAX_PER_KIND]
        _cap_kinds(lists)

        if update_folder:
            folders = store["folders"]
            folders.pop(kind, None)
            folders[kind] = folder
            if foundry_export:
                folders.pop("foundry-export", None)
                folders["foundry-export"] = folder
            _cap_kinds(folders)
        _save(store)
    return _public(entry)


def _servable_keys(lists: dict[str, list[dict[str, Any]]]) -> set[str]:
    return {
        os.path.normcase(e["path"])
        for items in lists.values()
        for e in items
        if e["source"] in SERVABLE_SOURCES
    }


def recent(
    kind: str | None = None,
    exts: Iterable[str] | str | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Remembered paths that still exist, newest first.

    One kind, or every kind when ``kind`` is empty. A path recorded under two
    kinds appears once, as its newest entry, and is servable when any of its
    entries has a servable source.
    """
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        limit = 20
    limit = max(0, min(limit, MAX_RECENT_LIMIT))
    if limit == 0:
        return []
    wanted = _normalize_exts(exts)
    lists = _read()["recent"]
    servable_keys = _servable_keys(lists)

    if kind:
        pool = list(lists.get(kind, []))
    else:
        # Most recently touched kind first, so a stable sort breaks a tie in
        # ``at`` toward the entry recorded last.
        pool = [e for k in reversed(list(lists)) for e in lists[k]]
    pool.sort(key=lambda e: e["at"], reverse=True)

    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in pool:
        key = os.path.normcase(entry["path"])
        if key in seen:
            continue
        seen.add(key)
        if wanted is not None and _ext(entry["path"]) not in wanted:
            continue
        if not _exists(entry["path"]):
            continue
        out.append(_public(entry, servable_keys))
        if len(out) >= limit:
            break
    return out


def find_servable(path: str | os.PathLike[str]) -> str | None:
    """The stored path of a servable file matching ``path``, or None.

    The caller serves the returned path, which the backend recorded itself;
    the spelling in the request only selects among those.
    """
    key = _key(path)
    if key is None:
        return None
    for items in _read()["recent"].values():
        for entry in items:
            if (
                entry["source"] in SERVABLE_SOURCES
                and os.path.normcase(entry["path"]) == key
                and _isfile(entry["path"])
            ):
                return entry["path"]
    return None


# ---------------------------------------------------------------------------
# Installed catalog assets
# ---------------------------------------------------------------------------


def set_installed_asset(asset_id: str, path: str | os.PathLike[str]) -> None:
    """Remember where a catalog asset was installed."""
    absolute = _absolute(path)
    if not isinstance(asset_id, str) or not asset_id or absolute is None:
        return
    with _LOCK:
        store = _load()
        store["installed"][asset_id] = absolute
        _save(store)


def installed_asset_path(asset_id: str) -> str | None:
    """Where a catalog asset was installed, while that file still exists."""
    if not isinstance(asset_id, str) or not asset_id:
        return None
    stored = _read()["installed"].get(asset_id)
    return stored if stored and _isfile(stored) else None


# ---------------------------------------------------------------------------
# Save grants
# ---------------------------------------------------------------------------


def is_blocked_save_path(path: str | os.PathLike[str]) -> bool:
    """True when a file written to ``path`` would be a type in
    ``BLOCKED_SAVE_EXTS``.

    The name is judged the way Windows creates the file: trailing dots and
    spaces are dropped, a name that is only an extension (``.cmd``) has that
    extension, and a name holding a colon (an NTFS stream spelling such as
    ``run.cmd::$DATA``) is refused outright. A path that cannot be normalized
    answers False; no grant can exist for it."""
    absolute = _absolute(path)
    if absolute is None:
        return False
    name = os.path.basename(absolute)
    if os.name == "nt":
        if ":" in name:
            return True
        name = name.rstrip(" .")
    dot = name.rfind(".")
    return dot >= 0 and name[dot:].lower() in BLOCKED_SAVE_EXTS


def _prune_grants(now: float) -> None:
    for key in list(_GRANTS):
        live = [g for g in _GRANTS[key] if g[1] > now]
        if live:
            _GRANTS[key] = live
        else:
            del _GRANTS[key]


def grant_save(path: str | os.PathLike[str]) -> str | None:
    """Allow one write to exactly ``path`` within ``SAVE_GRANT_SECONDS``, and
    return the nonce that write must present.

    Issued when the user picks that path in a native Save dialog. Grants
    nothing and returns None for a blocked file type or a path that cannot be
    normalized."""
    key = _key(path)
    if key is None or is_blocked_save_path(path):
        return None
    nonce = secrets.token_urlsafe(24)
    now = _clock()
    with _GRANT_LOCK:
        _prune_grants(now)
        live = _GRANTS.setdefault(key, [])
        live.append((nonce, now + SAVE_GRANT_SECONDS))
        del live[:-MAX_GRANTS_PER_PATH]
    return nonce


def _match_grant(path: Any, nonce: Any, consume: bool) -> bool:
    key = _key(path)
    if key is None or not isinstance(nonce, str) or not nonce:
        return False
    wanted = nonce.encode("utf-8")
    now = _clock()
    with _GRANT_LOCK:
        _prune_grants(now)
        live = _GRANTS.get(key, [])
        matched: int | None = None
        # Every stored nonce is compared in constant time, so the answer's
        # timing says nothing about how close a guess came.
        for i, (stored, _expiry) in enumerate(live):
            if hmac.compare_digest(stored.encode("utf-8"), wanted) and matched is None:
                matched = i
        if matched is None:
            return False
        if consume:
            del live[matched]
            if not live:
                _GRANTS.pop(key, None)
    return True


def peek_save_grant(path: str | os.PathLike[str], nonce: str) -> bool:
    """True while a live grant for ``path`` carries ``nonce``. Spends nothing."""
    return _match_grant(path, nonce, consume=False)


def consume_save_grant(path: str | os.PathLike[str], nonce: str) -> bool:
    """True once for a live grant for ``path`` carrying ``nonce``, which is then
    removed."""
    return _match_grant(path, nonce, consume=True)
