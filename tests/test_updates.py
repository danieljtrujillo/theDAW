"""Tests for the in-app updater (backend.modules.updates.router).

GitHub is never contacted: ``_get_releases`` is monkeypatched. The apply path
is exercised up to the point where it would pull, with ``git`` and the
supervisor flag faked so nothing on the developer's clone changes.
"""

from __future__ import annotations

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


def test_apply_refuses_dirty_tree(client, monkeypatch, tmp_path):
    (tmp_path / ".git").mkdir()
    monkeypatch.setattr(updates.shutil, "which", lambda name: "/usr/bin/git")
    monkeypatch.setattr(updates, "_tree_dirty", lambda: True)
    res = client.post("/api/updates/apply")
    assert res.status_code == 409
    assert "uncommitted" in res.json()["detail"]


def test_apply_starts_worker_and_reports_status(client, monkeypatch, tmp_path):
    (tmp_path / ".git").mkdir()
    monkeypatch.setattr(updates.shutil, "which", lambda name: "/usr/bin/git")
    monkeypatch.setattr(updates, "_tree_dirty", lambda: False)
    started: list[str] = []

    class _Thread:
        def __init__(self, target, daemon, name):
            started.append(name)

        def start(self):
            pass

    monkeypatch.setattr(updates.threading, "Thread", _Thread)
    body = client.post("/api/updates/apply").json()
    assert body["state"] == "running"
    assert started == ["updates-apply"]
    # A second click while running is a no-op that returns the same status.
    again = client.post("/api/updates/apply").json()
    assert again["state"] == "running"
    assert client.get("/api/updates/apply-status").json()["state"] == "running"
