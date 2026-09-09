"""Tests for library cover art: extraction at import, the cover route, and
the backfill that gives already-imported entries their artwork.

Fixtures are built here rather than committed as binaries — soundfile writes
a real (silent) FLAC / OGG / MP3 / WAV and mutagen embeds a picture in it, so
each container's own picture frame is exercised against real bytes.
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import struct
import threading
import zlib
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from backend.modules.library import router as library_router_module
from backend.modules.library.store import COVER_FILENAME, LibraryStore
from backend.modules.library.tags import (
    COVER_MAX_EDGE,
    MAX_EMBEDDED_COVER_BYTES,
    _cover_from_mp4,
    extract_embedded_cover,
    write_cover_image,
)

# ---- picture fixtures -------------------------------------------------------


def _png(size: tuple[int, int] = (64, 64), *, alpha: bool = False) -> bytes:
    mode = "RGBA" if alpha else "RGB"
    color = (200, 40, 120, 96) if alpha else (200, 40, 120)
    buf = io.BytesIO()
    Image.new(mode, size, color).save(buf, "PNG")
    return buf.getvalue()


def _jpeg(size: tuple[int, int] = (64, 64)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (30, 180, 90)).save(buf, "JPEG")
    return buf.getvalue()


def _png_claiming(width: int, height: int) -> bytes:
    """A PNG whose header CLAIMS an absurd size with no pixel data behind it.

    This is the shape of the attack the pixel bound exists for: Pillow reads
    the size from the header without decoding, so a 70-byte file can ask for a
    14-gigapixel allocation.
    """

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(b"\x00" * 16))
        + chunk(b"IEND", b"")
    )


# ---- audio fixtures ---------------------------------------------------------


def _silence(path: Path, fmt: str, seconds: float = 0.1) -> Path:
    frames = int(44100 * seconds)
    sf.write(str(path), np.zeros((frames, 2), dtype="float32"), 44100, format=fmt)
    return path


def _flac_picture(data: bytes, mime: str = "image/png", ptype: int = 3):
    from mutagen.flac import Picture

    picture = Picture()
    picture.type = ptype
    picture.mime = mime
    picture.desc = "front"
    picture.data = data
    return picture


def flac_with_art(path: Path, pictures: list[bytes] | None = None) -> Path:
    """A FLAC carrying its art in native Picture metadata blocks."""
    from mutagen.flac import FLAC

    _silence(path, "FLAC")
    if pictures:
        audio = FLAC(str(path))
        for data in pictures:
            audio.add_picture(_flac_picture(data))
        audio.save()
    return path


def ogg_with_art(path: Path, data: bytes | None = None, ptype: int = 3) -> Path:
    """An Ogg Vorbis file carrying base64 `metadata_block_picture` — the same
    frame the staged Opus album uses."""
    from mutagen.oggvorbis import OggVorbis

    _silence(path, "OGG")
    if data is not None:
        audio = OggVorbis(str(path))
        picture = _flac_picture(data, ptype=ptype)
        audio["metadata_block_picture"] = [
            base64.b64encode(picture.write()).decode("ascii")
        ]
        audio.save()
    return path


def mp3_with_art(
    path: Path, data: bytes | None = None, mime: str = "image/png"
) -> Path:
    """An MP3 carrying an ID3 APIC frame."""
    from mutagen.id3 import APIC
    from mutagen.mp3 import MP3

    _silence(path, "MP3")
    if data is not None:
        audio = MP3(str(path))
        if audio.tags is None:
            audio.add_tags()
        audio.tags.add(APIC(encoding=3, mime=mime, type=3, desc="", data=data))
        audio.save()
    return path


def wav_with_art(path: Path, data: bytes | None = None) -> Path:
    """A WAV carrying an ID3 chunk with an APIC frame."""
    from mutagen.id3 import APIC
    from mutagen.wave import WAVE

    _silence(path, "WAV")
    if data is not None:
        audio = WAVE(str(path))
        audio.add_tags()
        audio.tags.add(APIC(encoding=3, mime="image/png", type=3, desc="", data=data))
        audio.save()
    return path


# ---- harness ----------------------------------------------------------------


@pytest.fixture
def store(tmp_path: Path) -> LibraryStore:
    return LibraryStore(tmp_path / "library")


@pytest.fixture
def client_with_root(tmp_path: Path, monkeypatch) -> TestClient:
    """Same shape as the other library endpoint tests: a fresh app whose store
    points at tmp_path."""
    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path / "library"))
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    return TestClient(app)


_COVER_URL = re.compile(r"^/api/library/audio/(?P<id>[^/?]+)/cover\?v=(?P<stamp>\d+)$")


def _assert_cover_url(url: object, entry_id: str) -> str:
    """A cover URL is the route plus the file's mtime. The stamp is what makes
    a refreshed cover a NEW url instead of the same src with new bytes behind
    it, so every assertion on the shape checks for it."""
    assert isinstance(url, str), url
    match = _COVER_URL.match(url)
    assert match is not None, url
    assert match.group("id") == entry_id
    return match.group("stamp")


def _import(store: LibraryStore, path: Path):
    return store.import_blob(
        audio_bytes=path.read_bytes(),
        filename=path.name,
        mime_type="audio/flac",
        metadata={},
    )


# ---- extraction per container ----------------------------------------------


def test_flac_picture_block_is_extracted(tmp_path: Path):
    art = _png()
    path = flac_with_art(tmp_path / "song.flac", [art])
    assert extract_embedded_cover(path) == art


def test_ogg_metadata_block_picture_is_extracted(tmp_path: Path):
    art = _jpeg()
    path = ogg_with_art(tmp_path / "song.ogg", art)
    assert extract_embedded_cover(path) == art


def test_mp3_apic_frame_is_extracted(tmp_path: Path):
    art = _png()
    path = mp3_with_art(tmp_path / "song.mp3", art)
    assert extract_embedded_cover(path) == art


def test_wav_id3_chunk_is_extracted(tmp_path: Path):
    art = _png()
    path = wav_with_art(tmp_path / "song.wav", art)
    assert extract_embedded_cover(path) == art


def test_mp4_covr_atom_is_read():
    """No writer ships for M4A here, so the reader is exercised against a real
    MP4Tags object rather than a file."""
    from mutagen.mp4 import MP4Cover, MP4Tags

    art = _jpeg()
    tags = MP4Tags()
    tags["covr"] = [MP4Cover(art, imageformat=MP4Cover.FORMAT_JPEG)]

    class _Audio:
        pass

    audio = _Audio()
    audio.tags = tags
    assert _cover_from_mp4(audio) == art


def test_front_cover_wins_over_other_picture_types(tmp_path: Path):
    back, front = _png((16, 16)), _png((32, 32))
    path = tmp_path / "song.flac"
    _silence(path, "FLAC")
    from mutagen.flac import FLAC

    audio = FLAC(str(path))
    audio.add_picture(_flac_picture(back, ptype=4))  # 4 == back cover
    audio.add_picture(_flac_picture(front, ptype=3))
    audio.save()

    assert extract_embedded_cover(path) == front


def test_non_front_picture_is_used_when_there_is_no_front(tmp_path: Path):
    only = _png((16, 16))
    path = ogg_with_art(tmp_path / "song.ogg", only, ptype=4)
    assert extract_embedded_cover(path) == only


def test_an_unusable_front_does_not_hide_a_usable_back_cover(tmp_path: Path):
    """Picking the frame by type and validating afterwards threw away the only
    usable picture in the file. The front is still preferred — but only among
    pictures whose bytes survive the size gate."""
    back = _png((32, 32))
    path = tmp_path / "song.flac"
    _silence(path, "FLAC")
    from mutagen.flac import FLAC

    audio = FLAC(str(path))
    audio.add_picture(_flac_picture(b"", ptype=3))  # front cover, no bytes
    audio.add_picture(_flac_picture(back, ptype=4))
    audio.save()

    assert extract_embedded_cover(path) == back


def test_an_oversized_front_does_not_hide_a_usable_back_cover(tmp_path: Path):
    """Same rule for the other half of the gate: a front cover past the byte
    bound is skipped rather than swallowing the file's only real artwork.

    ID3 rather than FLAC because a FLAC metadata block cannot hold 24MB.
    """
    from mutagen.id3 import APIC
    from mutagen.mp3 import MP3

    back = _png((32, 32))
    huge = b"\x89PNG\r\n\x1a\n" + b"\x00" * MAX_EMBEDDED_COVER_BYTES
    path = _silence(tmp_path / "song.mp3", "MP3")
    audio = MP3(str(path))
    audio.add_tags()
    audio.tags.add(APIC(encoding=3, mime="image/png", type=4, desc="b", data=back))
    audio.tags.add(APIC(encoding=3, mime="image/png", type=3, desc="f", data=huge))
    audio.save()

    assert extract_embedded_cover(path) == back


def test_extraction_of_a_file_with_no_picture_is_none(tmp_path: Path):
    assert extract_embedded_cover(flac_with_art(tmp_path / "bare.flac")) is None


def test_extraction_never_raises_on_junk(tmp_path: Path):
    junk = tmp_path / "junk.flac"
    junk.write_bytes(b"not audio, not anything")
    assert extract_embedded_cover(junk) is None
    assert extract_embedded_cover(tmp_path / "missing.flac") is None


# ---- import ----------------------------------------------------------------


def test_import_with_embedded_art_lands_a_cover(store: LibraryStore, tmp_path: Path):
    path = flac_with_art(tmp_path / "song.flac", [_png((300, 300))])

    record = _import(store, path)

    cover = store.root / record.id / COVER_FILENAME
    assert cover.is_file()
    _assert_cover_url(record.cover_url, record.id)
    assert record.to_dict()["cover_url"] == record.cover_url
    with Image.open(cover) as im:
        assert im.format == "JPEG"
        assert im.size == (300, 300)


def test_import_without_art_still_succeeds(store: LibraryStore, tmp_path: Path):
    path = flac_with_art(tmp_path / "bare.flac")

    record = _import(store, path)

    assert record.cover_url is None
    assert not (store.root / record.id / COVER_FILENAME).exists()
    # The import itself is untouched by the absence of artwork.
    assert store.get_audio_path(record.id) is not None
    assert store.get_entry(record.id) is not None


def test_import_with_a_corrupt_picture_still_succeeds(
    store: LibraryStore, tmp_path: Path
):
    path = flac_with_art(tmp_path / "song.flac", [b"\x89PNG\r\n\x1a\n truncated"])

    record = _import(store, path)

    assert record.cover_url is None
    assert not (store.root / record.id / COVER_FILENAME).exists()
    assert store.get_entry(record.id) is not None


def test_import_with_an_absurdly_large_picture_is_refused(
    store: LibraryStore, tmp_path: Path
):
    path = flac_with_art(tmp_path / "song.flac", [_png_claiming(60_000, 60_000)])

    record = _import(store, path)

    assert record.cover_url is None
    assert not (store.root / record.id / COVER_FILENAME).exists()


def test_oversized_picture_bytes_are_refused_before_decoding(tmp_path: Path):
    out = tmp_path / COVER_FILENAME
    assert write_cover_image(b"\x00" * (MAX_EMBEDDED_COVER_BYTES + 1), out) is False
    assert not out.exists()


def test_cover_is_downscaled_to_the_bound(store: LibraryStore, tmp_path: Path):
    original = _png((1500, 1200))
    path = flac_with_art(tmp_path / "big.flac", [original])

    record = _import(store, path)

    cover = store.root / record.id / COVER_FILENAME
    with Image.open(cover) as im:
        assert max(im.size) == COVER_MAX_EDGE
        assert im.size == (COVER_MAX_EDGE, 512)  # aspect ratio preserved
    assert cover.stat().st_size < len(original)


def test_transparent_art_is_flattened_not_dropped(store: LibraryStore, tmp_path: Path):
    path = flac_with_art(tmp_path / "alpha.flac", [_png((64, 64), alpha=True)])

    record = _import(store, path)

    with Image.open(store.root / record.id / COVER_FILENAME) as im:
        assert im.mode == "RGB"


def test_a_failed_write_leaves_no_temp_file(tmp_path: Path):
    out = tmp_path / COVER_FILENAME
    assert write_cover_image(b"definitely not an image", out) is False
    assert list(tmp_path.iterdir()) == []


def test_a_rotated_cover_is_written_upright(tmp_path: Path):
    """A picture tagged with an EXIF orientation has to be transposed here:
    we re-encode without EXIF, so nothing downstream can straighten it."""
    source = Image.new("RGB", (400, 200), (10, 200, 10))
    exif = source.getexif()
    exif[274] = 6  # Orientation: rotate 90° CW to display
    buf = io.BytesIO()
    source.save(buf, "JPEG", exif=exif)

    out = tmp_path / COVER_FILENAME
    assert write_cover_image(buf.getvalue(), out) is True
    with Image.open(out) as im:
        assert im.size == (200, 400)


def test_concurrent_writes_to_one_entry_all_land(tmp_path: Path):
    """Two POSTs for the same entry run on FastAPI's threadpool at the same
    time. A shared temp filename let one call's cleanup delete the other's
    half-written file, so a cover was silently lost."""
    out = tmp_path / COVER_FILENAME
    red = _png((600, 600))
    blue = _jpeg((600, 600))
    results: list[bool] = []
    errors: list[Exception] = []

    def run(data: bytes) -> None:
        # write_cover_image promises never to raise; a thread that dies here
        # would otherwise just vanish, so collect it and assert on it below.
        for _ in range(6):
            try:
                results.append(write_cover_image(data, out))
            except Exception as e:
                errors.append(e)

    threads = [
        threading.Thread(target=run, args=(red,)),
        threading.Thread(target=run, args=(blue,)),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, errors
    assert all(results), "a concurrent write lost its cover"
    assert [p.name for p in tmp_path.iterdir()] == [COVER_FILENAME]


def test_a_failed_refresh_leaves_the_existing_cover_intact(
    store: LibraryStore, tmp_path: Path
):
    record = _import(store, flac_with_art(tmp_path / "song.flac", [_png((80, 80))]))
    cover = store.root / record.id / COVER_FILENAME
    before = cover.read_bytes()

    assert store.attach_cover(record.id, b"not an image") is None
    assert cover.read_bytes() == before


def test_reference_in_place_entries_get_their_cover(
    store: LibraryStore, tmp_path: Path
):
    """A folder import never copies the audio, but the artwork has to live
    under the library root for the route to serve it."""
    path = flac_with_art(tmp_path / "outside.flac", [_png()])

    record = store.register_reference(str(path), {"source": "folder"})

    assert record is not None
    _assert_cover_url(record.cover_url, record.id)
    assert (store.root / record.id / COVER_FILENAME).is_file()


def test_cover_does_not_masquerade_as_a_media_file(store: LibraryStore, tmp_path: Path):
    """`_resolve_media_file` scans for image extensions; our own cover.jpg must
    never be picked up as an entry's media."""
    record = _import(store, flac_with_art(tmp_path / "song.flac", [_png()]))
    entry_dir = store.root / record.id
    (entry_dir / "metadata.json").write_text(
        '{"kind": "video", "title": "x"}', encoding="utf-8"
    )

    assert store.get_media_path(record.id) is None


