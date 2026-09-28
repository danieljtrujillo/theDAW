"""/clip-audio folder grants survive switching between builds, both ways.

main 851f6a0 keeps the grants in ``data/media_roots.json`` as a bare JSON list
and reads any other shape as no grants. The first v2 build wrote
``{"v": 2, "roots": [...]}`` into that same file and read a list as no grants,
so every switch between the two forgot every grant, in both directions. This
build keeps its own grants in ``data/clip_audio_roots.json``, takes over on
every start the folders an older build added to ``media_roots.json``, and
keeps that file current in main's list format.

Each "start" below imports the module afresh with ``theDAW_DATA_DIR`` pointing
into ``tmp_path``, so it loads its files at import exactly as a starting
backend does, then runs this build's startup write (``finish_start``, the
``clip-audio-roots`` startup hook). main's module is
``tests/fixtures/main_851f6a0/media_access.py``, a byte-identical copy of
``backend/modules/project/media_access.py`` at 851f6a0, and the first v2
build's is ``tests/fixtures/pr207_8039b45/media_access.py`` (8039b45), so each
older build runs its real load and save code.
"""

from __future__ import annotations

import importlib.util
import itertools
import json
import shutil
import threading
import time
import zipfile
from pathlib import Path
from types import ModuleType

import pytest

REPO = Path(__file__).resolve().parents[1]
THIS_BUILD = REPO / "backend" / "modules" / "project" / "media_access.py"
MAIN_BUILD = REPO / "tests" / "fixtures" / "main_851f6a0" / "media_access.py"
FIRST_V2_BUILD = REPO / "tests" / "fixtures" / "pr207_8039b45" / "media_access.py"

_starts = itertools.count()


def _import(source: Path) -> ModuleType:
    """``source`` imported as a fresh module, the way a backend process
    imports it, and nothing more."""
    name = f"_media_access_start_{next(_starts)}"
    spec = importlib.util.spec_from_file_location(name, source)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _start(source: Path) -> ModuleType:
    """One backend start: the import, then this build's startup write. The
    older builds do all their loading at import and have no such step."""
    module = _import(source)
    finish_start = getattr(module, "finish_start", None)
    if finish_start is not None:
        finish_start()
    return module


@pytest.fixture
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The writable data tree both builds use. The media folders live beside
    it, never inside it, because the data tree is a static root."""
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("theDAW_DATA_DIR", str(data))
    monkeypatch.delenv("theDAW_MEDIA_ROOTS", raising=False)
    monkeypatch.delenv("theDAW_GENERATIONS_DIR", raising=False)
    return data


def _folder(tmp_path: Path, name: str) -> Path:
    folder = tmp_path / "media" / name
    folder.mkdir(parents=True)
    (folder / "clip.wav").write_bytes(b"RIFF")
    return folder


def _serves(module: ModuleType, folder: Path) -> bool:
    return module.resolve_media_path(str(folder / "clip.wav")) is not None


def _read(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def test_grants_survive_main_this_build_main_this_build(
    tmp_path: Path, data_dir: Path
) -> None:
    kicks = _folder(tmp_path, "kicks")
    vox = _folder(tmp_path, "vox")
    gone = _folder(tmp_path, "gone")

    # main opens three projects; the user later deletes one of their folders.
    main = _start(MAIN_BUILD)
    for folder in (kicks, vox, gone):
        assert main.register_root(folder / "clip.wav")
    shutil.rmtree(gone)
    assert isinstance(_read(data_dir / "media_roots.json"), list)

    # This build's first start takes main's grants over, dropping the folder
    # that is gone.
    this = _start(THIS_BUILD)
    assert _serves(this, kicks)
    assert _serves(this, vox)
    state = _read(data_dir / "clip_audio_roots.json")
    assert isinstance(state, dict) and state["v"] == 2
    assert sorted(state["roots"]) == sorted([str(kicks.resolve()), str(vox.resolve())])
    assert isinstance(_read(data_dir / "media_roots.json"), list), (
        "main's file is main's"
    )

    # main again: every grant is there, and it grants one more on its own.
    main = _start(MAIN_BUILD)
    assert _serves(main, kicks)
    assert _serves(main, vox)
    drums = _folder(tmp_path, "drums")
    assert main.register_root(drums / "clip.wav")

    # This build again: its grants are intact, main's new one is taken over
    # (the UI restores that project from its own storage, with no /load), and
    # it opens a new project.
    this = _start(THIS_BUILD)
    assert _serves(this, kicks)
    assert _serves(this, vox)
    assert _serves(this, drums)
    assert str(drums.resolve()) in _read(data_dir / "clip_audio_roots.json")["roots"]
    bass = _folder(tmp_path, "bass")
    assert this.register_root(bass / "clip.wav")

    # main a third time: this build's grants, and main's own one kept.
    main = _start(MAIN_BUILD)
    for folder in (kicks, vox, bass, drums):
        assert _serves(main, folder), folder

    # This build a third time.
    this = _start(THIS_BUILD)
    for folder in (kicks, vox, bass, drums):
        assert _serves(this, folder), folder


def test_a_v2_object_the_first_v2_build_writes_later_is_handed_back_to_main(
    tmp_path: Path, data_dir: Path
) -> None:
    """8039b45 reads main's list as no grants and overwrites main's file with
    its own object. When it runs after this build, the next start of this
    build takes the object's folders over and gives main its list back."""
    kicks = _folder(tmp_path, "kicks")
    assert _start(MAIN_BUILD).register_root(kicks / "clip.wav")
    assert _serves(_start(THIS_BUILD), kicks)

    first_v2 = _start(FIRST_V2_BUILD)
    assert not _serves(first_v2, kicks), "8039b45 reads main's list as nothing"
    vox = _folder(tmp_path, "vox")
    assert first_v2.register_root(vox / "clip.wav")
    assert isinstance(_read(data_dir / "media_roots.json"), dict)
    assert not _serves(_start(MAIN_BUILD), vox), "main reads the object as nothing"

    this = _start(THIS_BUILD)
    assert _serves(this, kicks)
    assert _serves(this, vox)
    legacy = _read(data_dir / "media_roots.json")
    assert isinstance(legacy, list)
    assert sorted(legacy) == sorted([str(kicks.resolve()), str(vox.resolve())])

    main = _start(MAIN_BUILD)
    assert _serves(main, kicks)
    assert _serves(main, vox)


