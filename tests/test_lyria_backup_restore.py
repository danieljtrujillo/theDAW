"""Lyria keys survive a backup and restore, whichever build made the backup.

The Lyria keys live in two files in ``data/``: ``lyria_gemini_key.json``,
which main (851f6a0), 8039b45 and this build all write, and
``lyria_provider_keys.json``, the copy only this build writes, with a record
of the key file it last wrote (backend/modules/lyria/sidecar.py _reconcile).
Every build's backup zips ``data/*.json``, so a main backup of a folder this
build also used holds both files, and a backup of main's own folder holds the
key file alone.

Written back as plain files, a restored key file gets a new file identity,
which the sidecar reads as main deleting it and saving it again: every Gemini
key but main's was forgotten. And in merge mode an existing key file kept
main's key out entirely. The backup service now hands both files to
sidecar.restore_key_files.

main's backup is made by main's own code (a verbatim copy in
tests/fixtures/main_851f6a0/backup_service.py) and main's key writes by main's
own sidecar (tests/fixtures/main_851f6a0/lyria_sidecar.py). Every file lives
under tmp_path.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.lib import known_paths
from backend.modules.backup import service as backup_service
from backend.modules.lyria import sidecar

FIXTURES = Path(__file__).parent / "fixtures" / "main_851f6a0"
_KEY_VARS = ("GEMINI_API_KEY", "OPENROUTER_API_KEY")


def _load(name: str, source: Path, monkeypatch: pytest.MonkeyPatch) -> object:
    spec = importlib.util.spec_from_file_location(name, source)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def world(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """One data folder under tmp_path that every build and both backup
    services use, the Lyria key files inside it, and the key pool and the
    provider environment variables emptied."""
    from backend.key_pool import key_pool

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
    key_file = data / "lyria_gemini_key.json"
    monkeypatch.setattr(sidecar, "_KEY_FILE", key_file)
    monkeypatch.setattr(sidecar, "_KEY_FILE_BACKUP", data / "lyria_gemini_key.json.bak")
    for var in (*_KEY_VARS, "AI_PROVIDER"):
        monkeypatch.delenv(var, raising=False)
        for n in range(2, 12):
            monkeypatch.delenv(f"{var}_{n}", raising=False)
    monkeypatch.setattr(key_pool, "get_raw_keys", lambda provider: [])
    stops: list[str] = []
    monkeypatch.setattr(sidecar, "stop", lambda: stops.append("stop") or False)

    main = _load(
        "lyria_sidecar_main_851f6a0", FIXTURES / "lyria_sidecar.py", monkeypatch
    )
    main._GEMINI_KEY_FILE = key_file
    main_backup = _load(
        "backup_service_main_851f6a0", FIXTURES / "backup_service.py", monkeypatch
    )
    return SimpleNamespace(
        data=data,
        key_file=key_file,
        copy=data / "lyria_provider_keys.json",
        main=main,
        main_backup=main_backup,
        dest=tmp_path / "backups",
        stops=stops,
    )


def _export(service: object, dest: Path) -> Path:
    """Run a backup service's export to completion on this thread, into
    ``dest`` (made first, as start_export does)."""
    dest.mkdir(parents=True, exist_ok=True)
    job = service._register_job("export")
    service._run_export(job, dest, None)
    assert job.state == "done", job.error
    return Path(job.zip_path)


def _import(zip_path: Path, mode: str) -> backup_service._Job:
    """Run this build's import to completion on this thread."""
    job = backup_service._register_job("import")
    backup_service._run_import(job, zip_path, mode)
    assert job.state == "done", job.error
    return job


def _state() -> dict:
    return {
        "gemini": sidecar.stored_keys("gemini"),
        "openrouter": sidecar.stored_keys("openrouter"),
        "preference": sidecar.provider_preference(),
        "share": sidecar.pool_shared(),
    }


def _this_build_saves_everything() -> None:
    sidecar.add_key("gemini", "this-g1")
    sidecar.add_key("gemini", "this-g2")
    sidecar.add_key("openrouter", "this-o1")
    sidecar.set_provider_preference("openrouter")
    sidecar.set_pool_shared(True)


def _record_matches(world: SimpleNamespace) -> bool:
    copy = json.loads(world.copy.read_text(encoding="utf-8"))
    digest = hashlib.sha256(world.key_file.read_bytes()).hexdigest()
    return copy["key_file"]["sha256"] == digest


