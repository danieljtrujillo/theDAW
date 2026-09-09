"""The standalone lyric documents behind the LYRIC tab: CRUD, the library
entry a draft can be attached to or imported from, the analysis stored beside
the document — and, above all, that a document id can never name a file
outside the notebook directory.

Everything runs against a tmp notebook root (``theDAW_LYRIC_DOCS_DIR``) and a
tmp library root, so no test can see this machine's own drafts.
"""

from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.core.jobs import create_job
from backend.modules.library import router as library_router_module
from backend.modules.lyricanalysis import documents
from backend.modules.lyricanalysis import router as analysis_router_module
from backend.modules.lyricanalysis import service
from backend.modules.lyricanalysis.schema import (
    ANALYZER_VERSION,
    Device,
    LyricAnalysisDoc,
    LyricMark,
)
from backend.modules.lyrics import router as lyrics_router_module
from tests.test_library_store import _seed_generate_entry

LYRIC = "The city breathes a silver light\nThe city bleeds a silver night"

# Ids no request may ever turn into a path. The route must 404 and the store
# must refuse before it touches the filesystem.
EVIL_IDS = [
    "../secret",
    "..",
    "../../etc/passwd",
    "..%2F..%2Fsecret",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    "lyricdoc_../aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "lyricdoc_\x00" + "a" * 31,
    "lyricdoc_" + "a" * 4096,
    "lyricdoc_" + "ｆ" * 32,  # fullwidth unicode that reads like hex
    "lyricdoc_" + "F" * 32,  # uppercase: a different file on Linux
    "lyricdoc_" + "z" * 32,  # not hex
    "lyricdoc_",
    "",
    "nope",
]


@pytest.fixture
def notebook(tmp_path: Path, monkeypatch) -> Path:
    root = tmp_path / "notebook"
    monkeypatch.setenv("theDAW_LYRIC_DOCS_DIR", str(root))
    return root


@pytest.fixture
def client(tmp_path: Path, notebook: Path, monkeypatch) -> TestClient:
    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path / "generations"))
    # The job registry is in-process and keyed by subject id; a stale job would
    # leak into the next test's "already running" check.
    service._active_jobs.clear()
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    app.include_router(lyrics_router_module.router, prefix="/api/lyrics")
    app.include_router(analysis_router_module.router, prefix="/api/lyricanalysis")
    return TestClient(app)


def _seed_entry(tmp_path: Path, client: TestClient, job: str = "doc_test") -> str:
    _seed_generate_entry(tmp_path / "generations", job, 0)
    ids = [e["id"] for e in client.get("/api/library/entries").json()["entries"]]
    return next(i for i in ids if i.startswith(job))


def _create(client: TestClient, **body) -> dict:
    r = client.post("/api/lyricanalysis/documents", json=body)
    assert r.status_code == 200, r.text
    return r.json()


# ---- ids and paths -----------------------------------------------------------


def test_minted_ids_are_the_only_shape_accepted():
    doc_id = documents.new_id()
    assert doc_id.startswith(documents.ID_PREFIX)
    assert documents.is_document_id(doc_id)
    assert documents.new_id() != doc_id
    for bad in EVIL_IDS:
        assert not documents.is_document_id(bad), bad
    # Not a string at all (a JSON body could hand us anything).
    for bad_type in (None, 12, ["lyricdoc_" + "a" * 32], {"id": 1}):
        assert not documents.is_document_id(bad_type)


def test_the_store_refuses_a_path_before_touching_the_disk(notebook: Path):
    for bad in EVIL_IDS:
        with pytest.raises(KeyError):
            documents._doc_path(bad)
        with pytest.raises(KeyError):
            documents._analysis_path(bad)
        assert documents.load(bad) is None
        assert documents.load_analysis(bad) is None
        assert documents.delete(bad) is False
        with pytest.raises(KeyError):
            documents.delete_analysis(bad)
    # Nothing was created anywhere by any of that.
    assert not notebook.exists()


def _pct(raw: str) -> str:
    """Percent-encode every byte, so the id arrives at the handler exactly as
    written: no client-side normalisation of ``..``, no rejected NUL, no
    ``/`` splitting it into two segments. This is the hostile request."""
    return "".join(f"%{b:02X}" for b in raw.encode("utf-8"))


def test_every_document_route_404s_on_a_traversal_id(client, notebook: Path):
    for bad in EVIL_IDS:
        if not bad:
            continue
        path = f"/api/lyricanalysis/documents/{_pct(bad)}"
        assert client.get(path).status_code == 404, bad
        assert client.put(path, json={"text": "x"}).status_code == 404, bad
        assert client.post(f"{path}/duplicate").status_code == 404, bad
        assert (
            client.post(f"{path}/attach", json={"entry_id": "nope"}).status_code == 404
        ), bad
        assert client.get(f"/api/lyricanalysis/{_pct(bad)}").status_code == 404, bad
        # DELETE is idempotent, so the id gate answers "nothing removed" rather
        # than 404 — unless the router refused the path first, which it does
        # for anything that decodes into extra segments (ASGI hands the router
        # an already-decoded path). Either way nothing is deleted.
        deleted = client.delete(path)
        assert deleted.status_code == 404 or deleted.json()["ok"] is False, bad
    assert not notebook.exists()


def test_a_document_id_that_does_not_exist_is_a_404_not_a_write(client, notebook):
    missing = documents.new_id()
    assert client.get(f"/api/lyricanalysis/documents/{missing}").status_code == 404
    assert (
        client.put(
            f"/api/lyricanalysis/documents/{missing}", json={"text": "x"}
        ).status_code
        == 404
    )
    assert client.get(f"/api/lyricanalysis/{missing}").status_code == 404
    assert client.get(f"/api/lyricanalysis/{missing}/job").status_code == 404
    assert client.post(f"/api/lyricanalysis/{missing}/run", json={}).status_code == 404
    assert not (notebook / f"{missing}.json").exists()


# ---- route ordering ----------------------------------------------------------


