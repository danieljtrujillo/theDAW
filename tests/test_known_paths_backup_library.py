"""Backup and library folder flows remember their paths.

The backup folder picker opens where the last backup went, a finished export is
remembered as a backup zip that is offered for a restore and never served, the
projects root is the user's projects folder, and the library's music folder
picker opens where the last folder added was. known_paths.json never leaves the
machine in an archive and is never restored from one. folder_dialog's
functions are replaced with recorders, so no dialog opens.
"""

from __future__ import annotations

import inspect
import json
import shutil
import time
import zipfile
from pathlib import Path
from typing import Any, Callable

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.core import folder_dialog
from backend.lib import known_paths
from backend.modules.backup import router as backup_router
from backend.modules.backup import service as backup_service
from backend.modules.library import router as library_router


class _Dialog:
    """Stands in for one folder_dialog function. Records every call's arguments
    by parameter name and answers with the next queued path; None is a cancel."""

    def __init__(self, real: Callable[..., Any], *answers: str | None) -> None:
        self._signature = inspect.signature(real)
        self._answers = list(answers)
        self.calls: list[dict[str, Any]] = []

    def __call__(self, *args: Any, **kwargs: Any) -> str | None:
        bound = self._signature.bind(*args, **kwargs)
        bound.apply_defaults()
        self.calls.append(dict(bound.arguments))
        return self._answers.pop(0) if self._answers else None


def _dialog(
    monkeypatch: pytest.MonkeyPatch, name: str, *answers: str | None
) -> _Dialog:
    fake = _Dialog(getattr(folder_dialog, name), *answers)
    monkeypatch.setattr(folder_dialog, name, fake)
    return fake


def _touch(path: Path, data: bytes = b"x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("theDAW_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path / "generations"))
    monkeypatch.setattr(
        known_paths, "_STORE_PATH", tmp_path / "state" / "known_paths.json"
    )
    monkeypatch.setattr(known_paths, "_GRANTS", {})
    return home


@pytest.fixture
def projects(home: Path, tmp_path: Path) -> Path:
    folder = tmp_path / "My Projects"
    known_paths.set_projects_dir(str(folder))
    return folder


