"""The assistant's RAG index is written outside every checkout during a test run.

backend.rag resolves ``RAG_INDEX_DIR`` when it is imported, from
``theDAW_RAG_INDEX_DIR`` when the shell names one and otherwise from the data
root. tests/conftest.py names all three roots in ``pytest_configure``, so a
root a shell exported for the live app is replaced before any test module
imports backend.rag.
"""

from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace

from backend.lib import paths


def test_the_rag_index_resolved_at_import_is_outside_the_checkout():
    from backend import rag

    index = Path(rag.RAG_INDEX_DIR).resolve()
    assert not index.is_relative_to(paths.PROJECT_ROOT), index
    assert not paths.rag_index_dir().is_relative_to(paths.PROJECT_ROOT)


def test_a_rag_index_root_the_shell_names_is_replaced(monkeypatch):
    from tests.conftest import pytest_configure

    live = str(paths.PROJECT_ROOT / "backend" / "rag_index")
    monkeypatch.setenv("theDAW_RAG_INDEX_DIR", live)
    monkeypatch.setenv("theDAW_DATA_DIR", os.environ["theDAW_DATA_DIR"])
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", os.environ["theDAW_GENERATIONS_DIR"])
    config = SimpleNamespace()
    pytest_configure(config)
    root = Path(os.environ["theDAW_RAG_INDEX_DIR"])
    assert not root.is_relative_to(paths.PROJECT_ROOT), root
    assert root.is_relative_to(config.thedaw_data_root), root