def test_documents_and_the_entry_route_both_resolve(client, tmp_path):
    """``/documents`` must not be swallowed by ``/{entry_id}``, and adding it
    must not have shadowed the entry route either."""
    eid = _seed_entry(tmp_path, client)
    listed = client.get("/api/lyricanalysis/documents")
    assert listed.status_code == 200 and listed.json() == {"documents": []}
    entry = client.get(f"/api/lyricanalysis/{eid}")
    assert entry.status_code == 200
    assert entry.json() == {"doc": None, "persisted": False, "stale": False}
    # And the literal word "documents" as an entry id is still an unknown entry,
    # not a list — the parametrised route is what answers a second segment.
    assert client.get("/api/lyricanalysis/documents/x").status_code == 404
    assert client.get("/api/lyricanalysis/nope").status_code == 404


# ---- CRUD --------------------------------------------------------------------


def test_create_read_update_delete_roundtrip(client, notebook: Path):
    doc = _create(client, title="  Silver   Night  ", text=LYRIC)
    assert documents.is_document_id(doc["id"])
    # The title is squeezed, not trusted verbatim.
    assert doc["title"] == "Silver Night"
    assert doc["entry_id"] == "" and doc["created_at"] > 0
    path = notebook / f"{doc['id']}.json"
    assert path.is_file()
    assert json.loads(path.read_text(encoding="utf-8"))["text"] == LYRIC
    # No temp file survives the atomic write.
    assert list(notebook.glob("*.tmp")) == []

    got = client.get(f"/api/lyricanalysis/documents/{doc['id']}").json()
    assert got["text"] == LYRIC and got["title"] == "Silver Night"

    updated = client.put(
        f"/api/lyricanalysis/documents/{doc['id']}",
        json={"text": LYRIC + "\nAnd the river answers back"},
    ).json()
    assert updated["text"].endswith("answers back")
    assert updated["title"] == "Silver Night"  # untouched fields stay put
    assert updated["updated_at"] >= doc["updated_at"]

    r = client.delete(f"/api/lyricanalysis/documents/{doc['id']}")
    assert r.status_code == 200 and r.json()["ok"] is True
    assert not path.exists()
    assert client.get(f"/api/lyricanalysis/documents/{doc['id']}").status_code == 404


def test_an_untitled_document_still_gets_a_name(client):
    assert _create(client)["title"] == documents.DEFAULT_TITLE
    assert _create(client, title="   ")["title"] == documents.DEFAULT_TITLE


def test_a_very_long_title_is_bounded(client):
    doc = _create(client, title="x" * 5000)
    assert len(doc["title"]) == documents.MAX_TITLE


def test_list_reports_the_switcher_row(client):
    first = _create(client, title="One", text="[Chorus]\nalpha beta\n\n\ngamma")
    second = _create(client, title="Two", text="")
    rows = client.get("/api/lyricanalysis/documents").json()["documents"]
    assert [r["id"] for r in rows] == [second["id"], first["id"]]  # newest first
    row = next(r for r in rows if r["id"] == first["id"])
    # Markers and blank lines are not lyric lines.
    assert row["lines"] == 2 and row["words"] == 3
    assert row["entry_id"] is None and row["analyzed"] is False
    assert row["updated_at"] > 0


def test_duplicate_copies_the_words_and_drops_the_song(client, tmp_path):
    eid = _seed_entry(tmp_path, client)
    doc = _create(client, title="Verse", text=LYRIC, entry_id=eid)
    copy = client.post(f"/api/lyricanalysis/documents/{doc['id']}/duplicate").json()
    assert copy["id"] != doc["id"]
    assert copy["text"] == LYRIC and copy["title"] == "Verse copy"
    # A variation is not the same song's lyrics until the writer says so.
    assert copy["entry_id"] == ""
    assert len(client.get("/api/lyricanalysis/documents").json()["documents"]) == 2


def test_a_corrupt_document_reads_as_absent(client, notebook: Path):
    doc = _create(client, text=LYRIC)
    (notebook / f"{doc['id']}.json").write_text("{not json", encoding="utf-8")
    assert client.get(f"/api/lyricanalysis/documents/{doc['id']}").status_code == 404
    assert client.get("/api/lyricanalysis/documents").json()["documents"] == []


def test_writing_a_document_creates_no_library_entry(client, notebook):
    _create(client, text=LYRIC)
    assert client.get("/api/library/entries").json()["entries"] == []


# ---- the song a draft can become ---------------------------------------------


def test_attach_records_the_link_without_touching_the_song(client, tmp_path):
    eid = _seed_entry(tmp_path, client)
    doc = _create(client, title="Draft", text=LYRIC)
    attached = client.post(
        f"/api/lyricanalysis/documents/{doc['id']}/attach", json={"entry_id": eid}
    ).json()
    assert attached["entry_id"] == eid
    assert client.get(f"/api/lyrics/{eid}").json()["doc"]["text"] == ""
    row = client.get("/api/lyricanalysis/documents").json()["documents"][0]
    assert row["entry_id"] == eid


def test_attach_can_write_the_words_into_the_entrys_lyrics(client, tmp_path):
    eid = _seed_entry(tmp_path, client)
    doc = _create(client, title="Draft", text=LYRIC)
    r = client.post(
        f"/api/lyricanalysis/documents/{doc['id']}/attach",
        json={"entry_id": eid, "write_lyrics": True},
    )
    assert r.status_code == 200 and r.json()["entry_id"] == eid
    bundle = client.get(f"/api/lyrics/{eid}").json()
    assert bundle["persisted"] is True and bundle["doc"]["text"] == LYRIC
    assert [ln["text"] for ln in bundle["doc"]["lines"]] == LYRIC.split("\n")


def test_attach_to_an_unknown_entry_404s(client):
    doc = _create(client, text=LYRIC)
    r = client.post(
        f"/api/lyricanalysis/documents/{doc['id']}/attach", json={"entry_id": "nope"}
    )
    assert r.status_code == 404


def test_detach_by_putting_an_empty_entry_id(client, tmp_path):
    eid = _seed_entry(tmp_path, client)
    doc = _create(client, text=LYRIC, entry_id=eid)
    detached = client.put(
        f"/api/lyricanalysis/documents/{doc['id']}", json={"entry_id": ""}
    ).json()
    assert detached["entry_id"] == ""


def test_import_seeds_a_new_document_from_the_entrys_lyrics(client, tmp_path):
    eid = _seed_entry(tmp_path, client)
    client.put(f"/api/lyrics/{eid}", json={"text": LYRIC})
    doc = client.post("/api/lyricanalysis/documents/import", json={"entry_id": eid})
    assert doc.status_code == 200, doc.text
    body = doc.json()
    assert body["text"] == LYRIC and body["entry_id"] == eid and body["title"]
    # Editing the copy leaves the song's own lyrics where they were.
    client.put(f"/api/lyricanalysis/documents/{body['id']}", json={"text": "rewritten"})
    assert client.get(f"/api/lyrics/{eid}").json()["doc"]["text"] == LYRIC


