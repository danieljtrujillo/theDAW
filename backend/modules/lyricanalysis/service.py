"""Lyric-analysis service: the on-disk LyricAnalysisDoc, its artifact row, and
the deterministic (+ optional LLM) analysis job.

The document is derived entirely from the entry's ``LyricsDoc``, so it carries
the ``updated_at`` it was computed from: edit the lyrics and the stored
analysis reports itself stale instead of painting devices onto words that have
moved.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Iterable, Optional

from backend.core.jobs import Job
from backend.modules.library.router import get_store
from backend.modules.lyrics import service as lyrics_service
from backend.modules.lyrics.schema import LyricsDoc, split_text

from .schema import (
    ANALYZER_VERSION,
    ARTIFACT_KIND,
    DOC_FILENAME,
    FAMILY_OF,
    AnalyzeTextRequest,
    Device,
    LlmPass,
    LyricAnalysisDoc,
    LyricMark,
)

log = logging.getLogger(__name__)

_running: set[asyncio.Task] = set()
# entry_id -> the analysis job running for it (one at a time). The job registry
# is in-process (backend/core/jobs.py) and is lost on a backend restart, so a
# job id never survives one: the saved lyric_analysis.json on disk is the only
# durable state, and a reconnecting SING tab reads that.
_active_jobs: dict[str, Job] = {}


def active_job(entry_id: str) -> Optional[Job]:
    job = _active_jobs.get(entry_id)
    if job is not None and job.status in ("queued", "running"):
        return job
    _active_jobs.pop(entry_id, None)
    return None


def register_job(entry_id: str, job: Job) -> None:
    _active_jobs[entry_id] = job


async def wait_job(job: Job) -> None:
    """Wait for a job somebody else started to leave queued/running."""
    q = job.subscribe()
    try:
        while job.status in ("queued", "running"):
            try:
                await asyncio.wait_for(q.get(), timeout=2.0)
            except asyncio.TimeoutError:
                continue
    finally:
        job.unsubscribe(q)


# ---- paths and documents ----------------------------------------------------


def artifact_id(entry_id: str) -> str:
    return f"{entry_id}__lyricanalysis__analysis"


def doc_path(entry_id: str) -> Optional[Path]:
    entry_dir = get_store()._dir_for(entry_id)
    return None if entry_dir is None else entry_dir / DOC_FILENAME


def load_doc(entry_id: str) -> Optional[LyricAnalysisDoc]:
    path = doc_path(entry_id)
    if path is None or not path.is_file():
        return None
    try:
        return LyricAnalysisDoc.model_validate(
            json.loads(path.read_text(encoding="utf-8"))
        )
    except Exception as e:  # noqa: BLE001 - a corrupt file reads as absent
        log.warning("lyricanalysis: %s unreadable: %s", path, e)
        return None


def _atomic_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def save_doc(doc: LyricAnalysisDoc) -> LyricAnalysisDoc:
    store = get_store()
    path = doc_path(doc.entry_id)
    if path is None:
        raise KeyError(doc.entry_id)
    _atomic_write(path, doc.model_dump())
    if store.db is not None:
        try:
            store.db.add_notation_artifact(
                artifact_id=artifact_id(doc.entry_id),
                entry_id=doc.entry_id,
                kind=ARTIFACT_KIND,
                path=str(path),
                engine="lyricanalysis",
                engine_version=str(doc.analyzer_version),
                metadata={
                    "devices": len(doc.devices),
                    "families": doc.stats.devices_by_family,
                    "scheme": doc.scheme,
                    "llm": bool(doc.llm and not doc.llm.error),
                },
            )
        except Exception as e:  # noqa: BLE001 - the file is the truth; the row is a cache
            log.warning(
                "lyricanalysis: artifact row failed for %s: %s", doc.entry_id, e
            )
    return doc


def delete_doc(entry_id: str) -> bool:
    store = get_store()
    if store.get_entry(entry_id) is None:
        raise KeyError(entry_id)
    path = doc_path(entry_id)
    removed = False
    if path is not None and path.is_file():
        path.unlink()
        removed = True
    if store.db is not None:
        try:
            removed = (
                store.db.delete_notation_artifact(artifact_id(entry_id)) or removed
            )
        except Exception as e:  # noqa: BLE001
            log.warning(
                "lyricanalysis: artifact row delete failed for %s: %s", entry_id, e
            )
    return removed


# ---- the lyrics this analysis is of -----------------------------------------


def source_lyrics(entry_id: str) -> LyricsDoc:
    """The entry's timed lyrics document — the saved one when there is one, so
    word and line timings come along, else the untimed document SING would
    derive from the entry's metadata. Raises KeyError for an unknown entry."""
    doc = lyrics_service.load_doc(entry_id)
    if doc is not None:
        return doc
    bundle = lyrics_service.get_bundle(entry_id)
    return LyricsDoc.model_validate(bundle["doc"])


