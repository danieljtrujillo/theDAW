"""Every place theDAW writes or opens a file remembers where it was.

known_paths is only as good as its callers: a project saved, a scene the cockpit
saved, a plugin installed, a DAW set imported or a VJ take exported must each
leave its path behind, so the next picker for that kind of file opens in the
right folder and a Recent menu can hand the file back. A path a request body
named is remembered as 'client', never served, and never moves a picker folder.
Each test drives the route the UI calls and then reads the store.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend.core import folder_dialog
from backend.lib import known_paths
from backend.modules.plugin import router as plugin_router
from backend.modules.plugin.gan_file import GanFile
from backend.modules.plugin.owl_import import import_vst_foundry
from backend.modules.project import media_access
from backend.modules.project import router as project_router
from backend.modules.project.tasmo_file import TasmoFile
from backend.modules.project.tasmo_project import TasmoProject
from backend.modules.sway import router as sway_router
from backend.modules.vj import router as vj_router
from backend.server import app

FOUNDRY_PROJECT = {
    "canvasWidth": 400,
    "canvasHeight": 300,
    "elements": [
        {
            "id": "k1",
            "name": "Cutoff",
            "type": "Knob",
            "x": 10,
            "y": 20,
            "width": 80,
            "height": 80,
        }
    ],
}

SHARE = "\\\\attacker\\share\\x.gan"


def _configure_client_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Move every data folder these routes write into tmp_path."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(
        known_paths, "_STORE_PATH", tmp_path / "state" / "known_paths.json"
    )
    monkeypatch.setattr(known_paths, "_GRANTS", {})
    # Opening a project allowlists its folders in data/clip_audio_roots.json
    # (and its data/media_roots.json mirror); keep those files out of the test.
    monkeypatch.setattr(media_access, "register_paths", lambda paths: list(paths))

    monkeypatch.setattr(
        project_router, "_RECENT_PATH", tmp_path / "state" / "recent_projects.json"
    )
    monkeypatch.setattr(project_router, "_recent_files", [])
    monkeypatch.setattr(project_router, "_recent_seen", None)
    monkeypatch.setattr(sway_router, "_PROJECTS_DIR", tmp_path / "sway-projects")
    monkeypatch.setattr(plugin_router, "GAN_DIR", tmp_path / "plugins")
    monkeypatch.setattr(plugin_router, "RUNTIME_DIR", tmp_path / "plugins" / "_runtime")


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """The app with known_paths, the recent-projects file and every data folder
    these routes write moved into tmp_path."""
    _configure_client_env(tmp_path, monkeypatch)
    return TestClient(app)


@pytest.fixture
def client_loopback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """Same as ``client``, but with a real loopback TCP peer -- what theDAW's
    own UI actually looks like on the wire, unlike ``TestClient``'s default
    fake, non-loopback ``("testclient", 50000)`` peer. Needed for routes
    gated by ``require_loopback_or_launch_token`` (ITW security P1)."""
    _configure_client_env(tmp_path, monkeypatch)
    return TestClient(app, client=("127.0.0.1", 51000))


def _only(kind: str) -> dict[str, Any]:
    items = known_paths.recent(kind=kind)
    assert len(items) == 1, items
    return items[0]


def _stored_folders(tmp_path: Path) -> dict[str, str]:
    store = tmp_path / "state" / "known_paths.json"
    return json.loads(store.read_text(encoding="utf-8"))["folders"]


def _project(name: str) -> dict[str, Any]:
    return TasmoProject(project_name=name, tempo=120.0).model_dump(mode="json")


def _foundry_export(folder: Path) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    pj = folder / "project.json"
    pj.write_text(json.dumps(FOUNDRY_PROJECT), encoding="utf-8")
    return pj


# ---------------------------------------------------------------------------
# .tasmo projects
# ---------------------------------------------------------------------------


def test_a_saved_project_is_remembered_and_never_served(
    client_loopback: TestClient, tmp_path: Path
) -> None:
    songs = tmp_path / "Songs"
    resp = client_loopback.post(
        "/api/project/save",
        json={"project": _project("Kept"), "path": str(songs / "kept")},
    )
    assert resp.status_code == 200, resp.text
    saved = resp.json()["path"]
    assert saved.endswith("kept.tasmo")

    entry = _only("tasmo")
    assert (entry["path"], entry["source"], entry["servable"]) == (
        str(songs / "kept.tasmo"),
        "client",
        False,
    )
    # The body named the folder, so the project picker's folder is not moved.
    assert "tasmo" not in _stored_folders(tmp_path)
    # A save can embed any file its body names, so its archive is never handed
    # back by /api/places/file.
    served = client_loopback.get("/api/places/file", params={"path": saved})
    assert served.status_code == 403


def test_a_save_to_a_new_folder_leaves_the_project_picker_where_the_user_left_it(
    client_loopback: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The order the Session tab produces: the user picks a .tasmo from their
    own folder, then a save names a folder that did not exist. The next project
    dialog still opens in the user's folder."""
    picked = tmp_path / "Gigs" / "Opener.tasmo"
    picked.parent.mkdir()
    TasmoFile.save(TasmoProject(project_name="Opener"), str(picked))
    calls: list[dict[str, Any]] = []
    answers = [str(picked), None]

    def pick_open_file(**kwargs: Any) -> str | None:
        calls.append(kwargs)
        return answers.pop(0)

    monkeypatch.setattr(folder_dialog, "picker_available", lambda: True)
    monkeypatch.setattr(folder_dialog, "pick_open_file", pick_open_file)

    chosen = client_loopback.post(
        "/api/storage/pick-file", json={"kind": "tasmo"}
    ).json()
    assert chosen == {"path": str(picked), "cancelled": False}
    assert known_paths.last_folder("tasmo") == str(picked.parent)

    elsewhere = tmp_path / "Brand New" / "Folder"
    saved = client_loopback.post(
        "/api/project/save",
        json={"project": _project("Fresh"), "path": str(elsewhere / "fresh")},
    )
    assert saved.status_code == 200, saved.text
    assert (elsewhere / "fresh.tasmo").is_file()
    assert [Path(e["path"]) for e in known_paths.recent(kind="tasmo")] == [
        elsewhere / "fresh.tasmo",
        picked,
    ]
    assert known_paths.last_folder("tasmo") == str(picked.parent)

    client_loopback.post("/api/storage/pick-file", json={"kind": "tasmo"})
    assert calls[1]["initial_dir"] == str(picked.parent)