def test_import_from_an_unknown_entry_404s(client):
    r = client.post("/api/lyricanalysis/documents/import", json={"entry_id": "nope"})
    assert r.status_code == 404


# ---- the analysis of a document ----------------------------------------------


def test_analysis_is_absent_until_it_is_run(client):
    doc = _create(client, text=LYRIC)
    body = client.get(f"/api/lyricanalysis/{doc['id']}").json()
    assert body == {"doc": None, "persisted": False, "stale": False}
    assert client.get(f"/api/lyricanalysis/{doc['id']}/job").json() == {"job": None}


def test_run_analyses_the_documents_own_words(client, notebook: Path):
    doc = _create(client, text=LYRIC)
    job = create_job("lyricanalysis", "analyse")
    asyncio.run(documents.run_analysis(job, doc["id"], {}))
    assert job.status == "done", job.error
    analysis = LyricAnalysisDoc.model_validate(job.result)
    assert analysis.devices and analysis.entry_id == doc["id"]
    stored = notebook / documents.ANALYSIS_DIRNAME / f"{doc['id']}.json"
    assert stored.is_file()
    body = client.get(f"/api/lyricanalysis/{doc['id']}").json()
    assert body["persisted"] is True and body["stale"] is False
    assert body["doc"]["stats"]["lines"] == 2
    # The words are anchored to the document, not to any entry folder.
    assert list((notebook).glob("*.tmp")) == []


def test_run_on_an_empty_document_fails_the_job(client):
    doc = _create(client, text="[Chorus]\n\n")
    job = create_job("lyricanalysis", "analyse")
    asyncio.run(documents.run_analysis(job, doc["id"], {}))
    assert job.status == "failed" and "no lyrics" in job.message


def test_unforced_rerun_reuses_the_stored_analysis(client, notebook: Path):
    doc = _create(client, text=LYRIC)
    asyncio.run(documents.run_analysis(create_job("lyricanalysis", "a"), doc["id"], {}))
    stored = notebook / documents.ANALYSIS_DIRNAME / f"{doc['id']}.json"
    written = stored.stat().st_mtime_ns
    job = create_job("lyricanalysis", "a")
    asyncio.run(documents.run_analysis(job, doc["id"], {}))
    assert job.status == "done" and "already up to date" in job.message
    assert stored.stat().st_mtime_ns == written


def test_editing_the_draft_makes_its_analysis_stale(client):
    doc = _create(client, text=LYRIC)
    asyncio.run(documents.run_analysis(create_job("lyricanalysis", "a"), doc["id"], {}))
    assert client.get(f"/api/lyricanalysis/{doc['id']}").json()["stale"] is False
    client.put(
        f"/api/lyricanalysis/documents/{doc['id']}",
        json={"text": LYRIC + "\nAnd the river answers back"},
    )
    assert client.get(f"/api/lyricanalysis/{doc['id']}").json()["stale"] is True
    job = create_job("lyricanalysis", "a")
    asyncio.run(documents.run_analysis(job, doc["id"], {}))
    assert "already up to date" not in job.message
    assert client.get(f"/api/lyricanalysis/{doc['id']}").json()["stale"] is False


def test_stale_when_the_analyzer_moved_on(client, notebook: Path):
    doc = _create(client, text=LYRIC)
    asyncio.run(documents.run_analysis(create_job("lyricanalysis", "a"), doc["id"], {}))
    path = notebook / documents.ANALYSIS_DIRNAME / f"{doc['id']}.json"
    stored = json.loads(path.read_text(encoding="utf-8"))
    stored["analyzer_version"] = ANALYZER_VERSION - 1
    path.write_text(json.dumps(stored), encoding="utf-8")
    assert client.get(f"/api/lyricanalysis/{doc['id']}").json()["stale"] is True


def test_a_corrupt_analysis_reads_as_never_run(client, notebook: Path):
    doc = _create(client, text=LYRIC)
    asyncio.run(documents.run_analysis(create_job("lyricanalysis", "a"), doc["id"], {}))
    path = notebook / documents.ANALYSIS_DIRNAME / f"{doc['id']}.json"
    path.write_text("{not json", encoding="utf-8")
    assert client.get(f"/api/lyricanalysis/{doc['id']}").json() == {
        "doc": None,
        "persisted": False,
        "stale": False,
    }


def test_run_route_starts_one_job_and_joins_the_second_caller(client, monkeypatch):
    doc = _create(client, text=LYRIC)
    started: list[tuple] = []
    monkeypatch.setattr(
        documents, "start_run", lambda job, doc_id, req: started.append((job, doc_id))
    )
    first = client.post(f"/api/lyricanalysis/{doc['id']}/run", json={}).json()
    assert first["ok"] is True and first["reused"] is False
    second = client.post(f"/api/lyricanalysis/{doc['id']}/run", json={}).json()
    assert second["reused"] is True and second["job"]["id"] == first["job"]["id"]
    assert len(started) == 1 and started[0][1] == doc["id"]
    running = client.get(f"/api/lyricanalysis/{doc['id']}/job").json()
    assert running["job"]["id"] == first["job"]["id"]


def test_deleting_the_analysis_leaves_the_words(client, notebook: Path):
    doc = _create(client, text=LYRIC)
    asyncio.run(documents.run_analysis(create_job("lyricanalysis", "a"), doc["id"], {}))
    r = client.delete(f"/api/lyricanalysis/{doc['id']}")
    assert r.status_code == 200 and r.json()["ok"] is True
    assert not (notebook / documents.ANALYSIS_DIRNAME / f"{doc['id']}.json").exists()
    assert (
        client.get(f"/api/lyricanalysis/documents/{doc['id']}").json()["text"] == LYRIC
    )
    # Deleting again is a no-op, not an error.
    assert client.delete(f"/api/lyricanalysis/{doc['id']}").json()["ok"] is False


