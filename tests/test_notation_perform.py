"""A sheet played as a MIDI performance (``notation.perform`` and
``POST /api/notation/{entry}/perform``).

The chorale is four bars of four-part quarter notes ending on a final bar
line. Its performance slows into the end: the last bar takes longer than the
first, and the MIDI carries that as more than one tempo event.
"""

from __future__ import annotations

from pathlib import Path

import mido
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from music21 import articulations, bar, dynamics, meter, note, stream, tempo

from backend.lib import pairing
from backend.modules.library import router as library_router_module
from backend.modules.notation import router as notation_router_module
from backend.modules.notation.perform import PPQ, perform_musicxml
from tests.test_library_store import _seed_generate_entry

ENTRY = "job_pf_00"
LOOPBACK_PEER = ("127.0.0.1", 51000)
LAN_PEER = ("10.20.30.40", 51000)

# Soprano, alto, tenor, bass: one chord per beat, four bars.
_CHORDS = [
    (72, 67, 64, 48),
    (74, 67, 65, 50),
    (76, 67, 64, 52),
    (77, 69, 65, 53),
    (79, 71, 67, 55),
    (77, 69, 65, 53),
    (76, 67, 64, 52),
    (74, 67, 65, 55),
    (72, 64, 64, 57),
    (74, 65, 65, 53),
    (76, 67, 64, 55),
    (74, 67, 65, 55),
    (72, 67, 64, 48),
    (71, 65, 62, 55),
    (72, 64, 60, 48),
    (72, 64, 60, 48),
]


def _chorale(path: Path, *, staccato_first_beat: bool = False) -> Path:
    score = stream.Score()
    for voice, name in enumerate(("Soprano", "Alto", "Tenor", "Bass")):
        part = stream.Part()
        part.partName = name
        part.append(meter.TimeSignature("4/4"))
        if voice == 0:
            part.append(tempo.MetronomeMark(number=90))
        for beat, chord_pitches in enumerate(_CHORDS):
            n = note.Note(chord_pitches[voice], quarterLength=1.0)
            if staccato_first_beat and beat == 1:
                n.articulations.append(articulations.Staccato())
            part.append(n)
        part.insert(0, dynamics.Dynamic("mf"))
        part.makeMeasures(inPlace=True)
        part.getElementsByClass(stream.Measure)[-1].rightBarline = bar.Barline("final")
        score.insert(0, part)
    path.parent.mkdir(parents=True, exist_ok=True)
    score.write("musicxml", fp=str(path))
    return path


def _seconds_at(midi: mido.MidiFile, tick: int) -> float:
    """Seconds from the start to ``tick`` under the file's tempo map."""
    tempos: list[tuple[int, int]] = []
    now = 0
    for message in midi.tracks[0]:
        now += message.time
        if message.type == "set_tempo":
            tempos.append((now, message.tempo))
    seconds, at, current = 0.0, 0, 500000
    for change_at, value in tempos:
        if change_at >= tick:
            break
        seconds += mido.tick2second(change_at - at, PPQ, current)
        at, current = change_at, value
    return seconds + mido.tick2second(tick - at, PPQ, current)


def test_a_chorale_slows_into_its_last_bar(tmp_path):
    sheet = _chorale(tmp_path / "chorale.musicxml")
    out = tmp_path / "chorale.mid"

    summary = perform_musicxml(sheet, out)

    midi = mido.MidiFile(str(out))
    set_tempos = [m for m in midi.tracks[0] if m.type == "set_tempo"]
    assert len(set_tempos) > 1
    assert summary["tempo_events"] == len(set_tempos)
    bar = 4 * PPQ
    first = _seconds_at(midi, bar) - _seconds_at(midi, 0)
    last = _seconds_at(midi, 4 * bar) - _seconds_at(midi, 3 * bar)
    assert last > first
    # Bar 1 is played close to the printed 90 BPM (a phrase lean on beat 1).
    assert first == pytest.approx(4 * 60 / 90, rel=0.05)
    assert summary["notes"] == 64
    assert summary["parts"] == ["Soprano", "Alto", "Tenor", "Bass"]
    assert len(midi.tracks) == 5, "a tempo track and one track per part"


