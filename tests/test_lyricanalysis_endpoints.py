"""End-to-end tests for /api/lyricanalysis against a tmp library root.

The interpretive pass is never allowed near the network: every LLM test drives
``llm._chat`` (and the key resolver) through monkeypatch.
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
from backend.modules.lyricanalysis import llm
from backend.modules.lyricanalysis import router as analysis_router_module
from backend.modules.lyricanalysis import service
from backend.modules.lyricanalysis.schema import (
    ANALYZER_VERSION,
    DOC_FILENAME,
    LyricAnalysisDoc,
)
from backend.modules.lyrics import router as lyrics_router_module
from tests.test_library_store import _seed_generate_entry

LYRIC = "The city breathes a silver light\nThe city bleeds a silver night"


@pytest.fixture
def client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    # The job registry is in-process and keyed by entry id, and every test
    # seeds the same "job_test_00" id, so a stale job would leak across tests.
    service._active_jobs.clear()
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    app.include_router(lyrics_router_module.router, prefix="/api/lyrics")
    app.include_router(analysis_router_module.router, prefix="/api/lyricanalysis")
    return TestClient(app)


@pytest.fixture(autouse=True)
def no_llm_keys(monkeypatch):
    """No test may see this machine's real assistant keys."""
    monkeypatch.setattr(llm, "_get_api_key", lambda pid, request_key=None: "")


def _seed(tmp_path: Path, client: TestClient, job: str = "job_test", **extra) -> str:
    _seed_generate_entry(tmp_path, job, 0, extra_meta=extra or None)
    ids = [e["id"] for e in client.get("/api/library/entries").json()["entries"]]
    return next(i for i in ids if i.startswith(job))


def _entry_dir(entry_id: str) -> Path:
    d = library_router_module.get_store()._dir_for(entry_id)
    assert d is not None
    return d


def _rows(entry_id: str) -> list[dict]:
    db = library_router_module.get_store().db
    assert db is not None
    return [
        r
        for r in db.list_notation_artifacts(entry_id)
        if r.get("kind") == "lyricanalysis"
    ]


def _with_lyrics(client: TestClient, entry_id: str, text: str = LYRIC) -> None:
    r = client.put(f"/api/lyrics/{entry_id}", json={"text": text})
    assert r.status_code == 200, r.text


def _assert_anchored(doc: LyricAnalysisDoc, lines: list[list[str]]) -> None:
    """Every span must land on a word that really exists, and its denormalised
    text must be exactly the slice of that word it claims (a span may cover one
    syllable, so char_start/char_end are part of the anchor)."""
    for device in doc.devices:
        assert device.spans, device
        for span in device.spans:
            assert 0 <= span.line < len(lines), device
            assert 0 <= span.word < len(lines[span.line]), device
            word = lines[span.line][span.word]
            end = len(word) if span.char_end is None else span.char_end
            assert 0 <= span.char_start <= end <= len(word), device
            assert span.text == word[span.char_start : end], device


# ---- capabilities -------------------------------------------------------------


def test_capabilities_on_both_root_routes(client, monkeypatch):
    monkeypatch.setattr(llm, "available_providers", lambda request_key="": [])
    for path in ("/api/lyricanalysis", "/api/lyricanalysis/"):
        body = client.get(path).json()
        assert body["ok"] is True
        assert body["llm_available"] is False and body["providers"] == []
        assert body["analyzer_version"] == ANALYZER_VERSION
        assert set(body["kinds"]) == {
            "rhyme",
            "sound",
            "repetition",
            "structure",
            "meaning",
        }
        assert "end-rhyme" in body["kinds"]["rhyme"]
        assert "metaphor" in body["kinds"]["meaning"]


def test_capabilities_reports_a_configured_provider(client, monkeypatch):
    monkeypatch.setattr(llm, "_get_api_key", lambda pid, request_key=None: "k")
    body = client.get("/api/lyricanalysis").json()
    assert body["llm_available"] is True
    assert body["providers"] == list(llm.PROVIDER_ORDER)


# ---- stateless text pass -------------------------------------------------------


