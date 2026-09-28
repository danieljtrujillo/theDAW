"""A staged SwayCommand template plays theDAW's copy of its song.

The cockpit's Will I Dream template names its song by the absolute path it had on
the author's machine (C:\\Users\\Cyboman\\Music\\...). On any other machine
/api/project/clip-audio answered 404 and the scene played silent. These replay
the SWAY tab's sequence: the tab asks /api/sway/url, which registers the staged
templates' media, and the cockpit then fetches the template's song by that path.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.assets import catalog
from backend.modules.project import media_access
from backend.modules.project.router import router as project_api
from backend.modules.sway import router as sway_api
from backend.modules.sway import sidecar


def _template(dist: Path, stem: str, media_paths: list[str]) -> Path:
    doc = {
        "format": "swaycommand-project",
        "project": {
            "media": [
                {"id": f"m{i}", "name": Path(p).name, "path": p}
                for i, p in enumerate(media_paths)
            ]
        },
    }
    path = dist / "templates" / f"{stem}.sway"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


@pytest.fixture()
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    dist = tmp_path / "sway-dist"
    (dist / "index.html").parent.mkdir(parents=True)
    (dist / "index.html").write_text("<title>cockpit</title>", encoding="utf-8")
    examples = tmp_path / "examples"
    (examples / "audio").mkdir(parents=True)
    song = examples / "audio" / "will i dream.opus"
    song.write_bytes(b"OggS shipped song")

    monkeypatch.setattr(sidecar, "resolve_dist_dir", lambda: dist)
    # server.py sets this when it registers /sway-app; this app has no server.py.
    monkeypatch.setattr(sidecar, "STATIC_MOUNTED", True)
    monkeypatch.setattr(catalog, "EXAMPLES_DIR", examples)
    monkeypatch.setattr(sway_api, "_template_media_registered", False)
    monkeypatch.setattr(
        media_access, "_ROOTS_STATE", tmp_path / "clip_audio_roots.json"
    )
    monkeypatch.setattr(media_access, "_session_roots", [])
    monkeypatch.setattr(media_access, "_stand_ins", {})
    monkeypatch.delenv("theDAW_MEDIA_ROOTS", raising=False)

    app = FastAPI()
    app.include_router(project_api, prefix="/api/project")
    app.include_router(sway_api.router, prefix="/api/sway")
    # /clip-audio is loopback-gated (T02): TestClient's default peer is
    # "testclient", which is not loopback, so name a real loopback peer the
    # way tests/test_vst_render_host.py does.
    return {
        "client": TestClient(app, client=("127.0.0.1", 51000)),
        "dist": dist,
        "song": song,
        "author": tmp_path / "author" / "Music",
    }


def _clip(client: TestClient, path: str | Path):
    return client.get("/api/project/clip-audio", params={"path": str(path)})


def test_template_song_from_another_machine_plays_the_shipped_copy(env) -> None:
    missing = env["author"] / "New Will I Dream Master Style 2 - Live Punchy.mp3"
    _template(env["dist"], "will-i-dream", [str(missing)])

    # Before the tab asks for its URL, nothing is registered.
    assert _clip(env["client"], missing).status_code == 403

    assert env["client"].get("/api/sway/url").status_code == 200
    resp = _clip(env["client"], missing)
    assert resp.status_code == 200
    assert resp.content == b"OggS shipped song"


def test_a_song_present_at_its_path_is_served_as_itself(env) -> None:
    env["author"].mkdir(parents=True)
    real = env["author"] / "will i dream master.mp3"
    real.write_bytes(b"ID3 the real file")
    _template(env["dist"], "will-i-dream", [str(real)])

    env["client"].get("/api/sway/url")
    resp = _clip(env["client"], real)
    assert resp.status_code == 200
    assert resp.content == b"ID3 the real file"


def test_the_real_file_wins_once_it_appears(env) -> None:
    missing = env["author"] / "song.mp3"
    _template(env["dist"], "will-i-dream", [str(missing)])
    env["client"].get("/api/sway/url")
    assert _clip(env["client"], missing).content == b"OggS shipped song"

    env["author"].mkdir(parents=True)
    missing.write_bytes(b"ID3 copied over later")
    assert _clip(env["client"], missing).content == b"ID3 copied over later"


def test_no_stand_in_without_a_matching_shipped_song(env) -> None:
    missing = env["author"] / "other.mp3"
    _template(env["dist"], "nature-s-tomb", [str(missing)])
    env["client"].get("/api/sway/url")
    assert _clip(env["client"], missing).status_code == 404


def test_no_stand_in_when_a_template_names_several_files(env) -> None:
    a = env["author"] / "a.mp3"
    b = env["author"] / "b.mp3"
    _template(env["dist"], "will-i-dream", [str(a), str(b)])
    env["client"].get("/api/sway/url")
    assert _clip(env["client"], a).status_code == 404
    assert _clip(env["client"], b).status_code == 404


def test_a_request_cannot_register_a_stand_in(env) -> None:
    """Only templates the server read can map a path; a path a caller invents
    stays refused."""
    _template(env["dist"], "will-i-dream", [str(env["author"] / "song.mp3")])
    env["client"].get("/api/sway/url")
    invented = env["author"].parent / "private" / "secret.wav"
    assert _clip(env["client"], invented).status_code == 403
