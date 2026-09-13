"""The asset catalog: what is downloadable, and where each format installs.

An entry describes one downloadable item. The bundled catalog ships in
``examples/catalog.json`` and is read from the install directory, so it works
in a read-only install; user catalogs live under the writable data tree at
``data/assets/<name>.json`` and are merged on top, later entries winning on a
repeated id.

Four formats are carried, each with a place it belongs:

``.tasmo``  a project, installed into the user's projects directory
``.gan``    a web plugin, installed through the plugin module's own importer
``.ares``   a volumetric capture (ARES container: mesh chunks plus a video
            track), installed into ``data/volumetric``
``.sway``   a SwayCommand cockpit scene, installed into ``data/sway-scenes``

A catalog file is data, not code: it is read, validated field by field, and an
entry that fails validation is dropped with a warning rather than taking the
whole catalog down.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from backend.lib import paths

log = logging.getLogger(__name__)

# Where the bundled catalog and its files live. Install-directory reads, which
# work whether or not the install directory is writable.
EXAMPLES_DIR = paths.PROJECT_ROOT / "examples"
BUNDLED_CATALOG = EXAMPLES_DIR / "catalog.json"

#: Extension -> the directory an install of that format lands in. ``None``
#: means the format has its own installer (see router._install_gan).
FORMAT_TARGETS: dict[str, str | None] = {
    ".tasmo": "projects",
    ".gan": None,
    ".ares": "volumetric",
    ".sway": "sway-scenes",
}

KINDS = ("project", "plugin", "volumetric", "scene")


@dataclass
class AssetEntry:
    """One catalog item. ``file`` is resolved against its catalog's directory."""

    id: str
    name: str
    kind: str
    format: str
    summary: str
    file: Path
    description: str = ""
    author: str = ""
    version: str = ""
    tags: list[str] = field(default_factory=list)
    #: App tabs this item exercises, so the browser can answer "show me
    #: something that demonstrates SCORE".
    tabs: list[str] = field(default_factory=list)
    cover: Path | None = None
    requires: list[str] = field(default_factory=list)
    duration_sec: float | None = None

    @property
    def available(self) -> bool:
        """False when the catalog lists a file this install does not carry."""
        return self.file.is_file()

    @property
    def size_bytes(self) -> int:
        try:
            return self.file.stat().st_size
        except OSError:
            return 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "format": self.format,
            "summary": self.summary,
            "description": self.description,
            "author": self.author,
            "version": self.version,
            "tags": list(self.tags),
            "tabs": list(self.tabs),
            "requires": list(self.requires),
            "duration_sec": self.duration_sec,
            "available": self.available,
            "size_bytes": self.size_bytes,
            "has_cover": self.cover is not None and self.cover.is_file(),
            "download_url": f"/api/assets/{self.id}/download",
            "cover_url": f"/api/assets/{self.id}/cover",
        }

    def haystack(self) -> str:
        """Everything a search should match, lowercased once per entry."""
        return " ".join(
            [
                self.name,
                self.summary,
                self.description,
                self.author,
                self.kind,
                self.format,
                " ".join(self.tags),
                " ".join(self.tabs),
            ]
        ).lower()


def user_catalog_dir() -> Path:
    return paths.data_path("assets")


def _catalog_files() -> list[Path]:
    files: list[Path] = []
    if BUNDLED_CATALOG.is_file():
        files.append(BUNDLED_CATALOG)
    user_dir = user_catalog_dir()
    if user_dir.is_dir():
        files.extend(sorted(p for p in user_dir.glob("*.json") if p.is_file()))
    return files