def test_a_main_backup_of_a_shared_folder_brings_back_every_lyria_key(world):
    """The user keeps two Gemini keys, an OpenRouter key, a provider choice
    and the pool share here, then runs main, saves a Gemini key there and
    makes a backup with main's Backup. Later this build's keys are changed
    (one Gemini key removed, the choice cleared) and the user restores
    main's backup, replacing. Every key comes back, main's first."""
    _this_build_saves_everything()
    world.main.set_gemini_key("main-x")
    archive = _export(world.main_backup, world.dest)
    with zipfile.ZipFile(archive) as zf:
        names = set(zf.namelist())
    assert "roots/settings/lyria_gemini_key.json" in names
    assert "roots/settings/lyria_provider_keys.json" in names

    sidecar.remove_key("gemini", 1)
    sidecar.set_provider_preference(None)

    job = _import(archive, "replace")

    assert job.skipped == 0
    assert _state() == {
        "gemini": ["main-x", "this-g1", "this-g2"],
        "openrouter": ["this-o1"],
        "preference": "openrouter",
        "share": True,
    }
    assert world.main.gemini_key() == ("main-x", "file")
    assert _record_matches(world)
    assert world.stops == ["stop"], "a running Lyria is stopped to take the keys"


def test_a_main_backup_restored_into_an_emptied_folder(world):
    """Same backup, restored onto a fresh data folder (a new machine)."""
    _this_build_saves_everything()
    world.main.set_gemini_key("main-x")
    archive = _export(world.main_backup, world.dest)
    world.key_file.unlink()
    world.copy.unlink()

    _import(archive, "replace")

    assert _state()["gemini"] == ["main-x", "this-g1", "this-g2"]
    assert _state()["openrouter"] == ["this-o1"]
    assert _record_matches(world)


def test_a_backup_of_mains_own_folder_merges_its_key_in_first(world):
    """A backup made in main's own data folder holds main's one key and no
    copy. Restored into this build with merge, main's key must still come
    back: merge used to skip the existing key file, main's key and all."""
    world.main.set_gemini_key("main-only")
    archive = _export(world.main_backup, world.dest)
    world.key_file.unlink()
    _this_build_saves_everything()

    job = _import(archive, "merge")

    assert job.skipped == 0
    assert _state() == {
        "gemini": ["this-g1", "this-g2", "main-only"],
        "openrouter": ["this-o1"],
        "preference": "openrouter",
        "share": True,
    }


def test_a_backup_of_mains_own_folder_replacing_keeps_the_keys_it_cannot_hold(
    world,
):
    """Replace with the same main-only backup: main's key goes first, as
    main saving it would; the keys a single-key backup cannot hold stay."""
    world.main.set_gemini_key("main-only")
    archive = _export(world.main_backup, world.dest)
    world.key_file.unlink()
    _this_build_saves_everything()

    _import(archive, "replace")

    assert _state()["gemini"] == ["main-only", "this-g1", "this-g2"]
    assert _state()["openrouter"] == ["this-o1"]
    assert world.main.gemini_key() == ("main-only", "file")


def test_this_builds_backup_holds_both_files_and_restores_its_own_store(world):
    """main saved a key after this build's last write; this build's Backup
    first writes main's key back into the full store, so the archive's key
    file and copy agree. After the keys change, restoring (replace) brings
    back exactly the archived store."""
    _this_build_saves_everything()
    world.main.set_gemini_key("main-x")

    archive = _export(backup_service, world.dest)

    with zipfile.ZipFile(archive) as zf:
        key_file = zf.read("roots/settings/lyria_gemini_key.json")
        copy = json.loads(zf.read("roots/settings/lyria_provider_keys.json"))
    assert json.loads(key_file)["providers"]["gemini"] == [
        "main-x",
        "this-g1",
        "this-g2",
    ]
    assert copy["key_file"]["sha256"] == hashlib.sha256(key_file).hexdigest()

    sidecar.add_key("openrouter", "later-o2")
    sidecar.remove_key("gemini", 0)
    sidecar.set_pool_shared(False)

    _import(archive, "replace")

    assert _state() == {
        "gemini": ["main-x", "this-g1", "this-g2"],
        "openrouter": ["this-o1"],
        "preference": "openrouter",
        "share": True,
    }
    assert _record_matches(world)


def test_a_backup_of_8039b45s_folder_restores_its_lists_and_keeps_the_pool_switch(
    world, monkeypatch
):
    """8039b45 (the first multi-key build) saved its lists in its own data
    folder; its Backup zips data/*.json exactly as main's does (the same
    export code), so main's copy of that code makes the archive here. This
    build, with the pool shared, restores it replacing: the lists are
    8039b45's, and the pool switch, which 8039b45 does not have, stays."""
    old = _load(
        "lyria_sidecar_8039b45",
        Path(__file__).parent / "fixtures" / "pr207_8039b45" / "lyria_sidecar.py",
        monkeypatch,
    )
    old._KEY_FILE = world.key_file
    old._KEY_FILE_BACKUP = world.data / "lyria_gemini_key.json.8039b45.bak"
    old.add_key("gemini", "old-g1")
    old.add_key("openrouter", "old-o1")
    archive = _export(world.main_backup, world.dest)
    world.key_file.unlink()
    _this_build_saves_everything()

    _import(archive, "replace")

    assert _state() == {
        "gemini": ["old-g1"],
        "openrouter": ["old-o1"],
        "preference": None,
        "share": True,
    }
    assert world.main.gemini_key() == ("old-g1", "file")
    assert old.stored_keys("openrouter") == ["old-o1"]
