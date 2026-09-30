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
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))

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


def test_entry_path_endpoint_returns_the_audio_file(client_with_root, tmp_path):
    _seed_generate_entry(tmp_path, "job_path", 0)

    r = client_with_root.get("/api/library/entries/job_path_00/path")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == "job_path_00"
    assert Path(body["path"]) == (tmp_path / "job_path" / "00" / "output.wav").resolve()


def test_entry_path_endpoint_404_for_unknown_entry(client_with_root):
    r = client_with_root.get("/api/library/entries/no-such-entry/path")
    assert r.status_code == 404


def test_stream_audio_endpoint_returns_file_bytes(client_with_root, tmp_path):
    audio = b"RIFF\x00\x00\x00\x00WAVEdata fake"
    _seed_generate_entry(tmp_path, "job_audio", 0, audio_bytes=audio)

    r = client_with_root.get("/api/library/audio/job_audio_00")
    assert r.status_code == 200
    assert r.content == audio
    assert "audio" in r.headers.get("content-type", "")


def test_stream_audio_revalidates_and_answers_304_for_an_unchanged_file(
    client_with_root, tmp_path
):
    """The DJ decks refetch the same entry constantly. The browser keeps a
    copy (``no-cache`` stores it) and asks before each use; an unchanged file
    is an empty 304, not a download.

    The sequence a browser produces: first load, then a reload carrying the
    ETag it was given. The old one-year ``max-age`` never asked at all, and
    FileResponse never compares If-None-Match, so the second request was a
    full 200 whenever the browser did ask.
    """
    audio = b"RIFF\x00\x00\x00\x00WAVEdata x"
    _seed_generate_entry(tmp_path, "job_cached", 0, audio_bytes=audio)

    first = client_with_root.get("/api/library/audio/job_cached_00")
    assert first.status_code == 200
    assert first.content == audio
    cache_control = first.headers.get("cache-control", "")
    # A library is one user's: no shared proxy may keep a copy.
    assert "private" in cache_control
    # Keep, but ask first: a freshness lifetime would let the browser play a
    # stale copy without asking (see the replaced-file test below).
    assert "no-cache" in cache_control
    assert "max-age" not in cache_control
    assert "immutable" not in cache_control
    etag = first.headers.get("etag")
    assert etag, "the response must carry a validator the browser can send back"

    again = client_with_root.get(
        "/api/library/audio/job_cached_00", headers={"If-None-Match": etag}
    )
    assert again.status_code == 304, (
        "an unchanged file must revalidate, not re-download"
    )
    assert again.content == b""
    assert again.headers.get("etag") == etag
    assert "no-cache" in again.headers.get("cache-control", "")

    # A weak form of the same tag, and a list containing it, match too.
    weak = client_with_root.get(
        "/api/library/audio/job_cached_00",
        headers={"If-None-Match": f'"other", W/{etag}'},
    )
    assert weak.status_code == 304


class _BrowserCache:
    """The part of a browser's HTTP cache these tests need (RFC 9111).

    A stored response with a freshness lifetime (``max-age`` > 0 and no
    ``no-cache``) is reused WITHOUT a request; anything else is revalidated
    with ``If-None-Match`` and reused only on a 304. That is the behaviour the
    old one-year header relied on, so a test that goes through this sees what
    a deck saw: bytes the server never had a chance to replace.
    """

    def __init__(self, client: TestClient) -> None:
        self._client = client
        self._stored: dict[str, tuple[dict[str, str], bytes]] = {}

    @staticmethod
    def _fresh(headers: dict[str, str]) -> bool:
        directives = [d.strip() for d in headers.get("cache-control", "").split(",")]
        if "no-cache" in directives or "no-store" in directives:
            return False
        for d in directives:
            if d.startswith("max-age="):
                return int(d.split("=", 1)[1]) > 0
        return False

    def get(self, url: str) -> tuple[bytes, str, dict[str, str]]:
        """``(body, how, headers)`` where ``how`` is cache / revalidated / network."""
        hit = self._stored.get(url)
        if hit is not None and self._fresh(hit[0]):
            return hit[1], "cache", hit[0]
        headers = {}
        if hit is not None and hit[0].get("etag"):
            headers["If-None-Match"] = hit[0]["etag"]
        r = self._client.get(url, headers=headers)
        if r.status_code == 304 and hit is not None:
            return hit[1], "revalidated", hit[0]
        assert r.status_code == 200, r.text
        stored = {k.lower(): v for k, v in r.headers.items()}
        self._stored[url] = (stored, r.content)
        return r.content, "network", stored


