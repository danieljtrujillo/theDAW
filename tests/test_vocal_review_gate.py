"""The vocal review gate, from the service call down to the HTTP status.

``set_review``'s contract is "disk first, cache second": the in-process cache
is only allowed to hold a review that reached ``vocal_metadata.json``. Two ways
that promise was broken, both fixed here:

  * an asset whose audio file cannot be resolved has nowhere to write the
    document, and the old code skipped the write, cached the new review and
    answered ``ok: True`` -- exactly the "a gate that disappears at the next
    restart" the docstring forbids;
  * the router turned every ``ok: False`` into a 404, so a write that failed on
    this machine was reported to the UI as "no such artifact" -- a permanent
    answer for a temporary problem, and the retry that would have worked was
    never offered.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.vocal import router as vocal_router_module
from backend.modules.vocal import service


class _Art:
    """Just the shape ``set_review`` touches: a mutable review sub-object and a
    ``model_dump``."""

    def __init__(self) -> None:
        class R:
            reviewed = False
            notes = ""

        self.review = R()

    def model_dump(self) -> dict:
        return {
            "review": {"reviewed": self.review.reviewed, "notes": self.review.notes},
            "notes": [],
        }


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(vocal_router_module.router, prefix="/api/vocal")
    return TestClient(app, raise_server_exceptions=False)


def test_an_unresolvable_asset_saves_nothing_and_says_so(
    tmp_path: Path, monkeypatch
) -> None:
    """No audio path means no document to rewrite. Nothing may be cached and
    the answer may not be ``ok``, because the review would be forgotten at the
    next restart while the UI showed it as saved."""
    monkeypatch.setattr(service, "_artifact_obj", lambda _id: _Art())
    monkeypatch.setattr(service, "_resolve_path", lambda _id: None)
    monkeypatch.setattr(service, "_artifacts", {})

    res = service.set_review("a1", True, "good take")

    assert res["ok"] is False
    assert res["code"] == "write_failed"
    assert res["error"] == "no file to save the review next to"
    # Nothing cached: a cache the file does not back is the bug.
    assert service._artifacts == {}
    # And nothing written anywhere near the (empty) working directory.
    assert list(tmp_path.iterdir()) == []


def test_a_missing_artifact_is_a_404_and_a_failed_write_is_a_500(
    monkeypatch,
) -> None:
    """The status has to tell the UI whether retrying can ever help."""
    client = _client()

    # No artifact for the asset: the request named something that is not there.
    monkeypatch.setattr(service, "_artifact_obj", lambda _id: None)
    gone = client.post("/api/vocal/review/ghost", json={"reviewed": True, "notes": ""})
    assert gone.status_code == 404
    assert gone.json()["detail"] == "no artifact for asset"

    # The artifact exists but the review could not be persisted: this machine's
    # problem, not a wrong asset id, so it must not read as "not found".
    monkeypatch.setattr(service, "_artifact_obj", lambda _id: _Art())
    monkeypatch.setattr(service, "_resolve_path", lambda _id: None)
    monkeypatch.setattr(service, "_artifacts", {})
    broken = client.post("/api/vocal/review/a1", json={"reviewed": True, "notes": "x"})
    assert broken.status_code == 500
    assert broken.json()["detail"] == "no file to save the review next to"


def test_a_saved_review_is_ok_through_the_router(tmp_path: Path, monkeypatch) -> None:
    """The success path still answers with the stored review, so the two
    failures above are the only thing that changed."""
    audio = tmp_path / "song.wav"
    audio.write_bytes(b"RIFF....")
    monkeypatch.setattr(service, "_artifact_obj", lambda _id: _Art())
    monkeypatch.setattr(service, "_resolve_path", lambda _id: audio)
    monkeypatch.setattr(service, "_artifacts", {})

    res = _client().post("/api/vocal/review/a1", json={"reviewed": True, "notes": "ok"})

    assert res.status_code == 200
    assert res.json()["review"] == {"reviewed": True, "notes": "ok"}
    assert (tmp_path / "vocal_metadata.json").is_file()