def test_deleting_the_document_takes_its_analysis_with_it(client, notebook: Path):
    doc = _create(client, text=LYRIC)
    asyncio.run(documents.run_analysis(create_job("lyricanalysis", "a"), doc["id"], {}))
    assert (
        client.delete(f"/api/lyricanalysis/documents/{doc['id']}").json()["ok"] is True
    )
    assert not (notebook / documents.ANALYSIS_DIRNAME / f"{doc['id']}.json").exists()
    assert client.get(f"/api/lyricanalysis/{doc['id']}").status_code == 404


# ---- the writer's own marks --------------------------------------------------
#
# LYRIC is two lines of six words each:
#   0: The city breathes a silver light
#   1: The city bleeds   a silver night


def _put_marks(client: TestClient, doc_id: str, marks: list[dict], expect: int = 200):
    """``LyricMark.id`` is a required field, so a new mark still has to carry
    one — it is just never believed: the server mints an id unless the one sent
    names a mark it already stored."""
    body = [{"id": "", **m} for m in marks]
    r = client.put(f"/api/lyricanalysis/documents/{doc_id}/marks", json={"marks": body})
    assert r.status_code == expect, r.text
    return r.json()


def _marks_path(notebook: Path, doc_id: str) -> Path:
    return notebook / documents.MARKS_DIRNAME / f"{doc_id}.json"


def test_marks_roundtrip_with_ids_minted_here(client, notebook: Path):
    doc = _create(client, text=LYRIC)
    body = _put_marks(
        client,
        doc["id"],
        [
            {
                "id": "../../etc/passwd",
                "kind": "internal-rhyme",
                "label": "  light   night  ",
                "spans": [
                    {"line": 0, "word": 5, "text": "whatever the client said"},
                    {"line": 1, "word": 5},
                ],
                "note": "the pair I hear",
            }
        ],
    )
    assert body["dropped"] == 0 and body["stale"] == []
    mark = body["marks"][0]
    # The id came from here, not from the request.
    assert documents.is_mark_id(mark["id"])
    assert mark["label"] == "light night" and mark["verdict"] == "mark"
    # The span text is the document's, never the request's: it is the only
    # thing that can tell us later that the words moved.
    assert [s["text"] for s in mark["spans"]] == ["light", "night"]
    assert mark["created_at"] > 0 and mark["updated_at"] > 0
    assert _marks_path(notebook, doc["id"]).is_file()
    assert list((notebook / documents.MARKS_DIRNAME).glob("*.tmp")) == []
    got = client.get(f"/api/lyricanalysis/documents/{doc['id']}/marks").json()
    assert got["marks"] == body["marks"] and got["stale"] == []
    assert got["updated_at"] == mark["updated_at"]


def test_resaving_the_set_keeps_ids_and_untouched_timestamps(client):
    doc = _create(client, text=LYRIC)
    first = _put_marks(
        client, doc["id"], [{"kind": "end-rhyme", "spans": [{"line": 0, "word": 5}]}]
    )["marks"][0]
    again = _put_marks(client, doc["id"], [first])["marks"][0]
    assert again["id"] == first["id"]
    # The editor PUTs the whole set on every save; a mark nobody touched must
    # not claim it was just edited.
    assert again["updated_at"] == first["updated_at"]
    edited = _put_marks(client, doc["id"], [dict(first, note="now with a note")])[
        "marks"
    ][0]
    assert edited["id"] == first["id"] and edited["created_at"] == first["created_at"]
    assert edited["updated_at"] > first["updated_at"]


def test_a_mark_id_that_names_nothing_is_replaced_not_trusted(client):
    doc = _create(client, text=LYRIC)
    fake = documents.new_mark_id()
    body = _put_marks(
        client, doc["id"], [{"id": fake, "spans": [{"line": 0, "word": 1}]}]
    )
    assert body["marks"][0]["id"] != fake
    # Two marks claiming one id stay two marks.
    kept = body["marks"][0]
    two = _put_marks(client, doc["id"], [kept, dict(kept, note="second")])["marks"]
    assert len({m["id"] for m in two}) == 2


def test_a_span_that_names_no_word_is_never_stored(client):
    doc = _create(client, text=LYRIC)
    body = _put_marks(
        client,
        doc["id"],
        [
            {"label": "negative line", "spans": [{"line": -1, "word": 0}]},
            {"label": "line past the end", "spans": [{"line": 99, "word": 0}]},
            {"label": "negative word", "spans": [{"line": 0, "word": -3}]},
            {"label": "word past the line", "spans": [{"line": 0, "word": 400}]},
            {
                "label": "half real",
                "spans": [{"line": 0, "word": 400}, {"line": 1, "word": 0}],
            },
            {"label": "a note on the whole lyric", "spans": []},
        ],
    )
    kept = {m["label"]: m for m in body["marks"]}
    assert set(kept) == {"half real", "a note on the whole lyric"}
    assert body["dropped"] == 4
    # Only the anchor that exists survived, and it carries the real word.
    assert kept["half real"]["spans"] == [
        {"line": 1, "word": 0, "char_start": 0, "char_end": None, "text": "The"}
    ]


def test_character_offsets_are_clamped_into_the_word(client):
    doc = _create(client, text=LYRIC)
    body = _put_marks(
        client,
        doc["id"],
        [
            {"spans": [{"line": 0, "word": 2, "char_start": 900, "char_end": 4000}]},
            {"spans": [{"line": 0, "word": 2, "char_start": 4}]},
        ],
    )
    over, tail = (m["spans"][0] for m in body["marks"])
    # Clamped INTO the word, never down to nothing: a span covering no
    # characters carries no text, and a span with no text is an anchor that
    # verifies nothing — it holds against whatever word later lands at that
    # index, so the mark could never be found stale.
    assert over["char_start"] == len("breathes") - 1
    assert over["char_end"] == len("breathes")
    assert over["text"] == "s"
    assert tail["char_start"] == 4 and tail["text"] == "thes"


def test_an_anchor_is_never_clamped_down_to_nothing(client):
    doc = _create(client, text=LYRIC)
    body = _put_marks(
        client, doc["id"], [{"spans": [{"line": 0, "word": 2, "char_start": 900}]}]
    )
    assert body["marks"][0]["spans"][0]["text"] == "s"
    # And because it still says something, the words moving out from under it
    # is something the store can see.
    client.put(
        f"/api/lyricanalysis/documents/{doc['id']}",
        json={"text": "The city inhales a silver light\n" + LYRIC.split("\n")[1]},
    )
    got = client.get(f"/api/lyricanalysis/documents/{doc['id']}/marks").json()
    assert got["stale"] == [body["marks"][0]["id"]]