def test_notes_sit_on_the_sheets_beat_grid_and_staccato_is_short(tmp_path):
    sheet = _chorale(tmp_path / "chorale.musicxml", staccato_first_beat=True)
    out = tmp_path / "chorale.mid"

    perform_musicxml(sheet, out)

    midi = mido.MidiFile(str(out))
    soprano = midi.tracks[1]
    now = 0
    ons: list[int] = []
    lengths: dict[int, int] = {}
    for message in soprano:
        now += message.time
        if message.type == "note_on" and message.velocity > 0:
            ons.append(now)
        elif message.type == "note_off":
            lengths[ons[-1]] = now - ons[-1]
    assert ons == [i * PPQ for i in range(16)]
    assert lengths[PPQ] < 0.6 * PPQ, "the staccato quarter sounds about half"
    assert lengths[0] > 0.8 * PPQ


@pytest.fixture
def library(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    _seed_generate_entry(tmp_path, "job_pf", 0)
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    app.include_router(notation_router_module.router, prefix="/api/notation")
    return (
        # This machine's own UI: a loopback peer.
        TestClient(app, client=LOOPBACK_PEER),
        library_router_module.get_store(),
        tmp_path / "job_pf" / "00",
    )


def _register(store, entry_dir: Path, artifact_id: str, kind: str, path: Path) -> None:
    store.db.add_notation_artifact(
        artifact_id=artifact_id,
        entry_id=ENTRY,
        kind=kind,
        path=str(path),
        source_ref="",
        engine="music21",
        engine_version="10.1.0",
        metadata={"format": kind},
    )


def test_the_perform_route_registers_a_midi_the_score_tab_lists(library):
    client, store, entry_dir = library
    sheet = _chorale(entry_dir / "notation" / "chorale.musicxml")
    _register(store, entry_dir, "sheet1", "musicxml", sheet)

    r = client.post(
        f"/api/notation/{ENTRY}/perform", json={"source_artifact_id": "sheet1"}
    )

    assert r.status_code == 200, r.text
    body = r.json()
    artifact = body["artifact"]
    assert artifact["id"] == "sheet1__performed_midi"
    assert artifact["kind"] == "midi"
    assert artifact["engine"] == "partitura-perform"
    path = Path(body["path"])
    assert path.is_file() and path.parent == entry_dir / "notation"
    assert body["performance"]["tempo_events"] > 1
    listed = client.get(f"/api/notation/{ENTRY}/artifacts").json()["artifacts"]
    assert "sheet1__performed_midi" in [a["id"] for a in listed]


def test_the_perform_route_guards_like_its_neighbours(library):
    client, store, entry_dir = library
    midi = entry_dir / "midi" / "take.mid"
    midi.parent.mkdir(parents=True, exist_ok=True)
    mido.MidiFile().save(str(midi))
    _register(store, entry_dir, "take", "midi", midi)

    assert (
        client.post(
            f"/api/notation/{ENTRY}/perform", json={"source_artifact_id": "take"}
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"/api/notation/{ENTRY}/perform", json={"source_artifact_id": "nope"}
        ).status_code
        == 404
    )
    assert (
        client.post(
            "/api/notation/no_such_entry/perform", json={"source_artifact_id": "take"}
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/notation/{ENTRY}/perform",
            json={"source_artifact_id": "take", "bpm": -3},
        ).status_code
        == 422
    )


def test_the_perform_route_answers_only_this_machine_or_a_paired_device(
    library, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """PERFORM writes a MIDI into the entry, so a page outside theDAW and a
    LAN caller without the pairing token are refused, and a paired device
    performs the sheet as this machine's own UI does."""
    monkeypatch.setattr(pairing, "_TOKEN_FILE", tmp_path / "pairing_token.txt")
    monkeypatch.setattr(pairing, "_cached", None)
    client, store, entry_dir = library
    sheet = _chorale(entry_dir / "notation" / "chorale.musicxml")
    _register(store, entry_dir, "sheet1", "musicxml", sheet)
    url = f"/api/notation/{ENTRY}/perform"
    body = {"source_artifact_id": "sheet1"}

    foreign = client.post(
        url,
        json=body,
        headers={"origin": "https://evil.example", "sec-fetch-site": "cross-site"},
    )
    assert foreign.status_code == 403, foreign.text

    lan = TestClient(client.app, client=LAN_PEER)
    assert lan.post(url, json=body).status_code == 403
    assert store.db.get_notation_artifact("sheet1__performed_midi") is None

    paired = lan.post(url, json=body, headers={pairing.HEADER: pairing.get_token()})
    assert paired.status_code == 200, paired.text
    assert paired.json()["artifact"]["id"] == "sheet1__performed_midi"


def test_capabilities_say_perform_is_available(library):
    client, _store, _entry_dir = library

    assert client.get("/api/notation").json()["perform"] is True
