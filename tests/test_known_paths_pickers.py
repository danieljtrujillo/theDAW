"""The native pickers in /api/storage open where the last path of a kind was,
remember what the user chooses, and report a dialog that failed as an error.

folder_dialog's functions are replaced with recorders, so no dialog opens. Each
sequence test replays the order the app produces: a first pick with no history,
then a second picker that has to open where the first one landed. The
folder_dialog tests at the end run its PowerShell and tkinter paths with the
process or the Tk module replaced, plus real PowerShell scripts that show no
dialog when this machine has PowerShell.
"""

from __future__ import annotations

import inspect
import os
import shutil
import subprocess
import sys
import types
from pathlib import Path
from typing import Any, Callable

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.core import folder_dialog
from backend.lib import known_paths, paths
from backend.modules.places import router as places_router
from backend.modules.quest import router as quest_router
from backend.modules.storage import router as storage_router
from backend.modules.vj import router as vj_router


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


def _failing_dialog(
    monkeypatch: pytest.MonkeyPatch, name: str, error: BaseException
) -> list[dict[str, Any]]:
    """Replace one folder_dialog function with one that raises ``error``."""
    real = getattr(folder_dialog, name)
    calls: list[dict[str, Any]] = []

    def fake(*args: Any, **kwargs: Any) -> str | None:
        bound = inspect.signature(real).bind(*args, **kwargs)
        bound.apply_defaults()
        calls.append(dict(bound.arguments))
        raise error

    monkeypatch.setattr(folder_dialog, name, fake)
    return calls


def _spy_grants(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str | None]]:
    """Every (path, nonce) known_paths.grant_save hands out from here on."""
    real = known_paths.grant_save
    issued: list[tuple[str, str | None]] = []

    def spy(path: Any) -> str | None:
        nonce = real(path)
        issued.append((str(path), nonce))
        return nonce

    monkeypatch.setattr(known_paths, "grant_save", spy)
    return issued