def test_a_mark_cannot_carry_unbounded_spans(client):
    doc = _create(client, text=LYRIC)
    body = _put_marks(client, doc["id"], [{"spans": [{"line": 0, "word": 0}] * 500}])
    assert len(body["marks"][0]["spans"]) == documents.MAX_SPANS_PER_MARK


def test_an_unknown_verdict_is_refused(client):
    doc = _create(client, text=LYRIC)
    r = client.put(
        f"/api/lyricanalysis/documents/{doc['id']}/marks",
        json={"marks": [{"id": "", "verdict": "delete-everything"}]},
    )
    assert r.status_code == 422


# ---- marks against an edit of the lyric --------------------------------------


def test_a_mark_follows_the_words_when_a_line_is_inserted(client, notebook: Path):
    doc = _create(client, text=LYRIC)
    mark = _put_marks(
        client, doc["id"], [{"kind": "end-rhyme", "spans": [{"line": 1, "word": 5}]}]
    )["marks"][0]
    assert mark["spans"][0]["line"] == 1
    client.put(
        f"/api/lyricanalysis/documents/{doc['id']}",
        json={"text": "A new opening line\n" + LYRIC},
    )
    got = client.get(f"/api/lyricanalysis/documents/{doc['id']}/marks").json()
    moved = got["marks"][0]
    assert got["stale"] == []
    assert moved["spans"][0]["line"] == 2 and moved["spans"][0]["text"] == "night"
    # Following the words is not an edit by the writer.
    assert moved["id"] == mark["id"] and moved["updated_at"] == mark["updated_at"]
    # The repair is written back, so the next edit shifts from where it is now
    # rather than stacking another delta onto the original anchor.
    stored = json.loads(_marks_path(notebook, doc["id"]).read_text(encoding="utf-8"))
    assert stored["marks"][0]["spans"][0]["line"] == 2
    client.put(
        f"/api/lyricanalysis/documents/{doc['id']}",
        json={"text": "Another one\nA new opening line\n" + LYRIC},
    )
    again = client.get(f"/api/lyricanalysis/documents/{doc['id']}/marks").json()
    assert again["stale"] == [] and again["marks"][0]["spans"][0]["line"] == 3


def test_a_mark_spanning_two_lines_moves_as_one(client):
    doc = _create(client, text=LYRIC)
    _put_marks(
        client,
        doc["id"],
        [{"spans": [{"line": 0, "word": 5}, {"line": 1, "word": 5}]}],
    )
    client.put(
        f"/api/lyricanalysis/documents/{doc['id']}",
        json={"text": "[Chorus]\n" + LYRIC},
    )
    got = client.get(f"/api/lyricanalysis/documents/{doc['id']}/marks").json()
    assert got["stale"] == []
    assert [s["line"] for s in got["marks"][0]["spans"]] == [1, 2]
    assert [s["text"] for s in got["marks"][0]["spans"]] == ["light", "night"]


def test_a_rewritten_line_leaves_its_mark_stale(client):
    doc = _create(client, text=LYRIC)
    mark = _put_marks(
        client, doc["id"], [{"kind": "end-rhyme", "spans": [{"line": 1, "word": 5}]}]
    )["marks"][0]
    client.put(
        f"/api/lyricanalysis/documents/{doc['id']}",
        json={
            "text": "The city breathes a silver light\nAnd nothing rhymes with orange"
        },
    )
    got = client.get(f"/api/lyricanalysis/documents/{doc['id']}/marks").json()
    assert got["stale"] == [mark["id"]]
    # The anchor stays where the writer put it. It is never dragged onto
    # whatever now happens to sit at that index.
    span = got["marks"][0]["spans"][0]
    assert span["line"] == 1 and span["text"] == "night"


def test_a_deleted_line_pulls_the_mark_back_up(client):
    doc = _create(client, text="[Chorus]\n" + LYRIC)
    _put_marks(client, doc["id"], [{"spans": [{"line": 2, "word": 5}]}])
    client.put(f"/api/lyricanalysis/documents/{doc['id']}", json={"text": LYRIC})
    got = client.get(f"/api/lyricanalysis/documents/{doc['id']}/marks").json()
    assert got["stale"] == []
    assert got["marks"][0]["spans"][0]["line"] == 1


# A hook that appears twice, which is what a chorus IS. Re-anchoring by content
# alone cannot tell the two apart, so the search has to be bounded by something
# other than the words.
REFRAIN = "I learned to call an empty house a home"
SONG = "\n".join(
    [
        "[Verse 1]",
        "You left the porch light burning",
        "The kettle never whistled once",
        REFRAIN,
        "",
        "[Verse 2]",
        "The summer came and took the cold",
        "The kettle sings for someone else",
        REFRAIN,
    ]
)


def test_a_rewritten_hook_does_not_jump_to_the_other_chorus(client):
    """The mark is on the FIRST chorus. Rewriting that chorus must leave the
    mark stale where the writer put it — not walk it down the page onto the
    second chorus, which says the same words and which the writer never
    marked."""
    doc = _create(client, text=SONG)
    mark = _put_marks(
        client,
        doc["id"],
        [{"kind": "refrain", "spans": [{"line": 3, "word": w} for w in range(9)]}],
    )["marks"][0]
    client.put(
        f"/api/lyricanalysis/documents/{doc['id']}",
        json={"text": SONG.replace(REFRAIN + "\n", "I taught myself to leave\n", 1)},
    )
    got = client.get(f"/api/lyricanalysis/documents/{doc['id']}/marks").json()
    assert got["stale"] == [mark["id"]]
    assert {s["line"] for s in got["marks"][0]["spans"]} == {3}


def test_a_hook_mark_still_follows_a_real_insertion(client):
    """The bound above must not cost the ordinary case: the same duplicated
    hook, pushed down by a line the writer added, is still followed."""
    doc = _create(client, text=SONG)
    _put_marks(
        client,
        doc["id"],
        [{"kind": "refrain", "spans": [{"line": 3, "word": w} for w in range(9)]}],
    )
    client.put(
        f"/api/lyricanalysis/documents/{doc['id']}",
        json={"text": SONG.replace("[Verse 1]\n", "[Verse 1]\nA new first line\n", 1)},
    )
    got = client.get(f"/api/lyricanalysis/documents/{doc['id']}/marks").json()
    assert got["stale"] == []
    assert {s["line"] for s in got["marks"][0]["spans"]} == {4}


