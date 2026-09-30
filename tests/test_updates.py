"""Tests for the in-app updater (backend.modules.updates.router).

GitHub is never contacted: ``_get_releases`` is monkeypatched. The apply path
is exercised up to the point where it would pull, with ``git`` and the
supervisor flag faked so nothing on the developer's clone changes.
"""

from __future__ import annotations

import subprocess
from datetime import datetime
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.updates import router as updates


@pytest.fixture
def client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setattr(updates, "_current_version", None)
    monkeypatch.setattr(updates, "_PYPROJECT_PATH", tmp_path / "pyproject.toml")
    (tmp_path / "pyproject.toml").write_text('[project]\nversion = "0.1.5"\n')
    monkeypatch.setattr(updates, "_CACHE_PATH", tmp_path / "updates_check.json")
    monkeypatch.setattr(updates, "_REPO_ROOT", tmp_path)
    with updates._apply_lock:
        updates._apply.update(
            state="idle", step=None, message="", log_tail="", returncode=None
        )
    app = FastAPI()
    app.include_router(updates.router, prefix="/api/updates")
    return TestClient(app)


def _release(tag: str) -> dict:
    return {
        "tag": tag,
        "name": f"theDAW {tag}",
        "published_at": "2026-09-07T00:00:00Z",
        "url": f"https://github.com/gantasmo/theDAW/releases/tag/{tag}",
        "draft": False,
        "prerelease": False,
        "body": "notes",
        "assets": [
            {
                "name": "theDAW-Setup-0.1.6.exe",
                "url": "https://example.invalid/theDAW-Setup-0.1.6.exe",
                "size": 1,
            }
        ],
    }


def test_check_reports_install_kind_and_assets(client, monkeypatch, tmp_path):
    monkeypatch.setattr(
        updates, "_get_releases", lambda force: ([_release("v0.1.6")], None)
    )
    monkeypatch.setenv("SA3_SUPERVISOR_PRESENT", "1")
    (tmp_path / ".git").mkdir()
    body = client.get("/api/updates/check").json()
    assert body["update_available"] is True
    assert body["latest_version"] == "0.1.6"
    assert body["install_kind"] == "git"
    assert body["restart_mode"] == "auto"
    assert body["assets"][0]["name"] == "theDAW-Setup-0.1.6.exe"


def test_check_packaged_without_git_dir(client, monkeypatch):
    monkeypatch.setattr(
        updates, "_get_releases", lambda force: ([_release("v0.1.6")], None)
    )
    monkeypatch.delenv("SA3_SUPERVISOR_PRESENT", raising=False)
    body = client.get("/api/updates/check").json()
    assert body["install_kind"] == "packaged"
    assert body["can_apply"] is False
    assert body["restart_mode"] == "manual"


def test_apply_refuses_packaged_install(client):
    res = client.post("/api/updates/apply")
    assert res.status_code == 400
    assert "desktop shell" in res.json()["detail"]


class _NoopThread:
    """Stands in for threading.Thread so /apply returns without doing the work."""

    def __init__(self, target, daemon, name):
        pass

    def start(self) -> None:
        pass


def test_apply_refuses_dirty_tree(client, monkeypatch, tmp_path):
    (tmp_path / ".git").mkdir()
    monkeypatch.setattr(updates.shutil, "which", lambda name: "/usr/bin/git")
    monkeypatch.setattr(updates, "_dirty_paths", lambda: ["backend/server.py"])
    res = client.post("/api/updates/apply")
    assert res.status_code == 409
    detail = res.json()["detail"]
    assert "uncommitted" in detail
    # The old message named nothing, which left the user guessing what to stash.
    assert "backend/server.py" in detail


def test_apply_ignores_launcher_rewritten_lockfiles(client, monkeypatch, tmp_path):
    """A clone that has only been launched has uv.lock / package-lock.json
    modified by its own setup step. That must not block the update -- it is the
    exact state Pinokio's Update died in."""
    (tmp_path / ".git").mkdir()
    monkeypatch.setattr(updates.shutil, "which", lambda name: "/usr/bin/git")
    monkeypatch.setattr(
        updates,
        "_dirty_paths",
        lambda: ["uv.lock", "frontend/package-lock.json"],
    )
    monkeypatch.setattr(updates.threading, "Thread", _NoopThread)
    body = client.post("/api/updates/apply").json()
    assert body["state"] == "running"


