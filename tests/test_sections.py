"""The song section finder, on synthetic songs whose form is known.

The finder (backend/modules/sections/finder.py) is run on songs built from
distinct chord progressions and drum patterns (tests/section_synth.py), with
and without the stems a separation would give, and on the edge cases: a
one-section drone, a file shorter than a bar, a file with no stems. The
module's HTTP surface is then driven in the order the app uses it: find the
sections, rename one, find them again, read them back, and ask the Shard
Index for chorus material.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.library.db import LibraryDB
from backend.modules.sections import finder, service, store
from tests.section_synth import (
    AM_F_C_G,
    C_FM,
    DM_BB,
    E_DRONE,
    F_G_EM_AM,
    SR,
    Part,
    bars_of,
    render,
    starts_of,
)

VERSE = Part(8, AM_F_C_G, drums="light", bass=True, lead=True)
CHORUS = Part(8, F_G_EM_AM, drums="full", bass=True, lead=True, level_db=2, bright=True)
BREAK = Part(8, DM_BB, drums="none", level_db=-6)
INTRO = Part(4, C_FM, level_db=-8)
OUTRO = Part(4, E_DRONE, level_db=-10)

_CACHE: dict[tuple, tuple] = {}


def _song(parts: list[Part]):
    key = tuple(parts)
    if key not in _CACHE:
        _CACHE[key] = render(parts)
    return _CACHE[key]


def _run(parts: list[Part], with_stems: bool) -> dict:
    mix, stems, _ = _song(parts)
    return finder.find_sections(
        mix, bars_of(parts), stems=stems if with_stems else None
    )


# ---- the finder ---------------------------------------------------------------


@pytest.mark.parametrize("with_stems", [False, True])
def test_a_b_a_c_is_found_on_its_bar_lines_with_repeat_letters(
    with_stems: bool,
) -> None:
    parts = [VERSE, CHORUS, VERSE, BREAK]
    r = _run(parts, with_stems)
    secs = r["sections"]
    assert [s["start_bar"] for s in secs] == starts_of(parts)
    assert [s["letter"] for s in secs] == ["A", "B", "A", "C"]
    # On the bar lines: bar 8 of a 120 BPM song starts at 16 s.
    assert [s["start_sec"] for s in secs] == [0.0, 16.0, 32.0, 48.0]
    assert secs[-1]["end_sec"] == pytest.approx(len(_song(parts)[0]) / SR, abs=1e-3)
    # The loud repeated part is the chorus; the drumless close is the outro.
    assert secs[1]["role"] == "chorus"
    assert secs[3]["role"] == "outro"
    assert secs[2]["repeat_of"] == 0 and secs[0]["repeat_of"] is None
    for s in secs[1:]:
        assert 0.0 < s["confidence"] <= 1.0
    assert [b["bar"] for b in r["boundaries"]] == [8, 16, 24]


def test_a_pop_form_reads_intro_verse_chorus_and_outro_from_the_stems() -> None:
    parts = [INTRO, VERSE, CHORUS, VERSE, CHORUS, OUTRO]
    r = _run(parts, True)
    secs = r["sections"]
    assert [s["start_bar"] for s in secs] == starts_of(parts)
    assert [s["role"] for s in secs] == [
        "intro",
        "verse",
        "chorus",
        "verse",
        "chorus",
        "outro",
    ]
    assert [s["name"] for s in secs] == [
        "Intro",
        "Verse",
        "Chorus",
        "Verse 2",
        "Chorus 2",
        "Outro",
    ]
    assert [s["letter"] for s in secs] == ["A", "B", "C", "B", "C", "D"]
    assert set(r["stems"]) == {"drums", "bass", "other", "vocals"}
    chorus = secs[2]["stems"]
    assert chorus["drums"] > 0.8 and chorus["vocals"] > 0.5
    assert secs[0]["stems"]["drums"] == 0.0


def test_a_loud_repeated_part_with_no_voice_is_a_drop() -> None:
    drop = Part(
        8, F_G_EM_AM, drums="full", bass=True, lead=False, level_db=3, bright=True
    )
    parts = [INTRO, VERSE, drop, VERSE, drop, OUTRO]
    secs = _run(parts, True)["sections"]
    assert [s["role"] for s in secs] == [
        "intro",
        "verse",
        "drop",
        "verse",
        "drop",
        "outro",
    ]


def test_a_varied_repeat_takes_a_prime() -> None:
    # The second verse keeps its chords, bass and kit but loses its voice.
    bare = Part(8, AM_F_C_G, drums="light", bass=True, lead=False)
    parts = [VERSE, CHORUS, bare, CHORUS]
    secs = _run(parts, True)["sections"]
    assert [s["start_bar"] for s in secs] == starts_of(parts)
    assert [s["letter"] for s in secs] == ["A", "B", "A'", "B"]


@pytest.mark.parametrize("with_stems", [False, True])
def test_a_drone_is_one_section(with_stems: bool) -> None:
    parts = [Part(16, E_DRONE)]
    r = _run(parts, with_stems)
    assert len(r["sections"]) == 1
    only = r["sections"][0]
    assert (
        only["letter"] == "A" and only["start_sec"] == 0.0 and only["confidence"] == 1.0
    )
    assert r["boundaries"] == []


def test_a_drone_with_no_beats_gets_a_time_grid_and_one_section() -> None:
    t = np.arange(int(20 * SR)) / SR
    y = (0.3 * np.sin(2 * np.pi * 110 * t) + 0.2 * np.sin(2 * np.pi * 165 * t)).astype(
        np.float32
    )
    bars, source = service.bar_grid(y)
    assert source in ("tracked", "time") and len(bars) >= 2
    r = finder.find_sections(y, bars)
    assert len(r["sections"]) == 1


def test_a_file_shorter_than_a_bar_is_one_section() -> None:
    y = (0.2 * np.sin(2 * np.pi * 220 * np.arange(int(1.5 * SR)) / SR)).astype(
        np.float32
    )
    bars, source = service.bar_grid(y)
    assert source == "time"
    r = finder.find_sections(y, bars)
    assert len(r["sections"]) == 1
    s = r["sections"][0]
    assert s["start_sec"] == 0.0 and s["end_sec"] == pytest.approx(1.5, abs=1e-3)
    assert s["role"] == "verse" and s["name"] == "Verse"


def test_an_empty_file_has_no_sections() -> None:
    r = finder.find_sections(np.zeros(0, dtype=np.float32), [])
    assert r["sections"] == []


def test_the_rhythm_bars_win_over_the_beats() -> None:
    y = np.zeros(SR * 10, dtype=np.float32)
    rb = [(0.3, 2.3), (2.3, 4.3), (4.3, 6.3)]
    assert service.bar_grid(y, rhythm_bars=rb, beats=[0.5 * i for i in range(20)]) == (
        rb,
        "rhythm",
    )


def test_beats_are_grouped_into_bars() -> None:
    beats = [0.5 * i for i in range(17)]
    assert finder.bars_from_beats(beats, 4, 1)[:2] == [(0.5, 2.5), (2.5, 4.5)]


# ---- the store ----------------------------------------------------------------


def _doc(roles: list[str]) -> dict:
    secs = []
    for i, r in enumerate(roles):
        secs.append(
            {
                "index": i,
                "start_sec": 8.0 * i,
                "end_sec": 8.0 * (i + 1),
                "start_bar": 4 * i,
                "bars": 4,
                "role": r,
            }
        )
    doc = {"version": finder.SECTIONS_VERSION, "sections": secs}
    return store.renumber(doc)


def test_a_rename_and_a_new_role_survive_a_new_run() -> None:
    old = store.edit_section(
        _doc(["intro", "verse", "chorus", "verse"]), 2, name="  The   Hook "
    )
    old = store.edit_section(old, 3, role="bridge")
    assert old["sections"][2]["name"] == "The Hook"
    assert [s["name"] for s in old["sections"]] == [
        "Intro",
        "Verse",
        "The Hook",
        "Bridge",
    ]
    new = store.carry_edits(old, _doc(["intro", "verse", "chorus", "verse"]))
    assert [s["name"] for s in new["sections"]] == [
        "Intro",
        "Verse",
        "The Hook",
        "Bridge",
    ]
    assert new["sections"][3]["role"] == "bridge"
    with pytest.raises(ValueError):
        store.edit_section(new, 0, name="   ")
    with pytest.raises(ValueError):
        store.edit_section(new, 0, role="solo")
    with pytest.raises(IndexError):
        store.edit_section(new, 9, name="x")


# ---- the app's sequence: find, rename, find again, query shards ----------------


@pytest.fixture()
def library(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("theDAW_DATA_DIR", str(tmp_path / "data"))
    from backend.modules.rhythm import router as rhythm_router

    monkeypatch.setattr(rhythm_router, "CACHE_DIR", tmp_path / "data" / "rhythm")
    db = LibraryDB(tmp_path / "library.db")
    parts = [INTRO, VERSE, CHORUS, VERSE, CHORUS, OUTRO]
    mix, stems, beats = render(parts)
    entry_dir = tmp_path / "song_s"
    (entry_dir / "stems").mkdir(parents=True)
    audio = entry_dir / "song.wav"
    sf.write(str(audio), mix, SR)
    db.upsert_entry(
        {
            "id": "song_s",
            "kind": "audio",
            "title": "Song S",
            "prompt": "",
            "model": "import",
            "duration_sec": len(mix) / SR,
            "created_at": 0.0,
            "updated_at": 0.0,
            "metadata_json": "{}",
        }
    )
    db.upsert_analysis(
        "song_s",
        {"bpm": 120.0, "beats": beats, "key": "A", "scale": "minor", "version": 2},
    )
    rows = []
    for name, y in stems.items():
        p = entry_dir / "stems" / f"{name}.wav"
        sf.write(str(p), y, SR)
        rows.append(name)
    for name in rows:
        db.add_stem(
            stem_id=f"song_s__{name}",
            entry_id="song_s",
            stem_name=name,
            audio_path=f"stems/{name}.wav",
        )
    from backend.core import pipeline

    monkeypatch.setattr(
        pipeline, "_entry_paths", lambda entry_id: (db, audio, entry_dir)
    )
    from backend.modules.sections import router as sections_router

    monkeypatch.setattr(sections_router, "_library_db", lambda: db)
    yield db, audio, entry_dir, parts
    db.close()


def _client() -> TestClient:
    from backend.modules.sections.router import router

    app = FastAPI()
    app.include_router(router, prefix="/api/sections")
    return TestClient(app)


def test_find_rename_find_again_and_query_the_chorus_shards(library) -> None:
    db, audio, entry_dir, parts = library
    from backend.modules.shards import extract

    # The entry was sharded before anyone asked for its sections.
    extract.extract_shards(db, "song_s", audio, entry_dir)
    assert {r["section"] for r in db.list_shards("song_s")} == {""}

    c = _client()
    assert c.get("/api/sections/song_s").json() == {
        "entry_id": "song_s",
        "status": "pending",
    }

    r = c.post("/api/sections/song_s/run")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ready" and body["grid"]["source"] == "beats"
    assert [s["role"] for s in body["sections"]] == [
        "intro",
        "verse",
        "chorus",
        "verse",
        "chorus",
        "outro",
    ]
    assert set(body["stems"]) == {"drums", "bass", "other", "vocals"}

    # The shards now carry the section they sit in.
    chorus_bars = {
        b
        for s in body["sections"]
        if s["role"] == "chorus"
        for b in range(s["start_bar"], s["start_bar"] + s["bars"])
    }
    bars = [
        r
        for r in db.list_shards("song_s")
        if r["beats"] == 4 and r["stem_name"] == "drums"
    ]
    assert {r["bar_index"] for r in bars if r["section"] == "chorus"} == chorus_bars
    picked = db.select_shards(section="chorus", role="drums", beats=4)
    assert picked and all(p["section"] == "chorus" for p in picked)

    # The user renames the second chorus; the name is stored.
    r = c.patch("/api/sections/song_s/sections/4", json={"name": "Last Chorus"})
    assert r.status_code == 200, r.text
    assert c.get("/api/sections/song_s").json()["sections"][4]["name"] == "Last Chorus"

    # ...re-roles the second verse, and the shards follow.
    r = c.patch("/api/sections/song_s/sections/3", json={"role": "bridge"})
    assert r.json()["sections"][3]["name"] == "Bridge"
    assert {
        r["section"]
        for r in db.list_shards("song_s")
        if r["beats"] == 4 and 20 <= r["bar_index"] < 28
    } == {"bridge"}

    # A second run keeps both edits.
    again = c.post("/api/sections/song_s/run").json()
    assert again["sections"][4]["name"] == "Last Chorus"
    assert again["sections"][3]["role"] == "bridge"
    stored = json.loads(
        (Path(entry_dir).parent / "data" / "sections" / "song_s.json").read_text(
            encoding="utf-8"
        )
    )
    assert stored["sections"][4]["named_by_user"] is True

    # A re-cut of the shards keeps the sections.
    extract.extract_shards(db, "song_s", audio, entry_dir)
    assert {
        r["bar_index"]
        for r in db.list_shards("song_s")
        if r["beats"] == 4 and r["stem_name"] == "drums" and r["section"] == "chorus"
    } == {
        b
        for s in again["sections"]
        if s["role"] == "chorus"
        for b in range(s["start_bar"], s["start_bar"] + s["bars"])
    }

    # Mistakes come back as 400 / 404.
    assert (
        c.patch("/api/sections/song_s/sections/99", json={"name": "x"}).status_code
        == 404
    )
    assert (
        c.patch("/api/sections/song_s/sections/0", json={"role": "solo"}).status_code
        == 400
    )
    assert c.patch("/api/sections/song_s/sections/0", json={}).status_code == 400
    assert (
        c.patch("/api/sections/other/sections/0", json={"name": "x"}).status_code == 404
    )


def test_health_names_the_roles() -> None:
    body = _client().get("/api/sections/").json()
    assert (
        body["module"] == "sections"
        and "chorus" in body["roles"]
        and "drop" in body["roles"]
    )
