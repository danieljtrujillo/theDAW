"""A sound bank the download manager installs (backend/modules/modeldl
soundbanks) is listed by the soundfont bank registry (backend/modules/
soundfonts) the moment it lands: GET /api/soundfonts shows it with its presets,
an offset and the catalog entry it came from, with no restart.

No network: the download reads a ``file://`` URL written by the test.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.lib import known_paths, launch_token
from backend.modules.modeldl import router as modeldl
from backend.modules.modeldl import soundbanks
from backend.modules.soundfonts import store
from backend.modules.soundfonts.router import router as soundfonts_router
from tests.test_soundfonts_module import make_sf2


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("theDAW_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv(launch_token.ENV_VAR, raising=False)
    known_paths.set_store_path_for_tests(tmp_path / "known_paths.json")
    store.set_root_for_tests(tmp_path / "soundfonts")
    with modeldl._LOCK:
        modeldl._REGISTRY.clear()
    app = FastAPI()
    app.include_router(modeldl.router, prefix="/api/models")
    app.include_router(soundfonts_router, prefix="/api/soundfonts")
    with TestClient(app, client=("127.0.0.1", 51000)) as test_client:
        yield test_client
    with modeldl._LOCK:
        modeldl._REGISTRY.clear()
    store.set_root_for_tests(None)
    known_paths.set_store_path_for_tests(None)


def _wait(client: TestClient, job_id: str, timeout: float = 5.0) -> dict:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        jobs = client.get("/api/models/downloads").json()["jobs"]
        last = next((j for j in jobs if j["id"] == job_id), None)
        if last and last["status"] in ("done", "error"):
            return last
        time.sleep(0.02)
    raise AssertionError(f"job did not finish: {last!r}")


def _download(client: TestClient) -> dict:
    resp = client.post("/api/models/soundbanks/thedaw-orchestra/download")
    assert resp.status_code == 200
    job = _wait(client, resp.json()["job_id"])
    assert job["status"] == "done", job["error_detail"]
    return job


def _serve_orchestra(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    source = tmp_path / "published" / "theDAW-Orchestra.sf3"
    source.parent.mkdir(parents=True)
    source.write_bytes(
        make_sf2(
            "theDAW Orchestra",
            [("Violins", 40, 0), ("Flute Staccato", 73, 1), ("Horns", 60, 0)],
        )
    )
    plan = soundbanks.DownloadPlan(
        [(source.name, source.as_uri(), source.stat().st_size, None)], "test"
    )
    monkeypatch.setattr(soundbanks, "plan_download", lambda entry: plan)
    return source


def test_the_registry_hooks_the_download_manager_at_import():
    assert store.on_bank_downloaded in soundbanks._HOOKS


def test_a_downloaded_bank_is_listed_without_a_restart(client, tmp_path, monkeypatch):
    _serve_orchestra(tmp_path, monkeypatch)
    assert client.get("/api/soundfonts").json()["banks"] == []

    _download(client)

    banks = client.get("/api/soundfonts").json()["banks"]
    assert len(banks) == 1
    bank = banks[0]
    assert bank["download_id"] == "thedaw-orchestra"
    assert bank["name"] == "theDAW Orchestra"
    assert bank["offset"] == store.USER_OFFSET_FIRST
    assert bank["span"] == 2
    assert {(p["bank"], p["program"]) for p in bank["presets"]} == {
        (0, 40),
        (1, 73),
        (0, 60),
    }
    installed = soundbanks.bank_dir(soundbanks.get_entry("thedaw-orchestra"))
    assert Path(bank["path"]) == (installed / "theDAW-Orchestra.sf3").resolve()
    # The synths fetch its bytes from the registry like any user bank.
    got = client.get(f"/api/soundfonts/{bank['id']}/file")
    assert got.status_code == 200
    assert got.content == (installed / "theDAW-Orchestra.sf3").read_bytes()


def test_a_second_download_keeps_its_listing_and_offset(client, tmp_path, monkeypatch):
    _serve_orchestra(tmp_path, monkeypatch)
    _download(client)
    first = client.get("/api/soundfonts").json()["banks"]
    _download(client)
    second = client.get("/api/soundfonts").json()["banks"]
    assert [b["id"] for b in second] == [b["id"] for b in first]
    assert second[0]["offset"] == first[0]["offset"]


def test_removing_a_downloaded_bank_deletes_it_from_disk(client, tmp_path, monkeypatch):
    _serve_orchestra(tmp_path, monkeypatch)
    _download(client)
    bank = client.get("/api/soundfonts").json()["banks"][0]
    assert client.delete(f"/api/soundfonts/{bank['id']}").status_code == 200
    assert not Path(bank["path"]).exists(), "the downloaded file is deleted"
    # The next read does not list it again, and the catalog offers the download again.
    assert client.get("/api/soundfonts").json()["banks"] == []
    listed = client.get("/api/models/soundbanks").json()["banks"]
    assert next(b for b in listed if b["id"] == "thedaw-orchestra")["installed"] == []
    # A new download lists it again.
    _download(client)
    assert len(client.get("/api/soundfonts").json()["banks"]) == 1


def test_a_bank_downloaded_before_the_registry_listed_downloads_is_listed(
    client, tmp_path, monkeypatch
):
    _serve_orchestra(tmp_path, monkeypatch)
    # A download made while the hook was not there (an earlier build).
    monkeypatch.setattr(soundbanks, "_HOOKS", [])
    _download(client)
    assert store.list_banks() == []
    banks = client.get("/api/soundfonts").json()["banks"]
    assert [b["download_id"] for b in banks] == ["thedaw-orchestra"]
    assert banks[0]["offset"] == store.USER_OFFSET_FIRST
    # Listed once: a second read adds nothing.
    assert store.sync_downloaded() == 0
    assert len(client.get("/api/soundfonts").json()["banks"]) == 1


def test_an_unreadable_download_is_not_listed(client, tmp_path, monkeypatch):
    source = tmp_path / "published" / "theDAW-Orchestra.sf3"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"RIFF-not-a-bank")
    plan = soundbanks.DownloadPlan(
        [(source.name, source.as_uri(), source.stat().st_size, None)], "test"
    )
    monkeypatch.setattr(soundbanks, "plan_download", lambda entry: plan)
    _download(client)
    assert client.get("/api/soundfonts").json()["banks"] == []