def test_an_opened_project_is_remembered_and_never_served(
    client_loopback: TestClient, tmp_path: Path
) -> None:
    path = tmp_path / "Gig" / "set.tasmo"
    path.parent.mkdir()
    TasmoFile.save(TasmoProject(project_name="Set"), str(path))

    assert (
        client_loopback.post("/api/project/load", json={"path": str(path)}).status_code
        == 200
    )
    entry = _only("tasmo")
    assert (entry["path"], entry["source"]) == (str(path), "client")
    assert known_paths.find_servable(path) is None


def test_an_installed_project_stays_servable_after_it_is_opened(
    client_loopback: TestClient, tmp_path: Path
) -> None:
    path = tmp_path / "Projects" / "demo.tasmo"
    path.parent.mkdir()
    TasmoFile.save(TasmoProject(project_name="Demo"), str(path))
    known_paths.record(path, source="install")

    assert (
        client_loopback.post("/api/project/load", json={"path": str(path)}).status_code
        == 200
    )
    assert (_only("tasmo")["source"], _only("tasmo")["servable"]) == ("install", True)


def test_a_project_that_fails_to_open_is_not_remembered(
    client_loopback: TestClient, tmp_path: Path
) -> None:
    broken = tmp_path / "broken.tasmo"
    broken.write_bytes(b"not a zip")
    assert client_loopback.post(
        "/api/project/load", json={"path": str(broken)}
    ).status_code in (
        400,
        500,
    )
    assert known_paths.recent(kind="tasmo") == []


def test_the_default_dir_is_the_projects_folder(
    client_loopback: TestClient, tmp_path: Path
) -> None:
    chosen = tmp_path / "My Projects"
    known_paths.set_projects_dir(chosen)
    assert client_loopback.get("/api/project/default-dir").json() == {
        "path": str(chosen)
    }


