"""End-to-end tests for the /api/library router."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.library import router as library_router_module
from tests.test_library_store import _seed_generate_entry


@pytest.fixture
def client_with_root(tmp_path: Path, monkeypatch) -> TestClient:
    """Build a fresh app with the library router pointing at tmp_path. Resets
    the lazily-cached store so each test gets its own filesystem fixture."""
    # Force the module-level store to be re-created.
    monkeypatch.setattr(library_router_module, "_store", None)
    # Override the root via env var (default_library_root() honors it).
    monkeypatch.setenv("STABLEDAW_GENERATIONS_DIR", str(tmp_path))

    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    return TestClient(app)


def test_list_entries_endpoint_returns_empty_when_root_is_fresh(
    client_with_root, tmp_path
):
    r = client_with_root.get("/api/library/entries")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 0
    assert body["entries"] == []
    assert str(tmp_path) in body["root"]


def test_list_entries_includes_seeded_generation(client_with_root, tmp_path):
    _seed_generate_entry(tmp_path, "job_test", 0, extra_meta={"prompt": "endpoint"})

    r = client_with_root.get("/api/library/entries")
    assert r.status_code == 200
    body = r.json()

    assert body["count"] == 1
    assert body["entries"][0]["id"] == "job_test_00"
    assert body["entries"][0]["prompt"] == "endpoint"
    assert body["entries"][0]["audio_url"] == "/api/library/audio/job_test_00"


def test_get_single_entry_endpoint(client_with_root, tmp_path):
    _seed_generate_entry(tmp_path, "job_solo", 0)
    r = client_with_root.get("/api/library/entries/job_solo_00")
    assert r.status_code == 200
    assert r.json()["id"] == "job_solo_00"


def test_get_missing_entry_returns_404(client_with_root):
    r = client_with_root.get("/api/library/entries/no-such-entry")
    assert r.status_code == 404


def test_stream_audio_endpoint_returns_file_bytes(client_with_root, tmp_path):
    audio = b"RIFF\x00\x00\x00\x00WAVEdata fake"
    _seed_generate_entry(tmp_path, "job_audio", 0, audio_bytes=audio)

    r = client_with_root.get("/api/library/audio/job_audio_00")
    assert r.status_code == 200
    assert r.content == audio
    assert "audio" in r.headers.get("content-type", "")


def test_patch_entry_updates_favorite_and_tags(client_with_root, tmp_path):
    _seed_generate_entry(tmp_path, "job_patch", 0)

    r = client_with_root.patch(
        "/api/library/entries/job_patch_00",
        json={"favorite": True, "tags": ["alpha", "beta"], "notes": "hello"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["favorite"] is True
    assert body["tags"] == ["alpha", "beta"]
    assert body["notes"] == "hello"

    # Persistence check via fresh GET.
    r2 = client_with_root.get("/api/library/entries/job_patch_00")
    assert r2.json()["favorite"] is True


def test_patch_does_not_modify_backend_owned_fields(client_with_root, tmp_path):
    _seed_generate_entry(tmp_path, "job_lock", 0, extra_meta={"prompt": "original"})

    r = client_with_root.patch(
        "/api/library/entries/job_lock_00",
        json={"prompt": "should not change", "favorite": True},
    )
    assert r.status_code == 200
    assert r.json()["prompt"] == "original"
    assert r.json()["favorite"] is True


def test_delete_entry_removes_from_disk(client_with_root, tmp_path):
    _seed_generate_entry(tmp_path, "job_del", 0)
    r = client_with_root.delete("/api/library/entries/job_del_00")
    assert r.status_code == 200

    listed = client_with_root.get("/api/library/entries").json()
    assert listed["count"] == 0


def test_import_endpoint_creates_entry(client_with_root, tmp_path):
    audio = b"RIFF\x00\x00\x00\x00WAVEdata imported"
    r = client_with_root.post(
        "/api/library/import",
        files={"file": ("song.wav", audio, "audio/wav")},
        data={"metadata": json.dumps({"title": "From bucket", "source": "import"})},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "From bucket"
    assert body["source"] == "import"
    assert body["file_size_bytes"] == len(audio)

    # The streamed audio should round-trip.
    audio_r = client_with_root.get(body["audio_url"])
    assert audio_r.status_code == 200
    assert audio_r.content == audio


def test_import_endpoint_rejects_invalid_metadata_json(client_with_root):
    r = client_with_root.post(
        "/api/library/import",
        files={"file": ("song.wav", b"abc", "audio/wav")},
        data={"metadata": "{not valid"},
    )
    assert r.status_code == 400


def test_import_endpoint_rejects_empty_file(client_with_root):
    r = client_with_root.post(
        "/api/library/import",
        files={"file": ("song.wav", b"", "audio/wav")},
        data={"metadata": "{}"},
    )
    assert r.status_code == 400
