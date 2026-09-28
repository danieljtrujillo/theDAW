"""The media-root index: the library resolves an entry's file from the user's
own folders before it ever asks a CDN.

Every test here builds its own tree under ``tmp_path`` and points the roots at
it through the env var or the settings store. Nothing reads a real library.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.library import media_roots
from backend.modules.library import router as library_router_module
from backend.modules.library.store import LibraryStore
from backend.modules.settings import router as settings_router
from backend.modules.settings.store import SettingsStore
from tests.test_library_store import _seed_generate_entry

UUID_A = "c27de18c-1b0e-4a2f-8b71-9d0c5f2a1e33"
UUID_B = "aa11bb22-3c4d-4e5f-8aa9-0b1c2d3e4f50"


@pytest.fixture(autouse=True)
def _clean_index(monkeypatch, tmp_path):
    """Every test starts with no index, no roots, no scan in flight and no
    remembered CDN refusals (all three are process-lifetime state).

    With no env var, configured_roots() falls back to the process-wide
    settings store over data/settings.json: a route test (a rescan) read and
    migrated the checkout's real file, and walked whatever media roots it
    named. Each test gets a settings store of its own instead."""
    monkeypatch.setattr(
        settings_router, "_store", SettingsStore(tmp_path / "settings.json")
    )
    monkeypatch.delenv(media_roots.ENV_VAR, raising=False)
    media_roots.reset()
    library_router_module._cdn_refused.clear()
    yield
    media_roots.reset()
    library_router_module._cdn_refused.clear()


def _write(path: Path, data: bytes = b"RIFF\x00\x00\x00\x00WAVE") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def _roots_env(monkeypatch, *roots: Path) -> None:
    import os

    monkeypatch.setenv(media_roots.ENV_VAR, os.pathsep.join(str(r) for r in roots))


# ---- the index -------------------------------------------------------------


def test_index_maps_id8_and_full_id_across_nested_folders(tmp_path, monkeypatch):
    root = tmp_path / "media"
    id8 = _write(root / "artists" / "a" / f"high voltage [{UUID_A[:8]}].mp3")
    full = _write(root / "deep" / "er" / f"take one {UUID_B}.flac")
    _roots_env(monkeypatch, root)

    media_roots.scan_now()

    assert media_roots.lookup(UUID_A) == id8
    assert media_roots.lookup(UUID_B) == full
    # The short-id table is consulted for a uuid entry id ONLY. Eight hex
    # digits are not an entry id, and nothing in the app looks one up.
    assert media_roots.lookup(UUID_B[:8]) is None
    assert media_roots.status()["files"] == 2


def test_non_media_files_are_ignored(tmp_path, monkeypatch):
    root = tmp_path / "media"
    _write(root / f"notes [{UUID_A[:8]}].txt")
    _write(root / f"cover [{UUID_B[:8]}].part")
    keep = _write(root / f"song [{UUID_B[:8]}].mp3")
    _roots_env(monkeypatch, root)

    media_roots.scan_now()

    assert media_roots.lookup(UUID_A) is None
    assert media_roots.lookup(UUID_B) == keep
    assert media_roots.status()["files"] == 1


def test_id8_ambiguity_prefers_the_full_id_file(tmp_path, monkeypatch):
    root = tmp_path / "media"
    tagged = _write(root / "one" / f"tagged [{UUID_A[:8]}].mp3")
    full = _write(root / "two" / f"named {UUID_A}.mp3")
    # The id8-only file is the NEWER one, so only the full-id rule can win.
    import os

    os.utime(tagged, (time.time() + 60, time.time() + 60))
    _roots_env(monkeypatch, root)

    media_roots.scan_now()

    assert media_roots.lookup(UUID_A) == full
    assert media_roots.status()["ambiguous"] == 1


def test_id8_ambiguity_without_a_full_id_takes_the_newest(tmp_path, monkeypatch):
    root = tmp_path / "media"
    old = _write(root / "old" / f"take [{UUID_A[:8]}].mp3")
    new = _write(root / "new" / f"take [{UUID_A[:8]}].m4a")
    import os

    os.utime(old, (time.time() - 600, time.time() - 600))
    _roots_env(monkeypatch, root)

    media_roots.scan_now()

    assert media_roots.lookup(UUID_A) == new


def test_lookup_filters_by_extension(tmp_path, monkeypatch):
    root = tmp_path / "media"
    clip = _write(root / f"clip [{UUID_A[:8]}].mp4")
    _roots_env(monkeypatch, root)

    media_roots.scan_now()

    assert media_roots.lookup(UUID_A, extensions={".mp3", ".wav"}) is None
    assert media_roots.lookup(UUID_A, extensions={".mp4"}) == clip


# ---- configuration ---------------------------------------------------------


def test_env_wins_over_settings(tmp_path, monkeypatch):
    from backend.modules.settings import router as settings_router
    from backend.modules.settings.store import SettingsStore

    from_settings = tmp_path / "from-settings"
    from_env = tmp_path / "from-env"
    from_settings.mkdir()
    from_env.mkdir()

    store = SettingsStore(tmp_path / "settings.json")
    store.patch({"library": {"media_roots": [str(from_settings)]}})
    monkeypatch.setattr(settings_router, "_store", store)

    assert media_roots.configured_roots() == [str(from_settings)]

    _roots_env(monkeypatch, from_env)
    assert media_roots.configured_roots() == [str(from_env)]


def test_settings_media_roots_survive_a_round_trip(tmp_path):
    from backend.modules.settings.store import SettingsStore

    path = tmp_path / "settings.json"
    store = SettingsStore(path)
    store.patch({"library": {"media_roots": ["  D:\\a  ", "D:\\a", "", 7]}})

    reloaded = SettingsStore(path)
    assert reloaded.get_value("library", "media_roots") == ["D:\\a"]


# ---- the store falls through ----------------------------------------------


def test_get_audio_path_falls_through_to_a_media_root(tmp_path, monkeypatch):
    lib = tmp_path / "lib"
    entry_dir = lib / UUID_A
    entry_dir.mkdir(parents=True)
    (entry_dir / "metadata.json").write_text(
        json.dumps({"title": "no bytes here", "cdn_audio_url": "https://cdn/x.mp3"}),
        encoding="utf-8",
    )
    root = tmp_path / "media"
    target = _write(root / "nested" / f"no bytes here [{UUID_A[:8]}].mp3")
    _roots_env(monkeypatch, root)
    media_roots.scan_now()

    store = LibraryStore(lib)
    resolved = store.get_audio_path(UUID_A)

    assert resolved == target
    # Reference in place: nothing was copied into the entry, and the metadata
    # is byte-for-byte what it was.
    assert sorted(p.name for p in entry_dir.iterdir()) == ["metadata.json"]
    assert json.loads((entry_dir / "metadata.json").read_text(encoding="utf-8")) == {
        "title": "no bytes here",
        "cdn_audio_url": "https://cdn/x.mp3",
    }


def test_get_audio_path_prefers_the_entry_dir(tmp_path, monkeypatch):
    lib = tmp_path / "lib"
    entry_dir = _seed_generate_entry(lib, "job_local", 0)
    root = tmp_path / "media"
    _write(root / "job_local_00 [deadbeef].mp3")
    _roots_env(monkeypatch, root)
    media_roots.scan_now()

    store = LibraryStore(lib)
    assert store.get_audio_path("job_local_00") == entry_dir / "output.wav"


def test_get_audio_path_ignores_the_index_for_an_unknown_id(tmp_path, monkeypatch):
    root = tmp_path / "media"
    _write(root / f"orphan [{UUID_A[:8]}].mp3")
    _roots_env(monkeypatch, root)
    media_roots.scan_now()

    store = LibraryStore(tmp_path / "lib")
    assert store.get_audio_path(UUID_A) is None


def test_get_media_path_falls_through_for_a_video_entry(tmp_path, monkeypatch):
    lib = tmp_path / "lib"
    entry_dir = lib / UUID_B
    entry_dir.mkdir(parents=True)
    (entry_dir / "metadata.json").write_text(
        json.dumps({"kind": "video", "title": "clip"}), encoding="utf-8"
    )
    root = tmp_path / "media"
    target = _write(root / f"clip [{UUID_B[:8]}].mp4")
    _roots_env(monkeypatch, root)
    media_roots.scan_now()

    store = LibraryStore(lib)
    assert store.get_media_path(UUID_B) == target


# ---- the index never blocks a request --------------------------------------


def test_lookup_does_not_block_while_a_scan_runs(tmp_path, monkeypatch):
    root = tmp_path / "media"
    _write(root / f"song [{UUID_A[:8]}].mp3")
    _roots_env(monkeypatch, root)

    release = threading.Event()
    started = threading.Event()

    def _never_finishes(roots):
        started.set()
        release.wait(30)
        return media_roots.MediaIndex(roots=tuple(roots), signature=())

    monkeypatch.setattr(media_roots, "_build_index", _never_finishes)
    media_roots.start_scan()
    assert started.wait(5)

    began = time.monotonic()
    assert media_roots.lookup(UUID_A) is None
    assert time.monotonic() - began < 1.0
    assert media_roots.status()["scanning"] is True
    release.set()


# ---- the routes ------------------------------------------------------------


@pytest.fixture
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path / "lib"))
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    # A loopback TCP peer: the media-root routes are this machine's own UI
    # only, and TestClient's default peer ("testclient") is not an address.
    return TestClient(app, client=("127.0.0.1", 51000))


def test_media_roots_status_and_rescan_routes(client, tmp_path, monkeypatch):
    root = tmp_path / "media"
    _write(root / f"song [{UUID_A[:8]}].mp3")
    _roots_env(monkeypatch, root)

    before = client.get("/api/library/media-roots")
    assert before.status_code == 200
    assert before.json()["roots"] == [str(root)]
    assert before.json()["ready"] is False

    rescan = client.post("/api/library/media-roots/rescan")
    assert rescan.status_code == 200
    deadline = time.monotonic() + 10
    while not media_roots.status()["ready"] and time.monotonic() < deadline:
        time.sleep(0.02)

    after = client.get("/api/library/media-roots")
    assert after.json()["ready"] is True
    assert after.json()["files"] == 1
    assert after.json()["scanning"] is False
    assert after.json()["age_seconds"] is not None


def test_stream_audio_serves_the_media_root_file(client, tmp_path, monkeypatch):
    lib = tmp_path / "lib"
    entry_dir = lib / UUID_A
    entry_dir.mkdir(parents=True)
    (entry_dir / "metadata.json").write_text(
        json.dumps({"title": "remote only"}), encoding="utf-8"
    )
    root = tmp_path / "media"
    _write(root / f"remote only [{UUID_A[:8]}].mp3", b"ID3fake-mp3-bytes")
    _roots_env(monkeypatch, root)
    media_roots.scan_now()

    r = client.get(f"/api/library/audio/{UUID_A}")

    assert r.status_code == 200
    assert r.content == b"ID3fake-mp3-bytes"
    # The type comes from `mimetypes`, which reads the OS registry on Windows
    # and answers "audio/mp3" there and "audio/mpeg" on Linux. Both are mp3 to
    # a browser; what matters is that the out-of-tree file was typed at all.
    assert r.headers["content-type"] in {"audio/mpeg", "audio/mp3"}


# ---- the CDN is asked once -------------------------------------------------


class _Resp:
    status_code = 403

    def raise_for_status(self):
        import httpx

        raise httpx.HTTPStatusError("403 Forbidden", request=None, response=self)


def test_cdn_403_is_remembered_and_not_refetched(client, tmp_path, monkeypatch):
    lib = tmp_path / "lib"
    entry_dir = lib / UUID_B
    entry_dir.mkdir(parents=True)
    (entry_dir / "metadata.json").write_text(
        json.dumps({"title": "gone", "cdn_audio_url": "https://cdn.example/x.mp3"}),
        encoding="utf-8",
    )
    calls: list[str] = []

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            calls.append(url)
            return _Resp()

    monkeypatch.setattr(library_router_module.httpx, "AsyncClient", _Client)

    first = client.get(f"/api/library/audio/{UUID_B}")
    assert first.status_code == 404
    assert "no local file in any media root" in first.json()["detail"]
    assert "not accessible" in first.json()["detail"]

    second = client.get(f"/api/library/audio/{UUID_B}")
    assert second.status_code == 404
    assert second.json()["detail"] == first.json()["detail"]
    assert calls == ["https://cdn.example/x.mp3"]


# ---- r2: the remux never lands in the entry --------------------------------


def _write_aiff(path: Path) -> Path:
    """A real 50 ms stereo AIFF, so the remux path does real work on a real
    file rather than a mocked branch."""
    import numpy as np
    import soundfile as sf

    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(
        str(path),
        np.zeros((2205, 2), dtype="float32"),
        44100,
        format="AIFF",
        subtype="PCM_16",
    )
    return path


def test_remuxing_a_media_root_file_never_writes_into_the_entry(
    client, tmp_path, monkeypatch
):
    monkeypatch.setenv("theDAW_DATA_DIR", str(tmp_path / "data"))
    lib = tmp_path / "lib"
    entry_dir = lib / UUID_A
    entry_dir.mkdir(parents=True)
    (entry_dir / "metadata.json").write_text(
        json.dumps({"title": "aiff master"}), encoding="utf-8"
    )
    root = tmp_path / "media"
    _write_aiff(root / f"aiff master [{UUID_A[:8]}].aiff")
    _roots_env(monkeypatch, root)
    media_roots.scan_now()

    r = client.get(f"/api/library/audio/{UUID_A}")

    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"
    # The entry is untouched: no _playable folder, no copied bytes.
    assert sorted(p.name for p in entry_dir.iterdir()) == ["metadata.json"]
    cached = list(media_roots.playable_cache_dir(UUID_A).rglob("*.wav"))
    assert len(cached) == 1, cached
    assert cached[0].stat().st_size > 0


# ---- r2: the routes are loopback-only --------------------------------------


@pytest.fixture
def lan_client(tmp_path, monkeypatch) -> TestClient:
    """A TestClient whose TCP peer is a LAN address, not this machine."""
    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path / "lib"))
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    return TestClient(app, client=("10.20.30.40", 51000))


def test_media_root_routes_refuse_a_lan_caller(lan_client, client):
    assert lan_client.get("/api/library/media-roots").status_code == 403
    assert lan_client.post("/api/library/media-roots/rescan").status_code == 403
    # This machine's own UI is unaffected.
    assert client.get("/api/library/media-roots").status_code == 200
    assert client.post("/api/library/media-roots/rescan").status_code == 200


# ---- r2: roots are normalised, validated, de-duped -------------------------


def test_spellings_of_one_root_collapse_to_one(tmp_path, monkeypatch):
    root = tmp_path / "music"
    _write(root / f"song [{UUID_A[:8]}].mp3")
    import os

    spellings = [str(root), str(root) + os.sep, str(root).swapcase()]
    monkeypatch.setenv(media_roots.ENV_VAR, os.pathsep.join(spellings))

    assert len(media_roots.configured_roots()) == 1

    media_roots.scan_now()
    assert media_roots.status()["files"] == 1
    assert media_roots.status()["ambiguous"] == 0


def test_a_nested_root_is_dropped(tmp_path, monkeypatch):
    outer = tmp_path / "music"
    inner = outer / "albums"
    inner.mkdir(parents=True)
    _roots_env(monkeypatch, inner, outer)

    assert media_roots.configured_roots() == [
        media_roots.normalize_roots([str(outer)])[0]
    ]


def test_validate_roots_refuses_a_relative_or_missing_folder(tmp_path):
    import pytest as _pytest

    with _pytest.raises(ValueError) as rel:
        media_roots.validate_roots(["music/here"])
    assert "absolute" in str(rel.value)

    with _pytest.raises(ValueError) as missing:
        media_roots.validate_roots([str(tmp_path / "nope")])
    assert "folder" in str(missing.value)

    ok = media_roots.validate_roots([str(tmp_path)])
    assert ok == media_roots.normalize_roots([str(tmp_path)])


# ---- r2: a failed scan says so ---------------------------------------------


def test_a_failed_scan_is_reported(tmp_path, monkeypatch):
    _roots_env(monkeypatch, tmp_path)

    def _boom(roots):
        raise OSError("the disk went away")

    monkeypatch.setattr(media_roots, "_build_index", _boom)
    media_roots.scan_now()

    st = media_roots.status()
    assert st["ready"] is False
    assert st["scanning"] is False
    assert "the disk went away" in (st["error"] or "")


def test_a_good_scan_clears_the_previous_failure(tmp_path, monkeypatch):
    _write(tmp_path / f"song [{UUID_A[:8]}].mp3")
    _roots_env(monkeypatch, tmp_path)
    media_roots._set_error("stale failure")

    media_roots.scan_now()

    assert media_roots.status()["error"] is None


# ---- r2: the short id is for uuid entry ids only ---------------------------


def test_a_non_uuid_entry_id_never_matches_a_short_id_file(tmp_path, monkeypatch):
    root = tmp_path / "media"
    # "job_local" starts with eight characters that are not hex, but an id
    # like "deadbeef_00" would be -- and must still not match.
    _write(root / "whatever [deadbeef].mp3")
    _roots_env(monkeypatch, root)
    media_roots.scan_now()

    assert media_roots.lookup("deadbeef_00") is None
    assert media_roots.lookup("job_local_00") is None
    assert media_roots.lookup("deadbeef") is None


# ---- r2: the roots are never stat-ed on the caller's thread ----------------


def test_the_signature_refresh_runs_off_the_calling_thread(tmp_path, monkeypatch):
    root = tmp_path / "media"
    target = _write(root / f"song [{UUID_A[:8]}].mp3")
    _roots_env(monkeypatch, root)
    media_roots.scan_now()

    seen: list[str] = []
    done = threading.Event()
    real_signature = media_roots._signature

    def _slow_signature(roots):
        seen.append(threading.current_thread().name)
        done.set()
        return real_signature(roots)

    monkeypatch.setattr(media_roots, "_signature", _slow_signature)
    # Force the next lookup to consider the roots stale-checkable.
    media_roots._last_signature_check = 0.0

    assert media_roots.lookup(UUID_A) == target

    assert done.wait(10), "the refresh never ran"
    assert seen, "the refresh never ran"
    assert threading.current_thread().name not in seen


# ---- r2: only a settled refusal is remembered ------------------------------


class _Resp5xx:
    status_code = 503

    def raise_for_status(self):
        import httpx

        raise httpx.HTTPStatusError("503", request=None, response=self)


def _cdn_entry(lib, entry_id):
    entry_dir = lib / entry_id
    entry_dir.mkdir(parents=True)
    (entry_dir / "metadata.json").write_text(
        json.dumps({"title": "gone", "cdn_audio_url": "https://cdn.example/x.mp3"}),
        encoding="utf-8",
    )
    return entry_dir


def test_a_5xx_from_the_cdn_is_retried_next_time(client, tmp_path, monkeypatch):
    _cdn_entry(tmp_path / "lib", UUID_B)
    calls: list[str] = []

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            calls.append(url)
            return _Resp5xx()

    monkeypatch.setattr(library_router_module.httpx, "AsyncClient", _Client)

    assert client.get(f"/api/library/audio/{UUID_B}").status_code == 404
    assert client.get(f"/api/library/audio/{UUID_B}").status_code == 404
    assert len(calls) == 2, "a 5xx is not the host's settled answer"


def test_a_dropped_connection_is_retried_next_time(client, tmp_path, monkeypatch):
    _cdn_entry(tmp_path / "lib", UUID_A)
    calls: list[str] = []

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            calls.append(url)
            raise OSError("connection reset")

    monkeypatch.setattr(library_router_module.httpx, "AsyncClient", _Client)

    assert client.get(f"/api/library/audio/{UUID_A}").status_code == 404
    assert client.get(f"/api/library/audio/{UUID_A}").status_code == 404
    assert len(calls) == 2


class _RespOk:
    status_code = 200

    def __init__(self, content: bytes):
        self.content = content

    def raise_for_status(self):
        return None


def test_a_disk_full_during_the_cdn_cache_write_never_serves_a_cut_file(
    client, tmp_path, monkeypatch
):
    """A track only the CDN holds: the first play fetches it and caches it
    next to the entry. The disk fills halfway through that write. The cache
    was written straight over its final name, so the half file stayed there,
    and every later play served it as the track. Written aside and renamed,
    the next play fetches again, and the one after serves the whole file."""
    entry_dir = _cdn_entry(tmp_path / "lib", UUID_A)
    track = b"ID3" + bytes(range(256)) * 64
    calls: list[str] = []

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            calls.append(url)
            return _RespOk(track)

    monkeypatch.setattr(library_router_module.httpx, "AsyncClient", _Client)

    real_write_bytes = Path.write_bytes
    disk_full = [True]
    writes_on_loop: list[bool] = []

    def filling_disk(self: Path, data: bytes) -> int:
        if entry_dir in self.parents:
            writes_on_loop.append(_on_the_event_loop())
            if disk_full[0]:
                disk_full[0] = False
                real_write_bytes(self, data[: len(data) // 2])
                raise OSError(28, "No space left on device")
        return real_write_bytes(self, data)

    monkeypatch.setattr(Path, "write_bytes", filling_disk)

    first = client.get(f"/api/library/audio/{UUID_A}")
    assert first.status_code == 200 and first.content == track
    second = client.get(f"/api/library/audio/{UUID_A}")
    assert second.status_code == 200 and second.content == track
    third = client.get(f"/api/library/audio/{UUID_A}")
    assert third.status_code == 200 and third.content == track
    assert len(calls) == 2, "the complete cache serves the third play"
    assert sorted(p.name for p in entry_dir.iterdir()) == sorted(
        ["metadata.json", f"{UUID_A}.mp3"]
    ), "no temp file is left beside the cache"
    assert writes_on_loop == [False, False], "the cache write blocks the event loop"


# ---- r3: nothing touches the filesystem on the event loop ------------------


def _on_the_event_loop() -> bool:
    """True when the caller is running ON the loop thread. A function handed
    to ``asyncio.to_thread`` has no running loop; one called inline from an
    ``async def`` handler does. Exact, and not a stopwatch."""
    import asyncio

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return False
    return True


def test_streaming_does_no_filesystem_work_on_the_event_loop(
    client, tmp_path, monkeypatch
):
    import os

    lib = tmp_path / "lib"
    entry_dir = lib / UUID_A
    entry_dir.mkdir(parents=True)
    (entry_dir / "metadata.json").write_text(
        json.dumps({"title": "remote only"}), encoding="utf-8"
    )
    root = tmp_path / "media"
    _write(root / f"remote only [{UUID_A[:8]}].mp3", b"ID3bytes")
    _roots_env(monkeypatch, root)
    media_roots.scan_now()

    on_loop: list[str] = []
    real_is_file = Path.is_file
    real_dir_for = LibraryStore._dir_for
    real_stat = os.stat

    def _is_file(self):
        if _on_the_event_loop():
            on_loop.append(f"is_file({self})")
        return real_is_file(self)

    def _dir_for(self, entry_id):
        if _on_the_event_loop():
            on_loop.append(f"_dir_for({entry_id})")
        return real_dir_for(self, entry_id)

    def _stat(path, *args, **kwargs):
        if _on_the_event_loop():
            on_loop.append(f"stat({path})")
        return real_stat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "is_file", _is_file)
    monkeypatch.setattr(LibraryStore, "_dir_for", _dir_for)
    # Every stat, including the one Starlette's FileResponse takes to size the
    # body: a response that stats on the loop is the same stall as a resolve
    # that does.
    monkeypatch.setattr(os, "stat", _stat)

    assert client.get(f"/api/library/audio/{UUID_A}").status_code == 200
    assert on_loop == []

    # And the miss path, which resolves the entry dir and reads its metadata.
    assert client.get("/api/library/audio/nope").status_code == 404
    assert on_loop == []


# ---- r3: the remux cache never falls back to the source folder -------------


def test_no_cache_parent_serves_the_original_and_writes_nothing(
    client, tmp_path, monkeypatch
):
    monkeypatch.setenv("theDAW_DATA_DIR", str(tmp_path / "data"))
    lib = tmp_path / "lib"
    entry_dir = lib / UUID_A
    entry_dir.mkdir(parents=True)
    (entry_dir / "metadata.json").write_text(
        json.dumps({"title": "aiff master"}), encoding="utf-8"
    )
    root = tmp_path / "media"
    source = _write_aiff(root / f"aiff master [{UUID_A[:8]}].aiff")
    _roots_env(monkeypatch, root)
    media_roots.scan_now()

    monkeypatch.setattr(
        library_router_module, "_playable_cache_for", lambda *a, **k: None
    )

    r = client.get(f"/api/library/audio/{UUID_A}")

    assert r.status_code == 200
    # The original bytes, and NOT a _playable folder beside the user's file.
    assert r.content == source.read_bytes()
    assert sorted(p.name for p in source.parent.iterdir()) == [source.name]
    assert sorted(p.name for p in entry_dir.iterdir()) == ["metadata.json"]


# ---- r3: an entry id is not a path -----------------------------------------


def test_the_playable_cache_refuses_an_id_that_is_a_path(tmp_path, monkeypatch):
    monkeypatch.setenv("theDAW_DATA_DIR", str(tmp_path / "data"))

    assert media_roots.playable_cache_dir("../escape") is None
    assert media_roots.playable_cache_dir("a/b") is None
    assert media_roots.playable_cache_dir("a\\b") is None
    assert media_roots.playable_cache_dir("C:sneaky") is None
    assert media_roots.playable_cache_dir("") is None
    # Every run of dots, not just the two the filesystem names.
    assert media_roots.playable_cache_dir(".") is None
    assert media_roots.playable_cache_dir("..") is None
    assert media_roots.playable_cache_dir("...") is None
    assert media_roots.playable_cache_dir(".....") is None

    ok = media_roots.playable_cache_dir(UUID_A)
    assert ok is not None and ok.name == UUID_A
    assert media_roots.playable_cache_dir("job_alpha_00") is not None


# ---- r3: an env root is held to the same rules as a typed one --------------


def test_a_relative_env_root_is_dropped(tmp_path, monkeypatch):
    import os

    good = tmp_path / "music"
    good.mkdir()
    monkeypatch.setenv(
        media_roots.ENV_VAR,
        os.pathsep.join(["music/here", str(tmp_path / "gone"), str(good)]),
    )

    assert media_roots.configured_roots() == [str(good)]