def test_analyze_text_returns_a_valid_doc_and_writes_nothing(client, tmp_path):
    eid = _seed(tmp_path, client)
    r = client.post("/api/lyricanalysis/analyze", json={"text": LYRIC})
    assert r.status_code == 200, r.text
    doc = LyricAnalysisDoc.model_validate(r.json())
    assert doc.entry_id == "" and doc.analyzer_version == ANALYZER_VERSION
    assert doc.stats.lines == 2 and doc.stats.words == 12
    assert len(doc.lines) == 2 and doc.devices
    _assert_anchored(doc, [ln.split() for ln in LYRIC.split("\n")])
    assert not (_entry_dir(eid) / DOC_FILENAME).exists()


def test_analyze_empty_text_is_an_empty_doc(client):
    doc = LyricAnalysisDoc.model_validate(
        client.post("/api/lyricanalysis/analyze", json={"text": "  "}).json()
    )
    assert doc.devices == [] and doc.lines == [] and doc.stats.words == 0


# ---- run / job / persistence ----------------------------------------------------


def test_get_before_any_run_is_absent(client, tmp_path):
    eid = _seed(tmp_path, client)
    body = client.get(f"/api/lyricanalysis/{eid}").json()
    assert body == {"doc": None, "persisted": False, "stale": False}


def test_run_route_starts_one_job_and_joins_the_second_caller(
    client, tmp_path, monkeypatch
):
    eid = _seed(tmp_path, client)
    _with_lyrics(client, eid)
    started: list[tuple] = []
    monkeypatch.setattr(
        service, "start_run", lambda job, entry_id, req: started.append((job, req))
    )
    first = client.post(f"/api/lyricanalysis/{eid}/run", json={}).json()
    assert first["ok"] is True and first["reused"] is False
    assert first["job"]["status"] == "queued" and first["job"]["result"] is None
    second = client.post(f"/api/lyricanalysis/{eid}/run", json={}).json()
    assert second["reused"] is True and second["job"]["id"] == first["job"]["id"]
    assert len(started) == 1 and started[0][1]["llm"] is False
    assert (
        client.get(f"/api/lyricanalysis/{eid}/job").json()["job"]["id"]
        == (first["job"]["id"])
    )
    polled = client.get(f"/api/lyricanalysis/jobs/{first['job']['id']}").json()
    assert polled["status"] == "queued"


def test_run_writes_the_document_and_one_artifact_row(client, tmp_path):
    eid = _seed(tmp_path, client)
    _with_lyrics(client, eid)
    job = create_job("lyricanalysis", "analyse")
    asyncio.run(service.run_analysis(job, eid, {}))
    assert job.status == "done", job.error
    doc = LyricAnalysisDoc.model_validate(job.result)
    assert doc.entry_id == eid and doc.devices
    stored = json.loads((_entry_dir(eid) / DOC_FILENAME).read_text(encoding="utf-8"))
    assert stored["entry_id"] == eid
    rows = _rows(eid)
    assert len(rows) == 1 and rows[0]["id"] == f"{eid}__lyricanalysis__analysis"
    body = client.get(f"/api/lyricanalysis/{eid}").json()
    assert body["persisted"] is True and body["stale"] is False
    assert body["doc"]["stats"]["devices_by_family"]
    # A second run rewrites in place: still exactly one row.
    job2 = create_job("lyricanalysis", "analyse")
    asyncio.run(service.run_analysis(job2, eid, {"force": True}))
    assert job2.status == "done" and len(_rows(eid)) == 1


def test_run_without_lyrics_fails_the_job(client, tmp_path):
    eid = _seed(tmp_path, client)
    job = create_job("lyricanalysis", "analyse")
    asyncio.run(service.run_analysis(job, eid, {}))
    assert job.status == "failed" and "no lyrics" in job.message


def test_unforced_rerun_reuses_the_stored_analysis(client, tmp_path):
    eid = _seed(tmp_path, client)
    _with_lyrics(client, eid)
    asyncio.run(service.run_analysis(create_job("lyricanalysis", "a"), eid, {}))
    written = (_entry_dir(eid) / DOC_FILENAME).stat().st_mtime_ns
    job = create_job("lyricanalysis", "a")
    asyncio.run(service.run_analysis(job, eid, {}))
    assert job.status == "done" and "already up to date" in job.message
    assert (_entry_dir(eid) / DOC_FILENAME).stat().st_mtime_ns == written


