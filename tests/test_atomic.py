"""The two concurrency hazards backend/lib/atomic.py exists to close.

Both of these fail intermittently rather than reliably, so each one hammers
the race hard enough that a regression shows up on an ordinary test run
instead of once a fortnight in CI. The cover-art writer hit the destination
one at roughly one run in six on Windows before the retry landed.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest

from backend.lib.atomic import atomic_replace, atomic_write, temp_sibling

# Enough passes to make a microsecond-wide window land. On a machine where
# the race is closed this is still well under a second.
ROUNDS = 40
WRITERS = 4


def test_atomic_write_lands_the_payload(tmp_path: Path):
    dest = tmp_path / "note.json"
    atomic_write(dest, json.dumps({"a": 1}))
    assert json.loads(dest.read_text(encoding="utf-8")) == {"a": 1}


def test_atomic_write_takes_bytes_too(tmp_path: Path):
    dest = tmp_path / "blob.bin"
    atomic_write(dest, b"\x00\x01\x02")
    assert dest.read_bytes() == b"\x00\x01\x02"


def test_atomic_write_creates_the_parent_directory(tmp_path: Path):
    dest = tmp_path / "deep" / "deeper" / "note.txt"
    atomic_write(dest, "hi")
    assert dest.read_text(encoding="utf-8") == "hi"


def test_atomic_write_leaves_the_old_file_when_the_write_fails(tmp_path: Path):
    dest = tmp_path / "note.txt"
    atomic_write(dest, "original")
    with pytest.raises(TypeError):
        atomic_write(dest, {"not": "a payload"})  # type: ignore[arg-type]
    assert dest.read_text(encoding="utf-8") == "original"
    assert [p.name for p in tmp_path.iterdir()] == ["note.txt"], "temp file left behind"


def test_two_calls_never_pick_the_same_temp_name(tmp_path: Path):
    dest = tmp_path / "cover.jpg"
    names = {temp_sibling(dest).name for _ in range(500)}
    assert len(names) == 500


def test_concurrent_replaces_onto_one_destination_all_land(tmp_path: Path):
    """Windows fails MoveFileEx with WinError 5 while another thread's rename
    holds the destination. Unretried, the loser's write is silently dropped."""
    dest = tmp_path / "contended.txt"
    errors: list[Exception] = []

    def run(tag: str) -> None:
        for i in range(ROUNDS):
            tmp = temp_sibling(dest)
            try:
                tmp.write_text(f"{tag}-{i}", encoding="utf-8")
                atomic_replace(tmp, dest)
            except Exception as e:  # noqa: BLE001 — the point is that none escape
                errors.append(e)
                tmp.unlink(missing_ok=True)

    threads = [threading.Thread(target=run, args=(f"w{n}",)) for n in range(WRITERS)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, errors
    assert dest.is_file()
    assert [p.name for p in tmp_path.iterdir()] == ["contended.txt"], "temp file leaked"


def test_concurrent_atomic_writes_leave_one_whole_file(tmp_path: Path):
    """The shared-temp-name hazard: a per-call scratch name is what stops one
    writer's payload landing inside another's."""
    dest = tmp_path / "doc.json"
    payloads = {
        f"w{n}": json.dumps({"writer": n, "body": "x" * 4096}) for n in range(WRITERS)
    }
    errors: list[Exception] = []

    def run(tag: str) -> None:
        for _ in range(ROUNDS):
            try:
                atomic_write(dest, payloads[tag])
            except Exception as e:  # noqa: BLE001
                errors.append(e)

    threads = [threading.Thread(target=run, args=(tag,)) for tag in payloads]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, errors
    # Whichever writer won, the file is exactly one of them and not a splice.
    assert dest.read_text(encoding="utf-8") in payloads.values()
    assert [p.name for p in tmp_path.iterdir()] == ["doc.json"], "temp file leaked"
