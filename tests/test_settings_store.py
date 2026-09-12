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

    assert merged["schema_version"] == SCHEMA_VERSION == 8
    assert merged["io"] == DEFAULT_SETTINGS["io"]
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
