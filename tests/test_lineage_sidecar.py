"""Unit tests for backend.modules.lineage.sidecar.

Every test builds its own throwaway library root under ``tmp_path`` — the
sidecar writer must never touch anything outside the one entry folder it is
told about, so these tests assert that boundary directly rather than trusting
it.
"""

from __future__ import annotations

import json
from pathlib import Path

from backend.modules.lineage.sidecar import (
    SIDECAR_FILENAME,
    entry_folder,
    read_sidecar,
    write_sidecar,
)


def _make_entry(root: Path, entry_id: str) -> Path:
    """Create ``<root>/<entry_id>`` the way the library store would."""
    folder = root / entry_id
    folder.mkdir(parents=True)
    return folder


def test_write_sidecar_creates_lineage_json_in_the_entry_folder(tmp_path: Path):
    root = tmp_path / "library"
    folder = _make_entry(root, "entry-1")
    record = {"source": "generate", "model": "medium", "seed": 42}

    result = write_sidecar(root, "entry-1", record)

    assert result == folder / SIDECAR_FILENAME
    written = json.loads((folder / SIDECAR_FILENAME).read_text(encoding="utf-8"))
    assert written == record


def test_write_sidecar_replaces_an_existing_file_and_leaves_no_tmp_files(
    tmp_path: Path,
):
    root = tmp_path / "library"
    folder = _make_entry(root, "entry-1")
    (folder / SIDECAR_FILENAME).write_text(
        json.dumps({"stale": True}), encoding="utf-8"
    )

    result = write_sidecar(root, "entry-1", {"stale": False, "seed": 7})

    assert result == folder / SIDECAR_FILENAME
    written = json.loads((folder / SIDECAR_FILENAME).read_text(encoding="utf-8"))
    assert written == {"stale": False, "seed": 7}
    assert list(folder.glob(".lineage-*")) == []


def test_write_sidecar_returns_none_when_the_entry_folder_does_not_exist(
    tmp_path: Path,
):
    root = tmp_path / "library"
    root.mkdir()

    result = write_sidecar(root, "never-created", {"seed": 1})

    assert result is None
    assert not (root / "never-created").exists()


def test_entry_id_with_dotdot_or_separator_escapes_nothing(tmp_path: Path):
    root = tmp_path / "library"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()

    escaping_ids = [
        "../evil",
        "a/b",
        str(outside / "evil"),
    ]
    for entry_id in escaping_ids:
        assert entry_folder(root, entry_id) is None, entry_id
        assert write_sidecar(root, entry_id, {"x": 1}) is None, entry_id

    # Nothing was created anywhere in the tmp tree — not the sidecar file,
    # not a stray entry folder, not anything under "outside".
    assert list(tmp_path.rglob(SIDECAR_FILENAME)) == []
    assert list(outside.iterdir()) == []
    assert not (tmp_path / "evil").exists()


def test_read_sidecar_roundtrips_the_record(tmp_path: Path):
    root = tmp_path / "library"
    _make_entry(root, "entry-1")
    record = {"prompt": "a slow arpeggio", "duration": 12.5, "tags": ["ambient"]}
    assert write_sidecar(root, "entry-1", record) is not None

    assert read_sidecar(root, "entry-1") == record


def test_read_sidecar_returns_none_for_corrupt_json(tmp_path: Path):
    root = tmp_path / "library"
    folder = _make_entry(root, "entry-1")
    (folder / SIDECAR_FILENAME).write_text("{not json", encoding="utf-8")

    assert read_sidecar(root, "entry-1") is None


def test_read_sidecar_returns_none_for_invalid_utf8(tmp_path: Path):
    root = tmp_path / "library"
    folder = _make_entry(root, "entry-1")
    # A byte sequence that is not valid UTF-8 (a stray UTF-16 BOM followed by
    # otherwise-valid-looking JSON text). ``read_text(encoding="utf-8")``
    # raises ``UnicodeDecodeError`` here, which is a ``ValueError`` subclass,
    # not an ``OSError`` — read_sidecar must catch it and return None rather
    # than let it propagate.
    (folder / SIDECAR_FILENAME).write_bytes(b'\xff\xfe{"a": 1}')

    assert read_sidecar(root, "entry-1") is None
