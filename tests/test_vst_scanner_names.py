"""The VST3 scanner's real plugin names: probe, carry-over, and cache shape.

``Vst3PluginInfo.name`` is only the bundle/file stem — the host library's
filename, which is frequently not what the vendor calls the plugin. The metadata
probe reads the plugin's OWN ``name`` and VST3 ``identifier``; these tests pin
that those reach the entry, survive a rescan, and survive a cache round trip.

The probe itself is exercised against a FAKE plugin object (no real VST3 is
installed on CI, and loading one can hang), by patching the loader
``probe_plugin`` resolves at call time.
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.modules.vst import scanner as vst_scanner  # noqa: E402
from backend.modules.vst.scanner import (  # noqa: E402
    Vst3PluginInfo,
    carry_over_metadata,
    enrich_plugin_metadata,
    probe_plugin,
)


class FakePlugin:
    """Stands in for ``pedalboard.VST3Plugin`` — same attribute names only."""

    def __init__(self, **attrs):
        self.name = attrs.get("name", "")
        self.identifier = attrs.get("identifier", "")
        self.manufacturer_name = attrs.get("manufacturer_name", "")
        self.version = attrs.get("version", "")
        self.category = attrs.get("category", "")
        self.is_instrument = attrs.get("is_instrument", False)


@pytest.fixture
def fake_loader(monkeypatch):
    """Make ``probe_plugin`` load a supplied fake instead of a real plugin."""
    import backend.modules.vst.host as vst_host

    def install(plugin):
        monkeypatch.setattr(vst_host, "load_plugin_file", lambda _pb, _path: plugin)

    return install


def test_probe_reports_the_plugins_own_name_and_identifier(fake_loader):
    fake_loader(
        FakePlugin(
            name="Pro-Q 4",
            identifier="FabFilter:Pro-Q 4:VST3",
            manufacturer_name="FabFilter",
            version="4.0.1",
            category="Fx|EQ",
        )
    )
    meta = probe_plugin(r"C:\VST3\FabFilter Pro-Q 4.vst3")
    assert meta["display_name"] == "Pro-Q 4"
    assert meta["identifier"] == "FabFilter:Pro-Q 4:VST3"
    # The fields that already existed keep working.
    assert meta["manufacturer"] == "FabFilter"
    assert meta["version"] == "4.0.1"
    assert meta["category"] == "effect"


def test_probe_never_returns_none_for_a_silent_plugin(fake_loader):
    """A plugin that reports nothing yields empty strings, not ``None``."""
    fake_loader(FakePlugin(is_instrument=True))
    meta = probe_plugin("/usr/lib/vst3/Mystery.vst3")
    assert meta["display_name"] == ""
    assert meta["identifier"] == ""
    assert meta["manufacturer"] == ""
    assert meta["category"] == "instrument"


def test_enrichment_writes_the_probed_name_onto_the_entry(monkeypatch):
    info = Vst3PluginInfo(name="FabFilter Pro-Q 4", path="/plugins/pq4.vst3")
    assert info.display_name == ""
    assert info.identifier == ""
    # The load probe's own path: no native host to list the module first (a
    # developer machine's built host would otherwise answer for it).
    monkeypatch.setattr(vst_scanner, "_host_command", lambda: None)
    monkeypatch.setattr(
        vst_scanner,
        "_probe_subprocess",
        lambda _path, _timeout: (
            "ok",
            {
                "display_name": "Pro-Q 4",
                "identifier": "FabFilter:Pro-Q 4:VST3",
                "manufacturer": "FabFilter",
                "version": "4.0.1",
                "category": "effect",
            },
        ),
    )
    assert enrich_plugin_metadata([info], budget_s=5.0) == 1
    assert info.probed is True
    assert info.display_name == "Pro-Q 4"
    assert info.identifier == "FabFilter:Pro-Q 4:VST3"
    assert info.manufacturer == "FabFilter"
    # The filename stem is untouched: it is still how the entry is keyed/sorted.
    assert info.name == "FabFilter Pro-Q 4"


def test_carry_over_keeps_names_across_a_rescan():
    """A rescan must not throw away a name that cost a probe to learn."""
    old = Vst3PluginInfo(
        name="pq4",
        path="/plugins/pq4.vst3",
        manufacturer="FabFilter",
        display_name="Pro-Q 4",
        identifier="FabFilter:Pro-Q 4:VST3",
        probed=True,
        last_modified=1234.0,
    )
    fresh = Vst3PluginInfo(name="pq4", path="/plugins/pq4.vst3", last_modified=1234.0)
    carry_over_metadata([fresh], [old])
    assert fresh.display_name == "Pro-Q 4"
    assert fresh.identifier == "FabFilter:Pro-Q 4:VST3"
    assert fresh.probed is True

    # A plugin whose file changed is a different build: it gets re-probed rather
    # than inheriting a name that may no longer be its own.
    updated = Vst3PluginInfo(name="pq4", path="/plugins/pq4.vst3", last_modified=9999.0)
    carry_over_metadata([updated], [old])
    assert updated.display_name == ""
    assert updated.identifier == ""
    assert updated.probed is False


def test_cache_round_trip_preserves_the_names(tmp_path, monkeypatch):
    cache = tmp_path / "vst3_scan_cache.json"
    monkeypatch.setattr(vst_scanner, "_cache_path", lambda: cache)
    entry = Vst3PluginInfo(
        name="pq4",
        path="/plugins/pq4.vst3",
        manufacturer="FabFilter",
        display_name="Pro-Q 4",
        identifier="FabFilter:Pro-Q 4:VST3",
        probed=True,
    )
    vst_scanner.save_scan_cache([entry])
    written = json.loads(cache.read_text(encoding="utf-8"))
    assert written["plugins"][0]["display_name"] == "Pro-Q 4"
    assert written["plugins"][0]["identifier"] == "FabFilter:Pro-Q 4:VST3"
    # The cache version moved with the new probe fields, so a cache written
    # before them is discarded (its entries are probed=True and would otherwise
    # never be probed again, leaving every name stuck at the filename stem).
    assert written["cache_version"] == vst_scanner._CACHE_VERSION
    assert vst_scanner._CACHE_VERSION >= 3

    back = vst_scanner.read_cache_entries()
    assert [(p.display_name, p.identifier) for p in back] == [
        ("Pro-Q 4", "FabFilter:Pro-Q 4:VST3")
    ]


def test_a_pre_names_cache_entry_still_loads():
    """An older cache blob has no name fields; it must read back as empty."""
    known = {"name": "pq4", "path": "/plugins/pq4.vst3", "manufacturer": "FabFilter"}
    info = Vst3PluginInfo(**known)
    assert info.display_name == ""
    assert info.identifier == ""


def test_scan_lists_a_bundle_under_a_symlinked_vendor_folder(tmp_path, monkeypatch):
    """A vendor folder kept on another drive and symlinked into the VST3 root
    (the Linux/macOS form of a Windows junction). Python 3.12's ``rglob`` does
    not descend into a directory symlink, so the scan listed nothing there."""
    root = tmp_path / "VST3"
    root.mkdir()
    vendor = tmp_path / "D-drive" / "Vendor"
    arch = vst_scanner._arch_dirs()[0]
    module_dir = vendor / "Bar.vst3" / "Contents" / arch
    module_dir.mkdir(parents=True)
    (module_dir / "Bar.vst3").write_bytes(b"module")
    try:
        os.symlink(vendor, root / "Vendor", target_is_directory=True)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"this OS refuses a directory symlink here: {exc}")
    monkeypatch.setattr(vst_scanner, "_default_vst3_dirs", lambda: [root])

    walked = vst_scanner._walk_vst3_paths(root)
    assert walked == [root / "Vendor" / "Bar.vst3"]

    [entry] = vst_scanner.scan_vst3_directories()
    assert entry.name == "Bar"
    assert entry.path == str((module_dir / "Bar.vst3").resolve())
    assert entry.loadable is True