def source_text_hash(lyrics: LyricsDoc) -> str:
    """Fingerprint of the words an analysis read.

    ``derive.py`` builds an untimed document without ever setting
    ``updated_at``, so a derived source sits at 0.0 forever and a timestamp
    comparison can never see it change. The lines are what the detectors
    actually consume, so the lines are what is hashed."""
    joined = "\n".join(f"{ln.kind}:{ln.text}" for ln in lyrics.lines)
    return hashlib.blake2s(joined.encode("utf-8"), digest_size=16).hexdigest()


def is_stale(doc: LyricAnalysisDoc, lyrics: Optional[LyricsDoc]) -> bool:
    """An analysis is stale when the words moved under it, or when the
    detectors have changed what they emit since it was written."""
    if doc.analyzer_version < ANALYZER_VERSION:
        return True
    if lyrics is None:
        return False
    # The hash decides whenever both sides carry one; the timestamp is only the
    # fallback for analyses written before the hash field existed.
    if doc.source_text_hash:
        return source_text_hash(lyrics) != doc.source_text_hash
    return lyrics.updated_at > doc.source_updated_at


def get_bundle(entry_id: str) -> dict[str, Any]:
    """``{doc, persisted, stale}``. Nothing is derived here: the analysis is
    CPU work and only ever runs behind a job, so an entry with no stored
    document reports ``doc: None`` and the UI offers the run."""
    store = get_store()
    if store.get_entry(entry_id) is None:
        raise KeyError(entry_id)
    doc = load_doc(entry_id)
    if doc is None:
        return {"doc": None, "persisted": False, "stale": False}
    # `source_lyrics`, not `lyrics_service.load_doc`: an entry whose words are
    # derived rather than saved has no lyrics document at all, and reading None
    # here would report every such analysis as fresh forever.
    try:
        lyrics: Optional[LyricsDoc] = source_lyrics(entry_id)
    except Exception as e:  # noqa: BLE001 - staleness is a hint, not the payload
        log.warning("lyricanalysis: source lyrics unreadable for %s: %s", entry_id, e)
        lyrics = None
    return {
        "doc": doc.model_dump(),
        "persisted": True,
        "stale": is_stale(doc, lyrics),
    }


# ---- the analysis itself -----------------------------------------------------


def _pronunciation_source(guessed: int, unique_words: int) -> str:
    """What actually backed the phones: the dictionary, the letter-to-sound
    rules, or both.

    Both inputs are counts of DISTINCT normalised words — ``guessed_
    pronunciations`` and ``unique_words`` are de-duplicated the same way — so
    they must be compared against each other. Comparing the unique guessed
    count against the total token count reported "mixed" for a lyric that
    repeats itself and was in fact guessed end to end. And when the dictionary
    is not installed in this process at all, nothing can have come from it.
    """
    from .phonetics import PRONUNCIATION_SOURCE

    if PRONUNCIATION_SOURCE != "cmudict":
        return "rules"
    if unique_words <= 0:
        return "rules"
    if guessed <= 0:
        return "cmudict"
    return "rules" if guessed >= unique_words else "mixed"


def _recount(doc: LyricAnalysisDoc) -> None:
    """Re-tally the per-kind / per-family counters. Called after the LLM pass
    appends its findings so the stats always describe the stored document."""
    by_kind: dict[str, int] = {}
    by_family: dict[str, int] = {}
    for device in doc.devices:
        by_kind[device.kind] = by_kind.get(device.kind, 0) + 1
        by_family[device.family] = by_family.get(device.family, 0) + 1
    doc.stats.devices_by_kind = by_kind
    doc.stats.devices_by_family = by_family


def analyse_lyrics(entry_id: str, lyrics: LyricsDoc) -> LyricAnalysisDoc:
    """The deterministic pass. Pure CPU: callers on the event loop run it under
    ``asyncio.to_thread``."""
    from .devices import analyse

    devices, lines, sections, stats = analyse(lyrics)
    scheme = " ".join(s.scheme for s in sections if s.scheme)
    if not scheme:
        scheme = "".join(ln.letter for ln in lines if ln.letter)
    doc = LyricAnalysisDoc(
        entry_id=entry_id,
        language=lyrics.language or "en",
        source_updated_at=lyrics.updated_at,
        source_text_hash=source_text_hash(lyrics),
        pronunciation_source=_pronunciation_source(
            stats.guessed_pronunciations, stats.unique_words
        ),
        devices=list(devices),
        lines=list(lines),
        sections=list(sections),
        scheme=scheme,
        stats=stats,
        updated_at=time.time(),
    )
    _recount(doc)
    return doc