def test_recent_rereads_a_file_a_restore_rewrote(
    client_loopback: TestClient, tmp_path: Path
) -> None:
    """The sequence a backup restore produces: the app has saved a project, the
    restore rewrites recent_projects.json on disk, the UI asks for the list and
    then saves again. Both the list and the next write must carry the restored
    entries."""
    before = tmp_path / "before.tasmo"
    client_loopback.post(
        "/api/project/save", json={"project": _project("B"), "path": str(before)}
    )
    assert [r["name"] for r in client_loopback.get("/api/project/recent").json()] == [
        "B"
    ]

    restored = [
        {"path": str(tmp_path / "old1.tasmo"), "name": "Old One"},
        {"path": str(tmp_path / "old2.tasmo"), "name": "Old Two"},
    ]
    recent_file = tmp_path / "state" / "recent_projects.json"
    recent_file.write_text(json.dumps(restored, indent=4), encoding="utf-8")
    st = recent_file.stat()
    os.utime(recent_file, ns=(st.st_atime_ns, st.st_mtime_ns + 2_000_000_000))

    assert client_loopback.get("/api/project/recent").json() == restored

    after = tmp_path / "after.tasmo"
    client_loopback.post(
        "/api/project/save", json={"project": _project("A"), "path": str(after)}
    )
    names = [r["name"] for r in client_loopback.get("/api/project/recent").json()]
    assert names == ["A", "Old One", "Old Two"]
    on_disk = json.loads(recent_file.read_text(encoding="utf-8"))
    assert [r["name"] for r in on_disk] == names


