"""End-to-end tests for /api/lyrics against a tmp library root."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.core.jobs import create_job
from backend.modules.library import router as library_router_module
from backend.modules.lyrics import lrc
from backend.modules.lyrics import router as lyrics_router_module
from backend.modules.lyrics import service
from backend.modules.lyrics.schema import LyricsDoc
from tests.test_library_store import _seed_generate_entry


@pytest.fixture
def client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    app.include_router(lyrics_router_module.router, prefix="/api/lyrics")
    return TestClient(app)


def _seed_many(tmp_path: Path, client: TestClient, jobs) -> list[str]:
    """Seed every entry BEFORE the first request: the store indexes the root
    once, when it is created."""
    for job, extra in jobs:
        _seed_generate_entry(tmp_path, job, 0, extra_meta=extra or None)
    ids = [e["id"] for e in client.get("/api/library/entries").json()["entries"]]
    out = []
    for job, _ in jobs:
        out.append(next(i for i in ids if i.startswith(job)))
    return out


def _seed(tmp_path: Path, client: TestClient, job: str = "job_test", **extra) -> str:
    return _seed_many(tmp_path, client, [(job, extra)])[0]


def _entry_dir(entry_id: str) -> Path:
    d = library_router_module.get_store()._dir_for(entry_id)
    assert d is not None
    return d


def _rows(entry_id: str) -> list[dict]:
    db = library_router_module.get_store().db
    assert db is not None
    return [
        r for r in db.list_notation_artifacts(entry_id) if r.get("kind") == "lyrics"
    ]


# ---- derivation -------------------------------------------------------------


def test_get_bare_entry_is_empty_and_not_persisted(client, tmp_path):
    eid = _seed(tmp_path, client)
    r = client.get(f"/api/lyrics/{eid}")
    assert r.status_code == 200
    body = r.json()
    assert body["persisted"] is False
    assert body["notes_candidate"] is None
    assert (
        body["doc"]["text"] == ""
        and body["doc"]["source"] == ""
        and body["doc"]["lines"] == []
    )


def test_get_suno_metadata_lyrics_surface(client, tmp_path):
    eid = _seed(
        tmp_path, client, model="suno", inferred={}, metadata={"lyrics": "a\nb"}
    )
    doc = client.get(f"/api/lyrics/{eid}").json()["doc"]
    assert doc["text"] == "a\nb" and doc["source"] == "suno"
    assert [ln["text"] for ln in doc["lines"]] == ["a", "b"]


def test_get_plain_lyrics_field_is_manual(client, tmp_path):
    eid = _seed(tmp_path, client, lyrics="x y\nz")
    doc = client.get(f"/api/lyrics/{eid}").json()["doc"]
    assert doc["source"] == "manual" and doc["text"] == "x y\nz"


def test_get_tag_lyrics(client, tmp_path):
    eid = _seed(tmp_path, client, tags=["lyrics:hello there", "mood:calm"])
    doc = client.get(f"/api/lyrics/{eid}").json()["doc"]
    assert doc["source"] == "tags" and doc["text"] == "hello there"


def test_get_offers_notes_as_candidate_only(client, tmp_path):
    eid = _seed(tmp_path, client, notes="one\ntwo\nthree")
    body = client.get(f"/api/lyrics/{eid}").json()
    assert body["doc"]["text"] == ""
    assert body["notes_candidate"] == "one\ntwo\nthree"


# ---- put / persistence --------------------------------------------------------


def test_put_text_persists_mirrors_and_registers_one_row(client, tmp_path):
    eid = _seed(tmp_path, client)
    r = client.put(f"/api/lyrics/{eid}", json={"text": "la la\nda da"})
    assert r.status_code == 200, r.text
    doc = r.json()
    assert doc["text"] == "la la\nda da" and doc["source"] == "manual"
    assert (_entry_dir(eid) / "lyrics.json").is_file()
    entries = {e["id"]: e for e in client.get("/api/library/entries").json()["entries"]}
    assert entries[eid]["lyrics"] == "la la\nda da"
    rows = _rows(eid)
    assert len(rows) == 1 and rows[0]["id"] == f"{eid}__lyrics__lyrics"
    client.put(f"/api/lyrics/{eid}", json={"text": "la la\nda da\nmore"})
    assert len(_rows(eid)) == 1
    assert client.get(f"/api/lyrics/{eid}").json()["persisted"] is True


def test_text_edit_carries_timings_over_by_line(client, tmp_path):
    eid = _seed(tmp_path, client)
    lines = [
        {
            "text": "keep me",
            "start_ms": 1000,
            "end_ms": 2000,
            "words": [
                {"text": "keep", "start_ms": 1000, "end_ms": 1500},
                {"text": "me", "start_ms": 1500, "end_ms": 2000},
            ],
        },
        {"text": "change me", "start_ms": 3000, "end_ms": 4000},
    ]
    r = client.put(f"/api/lyrics/{eid}", json={"lines": lines})
    assert r.status_code == 200, r.text
    r = client.put(f"/api/lyrics/{eid}", json={"text": "keep me\nchanged line"})
    doc = r.json()
    assert (
        doc["lines"][0]["start_ms"] == 1000
        and doc["lines"][0]["words"][1]["start_ms"] == 1500
    )
    assert (
        doc["lines"][1]["start_ms"] is None
        and doc["lines"][1]["text"] == "changed line"
    )


def test_unsorted_timed_lines_are_normalized_monotonic(client, tmp_path):
    eid = _seed(tmp_path, client)
    lines = [
        {"text": "second", "start_ms": 5000, "end_ms": 6000},
        {"text": "first", "start_ms": 2000, "end_ms": 3000},
        {"text": "[Chorus]", "kind": "marker", "start_ms": 100},
        {"text": "third", "start_ms": 7000, "end_ms": 7010},
    ]
    doc = client.put(f"/api/lyrics/{eid}", json={"lines": lines}).json()
    starts = [ln["start_ms"] for ln in doc["lines"] if ln["kind"] == "lyric"]
    assert starts == sorted(starts)
    assert doc["lines"][2]["start_ms"] is None
    assert doc["lines"][3]["end_ms"] >= 7000 + 40
    assert doc["text"] == "second\nfirst\n[Chorus]\nthird"


# ---- import / export ------------------------------------------------------------


def test_import_lrc_then_export_round_trips(client, tmp_path):
    eid = _seed(tmp_path, client)
    content = "[offset:-100]\n[00:01.00]hello world\n[00:02.50]second line\n"
    r = client.post(
        f"/api/lyrics/{eid}/import", json={"format": "lrc", "content": content}
    )
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "lrc" and r.json()["offset_ms"] == 100
    r = client.get(f"/api/lyrics/{eid}/export", params={"format": "lrc"})
    assert r.status_code == 200
    assert r.headers["content-disposition"].endswith('.lrc"')
    again = lrc.parse_lrc(r.text)
    assert [ln.start_ms for ln in again.lines if ln.start_ms is not None] == [
        1000,
        2500,
    ]
    assert again.offset_ms == 100
    r = client.get(f"/api/lyrics/{eid}/export", params={"format": "txt"})
    assert r.headers["content-disposition"].endswith('.txt"')
    assert r.text == "hello world\nsecond line"


def test_export_of_derived_lyrics_and_404_when_nothing(client, tmp_path):
    eid, bare = _seed_many(
        tmp_path, client, [("job_test", {"lyrics": "plain only"}), ("job_bare", {})]
    )
    r = client.get(f"/api/lyrics/{eid}/export", params={"format": "txt"})
    assert r.status_code == 200 and r.text == "plain only"
    assert client.get(f"/api/lyrics/{bare}/export").status_code == 404


def test_delete_removes_doc_and_row_but_keeps_plain_lyrics(client, tmp_path):
    eid = _seed(tmp_path, client)
    client.put(f"/api/lyrics/{eid}", json={"text": "stay"})
    r = client.delete(f"/api/lyrics/{eid}")
    assert r.status_code == 200 and r.json()["ok"] is True
    assert not (_entry_dir(eid) / "lyrics.json").exists()
    assert _rows(eid) == []
    assert client.get(f"/api/library/entries/{eid}").json()["lyrics"] == "stay"
    assert client.get(f"/api/lyrics/{eid}").json()["persisted"] is False


def test_unknown_entry_404s(client):
    assert client.get("/api/lyrics/nope").status_code == 404
    assert client.put("/api/lyrics/nope", json={"text": "x"}).status_code == 404
    assert client.delete("/api/lyrics/nope").status_code == 404
    assert client.get("/api/lyrics/nope/export").status_code == 404
    assert client.post("/api/lyrics/nope/transcribe", json={}).status_code == 404
    assert client.get("/api/lyrics/jobs/nope").status_code == 404


# ---- jobs -----------------------------------------------------------------------


def test_transcribe_and_align_409_with_install_hint(client, tmp_path, monkeypatch):
    eid = _seed(tmp_path, client)
    monkeypatch.setattr(lyrics_router_module, "transcription_available", lambda: False)
    for route in ("transcribe", "align"):
        r = client.post(f"/api/lyrics/{eid}/{route}", json={})
        assert r.status_code == 409
        assert r.json()["detail"]["install"] == "/api/vocal/transcription/install"


def test_align_route_starts_a_job(client, tmp_path, monkeypatch):
    eid = _seed(tmp_path, client)
    monkeypatch.setattr(lyrics_router_module, "transcription_available", lambda: True)
    started = {}

    def fake_start(job, entry_id, req):
        started["job"] = job
        started["req"] = req

    monkeypatch.setattr(service, "start_align", fake_start)
    r = client.post(f"/api/lyrics/{eid}/align", json={"text": "hi"})
    assert r.status_code == 200 and r.json()["ok"] is True
    assert started["req"]["text"] == "hi"
    j = client.get(f"/api/lyrics/jobs/{started['job'].id}").json()
    assert j["status"] == "queued" and j["result"] is None


def test_run_align_times_every_line(client, tmp_path, monkeypatch):
    eid = _seed(tmp_path, client)
    client.put(
        f"/api/lyrics/{eid}", json={"text": "hello world\nsecond line", "offset_ms": 40}
    )
    wav = _entry_dir(eid) / "output.wav"

    async def fake_resolve(entry_id, work, isolate, job=None):
        return wav, "mix"

    async def fake_transcribe(path, language="en", cfg=None, extra=None):
        assert language == "auto"  # detection by default
        assert extra["initial_prompt"].startswith("hello world")
        # Sung-vocal decoding: VAD on (timestamps stay absolute), the song's
        # vocabulary as hotwords for every window, no snowballing.
        assert extra["vad_filter"] is True
        assert extra["condition_on_previous_text"] is False
        assert "hello" in extra["hotwords"] and "world" in extra["hotwords"]
        return {
            "ok": True,
            "language": "en",
            "text": "hello world second line",
            "segments": [
                {
                    "text": "hello world second line",
                    "start": 1.0,
                    "end": 3.0,
                    "words": [
                        {"word": "hello", "start": 1.0, "end": 1.4},
                        {"word": "world", "start": 1.5, "end": 1.9},
                        {"word": "second", "start": 2.2, "end": 2.6},
                        {"word": "line", "start": 2.7, "end": 3.0},
                    ],
                }
            ],
        }

    monkeypatch.setattr(service, "_resolve_vocal_audio", fake_resolve)
    monkeypatch.setattr(service.transcription, "transcribe", fake_transcribe)
    monkeypatch.setattr(service, "aligner_choice", lambda: "whisper")
    job = create_job("lyrics", "align")
    asyncio.run(service.run_align(job, eid, {"isolate": True, "sync_vocal": False}))
    assert job.status == "done", job.error
    doc = LyricsDoc.model_validate(job.result)
    assert doc.source == "aligned" and doc.offset_ms == 40
    assert doc.language == "en"
    assert [ln.start_ms for ln in doc.lines] == [1000, 2200]
    assert (
        doc.stats is not None
        and doc.stats.matched == 4
        and doc.stats.audio_source == "mix"
    )
    body = client.get(f"/api/lyrics/{eid}").json()
    assert body["persisted"] is True and body["doc"]["source"] == "aligned"
    assert (
        client.get(f"/api/library/entries/{eid}").json()["lyrics"]
        == "hello world\nsecond line"
    )


def test_run_transcribe_writes_doc_from_whisper_words(client, tmp_path, monkeypatch):
    eid = _seed(tmp_path, client)
    wav = _entry_dir(eid) / "output.wav"

    async def fake_resolve(entry_id, work, isolate, job=None):
        return wav, "stem"

    async def fake_transcribe(path, language="en", cfg=None, extra=None):
        assert extra["vad_filter"] is True
        return {
            "ok": True,
            "language": "en",
            "text": "one two",
            "segments": [
                {
                    "text": "one two",
                    "start": 0.5,
                    "end": 1.5,
                    "words": [
                        {"word": "one", "start": 0.5, "end": 0.9},
                        {"word": "two", "start": 1.0, "end": 1.5},
                    ],
                },
            ],
        }

    monkeypatch.setattr(service, "_resolve_vocal_audio", fake_resolve)
    monkeypatch.setattr(service.transcription, "transcribe", fake_transcribe)
    job = create_job("lyrics", "transcribe")
    asyncio.run(service.run_transcribe(job, eid, {"language": "en", "isolate": True}))
    assert job.status == "done", job.error
    doc = LyricsDoc.model_validate(job.result)
    assert doc.source == "transcribed" and doc.text == "one two"
    assert doc.language == "en"  # whisper's detection, stored on the doc
    assert [w.start_ms for w in doc.lines[0].words] == [500, 1000]
    assert doc.stats is not None and doc.stats.audio_source == "stem"


def test_failed_transcription_marks_job_failed(client, tmp_path, monkeypatch):
    eid = _seed(tmp_path, client)

    async def fake_resolve(entry_id, work, isolate, job=None):
        return _entry_dir(eid) / "output.wav", "mix"

    async def fake_transcribe(path, language="en", cfg=None, extra=None):
        return {"ok": False, "error": "whisper exploded"}

    monkeypatch.setattr(service, "_resolve_vocal_audio", fake_resolve)
    monkeypatch.setattr(service.transcription, "transcribe", fake_transcribe)
    job = create_job("lyrics", "transcribe")
    asyncio.run(service.run_transcribe(job, eid, {}))
    assert job.status == "failed" and "whisper exploded" in job.message


# ---- vocal artifact interplay ---------------------------------------------------


def _vocal_payload(words):
    return {
        "version": 1,
        "lyrics": {
            "language": "en",
            "text": " ".join(w[0] for w in words),
            "words": [{"text": t, "start_ms": s, "end_ms": e} for t, s, e in words],
            "phrases": [
                {
                    "text": " ".join(w[0] for w in words),
                    "start_ms": words[0][1],
                    "end_ms": words[-1][2],
                }
            ],
            "source": "transcribed",
        },
    }


def test_seed_from_vocal_artifact_writes_once(client, tmp_path):
    eid = _seed(tmp_path, client)
    service.seed_from_vocal_artifact(
        eid, _vocal_payload([("hi", 100, 400), ("there", 500, 900)])
    )
    doc = service.load_doc(eid)
    assert doc is not None and doc.text == "hi there" and doc.source == "transcribed"
    assert [w.start_ms for w in doc.lines[0].words] == [100, 500]
    service.seed_from_vocal_artifact(eid, _vocal_payload([("other", 1, 400)]))
    assert service.load_doc(eid).text == "hi there"
    assert len(_rows(eid)) == 1


def test_write_back_rewrites_vocal_artifact_in_place(client, tmp_path):
    eid = _seed(tmp_path, client)
    art = _entry_dir(eid) / "vocal_metadata.json"
    art.write_text(
        json.dumps({"version": 1, "notes": [1], "lyrics": {"text": "old"}}),
        encoding="utf-8",
    )
    doc = client.put(
        f"/api/lyrics/{eid}",
        json={
            "lines": [
                {
                    "text": "new words",
                    "start_ms": 100,
                    "end_ms": 900,
                    "words": [
                        {"text": "new", "start_ms": 100, "end_ms": 400},
                        {"text": "words", "start_ms": 500, "end_ms": 900},
                    ],
                },
            ]
        },
    ).json()
    rows_before = len(_rows(eid))
    assert (
        service.write_back_to_vocal_artifact(eid, LyricsDoc.model_validate(doc)) is True
    )
    payload = json.loads(art.read_text(encoding="utf-8"))
    assert payload["notes"] == [1]
    assert [w["text"] for w in payload["lyrics"]["words"]] == ["new", "words"]
    assert payload["lyrics"]["phrases"][0]["text"] == "new words"
    assert len(_rows(eid)) == rows_before
    assert (
        service.write_back_to_vocal_artifact("nope", LyricsDoc(entry_id="nope"))
        is False
    )


def test_recovered_lyrics_json_is_registered_as_artifact(client, tmp_path):
    from backend.modules.notation.engine import register_on_disk_artifacts

    eid = _seed(tmp_path, client)
    client.put(f"/api/lyrics/{eid}", json={"text": "recover me"})
    db = library_router_module.get_store().db
    assert db is not None
    assert db.delete_notation_artifact(f"{eid}__lyrics__lyrics") is True
    assert _rows(eid) == []
    register_on_disk_artifacts(db, _entry_dir(eid), eid)
    rows = _rows(eid)
    assert len(rows) == 1 and rows[0]["id"] == f"{eid}__lyrics__lyrics"


# ---- vocal resolution: stems first ------------------------------------------------


def _write_tone(path: Path, seconds: float = 0.2, hz: float = 220.0, rate: int = 8000):
    import numpy as np
    import soundfile as sf

    t = np.arange(int(seconds * rate)) / rate
    sf.write(str(path), (0.3 * np.sin(2 * np.pi * hz * t)).astype("float32"), rate)


def test_resolve_vocal_audio_mixes_every_vocal_stem(client, tmp_path, monkeypatch):
    eid = _seed(tmp_path, client)
    stems_dir = _entry_dir(eid) / "stems"
    stems_dir.mkdir()
    for name in ("vocals", "backup_vocals", "drums"):
        _write_tone(stems_dir / f"{name}.wav")
    db = library_router_module.get_store().db
    assert db is not None
    for name in ("drums", "backup_vocals", "vocals"):
        db.add_stem(
            stem_id=f"{eid}__{name}",
            entry_id=eid,
            stem_name=name,
            audio_path=str(stems_dir / f"{name}.wav"),
        )
    monkeypatch.setattr(service, "_stems_available", lambda: False)
    work = tmp_path / "work"
    work.mkdir()
    path, source = asyncio.run(service._resolve_vocal_audio(eid, work, True))
    assert source == "stem"
    assert path == work / "vocals_mix.wav" and path.is_file()
    import soundfile as sf

    info = sf.info(str(path))
    assert (
        info.channels == 1
        and info.frames == sf.info(str(stems_dir / "vocals.wav")).frames
    )
    # Lead only: the stem itself is used, no mixing.
    db.delete_entry  # noqa: B018 - presence check; stems rows go with the entry
    (stems_dir / "backup_vocals.wav").unlink()
    path2, source2 = asyncio.run(service._resolve_vocal_audio(eid, work, True))
    # Lead only: still normalised into the work file (whisper likes a level).
    assert source2 == "stem" and path2 == work / "vocals_mix.wav"


def test_resolve_vocal_audio_runs_the_stemmer_when_installed(
    client, tmp_path, monkeypatch
):
    eid = _seed(tmp_path, client)
    db = library_router_module.get_store().db
    assert db is not None
    stems_dir = _entry_dir(eid) / "stems"
    stems_dir.mkdir()
    calls = []

    async def fake_separate(entry_id):
        calls.append(entry_id)
        _write_tone(stems_dir / "vocals.wav")
        db.add_stem(
            stem_id=f"{entry_id}__vocals",
            entry_id=entry_id,
            stem_name="vocals",
            audio_path=str(stems_dir / "vocals.wav"),
        )

    monkeypatch.setattr(service, "_stems_available", lambda: True)
    monkeypatch.setattr(service, "_separate_stems", fake_separate)
    job = create_job("lyrics", "t")
    work = tmp_path / "work"
    work.mkdir()
    path, source = asyncio.run(service._resolve_vocal_audio(eid, work, True, job))
    assert calls == [eid] and source == "stem" and path == work / "vocals_mix.wav"
    assert "separating stems" in job.message


def test_resolve_vocal_audio_falls_back_when_the_stemmer_fails(
    client, tmp_path, monkeypatch
):
    eid = _seed(tmp_path, client)

    async def boom(entry_id):
        raise RuntimeError("sidecar down")

    monkeypatch.setattr(service, "_stems_available", lambda: True)
    monkeypatch.setattr(service, "_separate_stems", boom)

    async def fake_isolate(src, out, method="vocal_isolate"):
        return src  # isolation unavailable -> the mix

    monkeypatch.setattr(service.isolation, "isolate", fake_isolate)
    work = tmp_path / "work"
    work.mkdir()
    path, source = asyncio.run(service._resolve_vocal_audio(eid, work, True))
    assert source == "mix" and path == _entry_dir(eid) / "output.wav"
    path3, source3 = asyncio.run(service._resolve_vocal_audio(eid, work, False))
    assert source3 == "mix"


def test_language_helpers():
    assert service._language_for_request(None) == "auto"
    assert service._language_for_request("AUTO") == "auto"
    assert service._language_for_request(" ja ") == "ja"
    assert service._language_detected({"language": "es"}, "auto") == "es"
    assert service._language_detected({"language": "es"}, "fr") == "fr"
    assert service._language_detected({}, "auto") == "en"


def test_hotwords_and_decode_options_for_sung_vocals():
    """The song's own vocabulary rides every whisper window; the pasted text
    primes the first one; both stay inside whisper's 224-token prompt."""
    from backend.modules.lyrics.service import (
        HOTWORDS_MAX,
        PROMPT_WORDS,
        decode_options,
        hotwords_for,
    )

    text = "Run with me now\nRun with me now\nDrum of glass wings\nPulling us up\n" * 3
    hot = hotwords_for(text)
    words = hot.split()
    assert words[0] == "Run"  # most frequent content word first
    assert "with" not in words and "me" not in words and "of" not in words
    assert "Drum" in words and "glass" in words and "wings" in words
    assert len(set(w.lower() for w in words)) == len(words)  # distinct
    many = " ".join(f"word{i}" for i in range(500))
    assert len(hotwords_for(many).split()) == HOTWORDS_MAX
    opts = decode_options(text)
    assert opts["hotwords"] == hot
    assert len(opts["initial_prompt"].split()) <= PROMPT_WORDS
    assert opts["vad_filter"] is True and opts["condition_on_previous_text"] is False
    assert opts["beam_size"] >= 5 and opts["hallucination_silence_threshold"] > 0
    # No text: the title primes the first window, no hotwords.
    bare = decode_options(None, "Drum of Glass Wings")
    assert bare["initial_prompt"] == "Drum of Glass Wings" and "hotwords" not in bare
    assert "initial_prompt" not in decode_options(None, "")


