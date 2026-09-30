"""MIDI stage 3 end to end, the sheet side: public-domain string quartets
from music21's corpus through the backend's sheet import.

Stage 3's promise for scores: a quartet opens with each part on its own
registry instrument and its tempo and meter changes intact. The quartets go
through ``POST /api/sheetimport/parse`` (the route the roll's IMPORT uses for
a score file), and the answer is checked against the file itself, read here
with music21 and the MusicXML, so neither side grades itself:

* Mozart, String Quartet K. 458 "The Hunt", I. Allegro vivace assai: 6/8 with
  an eighth-note pickup, and a ``<sound tempo="120">`` under its tempo words.
* Beethoven, String Quartet Op. 59 No. 3, I.: an Introduzione (Andante con
  moto, 3/4, ``<sound tempo="80">``) and the Allegro vivace in 4/4 from bar 30
  (``<sound tempo="120">``): a meter change and a tempo change.

Both are 18th/19th-century works, public domain, in the encodings music21
ships in its corpus. The frontend half of stage 3 (a 24-part orchestral file
through import, the live scheduler and the export) is
``frontend/src/lib/midiStage3.e2e.test.ts``.
"""

from __future__ import annotations

import time
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

import pytest

PPQ = 960
REGISTRY = {"violin": 40, "viola": 41, "cello": 42}


def _client() -> Any:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.modules.sheetimport.router import router

    app = FastAPI()
    app.include_router(router, prefix="/api/sheetimport")
    return TestClient(app, client=("127.0.0.1", 51000))


def _corpus_path(rel: str) -> Path:
    from music21 import corpus

    return Path(str(corpus.getWork(rel)))


def _parse(rel: str) -> tuple[dict[str, Any], float]:
    path = _corpus_path(rel)
    started = time.perf_counter()
    with _client() as client:
        res = client.post(
            "/api/sheetimport/parse",
            files={
                "file": (
                    path.name,
                    path.read_bytes(),
                    "application/vnd.recordare.musicxml",
                )
            },
        )
    elapsed = time.perf_counter() - started
    assert res.status_code == 200, res.text
    return res.json(), elapsed


def _sound_tempi(rel: str) -> dict[int, float]:
    """Each ``<sound tempo>`` of the first part, by measure number: the tempo the file plays at."""
    with zipfile.ZipFile(_corpus_path(rel)) as z:
        name = next(
            n
            for n in z.namelist()
            if n.endswith(".xml") and not n.startswith("META-INF")
        )
        root = ElementTree.fromstring(z.read(name))
    part = root.find("part")
    assert part is not None
    out: dict[int, float] = {}
    for measure in part.findall("measure"):
        for sound in measure.iter("sound"):
            if sound.get("tempo"):
                out[int(measure.get("number", "0"))] = float(sound.get("tempo", "0"))
    return out


def _signatures(rel: str) -> list[tuple[int, int, int]]:
    """Every time signature of the first part as music21 reads it: (tick, num, den), the pickup's ticks off."""
    from music21 import converter, meter

    score = converter.parse(str(_corpus_path(rel)))
    part = score.parts[0]
    out = []
    for ts in part.flatten().getElementsByClass(meter.TimeSignature):
        tick = round(float(ts.offset) * PPQ)
        if not out or (ts.numerator, ts.denominator) != out[-1][1:]:
            out.append((tick, ts.numerator, ts.denominator))
    return out


@pytest.fixture(scope="module")
def mozart() -> tuple[dict[str, Any], float]:
    return _parse("mozart/k458/movement1.mxl")


@pytest.fixture(scope="module")
def beethoven() -> tuple[dict[str, Any], float]:
    return _parse("beethoven/opus59no3/movement1.mxl")


def _assert_quartet(result: dict[str, Any], names: list[str]) -> None:
    tracks = result["tracks"]
    assert [t["name"] for t in tracks] == names
    assert [t["instrument"] for t in tracks] == ["violin", "violin", "viola", "cello"]
    assert [t["program"] for t in tracks] == [REGISTRY[t["instrument"]] for t in tracks]
    assert [t["percussion"] for t in tracks] == [False] * 4
    assert result["ppq"] == PPQ
    assert all(len(t["notes"]) > 300 for t in tracks), "every part holds its notes"


def test_mozart_k458_parts_meter_pickup_and_tempo(
    mozart: tuple[dict[str, Any], float],
) -> None:
    result, elapsed = mozart
    print(f"\n  K. 458 i: {result['note_count']} notes, parsed in {elapsed:.2f} s")
    _assert_quartet(result, ["1st Violin", "2nd Violin", "Viola", "Cello"])
    # 6/8 from the start, with an eighth-note pickup before bar 1.
    assert [(s["tick"], s["num"], s["den"]) for s in result["time_signatures"]] == [
        (0, 6, 8)
    ]
    assert result["pickup_ticks"] == PPQ // 2
    assert result["time_signature"] == [6, 8]
    # The tempo the file plays at: its <sound tempo="120"> under "Allegro Vivace Assai".
    assert _sound_tempi("mozart/k458/movement1.mxl") == {0: 120.0}
    assert [(t["tick"], t["bpm"], t["text"]) for t in result["tempos"]] == [
        (0, 120.0, "Allegro Vivace Assai")
    ]
    assert result["bpm"] == 120.0


def test_beethoven_op59_3_meter_and_tempo_change(
    beethoven: tuple[dict[str, Any], float],
) -> None:
    result, elapsed = beethoven
    print(f"\n  Op. 59/3 i: {result['note_count']} notes, parsed in {elapsed:.2f} s")
    _assert_quartet(result, ["1st Violin", "2nd Violin", "Viola", "Cello"])
    signatures = _signatures("beethoven/opus59no3/movement1.mxl")
    assert [s[1:] for s in signatures] == [(3, 4), (4, 4)]
    assert [
        (s["tick"], s["num"], s["den"]) for s in result["time_signatures"]
    ] == signatures, "each meter at the tick music21 reads for it"
    assert result["time_signatures"][1]["measure"] == 30, (
        "the Allegro vivace's 4/4 at bar 30"
    )
    allegro = signatures[1][0]
    # The Introduzione at the file's <sound tempo="80">, the Allegro vivace at its 120, from the same bar line as its 4/4.
    assert _sound_tempi("beethoven/opus59no3/movement1.mxl") == {1: 80.0, 30: 120.0}
    assert [(t["tick"], t["bpm"], t["text"]) for t in result["tempos"]] == [
        (0, 80.0, "Andante con moto"),
        (allegro, 120.0, "Allegro vivace"),
    ]
    assert result["bpm"] == 80.0