def test_saving_the_set_does_not_re_seat_a_stale_mark(client):
    """The editor owns the list and PUTs all of it on every save. That save
    must not be what quietly re-anchors a stale mark onto the words that
    replaced the writer's own."""
    doc = _create(client, text=LYRIC)
    mark = _put_marks(
        client,
        doc["id"],
        [{"spans": [{"line": 1, "word": 2}, {"line": 1, "word": 5}]}],
    )["marks"][0]
    assert [s["text"] for s in mark["spans"]] == ["bleeds", "night"]
    client.put(
        f"/api/lyricanalysis/documents/{doc['id']}",
        json={"text": LYRIC.split("\n")[0] + "\nA line about something else now"},
    )
    got = client.get(f"/api/lyricanalysis/documents/{doc['id']}/marks").json()
    assert got["stale"] == [mark["id"]]
    saved = _put_marks(client, doc["id"], got["marks"])["marks"][0]
    assert [s["text"] for s in saved["spans"]] == ["bleeds", "night"]
    assert saved["updated_at"] == mark["updated_at"]
    again = client.get(f"/api/lyricanalysis/documents/{doc['id']}/marks").json()
    assert again["stale"] == [mark["id"]]


def test_saving_the_set_does_not_delete_a_mark_whose_line_was_cut(client):
    """The harsher half of the same bug: when the marked line is gone rather
    than rewritten, re-reading the anchors off the page finds nothing at all,
    and an echoed-back mark would be dropped — the annotation destroyed by the
    act of saving."""
    doc = _create(client, text=LYRIC)
    mark = _put_marks(client, doc["id"], [{"spans": [{"line": 1, "word": 5}]}])[
        "marks"
    ][0]
    client.put(
        f"/api/lyricanalysis/documents/{doc['id']}",
        json={"text": LYRIC.split("\n")[0]},
    )
    got = client.get(f"/api/lyricanalysis/documents/{doc['id']}/marks").json()
    assert got["stale"] == [mark["id"]]
    saved = _put_marks(client, doc["id"], got["marks"])
    assert saved["dropped"] == 0
    assert [m["id"] for m in saved["marks"]] == [mark["id"]]
    assert saved["marks"][0]["spans"][0]["text"] == "night"


def test_moving_a_mark_yourself_still_re_reads_the_page(client):
    """The rule is narrow: only a mark whose anchors are UNCHANGED keeps its
    stored text. Re-placing one is the writer saying "it belongs here now", and
    that reads the words off the document, as it always did."""
    doc = _create(client, text=LYRIC)
    mark = _put_marks(client, doc["id"], [{"spans": [{"line": 1, "word": 5}]}])[
        "marks"
    ][0]
    mark["spans"] = [{"line": 0, "word": 5, "char_start": 0, "char_end": None}]
    moved = _put_marks(client, doc["id"], [mark])["marks"][0]
    assert moved["id"] == mark["id"]
    assert moved["spans"][0]["text"] == "light"


# ---- marks inside the analysis -----------------------------------------------


def test_a_mark_is_painted_beside_the_detected_devices(client):
    doc = _create(client, text=LYRIC)
    asyncio.run(documents.run_analysis(create_job("lyricanalysis", "a"), doc["id"], {}))
    detected = client.get(f"/api/lyricanalysis/{doc['id']}").json()["doc"]["devices"]
    mark = _put_marks(
        client,
        doc["id"],
        [
            {
                "kind": "internal-rhyme",
                "label": "breathes / bleeds",
                "verdict": "confirm",
                "note": "it lands on the beat",
                "spans": [{"line": 0, "word": 2}, {"line": 1, "word": 2}],
            }
        ],
    )["marks"][0]
    body = client.get(f"/api/lyricanalysis/{doc['id']}").json()
    devices = body["doc"]["devices"]
    mine = [d for d in devices if service.is_mark_device(Device.model_validate(d))]
    assert len(mine) == 1 and len(devices) == len(detected) + 1
    assert mine[0]["id"] == f"{service.MARK_DEVICE_PREFIX}{mark['id']}"
    assert mine[0]["group"].startswith(service.MARK_DEVICE_PREFIX)
    assert mine[0]["detail"] == "it lands on the beat"
    # A kind the taxonomy knows keeps its family, so it filters with its peers.
    assert mine[0]["family"] == "rhyme"
    # Device.source keeps the meaning it has always had; the prefix is what
    # tells a writer's mark from a detection.
    assert {d["source"] for d in devices} <= {"rules", "llm"}
    assert body["marks"] == {"total": 1, "stale": [], "painted": 1, "suppressed": 0}
    # The stats describe what is on the screen.
    assert body["doc"]["stats"]["devices_by_kind"]["internal-rhyme"] >= 1


def test_a_kind_the_taxonomy_has_no_word_for_gets_its_own_family(client):
    doc = _create(client, text=LYRIC)
    asyncio.run(documents.run_analysis(create_job("lyricanalysis", "a"), doc["id"], {}))
    _put_marks(
        client,
        doc["id"],
        [{"kind": "breath rhyme", "spans": [{"line": 0, "word": 1}]}],
    )
    devices = client.get(f"/api/lyricanalysis/{doc['id']}").json()["doc"]["devices"]
    mine = next(d for d in devices if service.is_mark_device(Device.model_validate(d)))
    assert mine["kind"] == "breath rhyme" and mine["family"] == service.MARK_FAMILY


