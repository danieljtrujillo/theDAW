"""A library sheet an older build wrote for a transposing instrument is
rewritten from its MIDI at written pitch.

Before the pitch fix, MAKE SHEET printed a MIDI's clarinet part at the pitch it
sounds under a ``<transpose>`` that says the notes are written pitch. This
build reads such a sheet correctly (``sheet_pitch.mark_legacy_sounding_pitch``),
but the file itself still prints the wrong notes for a player, a PDF or any
other program that opens it. The SCORE tab offers "Rewrite from MIDI" for it.

The sequence replayed here is the app's: the library holds the MIDI (a
``midis`` row) and the sheet the old ``/from-midi`` route registered for it;
the SCORE tab lists the entry's artifacts, sees the sheet flagged, posts the
rewrite, and lists again.
"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path

import pretty_midi
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.library import router as library_router_module
from backend.modules.notation import engine as notation_engine
from backend.modules.notation import router as notation_router_module
from backend.modules.notation.midi_read import read_midi
from backend.modules.sheetimport.parser import parse_score_path
from tests.test_library_store import _seed_generate_entry

ENTRY = "job_rw_00"


def _clarinet_midi(path: Path) -> Path:
    """A General MIDI clarinet (program 71) playing C4 D4 E4 F4 at sounding pitch."""
    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    inst = pretty_midi.Instrument(program=71)
    for i, pitch in enumerate((60, 62, 64, 65)):
        inst.notes.append(pretty_midi.Note(90, pitch, i * 0.5, i * 0.5 + 0.5))
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))
    return path


def _older_build_sheet(midi: Path, sheet: Path) -> Path:
    """MAKE SHEET as the build before the pitch fix wrote it: parts left at
    music21's ``'unknown'`` pitch state, printed at sounding pitch under the
    clarinet's ``<transpose>``, and no ``thedaw-pitch`` stamp."""
    score = read_midi(midi)
    score.atSoundingPitch = "unknown"
    for part in score.parts:
        part.atSoundingPitch = "unknown"
    score = score.quantize((4, 3), inPlace=False, recurse=True)
    sheet.parent.mkdir(parents=True, exist_ok=True)
    score.write("musicxml", fp=str(sheet))
    return sheet


def _printed(sheet: Path) -> list[tuple[str, int, int]]:
    return [
        (
            p.findtext("step") or "",
            int(float(p.findtext("alter") or 0)),
            int(p.findtext("octave") or 0),
        )
        for p in ET.parse(sheet).getroot().iter("pitch")
    ]


