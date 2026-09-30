"""Settings store: the `io` device section, its migration, and the patch
semantics the frontend depends on.

The device menu persists here rather than in localStorage because the same
user opens theDAW as a browser tab AND as the desktop app (app.launch_mode),
which are two origins with two localStorage partitions. That makes these
guarantees load-bearing:

  - a settings file written by an older build gains `io` without losing a
    single existing choice;
  - `patch()` assigns a dict-valued key WHOLESALE, so the frontend must send
    the complete object — pinned here so nobody "fixes" it into a deep merge
    and silently changes what a partial PATCH means;
  - a key that is not in DEFAULT_SETTINGS is dropped, not stored.
"""

import json

from backend.modules.settings.store import (
    DEFAULT_SETTINGS,
    SCHEMA_VERSION,
    SettingsStore,
    _merge_defaults,
)

IO_SLOTS = (
    "audio_output",
    "cue_output",
    "audio_input",
    "midi_output",
    "visual_display",
)


def test_io_defaults_are_system_default_everywhere():
    io = DEFAULT_SETTINGS["io"]
    for slot in IO_SLOTS:
        assert io[slot] == {"id": "", "label": ""}, slot
    # 'all' so a controller plugged in after the choice was made still works
    # without a trip to Settings.
    assert io["midi_inputs"] == {"mode": "all", "ports": []}
    assert io["overrides"] == {}


def test_v7_file_gains_io_without_losing_existing_choices():
    old = {
        "schema_version": 7,
        "app": {"launch_mode": "desktop"},
        "stems": {"auto_on_import": True, "device": "cpu"},
        "notation": {"artist": "SOMEONE"},
    }

    merged = _merge_defaults(old)

    assert merged["schema_version"] == SCHEMA_VERSION == 12
    assert merged["io"] == DEFAULT_SETTINGS["io"]
    # v9 -> v10 added the library section; a file that predates it gets the
    # empty list rather than a missing key the media-root index would trip on.
    assert merged["library"] == {"media_roots": []}
    # v10 -> v11 added the assistant section, ON: the in-app Claude keeps the
    # user's own Claude settings and MCP servers it had before.
    assert merged["assistant"] == {
        "use_user_claude_config": True,
        "always_allow_rules": [],
    }
    # v11 -> v12 moved the LAN HTTPS switch into a section of its own; absent
    # means on.
    assert merged["lan"] == {"https": True}
    assert "lan_https" not in merged["app"]
    assert merged["io"] is not DEFAULT_SETTINGS["io"], "must be a deep copy"
    assert merged["app"]["launch_mode"] == "desktop"
    assert merged["stems"]["device"] == "cpu"
    assert merged["notation"]["artist"] == "SOMEONE"


def test_existing_io_choices_survive_a_reload():
    old = {
        "schema_version": 8,
        "io": {
            "audio_output": {"id": "abc", "label": "Scarlett 2i2"},
            "overrides": {"singPitch": {"id": "mic1", "label": "Yeti"}},
        },
    }

    merged = _merge_defaults(old)

    assert merged["io"]["audio_output"] == {"id": "abc", "label": "Scarlett 2i2"}
    assert merged["io"]["overrides"] == {"singPitch": {"id": "mic1", "label": "Yeti"}}
    # Slots the file never carried are filled from the defaults.
    assert merged["io"]["cue_output"] == {"id": "", "label": ""}


def test_patch_replaces_a_dict_slot_wholesale(tmp_path):
    """The frontend MUST send a complete slot object. This is the reason."""
    store = SettingsStore(tmp_path / "settings.json")

    store.patch({"io": {"audio_output": {"id": "abc", "label": "Scarlett 2i2"}}})
    assert store.get_section("io")["audio_output"] == {
        "id": "abc",
        "label": "Scarlett 2i2",
    }

    # A fragment REPLACES; it does not merge. The label is gone, not kept.
    store.patch({"io": {"audio_output": {"id": "def"}}})
    assert store.get_section("io")["audio_output"] == {"id": "def"}


def test_patch_drops_an_unknown_io_key(tmp_path):
    store = SettingsStore(tmp_path / "settings.json")

    store.patch({"io": {"camera_input": {"id": "cam0", "label": "Webcam"}}})

    assert "camera_input" not in store.get_section("io")