def _as_str_list(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    return []


def _entry_from(raw: Any, root: Path) -> AssetEntry | None:
    if not isinstance(raw, dict):
        return None
    entry_id = str(raw.get("id") or "").strip()
    name = str(raw.get("name") or "").strip()
    rel = str(raw.get("file") or "").strip()
    if not entry_id or not name or not rel:
        log.warning("assets: skipping an entry with no id, name or file: %r", raw)
        return None

    file_path = (root / rel).resolve()
    try:
        # A catalog must not reach outside its own directory.
        file_path.relative_to(root.resolve())
    except ValueError:
        log.warning("assets: %s points outside its catalog directory", entry_id)
        return None

    fmt = str(raw.get("format") or file_path.suffix).lower()
    if fmt and not fmt.startswith("."):
        fmt = f".{fmt}"
    if fmt not in FORMAT_TARGETS:
        log.warning("assets: %s has an unknown format %r", entry_id, fmt)
        return None

    kind = str(raw.get("kind") or "").strip().lower()
    if kind not in KINDS:
        kind = {
            ".tasmo": "project",
            ".gan": "plugin",
            ".ares": "volumetric",
            ".sway": "scene",
        }[fmt]

    cover_rel = str(raw.get("cover") or "").strip()
    cover = (root / cover_rel).resolve() if cover_rel else None
    if cover is not None:
        try:
            cover.relative_to(root.resolve())
        except ValueError:
            cover = None

    duration = raw.get("duration_sec")
    try:
        duration_sec = float(duration) if duration is not None else None
    except (TypeError, ValueError):
        duration_sec = None

    return AssetEntry(
        id=entry_id,
        name=name,
        kind=kind,
        format=fmt,
        summary=str(raw.get("summary") or "").strip(),
        description=str(raw.get("description") or "").strip(),
        author=str(raw.get("author") or "").strip(),
        version=str(raw.get("version") or "").strip(),
        tags=_as_str_list(raw.get("tags")),
        tabs=_as_str_list(raw.get("tabs")),
        requires=_as_str_list(raw.get("requires")),
        cover=cover,
        file=file_path,
        duration_sec=duration_sec,
    )


def load_entries() -> list[AssetEntry]:
    """Every entry from every catalog, later files overriding earlier ids.

    Read on each call rather than cached: a user who drops a catalog into
    ``data/assets`` expects the browser to show it without a restart, and the
    files are small.
    """
    by_id: dict[str, AssetEntry] = {}
    for path in _catalog_files():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            log.warning("assets: could not read %s: %s", path, e)
            continue
        items = raw.get("assets") if isinstance(raw, dict) else raw
        if not isinstance(items, list):
            log.warning("assets: %s has no asset list", path)
            continue
        for item in items:
            entry = _entry_from(item, path.parent)
            if entry is not None:
                by_id[entry.id] = entry
    return list(by_id.values())


def search(
    entries: Iterable[AssetEntry],
    *,
    query: str = "",
    kind: str = "",
    tag: str = "",
    tab: str = "",
    available_only: bool = False,
) -> list[AssetEntry]:
    """Filter, then rank: a name match outranks a match anywhere else."""
    q = query.strip().lower()
    terms = [t for t in q.split() if t]
    out: list[tuple[int, str, AssetEntry]] = []
    for e in entries:
        if kind and e.kind != kind:
            continue
        if tag and tag.lower() not in [t.lower() for t in e.tags]:
            continue
        if tab and tab.lower() not in [t.lower() for t in e.tabs]:
            continue
        if available_only and not e.available:
            continue
        if terms:
            hay = e.haystack()
            if not all(t in hay for t in terms):
                continue
            name = e.name.lower()
            rank = 0 if all(t in name for t in terms) else 1
        else:
            rank = 0
        out.append((rank, e.name.lower(), e))
    out.sort(key=lambda row: (row[0], row[1]))
    return [e for _, _, e in out]


def facets(entries: Iterable[AssetEntry]) -> dict[str, list[dict[str, Any]]]:
    """Counts per kind, tag and tab, for the browser's filter rail."""
    kinds: dict[str, int] = {}
    tags: dict[str, int] = {}
    tabs: dict[str, int] = {}
    for e in entries:
        kinds[e.kind] = kinds.get(e.kind, 0) + 1
        for t in e.tags:
            tags[t] = tags.get(t, 0) + 1
        for t in e.tabs:
            tabs[t] = tabs.get(t, 0) + 1

    def rows(d: dict[str, int]) -> list[dict[str, Any]]:
        return [
            {"value": k, "count": v}
            for k, v in sorted(d.items(), key=lambda kv: (-kv[1], kv[0]))
        ]

    return {"kinds": rows(kinds), "tags": rows(tags), "tabs": rows(tabs)}