@pytest.fixture
def library(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    _seed_generate_entry(tmp_path, "job_rw", 0)
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    app.include_router(notation_router_module.router, prefix="/api/notation")
    return (
        # This machine's own UI: a loopback peer.
        TestClient(app, client=("127.0.0.1", 51000)),
        library_router_module.get_store(),
        tmp_path / "job_rw" / "00",
    )


def _register_old_sheet(
    store, entry_dir: Path, name: str, *, parts=None
) -> tuple[str, Path, Path]:
    """The MIDI row and the sheet the old /from-midi route registered for it."""
    midi_id = f"{ENTRY}__{name}"
    midi = _clarinet_midi(entry_dir / "midi" / f"{name}.mid")
    store.db.add_midi(
        midi_id=midi_id,
        entry_id=ENTRY,
        source=name,
        midi_path=str(midi),
        engine="basic-pitch",
    )
    sheet = _older_build_sheet(midi, entry_dir / "notation" / f"{midi_id}.musicxml")
    meta = {"source": str(midi), "format": "musicxml"}
    if parts:
        meta["parts"] = parts
    store.db.add_notation_artifact(
        artifact_id=f"{midi_id}__musicxml",
        entry_id=ENTRY,
        kind="musicxml",
        path=str(sheet),
        source_ref=midi_id,
        engine="music21",
        engine_version="9.1.0",
        metadata=meta,
    )
    return f"{midi_id}__musicxml", sheet, midi


def _listed(client: TestClient, artifact_id: str) -> dict:
    r = client.get(f"/api/notation/{ENTRY}/artifacts")
    assert r.status_code == 200, r.text
    return next(a for a in r.json()["artifacts"] if a["id"] == artifact_id)


def test_the_score_tab_flags_an_old_sheet_and_rewrites_it_at_written_pitch(library):
    client, store, entry_dir = library
    art_id, sheet, _midi = _register_old_sheet(store, entry_dir, "clar")
    assert _printed(sheet) == [("C", 0, 4), ("D", 0, 4), ("E", 0, 4), ("F", 0, 4)]

    listed = _listed(client, art_id)
    assert listed["legacy_sounding_pitch"] is True
    assert listed["rewrite_from_midi"] is True

    r = client.post(f"/api/notation/{ENTRY}/rewrite-from-midi/{art_id}")
    assert r.status_code == 200, r.text
    assert Path(r.json()["path"]) == sheet, "the sheet is rewritten in place"
    # Written pitch for a B-flat clarinet: a whole step above the sound.
    assert _printed(sheet) == [("D", 0, 4), ("E", 0, 4), ("F", 1, 4), ("G", 0, 4)]
    assert sheet.read_bytes().count(b'name="thedaw-pitch"') == 1
    back = parse_score_path(str(sheet))
    assert [n["pitch"] for n in back["tracks"][0]["notes"]] == [60, 62, 64, 65]

    listed = _listed(client, art_id)
    assert listed["legacy_sounding_pitch"] is False
    assert listed["rewrite_from_midi"] is False
    assert listed["source_ref"] == f"{ENTRY}__clar", "the row keeps its lineage"
    # Nothing else was left beside it.
    assert sorted(p.name for p in sheet.parent.iterdir()) == [sheet.name]

    again = client.post(f"/api/notation/{ENTRY}/rewrite-from-midi/{art_id}")
    assert again.status_code == 409, "a sheet that holds written pitch is not rewritten"


def test_a_rewrite_that_fails_leaves_the_old_sheet(
    library, monkeypatch: pytest.MonkeyPatch
):
    client, store, entry_dir = library
    art_id, sheet, midi = _register_old_sheet(store, entry_dir, "clar")
    before = sheet.read_bytes()

    def broken(_score):
        raise RuntimeError("disk full")

    with monkeypatch.context() as m:
        m.setattr(notation_engine, "stamp_written_pitch", broken)
        r = client.post(f"/api/notation/{ENTRY}/rewrite-from-midi/{art_id}")
    assert r.status_code == 500, r.text
    assert sheet.read_bytes() == before, (
        "the old sheet is kept until a new one is written"
    )
    assert sorted(p.name for p in sheet.parent.iterdir()) == [sheet.name]

    # The MIDI is gone: nothing to rewrite from, and the sheet stays.
    midi.unlink()
    assert _listed(client, art_id)["rewrite_from_midi"] is False
    r = client.post(f"/api/notation/{ENTRY}/rewrite-from-midi/{art_id}")
    assert r.status_code == 404
    assert sheet.read_bytes() == before


def test_a_one_part_sheet_is_rewritten_with_its_part(library):
    client, store, entry_dir = library
    art_id, sheet, _midi = _register_old_sheet(
        store, entry_dir, "solo", parts=[{"index": 0, "name": "Clarinet"}]
    )
    r = client.post(f"/api/notation/{ENTRY}/rewrite-from-midi/{art_id}")
    assert r.status_code == 200, r.text
    assert _printed(sheet) == [("D", 0, 4), ("E", 0, 4), ("F", 1, 4), ("G", 0, 4)]
    row = store.db.get_notation_artifact(art_id)
    assert [p["index"] for p in json.loads(row["metadata_json"])["parts"]] == [0]


def test_only_a_sheet_of_this_entry_is_rewritten(library):
    client, store, entry_dir = library
    art_id, _sheet, _midi = _register_old_sheet(store, entry_dir, "clar")
    assert (
        client.post(f"/api/notation/other/rewrite-from-midi/{art_id}").status_code
        == 404
    )
    assert (
        client.post(
            f"/api/notation/{ENTRY}/rewrite-from-midi/{ENTRY}__clar__nope"
        ).status_code
        == 404
    )