# ---- routes ----------------------------------------------------------------


def _upload(client: TestClient, path: Path) -> str:
    r = client.post(
        "/api/library/import",
        files={"file": (path.name, path.read_bytes(), "audio/flac")},
        data={"metadata": "{}"},
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_cover_route_serves_the_jpeg(client_with_root: TestClient, tmp_path: Path):
    entry_id = _upload(client_with_root, flac_with_art(tmp_path / "s.flac", [_png()]))

    r = client_with_root.get(f"/api/library/audio/{entry_id}/cover")

    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    assert r.content[:2] == b"\xff\xd8"  # JPEG SOI


def test_cover_route_serves_the_versioned_url_verbatim(
    client_with_root: TestClient, tmp_path: Path
):
    """The URL the record hands out carries a `?v=` stamp; the route has to
    serve that URL as-is, not just its bare path."""
    entry_id = _upload(client_with_root, flac_with_art(tmp_path / "s.flac", [_png()]))
    url = client_with_root.get(f"/api/library/entries/{entry_id}").json()["cover_url"]

    assert client_with_root.get(url).status_code == 200


def test_the_cover_url_stamp_follows_the_file(
    client_with_root: TestClient, tmp_path: Path
):
    """New bytes under the same filename must produce a new URL, or the
    browser keeps painting the old art from cache. `os.utime` stands in for a
    later rewrite so the assertion never races the filesystem clock."""
    entry_id = _upload(client_with_root, flac_with_art(tmp_path / "s.flac", [_png()]))
    cover = library_router_module.get_store().root / entry_id / COVER_FILENAME

    def stamp() -> str:
        payload = client_with_root.get(f"/api/library/entries/{entry_id}").json()
        return _assert_cover_url(payload["cover_url"], entry_id)

    before = stamp()
    assert int(before) == int(cover.stat().st_mtime * 1000)

    later = cover.stat().st_mtime + 5
    os.utime(cover, (later, later))

    after = stamp()
    assert after != before
    assert int(after) == int(later * 1000)


def test_cover_route_404s_without_art(client_with_root: TestClient, tmp_path: Path):
    entry_id = _upload(client_with_root, flac_with_art(tmp_path / "bare.flac"))

    r = client_with_root.get(f"/api/library/audio/{entry_id}/cover")

    assert r.status_code == 404
    assert entry_id in r.json()["detail"]


def test_cover_route_404s_for_an_unknown_entry(client_with_root: TestClient):
    assert client_with_root.get("/api/library/audio/nope/cover").status_code == 404


def test_entry_payloads_carry_the_cover_url(
    client_with_root: TestClient, tmp_path: Path
):
    with_art = _upload(client_with_root, flac_with_art(tmp_path / "a.flac", [_png()]))
    without = _upload(client_with_root, flac_with_art(tmp_path / "b.flac"))

    listed = {
        e["id"]: e
        for e in client_with_root.get("/api/library/entries").json()["entries"]
    }
    _assert_cover_url(listed[with_art]["cover_url"], with_art)
    assert listed[without]["cover_url"] is None

    single = client_with_root.get(f"/api/library/entries/{with_art}").json()
    _assert_cover_url(single["cover_url"], with_art)


def test_post_cover_accepts_an_explicit_image(
    client_with_root: TestClient, tmp_path: Path
):
    entry_id = _upload(client_with_root, flac_with_art(tmp_path / "bare.flac"))

    r = client_with_root.post(
        f"/api/library/audio/{entry_id}/cover",
        files={"file": ("art.png", _png((120, 120)), "image/png")},
    )

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == entry_id
    assert body["source"] == "upload"
    _assert_cover_url(body["cover_url"], entry_id)
    assert (
        client_with_root.get(f"/api/library/audio/{entry_id}/cover").status_code == 200
    )


def test_post_cover_rereads_the_embedded_art(
    client_with_root: TestClient, tmp_path: Path
):
    entry_id = _upload(client_with_root, flac_with_art(tmp_path / "s.flac", [_png()]))
    store = library_router_module.get_store()
    (store.root / entry_id / COVER_FILENAME).unlink()

    r = client_with_root.post(f"/api/library/audio/{entry_id}/cover")

    assert r.status_code == 200, r.text
    assert r.json()["source"] == "embedded"
    assert (store.root / entry_id / COVER_FILENAME).is_file()


def test_post_cover_422s_when_there_is_nothing_to_read(
    client_with_root: TestClient, tmp_path: Path
):
    entry_id = _upload(client_with_root, flac_with_art(tmp_path / "bare.flac"))

    r = client_with_root.post(f"/api/library/audio/{entry_id}/cover")

    assert r.status_code == 422


def test_post_cover_422s_on_an_unusable_upload(
    client_with_root: TestClient, tmp_path: Path
):
    entry_id = _upload(client_with_root, flac_with_art(tmp_path / "bare.flac"))

    r = client_with_root.post(
        f"/api/library/audio/{entry_id}/cover",
        files={"file": ("art.png", b"not an image", "image/png")},
    )

    assert r.status_code == 422


def test_post_cover_404s_for_an_unknown_entry(client_with_root: TestClient):
    r = client_with_root.post(
        "/api/library/audio/nope/cover",
        files={"file": ("art.png", _png(), "image/png")},
    )
    assert r.status_code == 404


def test_post_cover_404s_for_a_media_entry(
    client_with_root: TestClient, tmp_path: Path
):
    """A video/image entry posters itself from thumb.jpg and every read path
    reports its cover_url as None. Accepting one here answered 200 and left
    art on disk that no surface could ever show."""
    entry_dir = tmp_path / "library" / "vid1"
    entry_dir.mkdir(parents=True)
    (entry_dir / "clip.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64)
    (entry_dir / "metadata.json").write_text(
        json.dumps(
            {
                "id": "vid1",
                "kind": "video",
                "title": "clip",
                "filename": "clip.mp4",
                "media_filename": "clip.mp4",
            }
        ),
        encoding="utf-8",
    )

    r = client_with_root.post(
        "/api/library/audio/vid1/cover",
        files={"file": ("art.png", _png(), "image/png")},
    )

    assert r.status_code == 404
    assert not (entry_dir / COVER_FILENAME).exists()
    assert client_with_root.get("/api/library/audio/vid1/cover").status_code == 404


# ---- backfill --------------------------------------------------------------


def test_backfill_attaches_art_to_entries_that_have_none(
    client_with_root: TestClient, tmp_path: Path
):
    entry_id = _upload(client_with_root, flac_with_art(tmp_path / "s.flac", [_png()]))
    store = library_router_module.get_store()
    (store.root / entry_id / COVER_FILENAME).unlink()  # an entry from before covers
    assert (
        client_with_root.get("/api/library/entries").json()["entries"][0]["cover_url"]
        is None
    )

    r = client_with_root.post("/api/library/covers/backfill")

    assert r.status_code == 200
    assert r.json() == {"scanned": 1, "written": 1, "skipped": 0, "no_cover": 0}
    _assert_cover_url(
        client_with_root.get("/api/library/entries").json()["entries"][0]["cover_url"],
        entry_id,
    )


def test_backfill_counts_entries_with_no_embedded_art(
    client_with_root: TestClient, tmp_path: Path
):
    _upload(client_with_root, flac_with_art(tmp_path / "bare.flac"))

    assert client_with_root.post("/api/library/covers/backfill").json() == {
        "scanned": 1,
        "written": 0,
        "skipped": 0,
        "no_cover": 1,
    }


def test_backfill_is_idempotent_unless_overwriting(
    client_with_root: TestClient, tmp_path: Path
):
    entry_id = _upload(client_with_root, flac_with_art(tmp_path / "s.flac", [_png()]))
    cover = library_router_module.get_store().root / entry_id / COVER_FILENAME
    cover.write_bytes(_jpeg((10, 10)))  # a hand-set cover the rerun must keep

    first = client_with_root.post("/api/library/covers/backfill").json()
    assert first == {"scanned": 1, "written": 0, "skipped": 1, "no_cover": 0}
    with Image.open(cover) as im:
        assert im.size == (10, 10)

    second = client_with_root.post(
        "/api/library/covers/backfill", json={"overwrite": True}
    ).json()
    assert second == {"scanned": 1, "written": 1, "skipped": 0, "no_cover": 0}
    with Image.open(cover) as im:
        assert im.size == (64, 64)


def test_backfill_rejects_a_nonsense_limit(client_with_root: TestClient):
    r = client_with_root.post("/api/library/covers/backfill", json={"limit": 0})
    assert r.status_code == 400


def test_backfill_honours_its_limit(client_with_root: TestClient, tmp_path: Path):
    for i in range(3):
        _upload(client_with_root, flac_with_art(tmp_path / f"s{i}.flac", [_png()]))
    store = library_router_module.get_store()
    for record in store.list_entries():
        (store.root / record.id / COVER_FILENAME).unlink()

    assert (
        client_with_root.post("/api/library/covers/backfill", json={"limit": 2}).json()[
            "written"
        ]
        == 2
    )