# ---- the writer's own marks --------------------------------------------------
#
# A mark is not a detection and must not pretend to be one, but it has to reach
# the UI as a ``Device`` because that is the only shape the analysis pane
# paints. The discriminator is the id and the group: both carry
# ``MARK_DEVICE_PREFIX``, which no detector can produce (``devices._Out`` mints
# ``<kind>-<hex>`` ids and content-derived groups, neither of which contains a
# colon). ``Device.source`` keeps the meaning it has always had — "rules" = the
# deterministic pass computed it here, "llm" = the interpretive pass proposed
# it — and is NOT how you tell a mark apart; ``is_mark_device`` is.
#
# The mark itself, with its verdict, its note and its timestamps, stays at
# ``GET /documents/{id}/marks``. The device is only a handle onto it: strip the
# prefix off ``Device.id`` and you have the ``LyricMark.id`` to join on.

MARK_DEVICE_PREFIX = "mark:"
# A mark that names a device kind keeps that kind's family, so it filters and
# colours with its peers. A kind the taxonomy has no word for — which the
# writer is explicitly allowed to invent — lands in a family of its own rather
# than being filed under an interpretation nobody made.
MARK_FAMILY = "mark"


def is_mark_device(device: Device) -> bool:
    """True for a device that is a writer's mark rather than a detection."""
    return device.id.startswith(MARK_DEVICE_PREFIX)


def mark_device(mark: LyricMark) -> Device:
    """The writer's mark in the shape the analysis pane paints."""
    kind = mark.kind or "note"
    words = " / ".join(s.text for s in mark.spans if s.text)
    return Device(
        id=f"{MARK_DEVICE_PREFIX}{mark.id}",
        kind=kind,
        family=FAMILY_OF.get(kind, MARK_FAMILY),
        label=mark.label or (f"{kind}: {words}" if words else kind),
        # Marks the writer grouped together are one thing, exactly as two halves
        # of a detected rhyme are; a lone mark is its own group.
        group=f"{MARK_DEVICE_PREFIX}{mark.group or mark.id}",
        spans=list(mark.spans),
        detail=mark.note
        or (
            "the writer confirmed this"
            if mark.verdict == "confirm"
            else "the writer marked this"
        ),
        confidence=1.0,
        source="rules",
    )


def apply_marks(
    doc: LyricAnalysisDoc,
    marks: Iterable[LyricMark],
    *,
    skip: Iterable[str] = (),
) -> LyricAnalysisDoc:
    """The analysis as the writer's marks leave it, as a COPY.

    A ``reject`` removes the detected devices in the group it names — matched on
    ``Device.group``, because a group is derived from the content it describes
    and survives the re-run that re-mints every device id. A device that carries
    no group at all can only be named by its id, and that id is a hash of the
    device's own kind, detail and spans, so it is stable for as long as the
    words are: such a reject is honoured too, or rejecting a groupless finding
    would silently do nothing. ``mark`` and ``confirm`` are appended as mark
    devices.

    ``skip`` names marks not to paint: the stale ones, whose anchors no longer
    match the words. A reject still applies while its own spans are stale,
    because it suppresses by group and never touches a span at all.

    The document passed in is not modified — the file on disk holds detections
    only, which is what makes a re-run unable to overwrite a mark.
    """
    marks = list(marks)
    if not marks:
        return doc
    rejected = {
        m.target_group for m in marks if m.verdict == "reject" and m.target_group
    }
    skipped = set(skip)
    merged = doc.model_copy(deep=True)
    devices = [
        d
        for d in merged.devices
        if (d.group not in rejected if d.group else d.id not in rejected)
    ]
    devices.extend(
        mark_device(m) for m in marks if m.verdict != "reject" and m.id not in skipped
    )
    merged.devices = devices
    # The stats have to describe what is on the screen, not what the detectors
    # found before the writer had their say.
    _recount(merged)
    return merged


def analyze_text(req: AnalyzeTextRequest) -> LyricAnalysisDoc:
    """Pasted text, no entry, nothing written: the scratch pad path. The text
    is split into the same LyricsDoc shape the library path uses, so the
    findings carry the identical (line, word) anchors."""
    lyrics = LyricsDoc(
        entry_id="",
        language=req.language or "en",
        source="manual",
        text=req.text or "",
        lines=split_text(req.text or ""),
    )
    return analyse_lyrics("", lyrics)


# ---- jobs --------------------------------------------------------------------


def _track(task: asyncio.Task) -> None:
    _running.add(task)
    task.add_done_callback(_running.discard)


