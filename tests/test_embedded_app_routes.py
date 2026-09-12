"""/vj-app and /sway-app must serve a build that appeared AFTER boot.

Both builds are produced by steps that can run while theDAW is already up —
Pinokio's Update npm-installs the VJ checkout, `npm run fetch:sway` stages the
cockpit — and the old code mounted them with ``app.mount`` at import, which
froze the decision at boot: the tab 404'd until someone restarted the backend,
with nothing on screen saying why. So the sequence, not the end state, is what
these cover: import the app with NO build staged, stage one, then request it.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.modules.sway import sidecar as sway_sidecar
from backend.modules.vj import sidecar as vj_sidecar
from backend.server import app

CASES = (
    ("/vj-app", vj_sidecar),
    ("/sway-app", sway_sidecar),
)


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.mark.parametrize("mount,sidecar", CASES)
def test_no_build_staged_is_a_clean_404(client, monkeypatch, mount, sidecar) -> None:
    monkeypatch.setattr(sidecar, "resolve_dist_dir", lambda: None)
    res = client.get(f"{mount}/")
    assert res.status_code == 404
    assert "build" in res.json()["detail"]


@pytest.mark.parametrize("mount,sidecar", CASES)
def test_build_staged_after_boot_serves_without_a_restart(
    client, monkeypatch, tmp_path: Path, mount, sidecar
) -> None:
    # The app object was imported by the module-level import above, long before
    # this directory existed — exactly the Pinokio ordering.
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<title>staged late</title>", encoding="utf-8")
    (dist / "assets").mkdir()
    (dist / "assets" / "app.js").write_text("export const x = 1\n", encoding="utf-8")
    monkeypatch.setattr(sidecar, "resolve_dist_dir", lambda: dist)

    root = client.get(f"{mount}/")
    assert root.status_code == 200
    assert "staged late" in root.text

    asset = client.get(f"{mount}/assets/app.js")
    assert asset.status_code == 200
    assert "export const x" in asset.text

    # A client-routed path the build has no file for renders the shell, the way
    # StaticFiles(html=True) did.
    deep = client.get(f"{mount}/some/client/route")
    assert deep.status_code == 200
    assert "staged late" in deep.text

    # And the status the frontend pivots on agrees, without a restart.
    assert sidecar.static_mount_active() is True


@pytest.mark.parametrize("mount,sidecar", CASES)
def test_cannot_escape_the_build_directory(
    client, monkeypatch, tmp_path: Path, mount, sidecar
) -> None:
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("shell", encoding="utf-8")
    secret = tmp_path / "secret.txt"
    secret.write_text("do not serve me", encoding="utf-8")
    monkeypatch.setattr(sidecar, "resolve_dist_dir", lambda: dist)

    res = client.get(f"{mount}/..%2Fsecret.txt")
    assert res.status_code in (200, 404)
    assert "do not serve me" not in res.text


@pytest.mark.parametrize("mount,sidecar", CASES)
def test_status_is_false_while_nothing_is_staged(monkeypatch, mount, sidecar) -> None:
    """The route exists from boot, so 'mounted' alone must not read as ready —
    that is what let /api/vj/status report ok while the iframe 404'd."""
    monkeypatch.setattr(sidecar, "resolve_dist_dir", lambda: None)
    assert sidecar.static_mount_active() is False
