"""A score file imported into the library, a corpus piece opened, and a score
exported as MIDI at the pitch it sounds.

The sequence replayed is the SCORE tab's: IMPORT SCORE FILE uploads the file
(``POST /api/notation/import``), BROWSE CORPUS searches (``GET
/api/notation/corpus``) and opens one (``POST /api/notation/corpus/open``),
and the tab then lists the new entry's artifacts and exports the sheet. The
notation backfill runs at every launch, so it is run over the imported
entries too: it must not re-credit them to the app's default artist.
"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import pretty_midi
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.lib import pairing
from backend.modules.library import router as library_router_module
from backend.modules.notation import router as notation_router_module
from backend.modules.notation import score_import
from backend.modules.notation.backfill import backfill_scores

COMPOSER = "Ada Q. Composer"
TITLE = "Clarinet Study"

ABC_TUNE = """X:1
T:ABC Test Tune
C:Abc Composer
M:4/4
L:1/4
K:C
CDEF|GABc|
"""

KERN_TUNE = """!!!COM: Kern Composer
!!!OTL: Kern Test Tune
**kern
*M4/4
=1
4c
4d
4e
4f
==
*-
"""


def _clarinet_score():
    """A B-flat clarinet part at WRITTEN pitch: D5 then E5 in 4/4 at 90 BPM,
    then a bar of 3/4 at 120 BPM holding F5, under a title and a composer."""
    from music21 import instrument, metadata, meter, note, stream, tempo

    score = stream.Score()
    score.insert(0, metadata.Metadata(title=TITLE, composer=COMPOSER))
    part = stream.Part()
    part.partName = "Clarinet in Bb"
    part.insert(0, instrument.Clarinet())
    first = stream.Measure(number=1)
    first.append(meter.TimeSignature("4/4"))
    first.append(tempo.MetronomeMark(number=90))
    first.append(note.Note("D5", quarterLength=2))
    first.append(note.Note("E5", quarterLength=2))
    second = stream.Measure(number=2)
    second.append(meter.TimeSignature("3/4"))
    second.append(tempo.MetronomeMark(number=120))
    second.append(note.Note("F5", quarterLength=3))
    part.append([first, second])
    score.insert(0, part)
    score.atSoundingPitch = False
    part.atSoundingPitch = False
    return score


def _write_fixture(tmp_path: Path, suffix: str) -> Path:
    """The clarinet score as a file of ``suffix``; the kern and ABC fixtures
    are written as text, because music21 reads those formats but cannot
    write them."""
    path = tmp_path / "fixtures" / f"study{suffix}"
    path.parent.mkdir(parents=True, exist_ok=True)
    if suffix == ".abc":
        path.write_text(ABC_TUNE, encoding="utf-8")
    elif suffix == ".krn":
        path.write_text(KERN_TUNE, encoding="utf-8")
    elif suffix == ".mxl":
        _clarinet_score().write("mxl", fp=str(path))
    else:
        _clarinet_score().write("musicxml", fp=str(path))
    return path


@pytest.fixture(autouse=True)
def _isolated_pairing_token(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pairing, "_TOKEN_FILE", tmp_path / "pairing_token.txt")
    monkeypatch.setattr(pairing, "_cached", None)


@pytest.fixture
def library(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = tmp_path / "library"
    root.mkdir()
    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(root))
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    app.include_router(notation_router_module.router, prefix="/api/notation")
    store = library_router_module.get_store()
    return {
        "app": app,
        "store": store,
        # This machine's own UI: a loopback peer.
        "client": TestClient(app, client=("127.0.0.1", 51000)),
    }


def _upload(client: TestClient, path: Path, name: str | None = None, **kwargs):
    return client.post(
        "/api/notation/import",
        files={
            "file": (name or path.name, path.read_bytes(), "application/octet-stream")
        },
        **kwargs,
    )


def _artifacts(client: TestClient, entry_id: str) -> list[dict]:
    r = client.get(f"/api/notation/{entry_id}/artifacts")
    assert r.status_code == 200, r.text
    return r.json()["artifacts"]


def _composers(sheet: Path) -> list[str]:
    root = ET.parse(sheet).getroot()
    return [
        (c.text or "").strip()
        for c in root.iter("creator")
        if (c.get("type") or "composer") == "composer"
    ]


def _score_entries(store) -> list[str]:
    return [r.id for r in store.list_entries(kinds={"score"})]


# ---------------------------------------------------------------------------
# A. Import, one file of each extension
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("suffix", "title", "composer", "original_kind"),
    [
        (".musicxml", TITLE, COMPOSER, None),
        (".xml", TITLE, COMPOSER, None),
        (".mxl", TITLE, COMPOSER, "mxl"),
        (".krn", "Kern Test Tune", "Kern Composer", "kern"),
        (".abc", "ABC Test Tune", "Abc Composer", "abc"),
    ],
)
def test_an_imported_score_is_a_composition_entry_that_keeps_its_credit(
    library, tmp_path, suffix, title, composer, original_kind
):
    client, store = library["client"], library["store"]
    fixture = _write_fixture(tmp_path, suffix)

    r = _upload(client, fixture)
    assert r.status_code == 200, r.text
    body = r.json()
    entry_id = body["entry_id"]
    assert body["title"] == title
    assert body["composer"] == composer

    # The composition entry: kind score, no audio, the file's own identity.
    entry = client.get(f"/api/library/entries/{entry_id}")
    assert entry.status_code == 200, entry.text
    assert entry.json()["kind"] == "score"
    assert entry.json()["title"] == title
    assert entry.json()["audio_url"] == ""
    row = store.db.get_entry(entry_id)
    assert row is not None and row["kind"] == "score"
    meta = json.loads(row["metadata_json"])
    assert meta["notation_artist"] == composer
    assert meta["notation_title"] == title
    # It is listed with the other compositions, and never as a track.
    assert entry_id in _score_entries(store)
    tracks = client.get("/api/library/entries").json()["entries"]
    assert entry_id not in [t["id"] for t in tracks]
    scores = client.get("/api/library/entries?kind=score").json()["entries"]
    assert [s["id"] for s in scores] == [entry_id]

    # The SCORE tab lists the sheet (and the original, for a non-XML file).
    artifacts = _artifacts(client, entry_id)
    kinds = sorted(a["kind"] for a in artifacts)
    assert kinds == sorted(["musicxml"] + ([original_kind] if original_kind else []))
    sheet = next(a for a in artifacts if a["kind"] == "musicxml")
    assert sheet["legacy_sounding_pitch"] is False
    sheet_path = Path(sheet["path"])
    assert sheet_path.is_file()
    assert sheet_path.parent == store._dir_for(entry_id) / "notation"
    assert _composers(sheet_path) == [composer]
    if original_kind:
        original = next(a for a in artifacts if a["kind"] == original_kind)
        assert Path(original["path"]).read_bytes() == fixture.read_bytes()
        assert sheet["source_ref"] == original["id"]
    # The library's SCORE list carries it, joined to the composition's title.
    listed = client.get("/api/library/_all/scores").json()["scores"]
    assert sheet["id"] in [s["id"] for s in listed]
    assert {s["parent_title"] for s in listed if s["parent_id"] == entry_id} == {title}

    # The launch-time backfill leaves the file's credit alone.
    before = sheet_path.read_bytes()
    backfill_scores(store)
    assert sheet_path.read_bytes() == before
    assert _composers(sheet_path) == [composer]


def test_a_score_with_no_composer_is_credited_to_nobody(library, tmp_path):
    client = library["client"]
    path = tmp_path / "anon.abc"
    path.write_text(
        "X:1\nT:Nameless Air\nM:3/4\nL:1/4\nK:G\nGAB|d3|\n", encoding="utf-8"
    )
    r = _upload(client, path)
    assert r.status_code == 200, r.text
    assert r.json()["composer"] == ""
    sheet = next(
        a for a in _artifacts(client, r.json()["entry_id"]) if a["kind"] == "musicxml"
    )
    # music21's "Music21" stand-in is not kept as a credit.
    assert _composers(Path(sheet["path"])) == []


def test_a_verbatim_musicxml_original_is_the_sheet(library, tmp_path):
    """A MusicXML file another program wrote is kept byte for byte and drawn
    as it is: nothing rewrites the user's file."""
    client = library["client"]
    path = tmp_path / "other.musicxml"
    path.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<score-partwise version="4.0">'
        "<work><work-title>Hand Written</work-title></work>"
        '<identification><creator type="composer">Someone Else</creator>'
        "<encoding><software>Finale</software></encoding></identification>"
        '<part-list><score-part id="P1"><part-name>Flute</part-name></score-part></part-list>'
        '<part id="P1"><measure number="1"><attributes><divisions>1</divisions>'
        "<time><beats>4</beats><beat-type>4</beat-type></time></attributes>"
        "<note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration>"
        "<type>whole</type></note></measure></part></score-partwise>\n",
        encoding="utf-8",
    )
    r = _upload(client, path)
    assert r.status_code == 200, r.text
    assert (r.json()["title"], r.json()["composer"]) == ("Hand Written", "Someone Else")
    (sheet,) = _artifacts(client, r.json()["entry_id"])
    assert Path(sheet["path"]).read_bytes() == path.read_bytes()


