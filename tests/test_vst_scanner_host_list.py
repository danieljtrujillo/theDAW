"""The VST3 scan classifies a plugin from its module's factory, not by loading it.

Seen live on 2026-09-29, on a fresh install of 41 plugins: a plugin with no
``Contents/moduleinfo.json`` was classified only by the metadata probe, which
loads the whole plugin through pedalboard in a subprocess with a 25 s timeout.
Surge XT, u-he Zebralette 3 and Six Sines outlast that load three times, were
recorded as probed with category "unknown" for good, and EDIT's instrument
slot, which lists only category "instrument", never offered them. A rescan
carried the "unknown" verdict and its timeout count straight across.

``thedaw-vst-host --list --plugin <path>`` reads the module's factory class
info (name, vendor, version, sub-categories, class id) without instantiating a
class, in well under a second. These tests replay the scans the app makes
(``GET /api/vst/scan`` with ``refresh=false`` on mount, ``refresh=true`` from a
rescan key) against a fake ``subprocess.run`` that answers ``--list`` with what
the real host printed for these modules on the user's machine, and answers the
load probe the way those synths did: a timeout.
"""

from __future__ import annotations

import copy
import json
import subprocess
from dataclasses import asdict
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.vst import live_host
from backend.modules.vst import path_policy, scanner
from backend.modules.vst import router as vst_router
from backend.modules.vst.scanner import Vst3PluginInfo

# What thedaw-vst-host --list printed for these modules on 2026-09-29. Six Sines
# logs a line from its own module entry before the host's listing, and holds
# two instrument classes.
HOST_LISTINGS = {
    "Surge XT.vst3": (
        '[{"name":"Surge XT","vendor":"Surge Synth Team","version":"1.3.4",'
        '"category":"Instrument|Synth","identifier":"01EFCDAB8291EBFA566D624153675854",'
        '"format":"VST3"}]\n'
    ),
    "Zebralette3.vst3": (
        '[{"name":"Zebralette3","vendor":"u-he","version":"3.0.0",'
        '"category":"Instrument|u-he","identifier":"695B9DD3AFD6FA42123456785A334C45",'
        '"format":"VST3"}]\n'
    ),
    "Six Sines.vst3": (
        "src/clap/six-sines-clap-entry-impl.cpp:190 Initializing Six Sines "
        "1.2.0.18ecb36 / v1.2.1\n"
        '[{"name":"Six Sines","vendor":"BaconPaul","version":"1.2.0.18ecb36",'
        '"category":"Instrument|Synth","identifier":"30D2C648CCAABA57976D20DEFF9B93C1",'
        '"format":"VST3"},'
        '{"name":"Six Sines, Seven Outs","vendor":"BaconPaul","version":"1.2.0.18ecb36",'
        '"category":"Instrument|Synth","identifier":"346DA63783E28356B952CD15E50BAA6C",'
        '"format":"VST3"}]\n'
    ),
    "OTT.vst3": (
        '[{"name":"OTT","vendor":"Xfer Records","version":"1,3,7,0",'
        '"category":"Fx|Dynamics","identifier":"5854535654666F547474000000000000",'
        '"format":"VST3"}]\n'
    ),
}

# The synths whose full load outlasted the probe's timeout on the user's machine.
SLOW_TO_LOAD = {"Surge XT.vst3", "Zebralette3.vst3", "Six Sines.vst3"}
SYNTHS = {"Surge XT", "Zebralette3", "Six Sines"}

# What the pedalboard load probe reports for a plugin it does load in time.
PROBE_RESULTS = {
    "OTT.vst3": {
        "display_name": "OTT",
        "identifier": "VST3-OTT-1c1d1e1f-5854535654666f54",
        "manufacturer": "Xfer Records",
        "version": "1.3.7",
        "category": "effect",
    },
    "Legacy.vst3": {
        "display_name": "Legacy Delay",
        "identifier": "VST3-Legacy Delay-0a0b0c0d-4c656761",
        "manufacturer": "Old Vendor",
        "version": "0.9",
        "category": "effect",
    },
}