def test_apply_refuses_when_git_status_fails(client, monkeypatch, tmp_path):
    """A git that cannot report status is not a clean tree."""
    (tmp_path / ".git").mkdir()
    monkeypatch.setattr(updates.shutil, "which", lambda name: "/usr/bin/git")
    monkeypatch.setattr(updates, "_dirty_paths", lambda: None)
    res = client.post("/api/updates/apply")
    assert res.status_code == 503


def test_apply_starts_worker_and_reports_status(client, monkeypatch, tmp_path):
    (tmp_path / ".git").mkdir()
    monkeypatch.setattr(updates.shutil, "which", lambda name: "/usr/bin/git")
    monkeypatch.setattr(updates, "_dirty_paths", lambda: [])
    started: list[str] = []

    class _Thread(_NoopThread):
        def __init__(self, target, daemon, name):
            started.append(name)

    monkeypatch.setattr(updates.threading, "Thread", _Thread)
    body = client.post("/api/updates/apply").json()
    assert body["state"] == "running"
    assert started == ["updates-apply"]
    # A second click while running is a no-op that returns the same status.
    again = client.post("/api/updates/apply").json()
    assert again["state"] == "running"
    assert client.get("/api/updates/apply-status").json()["state"] == "running"


def test_build_reports_sha_and_start_time(client, monkeypatch):
    monkeypatch.setattr(updates, "_BUILD_SHA", "abc1234")
    monkeypatch.setattr(updates, "_STARTED_AT", "2026-09-18T12:00:00.000000Z")
    body = client.get("/api/updates/build").json()
    assert body == {"git_sha": "abc1234", "started_at": "2026-09-18T12:00:00.000000Z"}


def test_build_started_at_is_utc_iso():
    started = updates._STARTED_AT
    assert started.endswith("Z")
    datetime.fromisoformat(started.replace("Z", "+00:00"))


def test_build_sha_env_override_wins(monkeypatch, tmp_path):
    def _no_git(*args, **kwargs):
        raise AssertionError("git must not run when THEDAW_BUILD_SHA is set")

    monkeypatch.setenv("THEDAW_BUILD_SHA", "  deadbee  ")
    monkeypatch.setattr(updates.subprocess, "run", _no_git)
    assert updates._resolve_build_sha(tmp_path) == "deadbee"


def test_build_sha_reads_git(monkeypatch, tmp_path):
    calls: list[list[str]] = []

    def _fake_run(cmd, **kwargs):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout="f00ba12\n", stderr="")

    monkeypatch.delenv("THEDAW_BUILD_SHA", raising=False)
    monkeypatch.setattr(updates.subprocess, "run", _fake_run)
    assert updates._resolve_build_sha(tmp_path) == "f00ba12"
    assert calls == [["git", "-C", str(tmp_path), "rev-parse", "--short", "HEAD"]]


@pytest.mark.parametrize(
    "failure",
    [
        FileNotFoundError("git"),
        subprocess.TimeoutExpired(["git"], 5),
        "nonzero",
    ],
)
def test_build_sha_git_failure_is_null(monkeypatch, tmp_path, failure):
    def _fake_run(cmd, **kwargs):
        if failure == "nonzero":
            return subprocess.CompletedProcess(cmd, 128, stdout="", stderr="fatal")
        raise failure

    monkeypatch.delenv("THEDAW_BUILD_SHA", raising=False)
    monkeypatch.setattr(updates.subprocess, "run", _fake_run)
    assert updates._resolve_build_sha(tmp_path) is None


def test_build_endpoint_null_sha(client, monkeypatch):
    monkeypatch.setattr(updates, "_BUILD_SHA", None)
    body = client.get("/api/updates/build").json()
    assert body["git_sha"] is None
    assert isinstance(body["started_at"], str)
