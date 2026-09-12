"""Where the backend is allowed to write.

Everything the app persists — settings, registries, caches, the library,
sidecar logs — lives under ONE root. That root is ``<project>/data`` in a dev
checkout and in a per-user install, which is where the tree has always been.

A packaged install can also land somewhere read-only. electron-builder.yml
sets ``allowToChangeInstallationDirectory``, so a user can install into
``C:/Program Files/theDAW``, and then nothing may be created beside the app:
the first ``/api/settings`` call answered 500 because ``SettingsStore`` tried
to ``mkdir <install>/data``. The desktop launcher probes the install directory
and, when it cannot write there, points ``theDAW_DATA_DIR`` at a per-user
directory (``getWritableRuntimeDir`` in ``electron-ui/main/index.ts``).

So: **never compose ``PROJECT_ROOT / "data"`` directly.** Go through
``data_path()`` / ``ensure_data_dir()`` and the whole tree relocates together.
Read-only assets that ship with the app (docs, ``frontend/dist``, sidecar
sources, bundled plugin assets) stay addressed from ``PROJECT_ROOT`` — those
are install-directory *reads*, which work everywhere.

The environment is read on every call, never cached, so a test that
monkeypatches ``theDAW_DATA_DIR`` takes effect without reimporting anything.
"""

from __future__ import annotations

import os
from pathlib import Path

__all__ = [
    "PROJECT_ROOT",
    "data_dir",
    "data_path",
    "ensure_data_dir",
    "is_relocated",
    "library_root",
    "rag_index_dir",
]

# backend/lib/paths.py -> parents[2] == the repo / install root.
PROJECT_ROOT = Path(__file__).resolve().parents[2]


def is_relocated() -> bool:
    """True when the writable data tree lives outside the install directory."""
    return bool(os.getenv("theDAW_DATA_DIR"))


def data_dir() -> Path:
    """Root of the writable data tree. ``theDAW_DATA_DIR`` wins."""
    configured = os.getenv("theDAW_DATA_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return PROJECT_ROOT / "data"


def data_path(*parts: str) -> Path:
    """``data_dir()`` joined with ``parts``. Does not create anything."""
    return data_dir().joinpath(*parts)


def ensure_data_dir(*parts: str) -> Path:
    """``data_path(*parts)``, created (with parents) if it does not exist."""
    d = data_path(*parts)
    d.mkdir(parents=True, exist_ok=True)
    return d


def library_root() -> Path:
    """The generations/library tree. ``theDAW_GENERATIONS_DIR`` wins — that is
    the user-facing knob for putting the audio library on another drive."""
    configured = os.getenv("theDAW_GENERATIONS_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return data_path("generations")


def rag_index_dir() -> Path:
    """The assistant's chroma index. Written at runtime (the index is rebuilt
    whenever the docs hash changes), so it follows the writable root when the
    install directory is read-only; otherwise it stays at its historical
    ``backend/rag_index`` so existing installs do not re-embed for nothing."""
    configured = os.getenv("theDAW_RAG_INDEX_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    if is_relocated():
        return data_path("rag_index")
    return PROJECT_ROOT / "backend" / "rag_index"
