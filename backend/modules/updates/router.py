"""FastAPI router for the updates module (prefix ``/api/updates``).

    GET /check     compare the installed version against the latest GitHub release
    GET /releases  up to 10 recent releases for a restore-previous-version picker

The installed version is read once from ``pyproject.toml`` at the repo root
(regex, cached for the process lifetime). The latest-release data comes from
the GitHub releases API and is cached on disk at ``data/updates_check.json``
for 6 hours, so app startup and repeated polling never wait on the network.
``GET /check?force=true`` bypasses the cache.

Network failures NEVER produce a 5xx: offline users get HTTP 200 with
``update_available: null`` and an ``error`` field describing the failure.

All handlers are sync ``def`` functions, so Starlette runs them on its worker
thread pool -- the blocking httpx call (8s timeout) never touches the event
loop.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter

log = logging.getLogger(__name__)

router = APIRouter()

# backend/modules/updates/router.py -> parents[3] == repo root.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_PYPROJECT_PATH = _REPO_ROOT / "pyproject.toml"
_CACHE_PATH = _REPO_ROOT / "data" / "updates_check.json"

_REPO_SLUG = "gantasmo/theDAW"
_RELEASES_URL = f"https://api.github.com/repos/{_REPO_SLUG}/releases"
_HTTP_TIMEOUT_S = 8.0
_CACHE_TTL_S = 6 * 60 * 60  # 6 hours
_MAX_RELEASES = 10
_NOTES_EXCERPT_CHARS = 500

# Matches the [project] version line in pyproject.toml, e.g. version = "0.1.0".
_VERSION_RE = re.compile(r'^version\s*=\s*"([^"]+)"', re.MULTILINE)

# The installed version cannot change for the lifetime of the process, so the
# pyproject.toml read happens at most once.
_current_version: str | None = None
_version_lock = threading.Lock()

# Serializes cache reads + GitHub fetches so concurrent /check and /releases
# requests cannot double-fetch or interleave cache writes.
_fetch_lock = threading.Lock()


def _read_current_version() -> str | None:
    """The app version from pyproject.toml, read once and cached in memory."""
    global _current_version
    with _version_lock:
        if _current_version is not None:
            return _current_version
        try:
            text = _PYPROJECT_PATH.read_text(encoding="utf-8")
        except OSError as exc:
            log.warning("updates: cannot read %s: %s", _PYPROJECT_PATH, exc)
            return None
        match = _VERSION_RE.search(text)
        if match is None:
            log.warning("updates: no version field found in pyproject.toml")
            return None
        _current_version = match.group(1)
        return _current_version


def _load_cache() -> dict[str, Any] | None:
    """The parsed on-disk cache, or None when missing/corrupt."""
    try:
        raw = json.loads(_CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict) or not isinstance(raw.get("releases"), list):
        return None
    return raw


def _save_cache(releases: list[dict[str, Any]]) -> None:
    """Persist the fetched releases; a write failure only degrades caching."""
    payload = {"fetched_at": time.time(), "releases": releases}
    try:
        _CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _CACHE_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except OSError as exc:
        log.warning("updates: failed to write cache %s: %s", _CACHE_PATH, exc)


def _fetch_releases() -> list[dict[str, Any]]:
    """Blocking GitHub releases fetch, normalized to the fields this module
    serves. Raises httpx.HTTPError / ValueError on any network or payload
    problem -- callers translate that into a soft error, never a 5xx."""
    with httpx.Client(timeout=_HTTP_TIMEOUT_S) as client:
        resp = client.get(
            _RELEASES_URL,
            params={"per_page": _MAX_RELEASES},
            headers={"Accept": "application/vnd.github+json"},
        )
        resp.raise_for_status()
        data = resp.json()
    if not isinstance(data, list):
        raise ValueError("unexpected GitHub releases payload (not a list)")
    releases: list[dict[str, Any]] = []
    for item in data[:_MAX_RELEASES]:
        if not isinstance(item, dict):
            continue
        releases.append(
            {
                "tag": item.get("tag_name"),
                "name": item.get("name"),
                "published_at": item.get("published_at"),
                "url": item.get("html_url"),
                "draft": bool(item.get("draft")),
                "prerelease": bool(item.get("prerelease")),
                "body": str(item.get("body") or ""),
            }
        )
    return releases


def _get_releases(force: bool) -> tuple[list[dict[str, Any]], str | None]:
    """(releases, error). Serves the on-disk cache while it is fresh (< 6h)
    unless ``force`` is set; on network failure returns ([], error_text)."""
    with _fetch_lock:
        cached = _load_cache()
        if not force and cached is not None:
            age = time.time() - float(cached.get("fetched_at", 0) or 0)
            if 0 <= age < _CACHE_TTL_S:
                return list(cached["releases"]), None
        try:
            releases = _fetch_releases()
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("updates: release fetch failed: %s", exc)
            return [], f"release check failed: {exc}"
        _save_cache(releases)
        return releases, None


def _version_tuple(version: str) -> tuple[int, ...] | None:
    """'v1.2.3' / '1.2.3-rc1' -> (1, 2, 3); None when not version-shaped."""
    parts = version.strip().lstrip("vV").split(".")
    nums: list[int] = []
    for part in parts:
        match = re.match(r"\d+", part)
        if match is None:
            return None
        nums.append(int(match.group(0)))
    return tuple(nums) if nums else None


def _is_newer(latest: str, current: str) -> bool | None:
    """Whether ``latest`` is strictly newer than ``current``; None when either
    string cannot be parsed numerically."""
    latest_t = _version_tuple(latest)
    current_t = _version_tuple(current)
    if latest_t is None or current_t is None:
        return None
    width = max(len(latest_t), len(current_t))
    latest_t += (0,) * (width - len(latest_t))
    current_t += (0,) * (width - len(current_t))
    return latest_t > current_t


@router.get("/check")
def check_updates(force: bool = False) -> dict[str, Any]:
    """Compare the installed version with the newest published GitHub release."""
    current = _read_current_version()
    releases, error = _get_releases(force=force)

    # Newest stable release first; fall back to a prerelease if that is all
    # the repo has published. Drafts are never candidates.
    latest = next((r for r in releases if not r["draft"] and not r["prerelease"]), None)
    if latest is None:
        latest = next((r for r in releases if not r["draft"]), None)

    if error is None and (latest is None or not latest.get("tag")):
        error = "no published releases found"
    if error is not None or latest is None:
        return {
            "current_version": current,
            "latest_version": None,
            "update_available": None,
            "release_url": None,
            "published_at": None,
            "notes_excerpt": None,
            "error": error,
        }

    tag = str(latest["tag"])
    latest_version = tag.lstrip("vV")
    update_available: bool | None = None
    if current is not None:
        update_available = _is_newer(tag, current)
    excerpt = latest["body"].strip()[:_NOTES_EXCERPT_CHARS] or None
    return {
        "current_version": current,
        "latest_version": latest_version,
        "update_available": update_available,
        "release_url": latest.get("url"),
        "published_at": latest.get("published_at"),
        "notes_excerpt": excerpt,
    }


@router.get("/releases")
def list_releases() -> dict[str, Any]:
    """Up to 10 recent releases for a restore-previous-version picker.

    ROLLBACK SCAFFOLD: this endpoint only surfaces release metadata and
    download-page URLs for a future rollback flow. Actual rollback is
    installer-driven (the user downloads and runs an older installer); the
    backend performs no version switching itself.
    """
    releases, error = _get_releases(force=False)
    items = [
        {
            "tag": r.get("tag"),
            "name": r.get("name"),
            "published_at": r.get("published_at"),
            "url": r.get("url"),
        }
        for r in releases
        if not r.get("draft")
    ][:_MAX_RELEASES]
    payload: dict[str, Any] = {"releases": items}
    if error is not None:
        payload["error"] = error
    return payload
