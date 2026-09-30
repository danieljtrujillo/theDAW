"""Unit tests for backend.modules.lineage.store.

Every test opens a ``LineageStore`` against a throwaway ``tmp_path`` file --
never the real library root -- mirroring the isolation discipline in
test_library_db.py and test_lineage_sidecar.py.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from backend.modules.lineage.records import LineageError
from backend.modules.lineage.store import LineageStore


def _contribution(
    entry_id: str,
    clip_id: str,
    *,
    track_id: str = "track-1",
    role: str = "audio",
) -> dict:
    return {
        "library_entry_id": entry_id,
        "clip_id": clip_id,
        "track_id": track_id,
        "start_sec": 0.0,
        "end_sec": 4.0,
        "source_offset_sec": 0.0,
        "role": role,
    }


def _payload(
    render_id: str,
    *,
    project_id: str = "project-1",
    project_name: str = "My Project",
    created_at: str = "2026-01-01T00:00:00+00:00",
    output_entry_id: str | None = "output-entry-1",
    contributions: list[dict] | None = None,
) -> dict:
    return {
        "render_id": render_id,
        "project_id": project_id,
        "project_name": project_name,
        "created_at": created_at,
        "output": {
            "library_entry_id": output_entry_id,
            "path": "render.wav",
            "kind": "full",
            "start_sec": 0.0,
            "end_sec": 10.0,
        },
        "contributions": (
            contributions
            if contributions is not None
            else [_contribution("entry-source-1", "clip-1")]
        ),
    }


def _open(tmp_path: Path) -> LineageStore:
    return LineageStore(tmp_path / "lineage.db")


def test_put_render_then_get_render_roundtrips_the_record(tmp_path: Path):
    store = _open(tmp_path)

    stored = store.put_render(_payload("render-1"))
    fetched = store.get_render("render-1")

    assert fetched == stored
    assert fetched["render_id"] == "render-1"
    assert fetched["output"]["library_entry_id"] == "output-entry-1"
    assert fetched["contributions"][0]["library_entry_id"] == "entry-source-1"
    store.close()


def test_put_render_is_idempotent_on_render_id(tmp_path: Path):
    store = _open(tmp_path)
    store.put_render(
        _payload("render-1", contributions=[_contribution("entry-a", "clip-1")])
    )

    store.put_render(
        _payload(
            "render-1",
            project_name="Renamed Project",
            contributions=[
                _contribution("entry-b", "clip-2"),
                _contribution("entry-c", "clip-3"),
            ],
        )
    )

    with sqlite3.connect(str(tmp_path / "lineage.db")) as raw:
        raw.row_factory = sqlite3.Row
        render_rows = raw.execute("SELECT * FROM renders").fetchall()
        contribution_rows = raw.execute(
            "SELECT * FROM contributions WHERE render_id = 'render-1'"
        ).fetchall()

    assert len(render_rows) == 1
    assert render_rows[0]["project_name"] == "Renamed Project"
    assert len(contribution_rows) == 2
    assert {row["library_entry_id"] for row in contribution_rows} == {
        "entry-b",
        "entry-c",
    }
    store.close()


def test_used_in_lists_each_project_once_with_render_count_and_last_render_at(
    tmp_path: Path,
):
    store = _open(tmp_path)
    store.put_render(
        _payload(
            "render-1",
            project_id="project-a",
            project_name="Project A",
            created_at="2026-01-01T00:00:00+00:00",
            contributions=[_contribution("entry-x", "clip-1")],
        )
    )
    store.put_render(
        _payload(
            "render-2",
            project_id="project-a",
            project_name="Project A",
            created_at="2026-01-02T00:00:00+00:00",
            contributions=[_contribution("entry-x", "clip-2")],
        )
    )

    result = store.used_in("entry-x")

    assert result["entry_id"] == "entry-x"
    assert len(result["projects"]) == 1
    project = result["projects"][0]
    assert project["project_id"] == "project-a"
    assert project["project_name"] == "Project A"
    assert project["renders"] == 2
    assert project["last_render_at"] == "2026-01-02T00:00:00+00:00"
    assert [r["render_id"] for r in result["renders"]] == ["render-2", "render-1"]
    store.close()


def test_used_in_counts_a_render_once_when_an_entry_contributes_many_clips(
    tmp_path: Path,
):
    store = _open(tmp_path)
    store.put_render(
        _payload(
            "render-1",
            contributions=[_contribution("entry-x", f"clip-{i}") for i in range(40)],
        )
    )

    result = store.used_in("entry-x")

    assert len(result["renders"]) == 1
    assert result["renders"][0]["render_id"] == "render-1"
    assert len(result["projects"]) == 1
    assert result["projects"][0]["renders"] == 1
    store.close()


def test_used_in_is_empty_for_an_unknown_entry(tmp_path: Path):
    store = _open(tmp_path)
    store.put_render(_payload("render-1"))

    result = store.used_in("no-such-entry")

    assert result == {"entry_id": "no-such-entry", "projects": [], "renders": []}
    store.close()


def test_sources_for_returns_the_latest_render_that_produced_the_entry(
    tmp_path: Path,
):
    store = _open(tmp_path)
    store.put_render(
        _payload(
            "render-1", created_at="2026-01-01T00:00:00+00:00", output_entry_id="out-1"
        )
    )
    store.put_render(
        _payload(
            "render-2", created_at="2026-01-02T00:00:00+00:00", output_entry_id="out-1"
        )
    )
    store.put_render(
        _payload(
            "render-3", created_at="2026-01-03T00:00:00+00:00", output_entry_id="out-2"
        )
    )

    result = store.sources_for("out-1")

    assert result["entry_id"] == "out-1"
    assert result["render"] is not None
    assert result["render"]["render_id"] == "render-2"
    store.close()


def test_invalid_payload_raises_lineage_error_and_stores_nothing(tmp_path: Path):
    store = _open(tmp_path)

    with pytest.raises(LineageError):
        store.put_render({"render_id": "bad"})

    assert store.get_render("bad") is None
    store.close()


def test_wal_mode_is_enabled(tmp_path: Path):
    store = _open(tmp_path)

    mode = store._conn.execute("PRAGMA journal_mode").fetchone()[0]

    assert mode.lower() == "wal"
    store.close()


def test_reopening_the_same_file_keeps_the_records(tmp_path: Path):
    db_path = tmp_path / "lineage.db"
    store = LineageStore(db_path)
    store.put_render(_payload("render-1"))
    store.close()

    reopened = LineageStore(db_path)
    fetched = reopened.get_render("render-1")

    assert fetched is not None
    assert fetched["render_id"] == "render-1"
    reopened.close()
