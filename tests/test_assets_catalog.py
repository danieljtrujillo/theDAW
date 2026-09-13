"""The asset library: what the catalog accepts, and where an install lands.

A catalog file is data written by hand, so the parser's job is to drop a bad
entry and keep the rest. Install is the other half: each format has one place
it belongs, and a second install of the same item must not overwrite the copy
the user has since edited.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.modules.assets import catalog
from backend.server import app


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def bundled(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """A catalog of our own, standing in for examples/catalog.json."""
    root = tmp_path / "examples"
    (root / "projects").mkdir(parents=True)
    (root / "projects" / "demo.tasmo").write_bytes(b"PK\x03\x04 not really a zip")
    (root / "cover.jpg").write_bytes(b"\xff\xd8\xff")
    (root / "catalog.json").write_text(
        json.dumps(
            {
                "assets": [
                    {
                        "id": "demo",
                        "name": "Demo Project",
                        "file": "projects/demo.tasmo",
                        "cover": "cover.jpg",
                        "summary": "a demo",
                        "tags": ["uncanny", "meter"],
                        "tabs": ["EDIT"],
                    },
                    {
                        "id": "missing-file",
                        "name": "Listed But Absent",
                        "file": "projects/nope.tasmo",
                        "summary": "not shipped in this install",
                    },
                    {"name": "no id at all", "file": "projects/demo.tasmo"},
                    {
                        "id": "escapes",
                        "name": "Outside The Catalog",
                        "file": "../../etc/passwd",
                    },
                    {
                        "id": "unknown-format",
                        "name": "Some Other Thing",
                        "file": "projects/demo.exe",
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(catalog, "EXAMPLES_DIR", root)
    monkeypatch.setattr(catalog, "BUNDLED_CATALOG", root / "catalog.json")
    monkeypatch.setattr(catalog, "user_catalog_dir", lambda: tmp_path / "userdata")
    return root


def test_bad_entries_are_dropped_and_the_rest_survive(bundled: Path) -> None:
    entries = {e.id: e for e in catalog.load_entries()}
    assert set(entries) == {"demo", "missing-file"}
    assert entries["demo"].kind == "project"
    assert entries["demo"].format == ".tasmo"
    assert entries["demo"].available is True
    # Listed and absent is a state the browser shows, not a parse failure.
    assert entries["missing-file"].available is False


def test_search_ranks_a_name_match_first(bundled: Path) -> None:
    entries = catalog.load_entries()
    assert [e.id for e in catalog.search(entries, query="demo")] == ["demo"]
    assert [e.id for e in catalog.search(entries, tag="meter")] == ["demo"]
    assert [e.id for e in catalog.search(entries, tab="EDIT")] == ["demo"]
    assert catalog.search(entries, query="nothing here at all") == []
    assert [e.id for e in catalog.search(entries, available_only=True)] == ["demo"]


def test_user_catalog_overrides_a_bundled_id(
    bundled: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    user = tmp_path / "userdata"
    (user / "mine").mkdir(parents=True)
    (user / "mine" / "demo.tasmo").write_bytes(b"mine")
    (user / "extra.json").write_text(
        json.dumps(
            {
                "assets": [
                    {"id": "demo", "name": "My Own Demo", "file": "mine/demo.tasmo"}
                ]
            }
        ),
        encoding="utf-8",
    )
    entries = {e.id: e for e in catalog.load_entries()}
    assert entries["demo"].name == "My Own Demo"


def test_listing_and_detail_over_http(client: TestClient, bundled: Path) -> None:
    body = client.get("/api/assets").json()
    assert body["count"] == 2
    assert {a["id"] for a in body["assets"]} == {"demo", "missing-file"}

    one = client.get("/api/assets/demo").json()
    assert one["name"] == "Demo Project"
    assert one["installs_to"].endswith("theDAW Projects")

    assert client.get("/api/assets/nope").status_code == 404
    assert client.get("/api/assets/demo/cover").status_code == 200
    assert client.get("/api/assets/missing-file/cover").status_code == 404


def test_facets_count_every_axis(client: TestClient, bundled: Path) -> None:
    f = client.get("/api/assets/facets").json()
    assert {"value": "project", "count": 2} in f["kinds"]
    assert {"value": "uncanny", "count": 1} in f["tags"]
    assert {"value": "EDIT", "count": 1} in f["tabs"]


def test_install_twice_keeps_both_copies(
    client: TestClient, bundled: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The second install of an item the user has since edited must not land on
    top of their copy."""
    projects = tmp_path / "Documents" / "theDAW Projects"
    monkeypatch.setattr(
        "backend.modules.assets.router._install_path", lambda entry: projects
    )

    first = client.post("/api/assets/demo/install").json()
    assert Path(first["path"]).is_file()
    assert Path(first["path"]).name == "demo.tasmo"

    second = client.post("/api/assets/demo/install").json()
    assert Path(second["path"]).name == "demo (2).tasmo"
    assert Path(first["path"]).is_file()


def test_installing_something_absent_is_a_404(
    client: TestClient, bundled: Path
) -> None:
    assert client.post("/api/assets/missing-file/install").status_code == 404
    assert client.get("/api/assets/missing-file/download").status_code == 404


def test_the_shipped_catalog_is_valid() -> None:
    """The real examples/catalog.json, checked as it ships: every entry parses
    and every file it names is present."""
    entries = catalog.load_entries()
    assert entries, "the bundled catalog is empty"
    missing = [e.id for e in entries if not e.available]
    assert not missing, f"catalog lists files this checkout does not have: {missing}"
