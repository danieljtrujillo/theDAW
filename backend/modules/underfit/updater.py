"""Underfit upstream-update checker + applier.

underfit is vendored into theDAW as a git-subrepo (see ``underfit/.gitrepo``).
This module lets the app tell you when ``dada-bots/underfit`` has new commits and
apply them from the Underfit tab, without leaving theDAW.

  * ``check(force=False)`` — is upstream ahead of what we've synced? Uses
    ``git ls-remote`` (no fetch), cached to ``data/underfit_update.json`` so the
    network is hit at most every :data:`_CHECK_TTL` seconds.
  * ``apply()`` — ``git subrepo pull`` to merge upstream into our copy, then
    restarts the dashboard so the new code loads. **Guarded:** it refuses on a
    dirty theDAW tree, so it can never clobber your uncommitted work, and aborts
    cleanly on a merge conflict.

All git runs against theDAW's repo root; the subrepo lives at ``<root>/underfit``.
Every failure degrades to a clear message — a missing/slow git never breaks the
tab.
"""

from __future__ import annotations

import json
import logging
import subprocess
import time
from pathlib import Path
from threading import Lock
from typing import Optional

from . import sidecar

log = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parents[3]
_PREFIX = "underfit"
_SUBREPO_DIR = _REPO_ROOT / _PREFIX
_GITREPO = _SUBREPO_DIR / ".gitrepo"
_STATE = _REPO_ROOT / "data" / "underfit_update.json"
_DEFAULT_REMOTE = "https://github.com/dada-bots/underfit.git"
_DEFAULT_BRANCH = "main"
_CHECK_TTL = 900  # 15 min — don't poll the network more often than this

_lock = Lock()
_cache: dict = {}


def _run_git(args: list[str], timeout: int = 25, cwd: Optional[Path] = None):
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd or _REPO_ROOT),
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _read_gitrepo() -> dict:
    """Parse ``underfit/.gitrepo`` for remote / branch / last-pulled commit."""
    out = {"remote": _DEFAULT_REMOTE, "branch": _DEFAULT_BRANCH, "commit": ""}
    try:
        for raw in _GITREPO.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            for key in ("remote", "branch", "commit"):
                if line.startswith(key + " ="):
                    out[key] = line.split("=", 1)[1].strip()
    except OSError:
        pass
    out["remote"] = out["remote"] or _DEFAULT_REMOTE
    out["branch"] = out["branch"] or _DEFAULT_BRANCH
    return out


def _load_state() -> dict:
    try:
        return json.loads(_STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save_state(data: dict) -> None:
    try:
        _STATE.parent.mkdir(parents=True, exist_ok=True)
        _STATE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except OSError:
        pass


def _synced_sha(cfg: dict) -> str:
    """Upstream commit we're in sync with: the ``.gitrepo`` commit once a pull
    has recorded one, else the last value we persisted."""
    return cfg.get("commit") or _load_state().get("synced_upstream", "")


def _remote_head(remote: str, branch: str) -> Optional[str]:
    try:
        r = _run_git(["ls-remote", remote, branch], timeout=25)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.split()[0]
    except (subprocess.SubprocessError, OSError) as e:
        log.warning("underfit.updater: ls-remote failed: %s", e)
    return None


def check(force: bool = False) -> dict:
    """Return the current update status (cached unless ``force``)."""
    with _lock:
        now = time.time()
        if not force and _cache and now - _cache.get("_ts", 0) < _CHECK_TTL:
            return {k: v for k, v in _cache.items() if k != "_ts"}

        cfg = _read_gitrepo()
        synced = _synced_sha(cfg)
        upstream = _remote_head(cfg["remote"], cfg["branch"])

        # First run with no recorded baseline: adopt current upstream as synced
        # so we never cry "update" against an unknown base.
        if upstream and not synced:
            st = _load_state()
            st["synced_upstream"] = upstream
            _save_state(st)
            synced = upstream

        result = {
            "remote": cfg["remote"],
            "branch": cfg["branch"],
            "synced": synced,
            "upstream": upstream or "",
            "update_available": bool(upstream and synced and upstream != synced),
            "checked_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "error": None if upstream else "could not reach upstream",
        }
        _cache.clear()
        _cache.update(result)
        _cache["_ts"] = now
        return result


def _tree_dirty() -> bool:
    try:
        r = _run_git(["status", "--porcelain"], timeout=20)
        return bool(r.stdout.strip())
    except (subprocess.SubprocessError, OSError):
        return True  # can't tell → treat as dirty (safe: refuse the pull)


def _find_bash() -> Optional[str]:
    """git-subrepo is a bash tool; find a bash to run it through (Git Bash)."""
    for cand in ("bash", r"C:\Program Files\Git\bin\bash.exe", "/usr/bin/bash"):
        try:
            r = subprocess.run([cand, "-c", "true"], capture_output=True, timeout=10)
            if r.returncode == 0:
                return cand
        except (OSError, subprocess.SubprocessError):
            continue
    return None


def apply() -> dict:
    """Pull upstream into the subrepo. Never runs on a dirty tree."""
    with _lock:
        if _tree_dirty():
            return {
                "ok": False,
                "reason": "dirty_tree",
                "message": (
                    "theDAW has uncommitted changes. Commit or stash them first, "
                    "then update — this keeps your work safe."
                ),
            }
        bash = _find_bash()
        if not bash:
            return {
                "ok": False,
                "reason": "no_bash",
                "message": "git-subrepo needs Git Bash, which wasn't found on PATH.",
            }

        cfg = _read_gitrepo()
        root_posix = str(_REPO_ROOT).replace("\\", "/")
        cmd = (
            'source "$HOME/.git-subrepo/.rc" && '
            f'cd "{root_posix}" && '
            f"git subrepo pull {_PREFIX} --branch {cfg['branch']}"
        )
        try:
            r = subprocess.run(
                [bash, "-c", cmd], capture_output=True, text=True, timeout=300
            )
        except subprocess.SubprocessError as e:
            return {"ok": False, "reason": "exec", "message": str(e)}

        out = ((r.stdout or "") + (r.stderr or "")).strip()
        if r.returncode != 0:
            return {
                "ok": False,
                "reason": "pull_failed",
                "message": (
                    "Update failed (usually a merge conflict). Your tree may need "
                    "manual cleanup — run `git subrepo pull underfit` in a terminal."
                ),
                "output": out[-2000:],
            }

        # Success — record the new synced commit + restart the dashboard so the
        # freshly pulled code is what serves the tab.
        cfg = _read_gitrepo()
        st = _load_state()
        if cfg.get("commit"):
            st["synced_upstream"] = cfg["commit"]
        st["last_update"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        _save_state(st)
        _cache.clear()
        try:
            sidecar.stop()
            sidecar.ensure_running(wait_for_ready=False)
        except Exception as e:  # noqa: BLE001 — restart is best-effort
            log.warning("underfit.updater: dashboard restart after update failed: %s", e)

        return {"ok": True, "message": "Underfit updated from upstream.", "output": out[-2000:]}