def test_stream_audio_serves_a_file_replaced_at_the_same_path(
    client_with_root, tmp_path
):
    """A re-export to the same path must reach the deck. The sequence: the
    deck loads the entry, the user re-exports the file in place, the deck
    loads it again. With a one-year max-age the browser answered the second
    load from its cache and the server never saw it; now it asks, the old
    ETag no longer matches, and the new bytes come back."""
    import os

    _seed_generate_entry(
        tmp_path, "job_redo", 0, audio_bytes=b"RIFF\x00\x00\x00\x00WAVEold!"
    )
    browser = _BrowserCache(client_with_root)
    url = "/api/library/audio/job_redo_00"
    body, how, first_headers = browser.get(url)
    assert (body, how) == (b"RIFF\x00\x00\x00\x00WAVEold!", "network")

    # A reload with nothing changed costs a round trip, not a download.
    body, how, _ = browser.get(url)
    assert how == "revalidated", f"an unchanged file was served by {how}"

    audio_path = tmp_path / "job_redo" / "00" / "output.wav"
    audio_path.write_bytes(b"RIFF\x00\x00\x00\x00WAVEnew bytes")
    later = audio_path.stat().st_mtime + 5
    os.utime(audio_path, (later, later))

    body, how, headers = browser.get(url)
    assert body == b"RIFF\x00\x00\x00\x00WAVEnew bytes", (
        f"the deck kept playing the old bytes (served by {how})"
    )
    assert headers["etag"] != first_headers["etag"]


def test_stream_audio_replaces_a_failed_remux_once_it_works(
    client_with_root, tmp_path, monkeypatch
):
    """When the AIFF remux fails, the original (unplayable) file is served.
    The sequence: the remux fails on the first play, the cause goes away, the
    user plays the entry again. With a one-year max-age the browser kept the
    broken response for the entry's URL; now the fallback carries its own
    ETag and the revalidation brings the remuxed WAV."""
    import numpy as np
    import soundfile as sf

    from backend.lib import audio_io

    item_dir = tmp_path / "job_aiff" / "00"
    item_dir.mkdir(parents=True)
    sf.write(
        str(item_dir / "output.aiff"),
        np.zeros((2205, 2), dtype="float32"),
        44100,
        format="AIFF",
        subtype="PCM_16",
    )
    (item_dir / "metadata.json").write_text(
        json.dumps(
            {
                "job_id": "job_aiff",
                "index": 0,
                "filename": "output.aiff",
                "mime_type": "audio/aiff",
                "title": "aiff",
                "source": "import",
                "saved_at": 1.0,
            }
        ),
        encoding="utf-8",
    )

    real_load = audio_io.load_audio_array

    def _refuse(*_a, **_k):
        raise RuntimeError("decoder unavailable")

    browser = _BrowserCache(client_with_root)
    url = "/api/library/audio/job_aiff_00"
    monkeypatch.setattr(audio_io, "load_audio_array", _refuse)
    _, how, broken = browser.get(url)
    assert how == "network"
    assert broken["content-type"] != "audio/wav", "the remux was meant to fail here"

    monkeypatch.setattr(audio_io, "load_audio_array", real_load)
    _, how, fixed = browser.get(url)
    assert fixed["content-type"] == "audio/wav", (
        f"the unplayable fallback was still served (by {how}) after the remux worked"
    )
    assert fixed["etag"] != broken["etag"]


def test_listings_carry_the_bpm_confidence(client_with_root, tmp_path):
    """``bpm_confidence`` was stored but missing from the listing's scalar
    keys, so ``entry.analysis`` had a BPM with no confidence behind it on
    every list-driven surface. Both listing shapes read it: the unpaged one
    (every row, ``get_all_analysis``) and the paged one (``get_analysis_for``)."""
    from backend.modules.analysis.engine import ANALYSIS_VERSION, persist_analysis

    _seed_generate_entry(tmp_path, "job_conf", 0)
    client_with_root.get("/api/library/entries")
    store = library_router_module.get_store()
    assert store.db is not None
    persist_analysis(
        store.db,
        "job_conf_00",
        {"version": ANALYSIS_VERSION, "bpm": 124.0, "bpm_confidence": 0.37},
    )

    unpaged = client_with_root.get("/api/library/entries").json()["entries"]
    paged = client_with_root.get("/api/library/entries?limit=50").json()["entries"]
    single = client_with_root.get("/api/library/entries/job_conf_00").json()
    for label, entry in (
        ("unpaged", {e["id"]: e for e in unpaged}["job_conf_00"]),
        ("paged", {e["id"]: e for e in paged}["job_conf_00"]),
        ("single", single),
    ):
        assert entry["analysis"]["bpm"] == 124.0, label
        assert entry["analysis"].get("bpm_confidence") == 0.37, (
            f"the {label} listing dropped bpm_confidence"
        )


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


