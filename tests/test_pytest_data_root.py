"""Tests never write into a checkout's data/.

backend.lib.paths puts every backend write under ``theDAW_DATA_DIR`` (default
``<checkout>/data``) and the library under ``theDAW_GENERATIONS_DIR``, and a
few modules resolve a path when they are imported. tests/conftest.py points
both variables at a new directory in the system temp folder before collection.
Without that, a broad run wrote known_paths.json, logs, settings and VST preset
files into the checkout's data/, which in the live app's tree is the user's own.
"""

from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace

from backend.lib import paths


def test_the_data_root_is_outside_the_checkout():
    assert paths.is_relocated()
    assert not paths.data_dir().is_relative_to(paths.PROJECT_ROOT), paths.data_dir()
    assert not paths.library_root().is_relative_to(paths.PROJECT_ROOT), (
        paths.library_root()
    )


def test_a_path_resolved_at_import_is_outside_the_checkout():
    from backend.modules.vst import router

    preset_dir = Path(router._PRESET_DIR).resolve()
    assert not preset_dir.is_relative_to(paths.PROJECT_ROOT), preset_dir


def test_a_root_the_shell_names_is_replaced(monkeypatch):
    """A launcher may export the live app's data directory; the session must
    not write there, so the hook replaces whatever the shell named."""
    from tests.conftest import pytest_configure

    live = str(paths.PROJECT_ROOT / "data")
    monkeypatch.setenv("theDAW_DATA_DIR", live)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(Path(live) / "generations"))
    config = SimpleNamespace()
    pytest_configure(config)
    for name in ("theDAW_DATA_DIR", "theDAW_GENERATIONS_DIR"):
        root = Path(os.environ[name])
        assert not root.is_relative_to(paths.PROJECT_ROOT), (name, root)
        assert root.is_relative_to(config.thedaw_data_root), (name, root)