def test_deleting_an_override_sticks(tmp_path):
    """`overrides` is replaced wholesale, so dropping a key really removes it —
    a deleted per-surface override must not resurrect on the next load."""
    path = tmp_path / "settings.json"
    store = SettingsStore(path)

    store.patch(
        {
            "io": {
                "overrides": {
                    "singPitch": {"id": "mic1", "label": "Yeti"},
                    "micRecorder": {"id": "mic2", "label": "Scarlett"},
                }
            }
        }
    )
    store.patch(
        {"io": {"overrides": {"micRecorder": {"id": "mic2", "label": "Scarlett"}}}}
    )

    on_disk = json.loads(path.read_text(encoding="utf-8"))
    assert on_disk["io"]["overrides"] == {
        "micRecorder": {"id": "mic2", "label": "Scarlett"}
    }
    assert SettingsStore(path).get_section("io")["overrides"] == {
        "micRecorder": {"id": "mic2", "label": "Scarlett"}
    }


def test_migrated_schema_is_persisted(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"schema_version": 7, "vj": {}}), encoding="utf-8")

    SettingsStore(path)

    on_disk = json.loads(path.read_text(encoding="utf-8"))
    assert on_disk["schema_version"] == SCHEMA_VERSION
    assert on_disk["io"]["midi_inputs"] == {"mode": "all", "ports": []}


# ---------------------------------------------------------------------------
# The two list-valued keys name folders on this machine. A LAN caller must not
# be able to point the media-root index (or the model scan) anywhere it likes.
# ---------------------------------------------------------------------------


def _settings_app(tmp_path, monkeypatch, peer):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.modules.settings import router as settings_router
    from backend.modules.settings.store import SettingsStore

    monkeypatch.setattr(
        settings_router, "_store", SettingsStore(tmp_path / "settings.json")
    )
    app = FastAPI()
    app.include_router(settings_router.router, prefix="/api/settings")
    return TestClient(app, client=peer)


def test_a_lan_caller_cannot_set_the_folder_lists(tmp_path, monkeypatch):
    lan = _settings_app(tmp_path, monkeypatch, ("10.20.30.40", 51000))

    roots = lan.patch("/api/settings", json={"library": {"media_roots": ["C:\\"]}})
    assert roots.status_code == 403
    models = lan.patch("/api/settings", json={"models": {"extra_folders": ["C:\\"]}})
    assert models.status_code == 403
    # Everything else still works from the LAN (the phone toggles features).
    assert (
        lan.patch("/api/settings", json={"stems": {"auto_on_import": True}}).status_code
        == 200
    )


def test_this_machine_can_set_the_media_roots(tmp_path, monkeypatch):
    local = _settings_app(tmp_path, monkeypatch, ("127.0.0.1", 51000))
    folder = tmp_path / "music"
    folder.mkdir()

    ok = local.patch("/api/settings", json={"library": {"media_roots": [str(folder)]}})
    assert ok.status_code == 200
    assert len(ok.json()["library"]["media_roots"]) == 1


def test_a_relative_media_root_is_refused_with_a_reason(tmp_path, monkeypatch):
    local = _settings_app(tmp_path, monkeypatch, ("127.0.0.1", 51000))

    bad = local.patch(
        "/api/settings", json={"library": {"media_roots": ["music/here"]}}
    )

    assert bad.status_code == 400
    assert "absolute" in bad.json()["detail"]


def test_a_lan_patch_does_not_read_the_folder_lists_back(tmp_path, monkeypatch):
    """A PATCH answers with the whole settings document. Refusing to SET the
    folder lists is worthless if a LAN caller can read them back by toggling
    something harmless."""
    from backend.modules.settings import router as settings_router
    from backend.modules.settings.store import SettingsStore

    folder = tmp_path / "music"
    folder.mkdir()
    store = SettingsStore(tmp_path / "settings.json")
    store.patch(
        {
            "library": {"media_roots": [str(folder)]},
            "models": {"extra_folders": [str(folder)]},
        }
    )
    monkeypatch.setattr(settings_router, "_store", store)

    # The needle is the path as it appears in JSON: on Windows a raw
    # "D:\music" never matches the escaped "D:\\music" in the body, and an
    # `in answer.text` written the naive way would pass no matter what.
    needle = json.dumps(str(folder))[1:-1]

    lan = _settings_app(tmp_path, monkeypatch, ("10.20.30.40", 51000))
    monkeypatch.setattr(settings_router, "_store", store)
    answer = lan.patch("/api/settings", json={"stems": {"auto_on_import": True}})

    assert answer.status_code == 200
    assert needle in json.dumps(str(folder)), "the needle escapes like the body"
    assert needle not in answer.text
    assert answer.json()["library"]["media_roots"] == []
    assert answer.json()["library"]["media_roots_redacted"] is True
    assert answer.json()["models"]["extra_folders_redacted"] is True
    # The change itself still landed.
    assert answer.json()["stems"]["auto_on_import"] is True

    local = _settings_app(tmp_path, monkeypatch, ("127.0.0.1", 51000))
    monkeypatch.setattr(settings_router, "_store", store)
    mine = local.patch("/api/settings", json={"stems": {"auto_on_import": False}})
    assert needle in mine.text
    assert mine.json()["library"]["media_roots"] == [str(folder)]


