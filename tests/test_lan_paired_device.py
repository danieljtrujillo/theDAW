"""What a device on the LAN can do once it is paired, and what it still cannot.

A second PC or a phone opens the full desktop UI from the Mobile Access share
link, which carries the pairing token in its URL fragment
(``frontend/src/lib/pairing.ts``); every request after that sends it as
``X-TheDAW-Pair`` (``backend/lib/pairing.py``). Each test replays the order the
app produces -- this machine's UI saves or scans, then the paired device asks
-- and checks the device gets what it may use and never a row or tile that
ends in a 403 when clicked:

* VST scan and render (``/api/vst/*``) accept the pairing token the way the
  project routes do; the plugin window, which opens on this machine's desktop,
  does not.
* ``/api/project/recent`` and ``/api/places/recent`` offer a paired device only
  the projects ``/api/project/load`` lets it open.
* A caller on another machine cannot move the projects folder, which would
  widen the one folder a paired device may save into to the whole disk.
* An unpaired LAN caller is refused throughout.
"""

from __future__ import annotations

import io
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.lib import known_paths, launch_token, pairing
from backend.lib import paths as backend_paths
from backend.lib import reveal as reveal_lib
from backend.lib.audio_io import load_audio_array, save_audio
from backend.modules.places import router as places_router
from backend.modules.project import media_access
from backend.modules.project import router as project_router
from backend.modules.project.tasmo_project import TasmoProject
from backend.modules.vst import path_policy, scanner
from backend.modules.vst import router as vst_router

THIS_MACHINE = ("127.0.0.1", 51000)
OTHER_MACHINE = ("192.168.1.50", 51000)


@pytest.fixture(autouse=True)
def _isolated_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Every piece of persisted state these routes touch, moved into tmp_path:
    the pairing token, known places, the recent-projects list, the media-root
    allowlist, the VST scan cache, and the home folder the default projects
    folder lives under."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv(launch_token.ENV_VAR, raising=False)
    monkeypatch.setattr(pairing, "_TOKEN_FILE", tmp_path / "pairing_token.txt")
    monkeypatch.setattr(pairing, "_cached", None)
    monkeypatch.setattr(
        known_paths, "_STORE_PATH", tmp_path / "state" / "known_paths.json"
    )
    monkeypatch.setattr(known_paths, "_GRANTS", {})
    monkeypatch.setattr(project_router, "_RECENT_PATH", tmp_path / "recent.json")
    monkeypatch.setattr(project_router, "_recent_files", [])
    monkeypatch.setattr(project_router, "_recent_seen", None)
    monkeypatch.setattr(media_access, "_ROOTS_STATE", tmp_path / "media_roots.json")
    monkeypatch.setattr(media_access, "_session_roots", [])
    monkeypatch.setattr(backend_paths, "library_root", lambda: tmp_path / "library")
    monkeypatch.setattr(
        scanner, "_cache_path", lambda: tmp_path / "vst3_scan_cache.json"
    )


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(vst_router.router, prefix="/api/vst")
    app.include_router(project_router.router, prefix="/api/project")
    app.include_router(places_router.router, prefix="/api/places")
    return app


@pytest.fixture
def this_machine() -> TestClient:
    return TestClient(_app(), client=THIS_MACHINE)


@pytest.fixture
def paired() -> TestClient:
    """A device opened from the share link: another machine, sending the
    pairing token on every request."""
    return TestClient(
        _app(), client=OTHER_MACHINE, headers={pairing.HEADER: pairing.get_token()}
    )


@pytest.fixture
def stranger() -> TestClient:
    """A device on the LAN that was never given the share link."""
    return TestClient(_app(), client=OTHER_MACHINE)


def _projects_dir() -> Path:
    return known_paths.projects_dir()


def _project(name: str) -> dict[str, Any]:
    return TasmoProject(project_name=name, tempo=120.0).model_dump(mode="json")


def _wav_bytes() -> bytes:
    buf = io.BytesIO()
    save_audio(buf, np.full((2, 441), 0.25, dtype=np.float32), 44100, format="wav")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# VST: MIX on a paired device
