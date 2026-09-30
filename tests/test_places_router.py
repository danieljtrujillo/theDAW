"""/api/places over HTTP: what a request can make the server remember, show,
serve and write.

The server binds 0.0.0.0 and CORS is open, so each refusal here is paired with
the call from theDAW's own UI that must keep working.
"""

from __future__ import annotations

import hmac
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from backend.lib import known_paths, launch_token
from backend.lib import reveal as reveal_lib
from backend.modules.places import router as places_router
from backend.server import app

TOKEN_HEADER = "X-TheDAW-Launch-Token"
SHARE = "\\\\attacker\\share\\loop.wav"


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """theDAW's own UI on this machine: a loopback TCP peer, which is what
    every call from it looks like on the wire (directly, or through the Vite
    proxy on this machine). ``TestClient``'s default peer is a non-loopback
    stand-in, which the routes now treat as a caller on another machine; the
    LAN cases have their own clients in ``tests/test_lan_paired_device.py``."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv(launch_token.ENV_VAR, raising=False)
    monkeypatch.setattr(
        known_paths, "_STORE_PATH", tmp_path / "state" / "known_paths.json"
    )
    monkeypatch.setattr(known_paths, "_GRANTS", {})
    return TestClient(app, client=("127.0.0.1", 51000))


def _touch(path: Path, data: bytes = b"x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


class _Popen:
    """Stands in for subprocess.Popen so no file manager opens during a test."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def __call__(self, args: list[str], *_a: Any, **_k: Any) -> SimpleNamespace:
        self.calls.append(list(args))
        return SimpleNamespace()


def test_the_module_is_mounted() -> None:
    assert "places" in {m["name"] for m in app.state.loaded_modules}


# ---------------------------------------------------------------------------
# record, folder, recent
# ---------------------------------------------------------------------------


def test_a_recorded_path_joins_recent_unservable_and_moves_no_folder(
    client: TestClient, tmp_path: Path
) -> None:
    take = _touch(tmp_path / "Downloads" / "take.wav")
    resp = client.post("/api/places/record", json={"path": str(take)})
    assert resp.json() == {"recorded": True, "kind": "audio"}

    folder = client.get("/api/places/folder", params={"kind": "audio"}).json()
    assert folder == {"kind": "audio", "folder": None}

    items = client.get("/api/places/recent", params={"kind": "audio"}).json()["items"]
    assert [(i["name"], i["source"], i["servable"]) for i in items] == [
        ("take.wav", "client", False)
    ]
    assert set(items[0]) == {"path", "name", "kind", "source", "at", "servable"}