def _touch(path: Path, data: bytes = b"x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


class _Registry:
    """Stands in for the checkpoint registry's listing."""

    def __init__(self, entries: list[dict[str, Any]]) -> None:
        self._entries = entries

    def list_checkpoints(self) -> list[dict[str, Any]]:
        return [dict(e) for e in self._entries]


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("theDAW_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(
        known_paths, "_STORE_PATH", tmp_path / "state" / "known_paths.json"
    )
    # Grants live in memory; a fresh table keeps one test's grants from the next.
    monkeypatch.setattr(known_paths, "_GRANTS", {}, raising=False)
    # Every dialog is replaced, so a headless runner has a "picker" too.
    monkeypatch.setattr(folder_dialog, "picker_available", lambda: True)
    # No model folder or registered checkpoint on this machine reaches a dialog.
    monkeypatch.setattr(storage_router, "_local_search_dirs", lambda: [])
    monkeypatch.setattr(storage_router, "get_registry", lambda: _Registry([]))
    return home


@pytest.fixture
def client(home: Path) -> TestClient:
    app = FastAPI()
    app.include_router(storage_router.router, prefix="/api/storage")
    app.include_router(places_router.router, prefix="/api/places")
    app.include_router(quest_router.router, prefix="/api/quest")
    return TestClient(app)


@pytest.fixture
def vj(home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """The VJ router, with its export folder under tmp_path so no request
    reads or creates the real one."""
    monkeypatch.setattr(
        vj_router, "_resolved_export_root", lambda: str(tmp_path / "vj-exports")
    )
    app = FastAPI()
    app.include_router(vj_router.router, prefix="/api/vj")
    return TestClient(app)


_ROUTE_DIALOGS = {
    "/api/storage/pick-file": "pick_open_file",
    "/api/storage/pick-folder": "pick_folder",
    "/api/storage/pick-save": "pick_save_file",
}


# ---------------------------------------------------------------------------
# pick-file
# ---------------------------------------------------------------------------


def test_a_picked_file_is_remembered_and_the_next_picker_opens_beside_it(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    plugin = _touch(tmp_path / "Plugins" / "chorus.gan")
    dialog = _dialog(monkeypatch, "pick_open_file", str(plugin), None)

    first = client.post(
        "/api/storage/pick-file",
        json={"kind": "gan", "filter": "GAN (*.gan)|*.gan", "title": "Open a plugin"},
    )
    assert first.json() == {"path": str(plugin), "cancelled": False}
    assert dialog.calls[0]["title"] == "Open a plugin"
    assert dialog.calls[0]["filter_spec"] == "GAN (*.gan)|*.gan"
    # No history yet: the kind's default folder.
    assert dialog.calls[0]["initial_dir"] == str(paths.data_path("plugins"))

    items = known_paths.recent(kind="gan")
    assert [(i["path"], i["source"], i["servable"]) for i in items] == [
        (str(plugin), "pick", True)
    ]

    second = client.post("/api/storage/pick-file", json={"kind": "gan"})
    assert second.json() == {"path": None, "cancelled": True}
    assert dialog.calls[1]["initial_dir"] == str(plugin.parent)


def test_an_existing_initial_dir_wins_over_the_remembered_folder(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    remembered = tmp_path / "Remembered"
    remembered.mkdir()
    field = tmp_path / "Field"
    field.mkdir()
    known_paths.record_folder("audio", remembered)
    dialog = _dialog(monkeypatch, "pick_open_file", None)

    client.post(
        "/api/storage/pick-file", json={"kind": "audio", "initial_dir": str(field)}
    )
    assert dialog.calls[0]["initial_dir"] == str(field)


def test_a_missing_initial_dir_falls_back_to_the_folder_for_the_kind(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    remembered = tmp_path / "Remembered"
    remembered.mkdir()
    known_paths.record_folder("audio", remembered)
    dialog = _dialog(monkeypatch, "pick_open_file", None)

    client.post(
        "/api/storage/pick-file",
        json={"kind": "audio", "initial_dir": str(tmp_path / "deleted")},
    )
    assert dialog.calls[0]["initial_dir"] == str(remembered)


@pytest.mark.parametrize(
    "remote",
    [
        "\\\\attacker\\share",
        "//attacker/share",
        "\\\\?\\C:\\Exports",
        "\\\\.\\PhysicalDrive0",
    ],
)
def test_a_share_or_device_initial_dir_is_never_checked_or_opened(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, remote: str
) -> None:
    """The request body names initial_dir. Checking a share path on Windows
    authenticates to that host, so the dialog starts in the kind's folder."""
    remembered = tmp_path / "Remembered"
    remembered.mkdir()
    known_paths.record_folder("audio", remembered)
    checked: list[str] = []
    real_isdir = os.path.isdir

    def isdir(path: Any) -> bool:
        checked.append(os.fspath(path))
        return real_isdir(path)

    monkeypatch.setattr(os.path, "isdir", isdir)
    dialog = _dialog(monkeypatch, "pick_open_file", None, None)

    client.post("/api/storage/pick-file", json={"kind": "audio", "initial_dir": remote})
    assert dialog.calls[0]["initial_dir"] == str(remembered)
    client.post("/api/storage/pick-file", json={"initial_dir": remote})
    assert dialog.calls[1]["initial_dir"] is None
    assert remote not in checked


def test_with_no_history_a_download_kind_opens_in_downloads(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, home: Path
) -> None:
    downloads = home / "Downloads"
    downloads.mkdir()
    dialog = _dialog(monkeypatch, "pick_open_file", None)

    client.post("/api/storage/pick-file", json={"kind": "midi"})
    assert dialog.calls[0]["initial_dir"] == str(downloads)


def test_without_a_body_the_pick_is_remembered_under_its_extension(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    riff = _touch(tmp_path / "Takes" / "riff.mid")
    dialog = _dialog(monkeypatch, "pick_open_file", str(riff))

    assert client.post("/api/storage/pick-file").json() == {
        "path": str(riff),
        "cancelled": False,
    }
    call = dialog.calls[0]
    assert call["title"] == "Select a file for theDAW"
    assert call["filter_spec"] == "All files (*.*)|*.*"
    assert call["initial_dir"] is None
    assert [i["path"] for i in known_paths.recent(kind="midi")] == [str(riff)]
    assert known_paths.last_folder("midi") == str(riff.parent)


def test_a_daw_project_picked_from_the_project_field_is_listed_as_a_daw_project(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The Session tab's Open field asks with kind 'tasmo' and also takes .als.
    The .als belongs in DAW project menus; the field's next dialog still opens
    in its folder."""
    song = _touch(tmp_path / "Ableton" / "Song Project" / "Song.als")
    dialog = _dialog(monkeypatch, "pick_open_file", str(song), None)

    client.post("/api/storage/pick-file", json={"kind": "tasmo"})
    assert [i["path"] for i in known_paths.recent(kind="daw-project")] == [str(song)]
    assert known_paths.recent(kind="tasmo") == []
    assert known_paths.last_folder("daw-project") == str(song.parent)

    client.post("/api/storage/pick-file", json={"kind": "tasmo"})
    assert dialog.calls[1]["initial_dir"] == str(song.parent)


def test_a_kind_no_extension_produces_is_kept_for_the_pick(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    backup = _touch(tmp_path / "Backups" / "theDAW-backup-1.zip")
    _dialog(monkeypatch, "pick_open_file", str(backup))

    client.post("/api/storage/pick-file", json={"kind": "backup-zip"})
    assert [i["path"] for i in known_paths.recent(kind="backup-zip")] == [str(backup)]
    assert known_paths.recent(kind="zip") == []


@pytest.mark.parametrize(
    "chosen",
    [
        "\\\\server\\share\\song.wav",
        "//server/share/song.wav",
        "\\\\?\\C:\\Music\\song.wav",
    ],
)
def test_a_share_or_device_path_chosen_in_a_save_dialog_is_refused_with_its_reason(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, chosen: str
) -> None:
    """A share answers with its own reason, never the refused-file-type one, and
    grants nothing and remembers nothing."""
    issued = _spy_grants(monkeypatch)
    _dialog(monkeypatch, "pick_save_file", chosen)

    resp = client.post("/api/storage/pick-save", json={"kind": "midi"})
    assert resp.status_code == 400
    assert resp.json() == {"detail": "theDAW saves only to folders on this computer."}
    assert issued == []
    assert known_paths.recent() == []
    assert known_paths.last_folder("midi") is None


@pytest.mark.parametrize("route", list(_ROUTE_DIALOGS))
def test_a_machine_with_no_dialog_answers_501(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, route: str
) -> None:
    """saveFile turns a 501 into a browser download, so "no dialog here" must
    not look like a cancel."""
    monkeypatch.setattr(folder_dialog, "picker_available", lambda: False)
    issued = _spy_grants(monkeypatch)
    somewhere = str(_touch(tmp_path / "a.wav"))
    dialogs = [
        _dialog(monkeypatch, name, somewhere) for name in _ROUTE_DIALOGS.values()
    ]

    resp = client.post(route, json={"kind": "audio"})
    assert resp.status_code == 501
    assert all(not d.calls for d in dialogs)
    assert issued == []


@pytest.mark.parametrize("route", list(_ROUTE_DIALOGS))
@pytest.mark.parametrize(
    ("timed_out", "status", "message"),
    [
        (True, 504, "The Save dialog was closed after 600 seconds without an answer."),
        (False, 500, "Add-Type : Cannot add type. The assembly could not be found."),
    ],
)
def test_a_dialog_that_fails_answers_an_error_and_never_a_cancel(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    route: str,
    timed_out: bool,
    status: int,
    message: str,
) -> None:
    """saveFile and PathInput read {cancelled: true} as the user's choice, so a
    dialog PowerShell could not show, or one closed at the timeout, arrives as
    an error with its reason. A timeout is 504: Chromium resends a request
    answered 408 on a reused connection, which would open the dialog again."""
    issued = _spy_grants(monkeypatch)
    calls = _failing_dialog(
        monkeypatch,
        _ROUTE_DIALOGS[route],
        folder_dialog.PickerError(message, timed_out=timed_out),
    )

    resp = client.post(route, json={"kind": "midi", "title": "Pick"})
    assert resp.status_code == status
    assert resp.json() == {"detail": message}
    assert len(calls) == 1
    assert known_paths.recent() == []
    assert known_paths.last_folder("midi") is None
    assert issued == []


def test_the_quest_apk_picker_opens_where_the_last_apk_landed(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, home: Path
) -> None:
    """A downloaded APK is recorded by the desktop shell; the deploy dialog's
    picker then opens in that folder and remembers what the user picks."""
    monkeypatch.setattr(quest_router.service, "load_config", lambda: {})
    calls: list[tuple[Any, ...]] = []
    downloaded = _touch(home / "Downloads" / "theDAW-XR.apk")
    picked = _touch(tmp_path / "Builds" / "theDAW-XR-dev.apk")
    answers = [str(picked), None]

    def fake_pick(*args: Any) -> str | None:
        calls.append(args)
        return answers.pop(0)

    monkeypatch.setattr(quest_router, "pick_open_file", fake_pick)
    known_paths.record(downloaded, "apk", source="client")

    assert client.get("/api/quest/pick-apk").json() == {"path": str(picked)}
    assert calls[0][1] == str(downloaded.parent)
    assert [i["path"] for i in known_paths.recent(kind="apk")][0] == str(picked)

    client.get("/api/quest/pick-apk")
    assert calls[1][1] == str(picked.parent)


@pytest.mark.parametrize(("timed_out", "status"), [(True, 504), (False, 500)])
def test_an_apk_or_vj_folder_dialog_that_fails_answers_an_error(
    client: TestClient,
    vj: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    timed_out: bool,
    status: int,
) -> None:
    """The deploy dialog's APK picker and the VJ export folder picker report a
    dialog that failed or timed out as an error with its reason, never as a
    cancel."""
    monkeypatch.setattr(quest_router.service, "load_config", lambda: {})
    message = "The dialog could not open."
    error = folder_dialog.PickerError(message, timed_out=timed_out)
    apk_calls: list[tuple[Any, ...]] = []

    def failing_apk_pick(*args: Any) -> str | None:
        apk_calls.append(args)
        raise error

    monkeypatch.setattr(quest_router, "pick_open_file", failing_apk_pick)
    folder_calls = _failing_dialog(monkeypatch, "pick_folder", error)

    resp = client.get("/api/quest/pick-apk")
    assert (resp.status_code, resp.json()) == (status, {"detail": message})
    resp = vj.post("/api/vj/export-folder/pick")
    assert (resp.status_code, resp.json()) == (status, {"detail": message})
    assert len(apk_calls) == 1
    assert len(folder_calls) == 1
    assert known_paths.recent() == []


@pytest.mark.parametrize(
    "headers",
    [
        {"sec-fetch-site": "cross-site"},
        {"origin": "https://evil.example"},
    ],
)
def test_a_page_on_another_site_cannot_open_the_apk_or_vj_folder_pickers(
    client: TestClient,
    vj: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    headers: dict[str, str],
) -> None:
    monkeypatch.setattr(quest_router.service, "load_config", lambda: {})
    apk_calls: list[tuple[Any, ...]] = []
    monkeypatch.setattr(
        quest_router, "pick_open_file", lambda *args: apk_calls.append(args)
    )
    folder = _dialog(monkeypatch, "pick_folder", str(tmp_path))

    assert client.get("/api/quest/pick-apk", headers=headers).status_code == 403
    resp = vj.post("/api/vj/export-folder/pick", headers=headers)
    assert resp.status_code == 403
    assert apk_calls == []
    assert folder.calls == []


def test_a_cancelled_file_picker_remembers_nothing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _dialog(monkeypatch, "pick_open_file", None)

    assert client.post("/api/storage/pick-file", json={"kind": "gan"}).json() == {
        "path": None,
        "cancelled": True,
    }
    assert known_paths.recent() == []


# ---------------------------------------------------------------------------
# pick-folder
# ---------------------------------------------------------------------------


def test_a_picked_folder_becomes_where_the_next_folder_picker_opens(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    backups = tmp_path / "Backups"
    backups.mkdir()
    dialog = _dialog(monkeypatch, "pick_folder", str(backups), None)

    first = client.post("/api/storage/pick-folder", json={"kind": "backup-dest"})
    assert first.json() == {"path": str(backups), "cancelled": False}
    assert known_paths.last_folder("backup-dest") == str(backups)

    client.post("/api/storage/pick-folder", json={"kind": "backup-dest"})
    assert dialog.calls[1]["initial"] == str(backups)


def test_a_folder_picker_opens_at_the_fields_folder_and_needs_no_kind(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    field = tmp_path / "Field"
    field.mkdir()
    chosen = tmp_path / "Chosen"
    chosen.mkdir()
    dialog = _dialog(monkeypatch, "pick_folder", str(chosen))

    resp = client.post("/api/storage/pick-folder", json={"initial_dir": str(field)})
    assert resp.json() == {"path": str(chosen), "cancelled": False}
    assert dialog.calls[0]["initial"] == str(field)
    assert dialog.calls[0]["title"] == "Select a folder for theDAW"
    items = known_paths.recent(kind="folder")
    assert [(i["path"], i["source"], i["servable"]) for i in items] == [
        (str(chosen), "pick", False)
    ]


# ---------------------------------------------------------------------------
# Checkpoints
# ---------------------------------------------------------------------------


def test_a_first_checkpoint_browse_opens_in_a_local_model_folder_and_the_next_beside_the_pick(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Settings > Models asks for a checkpoint folder. With no history the
    dialog opens in the first model folder that exists. After a pick, the next
    Browse opens in the folder holding that checkpoint, among its siblings."""
    models = tmp_path / "models"
    models.mkdir()
    more = tmp_path / "more-models"
    more.mkdir()
    monkeypatch.setattr(
        storage_router,
        "_local_search_dirs",
        lambda: [tmp_path / "not-cloned", models, more],
    )
    run = tmp_path / "Finetunes" / "run-7"
    run.mkdir(parents=True)
    dialog = _dialog(monkeypatch, "pick_folder", str(run), None)

    first = client.post("/api/storage/pick-folder", json={"kind": "checkpoint"})
    assert first.json() == {"path": str(run), "cancelled": False}
    assert dialog.calls[0]["initial"] == str(models)
    items = known_paths.recent(kind="checkpoint")
    assert [(i["path"], i["source"]) for i in items] == [(str(run), "pick")]
    assert known_paths.last_folder("checkpoint") == str(run.parent)

    client.post("/api/storage/pick-folder", json={"kind": "checkpoint"})
    assert dialog.calls[1]["initial"] == str(run.parent)


def test_with_no_local_model_folder_a_checkpoint_browse_opens_beside_the_newest_registered_one(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    older = tmp_path / "Old" / "small-arc"
    older.mkdir(parents=True)
    newer = tmp_path / "New" / "medium-arc"
    newer.mkdir(parents=True)
    monkeypatch.setattr(
        storage_router, "_local_search_dirs", lambda: [tmp_path / "not-cloned"]
    )
    monkeypatch.setattr(
        storage_router,
        "get_registry",
        lambda: _Registry(
            [
                {"id": "local:00000001", "path": str(older), "added_at": 100},
                {"id": "local:00000002", "path": str(newer), "added_at": 200},
                # Newest of all, but its folder is gone.
                {
                    "id": "local:00000003",
                    "path": str(tmp_path / "Unplugged" / "large"),
                    "added_at": 300,
                },
            ]
        ),
    )
    dialog = _dialog(monkeypatch, "pick_folder", None)

    client.post("/api/storage/pick-folder", json={"kind": "checkpoint"})
    assert dialog.calls[0]["initial"] == str(newer.parent)


def test_a_sent_or_remembered_folder_wins_over_the_checkpoint_fallbacks(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    models = tmp_path / "models"
    models.mkdir()
    monkeypatch.setattr(storage_router, "_local_search_dirs", lambda: [models])
    field = tmp_path / "Field"
    field.mkdir()
    remembered = tmp_path / "Remembered"
    remembered.mkdir()
    dialog = _dialog(monkeypatch, "pick_folder", None, None, None)

    client.post(
        "/api/storage/pick-folder",
        json={"kind": "checkpoint", "initial_dir": str(field)},
    )
    assert dialog.calls[0]["initial"] == str(field)

    known_paths.record_folder("checkpoint", remembered)
    client.post("/api/storage/pick-folder", json={"kind": "checkpoint"})
    assert dialog.calls[1]["initial"] == str(remembered)

    client.post(
        "/api/storage/pick-folder",
        json={"kind": "checkpoint", "initial_dir": str(tmp_path / "deleted")},
    )
    assert dialog.calls[2]["initial"] == str(remembered)


def test_a_first_lora_browse_opens_in_a_model_folder_and_the_next_beside_the_pick(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The LoRA slot's Choose file asks with kind 'lora'. With no LoRA picked
    yet it opens where checkpoints are; after a pick it opens beside that
    LoRA."""
    models = tmp_path / "models"
    models.mkdir()
    monkeypatch.setattr(storage_router, "_local_search_dirs", lambda: [models])
    lora = _touch(tmp_path / "LoRAs" / "tape-hiss.safetensors")
    dialog = _dialog(monkeypatch, "pick_open_file", str(lora), None)

    first = client.post("/api/storage/pick-file", json={"kind": "lora"})
    assert first.json() == {"path": str(lora), "cancelled": False}
    assert dialog.calls[0]["initial_dir"] == str(models)
    assert [i["path"] for i in known_paths.recent(kind="lora")] == [str(lora)]

    client.post("/api/storage/pick-file", json={"kind": "lora"})
    assert dialog.calls[1]["initial_dir"] == str(lora.parent)


def test_with_no_model_folder_a_lora_browse_opens_beside_the_newest_registered_checkpoint(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    run = tmp_path / "Finetunes" / "run-7"
    run.mkdir(parents=True)
    monkeypatch.setattr(
        storage_router,
        "get_registry",
        lambda: _Registry([{"id": "local:1", "path": str(run), "added_at": 5}]),
    )
    dialog = _dialog(monkeypatch, "pick_open_file", None)

    client.post("/api/storage/pick-file", json={"kind": "lora"})
    assert dialog.calls[0]["initial_dir"] == str(run.parent)


def test_a_json_export_picker_opens_where_the_last_json_file_was(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """NODEFI's set import asks with kind 'nodefi-set'. With no set picked yet it
    opens where the last JSON file went; after a pick, beside that set."""
    chart = _touch(tmp_path / "Charts" / "chart.json")
    known_paths.record(chart, source="save")
    saved_set = _touch(tmp_path / "Sets" / "live.json")
    dialog = _dialog(monkeypatch, "pick_open_file", str(saved_set), None)

    client.post("/api/storage/pick-file", json={"kind": "nodefi-set"})
    assert dialog.calls[0]["initial_dir"] == str(chart.parent)

    client.post("/api/storage/pick-file", json={"kind": "nodefi-set"})
    assert dialog.calls[1]["initial_dir"] == str(saved_set.parent)
    assert known_paths.last_folder("json") == str(chart.parent)


def test_a_meter_report_save_opens_in_downloads_with_no_history(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, home: Path
) -> None:
    downloads = home / "Downloads"
    downloads.mkdir()
    dialog = _dialog(monkeypatch, "pick_save_file", None)

    client.post("/api/storage/pick-save", json={"kind": "meter-report"})
    assert dialog.calls[0]["initial_dir"] == str(downloads)


def test_a_checkpoint_file_pick_moves_only_the_checkpoint_folder(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The Browse also takes the config JSON or the .safetensors itself. The
    JSON is listed under its own kind, and the JSON dialogs keep their folder."""
    configs = tmp_path / "Configs"
    configs.mkdir()
    known_paths.record_folder("json", configs)
    run = tmp_path / "Finetunes" / "run-7"
    config = _touch(run / "model_config.json", b"{}")
    weights = _touch(run / "model.safetensors")
    dialog = _dialog(monkeypatch, "pick_open_file", str(config), str(weights), None)

    client.post("/api/storage/pick-file", json={"kind": "checkpoint"})
    assert [i["path"] for i in known_paths.recent(kind="json")] == [str(config)]
    assert known_paths.last_folder("json") == str(configs)
    assert known_paths.last_folder("checkpoint") == str(run)

    client.post("/api/storage/pick-file", json={"kind": "checkpoint"})
    assert [i["path"] for i in known_paths.recent(kind="checkpoint")] == [str(weights)]
    assert known_paths.last_folder("checkpoint") == str(run)

    client.post("/api/storage/pick-file", json={"kind": "checkpoint"})
    assert dialog.calls[2]["initial_dir"] == str(run)


# ---------------------------------------------------------------------------
# pick-save
# ---------------------------------------------------------------------------


def _upload(client: TestClient, path: Path, data: bytes, grant: str | None) -> Any:
    return client.post(
        "/api/places/save",
        data={"path": str(path), "kind": "midi", "grant": grant or ""},
        files={"file": (path.name, data, "audio/midi")},
    )


def test_a_save_dialog_grants_one_write_and_the_next_save_opens_in_that_folder(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    exports = tmp_path / "Exports"
    exports.mkdir()
    target = exports / "riff.mid"
    dialog = _dialog(monkeypatch, "pick_save_file", str(target), None)

    picked = client.post(
        "/api/storage/pick-save",
        json={
            "kind": "midi",
            "initial_name": "riff.mid",
            "default_ext": ".mid",
            "filter": "MID file (*.mid)|*.mid",
            "title": "Save MIDI",
        },
    )
    body = picked.json()
    grant = body.get("grant")
    assert isinstance(grant, str) and len(grant) >= 32
    assert body == {"cancelled": False, "path": str(target), "grant": grant}
    call = dialog.calls[0]
    assert (call["initial_name"], call["default_ext"], call["filter_spec"]) == (
        "riff.mid",
        ".mid",
        "MID file (*.mid)|*.mid",
    )
    assert call["title"] == "Save MIDI"
    assert not target.exists()
    assert known_paths.last_folder("midi") == str(exports)

    assert _upload(client, target, b"MThd", grant).status_code == 200
    assert target.read_bytes() == b"MThd"
    # The grant is spent by the first write.
    assert _upload(client, target, b"MThd again", grant).status_code == 403
    assert target.read_bytes() == b"MThd"
    assert known_paths.peek_save_grant(target, grant) is False

    client.post("/api/storage/pick-save", json={"kind": "midi"})
    assert dialog.calls[1]["initial_dir"] == str(exports)


@pytest.mark.parametrize(
    "name", ["startup.cmd", "Setup.EXE", "profile.ps1", "Shortcut.lnk", "run.sh"]
)
def test_a_save_dialog_refuses_a_file_type_that_runs_and_grants_nothing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, name: str
) -> None:
    exports = tmp_path / "Exports"
    exports.mkdir()
    target = exports / name
    issued = _spy_grants(monkeypatch)
    _dialog(monkeypatch, "pick_save_file", str(target))

    resp = client.post("/api/storage/pick-save", json={"kind": "midi"})
    assert resp.status_code == 400
    assert resp.json() == {"detail": "That file type cannot be saved from theDAW."}
    assert [nonce for _, nonce in issued] == [None]
    assert _upload(client, target, b"@echo off", "any-guess").status_code == 403
    assert not target.exists()


def test_a_cancelled_save_dialog_grants_nothing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    issued = _spy_grants(monkeypatch)
    _dialog(monkeypatch, "pick_save_file", None)
    target = tmp_path / "Exports" / "riff.mid"

    assert client.post("/api/storage/pick-save", json={"kind": "midi"}).json() == {
        "cancelled": True,
        "path": None,
    }
    assert issued == []
    assert _upload(client, target, b"MThd", None).status_code == 403
    assert not target.exists()
    assert known_paths.last_folder("midi") is None


def test_a_save_without_a_kind_remembers_the_folder_under_its_extension(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    exports = tmp_path / "Exports"
    exports.mkdir()
    not_yet = tmp_path / "theDAW Projects"
    dialog = _dialog(monkeypatch, "pick_save_file", str(exports / "mix.wav"))

    resp = client.post("/api/storage/pick-save", json={"initial_dir": str(not_yet)})
    # With no kind to fall back on, a folder that does not exist yet is passed
    # through for the dialog to handle.
    assert dialog.calls[0]["initial_dir"] == str(not_yet)
    assert known_paths.last_folder("audio") == str(exports)
    assert known_paths.peek_save_grant(exports / "mix.wav", resp.json()["grant"])


# ---------------------------------------------------------------------------
# Who may open a dialog
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("route", [*_ROUTE_DIALOGS, "/api/storage/open"])
@pytest.mark.parametrize(
    "headers",
    [
        {"sec-fetch-site": "cross-site"},
        {"origin": "https://evil.example"},
        {"referer": "https://evil.example/page"},
    ],
)
def test_a_page_on_another_site_cannot_open_a_dialog(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    route: str,
    headers: dict[str, str],
) -> None:
    issued = _spy_grants(monkeypatch)
    somewhere = str(_touch(tmp_path / "a.wav"))
    dialogs = [
        _dialog(monkeypatch, name, somewhere) for name in _ROUTE_DIALOGS.values()
    ]

    resp = client.post(route, json={"path": somewhere}, headers=headers)
    assert resp.status_code == 403
    assert all(not d.calls for d in dialogs)
    assert known_paths.recent() == []
    assert issued == []


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"origin": "http://localhost:5173"},
        {"origin": "app://."},
        {"sec-fetch-site": "same-origin"},
    ],
)
def test_the_apps_own_ui_opens_the_file_picker(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    headers: dict[str, str],
) -> None:
    take = _touch(tmp_path / "take.wav")
    _dialog(monkeypatch, "pick_open_file", str(take))

    resp = client.post("/api/storage/pick-file", json={}, headers=headers)
    assert resp.json() == {"path": str(take), "cancelled": False}


# ---------------------------------------------------------------------------
# folder_dialog: PowerShell
# ---------------------------------------------------------------------------


def _completed(
    returncode: int, stdout: str = "", stderr: str = ""
) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(["powershell.exe"], returncode, stdout, stderr)


def _powershell_answers(
    monkeypatch: pytest.MonkeyPatch, outcome: Any
) -> list[list[str]]:
    """Replace the PowerShell process with one that returns or raises ``outcome``."""
    commands: list[list[str]] = []

    def fake_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        commands.append(cmd)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    monkeypatch.setattr(folder_dialog.subprocess, "run", fake_run)
    return commands


_WINDOWS_OPENERS: dict[str, Callable[[], str | None]] = {
    "save": lambda: folder_dialog._pick_save_windows(
        "Save Riff's take", "C:\\Exports", "riff.mid", ".mid", "MID (*.mid)|*.mid"
    ),
    "folder": lambda: folder_dialog._pick_folder_windows("Pick", "C:\\Exports"),
    "open": lambda: folder_dialog._pick_open_windows(
        "Open", "C:\\Exports", "All files (*.*)|*.*"
    ),
}


@pytest.mark.parametrize(
    ("outcome", "expected"),
    [
        (_completed(0, "C:\\Exports\\riff.mid"), "C:\\Exports\\riff.mid"),
        (_completed(0, "\ufeffC:\\Música\\本 take.wav\r\n"), "C:\\Música\\本 take.wav"),
        # A path the script wrote before something after it failed is the choice.
        (
            _completed(1, "C:\\Exports\\riff.mid", "Dispose failed"),
            "C:\\Exports\\riff.mid",
        ),
        (_completed(folder_dialog._CANCEL_EXIT), None),
    ],
)
@pytest.mark.parametrize("opener", list(_WINDOWS_OPENERS))
def test_a_powershell_dialog_returns_the_path_and_none_only_for_its_cancel_exit(
    monkeypatch: pytest.MonkeyPatch,
    outcome: subprocess.CompletedProcess[str],
    expected: str | None,
    opener: str,
) -> None:
    commands = _powershell_answers(monkeypatch, outcome)
    assert _WINDOWS_OPENERS[opener]() == expected
    assert commands[0][:5] == [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-Command",
    ]


@pytest.mark.parametrize("opener", list(_WINDOWS_OPENERS))
def test_a_powershell_dialog_still_open_at_the_timeout_is_a_timed_out_error(
    monkeypatch: pytest.MonkeyPatch, opener: str
) -> None:
    _powershell_answers(monkeypatch, subprocess.TimeoutExpired(["powershell.exe"], 600))
    with pytest.raises(folder_dialog.PickerError) as caught:
        _WINDOWS_OPENERS[opener]()
    assert caught.value.timed_out is True
    assert "600 seconds" in str(caught.value)


def test_a_powershell_that_cannot_start_is_an_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _powershell_answers(monkeypatch, FileNotFoundError(2, "No such file"))
    with pytest.raises(folder_dialog.PickerError) as caught:
        folder_dialog._pick_open_windows("Open", None, None)
    assert caught.value.timed_out is False
    assert str(caught.value).startswith("PowerShell could not open the Open dialog:")


@pytest.mark.parametrize(
    ("outcome", "message"),
    [
        (
            _completed(1, "", "Add-Type : Cannot add type.\r\n"),
            "Add-Type : Cannot add type.",
        ),
        (_completed(1), "The folder dialog ended without an answer (exit code 1)."),
        (_completed(0), "The folder dialog ended without an answer (exit code 0)."),
    ],
)
def test_a_powershell_failure_with_no_path_is_an_error_with_its_reason(
    monkeypatch: pytest.MonkeyPatch,
    outcome: subprocess.CompletedProcess[str],
    message: str,
) -> None:
    _powershell_answers(monkeypatch, outcome)
    with pytest.raises(folder_dialog.PickerError) as caught:
        folder_dialog._pick_folder_windows("Pick", None)
    assert str(caught.value) == message
    assert caught.value.timed_out is False


_needs_powershell = (
    pytest.mark.skipif(  # portability: runs the real Windows PowerShell picker script
        sys.platform != "win32" or shutil.which("powershell.exe") is None,
        reason="needs Windows PowerShell",
    )
)


@_needs_powershell
def test_real_powershell_tells_a_cancel_from_a_failure(tmp_path: Path) -> None:
    """These scripts show no dialog. They take the same exits a dialog script
    takes, through the same try/catch wrapper."""
    run = folder_dialog._run_powershell
    assert run([f"exit {folder_dialog._CANCEL_EXIT};"], "Open dialog") is None
    assert run(["[Console]::Out.Write('C:\\Música\\本 take.wav');"], "Open dialog") == (
        "C:\\Música\\本 take.wav"
    )

    with pytest.raises(folder_dialog.PickerError) as thrown:
        run(["throw 'The dialog broke.';"], "Open dialog")
    assert str(thrown.value) == "The dialog broke."

    # A non-terminating error, the kind a failed New-Object writes, is an error.
    missing = folder_dialog._ps_quote(str(tmp_path / "missing"))
    with pytest.raises(folder_dialog.PickerError) as written:
        run([f"Get-Item -LiteralPath {missing};"], "Open dialog")
    assert "missing" in str(written.value)
    assert written.value.timed_out is False


@_needs_powershell
def test_real_powershell_past_the_timeout_is_a_timed_out_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(folder_dialog, "_DIALOG_TIMEOUT_SEC", 1.0)
    with pytest.raises(folder_dialog.PickerError) as caught:
        folder_dialog._run_powershell(["Start-Sleep -Seconds 30;"], "Save dialog")
    assert caught.value.timed_out is True


@_needs_powershell
@pytest.mark.parametrize("opener", list(_WINDOWS_OPENERS))
def test_every_dialog_script_parses(
    monkeypatch: pytest.MonkeyPatch, opener: str
) -> None:
    """The dialog scripts are checked with PowerShell's own parser, which shows
    nothing on screen."""
    real_run = subprocess.run
    commands = _powershell_answers(monkeypatch, _completed(folder_dialog._CANCEL_EXIT))
    assert _WINDOWS_OPENERS[opener]() is None

    parsed = real_run(
        [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$t = [Console]::In.ReadToEnd(); $e = $null;"
            " $null = [System.Management.Automation.Language.Parser]::ParseInput("
            "$t, [ref]$null, [ref]$e);"
            " [Console]::Out.Write((@($e) | ForEach-Object { $_.Message }) -join ' | ')",
        ],
        input=commands[0][-1],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert parsed.returncode == 0, parsed.stderr
    assert parsed.stdout.strip() == ""


# ---------------------------------------------------------------------------
# folder_dialog: tkinter
# ---------------------------------------------------------------------------


class _FakeRoot:
    def __init__(self) -> None:
        self.destroyed = False

    def withdraw(self) -> None:
        pass

    def attributes(self, *args: Any) -> None:
        pass

    def destroy(self) -> None:
        self.destroyed = True


def _fake_tk(monkeypatch: pytest.MonkeyPatch, answer: Any) -> list[_FakeRoot]:
    """Install a tkinter whose dialogs answer ``answer``, or raise it."""
    roots: list[_FakeRoot] = []

    def make_root() -> _FakeRoot:
        root = _FakeRoot()
        roots.append(root)
        return root

    def ask(**kwargs: Any) -> Any:
        if isinstance(answer, BaseException):
            raise answer
        return answer

    filedialog = types.ModuleType("tkinter.filedialog")
    for name in ("askopenfilename", "asksaveasfilename", "askdirectory"):
        setattr(filedialog, name, ask)
    tk = types.ModuleType("tkinter")
    setattr(tk, "Tk", make_root)
    setattr(tk, "filedialog", filedialog)
    monkeypatch.setitem(sys.modules, "tkinter", tk)
    monkeypatch.setitem(sys.modules, "tkinter.filedialog", filedialog)
    return roots


_TK_OPENERS: dict[str, Callable[[], str | None]] = {
    "save": lambda: folder_dialog._pick_save_tk(
        "Save", "/home/me", "riff.mid", ".mid", "MID (*.mid)|*.mid"
    ),
    "folder": lambda: folder_dialog._pick_folder_tk("Pick", "/home/me"),
    "open": lambda: folder_dialog._pick_open_tk("Open", "/home/me", None),
}


@pytest.mark.parametrize("opener", list(_TK_OPENERS))
def test_a_tk_dialog_that_raises_is_an_error_and_a_cancel_stays_none(
    monkeypatch: pytest.MonkeyPatch, opener: str
) -> None:
    roots = _fake_tk(monkeypatch, RuntimeError("main thread is not in main loop"))
    with pytest.raises(folder_dialog.PickerError) as caught:
        _TK_OPENERS[opener]()
    assert "main thread is not in main loop" in str(caught.value)
    assert caught.value.timed_out is False
    assert roots[0].destroyed

    for cancel in ("", ()):
        roots = _fake_tk(monkeypatch, cancel)
        assert _TK_OPENERS[opener]() is None
        assert roots[0].destroyed

    _fake_tk(monkeypatch, "/home/me/riff.mid")
    assert _TK_OPENERS[opener]() == "/home/me/riff.mid"