def test_stream_stem_audio_endpoint_serves_stem_bytes(client_with_root, tmp_path):
    """The /api/library/stems/{stem_id}/audio route lets the frontend
    fetch one separated stem's WAV bytes for the editor / init / inpaint
    pipelines without an in-memory copy. Test that the path-to-bytes
    round-trip works."""
    _seed_generate_entry(tmp_path, "job_stems", 0)
    # Write a fake stem file in the entry dir + register it in the DB
    # so the endpoint can resolve it.
    entry_dir = tmp_path / "job_stems_00"
    if not entry_dir.is_dir():
        entry_dir = tmp_path / "job_stems" / "00"
    stems_dir = entry_dir / "stems"
    stems_dir.mkdir(parents=True, exist_ok=True)
    stem_bytes = b"RIFF\x00\x00\x00\x00WAVEdata fake-bass"
    stem_path = stems_dir / "bass.wav"
    stem_path.write_bytes(stem_bytes)

    store = library_router_module.get_store()
    assert store.db is not None
    store.db.add_stem(
        stem_id="job_stems_00__bass",
        entry_id="job_stems_00",
        stem_name="bass",
        audio_path=str(stem_path),
        file_size_bytes=len(stem_bytes),
        model="demucs",
        model_variant="4-stem",
    )

    r = client_with_root.get("/api/library/stems/job_stems_00__bass/audio")
    assert r.status_code == 200
    assert r.content == stem_bytes
    assert "audio" in r.headers.get("content-type", "")


def test_stream_stem_audio_endpoint_404_for_unknown_stem(client_with_root):
    r = client_with_root.get("/api/library/stems/does-not-exist/audio")
    assert r.status_code == 404


def test_list_entries_attaches_analysis_and_embedded_tags(client_with_root, tmp_path):
    """Regression for the analytics-surfacing fix: the /entries payload must
    carry the stored musical analysis + embedded file tags so the Catalogue
    inspector (which reads ``entry.analysis`` / ``entry.embedded_tags``) and the
    library search can render/use them. An entry WITHOUT an analysis row must
    stay untouched — no empty ``analysis`` key."""
    _seed_generate_entry(tmp_path, "job_anal", 0)
    _seed_generate_entry(tmp_path, "job_plain", 0)

    # First list registers the on-disk entries into the DB — the FK target the
    # analysis row references (foreign_keys is ON).
    client_with_root.get("/api/library/entries")

    store = library_router_module.get_store()
    assert store.db is not None
    store.db.upsert_analysis(
        "job_anal_00",
        {
            "bpm": 120.0,
            "key": "C",
            "scale": "major",
            "key_confidence": 0.9,
            "semantic_tags": ["warm", "ambient"],
            "embedded_tags": {"artist": "Tester", "play_count": 7},
            "ffprobe": {"_summary": {"sample_rate": 44100, "codec": "pcm_s16le"}},
            "version": 2,
        },
    )

    body = client_with_root.get("/api/library/entries").json()
    by_id = {e["id"]: e for e in body["entries"]}

    enriched = by_id["job_anal_00"]
    assert enriched["analysis"]["bpm"] == 120.0
    assert enriched["analysis"]["key"] == "C"
    assert enriched["analysis"]["scale"] == "major"
    assert enriched["analysis"]["semantic_tags"] == ["warm", "ambient"]
    # ffprobe `_summary` technicals are flattened onto the analysis dict.
    assert enriched["analysis"]["sample_rate"] == 44100
    assert enriched["analysis"]["codec"] == "pcm_s16le"
    # Embedded ID3/Vorbis tags surface under their own key.
    assert enriched["embedded_tags"] == {"artist": "Tester", "play_count": 7}

    # The un-analyzed entry must NOT gain empty analysis / embedded_tags keys.
    plain = by_id["job_plain_00"]
    assert "analysis" not in plain
    assert "embedded_tags" not in plain


def test_single_entry_endpoint_attaches_analysis(client_with_root, tmp_path):
    """The per-id endpoint enriches via the targeted single-row lookup
    (``_attach_analysis_one``), not the whole-table bulk path."""
    _seed_generate_entry(tmp_path, "job_one", 0)
    client_with_root.get("/api/library/entries")

    store = library_router_module.get_store()
    assert store.db is not None
    store.db.upsert_analysis("job_one_00", {"bpm": 90.0, "key": "A"})

    data = client_with_root.get("/api/library/entries/job_one_00").json()
    assert data["analysis"]["bpm"] == 90.0
    assert data["analysis"]["key"] == "A"