# ---------------------------------------------------------------------------
# B. The music21 corpus
# ---------------------------------------------------------------------------


def test_corpus_search_for_bach_lists_pieces_and_open_imports_one(library):
    client, store = library["client"], library["store"]
    r = client.get("/api/notation/corpus", params={"q": "bach"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] > 0 and body["results"]
    for row in body["results"]:
        assert set(row) >= {"id", "composer", "title", "movement", "parts", "path"}
    # A named composer sorts first.
    assert body["results"][0]["composer"]
    assert "bach_bwv66_6_mxl" in [
        row["id"]
        for row in client.get("/api/notation/corpus", params={"q": "bwv66.6"}).json()[
            "results"
        ]
    ]
    # One letter is not a search.
    assert client.get("/api/notation/corpus", params={"q": "b"}).json()["results"] == []

    opened = client.post("/api/notation/corpus/open", json={"id": "bach_bwv10_7_mxl"})
    assert opened.status_code == 200, opened.text
    entry_id = opened.json()["entry_id"]
    assert entry_id in _score_entries(store)
    artifacts = _artifacts(client, entry_id)
    assert sorted(a["kind"] for a in artifacts) == ["musicxml", "mxl"]
    meta = json.loads(store.db.get_entry(entry_id)["metadata_json"])
    assert meta["corpus_id"] == "bach_bwv10_7_mxl"
    assert meta["score_origin"] == "corpus"
    # The corpus file names its composer; the composition keeps it.
    composer = opened.json()["composer"]
    assert "Bach" in composer
    assert meta["notation_artist"] == composer

    missing = client.post("/api/notation/corpus/open", json={"id": "no_such_piece"})
    assert missing.status_code == 404


def test_the_corpus_bundle_is_read_once(monkeypatch):
    from backend.modules.sheetimport import corpus

    first = corpus.core_bundle()
    assert corpus.core_bundle() is first
    assert corpus._load_core_bundle.cache_info().misses <= 1


# ---------------------------------------------------------------------------
# C. MIDI at sounding pitch
# ---------------------------------------------------------------------------


def test_a_b_flat_clarinet_exports_at_sounding_pitch(library, tmp_path):
    client = library["client"]
    r = _upload(client, _write_fixture(tmp_path, ".mxl"))
    assert r.status_code == 200, r.text
    entry_id = r.json()["entry_id"]
    sheet = next(a for a in _artifacts(client, entry_id) if a["kind"] == "musicxml")

    caps = client.get("/api/notation").json()
    assert "midi" in caps["formats"]

    exported = client.post(
        f"/api/notation/{entry_id}/export",
        json={"source_artifact_id": sheet["id"], "format": "midi"},
    )
    assert exported.status_code == 200, exported.text
    artifact = exported.json()["artifact"]
    assert artifact["kind"] == "midi"
    midi = pretty_midi.PrettyMIDI(artifact["path"])
    (clarinet,) = midi.instruments
    # Written D5 E5 F5 sound a whole step lower: C5 D5 Eb5.
    assert [n.pitch for n in clarinet.notes] == [72, 74, 75]
    assert clarinet.program == 71
    assert clarinet.name == "Clarinet in Bb"
    # The tempo map and the meter map.
    _times, tempi = midi.get_tempo_changes()
    assert [round(t) for t in tempi] == [90, 120]
    assert [(ts.numerator, ts.denominator) for ts in midi.time_signature_changes] == [
        (4, 4),
        (3, 4),
    ]
    # Registered beside the sheet, which stays at written pitch.
    listed = {a["id"]: a for a in _artifacts(client, entry_id)}
    assert artifact["id"] in listed
    assert json.loads(listed[artifact["id"]]["metadata_json"])["sounding_pitch"] is True


def test_one_part_exports_as_its_own_sounding_midi(library, tmp_path):
    from music21 import instrument, metadata, note, stream

    score = stream.Score()
    score.insert(0, metadata.Metadata(title="Duet", composer=COMPOSER))
    for name, inst, pitch in (
        ("Horn", instrument.Horn(), "C5"),
        ("Flute", instrument.Flute(), "C5"),
    ):
        part = stream.Part()
        part.partName = name
        part.insert(0, inst)
        part.append(note.Note(pitch, quarterLength=4))
        score.insert(0, part)
    score.atSoundingPitch = False
    path = tmp_path / "duet.musicxml"
    score.write("musicxml", fp=str(path))

    client = library["client"]
    entry_id = _upload(client, path).json()["entry_id"]
    sheet = next(a for a in _artifacts(client, entry_id) if a["kind"] == "musicxml")
    r = client.post(
        f"/api/notation/{entry_id}/export",
        json={
            "source_artifact_id": sheet["id"],
            "format": "midi",
            "options": {"parts": [0]},
        },
    )
    assert r.status_code == 200, r.text
    midi = pretty_midi.PrettyMIDI(r.json()["artifact"]["path"])
    (horn,) = midi.instruments
    # A horn in F sounds a fifth below the page: written C5 is F4.
    assert [n.pitch for n in horn.notes] == [65]
    assert horn.name == "Horn"
    assert r.json()["artifact"]["id"].endswith("__midi__p0")


# ---------------------------------------------------------------------------
# Route guards, as the neighbouring upload and file-writing routes have them
# ---------------------------------------------------------------------------


def test_a_lan_caller_without_a_token_is_refused(library, tmp_path):
    lan = TestClient(library["app"], client=("10.20.30.40", 51000))
    fixture = _write_fixture(tmp_path, ".abc")
    assert _upload(lan, fixture).status_code == 403
    assert (
        lan.post(
            "/api/notation/corpus/open", json={"id": "bach_bwv66_6_mxl"}
        ).status_code
        == 403
    )
    assert _score_entries(library["store"]) == []


def test_a_paired_lan_caller_can_import(library, tmp_path):
    lan = TestClient(library["app"], client=("10.20.30.40", 51000))
    r = _upload(
        lan,
        _write_fixture(tmp_path, ".abc"),
        headers={pairing.HEADER: pairing.get_token()},
    )
    assert r.status_code == 200, r.text


def test_a_page_outside_thedaw_is_refused(library, tmp_path):
    r = _upload(
        library["client"],
        _write_fixture(tmp_path, ".abc"),
        headers={"origin": "https://evil.example", "sec-fetch-site": "cross-site"},
    )
    assert r.status_code == 403
    assert _score_entries(library["store"]) == []


def test_upload_guards(library, tmp_path, monkeypatch):
    client, store = library["client"], library["store"]
    text = tmp_path / "notes.txt"
    text.write_text("not a score", encoding="utf-8")
    assert _upload(client, text).status_code == 415

    empty = tmp_path / "empty.musicxml"
    empty.write_bytes(b"")
    assert _upload(client, empty).status_code == 400

    with monkeypatch.context() as patched:
        patched.setattr(score_import, "MAX_IMPORT_BYTES", 64)
        assert _upload(client, _write_fixture(tmp_path, ".abc")).status_code == 413

    broken = tmp_path / "broken.musicxml"
    broken.write_text("<score-partwise><part", encoding="utf-8")
    assert _upload(client, broken).status_code == 422
    # A refused import leaves nothing behind.
    assert _score_entries(store) == []

    # Only the last component of the uploaded name is read: a path in it
    # cannot place a file outside the new entry.
    r = _upload(
        client, _write_fixture(tmp_path, ".abc"), name="..\\..\\escape/../x.abc"
    )
    assert r.status_code == 200, r.text
    entry_dir = store._dir_for(r.json()["entry_id"])
    for artifact in _artifacts(client, r.json()["entry_id"]):
        assert Path(artifact["path"]).parent == entry_dir / "notation"
    assert not (tmp_path / "x.abc").exists()


def _declaring_zip(declared: int) -> bytes:
    """A small .mxl whose one member says it unpacks to ``declared`` bytes:
    the size fields of its local and central headers are rewritten, the way
    a zip bomb states a size its few compressed bytes never hold."""
    import io
    import struct

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("score.musicxml", b"<score-partwise/>")
    raw = bytearray(buf.getvalue())
    local = raw.find(b"PK\x03\x04")
    central = raw.find(b"PK\x01\x02")
    struct.pack_into("<I", raw, local + 22, declared)
    struct.pack_into("<I", raw, central + 24, declared)
    return bytes(raw)


def test_an_mxl_that_unpacks_past_the_ceiling_is_refused(library, tmp_path):
    """The archive's directory is read before music21 unzips it: members that
    declare more than four times MAX_IMPORT_BYTES answer 413, and nothing is
    written."""
    bomb = tmp_path / "bomb.mxl"
    bomb.write_bytes(_declaring_zip(4 * score_import.MAX_IMPORT_BYTES + 1))
    assert bomb.stat().st_size < 1024

    r = _upload(library["client"], bomb)

    assert r.status_code == 413, r.text
    assert "unpacks" in r.json()["detail"]
    assert _score_entries(library["store"]) == []


def test_an_mxl_holding_another_archive_is_refused(library, tmp_path):
    import io

    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w") as zf:
        zf.writestr("score.musicxml", b"<score-partwise/>")
    for member in ("nested.zip", "score.musicxml"):
        outer = tmp_path / f"outer-{member}.mxl"
        with zipfile.ZipFile(outer, "w") as zf:
            zf.writestr(member, inner.getvalue())

        r = _upload(library["client"], outer, name="outer.mxl")

        assert r.status_code == 422, (member, r.text)
        assert "another archive" in r.json()["detail"], member
    assert _score_entries(library["store"]) == []


def test_the_sheet_parser_refuses_the_same_mxl(tmp_path):
    """The roll's own score import (``/api/sheetimport/parse``) reads .mxl
    through the same check."""
    from backend.modules.sheetimport import router as sheetimport_router

    app = FastAPI()
    app.include_router(sheetimport_router.router, prefix="/api/sheetimport")
    client = TestClient(app, client=("127.0.0.1", 51000))
    r = client.post(
        "/api/sheetimport/parse",
        files={
            "file": (
                "bomb.mxl",
                _declaring_zip(4 * score_import.MAX_IMPORT_BYTES + 1),
                "application/octet-stream",
            )
        },
    )
    assert r.status_code == 413, r.text


def test_mxl_original_is_served_as_compressed_musicxml(library, tmp_path):
    client = library["client"]
    entry_id = _upload(client, _write_fixture(tmp_path, ".mxl")).json()["entry_id"]
    original = next(a for a in _artifacts(client, entry_id) if a["kind"] == "mxl")
    r = client.get(f"/api/notation/file/{original['id']}")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/vnd.recordare.musicxml")
    with zipfile.ZipFile(Path(original["path"])) as archive:
        assert "META-INF/container.xml" in archive.namelist()