def test_recent_does_not_reread_an_unchanged_file(
    client_loopback: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client_loopback.post(
        "/api/project/save",
        json={"project": _project("Once"), "path": str(tmp_path / "once.tasmo")},
    )
    reads: list[int] = []
    real = project_router._load_recent
    monkeypatch.setattr(
        project_router, "_load_recent", lambda: reads.append(1) or real()
    )
    for _ in range(3):
        assert [
            r["name"] for r in client_loopback.get("/api/project/recent").json()
        ] == ["Once"]
    assert reads == []


# ---------------------------------------------------------------------------
# SwayCommand scenes
# ---------------------------------------------------------------------------


def test_a_cockpit_save_is_remembered_and_opens_by_name(
    client: TestClient, tmp_path: Path
) -> None:
    doc = {"version": 1, "scenes": [{"name": "Intro"}]}
    saved = client.post(
        "/api/sway/project-save", json={"name": "My Scene", "doc": doc}
    ).json()
    target = tmp_path / "sway-projects" / "My Scene.sway"
    assert Path(saved["path"]) == target.resolve()

    entry = _only("sway")
    assert (entry["source"], entry["servable"]) == ("sway-save", True)
    assert Path(entry["path"]) == target.resolve()

    for name in ("My Scene", "My Scene.sway"):
        body = client.get("/api/sway/project", params={"name": name}).json()
        assert body == {"name": "My Scene", "path": saved["path"], "doc": doc}


def test_a_cockpit_save_leaves_the_sway_picker_in_the_users_folder(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The order the SWAY tab produces: the user picks a .sway from their own
    folder, then the cockpit mirrors a save into the scene folder. The next
    .sway dialog still opens in the user's folder."""
    picked = tmp_path / "Shows" / "Opener.sway"
    picked.parent.mkdir()
    picked.write_text("{}", encoding="utf-8")
    calls: list[dict[str, Any]] = []
    answers = [str(picked), None]

    def pick_open_file(**kwargs: Any) -> str | None:
        calls.append(kwargs)
        return answers.pop(0)

    monkeypatch.setattr(folder_dialog, "picker_available", lambda: True)
    monkeypatch.setattr(folder_dialog, "pick_open_file", pick_open_file)

    chosen = client.post("/api/storage/pick-file", json={"kind": "sway"}).json()
    assert chosen == {"path": str(picked), "cancelled": False}
    assert _only("sway")["source"] == "pick"

    saved = client.post(
        "/api/sway/project-save", json={"name": "Opener", "doc": {"version": 1}}
    )
    assert saved.status_code == 200, saved.text
    assert known_paths.last_folder("sway") == str(picked.parent)
    assert [Path(e["path"]) for e in known_paths.recent(kind="sway")] == [
        Path(saved.json()["path"]),
        picked,
    ]

    client.post("/api/storage/pick-file", json={"kind": "sway"})
    assert calls[1]["initial_dir"] == str(picked.parent)


def test_an_installed_copy_with_a_numbered_name_opens_by_its_listed_name(
    client: TestClient, tmp_path: Path
) -> None:
    """An asset install names a second copy "Demo (2).sway". A save would drop
    the parentheses, but the name /projects lists has to open that file."""
    folder = tmp_path / "sway-projects"
    folder.mkdir()
    (folder / "Demo.sway").write_text('{"copy": 1}', encoding="utf-8")
    (folder / "Demo (2).sway").write_text('{"copy": 2}', encoding="utf-8")

    listed = {p["name"] for p in client.get("/api/sway/projects").json()["projects"]}
    assert listed == {"Demo", "Demo (2)"}
    body = client.get("/api/sway/project", params={"name": "Demo (2)"}).json()
    assert (body["name"], body["doc"]) == ("Demo (2)", {"copy": 2})


def test_opening_a_scene_that_is_not_there_is_a_404(client: TestClient) -> None:
    resp = client.get("/api/sway/project", params={"name": "never saved"})
    assert resp.status_code == 404


def test_a_scene_name_cannot_reach_outside_the_scene_folder(
    client: TestClient, tmp_path: Path
) -> None:
    (tmp_path / "secret.sway").write_text("{}", encoding="utf-8")
    (tmp_path / "sway-projects").mkdir()

    escaped = client.get("/api/sway/project", params={"name": "../secret"})
    assert escaped.status_code == 404
    assert client.get("/api/sway/project", params={"name": "///"}).status_code == 400
    assert client.get("/api/sway/project").status_code == 422


def test_a_scene_theDAW_may_serve_opens_by_path(
    client: TestClient, tmp_path: Path
) -> None:
    doc = {"version": 1, "scenes": [{"name": "Intro"}]}
    saved = client.post("/api/sway/project-save", json={"name": "Set", "doc": doc})
    saved_path = saved.json()["path"]
    body = client.get("/api/sway/project", params={"path": saved_path}).json()
    assert body == {"name": "Set", "path": saved_path, "doc": doc}

    # A copy the user saved through a Save dialog, outside the scene folder.
    copy = tmp_path / "Desktop" / "Set copy.sway"
    copy.parent.mkdir()
    copy.write_text(json.dumps({"copy": True}), encoding="utf-8")
    known_paths.record(copy, source="save")
    body = client.get("/api/sway/project", params={"path": str(copy)}).json()
    assert body == {"name": "Set copy", "path": str(copy), "doc": {"copy": True}}


def test_a_scene_path_theDAW_may_not_serve_is_refused_alike(
    client: TestClient, tmp_path: Path
) -> None:
    def write(path: Path) -> Path:
        path.write_text('{"secret": "scene"}', encoding="utf-8")
        return path

    never = write(tmp_path / "never.sway")
    typed = write(tmp_path / "typed.sway")
    known_paths.record(typed, source="client")
    gone = write(tmp_path / "gone.sway")
    known_paths.record(gone, source="save")
    gone.unlink()
    not_a_scene = write(tmp_path / "chart.json")
    known_paths.record(not_a_scene, source="save")

    answers = [
        client.get("/api/sway/project", params={"path": str(p)})
        for p in (never, typed, gone, not_a_scene, tmp_path / "missing.sway", "")
    ]
    assert {r.status_code for r in answers} == {403}
    assert len({r.text for r in answers}) == 1
    assert "secret" not in answers[0].text
    assert str(tmp_path) not in answers[0].text

    # A path wins over a name, so a name cannot open what the path may not.
    (tmp_path / "sway-projects").mkdir()
    write(tmp_path / "sway-projects" / "Listed.sway")
    both = client.get(
        "/api/sway/project", params={"name": "Listed", "path": str(never)}
    )
    assert both.status_code == 403


@pytest.mark.parametrize(
    "headers",
    [{"sec-fetch-site": "cross-site"}, {"origin": "https://evil.example"}],
)
def test_a_page_on_another_site_cannot_read_a_scene(
    client: TestClient, headers: dict[str, str]
) -> None:
    doc = {"scenes": [{"name": "Private"}]}
    saved = client.post("/api/sway/project-save", json={"name": "Set", "doc": doc})
    for params in ({"name": "Set"}, {"path": saved.json()["path"]}):
        resp = client.get("/api/sway/project", params=params, headers=headers)
        assert resp.status_code == 403
        assert "Private" not in resp.text


# ---------------------------------------------------------------------------
# .gan plugins
# ---------------------------------------------------------------------------


def test_opening_a_gan_by_path_remembers_the_shelf_copy_and_keeps_the_folder(
    client: TestClient, tmp_path: Path
) -> None:
    manifest, assets = import_vst_foundry(
        str(_foundry_export(tmp_path / "src")), name="Picked"
    )
    picked = tmp_path / "Downloads" / "picked.gan"
    picked.parent.mkdir()
    GanFile.save(manifest, assets, str(picked))
    # The .gan picker records the user's file first.
    known_paths.record(picked, source="pick")

    body = client.post("/api/plugin/open", json={"path": str(picked)}).json()
    installed = tmp_path / "plugins" / f"{manifest.id}.gan"
    assert body["gan_path"] == str(installed)

    newest = known_paths.recent(kind="gan")[0]
    assert (newest["path"], newest["source"], newest["servable"]) == (
        str(installed),
        "gan",
        True,
    )
    assert known_paths.last_folder("gan") == str(picked.parent)

    by_id = client.post("/api/plugin/open", json={"id": manifest.id}).json()
    assert by_id["gan_path"] == str(installed)


def test_an_imported_foundry_export_is_remembered_without_moving_the_gan_folder(
    client: TestClient, tmp_path: Path
) -> None:
    pj = _foundry_export(tmp_path / "Foundry")
    body = client.post("/api/plugin/import-owl", json={"project_path": str(pj)}).json()
    entry = _only("gan")
    assert (entry["path"], entry["source"]) == (body["gan_path"], "gan")
    assert "gan" not in _stored_folders(tmp_path)


def test_reveal_goes_through_the_shared_helper(
    client_loopback: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """theDAW's own UI (a loopback caller) reaches the real handler."""
    shown: list[str] = []

    def fake_reveal(path: str) -> str:
        shown.append(path)
        return f"shown:{path}"

    monkeypatch.setattr(plugin_router.reveal_lib, "reveal", fake_reveal)
    target = tmp_path / "x.gan"
    body = client_loopback.post("/api/plugin/reveal", json={"path": str(target)}).json()
    assert body == {"status": "ok", "path": f"shown:{target}"}
    assert shown == [str(target)]


def test_reveal_from_a_lan_peer_without_a_token_is_refused(
    client: TestClient, tmp_path: Path
) -> None:
    """ITW security P1: a non-loopback caller with no launch token never
    reaches the handler at all (403 from the gate), unlike a loopback caller
    naming a path that merely doesn't exist (404, see the test above)."""
    resp = client.post("/api/plugin/reveal", json={"path": str(tmp_path / "x.gan")})
    assert resp.status_code == 403


def test_reveal_answers_404_400_and_500_apart(
    client_loopback: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    started: list[list[str]] = []
    monkeypatch.setattr(
        plugin_router.reveal_lib.subprocess,
        "Popen",
        lambda args, *a, **k: started.append(args) or SimpleNamespace(),
    )
    missing = client_loopback.post(
        "/api/plugin/reveal", json={"path": str(tmp_path / "gone")}
    )
    assert missing.status_code == 404
    share = client_loopback.post("/api/plugin/reveal", json={"path": SHARE})
    assert share.status_code == 400
    assert started == []

    def broken(path: str) -> str:
        raise OSError("no file manager")

    monkeypatch.setattr(plugin_router.reveal_lib, "reveal", broken)
    failed = client_loopback.post("/api/plugin/reveal", json={"path": str(tmp_path)})
    assert failed.status_code == 500


@pytest.mark.parametrize("bad_id", ["..", ".", "a/b", "a\\b", "C:x", ""])
def test_a_plugin_id_that_names_another_folder_is_refused(
    client: TestClient, tmp_path: Path, bad_id: str
) -> None:
    """``..`` joined onto the runtime folder is the plugin shelf itself, which
    delete_plugin used to remove before it checked that the plugin existed."""
    shelf = tmp_path / "plugins"
    (shelf / "_runtime" / "kept").mkdir(parents=True)
    (shelf / "kept.gan").write_bytes(b"x")

    with pytest.raises(HTTPException) as deleted:
        plugin_router.delete_plugin(bad_id)
    assert deleted.value.status_code == 400
    with pytest.raises(HTTPException) as opened:
        plugin_router.open_plugin(plugin_router.OpenRequest(id=bad_id or " "))
    assert opened.value.status_code == 400

    assert (shelf / "kept.gan").is_file()
    assert (shelf / "_runtime" / "kept").is_dir()


# ---------------------------------------------------------------------------
# DAW project imports
# ---------------------------------------------------------------------------


class _FakeProject:
    tracks: list = []

    def collapse_silent_gaps(self) -> None:
        pass

    def to_dict(self) -> dict:
        return {"name": "fake"}


def test_an_imported_daw_project_is_remembered_and_never_served(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "backend.modules.dawimport.reaper.parse_rpp", lambda path: _FakeProject()
    )
    # Where the import dialog last landed.
    picked_folder = tmp_path / "Picked Sets"
    picked_folder.mkdir()
    known_paths.record_folder("daw-project", picked_folder)
    rpp = tmp_path / "Sets" / "song.RPP"
    rpp.parent.mkdir()
    rpp.write_text("<REAPER_PROJECT>", encoding="utf-8")

    assert client.post("/api/dawimport/reaper", json={"path": str(rpp)}).json() == {
        "name": "fake"
    }
    entry = _only("daw-project")
    assert (entry["path"], entry["source"], entry["servable"]) == (
        str(rpp),
        "client",
        False,
    )
    assert known_paths.find_servable(rpp) is None
    # The body named the file, so the import picker's folder is not moved.
    assert known_paths.last_folder("daw-project") == str(picked_folder)


def test_a_failed_import_is_not_remembered(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fail(path: str) -> None:
        raise RuntimeError("unreadable")

    monkeypatch.setattr("backend.modules.dawimport.reaper.parse_rpp", fail)
    rpp = tmp_path / "bad.rpp"
    rpp.write_text("?", encoding="utf-8")
    assert (
        client.post("/api/dawimport/reaper", json={"path": str(rpp)}).status_code == 500
    )
    assert known_paths.recent() == []


def test_an_import_of_a_file_without_a_project_extension_is_not_remembered(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A lenient parser accepting some other file keeps it out of the DAW
    project menus."""
    monkeypatch.setattr(
        "backend.modules.dawimport.audition.parse_sesx", lambda path: _FakeProject()
    )
    other = tmp_path / "notes.xml"
    other.write_text("<x/>", encoding="utf-8")
    assert (
        client.post("/api/dawimport/audition", json={"path": str(other)}).status_code
        == 200
    )
    assert known_paths.recent() == []
    assert known_paths.find_servable(other) is None


# ---------------------------------------------------------------------------
# VJ exports
# ---------------------------------------------------------------------------


def test_a_finished_vj_export_is_remembered(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    exports = tmp_path / "exports"
    monkeypatch.setattr(vj_router, "_export_root", lambda: str(exports))

    def fake_transcode(src: Path, codec: str, out_dir: Path) -> Path:
        out = out_dir / "LUMINA_take.mp4"
        out.write_bytes(src.read_bytes())
        return out

    monkeypatch.setattr(vj_router.export, "transcode", fake_transcode)
    resp = client.post(
        "/api/vj/export",
        files={"file": ("take.webm", b"webm bytes", "video/webm")},
        data={"codec": "h264"},
    )
    assert resp.status_code == 200, resp.text
    entry = _only("video")
    assert (entry["path"], entry["source"], entry["servable"]) == (
        resp.json()["path"],
        "save",
        True,
    )
