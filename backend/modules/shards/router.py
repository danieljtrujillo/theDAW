"""FastAPI router for the Shard Index (prefix ``/api/shards``).

GET  /{entry_id}            the entry's shards (empty list when not sharded)
POST /{entry_id}/run        (re)shard the entry now
POST /query                 ranked shards for a query
POST /pairings              complements for a shard, or between two entries
POST /keep                  remember a kept pairing (taste memory)
GET  /{shard_id}/audio      WAV crop, optionally conformed (?bpm=&semitones=)
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from backend.modules.library.router import get_store as get_library_store

from .service import (
    STRETCH_DEFAULT,
    key_to_camelot,
    rank_complements,
    rank_shards,
    shard_wav_bytes,
    transpose_semitones,
)

log = logging.getLogger(__name__)

router = APIRouter()


def _db():
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library database is not available")
    return store, store.db


def _cache_dir() -> Path:
    store = get_library_store()
    return Path(store.root).parent / "cache" / "shards"


class QueryBody(BaseModel):
    role: Optional[str] = None
    beats: Optional[int] = None
    entry: Optional[str] = Field(None, description="Restrict to one entry id")
    exclude_entry: Optional[str] = None
    camelot_of: Optional[str] = Field(
        None, description="An entry id whose key the results should fit"
    )
    key: Optional[str] = None
    scale: Optional[str] = None
    bpm: Optional[float] = None
    stretch_max: float = STRETCH_DEFAULT
    energy: Optional[tuple[float, float]] = None
    section: Optional[str] = None
    mask_like: Optional[int] = None
    text: Optional[str] = None
    limit: int = 50


class PairingsBody(BaseModel):
    shard_id: Optional[str] = None
    entry_a: Optional[str] = None
    entry_b: Optional[str] = None
    role: Optional[str] = None
    beats: Optional[int] = 4
    limit: int = 50


class KeepBody(BaseModel):
    a_id: str
    b_id: str


@router.post("/query")
def query_shards(body: QueryBody) -> dict[str, Any]:
    _, db = _db()
    camelot = ""
    if body.camelot_of:
        a = db.get_analysis(body.camelot_of) or {}
        camelot = key_to_camelot(str(a.get("key") or ""), str(a.get("scale") or ""))
    elif body.key:
        camelot = key_to_camelot(body.key, body.scale or "")
    cands = db.select_shards(
        role=body.role,
        beats=body.beats,
        entry_id=body.entry,
        exclude_entry=body.exclude_entry,
        section=body.section,
        text=body.text,
        limit=5000,
    )
    ranked = rank_shards(
        cands,
        camelot=camelot,
        bpm=body.bpm,
        stretch_max=body.stretch_max,
        energy=body.energy,
        mask_like=body.mask_like,
        pair_counts=db.pairing_counts(),
        limit=max(1, min(500, body.limit)),
    )
    if body.key:
        for r in ranked:
            r["transpose"] = transpose_semitones(
                str(r.get("key") or ""),
                str(r.get("scale") or ""),
                body.key,
                body.scale or "",
            )
    return {"count": len(ranked), "camelot": camelot, "shards": ranked}


@router.post("/pairings")
def pairings(body: PairingsBody) -> dict[str, Any]:
    _, db = _db()
    if body.shard_id:
        ref = db.get_shard(body.shard_id)
        if not ref:
            raise HTTPException(404, "shard not found")
        cands = db.select_shards(
            role=body.role,
            beats=body.beats or int(ref.get("beats") or 4),
            exclude_entry=ref.get("entry_id"),
            limit=8000,
        )
        return {
            "ref": ref,
            "complements": rank_complements(
                ref, cands, pair_counts=db.pairing_counts(), limit=body.limit
            ),
        }
    if body.entry_a and body.entry_b:
        a_rows = db.select_shards(
            entry_id=body.entry_a, beats=body.beats or 4, role=body.role, limit=4000
        )
        b_rows = db.select_shards(
            entry_id=body.entry_b, beats=body.beats or 4, limit=4000
        )
        pairs: list[dict[str, Any]] = []
        for ref in a_rows[: min(len(a_rows), 64)]:
            for c in rank_complements(ref, b_rows, limit=3):
                pairs.append({"a": ref, "b": c, "score": c["score"]})
        pairs.sort(key=lambda p: p["score"], reverse=True)
        return {"pairs": pairs[: body.limit]}
    raise HTTPException(400, "give shard_id, or entry_a and entry_b")


@router.post("/keep")
def keep(body: KeepBody) -> dict[str, Any]:
    _, db = _db()
    if not db.get_shard(body.a_id) or not db.get_shard(body.b_id):
        raise HTTPException(404, "shard not found")
    weight = db.bump_pairing(body.a_id, body.b_id)
    return {"ok": True, "weight": weight}


@router.get("/{shard_id}/audio")
def shard_audio(
    shard_id: str, bpm: Optional[float] = None, semitones: float = 0.0
) -> Response:
    store, db = _db()
    shard = db.get_shard(shard_id)
    if not shard:
        raise HTTPException(404, "shard not found")
    entry_dir = store._dir_for(shard["entry_id"])  # noqa: SLF001 - the store's own path rule
    src: Optional[Path] = None
    if shard.get("stem_name") and shard["stem_name"] != "mix":
        for r in db.list_stems(shard["entry_id"]):
            if r.get("stem_name") == shard["stem_name"]:
                p = Path(str(r.get("audio_path") or ""))
                if not p.is_absolute() and entry_dir is not None:
                    p = Path(entry_dir) / p
                if p.is_file():
                    src = p
                break
    if src is None:
        audio = store.get_audio_path(shard["entry_id"])
        if not audio or not Path(audio).is_file():
            raise HTTPException(404, "the shard's audio is no longer on disk")
        src = Path(audio)
    try:
        data = shard_wav_bytes(
            shard, src, bpm=bpm, semitones=semitones, cache_dir=_cache_dir()
        )
    except Exception as e:  # noqa: BLE001
        log.exception("shards: crop failed for %s", shard_id)
        raise HTTPException(500, f"could not render the shard: {e}")
    return Response(
        content=data,
        media_type="audio/wav",
        headers={"Cache-Control": "private, max-age=3600"},
    )


@router.get("/{entry_id}")
def entry_shards(entry_id: str) -> dict[str, Any]:
    _, db = _db()
    rows = db.list_shards(entry_id)
    return {"entry_id": entry_id, "count": len(rows), "shards": rows}


@router.post("/{entry_id}/run")
async def run_shards(entry_id: str, force: bool = True) -> dict[str, Any]:
    from backend.core import pipeline

    try:
        rows = await pipeline.ensure_shards(entry_id, force=force)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    return {"entry_id": entry_id, "count": len(rows)}