def test_importing_the_module_writes_no_file(tmp_path: Path, data_dir: Path) -> None:
    """Any process that imports the module (a test run, a tool) loads the
    grants. Only the startup hook writes what was taken over."""
    kicks = _folder(tmp_path, "kicks")
    legacy = data_dir / "media_roots.json"
    legacy.write_text(json.dumps({"v": 2, "roots": [str(kicks)]}), encoding="utf-8")
    before = legacy.read_bytes()

    this = _import(THIS_BUILD)

    assert _serves(this, kicks)
    assert legacy.read_bytes() == before
    assert not (data_dir / "clip_audio_roots.json").exists()

    this.finish_start()
    assert _read(legacy) == [str(kicks.resolve())]
    assert _read(data_dir / "clip_audio_roots.json") == {
        "v": 2,
        "roots": [str(kicks.resolve())],
    }


def test_a_start_with_nothing_to_take_over_writes_no_file(data_dir: Path) -> None:
    _start(THIS_BUILD)
    assert list(data_dir.iterdir()) == []


def test_the_takeover_leaves_folders_theDAW_owns_to_their_static_root(
    tmp_path: Path, data_dir: Path
) -> None:
    inside_data = data_dir / "bundles" / "song"
    inside_data.mkdir(parents=True)
    kicks = _folder(tmp_path, "kicks")
    (data_dir / "media_roots.json").write_text(
        json.dumps([str(inside_data), str(kicks)]), encoding="utf-8"
    )

    this = _start(THIS_BUILD)

    assert this._session_roots == [kicks.resolve()]
    assert this.resolve_media_path(str(inside_data / "a.wav")) is not None


def test_a_v2_object_in_media_roots_json_is_taken_over_and_handed_back(
    tmp_path: Path, data_dir: Path
) -> None:
    """The first v2 build wrote its object into main's file name, which main
    reads as no grants. This build takes it over and gives main a list back."""
    kicks = _folder(tmp_path, "kicks")
    (data_dir / "media_roots.json").write_text(
        json.dumps({"v": 2, "roots": [str(kicks)]}), encoding="utf-8"
    )
    assert not _serves(_start(MAIN_BUILD), kicks), "main reads the object as nothing"

    this = _start(THIS_BUILD)
    assert _serves(this, kicks)
    assert _read(data_dir / "media_roots.json") == [str(kicks.resolve())]

    assert _serves(_start(MAIN_BUILD), kicks)
    assert _serves(_start(THIS_BUILD), kicks)