class FakeRun:
    """``subprocess.run`` for the two children the scanner starts.

    ``--list`` is the native host: it answers from ``HOST_LISTINGS``, fails
    the way the real host does (exit 4, an error line on stdout) for a module
    it has no listing for, and hangs for any name in ``list_hangs``. ``--probe``
    is the pedalboard load: it times out for ``SLOW_TO_LOAD`` and answers from
    ``PROBE_RESULTS`` otherwise.
    """

    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.list_hangs: set[str] = set()

    def __call__(self, cmd, **kwargs):
        cmd = [str(part) for part in cmd]
        self.calls.append(cmd)
        if "--list" in cmd:
            name = Path(cmd[cmd.index("--plugin") + 1]).name
            if name in self.list_hangs:
                raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))
            listing = HOST_LISTINGS.get(name)
            if listing is None:
                return subprocess.CompletedProcess(
                    cmd,
                    4,
                    stdout='{"ev":"error","text":"LoadLibrary failed","fatal":true}\n',
                    stderr="LoadLibrary failed\n",
                )
            return subprocess.CompletedProcess(cmd, 0, stdout=listing, stderr="")
        if "--probe" in cmd:
            name = Path(cmd[-1]).name
            if name in SLOW_TO_LOAD or name not in PROBE_RESULTS:
                raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))
            return subprocess.CompletedProcess(
                cmd, 0, stdout=json.dumps(PROBE_RESULTS[name]) + "\n", stderr=""
            )
        raise AssertionError(f"the scan started an unexpected child: {cmd}")

    def lists(self, name: str) -> int:
        return sum(
            1
            for c in self.calls
            if "--list" in c and Path(c[c.index("--plugin") + 1]).name == name
        )

    def probes(self, name: str) -> int:
        return sum(1 for c in self.calls if "--probe" in c and Path(c[-1]).name == name)


def _file(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"stand-in module")


@pytest.fixture
def vst3_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The user's VST3 folder, shaped as it was: Surge XT is a bundle in a
    vendor folder with no moduleinfo.json, the rest are single-file modules."""
    root = tmp_path / "VST3"
    bundle = root / "Surge Synth Team" / "Surge XT.vst3"
    if scanner.platform.system() == "Darwin":
        bundle.mkdir(parents=True)
    else:
        _file(bundle / "Contents" / scanner._arch_dirs()[0] / "Surge XT.vst3")
    for name in ("Zebralette3.vst3", "Six Sines.vst3", "OTT.vst3"):
        _file(root / name)
    monkeypatch.setattr(scanner, "_default_vst3_dirs", lambda: [root])
    monkeypatch.setattr(path_policy, "allowed_roots", lambda: [root.resolve()])
    monkeypatch.setattr(scanner, "_cache_path", lambda: tmp_path / "scan.json")
    return root


@pytest.fixture
def run(monkeypatch: pytest.MonkeyPatch) -> FakeRun:
    fake = FakeRun()
    monkeypatch.setattr(scanner.subprocess, "run", fake)
    return fake


@pytest.fixture
def host(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Switches theDAW's native host between built and not built.

    Found the way the live host finds it: ``THEDAW_VST_HOST``, then
    ``native/vst-host/bin``. The built path is pointed into tmp so a developer
    machine's real binary never answers for the test.
    """
    binary = tmp_path / "vst-host" / "thedaw-vst-host.exe"
    monkeypatch.setattr(
        live_host, "default_host_path", lambda: tmp_path / "unbuilt" / binary.name
    )
    monkeypatch.delenv(live_host.HOST_ENV_VAR, raising=False)

    def built(yes: bool) -> None:
        if yes:
            _file(binary)
            monkeypatch.setenv(live_host.HOST_ENV_VAR, str(binary))
        else:
            monkeypatch.delenv(live_host.HOST_ENV_VAR, raising=False)

    return built


@pytest.fixture
def background(monkeypatch: pytest.MonkeyPatch) -> list[list[Vst3PluginInfo]]:
    """Runs the metadata worker a scan starts, to completion, before the test
    reads on. It is the real worker on the real cache, only not on a thread."""
    handed: list[list[Vst3PluginInfo]] = []

    def start(plugins: list[Vst3PluginInfo]) -> bool:
        handed.append(copy.deepcopy(plugins))
        if not any(not p.probed and p.loadable for p in plugins):
            return False
        scanner._enrich_worker(copy.deepcopy(plugins))
        return True

    monkeypatch.setattr(vst_router, "start_background_enrichment", start)
    return handed


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(vst_router.router, prefix="/api/vst")
    return TestClient(app, client=("127.0.0.1", 51000))


def _scan(client: TestClient, refresh: bool) -> dict[str, dict]:
    """``vstStore.scan(refresh)``'s request, answered as {display name: entry}."""
    response = client.get(f"/api/vst/scan?refresh={'true' if refresh else 'false'}")
    assert response.status_code == 200, response.text
    return {p.get("display_name") or p["name"]: p for p in response.json()["plugins"]}