def test_stale_flips_when_the_lyrics_move_underneath(client, tmp_path):
    eid = _seed(tmp_path, client)
    _with_lyrics(client, eid)
    asyncio.run(service.run_analysis(create_job("lyricanalysis", "a"), eid, {}))
    assert client.get(f"/api/lyricanalysis/{eid}").json()["stale"] is False
    _with_lyrics(client, eid, LYRIC + "\nAnd the river answers back")
    body = client.get(f"/api/lyricanalysis/{eid}").json()
    assert body["persisted"] is True and body["stale"] is True
    # Stale is also what makes an unforced rerun recompute rather than reuse.
    job = create_job("lyricanalysis", "a")
    asyncio.run(service.run_analysis(job, eid, {}))
    assert job.status == "done" and "already up to date" not in job.message
    assert client.get(f"/api/lyricanalysis/{eid}").json()["stale"] is False


def test_stale_when_the_analyzer_moved_on(client, tmp_path):
    eid = _seed(tmp_path, client)
    _with_lyrics(client, eid)
    asyncio.run(service.run_analysis(create_job("lyricanalysis", "a"), eid, {}))
    path = _entry_dir(eid) / DOC_FILENAME
    stored = json.loads(path.read_text(encoding="utf-8"))
    stored["analyzer_version"] = ANALYZER_VERSION - 1
    path.write_text(json.dumps(stored), encoding="utf-8")
    assert client.get(f"/api/lyricanalysis/{eid}").json()["stale"] is True


def test_delete_removes_the_document_and_the_row(client, tmp_path):
    eid = _seed(tmp_path, client)
    _with_lyrics(client, eid)
    asyncio.run(service.run_analysis(create_job("lyricanalysis", "a"), eid, {}))
    r = client.delete(f"/api/lyricanalysis/{eid}")
    assert r.status_code == 200 and r.json()["ok"] is True
    assert not (_entry_dir(eid) / DOC_FILENAME).exists()
    assert _rows(eid) == []
    assert client.get(f"/api/lyricanalysis/{eid}").json()["persisted"] is False
    # The lyrics themselves are untouched.
    assert client.get(f"/api/lyrics/{eid}").json()["doc"]["text"] == LYRIC


def test_unknown_entry_404s(client):
    assert client.get("/api/lyricanalysis/nope").status_code == 404
    assert client.delete("/api/lyricanalysis/nope").status_code == 404
    assert client.get("/api/lyricanalysis/nope/job").status_code == 404
    assert client.post("/api/lyricanalysis/nope/run", json={}).status_code == 404
    assert client.get("/api/lyricanalysis/jobs/nope").status_code == 404


def test_a_job_from_another_module_is_not_ours(client):
    other = create_job("lyrics", "align")
    assert client.get(f"/api/lyricanalysis/jobs/{other.id}").status_code == 404


# ---- the interpretive pass -------------------------------------------------------


def _reply(payload: dict) -> str:
    return "Sure, here you go:\n```json\n" + json.dumps(payload) + "\n```"


def test_run_with_llm_409s_without_a_key(client, tmp_path):
    eid = _seed(tmp_path, client)
    _with_lyrics(client, eid)
    r = client.post(f"/api/lyricanalysis/{eid}/run", json={"llm": True})
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["error"] == "llm unavailable"
    assert "openai" in detail["providers"]
    assert not (_entry_dir(eid) / DOC_FILENAME).exists()