def test_the_takeover_keeps_only_folders_that_exist(
    tmp_path: Path, data_dir: Path
) -> None:
    kicks = _folder(tmp_path, "kicks")
    (data_dir / "media_roots.json").write_text(
        json.dumps(
            [
                str(kicks),
                str(tmp_path / "media" / "missing"),
                str(kicks / "clip.wav"),  # a file, not a folder
                kicks.anchor,  # a drive root is never a grant
                str(kicks),  # a duplicate
                7,
            ]
        ),
        encoding="utf-8",
    )

    this = _start(THIS_BUILD)

    assert this._session_roots == [kicks.resolve()]
    assert _read(data_dir / "clip_audio_roots.json") == {
        "v": 2,
        "roots": [str(kicks.resolve())],
    }


def test_a_state_file_with_the_legacy_name_is_written_once(
    tmp_path: Path, data_dir: Path
) -> None:
    """When ``_ROOTS_STATE`` itself carries the older builds' name, the mirror
    write is skipped so it cannot put a list over this build's own state."""
    this = _start(THIS_BUILD)
    this._ROOTS_STATE = data_dir / "media_roots.json"
    kicks = _folder(tmp_path, "kicks")

    assert this.register_root(kicks / "clip.wav")

    assert _read(data_dir / "media_roots.json") == {
        "v": 2,
        "roots": [str(kicks.resolve())],
    }


