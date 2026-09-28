"""The composer module's HTTP surface: it mounts, plans, checks and realizes
through FastAPI, refuses bad requests with a 422, and takes the same gates as
the project routes (no foreign page, and a LAN caller must be paired).

Pure music21 + numpy; no model, no GPU.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.lib import launch_token, pairing
from backend.modules.composer.router import router

Q = 960
MODULE_DIR = Path(__file__).resolve().parents[1] / "backend" / "modules" / "composer"


@pytest.fixture(autouse=True)
def _isolated_tokens(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pairing, "_TOKEN_FILE", tmp_path / "pairing_token.txt")
    monkeypatch.setattr(pairing, "_cached", None)
    monkeypatch.delenv(launch_token.ENV_VAR, raising=False)


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(router, prefix="/api/composer")
    return app


def _client() -> TestClient:
    """This machine's own UI: a loopback peer."""
    return TestClient(_app(), client=("127.0.0.1", 51000))


def test_the_module_json_mounts_the_router_at_its_prefix() -> None:
    config = json.loads((MODULE_DIR / "module.json").read_text(encoding="utf-8"))
    assert config["name"] == "composer" and config["enabled"] is True
    assert config["api_prefix"] == "/api/composer"
    body = _client().get("/api/composer/").json()
    assert body["module"] == "composer" and body["ppq"] == Q
    assert "phrygian_half" in body["cadences"] and "german" in body["include"]
    assert body["ranges"]["soprano"] == [60, 79]


def test_mounting_the_router_leaves_music21_unloaded() -> None:
    # The loader imports every router at startup; music21 waits for a request.
    code = (
        "import sys, backend.modules.composer.router; print('music21' in sys.modules)"
    )
    out = subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(MODULE_DIR.parents[2]),
        env={**os.environ, "PYTHONPATH": str(MODULE_DIR.parents[2])},
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "False"


def test_plan_answers_with_chords_parts_and_no_flags() -> None:
    r = _client().post(
        "/api/composer/plan",
        json={
            "key": "F#",
            "mode": "minor",
            "bars": 6,
            "seed": 2,
            "include": ["neapolitan", "applied"],
            "meter_map": [
                {"bar": 0, "meter": {"num": 7, "den": 8, "groups": [2, 2, 3]}}
            ],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["key"] == "F# minor"
    assert body["flags"] == []
    assert body["chords"][-1]["figure"] == "i"
    assert {"N6", "V7/V"} <= {c["figure"] for c in body["chords"]}
    assert [c["tick"] for c in body["chords"] if c["bar"] == 0] == [0, 960, 1920]
    for part in ("soprano", "alto", "tenor", "bass"):
        notes = body["parts"][part]
        assert len(notes) == len(body["chords"])
        assert set(notes[0]) == {"note", "tick", "ticks", "velocity"}


def test_plan_refuses_what_it_cannot_write() -> None:
    c = _client()
    too_short = c.post(
        "/api/composer/plan",
        json={"bars": 2, "harmonic_rhythm": "bar", "include": ["german", "french"]},
    )
    assert too_short.status_code == 422
    assert "needs" in too_short.json()["detail"]
    far = c.post("/api/composer/plan", json={"key": "C", "modulate_to": "F#"})
    assert far.status_code == 422
    bad_kind = c.post("/api/composer/plan", json={"include": ["tristan"]})
    assert bad_kind.status_code == 422
    bad_key = c.post("/api/composer/plan", json={"key": "H"})
    assert bad_key.status_code == 422


def test_check_flags_parallel_fifths_with_bar_and_beat() -> None:
    def part(pitches: list[int]) -> list[dict]:
        return [{"note": p, "tick": i * Q, "ticks": Q} for i, p in enumerate(pitches)]

    r = _client().post(
        "/api/composer/check",
        json={
            "key": "C",
            "parts": {
                "soprano": part([67, 69]),
                "alto": part([64, 65]),
                "tenor": part([60, 62]),
                "bass": part([48, 53]),
            },
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] == 1
    assert body["flags"][0] == {
        "bar": 0,
        "beat": 2,
        "tick": Q,
        "parts": ["soprano", "tenor"],
        "rule": "parallel_fifths",
        "message": body["flags"][0]["message"],
    }


def test_check_takes_named_chords_and_part_ranges() -> None:
    notes = [{"note": 84, "tick": 0, "ticks": Q}]
    r = _client().post(
        "/api/composer/check",
        json={
            "parts": {"flute": notes, "cello": [{"note": 48, "tick": 0, "ticks": Q}]},
            "chords": [{"tick": 0, "figure": "I", "key": "C"}],
            "ranges": {"flute": [60, 96], "cello": [36, 76]},
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["flags"] == []
    empty = _client().post("/api/composer/check", json={"parts": {}})
    assert empty.status_code == 422


def test_continuo_realizes_four_parts() -> None:
    bass = [
        {"note": 48, "tick": 0, "ticks": Q, "figure": "5"},
        {"note": 53, "tick": Q, "ticks": Q, "figure": "6"},
        {"note": 55, "tick": 2 * Q, "ticks": Q, "figure": "6/4"},
        {"note": 55, "tick": 3 * Q, "ticks": Q, "figure": "7"},
        {"note": 48, "tick": 4 * Q, "ticks": 2 * Q, "figure": ""},
    ]
    r = _client().post("/api/composer/continuo", json={"key": "C", "bass": bass})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["flags"] == []
    assert set(body["parts"]) == {"soprano", "alto", "tenor", "bass"}
    assert [c["roman"] for c in body["chords"]] == ["I", "ii6", "I64", "V7", "I"]
    bad = _client().post(
        "/api/composer/continuo",
        json={
            "key": "C",
            "bass": [{"note": 48, "tick": 0, "ticks": Q, "figure": "6x"}],
        },
    )
    assert bad.status_code == 422


def test_a_foreign_page_and_an_unpaired_lan_caller_are_refused() -> None:
    body = {"key": "C", "bars": 2}
    foreign = _client().post(
        "/api/composer/plan",
        json=body,
        headers={"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"},
    )
    assert foreign.status_code == 403
    lan = TestClient(_app(), client=("10.20.30.40", 51000))
    assert lan.post("/api/composer/plan", json=body).status_code == 403
    token = pairing.get_token()
    paired = lan.post("/api/composer/plan", json=body, headers={pairing.HEADER: token})
    assert paired.status_code == 200, paired.text
