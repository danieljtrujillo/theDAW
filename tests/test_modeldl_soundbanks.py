"""Sound bank downloads in the model download manager (``kind: "soundbank"``).

No network: downloads read ``file://`` URLs written by the test, and the
GitHub release lookup reads a canned response.
"""

from __future__ import annotations

import hashlib
import io
import json
import time
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.lib import known_paths
from backend.modules.modeldl import router as modeldl
from backend.modules.modeldl import soundbanks


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("theDAW_DATA_DIR", str(tmp_path / "data"))
    known_paths.set_store_path_for_tests(tmp_path / "known_paths.json")
    yield tmp_path / "data"
    known_paths.set_store_path_for_tests(None)


@pytest.fixture
def client(data_dir):
    with modeldl._LOCK:
        modeldl._REGISTRY.clear()
    app = FastAPI()
    app.include_router(modeldl.router, prefix="/api/models")
    with TestClient(app) as test_client:
        yield test_client
    with modeldl._LOCK:
        modeldl._REGISTRY.clear()


def _wait(client, job_id, timeout=5.0):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        jobs = client.get("/api/models/downloads").json()["jobs"]
        last = next((j for j in jobs if j["id"] == job_id), None)
        if last and last["status"] in ("done", "error"):
            return last
        time.sleep(0.02)
    raise AssertionError(f"job did not finish: {last!r}")


def _zip_with_banks(path):
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("SSO/Strings - Violins.sf2", b"RIFF-violins")
        zf.writestr("SSO/Brass - Horns.sf2", b"RIFF-horns")
        zf.writestr("SSO/readme.txt", b"licence text")
        zf.writestr("SSO/samples/skip.wav", b"not kept")
    return path


def test_catalog_lists_every_bank_with_its_licence(client):
    banks = client.get("/api/models/soundbanks").json()["banks"]
    by_id = {b["id"]: b for b in banks}
    assert set(by_id) == {
        "thedaw-orchestra",
        "sonatina-sf2",
        "sonatina-sfz",
        "virtual-playing-orchestra",
    }
    for bank in banks:
        assert bank["licence"]["name"]
        assert bank["licence"]["url"].startswith("https://")
        assert bank["licence"]["summary"]
        assert bank["installed"] == []
        assert "github" not in bank
    assert by_id["thedaw-orchestra"]["licence"]["spdx"] == "CC0-1.0"
    assert by_id["thedaw-orchestra"]["kind"] == "download"
    assert by_id["sonatina-sf2"]["size_bytes"] == 512_093_492
    assert by_id["sonatina-sfz"]["kind"] == "link"
    assert by_id["sonatina-sfz"]["loadable"] is False
    assert by_id["virtual-playing-orchestra"]["kind"] == "link"


def test_link_only_and_unknown_banks_are_refused(client):
    assert client.post("/api/models/soundbanks/nope/download").status_code == 404
    resp = client.post("/api/models/soundbanks/virtual-playing-orchestra/download")
    assert resp.status_code == 409
    assert "virtualplaying.com" in resp.json()["detail"]


def test_zip_download_unpacks_registers_and_reports(client, tmp_path, monkeypatch):
    archive = _zip_with_banks(tmp_path / "Sonatina SF2.zip")
    plan = soundbanks.DownloadPlan(
        [(archive.name, archive.as_uri(), archive.stat().st_size, None)], "test"
    )
    monkeypatch.setattr(soundbanks, "plan_download", lambda entry: plan)
    hooked = []
    monkeypatch.setattr(soundbanks, "_HOOKS", [])
    soundbanks.add_soundbank_hook(
        lambda path, entry: hooked.append((path.name, entry.id))
    )

    resp = client.post("/api/models/soundbanks/sonatina-sf2/download")
    assert resp.status_code == 200
    job = _wait(client, resp.json()["job_id"])
    assert job["status"] == "done", job["error_detail"]
    assert job["kind"] == "soundbank"
    assert job["licence"]["name"] == soundbanks.CC_SAMPLING_PLUS.name
    assert job["files"][0]["done"] is True
    assert job["files"][0]["bytes_done"] == archive.stat().st_size

    folder = soundbanks.bank_dir(soundbanks.get_entry("sonatina-sf2"))
    names = sorted(p.name for p in folder.iterdir())
    assert names == [
        "Brass - Horns.sf2",
        "Strings - Violins.sf2",
        "readme.txt",
        "soundbank.json",
    ]
    stamp = json.loads((folder / "soundbank.json").read_text(encoding="utf-8"))
    assert stamp["licence"] == soundbanks.CC_SAMPLING_PLUS.name
    assert sorted(hooked) == [
        ("Brass - Horns.sf2", "sonatina-sf2"),
        ("Strings - Violins.sf2", "sonatina-sf2"),
    ]
    recent = known_paths.recent("soundfont")
    assert {r["name"] for r in recent} == {"Brass - Horns.sf2", "Strings - Violins.sf2"}
    assert all(r["servable"] for r in recent)
    assert known_paths.installed_asset_path("soundbank:sonatina-sf2") is not None

    listed = client.get("/api/models/soundbanks").json()["banks"]
    sso = next(b for b in listed if b["id"] == "sonatina-sf2")
    assert len(sso["installed"]) == 2