def test_a_reject_suppresses_the_device_the_engine_got_wrong(client, notebook: Path):
    doc = _create(client, text=LYRIC)
    asyncio.run(documents.run_analysis(create_job("lyricanalysis", "a"), doc["id"], {}))
    before = client.get(f"/api/lyricanalysis/{doc['id']}").json()["doc"]["devices"]
    victim = next(d for d in before if d["group"])
    in_group = sum(1 for d in before if d["group"] == victim["group"])
    _put_marks(
        client,
        doc["id"],
        [
            {
                "verdict": "reject",
                "target_group": victim["group"],
                "note": "not a rhyme in my mouth",
            }
        ],
    )
    body = client.get(f"/api/lyricanalysis/{doc['id']}").json()
    assert all(d["group"] != victim["group"] for d in body["doc"]["devices"])
    assert len(body["doc"]["devices"]) == len(before) - in_group
    assert body["marks"]["suppressed"] == in_group and body["marks"]["painted"] == 0
    # A reject is a view, not a deletion: the stored analysis still has it.
    stored = json.loads(
        (notebook / documents.ANALYSIS_DIRNAME / f"{doc['id']}.json").read_text(
            encoding="utf-8"
        )
    )
    assert any(d["group"] == victim["group"] for d in stored["devices"])
    # And it survives a forced re-run, which re-mints every device id — which
    # is exactly why the reject names a group and not an id.
    job = create_job("lyricanalysis", "a")
    asyncio.run(documents.run_analysis(job, doc["id"], {"force": True}))
    assert all(d["group"] != victim["group"] for d in job.result["devices"])


def test_a_reject_can_name_a_groupless_device_by_its_id():
    """A device with no group can only be named by its id — and that id is a
    hash of the device's own content, so it is as stable as the words are."""
    doc = LyricAnalysisDoc(
        entry_id="x",
        devices=[
            Device(
                id="caesura-abc123", kind="caesura", family="structure", label="a break"
            ),
            Device(
                id="meter-def456",
                kind="meter",
                family="structure",
                label="iambic",
                group="meter-iambic",
            ),
        ],
    )
    merged = service.apply_marks(
        doc,
        [
            LyricMark(
                id=documents.new_mark_id(),
                verdict="reject",
                target_group="caesura-abc123",
            )
        ],
    )
    assert [d.id for d in merged.devices] == ["meter-def456"]
    assert merged.stats.devices_by_kind == {"meter": 1}
    # The document handed in is untouched.
    assert len(doc.devices) == 2


def test_a_rerun_never_overwrites_a_mark(client, notebook: Path):
    doc = _create(client, text=LYRIC)
    mark = _put_marks(
        client, doc["id"], [{"kind": "callback", "spans": [{"line": 1, "word": 4}]}]
    )["marks"][0]
    job = create_job("lyricanalysis", "a")
    asyncio.run(documents.run_analysis(job, doc["id"], {"force": True}))
    # The job hands back the merged view ...
    assert any(d["id"] == f"mark:{mark['id']}" for d in job.result["devices"])
    # ... and the file it saved holds detections only.
    stored = json.loads(
        (notebook / documents.ANALYSIS_DIRNAME / f"{doc['id']}.json").read_text(
            encoding="utf-8"
        )
    )
    assert not any(
        service.is_mark_device(Device.model_validate(d)) for d in stored["devices"]
    )
    marks = client.get(f"/api/lyricanalysis/documents/{doc['id']}/marks").json()[
        "marks"
    ]
    assert marks[0]["id"] == mark["id"]


def test_a_stale_mark_is_reported_and_not_painted(client):
    doc = _create(client, text=LYRIC)
    asyncio.run(documents.run_analysis(create_job("lyricanalysis", "a"), doc["id"], {}))
    mark = _put_marks(client, doc["id"], [{"spans": [{"line": 1, "word": 2}]}])[
        "marks"
    ][0]
    client.put(
        f"/api/lyricanalysis/documents/{doc['id']}",
        json={"text": "The city breathes a silver light\nAnd nothing rhymes with it"},
    )
    body = client.get(f"/api/lyricanalysis/{doc['id']}").json()
    assert body["marks"]["stale"] == [mark["id"]] and body["marks"]["painted"] == 0
    assert not any(
        service.is_mark_device(Device.model_validate(d)) for d in body["doc"]["devices"]
    )


def test_a_document_with_no_marks_keeps_the_bundle_it_always_had(client):
    doc = _create(client, text=LYRIC)
    assert client.get(f"/api/lyricanalysis/{doc['id']}").json() == {
        "doc": None,
        "persisted": False,
        "stale": False,
    }
    assert client.get(f"/api/lyricanalysis/documents/{doc['id']}/marks").json() == {
        "marks": [],
        "stale": [],
        "updated_at": 0.0,
    }
    asyncio.run(documents.run_analysis(create_job("lyricanalysis", "a"), doc["id"], {}))
    assert "marks" not in client.get(f"/api/lyricanalysis/{doc['id']}").json()


# ---- hostile input on the mark routes ----------------------------------------


def test_the_marks_routes_404_on_a_traversal_id(client, notebook: Path):
    for bad in EVIL_IDS:
        if not bad:
            continue
        path = f"/api/lyricanalysis/documents/{_pct(bad)}/marks"
        assert client.get(path).status_code == 404, bad
        assert client.put(path, json={"marks": []}).status_code == 404, bad
        # A hostile id is a 404 whatever body rode along with it.
        assert (
            client.put(
                path,
                json={"marks": [{"id": "", "spans": [{"line": 0, "word": 0}]}] * 5000},
            ).status_code
            == 404
        ), bad
    assert not notebook.exists()


def test_marks_on_a_document_that_does_not_exist_are_a_404_not_a_write(
    client, notebook: Path
):
    missing = documents.new_id()
    assert (
        client.get(f"/api/lyricanalysis/documents/{missing}/marks").status_code == 404
    )
    assert (
        client.put(
            f"/api/lyricanalysis/documents/{missing}/marks", json={"marks": []}
        ).status_code
        == 404
    )
    assert not (notebook / documents.MARKS_DIRNAME).exists()
    # Existence is decided before size, so an oversize body for a page that is
    # not there says so, instead of telling the client to send fewer marks.
    assert (
        client.put(
            f"/api/lyricanalysis/documents/{missing}/marks",
            json={"marks": [{"id": ""}] * (documents.MAX_MARKS + 1)},
        ).status_code
        == 404
    )
    assert not (notebook / documents.MARKS_DIRNAME).exists()