def start_run(job: Job, entry_id: str, req: dict[str, Any]) -> None:
    _track(asyncio.create_task(run_analysis(job, entry_id, req)))


def begin_run(entry_id: str, req: dict[str, Any]) -> tuple[Job, bool]:
    """Start an analysis for the entry, or hand back the one already running
    for it (second flag True) so two SCORE/SING tabs never analyse one song
    twice."""
    from backend.core.jobs import create_job

    job = active_job(entry_id)
    if job is not None:
        return job, True
    job = create_job("lyricanalysis", f"Analyse lyrics ({entry_id})")
    register_job(entry_id, job)
    start_run(job, entry_id, req)
    return job, False


def _reusable(
    entry_id: str, req: dict[str, Any], lyrics: LyricsDoc
) -> Optional[LyricAnalysisDoc]:
    """The stored document when it still describes these lyrics and already
    has whatever the request asked for. ``force`` skips this."""
    if req.get("force"):
        return None
    doc = load_doc(entry_id)
    if doc is None or is_stale(doc, lyrics):
        return None
    if req.get("llm") and (doc.llm is None or doc.llm.error):
        return None
    # A different provider or model is a different reading, so it is not what
    # the caller asked for even though the document is otherwise current.
    if req.get("llm") and doc.llm is not None:
        wanted_provider = str(req.get("provider") or "")
        wanted_model = str(req.get("model") or "")
        if wanted_provider and wanted_provider != doc.llm.provider:
            return None
        if wanted_model and wanted_model != doc.llm.model:
            return None
    return doc


async def run_analysis(job: Job, entry_id: str, req: dict[str, Any]) -> None:
    try:
        job.update(status="running", progress=0.05, message="reading the lyrics")
        lyrics = source_lyrics(entry_id)
        if not any(ln.kind == "lyric" and ln.words for ln in lyrics.lines):
            raise RuntimeError("no lyrics to analyse: paste or transcribe them first")
        cached = _reusable(entry_id, req, lyrics)
        if cached is not None:
            job.result = cached.model_dump()
            job.update(
                status="done", progress=1.0, message="analysis is already up to date"
            )
            return
        job.update(progress=0.2, message="finding rhymes, sounds and repetitions")
        doc = await asyncio.to_thread(analyse_lyrics, entry_id, lyrics)
        note = ""
        if req.get("llm"):
            note = await _run_llm_pass(job, doc, lyrics, req)
        job.update(progress=0.9, message="saving")
        doc.updated_at = time.time()
        save_doc(doc)
        job.result = doc.model_dump()
        job.update(
            status="done",
            progress=1.0,
            message=f"found {len(doc.devices)} devices across {len(doc.lines)} lines{note}",
        )
    except Exception as e:  # noqa: BLE001 - the job reports every failure
        log.exception("lyricanalysis run failed")
        job.error = repr(e)
        job.update(status="failed", message=str(e))


async def _run_llm_pass(
    job: Job, doc: LyricAnalysisDoc, lyrics: LyricsDoc, req: dict[str, Any]
) -> str:
    """Append the interpretive findings, or record why there are none.

    A failed reading must never look like "no metaphors in this song", so the
    reason lands on ``LlmPass.error`` AND in the job message; the deterministic
    analysis is still saved, because it is still correct.
    """
    from . import llm as llm_mod

    job.update(progress=0.6, message="asking the model for the interpretive pass")
    try:
        devices, provenance = await llm_mod.interpret(
            lyrics,
            provider=str(req.get("provider") or ""),
            model=str(req.get("model") or ""),
            api_key=str(req.get("api_key") or ""),
        )
    except llm_mod.LlmError as e:
        log.info("lyricanalysis: interpretive pass skipped: %s", e)
        doc.llm = _failed_pass(req, str(e))
        return f"; interpretive pass failed ({e})"
    except Exception as e:  # noqa: BLE001 - a bad reading must not lose a good analysis
        # Anything the pass raises that is not an LlmError is a bug or a reply
        # shaped in a way nobody anticipated; either way the deterministic
        # findings are still correct and still get saved.
        log.exception("lyricanalysis: interpretive pass crashed")
        reason = f"{type(e).__name__}: {e}"
        doc.llm = _failed_pass(req, reason)
        return f"; interpretive pass failed ({reason})"
    doc.devices.extend(devices)
    doc.llm = provenance
    _recount(doc)
    return f"; {len(devices)} from {provenance.provider}"


def _failed_pass(req: dict[str, Any], error: str) -> LlmPass:
    """The provenance row for a pass that was asked for and could not run."""
    return LlmPass(
        provider=str(req.get("provider") or ""),
        model=str(req.get("model") or ""),
        ran_at=time.time(),
        error=error,
    )