@pytest.fixture
def data_store(home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The store where the app keeps it, inside the data folder the settings
    root backs up."""
    store = tmp_path / "data" / "known_paths.json"
    monkeypatch.setattr(known_paths, "_STORE_PATH", store)
    return store


@pytest.fixture
def backup(home: Path) -> TestClient:
    app = FastAPI()
    app.include_router(backup_router.router, prefix="/api/backup")
    # A loopback TCP peer: the backup routes answer only to this machine's own
    # UI, and TestClient's default peer ("testclient") is not an address.
    return TestClient(app, client=("127.0.0.1", 51000))


@pytest.fixture
def library(home: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(library_router, "_store", None)
    app = FastAPI()
    app.include_router(library_router.router, prefix="/api/library")
    return TestClient(app)


def _wait(client: TestClient, url: str, job: str) -> dict[str, Any]:
    deadline = time.monotonic() + 30.0
    while True:
        status = client.get(url, params={"job": job}).json()
        if status["state"] != "running" or time.monotonic() > deadline:
            return status
        time.sleep(0.05)


def _export(
    client: TestClient, dest_dir: str, include: list[str] | None = None
) -> dict[str, Any]:
    started = client.post(
        "/api/backup/export",
        json={"dest_dir": dest_dir, "include": include or ["projects"]},
    )
    assert started.status_code == 200, started.text
    return _wait(client, "/api/backup/export/status", started.json()["job"])


def _restore(client: TestClient, zip_path: str | Path, mode: str) -> dict[str, Any]:
    started = client.post(
        "/api/backup/import", json={"zip_path": str(zip_path), "mode": mode}
    )
    assert started.status_code == 200, started.text
    return _wait(client, "/api/backup/import/status", started.json()["job"])


# ---------------------------------------------------------------------------
# Backup
# ---------------------------------------------------------------------------


def test_the_backup_folder_picker_opens_in_documents_then_in_the_last_choice(
    backup: TestClient, monkeypatch: pytest.MonkeyPatch, home: Path, tmp_path: Path
) -> None:
    documents = home / "Documents"
    documents.mkdir()
    dest = tmp_path / "Backups"
    dest.mkdir()
    dialog = _dialog(monkeypatch, "pick_folder", str(dest), None)

    assert backup.get("/api/backup/pick-folder").json() == {"path": str(dest)}
    assert dialog.calls[0]["initial"] == str(documents)
    assert [
        (i["path"], i["source"]) for i in known_paths.recent(kind="backup-dest")
    ] == [(str(dest), "pick")]

    assert backup.get("/api/backup/pick-folder").json() == {"path": None}
    assert dialog.calls[1]["initial"] == str(dest)
    # A cancel keeps the earlier choice.
    assert known_paths.last_folder("backup-dest") == str(dest)


def test_a_finished_export_is_remembered_as_a_backup_zip_that_is_never_served(
    backup: TestClient, projects: Path, tmp_path: Path
) -> None:
    _touch(projects / "song.tasmo", b"{}")
    dest = tmp_path / "Backups"

    status = _export(backup, str(dest))
    assert status["state"] == "done", status
    zip_path = status["zip_path"]
    assert Path(zip_path).parent == dest

    items = known_paths.recent(kind="backup-zip")
    assert [(i["path"], i["source"], i["servable"]) for i in items] == [
        (zip_path, "client", False)
    ]
    assert known_paths.find_servable(zip_path) is None
    assert known_paths.last_folder("backup-dest") == str(dest)
    assert known_paths.last_folder("backup-zip") == str(dest)


def test_an_export_with_no_folder_goes_where_the_picker_last_pointed(
    backup: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    projects: Path,
    tmp_path: Path,
) -> None:
    _touch(projects / "song.tasmo", b"{}")
    dest = tmp_path / "Picked Backups"
    dest.mkdir()
    _dialog(monkeypatch, "pick_folder", str(dest))

    backup.get("/api/backup/pick-folder")
    status = _export(backup, "")
    assert status["state"] == "done", status
    assert Path(status["zip_path"]).parent == dest


def test_the_projects_root_is_the_projects_folder_the_user_chose(
    backup: TestClient, projects: Path
) -> None:
    _touch(projects / "song.tasmo", b"{}")

    roots = {r["id"]: r for r in backup.get("/api/backup/manifest").json()["roots"]}
    assert roots["projects"]["path"] == str(projects)
    assert (roots["projects"]["exists"], roots["projects"]["files"]) == (True, 1)


def test_a_restored_zip_is_offered_again_and_never_served(
    backup: TestClient, projects: Path, tmp_path: Path
) -> None:
    _touch(projects / "song.tasmo", b"{}")
    exported = _export(backup, str(tmp_path / "Backups"))["zip_path"]

    assert _restore(backup, exported, "merge")["state"] == "done"
    assert [
        (i["path"], i["source"], i["servable"])
        for i in known_paths.recent(kind="backup-zip")
    ] == [(exported, "client", False)]

    copied = tmp_path / "Elsewhere" / "from-a-friend.zip"
    copied.parent.mkdir()
    shutil.copyfile(exported, copied)
    _restore(backup, copied, "merge")
    newest = known_paths.recent(kind="backup-zip")[0]
    assert (newest["path"], newest["source"], newest["servable"]) == (
        str(copied),
        "client",
        False,
    )
    assert known_paths.last_folder("backup-zip") == str(copied.parent)


def test_an_export_leaves_known_paths_json_out(
    backup: TestClient, data_store: Path, tmp_path: Path
) -> None:
    settings = _touch(tmp_path / "data" / "settings.json", b'{"theme": "ink"}')
    take = _touch(tmp_path / "exports" / "take.wav")
    known_paths.record(take, source="save")
    assert data_store.is_file()

    roots = {r["id"]: r for r in backup.get("/api/backup/manifest").json()["roots"]}
    assert roots["settings"]["files"] == 1
    assert roots["settings"]["bytes"] == settings.stat().st_size

    status = _export(backup, str(tmp_path / "Backups"), include=["settings"])
    assert status["state"] == "done", status
    with zipfile.ZipFile(status["zip_path"]) as zf:
        names = set(zf.namelist())
        manifest = json.loads(zf.read(backup_service.MANIFEST_NAME))
    assert names == {backup_service.MANIFEST_NAME, "roots/settings/settings.json"}
    assert manifest["roots"][0]["files"] == 1


def _crafted_archive(path: Path, members: dict[str, bytes]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(
            backup_service.MANIFEST_NAME,
            json.dumps({"app": "theDAW", "roots": [{"id": "settings"}]}),
        )
        for name, data in members.items():
            zf.writestr(name, data)
    return path


@pytest.mark.parametrize("mode", ["replace", "merge"])
def test_a_restore_never_writes_known_paths_json(
    backup: TestClient,
    data_store: Path,
    tmp_path: Path,
    mode: str,
) -> None:
    """A crafted archive naming the store under any spelling cannot mark a file
    servable or move the projects folder."""
    here = tmp_path / "This PC Projects"
    known_paths.set_projects_dir(str(here))
    secret = _touch(tmp_path / "private" / "api_keys.json", b'{"key": "secret"}')
    forged = json.dumps(
        {
            "recent": {
                "json": [{"path": str(secret), "source": "save", "at": 9e9}],
            },
            "settings": {"projects_dir": str(tmp_path / "Elsewhere")},
        }
    ).encode("utf-8")
    spellings = [
        "known_paths.json",
        "KNOWN_PATHS.JSON",
        "known_paths.json.",
        "known_paths.json ",
        "known_paths.json::$DATA",
        "sub/../known_paths.json",
        "nested/settings.json",
    ]
    archive = _crafted_archive(
        tmp_path / "Downloads" / "theDAW-backup-crafted.zip",
        {
            **{f"roots/settings/{name}": forged for name in spellings},
            "roots/settings/settings.json": b'{"theme": "restored"}',
        },
    )

    status = _restore(backup, archive, mode)
    assert status["state"] == "done", status

    # The store holds the restore's own record of the archive and nothing the
    # archive said.
    stored = json.loads(data_store.read_text(encoding="utf-8"))
    assert stored["settings"] == {"projects_dir": str(here)}
    assert {
        (kind, entry["path"], entry["source"])
        for kind, items in stored["recent"].items()
        for entry in items
    } == {("backup-zip", str(archive), "client")}
    assert known_paths.find_servable(secret) is None
    assert known_paths.projects_dir() == here
    data = tmp_path / "data"
    assert sorted(p.name for p in data.iterdir()) == [
        "known_paths.json",
        "settings.json",
    ]
    assert (data / "settings.json").read_bytes() == b'{"theme": "restored"}'


def test_the_restore_rules_for_a_settings_member() -> None:
    allowed = backup_service._is_restorable_settings_name
    assert allowed("settings.json")
    assert allowed("local_checkpoints.json")
    for refused in (
        "known_paths.json",
        "Known_Paths.JSON",
        "known_paths.json. ",
        "notes.txt",
        "a/settings.json",
        "a\\settings.json",
        "settings.json:alt",
        "",
    ):
        assert not allowed(refused), refused


def test_a_zip_that_is_not_a_backup_is_refused_and_not_remembered(
    backup: TestClient, home: Path, tmp_path: Path
) -> None:
    stray = tmp_path / "photos.zip"
    with zipfile.ZipFile(stray, "w") as zf:
        zf.writestr("a.txt", "hello")

    resp = backup.post("/api/backup/import", json={"zip_path": str(stray)})
    assert resp.status_code == 400
    assert backup_service.MANIFEST_NAME in resp.json()["detail"]
    assert known_paths.recent() == []


# ---------------------------------------------------------------------------
# Library folder import
# ---------------------------------------------------------------------------


def test_the_music_folder_picker_opens_in_music_then_in_the_last_folder_added(
    library: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    home: Path,
    tmp_path: Path,
) -> None:
    music = home / "Music"
    music.mkdir()
    album = tmp_path / "Album"
    _touch(album / "notes.txt")
    dialog = _dialog(monkeypatch, "pick_folder", str(album), None)

    body = library.post("/api/library/import-folder", json={}).json()
    assert (body["cancelled"], body["folder"]) == (False, str(album))
    assert dialog.calls[0]["initial"] == str(music)
    assert [
        (i["path"], i["kind"], i["source"], i["servable"])
        for i in known_paths.recent(kind="library-folder")
    ] == [(str(album), "library-folder", "library-folder", False)]

    cancelled = library.post("/api/library/import-folder", json={}).json()
    assert cancelled == {"cancelled": True, "folder": None, "entries": []}
    assert dialog.calls[1]["initial"] == str(album)


def test_a_typed_music_folder_is_remembered_without_a_dialog(
    library: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    album = tmp_path / "Typed Album"
    album.mkdir()
    dialog = _dialog(monkeypatch, "pick_folder", None)

    body = library.post("/api/library/import-folder", json={"path": str(album)})
    assert body.json()["folder"] == str(album)
    assert dialog.calls == []
    assert known_paths.last_folder("library-folder") == str(album)


def test_a_path_that_is_not_a_folder_is_refused_and_not_remembered(
    library: TestClient, tmp_path: Path
) -> None:
    take = _touch(tmp_path / "take.wav")

    resp = library.post("/api/library/import-folder", json={"path": str(take)})
    assert resp.status_code == 400
    assert known_paths.recent() == []


# ---------------------------------------------------------------------------
# Who may open a dialog
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "headers",
    [
        {"sec-fetch-site": "cross-site"},
        {"origin": "https://evil.example"},
    ],
)
def test_a_page_on_another_site_cannot_open_the_backup_or_music_pickers(
    backup: TestClient,
    library: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    headers: dict[str, str],
) -> None:
    folder = tmp_path / "Somewhere"
    folder.mkdir()
    dialog = _dialog(monkeypatch, "pick_folder", str(folder), str(folder))

    assert backup.get("/api/backup/pick-folder", headers=headers).status_code == 403
    resp = library.post("/api/library/import-folder", json={}, headers=headers)
    assert resp.status_code == 403
    assert dialog.calls == []
    assert known_paths.recent() == []


@pytest.mark.parametrize(("timed_out", "status"), [(True, 504), (False, 500)])
def test_a_backup_or_music_folder_dialog_that_fails_answers_an_error(
    backup: TestClient,
    library: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    timed_out: bool,
    status: int,
) -> None:
    """A dialog that failed or timed out is an error with its reason, never a
    cancel, and remembers nothing."""
    message = "The folder dialog could not open."
    calls: list[Any] = []

    def failing_pick(*args: Any, **kwargs: Any) -> str | None:
        calls.append((args, kwargs))
        raise folder_dialog.PickerError(message, timed_out=timed_out)

    monkeypatch.setattr(folder_dialog, "pick_folder", failing_pick)

    resp = backup.get("/api/backup/pick-folder")
    assert (resp.status_code, resp.json()) == (status, {"detail": message})
    resp = library.post("/api/library/import-folder", json={})
    assert (resp.status_code, resp.json()) == (status, {"detail": message})
    assert len(calls) == 2
    assert known_paths.recent() == []


@pytest.mark.parametrize(
    "headers",
    [
        {"sec-fetch-site": "cross-site"},
        {"origin": "https://evil.example"},
    ],
)
def test_a_page_on_another_site_cannot_list_export_or_restore_a_backup(
    backup: TestClient, projects: Path, tmp_path: Path, headers: dict[str, str]
) -> None:
    """An export writes the user's keys into a zip and a restore overwrites user
    data, so neither starts for a page on another site."""
    _touch(projects / "song.tasmo", b"{}")
    dest = tmp_path / "Backups"
    archive = _touch(tmp_path / "theDAW-backup-crafted.zip", b"PK")

    assert backup.get("/api/backup/manifest", headers=headers).status_code == 403
    started = backup.post(
        "/api/backup/export",
        json={"dest_dir": str(dest), "include": ["projects"]},
        headers=headers,
    )
    assert started.status_code == 403
    restored = backup.post(
        "/api/backup/import",
        json={"zip_path": str(archive), "mode": "replace"},
        headers=headers,
    )
    assert restored.status_code == 403
    status = backup.get(
        "/api/backup/export/status", params={"job": "any"}, headers=headers
    )
    assert status.status_code == 403
    assert not dest.exists()
    assert known_paths.recent() == []


def test_theDAWs_own_page_still_reaches_the_backup_routes(
    backup: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    dialog = _dialog(monkeypatch, "pick_folder", None)
    own = {"sec-fetch-site": "same-origin"}

    assert backup.get("/api/backup/pick-folder", headers=own).json() == {"path": None}
    assert len(dialog.calls) == 1
    missing = backup.get("/api/backup/import/status", params={"job": "x"}, headers=own)
    assert missing.status_code == 404
