"""The rhythm module's HTTP surface, against a synthetic two-meter file.

The engine's own tests (test_rhythm_engine.py) prove the analysis; this proves
the module mounts, answers, and hands the analysis through: a health report, a
file analysis that reads the two meters in order, a 404 for a missing file, and
a 200 ``pending`` for an entry nothing has analyzed — the Details panel polls
that, and a 404 there paints the Network tab red for a normal state.
"""

from __future__ import annotations

from pathlib import Path

import soundfile as sf
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.rhythm.engine import RHYTHM_VERSION
from backend.modules.rhythm.router import router
from tests.rhythm_synth import MeterSegment, meter_track


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api/rhythm")
    return TestClient(app)


def test_health_names_the_engine_version_and_features():
    body = _client().get("/api/rhythm/").json()
    assert body["module"] == "rhythm"
    assert body["version"] == RHYTHM_VERSION
    assert "meter_map" in body["features"] and "polymeter" in body["features"]


def test_a_file_comes_back_with_its_meter_map(tmp_path: Path):
    y, _ = meter_track([MeterSegment(120.0, 4, 8), MeterSegment(120.0, 7, 8)], sr=22050)
    wav = tmp_path / "two-meters.wav"
    sf.write(str(wav), y, 22050)
    r = _client().post("/api/rhythm/file", json={"path": str(wav)})
    assert r.status_code == 200, r.text
    body = r.json()
    assert [m["beats_per_bar"] for m in body["meter_map"]] == [4, 7]
    assert body["source"] == wav.name
    assert body["elapsed_sec"] >= 0
    assert body["summary"].startswith("Meter:")


def test_a_missing_file_is_a_404_and_an_unanalyzed_entry_is_pending():
    c = _client()
    assert (
        c.post("/api/rhythm/file", json={"path": "Z:/nowhere/none.wav"}).status_code
        == 404
    )
    body = c.get("/api/rhythm/not-an-entry").json()
    assert body == {"entry_id": "not-an-entry", "status": "pending"}
