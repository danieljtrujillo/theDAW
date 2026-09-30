"""ORCHESTRATE: a two-part sketch written for each ensemble keeps every note
inside its instrument's sounding range, gives every instrument of the
ensemble a part, keeps the melody in Violin I and the bass in the cellos,
answers the same for the same input, and the route mounts with its checks.

Pure computation; no model, no GPU.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.lib import launch_token, pairing
from backend.modules.composer.orchestrate import (
    ENSEMBLES,
    OrchestrateError,
    ensemble_instruments,
    fit,
    orchestrate,
)
from backend.modules.composer.router import router
from backend.modules.notation.instruments import by_id

Q = 960
BAR = 4 * Q


def _line(steps: list[tuple[int, int, int]]) -> list[dict[str, int]]:
    out, t = [], 0
    for pitch, ticks, velocity in steps:
        out.append({"note": pitch, "tick": t, "ticks": ticks, "velocity": velocity})
        t += ticks
    return out


# Eight bars in C: a rising phrase that peaks at forte, then a soft fall.
MELODY = _line(
    [
        (67, Q, 78), (69, Q, 80), (71, Q, 82), (72, Q, 84),
        (74, 2 * Q, 90), (72, Q, 100), (71, Q, 104),
        (69, 4 * Q, 110),
        (67, Q, 60), (65, Q, 60), (64, 2 * Q, 50),
        (62, 4 * Q, 48),
        (60, 4 * Q, 44),
        (64, 2 * Q, 40), (62, 2 * Q, 40),
        (60, 4 * Q, 36),
    ]
)  # fmt: skip
BASS = _line(
    [
        (p, 2 * Q, 80)
        for p in (48, 53, 55, 48, 53, 55, 48, 43, 45, 41, 43, 43, 48, 48, 43, 48)
    ]
)
SKETCH = [
    {"id": "m", "name": "Melody", "notes": MELODY},
    {"id": "b", "name": "Bass", "notes": BASS},
]
HARMONY = [
    {"tick": 0, "figure": "I", "key": "C"},
    {"tick": BAR, "figure": "IV", "key": "C"},
    {"tick": 2 * BAR, "figure": "V7", "key": "C"},
    {"tick": 3 * BAR, "figure": "I", "key": "C"},
    {"tick": 4 * BAR, "figure": "vi", "key": "C"},
    {"tick": 5 * BAR, "figure": "ii6", "key": "C"},
    {"tick": 6 * BAR, "figure": "V", "key": "C"},
    {"tick": 7 * BAR, "figure": "I", "key": "C"},
]
MARKERS = [{"tick": 0, "name": "A"}, {"tick": 3 * BAR, "name": "B"}]


def _run(**opts):
    args = dict(
        key="C", harmony=HARMONY, markers=MARKERS, ensemble="classical", density=0.6
    )
    args.update(opts)
    return orchestrate(SKETCH, **args)


@pytest.mark.parametrize("ensemble", sorted(ENSEMBLES))
@pytest.mark.parametrize(
    "texture", ["tutti", "melody_accompaniment", "chorale", "call_answer"]
)
def test_every_instrument_has_a_part_inside_its_range(
    ensemble: str, texture: str
) -> None:
    r = _run(ensemble=ensemble, texture=texture, density=1.0)
    names = [p["name"] for p in r["parts"]]
    assert names == [p["name"] for p in ensemble_instruments(ensemble)]
    for part in r["parts"]:
        inst = by_id(part["instrument_id"])
        assert inst is not None
        assert part["notes"], f"{part['name']} has no notes at density 1"
        for n in part["notes"]:
            assert inst.range_low <= n["note"] <= inst.range_high, (part["name"], n)
            assert 1 <= n["velocity"] <= 127
        for c in part["controls"]:
            assert c["controller"] == 1 and 0 <= c["value"] <= 127
        if inst.percussion:
            assert part["controls"] == []
        else:
            assert part["controls"], f"{part['name']} has no CC 1 swell"


def test_the_melody_stays_in_violin_i_and_the_bass_in_the_cellos() -> None:
    r = _run(texture="tutti")
    by_name = {p["name"]: p for p in r["parts"]}
    lead = [(n["note"], n["tick"], n["ticks"]) for n in by_name["Violin I"]["notes"]]
    assert lead == [(n["note"], n["tick"], n["ticks"]) for n in MELODY]
    cello = [(n["note"], n["tick"], n["ticks"]) for n in by_name["Cello"]["notes"]]
    assert cello == [(n["note"], n["tick"], n["ticks"]) for n in BASS]
    # The contrabasses an octave down, moved back inside their range.
    basses = by_name["Contrabass"]["notes"]
    assert [n["note"] for n in basses] == [fit(n["note"] - 12, 28, 67) for n in BASS]
    assert all(n["note"] <= b["note"] for n, b in zip(basses, BASS))


def test_dynamics_doubling_and_articulations_follow_the_sections() -> None:
    r = _run(texture="tutti", density=0.6)
    a, b = r["sections"]
    assert (a["dynamic"], a["climax"]) == ("f", True)
    assert (b["dynamic"], b["climax"]) == ("p", False)
    by_name = {p["name"]: p for p in r["parts"]}
    # The flute doubles the climax at the octave above at density > 0.5 ...
    flute_a = [n for n in by_name["Flute I"]["notes"] if n["tick"] < 3 * BAR]
    assert [n["note"] for n in flute_a] == [
        n["note"] + 12 for n in MELODY if n["tick"] < 3 * BAR
    ]
    # ... the trumpet takes it on the climax and rests in the soft section.
    trumpet = by_name["Trumpet I"]["notes"]
    assert trumpet and all(n["tick"] < 3 * BAR for n in trumpet)
    # Every note carries the section's dynamic.
    assert all(n["velocity"] == a["velocity"] for n in flute_a)
    assert all(
        n["velocity"] == b["velocity"]
        for n in by_name["Violin I"]["notes"]
        if n["tick"] >= 3 * BAR
    )
    # Sustained lines are legato; the timpani sit on I and V downbeats only.
    assert all(n["articulation"] == "legato" for n in by_name["Viola"]["notes"])
    timpani = by_name["Timpani"]["notes"]
    assert timpani and {n["tick"] for n in timpani} <= {0, 3 * BAR, 7 * BAR}
    assert {n["note"] % 12 for n in timpani} <= {0, 7}
    assert r["plan"][0].startswith(
        "A, bars 1-3, f (climax): Violin I carries the melody, doubled by"
    )


def test_a_chorale_plucks_the_basses_and_an_accompaniment_pulses() -> None:
    chorale = _run(texture="chorale", ensemble="strings")
    by_name = {p["name"]: p for p in chorale["parts"]}
    assert all(n["articulation"] == "pizzicato" for n in by_name["Contrabass"]["notes"])
    pulsed = _run(texture="melody_accompaniment", ensemble="strings")
    second = {p["name"]: p for p in pulsed["parts"]}["Violin II"]["notes"]
    assert len(second) > len(by_name["Violin II"]["notes"])
    assert all(n["articulation"] == "staccato" for n in second)


def test_call_and_answer_alternates_the_lead_by_section() -> None:
    r = _run(texture="call_answer", ensemble="chamber")
    assert [s["lead"] for s in r["sections"]] == ["strings", "winds"]
    assert r["plan"][1].startswith("B, bars 4-8, p: The winds carry the melody")


def test_a_one_line_sketch_gets_a_bass_of_roots_and_a_chord_read_from_it() -> None:
    r = orchestrate([SKETCH[0]], key="C", ensemble="strings")
    by_name = {p["name"]: p for p in r["parts"]}
    assert by_name["Cello"]["notes"]
    assert r["melody_part"] == r["bass_part"] == "m"
    assert r["chords"][0]["figure"]


def test_the_same_sketch_answers_the_same() -> None:
    assert _run(ensemble="romantic", texture="tutti") == _run(
        ensemble="romantic", texture="tutti"
    )


def test_refusals() -> None:
    with pytest.raises(OrchestrateError):
        orchestrate([{"id": "x", "name": "Empty", "notes": []}])
    with pytest.raises(OrchestrateError):
        _run(melody="nobody")
    with pytest.raises(OrchestrateError):
        _run(ensemble="marching-band")


@pytest.fixture(autouse=True)
def _isolated_tokens(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pairing, "_TOKEN_FILE", tmp_path / "pairing_token.txt")
    monkeypatch.setattr(pairing, "_cached", None)
    monkeypatch.delenv(launch_token.ENV_VAR, raising=False)


def test_the_route_answers_and_refuses_with_a_sentence() -> None:
    app = FastAPI()
    app.include_router(router, prefix="/api/composer")
    client = TestClient(app, client=("127.0.0.1", 51000))
    body = {
        "parts": SKETCH,
        "harmony": HARMONY,
        "markers": MARKERS,
        "key": "C",
        "ensemble": "chamber",
        "texture": "tutti",
        "density": 0.5,
        "melody": "m",
        "bass": "b",
    }
    r = client.post("/api/composer/orchestrate", json=body)
    assert r.status_code == 200, r.text
    data = r.json()
    assert [p["name"] for p in data["parts"]][:2] == ["Flute", "Oboe"]
    assert len(data["plan"]) == 2
    r = client.post("/api/composer/orchestrate", json={**body, "melody": "nobody"})
    assert r.status_code == 422
    assert "nobody" in r.json()["detail"]
    health = client.get("/api/composer").json()
    assert health["ensembles"] == ["strings", "chamber", "classical", "romantic"]
