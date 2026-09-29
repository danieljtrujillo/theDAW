"""A plugin that ships a moduleinfo.json is classified from it without a process.

The VST3 SDK writes ``Contents/Resources/moduleinfo.json`` into a bundle: the
module's factory classes (name, vendor, version, category, sub-categories) as
JSON5, with a comma after the last member of every object and array. 23 of the
46 modules installed on the user's machine on 2026-09-29 ship one (Dexed,
Airwindows Consolidated, the Venn Free series, ...). The scanner looked for
``Contents/moduleinfo.json`` in a ``{"plugins": [...]}`` shape no SDK writes,
so it read nothing from any of them, and on a machine without the native host
every one of them waited for a full load through pedalboard to be classified.

The files below are what those bundles hold on the user's machine, cut to the
classes that matter.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.vst import live_host, path_policy, scanner
from backend.modules.vst import router as vst_router

DEXED = """{
  "Name": "Dexed",
  "Version": "1.0.1",
  "Factory Info": {
    "Vendor": "Digital Suburban",
    "URL": "",
    "E-Mail": "",
    "Flags": {
      "Unicode": true,
      "Classes Discardable": false,
      "Component Non Discardable": false,
    },
  },
  "Classes": [
    {
      "CID": "ABCDEF019182FAEB4447534244657864",
      "Category": "Audio Module Class",
      "Name": "Dexed",
      "Vendor": "Digital Suburban",
      "Version": "1.0.1",
      "SDKVersion": "VST 3.7.8",
      "Sub Categories": [
        "Instrument",
        "Synth",
      ],
      "Class Flags": 2,
      "Cardinality": 2147483647,
      "Snapshots": [
      ],
    },
    {
      "CID": "ABCDEF01C0DEF00D4447534244657864",
      "Category": "Plugin Compatibility Class",
      "Name": "Dexed",
      "Vendor": "Digital Suburban",
      "Version": "1.0.1",
      "SDKVersion": "VST 3.7.8",
      "Class Flags": 0,
      "Cardinality": 2147483647,
      "Snapshots": [
      ],
    },
  ],
}"""

# The URL holds "//", which is a comment only outside a string. The controller
# class comes first here, as a module is free to order its classes.
AIRWINDOWS = """{
  "Name": "Airwindows Consolidated",
  "Version": "1.2026.263",
  "Factory Info": {
    "Vendor": "Airwindows",
    "URL": "https://airwindows.com/",
    "E-Mail": "",
    "Flags": {
      "Unicode": true,
      "Classes Discardable": false,
      "Component Non Discardable": false,
    },
  },
  "Classes": [
    {
      "CID": "ABCDEF011234ABCD44746872616C4658",
      "Category": "Component Controller Class",
      "Name": "Airwindows Consolidated",
      "Vendor": "Airwindows",
      "Version": "1.2026.263",
      "SDKVersion": "VST 3.7.12",
      "Sub Categories": [
        "Fx",
      ],
      "Class Flags": 0,
      "Cardinality": 2147483647,
      "Snapshots": [
      ],
    },
    {
      "CID": "ABCDEF019182FAEB44746872616C4658",
      "Category": "Audio Module Class",
      "Name": "Airwindows Consolidated",
      "Vendor": "Airwindows",
      "Version": "1.2026.263",
      "SDKVersion": "VST 3.7.12",
      "Sub Categories": [
        "Fx",
      ],
      "Class Flags": 0,
      "Cardinality": 2147483647,
      "Snapshots": [
      ],
    },
  ],
}"""


def _bundle(root: Path, name: str, moduleinfo: str | None) -> Path:
    """A VST3 bundle as an installer lays it out: the module under
    ``Contents/<arch>/`` and, when given, ``Contents/Resources/moduleinfo.json``."""
    bundle = root / f"{name}.vst3"
    if scanner.platform.system() == "Darwin":
        bundle.mkdir(parents=True)
    else:
        module = bundle / "Contents" / scanner._arch_dirs()[0] / f"{name}.vst3"
        module.parent.mkdir(parents=True)
        module.write_bytes(b"stand-in module")
    if moduleinfo is not None:
        resources = bundle / "Contents" / "Resources"
        resources.mkdir(parents=True)
        (resources / "moduleinfo.json").write_text(moduleinfo, encoding="utf-8")
    return bundle


@pytest.fixture
def vst3_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "VST3"
    root.mkdir()
    monkeypatch.setattr(scanner, "_default_vst3_dirs", lambda: [root])
    monkeypatch.setattr(path_policy, "allowed_roots", lambda: [root.resolve()])
    monkeypatch.setattr(scanner, "_cache_path", lambda: tmp_path / "scan.json")
    return root


def test_the_walk_reads_what_the_sdk_writes(vst3_root):
    _bundle(vst3_root, "Dexed", DEXED)
    _bundle(vst3_root, "Airwindows Consolidated", AIRWINDOWS)
    _bundle(vst3_root, "Plain", None)

    found = {p.name: p for p in scanner.scan_vst3_directories()}

    dexed = found["Dexed"]
    assert dexed.category == "instrument"
    assert dexed.manufacturer == "Digital Suburban"
    assert dexed.version == "1.0.1"
    assert dexed.display_name == "Dexed"
    airwindows = found["Airwindows Consolidated"]
    assert airwindows.category == "effect"
    assert airwindows.manufacturer == "Airwindows"
    assert airwindows.version == "1.2026.263"
    # A bundle without one is left for the listing and the load probe.
    assert found["Plain"].category == "unknown"
    assert found["Plain"].manufacturer == ""


def test_the_instrument_slot_offers_a_moduleinfo_synth_with_no_host_and_no_load(
    vst3_root, tmp_path, monkeypatch
):
    """``enrich=false`` opens no plugin, and without the native host there is
    no listing either: the moduleinfo.json is all the scan reads, and Dexed
    reaches EDIT's instrument slot on it."""
    _bundle(vst3_root, "Dexed", DEXED)
    monkeypatch.setattr(
        live_host, "default_host_path", lambda: tmp_path / "unbuilt" / "host.exe"
    )
    monkeypatch.delenv(live_host.HOST_ENV_VAR, raising=False)

    def no_child(cmd, **kwargs):
        raise AssertionError(f"the scan started a child: {cmd}")

    monkeypatch.setattr(scanner.subprocess, "run", no_child)
    app = FastAPI()
    app.include_router(vst_router.router, prefix="/api/vst")
    client = TestClient(app, client=("127.0.0.1", 51000))

    response = client.get("/api/vst/scan?refresh=true&enrich=false")

    assert response.status_code == 200, response.text
    (dexed,) = response.json()["plugins"]
    assert dexed["category"] == "instrument"
    assert dexed["manufacturer"] == "Digital Suburban"


