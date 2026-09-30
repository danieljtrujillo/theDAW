"""Settings store: the `models.extra_folders` list — unlimited extra folders
the app scans for ML models.

The contract (fixed by the plan): path is ``models.extra_folders``, type is
``list[str]`` of absolute folder paths, no cap on length. The store owns
persistence + hygiene only; consumers validate that a folder actually exists.

Guarantees pinned here:
  - the key is present by default (empty list);
  - a PATCH with a list persists it and survives a reload;
  - the list is sanitised on PATCH — non-str items dropped, whitespace
    stripped, empties dropped, duplicates removed preserving first-seen order;
  - a settings file written by a v8 build gains the key without losing any
    existing choice.
"""

import json

from backend.modules.settings.store import (
    DEFAULT_SETTINGS,
    SCHEMA_VERSION,
    SettingsStore,
    _merge_defaults,
)


def test_extra_folders_default_is_empty_list():
    models = DEFAULT_SETTINGS["models"]
    assert models["extra_folders"] == []
    assert isinstance(models["extra_folders"], list)


def test_patch_persists_the_list_and_survives_reload(tmp_path):
    path = tmp_path / "settings.json"
    store = SettingsStore(path)

    folders = ["D:/models/a", "E:/models/b", "F:/models/c"]
    store.patch({"models": {"extra_folders": folders}})

    assert store.get_section("models")["extra_folders"] == folders

    on_disk = json.loads(path.read_text(encoding="utf-8"))
    assert on_disk["models"]["extra_folders"] == folders
    # A fresh store reading the same file returns the same list.
    assert SettingsStore(path).get_section("models")["extra_folders"] == folders


def test_patch_dedupes_strips_and_drops_empties(tmp_path):
    store = SettingsStore(tmp_path / "settings.json")

    store.patch(
        {"models": {"extra_folders": ["D:/x", "D:/x", "  ", "E:/y", "  D:/x  "]}}
    )

    # "  D:/x  " strips to "D:/x" which is already present -> dropped.
    assert store.get_section("models")["extra_folders"] == ["D:/x", "E:/y"]


def test_patch_drops_non_string_items(tmp_path):
    store = SettingsStore(tmp_path / "settings.json")

    store.patch(
        {
            "models": {
                "extra_folders": ["D:/keep", 123, None, {"p": "x"}, ["y"], "E:/ok"]
            }
        }
    )

    assert store.get_section("models")["extra_folders"] == ["D:/keep", "E:/ok"]


def test_patch_ignores_non_list_value_without_wiping(tmp_path):
    store = SettingsStore(tmp_path / "settings.json")
    store.patch({"models": {"extra_folders": ["D:/keep"]}})

    # A malformed (non-list) value must not overwrite the good list.
    store.patch({"models": {"extra_folders": "D:/single"}})

    assert store.get_section("models")["extra_folders"] == ["D:/keep"]


def test_no_cap_on_length(tmp_path):
    store = SettingsStore(tmp_path / "settings.json")
    folders = [f"D:/models/dir_{i}" for i in range(500)]

    store.patch({"models": {"extra_folders": folders}})

    assert store.get_section("models")["extra_folders"] == folders
    assert len(store.get_section("models")["extra_folders"]) == 500


def test_v8_file_gains_models_without_losing_existing_choices():
    old = {
        "schema_version": 8,
        "app": {"launch_mode": "desktop"},
        "stems": {"auto_on_import": True, "device": "cpu"},
        "io": {"audio_output": {"id": "abc", "label": "Scarlett 2i2"}},
    }

    merged = _merge_defaults(old)

    assert merged["schema_version"] == SCHEMA_VERSION == 12
    assert merged["models"] == {"extra_folders": []}
    assert merged["models"] is not DEFAULT_SETTINGS["models"], "must be a deep copy"
    assert merged["app"]["launch_mode"] == "desktop"
    assert merged["stems"]["device"] == "cpu"
    assert merged["io"]["audio_output"] == {"id": "abc", "label": "Scarlett 2i2"}


def test_existing_extra_folders_survive_a_reload():
    old = {
        "schema_version": 9,
        "models": {"extra_folders": ["D:/kept/one", "E:/kept/two"]},
    }

    merged = _merge_defaults(old)

    assert merged["models"]["extra_folders"] == ["D:/kept/one", "E:/kept/two"]