def _instrument_slot(plugins: dict[str, dict]) -> set[str]:
    """What EDIT's instrument slot offers (TrackVstInstrument instrumentPlugins)."""
    return {name for name, p in plugins.items() if p["category"] == "instrument"}


def test_the_first_scan_offers_the_synths_whose_load_outlasts_the_probe(
    vst3_root, run, host, background, client
):
    host(True)

    plugins = _scan(client, refresh=False)

    assert _instrument_slot(plugins) == SYNTHS
    surge = plugins["Surge XT"]
    assert surge["manufacturer"] == "Surge Synth Team"
    assert surge["version"] == "1.3.4"
    assert surge["identifier"] == "01EFCDAB8291EBFA566D624153675854"
    assert plugins["Zebralette3"]["manufacturer"] == "u-he"
    assert plugins["OTT"]["category"] == "effect"
    # Six Sines holds two instrument classes; the entry is the first one, the
    # class a loader opens when none is named, under its own name.
    six = plugins["Six Sines"]
    assert six["category"] == "instrument"
    assert six["identifier"] == "30D2C648CCAABA57976D20DEFF9B93C1"
    # Nothing was loaded: no plugin went through the pedalboard probe, and the
    # worker the scan starts has nothing left to do.
    assert not any("--probe" in c for c in run.calls)
    assert all(p.probed for p in background[-1])


def test_the_first_scan_after_updating_reclassifies_what_the_old_probe_left_unknown(
    vst3_root, run, host, background, client, tmp_path
):
    """The user's own cache, as the scanner before this fix wrote it (version
    3): every synth probed, "unknown", three timeouts. The app is updated and
    EDIT opens: its scan must not serve that cache."""
    entries = scanner.scan_vst3_directories()
    for entry in entries:
        entry.probed = True
        if entry.name in SYNTHS:
            entry.probe_timeouts = scanner._MAX_PROBE_TIMEOUTS
        else:
            entry.category = "effect"
            entry.display_name = "OTT"
    (tmp_path / "scan.json").write_text(
        json.dumps(
            {
                "cache_version": 3,
                "scanned_at": 0,
                "roots_signature": scanner.scan_roots_signature(),
                "plugins": [asdict(e) for e in entries],
            }
        ),
        encoding="utf-8",
    )
    host(True)

    plugins = _scan(client, refresh=False)

    assert _instrument_slot(plugins) == SYNTHS
    assert plugins["Six Sines"]["manufacturer"] == "BaconPaul"


def test_a_module_the_host_cannot_list_is_classified_by_the_load_probe(
    vst3_root, run, host, background, client
):
    _file(vst3_root / "Legacy.vst3")
    host(True)

    _scan(client, refresh=False)
    plugins = _scan(client, refresh=False)

    legacy = plugins["Legacy Delay"]
    assert legacy["category"] == "effect"
    assert legacy["manufacturer"] == "Old Vendor"
    assert run.probes("Legacy.vst3") == 1
    assert _instrument_slot(plugins) == SYNTHS


def test_the_worker_lists_a_module_once_however_many_probe_rounds_it_takes(
    vst3_root, run, host, background, client
):
    """A module whose listing hangs (a plugin that blocks in its own module
    entry) costs the host's timeout once in the worker, not once per round of
    load probes."""
    _file(vst3_root / "Hang.vst3")
    run.list_hangs.add("Hang.vst3")
    host(True)

    _scan(client, refresh=False)

    # One listing in the scan request, one in the worker, and the worker's three
    # rounds of load probes after it.
    assert run.lists("Hang.vst3") == 2
    assert run.probes("Hang.vst3") == scanner._MAX_PROBE_TIMEOUTS


def test_the_listing_is_read_past_what_a_plugin_prints_itself():
    six = scanner._parse_class_listing(HOST_LISTINGS["Six Sines.vst3"])
    assert [c["name"] for c in six] == ["Six Sines", "Six Sines, Seven Outs"]

    # A module entry that prints without a newline, and a log line that starts
    # with a bracket of its own.
    glued = scanner._parse_class_listing(
        "[surge] init" + HOST_LISTINGS["Surge XT.vst3"] + "[ok] bye\n"
    )
    assert [c["name"] for c in glued] == ["Surge XT"]

    # The host's error line is not a listing, and neither is an empty one.
    assert scanner._parse_class_listing('{"ev":"error","text":"x"}\n') == []
    assert scanner._parse_class_listing("[]\n") == []
