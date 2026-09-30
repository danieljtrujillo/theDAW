"""The backup routes answer only to this machine.

``refuse_cross_site`` stops a foreign web page, but a LAN script that sends no
``Origin``, ``Referer`` or ``Sec-Fetch-Site`` passes it, and the backend binds
0.0.0.0. Before the routes were held to ``require_loopback_or_launch_token``,
such a caller could restore an archive of its own over ``data/*.json`` (the
settings and the ``/clip-audio`` folder grants among them) or export the
user's keys into a folder it named.
"""

from __future__ import annotations

import json
import time
import zipfile
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.lib import known_paths
from backend.modules.backup import router as backup_router
from backend.modules.backup import service as backup_service

LAN_PEER = ("10.20.30.40", 51000)
LOOPBACK_PEER = ("127.0.0.1", 51000)


@pytest.fixture
def data(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Every root the backup module reads or writes, moved into tmp_path."""
    home = tmp_path / "home"
    home.mkdir()
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("theDAW_DATA_DIR", str(data))
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path / "generations"))
    monkeypatch.setattr(known_paths, "_STORE_PATH", data / "known_paths.json")
    monkeypatch.setattr(known_paths, "_GRANTS", {})
    return data


def _client(peer: tuple[str, int]) -> TestClient:
    app = FastAPI()
    app.include_router(backup_router.router, prefix="/api/backup")
    return TestClient(app, client=peer)


def _archive(path: Path, members: dict[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(
            backup_service.MANIFEST_NAME,
            json.dumps({"app": "theDAW", "roots": [{"id": "settings"}]}),
        )
        for name, value in members.items():
            zf.writestr(f"roots/settings/{name}", json.dumps(value))
    return path


def _wait_for_import(client: TestClient, job: str) -> dict[str, Any]:
    deadline = time.monotonic() + 30.0
    while True:
        status = client.get("/api/backup/import/status", params={"job": job}).json()
        if status["state"] != "running" or time.monotonic() > deadline:
            return status
        time.sleep(0.05)


def test_a_lan_caller_cannot_restore_an_archive_over_the_settings_and_grants(
    data: Path, tmp_path: Path
) -> None:
    settings = data / "settings.json"
    settings.write_text(json.dumps({"lan": {"https": False}}), encoding="utf-8")
    grants = data / "clip_audio_roots.json"
    grants.write_text(json.dumps({"v": 2, "roots": []}), encoding="utf-8")
    before = {p.name: p.read_bytes() for p in (settings, grants)}

    planted = tmp_path / "anywhere"
    planted.mkdir()
    archive = _archive(
        tmp_path / "share" / "theDAW-backup-planted.zip",
        {
            "settings.json": {"lan": {"https": True}},
            "clip_audio_roots.json": {"v": 2, "roots": [str(planted)]},
            "media_roots.json": [str(planted)],
        },
    )
    body = {"zip_path": str(archive), "mode": "replace"}

    refused = _client(LAN_PEER).post("/api/backup/import", json=body)

    assert refused.status_code == 403
    assert {p.name: p.read_bytes() for p in (settings, grants)} == before
    assert not (data / "media_roots.json").exists()

    # This machine's own UI still restores the same archive. The settings come
    # back; the folder grants never come from an archive, from anyone.
    local = _client(LOOPBACK_PEER)
    started = local.post("/api/backup/import", json=body)
    assert started.status_code == 200, started.text
    assert _wait_for_import(local, started.json()["job"])["state"] == "done"
    assert json.loads(settings.read_text(encoding="utf-8")) == {"lan": {"https": True}}
    assert grants.read_bytes() == before["clip_audio_roots.json"]
    assert not (data / "media_roots.json").exists()


def test_a_lan_caller_cannot_export_or_list_or_open_a_dialog(
    data: Path, tmp_path: Path
) -> None:
    (data / "settings.json").write_text("{}", encoding="utf-8")
    dest = tmp_path / "share"
    dest.mkdir()
    lan = _client(LAN_PEER)

    exported = lan.post(
        "/api/backup/export", json={"dest_dir": str(dest), "include": ["settings"]}
    )

    assert exported.status_code == 403
    assert list(dest.iterdir()) == []
    assert lan.get("/api/backup/manifest").status_code == 403
    assert lan.get("/api/backup/pick-folder").status_code == 403
    assert lan.get("/api/backup/export/status", params={"job": "x"}).status_code == 403
    assert lan.get("/api/backup/import/status", params={"job": "x"}).status_code == 403
