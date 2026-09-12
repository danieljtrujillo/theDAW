"""The backend's writable data tree must follow ``theDAW_DATA_DIR``.

A packaged install can land in ``C:/Program Files/theDAW``, where nothing may
be created beside the app. The desktop launcher then points ``theDAW_DATA_DIR``
at a per-user directory — which only works if EVERY writer resolves through
``backend.lib.paths``. The last regression here shipped with the library
relocated and ``settings.json`` still pointed at the install directory, so the
first ``/api/settings`` call answered 500; the source sweep below is what
catches that class of miss.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

from backend.lib import paths

REPO_ROOT = Path(__file__).resolve().parents[1]


def test_data_dir_defaults_to_the_project(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("theDAW_DATA_DIR", raising=False)
    assert paths.data_dir() == paths.PROJECT_ROOT / "data"
    assert not paths.is_relocated()


def test_env_moves_the_whole_tree(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("theDAW_DATA_DIR", str(tmp_path / "runtime-data"))
    monkeypatch.delenv("theDAW_GENERATIONS_DIR", raising=False)
    monkeypatch.delenv("theDAW_SETTINGS_PATH", raising=False)
    monkeypatch.delenv("theDAW_RAG_INDEX_DIR", raising=False)

    root = (tmp_path / "runtime-data").resolve()
    assert paths.is_relocated()
    assert paths.data_dir() == root
    assert paths.data_path("settings.json") == root / "settings.json"
    assert paths.library_root() == root / "generations"
    # The chroma index is written at runtime, so it moves too.
    assert paths.rag_index_dir() == root / "rag_index"

    from backend.modules.library.store import default_library_root
    from backend.modules.settings.store import default_settings_path

    assert default_settings_path() == root / "settings.json"
    assert default_library_root() == root / "generations"


def test_generations_override_still_wins(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The user-facing 'put my library on another drive' knob outranks the
    relocation, and moves the library only."""
    monkeypatch.setenv("theDAW_DATA_DIR", str(tmp_path / "runtime-data"))
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path / "D-drive"))
    assert paths.library_root() == (tmp_path / "D-drive").resolve()
    assert (
        paths.data_path("settings.json")
        == (tmp_path / "runtime-data").resolve() / "settings.json"
    )


def test_settings_store_writes_into_the_relocated_tree(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The exact first-launch sequence a Program Files install runs: nothing
    exists yet, and the store has to create its own directory."""
    monkeypatch.setenv("theDAW_DATA_DIR", str(tmp_path / "runtime-data"))
    monkeypatch.delenv("theDAW_SETTINGS_PATH", raising=False)

    from backend.modules.settings.store import SettingsStore, default_settings_path

    store = SettingsStore(default_settings_path())
    assert store.path.is_file()
    assert store.path.parent == (tmp_path / "runtime-data").resolve()
    assert store.get_all()["schema_version"] >= 1


# Every writable location in the backend has to come from backend.lib.paths.
# A bare `<root> / "data"` is the bug this whole module exists to prevent.
_BARE_DATA = re.compile(
    r"(PROJECT_ROOT|_REPO_ROOT|project_root|repo_root)\s*/\s*\"data\""
)

# media_access deliberately keeps the in-install data dir as a READ root so
# content that shipped with the app still resolves; paths.py owns the default.
_ALLOWED = {
    Path("backend/lib/paths.py"),
    Path("backend/modules/project/media_access.py"),
}


def test_no_module_composes_its_own_data_dir() -> None:
    tracked = subprocess.run(
        ["git", "ls-files", "backend"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    offenders: list[str] = []
    for rel in tracked:
        if not rel.endswith(".py") or Path(rel) in _ALLOWED:
            continue
        text = (REPO_ROOT / rel).read_text(encoding="utf-8", errors="replace")
        for i, line in enumerate(text.splitlines(), 1):
            if _BARE_DATA.search(line):
                offenders.append(f"{rel}:{i}: {line.strip()}")
    assert not offenders, (
        "these write outside backend.lib.paths and break a read-only install:\n"
        + "\n".join(offenders)
    )


def test_paths_module_has_no_heavy_imports() -> None:
    """It is imported by every module in the backend, including ones that load
    before the app does; keep it to the standard library."""
    proc = subprocess.run(
        [sys.executable, "-c", "import backend.lib.paths"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr
