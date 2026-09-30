"""Per-entry ``lineage.json`` sidecar: the same provenance record dropped
next to the audio it describes.

The library's SQLite row is the primary record. This module writes a copy
into the entry's own folder, ``<library_root>/<entry_id>/lineage.json``, so
the provenance survives even if the database is ever lost or rebuilt.

The record is written verbatim — whatever ``backend.modules.lineage.records``
already normalised — so it is never re-validated here, and it never contains
a hash of itself (a self-referential hash cannot be computed before the
record that would contain it is finalised). Every write is confined to the
entry's own folder: nothing outside ``<root>/<entry_id>/`` is ever read,
written, or deleted, and the entry folder itself is never created here — the
library owns that.

Stdlib only, no project imports, so this module can be exercised standalone.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path

log = logging.getLogger(__name__)

#: The sidecar's fixed filename inside each entry folder.
SIDECAR_FILENAME = "lineage.json"


def entry_folder(root: Path, entry_id: str) -> Path | None:
    """Resolve ``<root>/<entry_id>``, the layout ``store.py``'s ``entry_dir``
    uses.

    Returns ``None`` — never raises — for a falsy id, one containing a path
    separator (an entry id is always a single path component, never a nested
    path), a ``..`` that walks out of ``root``, an absolute id, or anything
    else whose resolved path is not a direct child of the resolved root.
    """
    if not entry_id:
        return None
    try:
        base = root.resolve()
        candidate = (root / entry_id).resolve()
    except (OSError, ValueError):
        return None
    if not candidate.is_relative_to(base) or candidate.parent != base:
        return None
    return candidate


def write_sidecar(root: Path, entry_id: str, record: dict) -> Path | None:
    """Atomically write ``record`` as ``<root>/<entry_id>/lineage.json``.

    ``record`` is written verbatim: the caller has already normalised it, so
    this never validates or mutates it.

    Returns ``None`` without writing anything when ``entry_id`` is falsy,
    ``entry_folder`` refuses it, or the entry folder does not already exist
    (this never creates one — the library owns that). On any ``OSError``
    during the write, the temp file is removed if present, a warning is
    logged, and ``None`` is returned: a failed sidecar must never fail a
    render.
    """
    if not entry_id:
        return None
    folder = entry_folder(root, entry_id)
    if folder is None or not folder.is_dir():
        return None

    dest = folder / SIDECAR_FILENAME
    payload = json.dumps(record, ensure_ascii=False, indent=2).encode("utf-8")

    tmp_name: str | None = None
    try:
        fd, tmp_name = tempfile.mkstemp(dir=folder, prefix=".lineage-", suffix=".tmp")
        # fdopen takes ownership of fd and closes it exactly once on block
        # exit, so a later failure can't double-close or probe a closed
        # descriptor.
        with os.fdopen(fd, "wb") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_name, dest)
    except OSError:
        if tmp_name is not None:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
        log.warning("lineage: could not write %s", dest)
        return None
    return dest


def read_sidecar(root: Path, entry_id: str) -> dict | None:
    """Read back the ``lineage.json`` written by ``write_sidecar``.

    For tests and a future recovery path (rebuilding library rows from the
    sidecars on disk). Returns ``None`` — never raises — when the id escapes
    the root, the folder or file is missing, the file is not valid UTF-8, or
    the bytes are not valid JSON encoding a JSON object. ``UnicodeDecodeError``
    and ``json.JSONDecodeError`` are both ``ValueError`` subclasses (not
    ``OSError``), so a single handler covers the missing/unreadable file and
    the two "wrong contents" cases alike.
    """
    folder = entry_folder(root, entry_id)
    if folder is None:
        return None
    try:
        raw = (folder / SIDECAR_FILENAME).read_text(encoding="utf-8")
        record = json.loads(raw)
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) else None
