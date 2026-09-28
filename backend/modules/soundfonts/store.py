"""The user's sound banks on disk: one folder under the data root holding each
bank file and ``registry.json``, which lists them.

Each bank gets a bank-select OFFSET when it is added, and keeps it. The synths
load a bank at its offset (SpessaSynth ``addSoundBank(buffer, id, offset)``),
which moves every melodic preset of the bank from bank select ``b`` to
``offset + b``. The bundled General MIDI bank uses bank selects 0-26 and 120,
so user banks take offsets from USER_OFFSET_FIRST to USER_OFFSET_LAST, each a
range as wide as the banks it uses (``BankInfo.melodic_span``), none
overlapping another. A project stores a preset as its bank id, its bank inside
that file and its program; the offset turns that into the bank select a synth
and a MIDI file send.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import shutil
import threading
import time
from pathlib import Path
from typing import Any, BinaryIO

from backend.lib import known_paths, paths
from backend.lib.atomic import atomic_replace, atomic_write, temp_sibling

from .bankfile import SUPPORTED_FORMATS, BankFileError, read_bank

log = logging.getLogger(__name__)

__all__ = [
    "BankStoreError",
    "USER_OFFSET_FIRST",
    "USER_OFFSET_LAST",
    "add_bank",
    "allocate_offset",
    "bank_file",
    "list_banks",
    "remove_bank",
    "set_root_for_tests",
]

# The first and last bank select MSB a user bank may take: past the bundled
# bank's 0-26, below the XG drum and GM2 banks at 120-127.
USER_OFFSET_FIRST = 32
USER_OFFSET_LAST = 119

REGISTRY = "registry.json"
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,63}$")
_LOCK = threading.Lock()
_root_override: Path | None = None


class BankStoreError(ValueError):
    """A bank that cannot be added, with the reason to show the user."""


def set_root_for_tests(root: str | os.PathLike[str] | None) -> None:
    global _root_override
    _root_override = Path(root) if root is not None else None


def _root() -> Path:
    root = _root_override or paths.data_path("soundfonts")
    root.mkdir(parents=True, exist_ok=True)
    return root


def _load() -> list[dict[str, Any]]:
    path = _root() / REGISTRY
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as e:
        log.error("soundfonts: %s is unreadable (%s); listing no banks", path, e)
        return []
    banks = data.get("banks") if isinstance(data, dict) else None
    return [
        b
        for b in banks or []
        if isinstance(b, dict) and _ID_RE.match(str(b.get("id", "")))
    ]


def _save(banks: list[dict[str, Any]]) -> None:
    atomic_write(
        _root() / REGISTRY,
        json.dumps({"version": 1, "banks": banks}, indent=2).encode("utf-8"),
    )


def allocate_offset(span: int, taken: list[tuple[int, int]]) -> int:
    """The lowest offset from USER_OFFSET_FIRST whose range of ``span`` bank
    selects overlaps none of ``taken`` ((offset, span) pairs) and ends by
    USER_OFFSET_LAST. Raises BankStoreError when no range is free."""
    span = max(1, int(span))
    ranges = sorted((o, o + max(1, s)) for o, s in taken)
    start = USER_OFFSET_FIRST
    for lo, hi in ranges:
        if start + span <= lo:
            break
        start = max(start, hi)
    if start + span - 1 > USER_OFFSET_LAST:
        raise BankStoreError(
            "No bank select range is free for this bank: remove a sound bank first."
        )
    return start


def _format_of(name: str) -> str:
    ext = os.path.splitext(name)[1].lower().lstrip(".")
    if ext not in SUPPORTED_FORMATS:
        raise BankStoreError("A sound bank is an .sf2, .sf3 or .dls file.")
    return ext


def _public(entry: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in entry.items() if k != "file"}


def list_banks() -> list[dict[str, Any]]:
    """Every stored bank whose file is still there, in the order added, with
    its path."""
    root = _root()
    out = []
    for b in _load():
        f = root / str(b.get("file", ""))
        if f.is_file():
            out.append({**_public(b), "path": str(f)})
    return out


def bank_file(bank_id: str) -> Path | None:
    if not _ID_RE.match(bank_id or ""):
        return None
    for b in _load():
        if b.get("id") == bank_id:
            f = _root() / str(b.get("file", ""))
            return f if f.is_file() else None
    return None


def add_bank(
    src: BinaryIO, filename: str, source_path: str | None = None
) -> dict[str, Any]:
    """Copy the bank in ``src`` into the store, read its presets, give it an
    offset, list it, and remember its path (known_paths kind ``soundfont``).
    Returns the stored entry with its path."""
    fmt = _format_of(filename)
    root = _root()
    bank_id = f"sb-{secrets.token_hex(6)}"
    dest = root / f"{bank_id}.{fmt}"
    tmp = temp_sibling(dest)
    try:
        with tmp.open("wb") as out:
            shutil.copyfileobj(src, out, 1 << 20)
        with tmp.open("rb") as f:
            info = read_bank(f)
        with _LOCK:
            banks = _load()
            offset = allocate_offset(
                info.melodic_span,
                [(int(b.get("offset", 0)), int(b.get("span", 1))) for b in banks],
            )
            atomic_replace(tmp, dest)
            stem = os.path.splitext(os.path.basename(filename))[0]
            entry: dict[str, Any] = {
                "id": bank_id,
                "name": info.name or stem,
                "file_name": os.path.basename(filename),
                "file": dest.name,
                "format": fmt,
                "size": dest.stat().st_size,
                "offset": offset,
                "span": info.melodic_span,
                "added_at": time.time(),
                "presets": [p.as_dict() for p in info.presets],
            }
            if source_path:
                entry["source_path"] = source_path
            banks.append(entry)
            _save(banks)
    except BankFileError as e:
        raise BankStoreError(
            f"{os.path.basename(filename)} is not a sound bank theDAW can read: {e}"
        ) from e
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                log.debug("soundfonts: leftover temp file %s", tmp)
    # The app wrote this file, so it is remembered as installed: a Recent menu
    # for sound banks offers it, and it stays servable.
    known_paths.record(dest, "soundfont", source="install", update_folder=False)
    log.info("soundfonts: added %s as %s at offset %d", filename, bank_id, offset)
    return {**_public(entry), "path": str(dest)}


def remove_bank(bank_id: str) -> bool:
    """Take a bank off the list and delete its stored file. False when no bank
    has that id."""
    with _LOCK:
        banks = _load()
        keep = [b for b in banks if b.get("id") != bank_id]
        if len(keep) == len(banks):
            return False
        gone = [b for b in banks if b.get("id") == bank_id]
        _save(keep)
    for b in gone:
        f = _root() / str(b.get("file", ""))
        try:
            f.unlink(missing_ok=True)
        except OSError as e:
            log.warning("soundfonts: could not delete %s: %s", f, e)
    return True
