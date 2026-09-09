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
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.core.jobs import create_job
from backend.modules.library import router as library_router_module
from backend.modules.lyricanalysis import documents
from backend.modules.lyricanalysis import router as analysis_router_module
from backend.modules.lyricanalysis import service
from backend.modules.lyricanalysis.schema import ANALYZER_VERSION, LyricAnalysisDoc
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
