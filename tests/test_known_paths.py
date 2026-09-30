"""What theDAW remembers about paths, and what that memory lets through.

known_paths is behind every picker's starting folder and every Recent menu, and
it is the gate on /api/places/file and /api/places/save. The rules pinned here
are the security ones (only a servable source is served, a save grant is a
nonce that writes once and never a script, a network share is never touched)
and the ones a user notices (a picker starts where the last one ended, a
deleted file drops out of the list).
"""

from __future__ import annotations

import hmac
import json
import os
import shutil
from pathlib import Path

import pytest

from backend.lib import known_paths


@pytest.fixture
def store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An empty store under tmp_path, a home folder with nothing in it, and a
    data root of our own."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("theDAW_DATA_DIR", str(tmp_path / "data"))
    path = tmp_path / "state" / "known_paths.json"
    monkeypatch.setattr(known_paths, "_STORE_PATH", path)
    monkeypatch.setattr(known_paths, "_GRANTS", {})
    return path


def _touch(path: Path, data: bytes = b"x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


REMOTE_PATHS = [
    "\\\\server\\share\\take.wav",
    "//server/share/take.wav",
    "\\\\?\\C:\\takes\\take.wav",
    "\\\\.\\PhysicalDrive0",
    "/\\server\\share\\take.wav",
]


@pytest.mark.parametrize(
    ("name", "kind"),
    [
        ("song.tasmo", "tasmo"),
        ("pad.gan", "gan"),
        ("scene.sway", "sway"),
        ("capture.ares", "ares"),
        ("set.als", "daw-project"),
        ("session.rpp-bak", "daw-project"),
        ("session.pts", "daw-project"),
        ("take.WAV", "audio"),
        ("mix.flac", "audio"),
        ("clip.webm", "audio"),
        ("groove.mid", "midi"),
        ("lead.musicxml", "score"),
        ("chart.pdf", "score"),
        ("words.lrc", "lyrics"),
        ("notes.txt", "lyrics"),
        ("export.json", "json"),
        ("cover.jpeg", "image"),
        ("show.mkv", "video"),
        ("bundle.zip", "zip"),
        ("model.safetensors", "checkpoint"),
        ("companion.apk", "apk"),
        ("readme.md", "file"),
        ("no-extension", "file"),
    ],
)
def test_kind_follows_the_extension(name: str, kind: str, tmp_path: Path) -> None:
    assert known_paths.kind_for_path(tmp_path / name) == kind


def test_a_directory_is_a_folder_unless_it_is_a_project_bundle(tmp_path: Path) -> None:
    plain = tmp_path / "Samples.wav"
    plain.mkdir()
    bundle = tmp_path / "Song.logicx"
    bundle.mkdir()
    assert known_paths.kind_for_path(plain) == "folder"
    assert known_paths.kind_for_path(bundle) == "daw-project"


def test_a_missing_path_is_not_remembered(store: Path, tmp_path: Path) -> None:
    assert known_paths.record(tmp_path / "nope.wav", source="pick") is None
    assert known_paths.recent() == []
    assert not store.exists()


def test_record_stores_the_entry_and_its_folder(store: Path, tmp_path: Path) -> None:
    take = _touch(tmp_path / "takes" / "take.wav")
    entry = known_paths.record(take, source="pick")
    assert entry is not None
    assert entry["path"] == str(take)
    assert entry["name"] == "take.wav"
    assert entry["kind"] == "audio"
    assert entry["source"] == "pick"
    assert entry["servable"] is True
    assert isinstance(entry["at"], float)
    assert known_paths.last_folder("audio") == str(take.parent)

    library = tmp_path / "library"
    library.mkdir()
    folder_entry = known_paths.record(
        library, kind="library-folder", source="library-folder"
    )
    assert folder_entry is not None
    assert folder_entry["servable"] is False
    assert known_paths.last_folder("library-folder") == str(library)

    raw = json.loads(store.read_text(encoding="utf-8"))
    stored = raw["recent"]["audio"][0]
    assert stored["path"] == str(take)
    # Servable is worked out on every read, so a stored flag cannot be forged.
    assert "servable" not in stored


def test_recording_again_moves_the_path_to_the_front_once(
    store: Path, tmp_path: Path
) -> None:
    first = _touch(tmp_path / "a.mid")
    second = _touch(tmp_path / "b.mid")
    known_paths.record(first, source="pick")
    known_paths.record(second, source="pick")
    known_paths.record(first, source="pick")
    names = [e["name"] for e in known_paths.recent(kind="midi")]
    assert names == ["a.mid", "b.mid"]


@pytest.mark.skipif(os.name != "nt", reason="case-insensitive paths are Windows")
def test_windows_paths_match_without_regard_to_case(
    store: Path, tmp_path: Path
) -> None:
    take = _touch(tmp_path / "Take.wav")
    known_paths.record(take, source="pick")
    known_paths.record(str(take).upper(), source="pick")
    assert len(known_paths.recent(kind="audio")) == 1
    assert known_paths.find_servable(str(take).lower()) is not None


def test_each_kind_keeps_the_newest_thirty(store: Path, tmp_path: Path) -> None:
    for i in range(known_paths.MAX_PER_KIND + 5):
        known_paths.record(_touch(tmp_path / f"t{i:02}.wav"), source="pick")
    items = known_paths.recent(kind="audio", limit=100)
    names = [e["name"] for e in items]
    assert len(items) == known_paths.MAX_PER_KIND
    assert names[0] == f"t{known_paths.MAX_PER_KIND + 4:02}.wav"
    assert "t04.wav" not in names


def test_kinds_are_capped(store: Path, tmp_path: Path) -> None:
    take = _touch(tmp_path / "take.wav")
    total = known_paths.MAX_KINDS + 5
    for i in range(total):
        known_paths.record(take, kind=f"k{i}", source="client")
    raw = json.loads(store.read_text(encoding="utf-8"))
    assert len(raw["recent"]) == known_paths.MAX_KINDS
    assert len(raw["folders"]) == known_paths.MAX_KINDS
    assert "k0" not in raw["recent"]
    assert f"k{total - 1}" in raw["recent"]


def test_an_invalid_kind_falls_back_to_the_extension(
    store: Path, tmp_path: Path
) -> None:
    take = _touch(tmp_path / "take.wav")
    assert known_paths.record(take, kind="../../etc", source="pick")["kind"] == "audio"
    assert known_paths.record(take, kind="", source="pick")["kind"] == "audio"
    assert known_paths.record(take, kind="Big Kind", source="pick")["kind"] == "audio"


def test_recent_drops_missing_files_and_filters_by_extension(
    store: Path, tmp_path: Path
) -> None:
    keep = _touch(tmp_path / "keep.mid")
    gone = _touch(tmp_path / "gone.midi")
    wav = _touch(tmp_path / "x.wav")
    for p in (keep, gone, wav):
        known_paths.record(p, source="pick")
    gone.unlink()

    assert [e["name"] for e in known_paths.recent(exts=[".mid", "MIDI"])] == [
        "keep.mid"
    ]
    assert {e["name"] for e in known_paths.recent()} == {"keep.mid", "x.wav"}
    assert [e["name"] for e in known_paths.recent(kind="audio")] == ["x.wav"]
    assert len(known_paths.recent(limit=1)) == 1
    assert known_paths.recent(limit=0) == []


# ---------------------------------------------------------------------------
# Servable sources
# ---------------------------------------------------------------------------


def test_the_servable_sources_are_exactly_these() -> None:
    assert known_paths.SERVABLE_SOURCES == {
        "install",
        "save",
        "pick",
        "gan",
        "sway-save",
        "sway-render",
        "download",
    }


@pytest.mark.parametrize(
    "source", ["install", "save", "pick", "gan", "sway-save", "download"]
)
def test_a_file_with_a_servable_source_is_served(
    store: Path, tmp_path: Path, source: str
) -> None:
    kept = _touch(tmp_path / source / "take.wav")
    assert known_paths.record(kept, source=source)["servable"] is True
    assert known_paths.find_servable(kept) == str(kept)


@pytest.mark.parametrize("source", ["client", "project", "backup", "library-folder"])
def test_a_file_with_any_other_source_is_never_served(
    store: Path, tmp_path: Path, source: str
) -> None:
    kept = _touch(tmp_path / source / "keys.json")
    entry = known_paths.record(kept, source=source)
    assert entry is not None
    assert entry["servable"] is False
    assert known_paths.recent()[0]["servable"] is False
    assert known_paths.find_servable(kept) is None
    # Still useful for the next picker.
    assert known_paths.last_folder("json") == str(kept.parent)


def test_a_client_record_keeps_a_picked_file_servable(
    store: Path, tmp_path: Path
) -> None:
    picked = _touch(tmp_path / "picked.wav")
    known_paths.record(picked, source="pick")
    again = known_paths.record(picked, source="client")
    assert again is not None
    assert again["source"] == "pick"
    assert known_paths.find_servable(picked) == str(picked)

    # Recorded under another kind as well: one row, still servable.
    known_paths.record(picked, kind="stems", source="client")
    items = known_paths.recent()
    assert len(items) == 1
    assert items[0]["servable"] is True


def test_find_servable_answers_with_the_stored_path(
    store: Path, tmp_path: Path
) -> None:
    saved = _touch(tmp_path / "out" / "mix.wav")
    known_paths.record(saved, source="save")
    spelled = tmp_path / "out" / ".." / "out" / "mix.wav"
    assert known_paths.find_servable(str(spelled)) == str(saved)
    assert known_paths.find_servable(tmp_path / "out" / "other.wav") is None
    assert known_paths.find_servable("") is None

    picked_folder = tmp_path / "picked-folder"
    picked_folder.mkdir()
    known_paths.record(picked_folder, kind="folder", source="pick")
    assert known_paths.find_servable(picked_folder) is None

    saved.unlink()
    assert known_paths.find_servable(saved) is None


# ---------------------------------------------------------------------------
# Network shares and device paths
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("remote", REMOTE_PATHS)
def test_a_share_or_device_path_is_never_remembered_or_touched(
    store: Path, monkeypatch: pytest.MonkeyPatch, remote: str
) -> None:
    touched: list[str] = []

    def spy(path: str | os.PathLike[str]) -> bool:
        touched.append(os.fspath(path))
        return True

    for name in ("_exists", "_isdir", "_isfile"):
        monkeypatch.setattr(known_paths, name, spy)

    assert known_paths.is_remote_or_device_path(remote) is True
    assert known_paths._absolute(remote) is None
    assert known_paths.record(remote, kind="audio", source="pick") is None
    known_paths.record_folder("audio", remote)
    assert known_paths.find_servable(remote) is None
    assert known_paths.grant_save(remote) is None
    known_paths.set_installed_asset("demo", remote)
    known_paths.kind_for_path(remote)
    with pytest.raises(ValueError):
        known_paths.set_projects_dir(remote)

    assert touched == []
    assert not store.exists()


@pytest.mark.parametrize(
    "local", ["C:\\Music\\take.wav", "/home/me/take.wav", "relative/take.wav", ""]
)
def test_a_local_spelling_is_not_a_share(local: str) -> None:
    assert known_paths.is_remote_or_device_path(local) is False


def test_a_store_holding_share_paths_drops_them_unread(
    store: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A store written before shares were refused must not reach the share on a
    later read."""
    share = "\\\\server\\share"
    take = _touch(tmp_path / "take.wav")
    store.parent.mkdir(parents=True)
    store.write_text(
        json.dumps(
            {
                "recent": {
                    "audio": [
                        {"path": share + "\\take.wav", "source": "pick", "at": 2.0},
                        {"path": str(take), "source": "pick", "at": 1.0},
                    ]
                },
                "folders": {"audio": share},
                "settings": {"projects_dir": share + "\\Projects"},
                "installed": {"demo": share + "\\demo.tasmo"},
            }
        ),
        encoding="utf-8",
    )
    touched: list[str] = []
    for name in ("_exists", "_isdir", "_isfile"):
        real = getattr(known_paths, name)

        def spy(path: str | os.PathLike[str], _real=real) -> bool:
            touched.append(os.fspath(path))
            return _real(path)

        monkeypatch.setattr(known_paths, name, spy)

    assert [e["path"] for e in known_paths.recent()] == [str(take)]
    assert known_paths.last_folder("audio") is None
    assert known_paths.projects_dir() == (
        tmp_path / "home" / "Documents" / "theDAW Projects"
    )
    assert known_paths.projects_dir_configured() is False
    assert known_paths.installed_asset_path("demo") is None
    assert known_paths.find_servable(share + "\\take.wav") is None
    assert not [p for p in touched if known_paths.is_remote_or_device_path(p)]


# ---------------------------------------------------------------------------
# Folders
# ---------------------------------------------------------------------------


def test_last_folder_falls_back_when_the_folder_is_gone(
    store: Path, tmp_path: Path
) -> None:
    downloads = tmp_path / "home" / "Downloads"
    assert known_paths.last_folder("audio") is None
    downloads.mkdir()
    assert known_paths.last_folder("audio") == str(downloads)

    take = _touch(tmp_path / "session" / "take.wav")
    known_paths.record(take, source="pick")
    assert known_paths.last_folder("audio") == str(take.parent)

    take.unlink()
    take.parent.rmdir()
    assert known_paths.last_folder("audio") == str(downloads)


def test_default_folders(store: Path, tmp_path: Path) -> None:
    home = tmp_path / "home"
    data = tmp_path / "data"
    assert known_paths.default_folder("tasmo") == str(
        home / "Documents" / "theDAW Projects"
    )
    assert known_paths.default_folder("gan") == str(data / "plugins")
    assert known_paths.default_folder("sway") == str(data / "sway-projects")
    assert known_paths.default_folder("ares") == str(data / "volumetric")
    assert known_paths.default_folder("backup-zip") is None
    assert known_paths.default_folder("library-folder") is None
    assert known_paths.default_folder("checkpoint") is None
    assert known_paths.default_folder("apk") is None
    assert known_paths.default_folder("download") is None
    assert known_paths.default_folder("meter-report") is None
    assert known_paths.default_folder("foundry-export") is None
    assert known_paths.default_folder(None) is None

    (home / "Documents").mkdir()
    (home / "Music").mkdir()
    (home / "Downloads").mkdir()
    assert known_paths.default_folder("backup-zip") == str(home / "Documents")
    assert known_paths.default_folder("backup-dest") == str(home / "Documents")
    assert known_paths.default_folder("library-folder") == str(home / "Music")
    assert known_paths.default_folder("apk") == str(home / "Downloads")
    assert known_paths.default_folder("download") == str(home / "Downloads")
    assert known_paths.default_folder("meter-report") == str(home / "Downloads")
    # The JSON export kinds have no default of their own; they follow json.
    for kind in JSON_EXPORT_KINDS:
        assert known_paths.default_folder(kind) is None
        assert known_paths.last_folder(kind) == str(home / "Downloads")


JSON_EXPORT_KINDS = [
    "nodefi-set",
    "v2m-recordings",
    "meter-map",
    "lineage-json",
    "library-metadata",
]


@pytest.mark.parametrize("kind", JSON_EXPORT_KINDS)
def test_a_json_export_kind_follows_json_until_it_has_a_folder_of_its_own(
    store: Path, tmp_path: Path, kind: str
) -> None:
    assert known_paths.last_folder(kind) is None

    chart = _touch(tmp_path / "Charts" / "chart.json")
    known_paths.record(chart, source="save")
    assert known_paths.last_folder(kind) == str(chart.parent)

    own = _touch(tmp_path / "Exports" / f"{kind}.json")
    known_paths.record(own, kind=kind, source="save")
    assert known_paths.last_folder(kind) == str(own.parent)

    later = _touch(tmp_path / "Later" / "other.json")
    known_paths.record(later, source="save")
    assert known_paths.last_folder("json") == str(later.parent)
    assert known_paths.last_folder(kind) == str(own.parent)

    shutil.rmtree(own.parent)
    assert known_paths.last_folder(kind) == str(later.parent)


def test_record_folder_needs_an_existing_folder(store: Path, tmp_path: Path) -> None:
    known_paths.record_folder("backup-dest", tmp_path / "missing")
    assert known_paths.last_folder("backup-dest") is None
    known_paths.record_folder("backup-dest", tmp_path)
    assert known_paths.last_folder("backup-dest") == str(tmp_path)
    known_paths.record_folder("Not A Kind", tmp_path)
    raw = json.loads(store.read_text(encoding="utf-8"))
    assert raw["folders"] == {"backup-dest": str(tmp_path)}


def test_a_record_without_the_folder_update_keeps_the_users_folder(
    store: Path, tmp_path: Path
) -> None:
    """The plugin shelf copy of a .gan the user opened joins Recent, and the
    next .gan picker still opens where the user's own file was."""
    picked = _touch(tmp_path / "Mine" / "pad.gan")
    known_paths.record(picked, source="pick")
    shelf = _touch(tmp_path / "plugins" / "pad-id.gan")

    entry = known_paths.record(shelf, kind="gan", source="gan", update_folder=False)
    assert entry is not None
    assert (entry["source"], entry["servable"]) == ("gan", True)
    assert [e["path"] for e in known_paths.recent(kind="gan")] == [
        str(shelf),
        str(picked),
    ]
    assert known_paths.last_folder("gan") == str(picked.parent)

    first = _touch(tmp_path / "plugins" / "scene.sway")
    known_paths.record(first, source="sway-save", update_folder=False)
    raw = json.loads(store.read_text(encoding="utf-8"))
    assert "sway" not in raw["folders"]
    assert [e["path"] for e in raw["recent"]["sway"]] == [str(first)]


def test_the_foundry_import_picker_follows_project_json_then_json(
    store: Path, tmp_path: Path
) -> None:
    downloads = tmp_path / "home" / "Downloads"
    assert known_paths.last_folder("foundry-export") is None
    downloads.mkdir()
    # No folder of its own: the json picker's folder, here its default.
    assert known_paths.last_folder("foundry-export") == str(downloads)

    chart = _touch(tmp_path / "Charts" / "chart.json")
    known_paths.record(chart, source="save")
    assert known_paths.last_folder("foundry-export") == str(chart.parent)

    export = _touch(tmp_path / "Foundry" / "Pad" / "PROJECT.JSON")
    known_paths.record(export, source="download")
    assert known_paths.last_folder("foundry-export") == str(export.parent)

    later = _touch(tmp_path / "Meters" / "meter.json")
    known_paths.record(later, source="save")
    assert known_paths.last_folder("json") == str(later.parent)
    assert known_paths.last_folder("foundry-export") == str(export.parent)

    # A copy the app keeps for itself moves no folder.
    kept = _touch(tmp_path / "Kept" / "project.json")
    known_paths.record(kept, source="save", update_folder=False)
    assert known_paths.last_folder("foundry-export") == str(export.parent)

    # A folder named project.json is not an export.
    folder = tmp_path / "Odd" / "project.json"
    folder.mkdir(parents=True)
    known_paths.record(folder, source="pick")
    assert known_paths.last_folder("foundry-export") == str(export.parent)

    shutil.rmtree(export.parent)
    assert known_paths.last_folder("foundry-export") == str(later.parent)


# ---------------------------------------------------------------------------
# The projects folder
# ---------------------------------------------------------------------------


def test_projects_dir_is_stored_and_must_be_a_local_absolute_path(
    store: Path, tmp_path: Path
) -> None:
    home = tmp_path / "home"
    default = home / "Documents" / "theDAW Projects"
    assert known_paths.projects_dir() == default
    assert known_paths.projects_dir_configured() is False

    chosen = tmp_path / "My Projects"
    assert known_paths.set_projects_dir(str(chosen)) == chosen
    assert known_paths.projects_dir() == chosen
    assert known_paths.projects_dir_configured() is True
    assert known_paths.default_folder("tasmo") == str(chosen)

    for bad in ("", "   ", "relative/projects", *REMOTE_PATHS):
        with pytest.raises(ValueError):
            known_paths.set_projects_dir(bad)
    assert known_paths.projects_dir() == chosen


def test_choosing_the_default_folder_still_counts_as_configured(
    store: Path, tmp_path: Path
) -> None:
    default = tmp_path / "home" / "Documents" / "theDAW Projects"
    known_paths.set_projects_dir(default)
    assert known_paths.projects_dir() == default
    assert known_paths.projects_dir_configured() is True


def test_installed_asset_path_needs_the_file(store: Path, tmp_path: Path) -> None:
    copy = _touch(tmp_path / "Projects" / "demo.tasmo")
    known_paths.set_installed_asset("demo", copy)
    assert known_paths.installed_asset_path("demo") == str(copy)
    assert known_paths.installed_asset_path("other") is None
    copy.unlink()
    assert known_paths.installed_asset_path("demo") is None


# ---------------------------------------------------------------------------
# Save grants
# ---------------------------------------------------------------------------


def test_a_save_grant_is_a_nonce_that_writes_once(store: Path, tmp_path: Path) -> None:
    target = tmp_path / "exports" / "mix.wav"
    assert known_paths.peek_save_grant(target, "guess") is False
    assert known_paths.consume_save_grant(target, "guess") is False

    nonce = known_paths.grant_save(target)
    assert isinstance(nonce, str)
    assert len(nonce) == 32
    # Grants live in memory only.
    assert not store.exists()

    # Peeking spends nothing.
    assert known_paths.peek_save_grant(target, nonce) is True
    assert known_paths.peek_save_grant(target, nonce) is True
    for wrong in ("", nonce + "x", nonce[:-1], "é", None):
        assert known_paths.peek_save_grant(target, wrong) is False  # type: ignore[arg-type]
        assert known_paths.consume_save_grant(target, wrong) is False  # type: ignore[arg-type]
    other = tmp_path / "exports" / "other.wav"
    assert known_paths.peek_save_grant(other, nonce) is False
    assert known_paths.consume_save_grant(other, nonce) is False

    spelled = tmp_path / "exports" / "." / "mix.wav"
    assert known_paths.consume_save_grant(spelled, nonce) is True
    assert known_paths.consume_save_grant(target, nonce) is False
    assert known_paths.peek_save_grant(target, nonce) is False


def test_two_dialogs_answered_with_one_path_each_get_a_grant(
    store: Path, tmp_path: Path
) -> None:
    target = tmp_path / "exports" / "mix.wav"
    first = known_paths.grant_save(target)
    second = known_paths.grant_save(target)
    assert first and second and first != second
    assert known_paths.consume_save_grant(target, second) is True
    assert known_paths.consume_save_grant(target, first) is True
    assert known_paths.consume_save_grant(target, first) is False


def test_a_save_grant_expires_after_ten_minutes(
    store: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    now = [1000.0]
    monkeypatch.setattr(known_paths, "_clock", lambda: now[0])
    target = tmp_path / "late.wav"
    nonce = known_paths.grant_save(target)
    assert known_paths.SAVE_GRANT_SECONDS == 600.0
    now[0] += known_paths.SAVE_GRANT_SECONDS - 1
    assert known_paths.peek_save_grant(target, nonce) is True
    now[0] += 2
    assert known_paths.peek_save_grant(target, nonce) is False
    assert known_paths.consume_save_grant(target, nonce) is False
    assert known_paths._GRANTS == {}


def test_nonces_are_compared_in_constant_time(
    store: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    compared: list[tuple[bytes, bytes]] = []
    real = hmac.compare_digest

    def spy(a: bytes, b: bytes) -> bool:
        compared.append((a, b))
        return real(a, b)

    monkeypatch.setattr(known_paths.hmac, "compare_digest", spy)
    target = tmp_path / "mix.wav"
    nonce = known_paths.grant_save(target)
    assert known_paths.consume_save_grant(target, nonce) is True
    assert compared == [(nonce.encode(), nonce.encode())]


def test_the_blocked_save_types_are_exactly_these() -> None:
    assert known_paths.BLOCKED_SAVE_EXTS == {
        ".exe",
        ".bat",
        ".cmd",
        ".com",
        ".ps1",
        ".psm1",
        ".vbs",
        ".vbe",
        ".js",
        ".jse",
        ".wsf",
        ".wsh",
        ".hta",
        ".lnk",
        ".scr",
        ".msi",
        ".msp",
        ".dll",
        ".cpl",
        ".reg",
        ".jar",
        ".sh",
        ".app",
        ".desktop",
        ".url",
        ".pif",
        ".appref-ms",
        ".application",
        ".chm",
        ".gadget",
        ".inf",
        ".msc",
        ".ps1xml",
        ".psd1",
        ".py",
        ".pyw",
        ".scf",
        ".sct",
        ".settingcontent-ms",
        ".shb",
        ".shs",
        ".ws",
        ".wsb",
        ".wsc",
        ".xll",
    }


@pytest.mark.parametrize(
    "name",
    [
        *(f"file{ext}" for ext in sorted(known_paths.BLOCKED_SAVE_EXTS)),
        "SETUP.EXE",
        "Run.Cmd",
        ".cmd",
        "archive.tar.sh",
    ],
)
def test_a_program_or_script_is_never_granted(
    store: Path, tmp_path: Path, name: str
) -> None:
    target = tmp_path / "Startup" / name
    assert known_paths.is_blocked_save_path(target) is True
    assert known_paths.grant_save(target) is None
    assert known_paths._GRANTS == {}


@pytest.mark.skipif(os.name != "nt", reason="Windows file name rules")
@pytest.mark.parametrize(
    "name",
    ["run.cmd.", "run.cmd. . ", "run.cmd::$DATA", "notes.txt:run.cmd", "run.cmd\\"],
)
def test_a_windows_spelling_of_a_script_is_never_granted(
    store: Path, tmp_path: Path, name: str
) -> None:
    target = f"{tmp_path}\\Startup\\{name}"
    assert known_paths.is_blocked_save_path(target) is True
    assert known_paths.grant_save(target) is None


@pytest.mark.parametrize(
    "name",
    [
        "mix.wav",
        "song.tasmo",
        "project.json",
        "cover.png",
        "notes.txt",
        "bundle.tar.gz",
        "component.jsx",
        "no-extension",
    ],
)
def test_a_media_or_document_file_is_granted(
    store: Path, tmp_path: Path, name: str
) -> None:
    target = tmp_path / "exports" / name
    assert known_paths.is_blocked_save_path(target) is False
    assert known_paths.grant_save(target) is not None


# ---------------------------------------------------------------------------
# A damaged store
# ---------------------------------------------------------------------------


def test_a_corrupt_store_reads_as_empty_and_is_rewritten(
    store: Path, tmp_path: Path
) -> None:
    store.parent.mkdir(parents=True)
    store.write_text("{not json", encoding="utf-8")
    assert known_paths.recent() == []
    assert known_paths.last_folder("checkpoint") is None

    take = _touch(tmp_path / "take.wav")
    assert known_paths.record(take, source="pick") is not None
    raw = json.loads(store.read_text(encoding="utf-8"))
    assert raw["recent"]["audio"][0]["name"] == "take.wav"


def test_malformed_entries_are_dropped(store: Path, tmp_path: Path) -> None:
    take = _touch(tmp_path / "take.wav")
    store.parent.mkdir(parents=True)
    store.write_text(
        json.dumps(
            {
                "recent": {
                    "audio": [
                        {"path": str(take), "source": "pick", "at": 1.0},
                        {"path": 5, "source": "pick", "at": 2.0},
                        {"path": str(take), "source": "pick", "at": "yesterday"},
                        "junk",
                    ],
                    "Bad Kind!": [{"path": str(take), "source": "pick", "at": 3.0}],
                },
                "folders": {"audio": 3},
                "installed": ["not", "a", "map"],
            }
        ),
        encoding="utf-8",
    )
    items = known_paths.recent()
    assert [(e["name"], e["kind"], e["servable"]) for e in items] == [
        ("take.wav", "audio", True)
    ]
    assert known_paths.installed_asset_path("demo") is None


def test_an_unwritable_store_never_raises(
    store: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    blocker = tmp_path / "blocker"
    blocker.write_text("a file where the store folder should be", encoding="utf-8")
    monkeypatch.setattr(known_paths, "_STORE_PATH", blocker / "known_paths.json")

    take = _touch(tmp_path / "take.wav")
    assert known_paths.record(take, source="pick") is not None
    known_paths.record_folder("audio", tmp_path)
    known_paths.set_installed_asset("demo", take)
    assert known_paths.set_projects_dir(str(tmp_path / "P")) == tmp_path / "P"
    assert known_paths.recent() == []
    assert known_paths.find_servable(take) is None