def test_a_request_cannot_move_a_pickers_folder_and_the_desktop_shell_can(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The order the app produces: the user picks a file, a page names another
    path, then the desktop shell records a download it finished."""
    monkeypatch.setenv(launch_token.ENV_VAR, "launch-secret")
    picked = _touch(tmp_path / "Sessions" / "take.wav")
    known_paths.record(picked, source="pick")

    named = _touch(tmp_path / "Elsewhere" / "planted.wav")
    for headers in ({}, {TOKEN_HEADER: "wrong-secret"}):
        client.post("/api/places/record", json={"path": str(named)}, headers=headers)
        folder = client.get("/api/places/folder", params={"kind": "audio"}).json()
        assert folder["folder"] == str(picked.parent)

    downloaded = _touch(tmp_path / "Downloads" / "loop.wav")
    client.post(
        "/api/places/record",
        json={"path": str(downloaded)},
        headers={TOKEN_HEADER: "launch-secret"},
    )
    folder = client.get("/api/places/folder", params={"kind": "audio"}).json()
    assert folder["folder"] == str(downloaded.parent)
    names = [i["name"] for i in known_paths.recent(kind="audio")]
    assert names == ["loop.wav", "planted.wav", "take.wav"]


@pytest.mark.parametrize(
    ("env", "header", "matches"),
    [
        ("launch-secret", "launch-secret", True),
        ("launch-secret", "wrong-secret", False),
        ("launch-secret", None, False),
        (None, "launch-secret", False),
    ],
)
def test_the_launch_token_check_answers_only_whether_the_header_matches(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    env: str | None,
    header: str | None,
    matches: bool,
) -> None:
    if env is None:
        monkeypatch.delenv(launch_token.ENV_VAR, raising=False)
    else:
        monkeypatch.setenv(launch_token.ENV_VAR, env)
    headers = {TOKEN_HEADER: header} if header is not None else {}
    resp = client.get("/api/places/launch-token-check", headers=headers)
    assert resp.status_code == 200
    assert resp.json() == {"matches": matches}
    assert "launch-secret" not in resp.text


def test_a_page_on_another_site_cannot_ask_about_the_launch_token(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(launch_token.ENV_VAR, "launch-secret")
    resp = client.get(
        "/api/places/launch-token-check",
        headers={TOKEN_HEADER: "launch-secret", "origin": "https://evil.example"},
    )
    assert resp.status_code == 403


def test_a_download_the_desktop_shell_vouches_for_is_served(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(launch_token.ENV_VAR, "launch-secret")
    loop = _touch(tmp_path / "Downloads" / "loop.wav", b"RIFF-download")

    resp = client.post(
        "/api/places/record",
        json={"path": str(loop)},
        headers={TOKEN_HEADER: "launch-secret"},
    )
    assert resp.json() == {"recorded": True, "kind": "audio"}
    [item] = client.get("/api/places/recent", params={"kind": "audio"}).json()["items"]
    assert (item["source"], item["servable"]) == ("download", True)
    folder = client.get("/api/places/folder", params={"kind": "audio"}).json()
    assert folder["folder"] == str(loop.parent)

    served = client.get("/api/places/file", params={"path": str(loop)})
    assert served.status_code == 200
    assert served.content == b"RIFF-download"


@pytest.mark.parametrize(
    ("env", "header"),
    [
        ("launch-secret", "wrong-secret"),
        ("launch-secret", None),
        (None, "launch-secret"),
        ("", ""),
    ],
)
def test_a_record_without_the_launch_token_is_never_served(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    env: str | None,
    header: str | None,
) -> None:
    if env is None:
        monkeypatch.delenv(launch_token.ENV_VAR, raising=False)
    else:
        monkeypatch.setenv(launch_token.ENV_VAR, env)
    secret = _touch(tmp_path / "private" / "keys.json", b'{"key": "secret"}')
    headers = {TOKEN_HEADER: header} if header is not None else {}

    client.post("/api/places/record", json={"path": str(secret)}, headers=headers)
    [item] = client.get("/api/places/recent").json()["items"]
    assert (item["source"], item["servable"]) == ("client", False)
    resp = client.get("/api/places/file", params={"path": str(secret)})
    assert resp.status_code == 403
    assert b"secret" not in resp.content


def _request(headers: dict[str, str]) -> Request:
    return Request(
        {
            "type": "http",
            "headers": [
                (k.lower().encode("latin-1"), v.encode("latin-1"))
                for k, v in headers.items()
            ],
        }
    )


def test_the_launch_token_is_read_from_the_environment_at_call_time(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    compared: list[tuple[bytes, bytes]] = []
    real = hmac.compare_digest

    def spy(a: bytes, b: bytes) -> bool:
        compared.append((a, b))
        return real(a, b)

    monkeypatch.setattr(launch_token.hmac, "compare_digest", spy)
    carrying = _request({TOKEN_HEADER: "abc"})

    monkeypatch.delenv(launch_token.ENV_VAR, raising=False)
    assert launch_token.header_matches(carrying) is False
    monkeypatch.setenv(launch_token.ENV_VAR, "abc")
    assert launch_token.header_matches(carrying) is True
    assert compared == [(b"abc", b"abc")]
    monkeypatch.setenv(launch_token.ENV_VAR, "abd")
    assert launch_token.header_matches(carrying) is False
    assert launch_token.header_matches(_request({})) is False
    monkeypatch.setenv(launch_token.ENV_VAR, "")
    assert launch_token.header_matches(_request({TOKEN_HEADER: ""})) is False


def test_recording_a_missing_path_records_nothing(
    client: TestClient, tmp_path: Path
) -> None:
    resp = client.post(
        "/api/places/record",
        json={"path": str(tmp_path / "nope.wav"), "kind": "audio"},
    )
    assert resp.json() == {"recorded": False, "kind": None}
    assert client.get("/api/places/recent").json() == {"items": []}


def test_a_share_path_is_not_recorded_and_moves_no_picker(
    client: TestClient, tmp_path: Path
) -> None:
    resp = client.post("/api/places/record", json={"path": SHARE, "kind": "audio"})
    assert resp.json() == {"recorded": False, "kind": None}
    assert client.get("/api/places/folder", params={"kind": "audio"}).json() == {
        "kind": "audio",
        "folder": None,
    }


def test_a_folder_request_without_a_kind_is_null(client: TestClient) -> None:
    assert client.get("/api/places/folder").json() == {"kind": "", "folder": None}


def test_recent_filters_by_extension(client: TestClient, tmp_path: Path) -> None:
    for name in ("a.mid", "b.midi", "c.wav"):
        known_paths.record(_touch(tmp_path / name), source="pick")
    items = client.get(
        "/api/places/recent", params={"exts": ".mid,.midi", "limit": 20}
    ).json()["items"]
    assert sorted(i["name"] for i in items) == ["a.mid", "b.midi"]
    assert all(i["servable"] for i in items)


# ---------------------------------------------------------------------------
# file
# ---------------------------------------------------------------------------


def test_a_file_a_request_named_is_not_served(
    client: TestClient, tmp_path: Path
) -> None:
    secret = _touch(tmp_path / "private" / "keys.json", b'{"key": "secret"}')
    client.post("/api/places/record", json={"path": str(secret), "kind": "json"})
    resp = client.get("/api/places/file", params={"path": str(secret)})
    assert resp.status_code == 403
    assert b"secret" not in resp.content


def test_a_file_the_backend_recorded_is_served(
    client: TestClient, tmp_path: Path
) -> None:
    saved = _touch(tmp_path / "exports" / "mix.wav", b"RIFF-bytes")
    known_paths.record(saved, source="save")
    resp = client.get("/api/places/file", params={"path": str(saved)})
    assert resp.status_code == 200
    assert resp.content == b"RIFF-bytes"
    assert 'filename="mix.wav"' in resp.headers["content-disposition"]


def test_file_refusals_all_look_the_same(client: TestClient, tmp_path: Path) -> None:
    unknown = _touch(tmp_path / "unknown.wav")
    gone = _touch(tmp_path / "gone.wav")
    known_paths.record(gone, source="save")
    gone.unlink()

    answers = [
        client.get("/api/places/file", params={"path": str(p)})
        for p in (unknown, gone, tmp_path / "never.wav", SHARE)
    ]
    assert {r.status_code for r in answers} == {403}
    assert len({r.text for r in answers}) == 1
    assert str(tmp_path) not in answers[0].text


# ---------------------------------------------------------------------------
# save
# ---------------------------------------------------------------------------


def _save(
    client: TestClient,
    path: Path | str,
    data: bytes,
    kind: str | None = None,
    grant: str | None = None,
):
    form = {"path": str(path)}
    if kind is not None:
        form["kind"] = kind
    if grant is not None:
        form["grant"] = grant
    return client.post(
        "/api/places/save",
        data=form,
        files={
            "file": (Path(str(path)).name or "upload", data, "application/octet-stream")
        },
    )


def test_save_without_a_grant_writes_nothing(
    client: TestClient, tmp_path: Path
) -> None:
    target = tmp_path / "out" / "song.mid"
    known_paths.grant_save(target)
    resp = _save(client, target, b"MThd")
    assert resp.status_code == 403
    assert not target.exists()
    assert not target.parent.exists()


def test_save_with_a_wrong_nonce_or_another_paths_grant_writes_nothing(
    client: TestClient, tmp_path: Path
) -> None:
    target = tmp_path / "out" / "song.mid"
    other = tmp_path / "out" / "other.mid"
    nonce = known_paths.grant_save(other)
    known_paths.grant_save(target)

    assert _save(client, target, b"MThd", grant="guess").status_code == 403
    assert _save(client, target, b"MThd", grant=nonce).status_code == 403
    assert not target.exists()
    # Neither refusal spent the other path's grant.
    assert known_paths.peek_save_grant(other, nonce) is True


def test_a_granted_save_writes_once_and_is_remembered(
    client: TestClient, tmp_path: Path
) -> None:
    target = tmp_path / "new folder" / "song.mid"
    nonce = known_paths.grant_save(target)
    resp = _save(client, target, b"MThd", kind="midi", grant=nonce)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"path": str(target), "kind": "midi"}
    assert target.read_bytes() == b"MThd"
    # The temp file was renamed into place, so nothing else is left beside it.
    assert [p.name for p in target.parent.iterdir()] == ["song.mid"]

    item = client.get("/api/places/recent", params={"kind": "midi"}).json()["items"][0]
    assert (item["path"], item["source"], item["servable"]) == (
        str(target),
        "save",
        True,
    )
    served = client.get("/api/places/file", params={"path": str(target)})
    assert served.content == b"MThd"

    again = _save(client, target, b"overwritten", grant=nonce)
    assert again.status_code == 403
    assert target.read_bytes() == b"MThd"


def test_a_granted_save_replaces_the_file_the_user_chose(
    client: TestClient, tmp_path: Path
) -> None:
    target = _touch(tmp_path / "chart.json", b"old")
    nonce = known_paths.grant_save(target)
    resp = _save(client, target, b'{"new": true}', grant=nonce)
    assert resp.status_code == 200, resp.text
    assert resp.json()["kind"] == "json"
    assert target.read_bytes() == b'{"new": true}'


def test_a_failed_write_keeps_the_grant_for_a_retry(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "exports" / "song.mid"
    nonce = known_paths.grant_save(target)
    real = places_router.atomic_replace
    attempts: list[Path] = []

    def full_disk_once(tmp: Path, dest: Path) -> None:
        attempts.append(dest)
        if len(attempts) == 1:
            raise OSError("disk full")
        real(tmp, dest)

    monkeypatch.setattr(places_router, "atomic_replace", full_disk_once)

    failed = _save(client, target, b"MThd", kind="midi", grant=nonce)
    assert failed.status_code == 500
    assert not target.exists()
    assert list(target.parent.iterdir()) == []
    assert known_paths.recent(kind="midi") == []

    retried = _save(client, target, b"MThd", kind="midi", grant=nonce)
    assert retried.status_code == 200, retried.text
    assert target.read_bytes() == b"MThd"
    assert _save(client, target, b"again", grant=nonce).status_code == 403


@pytest.mark.parametrize("name", ["startup.cmd", "Payload.EXE", "link.lnk", ".bat"])
def test_a_script_is_never_written_even_when_a_grant_matches(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    monkeypatch.setattr(known_paths, "peek_save_grant", lambda path, grant: True)
    monkeypatch.setattr(known_paths, "consume_save_grant", lambda path, grant: True)
    target = tmp_path / "Startup" / name

    resp = _save(client, target, b"@echo off", grant="anything")
    assert resp.status_code == 403
    assert resp.json()["detail"] == "That file type cannot be saved from theDAW."
    assert not target.parent.exists()


def test_a_share_path_is_never_written(client: TestClient) -> None:
    assert known_paths.grant_save(SHARE) is None
    resp = _save(client, SHARE, b"RIFF", grant="anything")
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# reveal
# ---------------------------------------------------------------------------


def test_revealing_a_missing_path_is_404(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = _Popen()
    monkeypatch.setattr(reveal_lib, "subprocess", SimpleNamespace(Popen=fake))
    resp = client.post("/api/places/reveal", json={"path": str(tmp_path / "no.wav")})
    assert resp.status_code == 404
    assert fake.calls == []


@pytest.mark.parametrize(
    "remote",
    [
        SHARE,
        "//attacker/share/loop.wav",
        "\\\\?\\C:\\loop.wav",
        "\\\\.\\PhysicalDrive0",
    ],
)
def test_revealing_a_share_or_device_path_is_400_and_touches_nothing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, remote: str
) -> None:
    fake = _Popen()
    monkeypatch.setattr(reveal_lib, "subprocess", SimpleNamespace(Popen=fake))

    class _NoPath:
        def __init__(self, *_a: Any) -> None:
            raise AssertionError("reveal built a path to check on disk")

    monkeypatch.setattr(reveal_lib, "Path", _NoPath)

    with pytest.raises(ValueError):
        reveal_lib.reveal(remote)
    resp = client.post("/api/places/reveal", json={"path": remote})
    assert resp.status_code == 400
    assert fake.calls == []


@pytest.mark.parametrize("platform", ["win32", "darwin", "linux"])
def test_reveal_selects_the_file_on_each_platform(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    platform: str,
) -> None:
    take = _touch(tmp_path / "take.wav")
    fake = _Popen()
    monkeypatch.setattr(reveal_lib, "subprocess", SimpleNamespace(Popen=fake))
    monkeypatch.setattr(reveal_lib, "sys", SimpleNamespace(platform=platform))

    resp = client.post("/api/places/reveal", json={"path": str(take)})
    assert resp.json() == {"status": "ok", "path": str(take)}
    expected = {
        "win32": ["explorer", f"/select,{take}"],
        "darwin": ["open", "-R", str(take)],
        "linux": ["xdg-open", str(take.parent)],
    }[platform]
    assert fake.calls == [expected]


def test_a_file_manager_that_will_not_start_is_500(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(*_a: Any, **_k: Any) -> None:
        raise OSError("no file manager here")

    monkeypatch.setattr(reveal_lib, "subprocess", SimpleNamespace(Popen=refuse))
    take = _touch(tmp_path / "take.wav")
    resp = client.post("/api/places/reveal", json={"path": str(take)})
    assert resp.status_code == 500


# ---------------------------------------------------------------------------
# projects-dir
# ---------------------------------------------------------------------------


def test_projects_dir_round_trip(client: TestClient, tmp_path: Path) -> None:
    default = tmp_path / "home" / "Documents" / "theDAW Projects"
    assert client.get("/api/places/projects-dir").json() == {
        "path": str(default),
        "configured": False,
    }

    chosen = tmp_path / "Songs"
    put = client.put("/api/places/projects-dir", json={"path": str(chosen)})
    assert put.json() == {"path": str(chosen)}
    assert client.get("/api/places/projects-dir").json() == {
        "path": str(chosen),
        "configured": True,
    }

    for bad in ("relative/dir", "\\\\attacker\\share\\Projects", "//attacker/share"):
        resp = client.put("/api/places/projects-dir", json={"path": bad})
        assert resp.status_code == 400
    assert client.get("/api/places/projects-dir").json() == {
        "path": str(chosen),
        "configured": True,
    }


# ---------------------------------------------------------------------------
# who may call
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "headers",
    [
        {"sec-fetch-site": "cross-site"},
        {"origin": "https://evil.example"},
        {"referer": "https://evil.example/page"},
        {"origin": "null"},
    ],
)
def test_a_page_on_another_site_is_refused(
    client: TestClient, tmp_path: Path, headers: dict[str, str]
) -> None:
    saved = _touch(tmp_path / "exports" / "mix.wav", b"RIFF-bytes")
    known_paths.record(saved, source="save")

    listing = client.get("/api/places/recent", headers=headers)
    assert listing.status_code == 403
    assert str(saved) not in listing.text
    served = client.get(
        "/api/places/file", params={"path": str(saved)}, headers=headers
    )
    assert served.status_code == 403
    assert b"RIFF-bytes" not in served.content
    recorded = client.post(
        "/api/places/record", json={"path": str(saved)}, headers=headers
    )
    assert recorded.status_code == 403


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"origin": "http://localhost:5173"},
        {"origin": "app://."},
        {"origin": "http://192.168.1.50:8600"},
        {"sec-fetch-site": "same-origin"},
    ],
)
def test_theDAW_own_pages_and_the_desktop_shell_pass(
    client: TestClient, tmp_path: Path, headers: dict[str, str]
) -> None:
    saved = _touch(tmp_path / "exports" / "mix.wav", b"RIFF-bytes")
    known_paths.record(saved, source="save")
    resp = client.get("/api/places/file", params={"path": str(saved)}, headers=headers)
    assert resp.status_code == 200
    assert resp.content == b"RIFF-bytes"