def test_run_align_forced_alignment_times_every_word_then_reviews(
    client, tmp_path, monkeypatch
):
    """The default ALIGN: the MMS forced aligner places the user's own words
    (no transcription), the document is saved and the job is done, and the
    whisper review pass is registered as the entry's next job."""
    eid = _seed(tmp_path, client)
    client.put(f"/api/lyrics/{eid}", json={"text": "hello world\nsecond line"})
    wav = _entry_dir(eid) / "output.wav"

    async def fake_resolve(entry_id, work, isolate, job=None):
        return wav, "stem"

    def fake_align_lines(path, lines, *, duration_ms, scale, progress=None, **_):
        assert path == wav and scale == 1.0
        progress("listening")
        t = 1000
        for ln in lines:
            for w in ln.words:
                w.start_ms, w.end_ms = t, t + 300
                t += 400
            ln.confidence = 1.0
        from backend.modules.lyrics.align import _finish_lines
        from backend.modules.lyrics.schema import LyricsStats

        _finish_lines(lines)
        return lines, LyricsStats(matched=4, total=4, aligner="mms")

    reviews = []
    monkeypatch.setattr(service, "_resolve_vocal_audio", fake_resolve)
    monkeypatch.setattr(service.forced_align, "align_lines", fake_align_lines)
    monkeypatch.setattr(service, "aligner_choice", lambda: "mms")
    monkeypatch.setattr(service.transcription, "available", lambda: True)
    monkeypatch.setattr(
        service, "begin_review", lambda e, text, lang: reviews.append((e, text))
    )
    job = create_job("lyrics", "align")
    asyncio.run(service.run_align(job, eid, {"isolate": True}))
    assert job.status == "done", job.error
    assert "timed 4/4" in job.message
    doc = service.load_doc(eid)
    assert doc is not None and doc.source == "aligned"
    assert doc.stats is not None and doc.stats.aligner == "mms"
    words = [w for ln in doc.lines for w in ln.words]
    assert [w.start_ms for w in words] == [1000, 1400, 1800, 2200]
    assert doc.lines[0].start_ms == 1000 and doc.lines[1].start_ms == 1800
    assert reviews == [(eid, "hello world\nsecond line")]
    # review off: no review job.
    reviews.clear()
    job2 = create_job("lyrics", "align")
    asyncio.run(service.run_align(job2, eid, {"isolate": True, "review": False}))
    assert job2.status == "done" and reviews == []