def test_llm_pass_appends_only_validated_meaning_devices(client, tmp_path, monkeypatch):
    eid = _seed(tmp_path, client)
    _with_lyrics(client, eid)
    seen: dict = {}

    async def fake_chat(provider, model, api_key, prompt):
        seen["provider"] = provider
        seen["model"] = model
        seen["prompt"] = prompt
        return _reply(
            {
                "devices": [
                    {
                        "kind": "personification",
                        "label": "personification: the city breathes",
                        "detail": "The city is given a body.",
                        "confidence": 0.9,
                        "spans": [[0, 1], [0, 2]],
                    },
                    # Dropped: a kind the deterministic families own.
                    {"kind": "alliteration", "spans": [[0, 0]]},
                    # Dropped: no such word.
                    {"kind": "metaphor", "spans": [[0, 99]]},
                    # Dropped: no such line.
                    {"kind": "irony", "spans": [[9, 0]]},
                    # Dropped: nothing to anchor to.
                    {"kind": "imagery", "spans": []},
                ]
            }
        )

    monkeypatch.setattr(llm, "_get_api_key", lambda pid, request_key=None: "k")
    monkeypatch.setattr(llm, "_chat", fake_chat)
    job = create_job("lyricanalysis", "analyse")
    asyncio.run(
        service.run_analysis(
            job, eid, {"llm": True, "provider": "openai", "model": "m"}
        )
    )
    assert job.status == "done", job.error
    doc = LyricAnalysisDoc.model_validate(job.result)
    assert seen["provider"] == "openai" and seen["model"] == "m"
    # Every word is offered to the model with its own (line, word) address.
    assert "0:1 city" in seen["prompt"] and "1:2 bleeds" in seen["prompt"]
    from_llm = [d for d in doc.devices if d.source == "llm"]
    assert len(from_llm) == 1
    found = from_llm[0]
    assert found.kind == "personification" and found.family == "meaning"
    assert 0.0 < found.confidence < 1.0
    assert [(s.line, s.word, s.text) for s in found.spans] == [
        (0, 1, "city"),
        (0, 2, "breathes"),
    ]
    assert doc.llm is not None and doc.llm.provider == "openai" and not doc.llm.error
    # The family total is NOT the model's contribution any more: the rules pass
    # finds the checkable meaning devices too (a heteronym, a word with a second
    # sense). What must hold is that exactly one finding came from the model,
    # and that it is the one it was allowed to keep.
    assert doc.stats.devices_by_kind["personification"] == 1
    assert doc.stats.devices_by_family["meaning"] == len(
        [d for d in doc.devices if d.family == "meaning"]
    )
    assert all(
        d.source == "rules"
        for d in doc.devices
        if d.family == "meaning" and d is not found
    )
    _assert_anchored(doc, [ln.split() for ln in LYRIC.split("\n")])
    assert client.get(f"/api/lyricanalysis/{eid}").json()["doc"]["llm"]["model"] == "m"


def test_a_failed_llm_pass_is_recorded_not_silent(client, tmp_path, monkeypatch):
    eid = _seed(tmp_path, client)
    _with_lyrics(client, eid)

    async def prose(provider, model, api_key, prompt):
        return "I'm afraid I can't help with that."

    monkeypatch.setattr(llm, "_get_api_key", lambda pid, request_key=None: "k")
    monkeypatch.setattr(llm, "_chat", prose)
    job = create_job("lyricanalysis", "analyse")
    asyncio.run(service.run_analysis(job, eid, {"llm": True, "provider": "openai"}))
    # The deterministic analysis is still correct, so it is still saved — but
    # the failure is on the document and in the job message, never swallowed.
    assert job.status == "done" and "interpretive pass failed" in job.message
    doc = LyricAnalysisDoc.model_validate(job.result)
    assert doc.llm is not None and "did not return" in doc.llm.error
    assert [d for d in doc.devices if d.source == "llm"] == []
    assert client.get(f"/api/lyricanalysis/{eid}").json()["persisted"] is True


def test_llm_upstream_error_does_not_lose_the_analysis(client, tmp_path, monkeypatch):
    eid = _seed(tmp_path, client)
    _with_lyrics(client, eid)

    async def boom(provider, model, api_key, prompt):
        raise llm.LlmError("openai returned HTTP 429: slow down")

    monkeypatch.setattr(llm, "_get_api_key", lambda pid, request_key=None: "k")
    monkeypatch.setattr(llm, "_chat", boom)
    job = create_job("lyricanalysis", "analyse")
    asyncio.run(service.run_analysis(job, eid, {"llm": True, "provider": "openai"}))
    assert job.status == "done" and "429" in job.message
    doc = service.load_doc(eid)
    assert doc is not None and doc.devices and doc.llm.error