# ---------------------------------------------------------------------------


@pytest.fixture
def vst3_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "VST3"
    root.mkdir()
    (root / "Ozone 11.vst3").write_bytes(b"a standalone module; only the path is used")
    monkeypatch.setattr(scanner, "_default_vst3_dirs", lambda: [root])
    monkeypatch.setattr(path_policy, "allowed_roots", lambda: [root.resolve()])
    return root


def test_a_paired_device_scans_then_renders_a_vst_stage(
    paired: TestClient, vst3_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """MIX on the paired device: the effects browser scans, the user adds the
    tile, and a render sends the tile's path to /process-file."""
    rendered: list[str] = []

    def fake_render(path, signal, sr, params, raw_state, warnings):
        rendered.append(path)
        return signal * 0.5

    monkeypatch.setattr(vst_router, "process_with_plugin", fake_render)

    scan = paired.get("/api/vst/scan", params={"enrich": "false"})
    assert scan.status_code == 200, scan.text
    [tile] = scan.json()["plugins"]

    out = paired.post(
        "/api/vst/process-file",
        files={"audio": ("stem.wav", _wav_bytes(), "audio/wav")},
        data={"plugin_path": tile["path"]},
    )
    assert out.status_code == 200, out.text
    assert rendered == [str(Path(tile["path"]).resolve())]
    audio, sr = load_audio_array(out.content)
    assert sr == 44100
    assert np.allclose(audio, 0.125, atol=1e-6)


def _every_vst_route(plugin: str, sub: str) -> list[tuple[str, str, dict[str, Any]]]:
    return [
        ("get", "/api/vst/scan?enrich=false", {}),
        ("get", f"/api/vst/scan/{sub}", {}),
        ("post", "/api/vst/load", {"json": {"plugin_path": plugin}}),
        ("get", "/api/vst/plugins", {}),
        (
            "post",
            "/api/vst/process",
            {"json": {"instance_ids": ["i1"], "audio_path": "x.wav"}},
        ),
        (
            "post",
            "/api/vst/process-file",
            {
                "files": {"audio": ("a.wav", b"RIFF", "audio/wav")},
                "data": {"plugin_path": plugin},
            },
        ),
        ("get", "/api/vst/param/i1", {}),
        ("put", "/api/vst/param/i1", {"json": {"name": "gain", "value": 0.5}}),
        ("delete", "/api/vst/unload/i1", {}),
        ("post", "/api/vst/open-editor", {"json": {"plugin_path": plugin}}),
        ("post", "/api/vst/editor-rect", {"json": {"plugin_path": plugin}}),
        ("get", "/api/vst/editor-size", {"params": {"plugin_path": plugin}}),
        ("get", "/api/vst/editor-result", {"params": {"plugin_path": plugin}}),
    ]


def test_an_unpaired_lan_device_is_refused_on_every_vst_route(
    stranger: TestClient, vst3_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ran: list[str] = []
    monkeypatch.setattr(vst_router, "load_plugin", lambda *a: ran.append("load"))
    monkeypatch.setattr(vst_router, "process_chain", lambda *a: ran.append("chain"))
    monkeypatch.setattr(
        vst_router, "process_with_plugin", lambda *a: ran.append("render")
    )
    plugin = str(vst3_root / "Ozone 11.vst3")
    sub = vst3_root / "Vendor"
    sub.mkdir()

    for method, url, kwargs in _every_vst_route(plugin, str(sub)):
        resp = getattr(stranger, method)(url, **kwargs)
        assert resp.status_code == 403, (method, url, resp.text)
    assert ran == []


def test_a_paired_device_cannot_open_a_plugin_window_on_this_machine(
    paired: TestClient, vst3_root: Path
) -> None:
    """The plugin window opens on this machine's desktop, where the device's
    user can neither see nor close it; the refusal says so."""
    plugin = str(vst3_root / "Ozone 11.vst3")
    for method, url, kwargs in _every_vst_route(plugin, "")[-4:]:
        resp = getattr(paired, method)(url, **kwargs)
        assert resp.status_code == 403, (method, url, resp.text)
        assert "computer running theDAW" in resp.json()["detail"]


def test_process_keeps_a_paired_device_inside_the_project_roots(
    paired: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(vst_router, "process_chain", lambda ids, audio, sr: audio)
    inside = _projects_dir() / "stems" / "take.wav"
    inside.parent.mkdir(parents=True)
    inside.write_bytes(_wav_bytes())
    outside = tmp_path / "private" / "secret.wav"
    outside.parent.mkdir()
    outside.write_bytes(_wav_bytes())

    refused_read = paired.post(
        "/api/vst/process",
        json={"instance_ids": ["i1"], "audio_path": str(outside)},
    )
    assert refused_read.status_code == 403
    refused_write = paired.post(
        "/api/vst/process",
        json={
            "instance_ids": ["i1"],
            "audio_path": str(inside),
            "output_path": str(tmp_path / "private" / "planted.wav"),
        },
    )
    assert refused_write.status_code == 403
    assert not (tmp_path / "private" / "planted.wav").exists()

    kept = _projects_dir() / "stems" / "take-fx.wav"
    ok = paired.post(
        "/api/vst/process",
        json={
            "instance_ids": ["i1"],
            "audio_path": str(inside),
            "output_path": str(kept),
        },
    )
    assert ok.status_code == 200, ok.text
    assert kept.is_file()


def test_a_paired_device_writing_a_stem_back_over_itself_never_truncates_it(
    paired: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """MIX on a paired device renders a stem in place: output_path is the
    stem it read. The encode dies partway; the stem must still be whole."""
    import soundfile

    monkeypatch.setattr(vst_router, "process_chain", lambda ids, audio, sr: audio)
    stem = _projects_dir() / "stems" / "vox.wav"
    stem.parent.mkdir(parents=True)
    stem.write_bytes(_wav_bytes())
    before = stem.read_bytes()

    def truncate_then_fail(file, *args, **kwargs):
        with open(file, "wb") as fh:
            fh.write(b"RIFF")
        raise RuntimeError("disk full")

    monkeypatch.setattr(soundfile, "write", truncate_then_fail)
    resp = paired.post(
        "/api/vst/process",
        json={
            "instance_ids": ["i1"],
            "audio_path": str(stem),
            "output_path": str(stem),
        },
    )
    assert resp.status_code == 500, resp.text
    assert "disk full" in resp.json()["detail"]
    assert stem.read_bytes() == before
    assert sorted(p.name for p in stem.parent.iterdir()) == ["vox.wav"]


# ---------------------------------------------------------------------------
# Recent projects on a paired device
# ---------------------------------------------------------------------------


def _save_here(client: TestClient, name: str, path: Path) -> str:
    resp = client.post(
        "/api/project/save", json={"project": _project(name), "path": str(path)}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["path"]


def test_recent_offers_a_paired_device_only_projects_it_can_open(
    this_machine: TestClient, paired: TestClient, tmp_path: Path
) -> None:
    """This machine's UI saves one project in the projects folder and one on
    another drive. The paired device's Recent list (project router plus known
    places, merged by frontend/src/lib/recentProjects.ts) must hold only rows
    that open when clicked."""
    kept = _save_here(this_machine, "Kept", _projects_dir() / "kept")
    elsewhere = _save_here(this_machine, "Elsewhere", tmp_path / "E-drive" / "gig")

    here = [r["path"] for r in this_machine.get("/api/project/recent").json()]
    assert here == [elsewhere, kept], "this machine still sees every project"

    rows = paired.get("/api/project/recent").json()
    places = paired.get("/api/places/recent", params={"exts": ".tasmo"}).json()
    offered = {r["path"] for r in rows} | {r["path"] for r in places["items"]}
    assert offered == {kept}

    for path in offered:
        opened = paired.post("/api/project/load", json={"path": path})
        assert opened.status_code == 200, opened.text


def test_the_places_limit_counts_only_the_rows_a_paired_device_gets(
    this_machine: TestClient, paired: TestClient, tmp_path: Path
) -> None:
    kept = _save_here(this_machine, "Kept", _projects_dir() / "kept")
    for i in range(3):
        _save_here(this_machine, f"Far {i}", tmp_path / "E-drive" / f"far{i}")

    items = paired.get(
        "/api/places/recent", params={"exts": ".tasmo", "limit": 1}
    ).json()["items"]
    assert [i["path"] for i in items] == [kept]


def test_a_paired_device_still_sees_its_other_remembered_files(
    paired: TestClient, tmp_path: Path
) -> None:
    take = tmp_path / "Downloads" / "take.wav"
    take.parent.mkdir()
    take.write_bytes(_wav_bytes())
    known_paths.record(take, source="save")

    items = paired.get("/api/places/recent").json()["items"]
    assert [i["path"] for i in items] == [str(take)]
    assert paired.get("/api/places/file", params={"path": str(take)}).status_code == 200


# ---------------------------------------------------------------------------
# The projects folder is this machine's to move
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("who", ["paired", "stranger"])
def test_a_lan_caller_cannot_move_the_projects_folder_to_reach_the_whole_disk(
    who: str,
    paired: TestClient,
    stranger: TestClient,
    this_machine: TestClient,
    tmp_path: Path,
) -> None:
    """The attack order: point the projects folder at a parent of everything,
    then save "inside" it. The move is refused, so the save stays refused."""
    caller = paired if who == "paired" else stranger
    before = this_machine.get("/api/places/projects-dir").json()

    moved = caller.put("/api/places/projects-dir", json={"path": str(tmp_path)})
    assert moved.status_code == 403
    assert "computer running theDAW" in moved.json()["detail"]
    assert this_machine.get("/api/places/projects-dir").json() == before

    planted = tmp_path / "private" / "planted"
    saved = paired.post(
        "/api/project/save", json={"project": _project("P"), "path": str(planted)}
    )
    assert saved.status_code == 403
    assert not planted.with_suffix(".tasmo").exists()


def test_this_machine_still_moves_the_projects_folder(
    this_machine: TestClient, tmp_path: Path
) -> None:
    chosen = tmp_path / "Songs"
    resp = this_machine.put("/api/places/projects-dir", json={"path": str(chosen)})
    assert resp.status_code == 200, resp.text
    assert this_machine.get("/api/places/projects-dir").json()["path"] == str(chosen)


# ---------------------------------------------------------------------------
# Known places refuse an unpaired caller; Show in folder stays on this machine
# ---------------------------------------------------------------------------


def test_an_unpaired_lan_device_cannot_list_or_read_remembered_paths(
    stranger: TestClient, tmp_path: Path
) -> None:
    mix = tmp_path / "exports" / "mix.wav"
    mix.parent.mkdir()
    mix.write_bytes(b"RIFF-bytes")
    known_paths.record(mix, source="save")

    answers = [
        stranger.get("/api/places/recent"),
        stranger.get("/api/places/folder", params={"kind": "audio"}),
        stranger.get("/api/places/file", params={"path": str(mix)}),
        stranger.get("/api/places/projects-dir"),
        stranger.post("/api/places/record", json={"path": str(mix)}),
        stranger.get("/api/project/recent"),
    ]
    assert [r.status_code for r in answers] == [403] * len(answers)
    assert all(str(tmp_path) not in r.text for r in answers)
    assert all(b"RIFF-bytes" not in r.content for r in answers)


def test_show_in_folder_from_a_paired_device_opens_nothing_here(
    paired: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[Any] = []
    monkeypatch.setattr(
        reveal_lib,
        "subprocess",
        SimpleNamespace(Popen=lambda *a, **k: calls.append(a)),
    )
    take = tmp_path / "take.wav"
    take.write_bytes(b"x")

    resp = paired.post("/api/places/reveal", json={"path": str(take)})

    assert resp.status_code == 403
    assert "computer running theDAW" in resp.json()["detail"]
    assert calls == []