def test_run_review_flags_words_whisper_heard_differently(
    client, tmp_path, monkeypatch
):
    eid = _seed(tmp_path, client)
    client.put(f"/api/lyrics/{eid}", json={"text": "night falls on the quiet town"})
    doc = service.load_doc(eid)
    t = 1000
    for w in doc.lines[0].words:
        w.start_ms, w.end_ms = t, t + 300
        t += 400
    doc.lines[0].start_ms, doc.lines[0].end_ms = 1000, 3300
    service.save_doc(doc)
    wav = _entry_dir(eid) / "output.wav"

    async def fake_resolve(entry_id, work, isolate, job=None):
        return wav, "stem"

    async def fake_transcribe(path, language="en", cfg=None, extra=None):
        words = "night falls on the silent town".split()
        return {
            "ok": True,
            "language": "en",
            "text": " ".join(words),
            "segments": [
                {
                    "text": " ".join(words),
                    "start": 1.0,
                    "end": 3.3,
                    "words": [
                        {"word": w, "start": 1.0 + 0.4 * i, "end": 1.3 + 0.4 * i}
                        for i, w in enumerate(words)
                    ],
                }
            ],
        }

    monkeypatch.setattr(service, "_resolve_vocal_audio", fake_resolve)
    monkeypatch.setattr(service.transcription, "transcribe", fake_transcribe)
    job = create_job("lyrics", "review")
    asyncio.run(service.run_review(job, eid, {"text": doc.text, "language": "auto"}))
    assert job.status == "done", job.error
    reviewed = service.load_doc(eid)
    words = reviewed.lines[0].words
    assert words[4].text == "quiet" and words[4].heard == "silent"
    assert all(w.heard is None for w in words if w.text != "quiet")
    # The aligner's timings are untouched by the review.
    assert [w.start_ms for w in words] == [1000, 1400, 1800, 2200, 2600, 3000]
    assert reviewed.stats.mismatched == 1 and reviewed.stats.reviewed is True
    assert "1 words differ" in job.message

    # Whisper heard something else entirely: not evidence, nothing flagged.
    async def babble(path, language="en", cfg=None, extra=None):
        words = "la la la la la la".split()
        return {
            "ok": True,
            "language": "en",
            "text": " ".join(words),
            "segments": [
                {
                    "text": " ".join(words),
                    "start": 1.0,
                    "end": 3.3,
                    "words": [
                        {"word": w, "start": 1.0 + 0.4 * i, "end": 1.3 + 0.4 * i}
                        for i, w in enumerate(words)
                    ],
                }
            ],
        }

    monkeypatch.setattr(service.transcription, "transcribe", babble)
    job2 = create_job("lyrics", "review")
    asyncio.run(service.run_review(job2, eid, {"text": doc.text, "language": "auto"}))
    assert job2.status == "done", job2.error
    again = service.load_doc(eid)
    assert all(w.heard is None for w in again.lines[0].words)
    assert again.stats.mismatched == 0 and again.stats.reviewed is False
    assert "could not follow" in job2.message