def test_a_bad_digest_fails_the_job_and_leaves_nothing(client, tmp_path, monkeypatch):
    bank = tmp_path / "theDAW-Orchestra.sf3"
    bank.write_bytes(b"RIFF-orchestra")
    plan = soundbanks.DownloadPlan(
        [(bank.name, bank.as_uri(), bank.stat().st_size, "0" * 64)], "test"
    )
    monkeypatch.setattr(soundbanks, "plan_download", lambda entry: plan)
    job_id = client.post("/api/models/soundbanks/thedaw-orchestra/download").json()[
        "job_id"
    ]
    job = _wait(client, job_id)
    assert job["status"] == "error"
    assert "SHA-256" in job["error_detail"]
    folder = soundbanks.bank_dir(soundbanks.get_entry("thedaw-orchestra"))
    assert list(folder.iterdir()) == []


def test_a_good_digest_installs_the_bank(client, tmp_path, monkeypatch):
    bank = tmp_path / "theDAW-Orchestra.sf3"
    bank.write_bytes(b"RIFF-orchestra")
    digest = hashlib.sha256(bank.read_bytes()).hexdigest()
    plan = soundbanks.DownloadPlan([(bank.name, bank.as_uri(), None, digest)], "test")
    monkeypatch.setattr(soundbanks, "plan_download", lambda entry: plan)
    job_id = client.post("/api/models/soundbanks/thedaw-orchestra/download").json()[
        "job_id"
    ]
    job = _wait(client, job_id)
    assert job["status"] == "done", job["error_detail"]
    assert job["installed"][0].endswith("theDAW-Orchestra.sf3")


class _Resp(io.BytesIO):
    headers: dict = {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_github_asset_resolves_to_the_newest_published_release(monkeypatch):
    releases = [
        {"tag_name": "soundbank-orchestra-3", "draft": True, "assets": []},
        {
            "tag_name": "v0.3.0",
            "draft": False,
            "assets": [{"name": "theDAW-Orchestra.sf3"}],
        },
        {
            "tag_name": "soundbank-orchestra-2",
            "draft": False,
            "assets": [
                {
                    "name": "theDAW-Orchestra.sf3",
                    "browser_download_url": "https://example.test/2/theDAW-Orchestra.sf3",
                    "size": 1234,
                    "digest": "sha256:" + "ab" * 32,
                },
                {
                    "name": "theDAW-Orchestra.json",
                    "browser_download_url": "https://example.test/2/theDAW-Orchestra.json",
                    "size": 10,
                },
            ],
        },
        {
            "tag_name": "soundbank-orchestra-1",
            "draft": False,
            "assets": [
                {
                    "name": "theDAW-Orchestra.sf3",
                    "browser_download_url": "https://example.test/1/theDAW-Orchestra.sf3",
                    "size": 1,
                }
            ],
        },
    ]
    seen = []

    def fake_urlopen(req, timeout=None):
        seen.append(req.full_url)
        return _Resp(json.dumps(releases).encode())

    monkeypatch.setattr(soundbanks.urllib.request, "urlopen", fake_urlopen)
    entry = soundbanks.get_entry("thedaw-orchestra")
    found = soundbanks.resolve_github_asset(entry.github)
    assert seen == ["https://api.github.com/repos/gantasmo/theDAW/releases?per_page=50"]
    assert found["tag"] == "soundbank-orchestra-2"
    assert found["url"].endswith("/2/theDAW-Orchestra.sf3")
    assert found["sha256"] == "ab" * 32
    assert [e[0] for e in found["extras"]] == ["theDAW-Orchestra.json"]
    plan = soundbanks.plan_download(entry)
    assert [f[0] for f in plan.files] == [
        "theDAW-Orchestra.sf3",
        "theDAW-Orchestra.json",
    ]


def test_github_asset_missing_says_how_to_publish(monkeypatch):
    monkeypatch.setattr(
        soundbanks.urllib.request, "urlopen", lambda req, timeout=None: _Resp(b"[]")
    )
    with pytest.raises(FileNotFoundError, match="build_orchestra_sf3.py"):
        soundbanks.resolve_github_asset(soundbanks.get_entry("thedaw-orchestra").github)


def test_archive_members_never_escape_the_bank_folder(tmp_path):
    archive = tmp_path / "evil.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("../../outside.sf2", b"x")
        zf.writestr("C:/abs/also.sf3", b"y")
    folder = tmp_path / "bank"
    folder.mkdir()
    kept = soundbanks.unpack_archive(archive, folder)
    assert sorted(p.name for p in kept) == ["also.sf3", "outside.sf2"]
    assert all(p.parent == folder for p in kept)
    assert not archive.exists()
    assert not (tmp_path / "outside.sf2").exists()


def test_a_failing_hook_does_not_fail_registration(data_dir, tmp_path, monkeypatch):
    bank = tmp_path / "b.sf2"
    bank.write_bytes(b"RIFF")
    monkeypatch.setattr(soundbanks, "_HOOKS", [])

    def boom(path, entry):
        raise RuntimeError("registry down")

    called = []
    soundbanks.add_soundbank_hook(boom)
    soundbanks.add_soundbank_hook(lambda path, entry: called.append(path))
    soundbanks.register_downloaded_bank(bank, soundbanks.get_entry("sonatina-sf2"))
    assert called == [bank]