def test_an_unexpected_pass_failure_still_saves_the_analysis(
    client, tmp_path, monkeypatch
):
    """Only ``LlmError`` used to be caught, so any other exception out of the
    pass failed the job and threw away a perfectly good deterministic
    analysis. A bad reading must never cost the measured findings."""
    eid = _seed(tmp_path, client)
    _with_lyrics(client, eid)

    async def explode(provider, model, api_key, prompt):
        raise ValueError("something nobody anticipated")

    monkeypatch.setattr(llm, "_get_api_key", lambda pid, request_key=None: "k")
    monkeypatch.setattr(llm, "_chat", explode)
    job = create_job("lyricanalysis", "analyse")
    asyncio.run(service.run_analysis(job, eid, {"llm": True, "provider": "openai"}))
    assert job.status == "done", job.error
    assert "interpretive pass failed" in job.message
    doc = service.load_doc(eid)
    assert doc is not None and doc.devices
    assert doc.llm is not None and "ValueError" in doc.llm.error


def test_provider_picked_from_the_first_configured_key(client, tmp_path, monkeypatch):
    eid = _seed(tmp_path, client)
    _with_lyrics(client, eid)

    async def fake_chat(provider, model, api_key, prompt):
        return _reply({"devices": [{"kind": "imagery", "spans": [[0, 3]]}]})

    # Only Grok has a key: the pass must land there, on the provider catalog's
    # own default model (never a model id written from memory).
    monkeypatch.setattr(
        llm, "_get_api_key", lambda pid, request_key=None: "k" if pid == "grok" else ""
    )
    monkeypatch.setattr(llm, "_chat", fake_chat)
    job = create_job("lyricanalysis", "analyse")
    asyncio.run(service.run_analysis(job, eid, {"llm": True}))
    assert job.status == "done", job.error
    doc = LyricAnalysisDoc.model_validate(job.result)
    assert doc.llm.provider == "grok"
    assert doc.llm.model == llm.PROVIDERS["grok"]["default_model"]


# ---- validation, without any transport at all --------------------------------------


def test_devices_from_reply_drops_everything_unanchored():
    from backend.modules.lyrics.schema import LyricsDoc, split_text

    doc = LyricsDoc(entry_id="", lines=split_text("one two three"))
    devices, dropped = llm.devices_from_reply(
        {
            "devices": [
                {"kind": "pun", "spans": [[0, 0], [0, 7]]},  # bad span pruned
                {"kind": "nonsense", "spans": [[0, 0]]},
                {"kind": "pun", "spans": [["x", None]]},
                "not a dict",
            ]
        },
        doc,
    )
    assert dropped == 3
    assert len(devices) == 1
    assert [(s.line, s.word) for s in devices[0].spans] == [(0, 0)]
    assert devices[0].source == "llm" and devices[0].confidence < 1.0
    assert llm.devices_from_reply({"devices": "nope"}, doc) == ([], 0)
    assert llm.parse_json_block("no json here") is None


def test_devices_from_reply_survives_numbers_int_refuses():
    """``json.loads`` accepts Infinity/NaN and unbounded integers, so a model
    can hand back a "number" that ``int()``/``float()`` throw on. The validator
    must drop the span, not raise out of the pass."""
    from backend.modules.lyrics.schema import LyricsDoc, split_text

    doc = LyricsDoc(entry_id="", lines=split_text("one two three"))
    payload = json.loads(
        '{"devices": [{"kind": "metaphor", "spans": [[Infinity, 0]]},'
        ' {"kind": "irony", "spans": [[NaN, 0], [0, 1]]}]}'
    )
    # An int too large to be a float is a number json parses and float() will not.
    payload["devices"][1]["confidence"] = 10**400
    devices, dropped = llm.devices_from_reply(payload, doc)
    assert dropped == 1  # the all-Infinity finding loses every span
    assert len(devices) == 1 and devices[0].kind == "irony"
    assert [(sp.line, sp.word) for sp in devices[0].spans] == [(0, 1)]
    assert devices[0].confidence == llm.DEFAULT_CONFIDENCE


def test_pronunciation_source_is_rules_when_every_word_was_guessed():
    """``guessed_pronunciations`` and ``unique_words`` are both DISTINCT-word
    counts; comparing the guessed count against the total token count called a
    fully guessed lyric "mixed" as soon as it repeated a word."""
    from backend.modules.lyricanalysis.schema import AnalyzeTextRequest

    line = "zxqv wibble frobnitz"
    text = "\n".join([line] * 3)
    doc = service.analyze_text(AnalyzeTextRequest(text=text))
    assert doc.stats.words == 9 and doc.stats.unique_words == 3
    assert doc.stats.guessed_pronunciations == 3
    assert doc.pronunciation_source == "rules"