# ---------------------------------------------------------------------------
# lan.https decides whether the next launch opens the LAN HTTPS listener. A
# device on the LAN must not be able to switch it for everyone else.
# ---------------------------------------------------------------------------


def test_a_lan_caller_cannot_switch_the_lan_https_listener(tmp_path, monkeypatch):
    lan = _settings_app(tmp_path, monkeypatch, ("10.20.30.40", 51000))

    refused = lan.patch("/api/settings", json={"lan": {"https": False}})

    assert refused.status_code == 403
    on_disk = json.loads((tmp_path / "settings.json").read_text(encoding="utf-8"))
    assert on_disk["lan"] == {"https": True}


def test_this_machine_can_switch_the_lan_https_listener(tmp_path, monkeypatch):
    local = _settings_app(tmp_path, monkeypatch, ("127.0.0.1", 51000))

    ok = local.patch("/api/settings", json={"lan": {"https": False}})

    assert ok.status_code == 200
    assert ok.json()["lan"] == {"https": False}


# ---------------------------------------------------------------------------
# A backup restore copies settings.json over the file while the backend runs.
# The store must build the next change on the restored file, not on the copy
# it held from before the restore.
# ---------------------------------------------------------------------------


def _restore_settings(tmp_path, payload: dict) -> None:
    """Run the real backup import over an archive holding ``payload`` as
    data/settings.json (theDAW_DATA_DIR must point at the data dir)."""
    import zipfile

    from backend.modules.backup import service as backup_service

    archive = tmp_path / "Downloads" / "theDAW-backup-restore.zip"
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr(
            backup_service.MANIFEST_NAME,
            json.dumps({"app": "theDAW", "roots": [{"id": "settings"}]}),
        )
        zf.writestr("roots/settings/settings.json", json.dumps(payload))
    job = backup_service._register_job("import")
    backup_service._run_import(job, archive, "replace")
    assert job.state == "done", job


def test_a_restored_settings_file_is_what_the_next_change_builds_on(
    tmp_path, monkeypatch
):
    from backend.lib import known_paths

    data = tmp_path / "data"
    monkeypatch.setenv("theDAW_DATA_DIR", str(data))
    monkeypatch.delenv("theDAW_SETTINGS_PATH", raising=False)
    monkeypatch.setattr(known_paths, "_STORE_PATH", data / "known_paths.json")
    store = SettingsStore(data / "settings.json")
    store.patch({"notation": {"artist": "BEFORE THE RESTORE"}})

    restored = store.get_all()
    restored["notation"]["artist"] = "FROM THE BACKUP"
    restored["stems"]["auto_on_import"] = True
    _restore_settings(tmp_path, restored)

    # What the running store serves now is the restored file.
    assert store.get_value("notation", "artist") == "FROM THE BACKUP"
    # The next change lands on top of it instead of writing the old copy back.
    store.patch({"idle": {"min_idle_seconds": 45}})
    on_disk = json.loads((data / "settings.json").read_text(encoding="utf-8"))
    assert on_disk["notation"]["artist"] == "FROM THE BACKUP"
    assert on_disk["stems"]["auto_on_import"] is True
    assert on_disk["idle"]["min_idle_seconds"] == 45


def test_a_settings_file_caught_mid_copy_leaves_the_store_as_it_was(tmp_path):
    """The restore copies in place, so a read can see half a file. That read
    changes nothing; the next one after the copy finishes takes the file."""
    path = tmp_path / "settings.json"
    store = SettingsStore(path)
    store.patch({"notation": {"artist": "KEPT"}})
    whole = path.read_text(encoding="utf-8").replace("KEPT", "RESTORED")

    path.write_text(whole[: len(whole) // 2], encoding="utf-8")
    assert store.get_value("notation", "artist") == "KEPT"

    path.write_text(whole, encoding="utf-8")
    assert store.get_value("notation", "artist") == "RESTORED"