def test_v8_partial_file_migrates_and_persists_the_key(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"schema_version": 8, "vj": {}}), encoding="utf-8")

    SettingsStore(path)

    on_disk = json.loads(path.read_text(encoding="utf-8"))
    assert on_disk["schema_version"] == SCHEMA_VERSION == 12
    assert on_disk["models"]["extra_folders"] == []


def test_load_path_sanitises_hand_edited_dirty_list(tmp_path):
    """Hygiene lives in the store: a hand-edited / restored / externally
    written v9 file gets the same str-only / stripped / de-duped treatment
    on LOAD, not only on PATCH."""
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": 9,
                "models": {"extra_folders": ["D:/x", "D:/x", "  ", 7]},
            }
        ),
        encoding="utf-8",
    )

    store = SettingsStore(path)

    assert store.get_section("models")["extra_folders"] == ["D:/x"]
    # And _merge_defaults itself (the load primitive) does the same.
    merged = _merge_defaults(
        {"schema_version": 9, "models": {"extra_folders": ["D:/x", "D:/x", "  ", 7]}}
    )
    assert merged["models"]["extra_folders"] == ["D:/x"]


def test_load_path_non_list_normalises_to_empty():
    merged = _merge_defaults(
        {"schema_version": 9, "models": {"extra_folders": "D:/single"}}
    )
    assert merged["models"]["extra_folders"] == []


def test_router_get_and_patch_end_to_end(tmp_path, monkeypatch):
    """Exercise the real router with the ticket's exact payloads against an
    isolated temp settings path so it never touches real data."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.modules.settings import router as settings_router

    monkeypatch.setattr(
        settings_router, "_store", SettingsStore(tmp_path / "settings.json")
    )

    app = FastAPI()
    app.include_router(settings_router.router, prefix="/api/settings")
    # `models.extra_folders` names folders on this machine, so the PATCH is
    # held to the loopback-or-launch-token tier (settings/router.py). The
    # default TestClient peer is the string "testclient", which is not an
    # address at all -- this machine's own UI is what this test stands for.
    client = TestClient(app, client=("127.0.0.1", 51000))

    body = client.get("/api/settings").json()
    assert "extra_folders" in body["models"]
    assert body["models"]["extra_folders"] == []

    resp = client.patch(
        "/api/settings",
        json={"models": {"extra_folders": ["D:/x", "D:/x", "  ", "E:/y"]}},
    )
    assert resp.status_code == 200
    assert resp.json()["models"]["extra_folders"] == ["D:/x", "E:/y"]
    # Persisted for a subsequent GET.
    assert client.get("/api/settings").json()["models"]["extra_folders"] == [
        "D:/x",
        "E:/y",
    ]


def _settings_client(tmp_path, monkeypatch, peer):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.modules.settings import router as settings_router
    from backend.modules.settings.store import SettingsStore

    store = SettingsStore(tmp_path / "settings.json")
    folder = tmp_path / "music"
    folder.mkdir(exist_ok=True)
    store.patch(
        {
            "library": {"media_roots": [str(folder)]},
            "models": {"extra_folders": [str(folder)]},
        }
    )
    monkeypatch.setattr(settings_router, "_store", store)
    app = FastAPI()
    app.include_router(settings_router.router, prefix="/api/settings")
    return TestClient(app, client=peer), str(folder)


def test_a_lan_get_does_not_hand_out_folder_names(tmp_path, monkeypatch):
    lan, folder = _settings_client(tmp_path, monkeypatch, ("10.20.30.40", 51000))

    body = lan.get("/api/settings").json()

    assert body["library"]["media_roots"] == []
    assert body["models"]["extra_folders"] == []
    assert body["library"]["media_roots_redacted"] is True
    assert body["models"]["extra_folders_redacted"] is True
    assert folder not in lan.get("/api/settings").text
    # Everything else is still readable -- this is the feature-toggle panel.
    assert "stems" in body


def test_this_machine_sees_its_own_folder_lists(tmp_path, monkeypatch):
    local, folder = _settings_client(tmp_path, monkeypatch, ("127.0.0.1", 51000))

    body = local.get("/api/settings").json()

    assert body["library"]["media_roots"] == [folder]
    assert body["models"]["extra_folders"] == [folder]
    assert "media_roots_redacted" not in body["library"]
    assert "extra_folders_redacted" not in body["models"]
