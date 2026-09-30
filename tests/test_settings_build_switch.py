"""The LAN HTTPS switch survives a run of an older build.

Schema 10 kept the switch at ``app.lan_https``, and a missing key means ON.
main 851f6a0's store keeps only the keys it knows inside a section it knows,
and its first load of a newer file rewrites it (the schema differs), so one
start of main dropped the key and a user's "off" came back on. The switch now
lives in a section of its own, ``lan.https``, which main keeps whole.

main's store runs from ``tests/fixtures/main_851f6a0/settings_store.py``, a
byte-identical copy of ``backend/modules/settings/store.py`` at 851f6a0, and
the schema-10 build's store and launcher from ``tests/fixtures/pr207_8039b45/``
(8039b45), so each sequence below goes through the older builds' real load,
save and launch code. That build reads the switch only at ``app.lan_https``,
so this build keeps a plain False there while ``lan.https`` is off.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import pytest

from backend.lib import lan_https
from backend.modules.settings.store import SCHEMA_VERSION, SettingsStore

FIXTURES = Path(__file__).resolve().parent / "fixtures"
MAIN_STORE = FIXTURES / "main_851f6a0" / "settings_store.py"
SCHEMA_10_STORE = FIXTURES / "pr207_8039b45" / "settings_store.py"
SCHEMA_10_LAUNCHER = FIXTURES / "pr207_8039b45" / "lan_https.py"
LAN = ["192.168.1.34"]


def _load(source: Path, name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, source)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # A dataclass looks its module up in sys.modules while it is built.
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    finally:
        del sys.modules[name]
    return module


def _main_store() -> ModuleType:
    """main 851f6a0's settings store, imported fresh."""
    return _load(MAIN_STORE, "main_851f6a0_settings")


def _schema_10_store() -> ModuleType:
    """8039b45's settings store (schema 10), imported fresh."""
    return _load(SCHEMA_10_STORE, "pr207_8039b45_settings")


def _schema_10_launcher_blocks(path: Path) -> bool:
    """Whether 8039b45's launcher, reading ``path``, leaves the listener off."""
    launcher = _load(SCHEMA_10_LAUNCHER, "pr207_8039b45_lan_https")
    return launcher.blocking_reason(_on_disk(path), {}, LAN) is not None


def _launcher_blocks(path: Path, monkeypatch: pytest.MonkeyPatch) -> bool:
    """Whether a launcher reading ``path`` would leave the listener off.

    The launcher reads the raw file (lan_https.read_settings), before the
    backend's store has loaded or migrated anything. The environment override
    is left out so only the stored value decides.
    """
    monkeypatch.setenv("theDAW_SETTINGS_PATH", str(path))
    return lan_https.blocking_reason(lan_https.read_settings(), {}, LAN) is not None


