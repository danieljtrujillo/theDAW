"""Tests for library media (video/image) entries: import, probing,
thumbnails, kind filtering, and the media/thumb streaming endpoints."""

from __future__ import annotations

import io
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.library import media as media_mod
from backend.modules.library import router as library_router_module
from backend.modules.library.store import LibraryStore
from tests.test_library_store import _seed_generate_entry


# ---- fixtures ---------------------------------------------------------------


def _png_bytes(*, alpha: bool, size: tuple[int, int] = (8, 6)) -> bytes:
    """A tiny PNG, RGBA (transparent) or RGB (opaque)."""
    from PIL import Image

    mode = "RGBA" if alpha else "RGB"
    color = (200, 40, 120, 128) if alpha else (200, 40, 120)
    im = Image.new(mode, size, color)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def _make_test_mp4(path: Path, seconds: float = 1.0) -> bool:
    """Render a tiny opaque test mp4 via ffmpeg. Returns False if ffmpeg
    is unavailable so the caller can skip."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        return False
    cmd = [
        ffmpeg,
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"testsrc=duration={seconds}:size=64x48:rate=10",
        "-pix_fmt",
        "yuv420p",
        str(path),
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=60)
    return proc.returncode == 0 and path.is_file()


@pytest.fixture
def client_with_root(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    return TestClient(app)


# ---- classify / probe -------------------------------------------------------


def test_classify_ext():
    assert media_mod.classify_ext("clip.mp4") == "video"
    assert media_mod.classify_ext("loop.WEBM") == "video"
    assert media_mod.classify_ext("art.png") == "image"
    assert media_mod.classify_ext("photo.JPG") == "image"
    assert media_mod.classify_ext("notes.txt") is None
    assert media_mod.classify_ext("song.wav") is None


def test_probe_image_alpha_vs_opaque(tmp_path: Path):
    rgba = tmp_path / "a.png"
    rgba.write_bytes(_png_bytes(alpha=True, size=(12, 9)))
    info = media_mod.probe_media(rgba, "image")
    assert info["width"] == 12 and info["height"] == 9
    assert info["has_alpha"] is True
    assert info["duration"] is None

    rgb = tmp_path / "b.png"
    rgb.write_bytes(_png_bytes(alpha=False))
    assert media_mod.probe_media(rgb, "image")["has_alpha"] is False


# ---- store import -----------------------------------------------------------


def test_import_image_creates_media_entry(tmp_path: Path):
    store = LibraryStore(tmp_path)
    rec = store.import_media(
        media_bytes=_png_bytes(alpha=True),
        filename="overlay.png",
        mime_type="image/png",
    )
    assert rec.kind == "image"
    assert rec.has_alpha is True
    assert rec.width == 8 and rec.height == 6
    assert rec.media_url == f"/api/library/media/{rec.id}"
    # audio_url falls back to the media URL so generic consumers never break.
    assert rec.audio_url == rec.media_url
    # Poster thumbnail rendered to disk.
    assert (tmp_path / rec.id / "thumb.jpg").is_file()
    assert rec.thumb_url == f"/api/library/media/{rec.id}/thumb"


def test_import_rejects_non_media(tmp_path: Path):
    store = LibraryStore(tmp_path)
    with pytest.raises(ValueError):
        store.import_media(
            media_bytes=b"not a media file",
            filename="notes.txt",
            mime_type="text/plain",
        )


def test_import_video(tmp_path: Path):
    src = tmp_path / "src.mp4"
    if not _make_test_mp4(src):
        pytest.skip("ffmpeg not available")
    store = LibraryStore(tmp_path)
    rec = store.import_media(
        media_bytes=src.read_bytes(),
        filename="clip.mp4",
        mime_type="video/mp4",
    )
    assert rec.kind == "video"
    assert rec.width == 64 and rec.height == 48
    assert rec.duration > 0
    assert rec.has_alpha is False
    assert (tmp_path / rec.id / "thumb.jpg").is_file()


# ---- kind filtering ---------------------------------------------------------


def test_list_kind_filter_isolates_audio_and_media(tmp_path: Path):
    store = LibraryStore(tmp_path)
    _seed_generate_entry(tmp_path, "job_audio", 0)
    store.import_media(
        media_bytes=_png_bytes(alpha=False),
        filename="pic.png",
        mime_type="image/png",
    )

    audio_only = store.list_entries(kinds={"audio"})
    assert {r.kind for r in audio_only} == {"audio"}

    media_only = store.list_entries(kinds={"video", "image"})
    assert {r.kind for r in media_only} == {"image"}

    everything = store.list_entries()
    assert {r.kind for r in everything} == {"audio", "image"}


# ---- endpoints --------------------------------------------------------------


def test_entries_endpoint_default_excludes_media(client_with_root, tmp_path):
    _seed_generate_entry(tmp_path, "job_a", 0)
    client_with_root.post(
        "/api/library/import-media",
        files={"file": ("pic.png", _png_bytes(alpha=True), "image/png")},
    )

    default = client_with_root.get("/api/library/entries").json()
    assert default["count"] == 1
    assert default["entries"][0]["kind"] == "audio"

    media = client_with_root.get("/api/library/entries?kind=media").json()
    assert media["count"] == 1
    assert media["entries"][0]["kind"] == "image"
    assert media["entries"][0]["has_alpha"] is True


def test_entries_endpoint_rejects_bad_kind(client_with_root):
    r = client_with_root.get("/api/library/entries?kind=bogus")
    assert r.status_code == 400


def test_import_media_endpoint_then_stream(client_with_root):
    png = _png_bytes(alpha=True, size=(10, 10))
    imp = client_with_root.post(
        "/api/library/import-media",
        files={"file": ("o.png", png, "image/png")},
    )
    assert imp.status_code == 200
    rec = imp.json()
    assert rec["kind"] == "image"
    entry_id = rec["id"]

    media = client_with_root.get(f"/api/library/media/{entry_id}")
    assert media.status_code == 200
    assert media.content == png

    thumb = client_with_root.get(f"/api/library/media/{entry_id}/thumb")
    assert thumb.status_code == 200
    assert "image/jpeg" in thumb.headers.get("content-type", "")


def test_import_media_endpoint_rejects_non_media(client_with_root):
    r = client_with_root.post(
        "/api/library/import-media",
        files={"file": ("notes.txt", b"hello", "text/plain")},
    )
    assert r.status_code == 415


def test_media_endpoint_404_for_audio_entry(client_with_root, tmp_path):
    _seed_generate_entry(tmp_path, "job_x", 0)
    # An audio entry is not reachable via the media stream.
    r = client_with_root.get("/api/library/media/job_x_00")
    assert r.status_code == 404