def test_two_grants_of_one_folder_in_flight_record_it_once(
    tmp_path: Path, data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """register_root runs on the threadpool. Both calls used to pass the
    membership check before either inserted, and the folder went in twice."""
    this = _start(THIS_BUILD)
    kicks = _folder(tmp_path, "kicks")
    both_checking = threading.Barrier(2, timeout=0.5)

    class RacingRoots(list):
        def __contains__(self, item: object) -> bool:
            # Answers first, then holds that answer until the second check has
            # answered too, so neither can see the other's insert. Under the
            # lock the second check never starts while the first is held: the
            # wait times out and the first goes on alone.
            found = super().__contains__(item)
            try:
                both_checking.wait()
            except threading.BrokenBarrierError:
                pass
            return found

    monkeypatch.setattr(this, "_session_roots", RacingRoots())
    results: list[bool] = []
    threads = [
        threading.Thread(
            target=lambda: results.append(this.register_root(kicks / "clip.wav"))
        )
        for _ in range(2)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert list(this._session_roots) == [kicks.resolve()]
    assert sorted(results) == [False, True]
    assert _read(data_dir / "clip_audio_roots.json") == {
        "v": 2,
        "roots": [str(kicks.resolve())],
    }


def _wait_for(client, url: str, job: str) -> dict:
    deadline = time.monotonic() + 30.0
    while True:
        status = client.get(url, params={"job": job}).json()
        if status["state"] != "running" or time.monotonic() > deadline:
            return status
        time.sleep(0.05)


def test_a_backup_never_carries_the_grants_and_a_restore_never_writes_them(
    tmp_path: Path, data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The grant files decide which folders /clip-audio serves, the same as
    known_paths.json decides which files /api/places/file serves. The backup
    copied every top-level data/*.json, so a restored archive (made on another
    machine, or planted) chose the folders, in this build's file and in the
    list the older builds read."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.lib import known_paths
    from backend.modules.backup import router as backup_router
    from backend.modules.backup import service as backup_service

    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path / "generations"))
    monkeypatch.setattr(known_paths, "_STORE_PATH", tmp_path / "known_paths.json")
    monkeypatch.setattr(known_paths, "_GRANTS", {})
    app = FastAPI()
    app.include_router(backup_router.router, prefix="/api/backup")
    local = TestClient(app, client=("127.0.0.1", 51000))

    # main grants a folder; this build takes it over and grants one more.
    kicks = _folder(tmp_path, "kicks")
    assert _start(MAIN_BUILD).register_root(kicks / "clip.wav")
    this = _start(THIS_BUILD)
    vox = _folder(tmp_path, "vox")
    assert this.register_root(vox / "clip.wav")
    (data_dir / "settings.json").write_text("{}", encoding="utf-8")

    started = local.post(
        "/api/backup/export",
        json={"dest_dir": str(tmp_path / "Backups"), "include": ["settings"]},
    )
    assert started.status_code == 200, started.text
    exported = _wait_for(local, "/api/backup/export/status", started.json()["job"])
    assert exported["state"] == "done", exported
    with zipfile.ZipFile(exported["zip_path"]) as zf:
        assert set(zf.namelist()) == {
            backup_service.MANIFEST_NAME,
            "roots/settings/settings.json",
        }

    grants_before = {
        name: (data_dir / name).read_bytes()
        for name in ("clip_audio_roots.json", "media_roots.json")
    }
    planted = _folder(tmp_path, "planted")
    archive = tmp_path / "Downloads" / "theDAW-backup-planted.zip"
    archive.parent.mkdir()
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr(
            backup_service.MANIFEST_NAME,
            json.dumps({"app": "theDAW", "roots": [{"id": "settings"}]}),
        )
        zf.writestr(
            "roots/settings/clip_audio_roots.json",
            json.dumps({"v": 2, "roots": [str(planted)]}),
        )
        zf.writestr("roots/settings/MEDIA_ROOTS.JSON.", json.dumps([str(planted)]))
        zf.writestr("roots/settings/settings.json", json.dumps({"stems": {}}))

    started = local.post(
        "/api/backup/import", json={"zip_path": str(archive), "mode": "replace"}
    )
    assert started.status_code == 200, started.text
    restored = _wait_for(local, "/api/backup/import/status", started.json()["job"])
    assert restored["state"] == "done", restored

    for name, before in grants_before.items():
        assert (data_dir / name).read_bytes() == before, name
    assert _read(data_dir / "settings.json") == {"stems": {}}
    for start in (_start(THIS_BUILD), _start(MAIN_BUILD)):
        assert not _serves(start, planted)
        assert _serves(start, kicks)
        assert _serves(start, vox)


def test_a_restored_recent_list_grants_only_projects_on_disk(
    tmp_path: Path, data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The grant files stay out of every archive, but the recent-projects list
    goes in, and each recent project's folder is granted: when /recent
    re-reads a restored list, and at every start. register_root grants a
    path's folder whether or not a file is there, so an archive naming
    ``<any folder>/x.tasmo`` chose a folder /clip-audio serves. Only an entry
    naming a .tasmo file on disk counts now."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.lib import known_paths
    from backend.modules.backup import router as backup_router
    from backend.modules.backup import service as backup_service
    from backend.modules.project import media_access as live_media_access
    from backend.modules.project import router as project_router

    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path / "generations"))
    monkeypatch.setattr(known_paths, "_STORE_PATH", tmp_path / "known_paths.json")
    monkeypatch.setattr(known_paths, "_GRANTS", {})
    grants = data_dir / "clip_audio_roots.json"
    monkeypatch.setattr(live_media_access, "_ROOTS_STATE", grants)
    monkeypatch.setattr(live_media_access, "_session_roots", [])
    monkeypatch.setattr(live_media_access, "_needs_write", False, raising=False)
    recent = data_dir / "recent_projects.json"
    monkeypatch.setattr(project_router, "_RECENT_PATH", recent)
    monkeypatch.setattr(project_router, "_recent_files", [])
    monkeypatch.setattr(project_router, "_recent_seen", None)
    app = FastAPI()
    app.include_router(backup_router.router, prefix="/api/backup")
    app.include_router(project_router.router, prefix="/api/project")
    local = TestClient(app, client=("127.0.0.1", 51000))

    planted = _folder(tmp_path, "planted")
    also_planted = _folder(tmp_path, "also-planted")
    real = _folder(tmp_path, "real-project")
    (real / "song.tasmo").write_bytes(b"PK")
    restored_list = [
        {"path": str(planted / "x.tasmo"), "name": "No such file"},
        {"path": str(also_planted), "name": "A folder"},
        {"path": str(real / "song.tasmo"), "name": "Song"},
    ]
    archive = tmp_path / "Downloads" / "theDAW-backup-planted.zip"
    archive.parent.mkdir()
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr(
            backup_service.MANIFEST_NAME,
            json.dumps({"app": "theDAW", "roots": [{"id": "settings"}]}),
        )
        zf.writestr("roots/settings/recent_projects.json", json.dumps(restored_list))

    started = local.post(
        "/api/backup/import", json={"zip_path": str(archive), "mode": "replace"}
    )
    assert started.status_code == 200, started.text
    restored = _wait_for(local, "/api/backup/import/status", started.json()["job"])
    assert restored["state"] == "done", restored

    # The UI asks for the recent list: the restored list comes back whole.
    answer = local.get("/api/project/recent")
    assert answer.status_code == 200, answer.text
    assert answer.json() == restored_list

    for folder in (planted, also_planted):
        assert not _serves(live_media_access, folder), folder
    assert _serves(live_media_access, real)

    # The next start grants the recent projects' folders again, from the
    # project module's startup hook.
    from backend.core import startup

    assert ("clip-audio-roots", project_router._on_start) in startup._hooks
    monkeypatch.setattr(live_media_access, "_session_roots", [])
    project_router._on_start()
    for folder in (planted, also_planted):
        assert not _serves(live_media_access, folder), folder
    assert _serves(live_media_access, real)
    assert _read(grants)["roots"] == [str(real.resolve())]
    assert _read(data_dir / "media_roots.json") == [str(real.resolve())]
