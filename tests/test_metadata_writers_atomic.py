"""Every writer of an entry-adjacent metadata document goes through
``backend.lib.atomic.atomic_write``: a reader sees the old file or the new one,
and a failed write leaves neither a torn document nor a stray temp file.

Two writers had been left on a bare ``write_text``: the generation-artifact
saver in ``backend/server.py`` and the vocal review gate in
``backend/modules/vocal/service.py``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend import server
from backend.lib import atomic


def _boom(*_a, **_k):  # noqa: ANN001
    raise OSError("simulated disk failure at replace")


def test_generation_artifacts_metadata_is_written_atomically(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(server, "_get_generation_artifacts_root", lambda: tmp_path)
    out = server._save_generation_artifacts_sync(
        "job1", 0, b"RIFF....", "take.wav", "audio/wav", {}, {"title": "t"}
    )
    item_dir = Path(out["artifact_dir"])
    meta = json.loads((item_dir / "metadata.json").read_text(encoding="utf-8"))
    assert meta["title"] == "t" and meta["job_id"] == "job1"
    # No temp sibling survives a successful write.
    assert [p.name for p in item_dir.iterdir() if p.name.endswith(".tmp")] == []

    # A failure at the rename leaves the previous document intact and no temp file.
    monkeypatch.setattr(atomic, "atomic_replace", _boom)
    with pytest.raises(OSError):
        server._save_generation_artifacts_sync(
            "job1", 0, b"RIFF....", "take.wav", "audio/wav", {}, {"title": "CHANGED"}
        )
    again = json.loads((item_dir / "metadata.json").read_text(encoding="utf-8"))
    assert again["title"] == "t", "the old document must survive a failed write"
    assert [p.name for p in item_dir.iterdir() if p.name.endswith(".tmp")] == []


def test_vocal_review_gate_is_written_atomically(tmp_path: Path, monkeypatch) -> None:
    from backend.modules.vocal import service

    audio = tmp_path / "song.wav"
    audio.write_bytes(b"RIFF....")
    payload = {
        "review": {"reviewed": False, "notes": ""},
        "notes": [],
    }

    class _Art:
        def __init__(self) -> None:
            class R:  # the review sub-object set_review mutates
                reviewed = False
                notes = ""

            self.review = R()

        def model_dump(self) -> dict:
            return {
                "review": {
                    "reviewed": self.review.reviewed,
                    "notes": self.review.notes,
                },
                "notes": [],
            }

    monkeypatch.setattr(service, "_artifact_obj", lambda _id: _Art())
    monkeypatch.setattr(service, "_resolve_path", lambda _id: audio)
    monkeypatch.setitem(service._artifacts, "a1", payload)

    res = service.set_review("a1", True, "good take")
    assert res["ok"] is True
    doc = json.loads((tmp_path / "vocal_metadata.json").read_text(encoding="utf-8"))
    assert doc["review"] == {"reviewed": True, "notes": "good take"}
    assert [p.name for p in tmp_path.iterdir() if p.name.endswith(".tmp")] == []

    # A persistence failure is REPORTED, not swallowed into an ok: the document
    # on disk is still the last good one, so the in-process cache must be too.
    # Answering ok here told the user their click was saved while disk held the
    # old review flag, and the next restart forgot it.
    monkeypatch.setattr(atomic, "atomic_replace", _boom)
    res2 = service.set_review("a1", False, "changed my mind")
    assert res2["ok"] is False
    assert res2["code"] == "write_failed", "the route maps this code to 500"
    assert "could not save the review" in res2["error"]
    doc2 = json.loads((tmp_path / "vocal_metadata.json").read_text(encoding="utf-8"))
    assert doc2["review"] == {"reviewed": True, "notes": "good take"}
    assert [p.name for p in tmp_path.iterdir() if p.name.endswith(".tmp")] == []
    # The cache still holds the last payload that reached disk.
    assert service._artifacts["a1"]["review"] == {
        "reviewed": True,
        "notes": "good take",
    }
