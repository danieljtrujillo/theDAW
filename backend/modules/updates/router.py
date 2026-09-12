"""FastAPI router for the updates module (prefix ``/api/updates``).

    GET  /check         compare the installed version against the latest GitHub release
    GET  /releases      up to 10 recent releases for a restore-previous-version picker
    POST /apply         update a git-clone install in place (pull, then restart)
    GET  /apply-status  progress of the last /apply

Install kinds. A clone (theDAW.bat, theDAW.sh, Pinokio, dev Electron) has a
``.git`` at the repo root: ``/apply`` pulls it and exits the backend with code
89 so the spawning supervisor syncs dependencies and respawns (see
backend/_update_sync.py). The packaged Electron app has no ``.git``: there the
Electron shell updates itself with electron-updater and the renderer never
calls ``/apply``; ``/check`` reports ``install_kind`` and the release assets so
the shell (or a macOS user, where the unsigned dmg cannot self-update) can act.

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
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException

from backend._update_sync import UPDATE_EXIT_CODE, run_dependency_sync

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
                "assets": [
                    {
                        "name": str(a.get("name") or ""),
                        "url": a.get("browser_download_url"),
                        "size": a.get("size"),
                    }
                    for a in (item.get("assets") or [])
                    if isinstance(a, dict) and a.get("browser_download_url")
                ],
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


def _install_kind() -> str:
    """'git' for a clone (bat/sh/Pinokio/dev Electron), 'packaged' for the
    installer build, whose resources/python tree carries no .git."""
    return "git" if (_REPO_ROOT / ".git").is_dir() else "packaged"


def _supervisor_present() -> bool:
    return os.environ.get("SA3_SUPERVISOR_PRESENT") == "1"


def _install_facts() -> dict[str, Any]:
    kind = _install_kind()
    return {
        "install_kind": kind,
        # A clone can be pulled by this backend; the packaged app is updated by
        # the Electron shell. Both are reported so the modal can pick a path.
        "can_apply": kind == "git" and shutil.which("git") is not None,
        # With a supervisor the backend restarts itself after the pull;
        # without one (raw `backend.run`) the user has to relaunch.
        "restart_mode": "auto" if _supervisor_present() else "manual",
    }


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
            "assets": [],
            **_install_facts(),
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
        "assets": list(latest.get("assets") or []),
        **_install_facts(),
    }


# ---------------------------------------------------------------------------
# Apply (git-clone installs)
# ---------------------------------------------------------------------------

_apply_lock = threading.Lock()
_apply: dict[str, Any] = {
    "state": "idle",  # idle | running | restarting | done | error
    "step": None,
    "message": "",
    "log_tail": "",
    "returncode": None,
    "restart_mode": None,
}
_LOG_TAIL_LINES = 40


def _apply_log(tail: list[str], line: str) -> None:
    tail.append(line.rstrip())
    del tail[:-_LOG_TAIL_LINES]
    with _apply_lock:
        _apply["log_tail"] = "\n".join(tail)


def _run_git(args: list[str], tail: list[str]) -> int:
    cmd = ["git", *args]
    _apply_log(tail, "$ " + " ".join(cmd))
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(_REPO_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            encoding="utf-8",
            errors="replace",
        )
    except OSError as exc:
        _apply_log(tail, f"could not run git: {exc}")
        return 1
    assert proc.stdout is not None
    for line in proc.stdout:
        _apply_log(tail, line)
    return proc.wait()


# Lockfiles the setup step rewrites on an ordinary run: `npm install` in
# frontend/ and electron-ui/, `uv sync` re-resolving. A clone dirtied only by
# those was dirtied by its own launcher, not by the user, so an update restores
# them instead of refusing. Refusing was a dead end for the Pinokio launcher,
# whose Update runs a bare `git pull` and died with "Your local changes to the
# following files would be overwritten by merge" with nothing the user could do
# about it from inside the app.
_TOOL_OWNED_PATHS = frozenset(
    {
        "uv.lock",
        "frontend/package-lock.json",
        "electron-ui/package-lock.json",
    }
)


def _dirty_paths() -> list[str] | None:
    """Tracked files with local modifications. None when git itself failed,
    which is NOT the same as a clean tree and must not be treated as one."""
    try:
        out = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=no"],
            cwd=str(_REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    paths: list[str] = []
    for line in out.stdout.splitlines():
        entry = line[3:].strip()
        if not entry:
            continue
        # A rename reads "old -> new"; the working-tree file is the new one.
        if " -> " in entry:
            entry = entry.split(" -> ", 1)[1]
        paths.append(entry.strip('"'))
    return paths


def _set_apply(**fields: Any) -> None:
    with _apply_lock:
        _apply.update(fields)


def _apply_worker() -> None:
    global _current_version
    tail: list[str] = []
    try:
        # Restore the lockfiles the launcher rewrote, or the pull refuses to
        # overwrite them. Checked again here, not just at the request, because
        # a launch can dirty the tree between the two.
        restore = sorted(p for p in (_dirty_paths() or []) if p in _TOOL_OWNED_PATHS)
        if restore:
            _set_apply(
                step="restore",
                message="Restoring lockfiles the setup step rewrote.",
            )
            _apply_log(
                tail, f"restoring launcher-rewritten files: {', '.join(restore)}"
            )
            _run_git(["checkout", "--", *restore], tail)
        _set_apply(step="pull", message="Pulling the latest code.")
        rc = _run_git(["pull", "--ff-only"], tail)
        if rc != 0:
            _set_apply(
                state="error",
                returncode=rc,
                message="git pull failed. The log below says why (a diverged branch "
                "needs a manual merge).",
            )
            return
        _set_apply(
            step="submodules", message="Refreshing the Magenta sidecar submodule."
        )
        rc = _run_git(["submodule", "update", "--init", "--recursive"], tail)
        if rc != 0:
            _set_apply(
                state="error",
                returncode=rc,
                message="git submodule update failed; see the log below.",
            )
            return
        # The version string is read once per process; forget it so a poll
        # during the restart window does not report the old number.
        with _version_lock:
            _current_version = None

        if _supervisor_present():
            # Dependencies sync in the supervisor after this process is gone
            # (backend/_update_sync.py) - never against a live venv.
            _set_apply(
                state="restarting",
                step="restart",
                message="Code updated. theDAW is installing dependencies and restarting; "
                "this page reconnects by itself.",
                returncode=0,
            )
            time.sleep(0.8)
            from backend.core.teardown import stop_all_sidecars

            try:
                stop_all_sidecars()
            except Exception:  # pragma: no cover - best effort before exit
                log.warning("updates: sidecar teardown failed", exc_info=True)
            os._exit(UPDATE_EXIT_CODE)

        # No supervisor: sync here (the only option) and ask for a relaunch.
        _set_apply(step="sync", message="Installing dependencies.")
        rc = run_dependency_sync(_REPO_ROOT, lambda line: _apply_log(tail, line))
        _set_apply(
            state="done" if rc == 0 else "error",
            step="relaunch",
            returncode=rc,
            message="Update installed. Close theDAW and launch it again to run the new version."
            if rc == 0
            else f"Dependency sync exited {rc}; relaunch theDAW (theDAW.bat / theDAW.sh) "
            "to finish the install.",
        )
    except Exception as exc:  # pragma: no cover - defensive
        log.exception("updates: apply failed")
        _set_apply(state="error", message=f"{type(exc).__name__}: {exc}")


@router.get("/apply-status")
def apply_status() -> dict[str, Any]:
    with _apply_lock:
        return dict(_apply)


@router.post("/apply")
def apply_update() -> dict[str, Any]:
    """Pull the latest code into a git-clone install and restart.

    409 when the tree has local edits or an apply is already running, 400 for
    the packaged app (the Electron shell updates that one), 503 when git is
    missing. The work runs on a thread; poll ``/apply-status``.
    """
    facts = _install_facts()
    if facts["install_kind"] != "git":
        raise HTTPException(
            status_code=400,
            detail="This is the installed (packaged) app; it updates through the desktop shell.",
        )
    if shutil.which("git") is None:
        raise HTTPException(
            status_code=503,
            detail="git is not on the backend's PATH, so the clone cannot be pulled.",
        )
    with _apply_lock:
        if _apply["state"] in ("running", "restarting"):
            return dict(_apply)
    dirty = _dirty_paths()
    if dirty is None:
        raise HTTPException(
            status_code=503,
            detail="git could not report this clone's status, so the update was not attempted.",
        )
    blocked = sorted(p for p in dirty if p not in _TOOL_OWNED_PATHS)
    if blocked:
        shown = ", ".join(blocked[:8])
        if len(blocked) > 8:
            shown += f", and {len(blocked) - 8} more"
        raise HTTPException(
            status_code=409,
            detail="This clone has uncommitted local changes, so the update would overwrite "
            f"them: {shown}. Commit or stash them, then update again.",
        )
    _set_apply(
        state="running",
        step="pull",
        message="Starting the update.",
        log_tail="",
        returncode=None,
        restart_mode=facts["restart_mode"],
    )
    threading.Thread(target=_apply_worker, daemon=True, name="updates-apply").start()
    with _apply_lock:
        return dict(_apply)


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