def test_the_marks_routes_do_not_shadow_the_others(client, tmp_path):
    """Three segments cannot collide with ``/documents/{doc_id}`` or with
    ``/{entry_id}``, and adding them must not have moved anything."""
    eid = _seed_entry(tmp_path, client, job="marks_order")
    doc = _create(client, text=LYRIC)
    assert (
        client.get(f"/api/lyricanalysis/documents/{doc['id']}").json()["text"] == LYRIC
    )
    assert (
        client.get(f"/api/lyricanalysis/documents/{doc['id']}/marks").status_code == 200
    )
    assert client.get("/api/lyricanalysis/documents").status_code == 200
    assert client.get(f"/api/lyricanalysis/{eid}").status_code == 200
    assert client.get(f"/api/lyricanalysis/{doc['id']}").status_code == 200
    # "marks" is neither a document id nor an entry id.
    assert client.get("/api/lyricanalysis/documents/marks").status_code == 404
    assert client.get("/api/lyricanalysis/marks").status_code == 404
    assert client.get(f"/api/lyricanalysis/{eid}/marks").status_code == 404


def test_too_many_marks_is_refused_and_nothing_is_written(client, notebook: Path):
    doc = _create(client, text=LYRIC)
    r = client.put(
        f"/api/lyricanalysis/documents/{doc['id']}/marks",
        json={"marks": [{"id": "", "spans": [{"line": 0, "word": 0}]}] * 5000},
    )
    assert r.status_code == 413, r.text
    assert not _marks_path(notebook, doc["id"]).exists()
    got = client.get(f"/api/lyricanalysis/documents/{doc['id']}/marks").json()
    assert got["marks"] == []


def test_a_ten_megabyte_payload_is_bounded_before_it_lands(client, notebook: Path):
    doc = _create(client, text=LYRIC)
    r = client.put(
        f"/api/lyricanalysis/documents/{doc['id']}/marks",
        json={
            "marks": [
                {
                    "id": "",
                    "note": "x" * (10 * 1024 * 1024),
                    "label": "y" * 5000,
                    "kind": "z" * 5000,
                    "group": "g" * 5000,
                    "target_group": "t" * 5000,
                    "spans": [{"line": 0, "word": 0}],
                }
            ]
        },
    )
    assert r.status_code == 200, r.text[:300]
    mark = r.json()["marks"][0]
    assert len(mark["note"]) == documents.MAX_MARK_NOTE
    assert len(mark["label"]) == documents.MAX_MARK_LABEL
    assert len(mark["kind"]) == documents.MAX_MARK_KIND
    assert len(mark["group"]) == documents.MAX_MARK_GROUP
    # ``target_group`` is matched against a ``Device.group`` character for
    # character, so it gets a bound of its own rather than the display one.
    assert len(mark["target_group"]) == documents.MAX_MARK_TARGET
    assert _marks_path(notebook, doc["id"]).stat().st_size < 64 * 1024


def test_a_reject_naming_a_long_group_still_matches_it(client):
    """A group longer than the display bound must not be silently truncated
    into one that matches nothing: the reject would just stop working."""
    doc = _create(client, text=LYRIC)
    group = "poly-" + "x" * (documents.MAX_MARK_GROUP * 2)
    mark = _put_marks(
        client, doc["id"], [{"verdict": "reject", "target_group": group}]
    )["marks"][0]
    assert mark["target_group"] == group
    analysis = LyricAnalysisDoc(
        entry_id=doc["id"],
        devices=[
            Device(id="poly-1", kind="polyptoton", family="repetition", label="p"),
        ],
    )
    analysis.devices[0].group = group
    assert service.apply_marks(analysis, [LyricMark(**mark)]).devices == []


def test_a_corrupt_marks_file_reads_as_no_marks(client, notebook: Path):
    doc = _create(client, text=LYRIC)
    _put_marks(client, doc["id"], [{"spans": [{"line": 0, "word": 0}]}])
    _marks_path(notebook, doc["id"]).write_text("{not json", encoding="utf-8")
    got = client.get(f"/api/lyricanalysis/documents/{doc['id']}/marks")
    assert got.status_code == 200 and got.json()["marks"] == []


def test_deleting_the_document_takes_its_marks_with_it(client, notebook: Path):
    doc = _create(client, text=LYRIC)
    _put_marks(client, doc["id"], [{"spans": [{"line": 0, "word": 0}]}])
    path = _marks_path(notebook, doc["id"])
    assert path.is_file()
    assert (
        client.delete(f"/api/lyricanalysis/documents/{doc['id']}").json()["ok"] is True
    )
    assert not path.exists()
    assert (
        client.get(f"/api/lyricanalysis/documents/{doc['id']}/marks").status_code == 404
    )


def test_reading_marks_while_the_words_are_being_saved(client):
    """The LYRIC tab debounce-saves the words in one pane while it debounce-
    saves the marks in the other, and FastAPI runs both sync handlers in a
    threadpool — so a read genuinely overlaps a write.

    On Windows, opening a file while ``os.replace`` publishes over it raises
    PermissionError, and every load here reads an unreadable file as an absent
    one. Without a retry that turns a document which plainly exists into
    "unknown lyric document": a 404 on the marks PUT, and an empty mark set on
    the GET, while the writer is mid-sentence. This hammers exactly that.
    """
    doc = _create(client, text=LYRIC)
    marks = [
        {"id": "", "kind": f"k{i}", "spans": [{"line": 1, "word": 5}]} for i in range(8)
    ]
    _put_marks(client, doc["id"], marks)
    failures: list[str] = []
    stop = threading.Event()

    def read() -> None:
        while not stop.is_set():
            r = client.get(f"/api/lyricanalysis/documents/{doc['id']}/marks")
            if r.status_code != 200:
                failures.append(f"GET {r.status_code} {r.text[:80]}")
            elif len(r.json()["marks"]) != 8:
                failures.append(f"GET saw {len(r.json()['marks'])} marks")

    def write() -> None:
        for i in range(20):
            r = client.put(
                f"/api/lyricanalysis/documents/{doc['id']}/marks", json={"marks": marks}
            )
            if r.status_code != 200:
                failures.append(f"PUT {r.status_code} {r.text[:80]}")
            # The words change under the marks at the same time, which is what
            # makes the document file a moving target for the readers.
            client.put(
                f"/api/lyricanalysis/documents/{doc['id']}",
                json={"text": ("A padding line with six words\n" * (i % 3)) + LYRIC},
            )

    writers = [threading.Thread(target=write) for _ in range(3)]
    readers = [threading.Thread(target=read) for _ in range(3)]
    for t in writers:
        t.start()
    for t in readers:
        t.start()
    for t in writers:
        t.join()
    stop.set()
    for t in readers:
        t.join()
    assert failures == [], failures[:5]