def test_the_class_id_is_left_to_the_host_that_reads_it():
    """moduleinfo.json writes a class id in the SDK's string order
    ("ABCDEF019182FAEB...") and the native host prints the id's bytes as they
    lie in memory ("01EFCDAB8291EBFA..." for the same Dexed class on Windows).
    The entry's identifier is the host's, so the file does not fill it."""
    assert "identifier" not in scanner._moduleinfo_metadata(DEXED)


def test_json5_the_sdk_may_write_reads_as_json():
    text = """{
      // a line comment
      "URL": "https://example.com/a//b", /* a block */
      "List": [1, 2, 3,],
      "Quote": "a \\" , ] still a string",
    }"""
    assert scanner._json5_loads(text) == {
        "URL": "https://example.com/a//b",
        "List": [1, 2, 3],
        "Quote": 'a " , ] still a string',
    }


@pytest.mark.parametrize(
    "text",
    ["", "not json", "[]", '{"Classes": "none"}', '{"Classes": [{"Category": 3}]}'],
)
def test_an_unreadable_moduleinfo_classifies_nothing(text):
    assert scanner._moduleinfo_metadata(text) == {}


def test_no_process_is_started_by_the_walk(vst3_root, monkeypatch):
    _bundle(vst3_root, "Dexed", DEXED)

    def no_child(cmd, **kwargs):
        raise AssertionError(f"the walk started a child: {cmd}")

    monkeypatch.setattr(subprocess, "run", no_child)
    assert scanner.scan_vst3_directories()[0].category == "instrument"