def _on_disk(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_an_off_the_schema_10_build_saved_stays_off_through_main(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The reported sequence. The schema-10 build saves the user's off at
    ``app.lan_https``; this build starts; main starts and saves; the launcher
    runs. The schema-10 build kept the off where main's save drops it, and its
    launcher read only that key, so HTTPS came back on. Only the launcher's
    answer is asserted, so an older build fails at that step."""
    path = tmp_path / "settings.json"
    _schema_10_store().SettingsStore(path).patch({"app": {"lan_https": False}})
    assert _on_disk(path)["schema_version"] == 10
    assert _on_disk(path)["app"]["lan_https"] is False

    SettingsStore(path)
    _main_store().SettingsStore(path).patch({"stems": {"auto_on_import": True}})
    assert "lan_https" not in _on_disk(path)["app"], "main's save drops the key"

    assert _launcher_blocks(path, monkeypatch)


def test_an_off_this_build_saved_stays_off_in_the_schema_10_build(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The user switches the listener off here, then runs 8039b45, which reads
    only ``app.lan_https``. Its store keeps the ``lan`` section whole and its
    launcher leaves the listener off. Back here, switching it on clears the
    copy, so neither build keeps HTTPS off against the user."""
    path = tmp_path / "settings.json"
    SettingsStore(path).patch({"lan": {"https": False}})

    assert _schema_10_launcher_blocks(path)
    _schema_10_store().SettingsStore(path).patch({"stems": {"auto_on_import": True}})
    assert _on_disk(path)["lan"] == {"https": False}
    assert _schema_10_launcher_blocks(path)
    assert _launcher_blocks(path, monkeypatch)

    SettingsStore(path).patch({"lan": {"https": True}})
    assert "lan_https" not in _on_disk(path)["app"]
    assert not _launcher_blocks(path, monkeypatch)
    assert not _schema_10_launcher_blocks(path)


def test_an_off_switch_stays_off_after_main_loads_and_saves(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "settings.json"

    # This build: the user switches the listener off.
    SettingsStore(path).patch({"lan": {"https": False}})
    assert _launcher_blocks(path, monkeypatch)

    # main starts (its load rewrites the file) and the user changes a setting.
    main = _main_store()
    main.SettingsStore(path).patch({"stems": {"auto_on_import": True}})
    assert _on_disk(path)["schema_version"] == 8, "main really rewrote the file"
    assert _on_disk(path)["stems"]["auto_on_import"] is True

    # This build again: the launcher first, then the backend's store.
    assert _launcher_blocks(path, monkeypatch)
    assert SettingsStore(path).get_value("lan", "https") is False
    assert _launcher_blocks(path, monkeypatch)


def test_an_off_stored_at_app_lan_https_moves_to_lan_and_survives_main(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "settings.json"
    # What the schema-10 build wrote after the user switched the listener off.
    path.write_text(
        json.dumps(
            {
                "schema_version": 10,
                "app": {"launch_mode": "desktop", "lan_https": False},
                "library": {"media_roots": []},
                "models": {"extra_folders": []},
            }
        ),
        encoding="utf-8",
    )

    # The launcher honours the old key before anything has been migrated.
    assert _launcher_blocks(path, monkeypatch)

    SettingsStore(path)
    migrated = _on_disk(path)
    assert migrated["schema_version"] == SCHEMA_VERSION
    assert migrated["lan"] == {"https": False}
    assert migrated["app"] == {"launch_mode": "desktop", "lan_https": False}

    main = _main_store()
    main.SettingsStore(path).patch({"notation": {"artist": "SOMEONE"}})
    assert _on_disk(path)["lan"] == {"https": False}, "main kept the section whole"

    assert _launcher_blocks(path, monkeypatch)
    assert SettingsStore(path).get_value("lan", "https") is False


def test_an_off_written_to_the_old_key_after_this_build_ran_still_wins(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A schema-10 build running after this one keeps ``lan`` whole, writes
    ``app.lan_https: true`` from its own defaults, and the user may switch the
    listener off there. An off in either place wins."""
    path = tmp_path / "settings.json"
    SettingsStore(path)
    written_by_schema_10 = _on_disk(path)
    written_by_schema_10["schema_version"] = 10
    written_by_schema_10["app"]["lan_https"] = False
    path.write_text(json.dumps(written_by_schema_10), encoding="utf-8")

    assert _launcher_blocks(path, monkeypatch)
    assert SettingsStore(path).get_value("lan", "https") is False
    assert _on_disk(path)["lan"] == {"https": False}
    assert _launcher_blocks(path, monkeypatch)


def test_the_old_key_at_the_current_schema_is_moved_on_load(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A hand edit can put the old key back at the current schema. The store
    rewrites the file on load, so the next write cannot drop the off it
    carried, and the old key holds the plain False the schema-10 build
    reads."""
    path = tmp_path / "settings.json"
    SettingsStore(path)
    edited = _on_disk(path)
    edited["app"]["lan_https"] = "off"
    path.write_text(json.dumps(edited), encoding="utf-8")

    SettingsStore(path)
    assert _on_disk(path)["lan"] == {"https": False}
    assert _on_disk(path)["app"]["lan_https"] is False
    assert _launcher_blocks(path, monkeypatch)


def test_the_default_stays_on_through_main(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "settings.json"
    SettingsStore(path)
    assert _on_disk(path)["lan"] == {"https": True}
    assert not _launcher_blocks(path, monkeypatch)

    _main_store().SettingsStore(path).patch({"stems": {"auto_on_import": True}})
    assert not _launcher_blocks(path, monkeypatch)
    assert SettingsStore(path).get_value("lan", "https") is True


def test_a_known_section_that_is_not_an_object_keeps_its_defaults(
    tmp_path: Path,
) -> None:
    """A hand edit that nulls a section used to replace its defaults with
    None, and the load raised on it (every /api/settings call answered 500).
    An off at the old key still carries over into the rebuilt section."""
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": 10,
                "app": {"lan_https": False},
                "lan": None,
                "models": None,
                "library": "not a section",
            }
        ),
        encoding="utf-8",
    )

    store = SettingsStore(path)

    assert store.get_value("lan", "https") is False
    assert store.get_section("models") == {"extra_folders": []}
    assert store.get_section("library") == {"media_roots": []}
    store.patch({"models": {"extra_folders": ["C:/models"]}})
    assert store.get_section("models") == {"extra_folders": ["C:/models"]}


# ---------------------------------------------------------------------------
# The record beside settings.json (lan_https.RECORD_NAME)
#
# Before it, the rule was "an off stored in either place wins", which is right
# while nothing but an off can be the latest choice. It is not: the schema-10
# build's on after this build's off, and a hand edit of lan.https, were both
# overruled by the copy at app.lan_https this build had left there.
# ---------------------------------------------------------------------------


def test_an_on_saved_in_the_schema_10_build_after_an_off_here_is_honoured(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The user switches the listener off here, runs 8039b45, switches it back
    on there (its store writes app.lan_https: true and keeps lan whole, still
    off), then comes back. The on is the latest choice: this build's launcher
    starts the listener, its store settles lan.https on, and the schema-10
    build agrees afterwards."""
    path = tmp_path / "settings.json"
    SettingsStore(path).patch({"lan": {"https": False}})
    assert _launcher_blocks(path, monkeypatch)

    _schema_10_store().SettingsStore(path).patch({"app": {"lan_https": True}})
    assert _on_disk(path)["lan"] == {"https": False}, "8039b45 kept lan whole"
    assert not _schema_10_launcher_blocks(path)

    assert not _launcher_blocks(path, monkeypatch)
    assert SettingsStore(path).get_value("lan", "https") is True
    assert _on_disk(path)["lan"] == {"https": True}
    assert "lan_https" not in _on_disk(path)["app"]
    assert not _launcher_blocks(path, monkeypatch)
    assert not _schema_10_launcher_blocks(path)


def test_a_hand_edit_of_lan_https_is_the_latest_choice(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Switched off here, then turned back on by editing lan.https in the file
    (the copy at app.lan_https left as it was, since nothing says it is
    there). The edit wins in the launcher and in the store."""
    path = tmp_path / "settings.json"
    SettingsStore(path).patch({"lan": {"https": False}})
    edited = _on_disk(path)
    assert edited["app"]["lan_https"] is False
    edited["lan"]["https"] = True
    path.write_text(json.dumps(edited), encoding="utf-8")

    assert not _launcher_blocks(path, monkeypatch)
    assert SettingsStore(path).get_value("lan", "https") is True
    assert "lan_https" not in _on_disk(path)["app"]


def test_the_record_keeps_the_off_through_main_and_the_schema_10_build(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Off here; 8039b45 runs and saves something else; main runs and drops
    the old key; a hand edit deletes the lan section too. Nothing that was
    dropped is a choice, so the record's off stands at every step."""
    path = tmp_path / "settings.json"
    SettingsStore(path).patch({"lan": {"https": False}})
    record = path.with_name(lan_https.RECORD_NAME)
    assert json.loads(record.read_text(encoding="utf-8")) == {
        "lan_https": False,
        "app_lan_https": False,
    }

    _schema_10_store().SettingsStore(path).patch({"stems": {"auto_on_import": True}})
    assert _launcher_blocks(path, monkeypatch)
    _main_store().SettingsStore(path).patch({"stems": {"auto_on_import": False}})
    assert "lan_https" not in _on_disk(path)["app"]
    assert _launcher_blocks(path, monkeypatch)

    stripped = _on_disk(path)
    del stripped["lan"]
    path.write_text(json.dumps(stripped), encoding="utf-8")
    assert _launcher_blocks(path, monkeypatch)
    assert SettingsStore(path).get_value("lan", "https") is False
    assert _on_disk(path)["lan"] == {"https": False}


def test_a_save_cut_off_before_the_record_keeps_the_value_it_wrote(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The store writes settings.json, then the record. A crash between the
    two leaves the record one write behind; the value in the file differs
    from it and is read as the latest choice, which is the value written."""
    path = tmp_path / "settings.json"
    store = SettingsStore(path)
    record = path.with_name(lan_https.RECORD_NAME)
    before = record.read_text(encoding="utf-8")
    store.patch({"lan": {"https": False}})
    record.write_text(before, encoding="utf-8")  # the record write never landed

    assert _launcher_blocks(path, monkeypatch)
    assert SettingsStore(path).get_value("lan", "https") is False


def test_an_unreadable_record_falls_back_to_an_off_anywhere_wins(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "settings.json"
    SettingsStore(path).patch({"lan": {"https": False}})
    path.with_name(lan_https.RECORD_NAME).write_text("{half", encoding="utf-8")
    assert _launcher_blocks(path, monkeypatch)
    assert SettingsStore(path).get_value("lan", "https") is False


def test_a_patch_stores_the_switch_as_a_boolean(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    store = SettingsStore(path)
    store.patch({"lan": {"https": "off"}})
    assert _on_disk(path)["lan"] == {"https": False}
    store.patch({"lan": {"https": "maybe"}})
    assert _on_disk(path)["lan"] == {"https": False}, (
        "a value saying neither is ignored"
    )
    store.patch({"lan": {"https": True}})
    assert _on_disk(path)["lan"] == {"https": True}
