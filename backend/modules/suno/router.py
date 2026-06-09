"""
Suno public-API proxy module (Berklee Hackathon API).

A self-contained layer that proxies StableDAW's frontend to the Suno public
API at ``https://api.suno.com`` so the secret API key NEVER reaches the
browser. Adapted from SunoHarvester's proven Suno-proxy pattern.

What this module does:
  - Holds the Suno API key server-side: ``SUNO_API_KEY`` env first, else the
    in-app data file ``data/suno_api_key.json`` (settable via ``POST /key``).
  - Proxies the four generation modes (simple / custom / cover / mashup),
    polling, voices, and account usage.
  - Tracks every submitted job in ``data/suno_jobs.json`` (a dict keyed by the
    Suno clip id) so the frontend can list/poll them across restarts.
  - On completion, registers the finished MP3 as a FIRST-CLASS library entry
    via ``backend.modules.library``'s ``import_blob`` so Suno tracks are
    indistinguishable from local generations in the catalog.
  - For cover / mashup, writes ``relations`` lineage edges (parent → child) so
    the existing library lineage graph shows the derivation. Parents are
    resolved by the ``sunoid:<clip_id>`` tag we stamp on every imported entry;
    unresolved parents are kept as raw (external) clip-id nodes — the relations
    table is polymorphic so non-entry ids render as external nodes.

Mounted at /api/suno by backend/modules/loader.py (api_prefix in module.json).
The APIRouter here has NO prefix — the loader applies ``api_prefix``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

router = APIRouter()

# CHANGED: lock around the poll→register flow to prevent duplicate library imports
# when two concurrent poll requests both see a job as just-completed.
_register_lock = asyncio.Lock()

# CHANGED: allowlist for audio_url hosts — prevents SSRF via tampered suno_jobs.json.
_ALLOWED_AUDIO_HOSTS = frozenset(
    {"cdn.suno.ai", "cdn1.suno.ai", "cdn2.suno.ai", "audiopipe.suno.ai"}
)
log = logging.getLogger(__name__)

# backend/modules/suno/router.py -> parents[3] == StableDAW repo root
PROJECT_ROOT = Path(__file__).resolve().parents[3]
_DEFAULT_BASE = "https://api.suno.com"

# Three preset voices provided by the hackathon API.
PRESET_VOICES = [
    {
        "id": "5b915c6d-8d96-416c-9755-eba65868cfef",
        "name": "Preset A",
        "description": "Female voice",
    },
    {
        "id": "c036ce3a-55e4-4690-9b8d-4516b37a96d5",
        "name": "Preset B",
        "description": "Weird kid voice",
    },
    {
        "id": "27f5465b-73c3-4134-b11e-70b0bd571c6c",
        "name": "Preset C",
        "description": "Low male voice",
    },
]


# ---------------------------------------------------------------------------
# Config / key handling (env first, then in-app data file). Server-side only.
# ---------------------------------------------------------------------------


def _data_dir() -> Path:
    d = PROJECT_ROOT / "data"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _key_file() -> Path:
    return _data_dir() / "suno_api_key.json"


def _read_api_key() -> Optional[str]:
    """Resolve the key: SUNO_API_KEY env wins, else data/suno_api_key.json."""
    env = os.getenv("SUNO_API_KEY")
    if env and env.strip():
        return env.strip()
    f = _key_file()
    if f.exists():
        try:
            return (
                json.loads(f.read_text(encoding="utf-8")).get("key") or ""
            ).strip() or None
        except Exception as exc:  # noqa: BLE001 — a corrupt file must not crash the app
            log.warning("Suno: failed to read key file: %s", exc)
    return None


def _require_key() -> str:
    """Return the key or raise 503 so generation routes fail clearly."""
    key = _read_api_key()
    if not key:
        raise HTTPException(
            status_code=503,
            detail="Suno API key not configured. Set it in-app (POST /api/suno/key) or via the SUNO_API_KEY env var.",
        )
    return key


def _base_url() -> str:
    return os.getenv("SUNO_API_BASE", _DEFAULT_BASE).rstrip("/")


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {_require_key()}",
        "Content-Type": "application/json",
    }


# ---------------------------------------------------------------------------
# Job persistence — dict keyed by Suno clip id, persisted to data/suno_jobs.json
# ---------------------------------------------------------------------------


def _jobs_file() -> Path:
    return _data_dir() / "suno_jobs.json"


def _load_jobs() -> dict[str, dict[str, Any]]:
    f = _jobs_file()
    if f.exists():
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:  # noqa: BLE001
            return {}
    return {}


def _save_jobs(jobs: dict[str, dict[str, Any]]) -> None:
    try:
        _jobs_file().write_text(
            json.dumps(jobs, indent=2, default=str), encoding="utf-8"
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("Suno: failed to persist jobs: %s", exc)


# In-module cache of tracked jobs. Each value also carries our own bookkeeping
# under the keys "mode", "parents" (submit-time parent clip ids for lineage),
# and "library_entry_id" (set once the track is registered, to avoid re-import).
_jobs: dict[str, dict[str, Any]] = _load_jobs()


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------


async def _post(path: str, body: dict[str, Any]) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(f"{_base_url()}{path}", json=body, headers=_headers())
    return _unwrap(resp)


async def _get(path: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{_base_url()}{path}", headers=_headers())
    return _unwrap(resp)


def _unwrap(resp: httpx.Response) -> dict[str, Any]:
    """Return JSON on success; on 4xx/5xx raise HTTPException with the upstream
    error detail surfaced to the caller."""
    if resp.status_code >= 400:
        detail: Any = resp.text
        try:
            payload = resp.json()
            detail = payload.get("error") or payload.get("detail") or payload
        except Exception:  # noqa: BLE001 — non-JSON upstream error body
            pass
        raise HTTPException(status_code=resp.status_code, detail=detail)
    try:
        return resp.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=502, detail=f"Suno returned non-JSON response: {exc}"
        )


# ---------------------------------------------------------------------------
# Request models (mirror the hackathon API)
# ---------------------------------------------------------------------------


class SimpleReq(BaseModel):
    description: str
    title: Optional[str] = None
    voice_id: Optional[str] = None


class CustomReq(BaseModel):
    style: str
    lyrics: Optional[str] = None
    title: Optional[str] = None
    voice_id: Optional[str] = None
    instrumental: bool = False


class CoverReq(BaseModel):
    source_id: str  # the Suno clip id being covered
    lyrics: Optional[str] = None
    style: Optional[str] = None
    voice_id: Optional[str] = None


class MashupReq(BaseModel):
    source_id: str  # the primary Suno clip id (path id)
    additional_audio_id: str  # the second Suno clip id mashed in
    lyrics: Optional[str] = None
    style: Optional[str] = None
    title: Optional[str] = None


def _track(
    result: dict[str, Any], *, mode: str, parents: Optional[list[str]] = None
) -> dict[str, Any]:
    """Record a freshly submitted job + our lineage bookkeeping, then persist."""
    job_id = result.get("id")
    if job_id:
        entry = dict(result)
        entry["mode"] = mode
        entry["parents"] = [p for p in (parents or []) if p]
        _jobs[job_id] = entry
        _save_jobs(_jobs)
    return result


# ---------------------------------------------------------------------------
# First-class library registration on completion
# ---------------------------------------------------------------------------


def _resolve_parent_entry_id(store: Any, suno_clip_id: str) -> Optional[str]:
    """Find the library entry whose tags contain ``sunoid:<suno_clip_id>``.
    Returns the library entry id, or None if not present in the library."""
    needle = f"sunoid:{suno_clip_id}"
    try:
        for rec in store.list_entries():
            if needle in (rec.tags or []):
                return rec.id
    except Exception as exc:  # noqa: BLE001 — resolution is best-effort
        log.debug("Suno: parent resolution scan failed: %s", exc)
    return None


async def _register_completed_job(job: dict[str, Any]) -> Optional[str]:
    """Download the finished MP3 and register it as a first-class library entry.

    Idempotent: if the job already carries a ``library_entry_id`` it is a no-op.
    For cover/mashup it also writes lineage relation edges from each parent
    Suno clip (resolved to a library entry by ``sunoid:`` tag, else kept as the
    raw external clip id). Returns the new library entry id, or None on failure.
    """
    job_id = job.get("id")
    audio_url = job.get("audio_url")
    if not job_id or not audio_url:
        return None
    if job.get("library_entry_id"):
        return job["library_entry_id"]  # already registered — don't double-import

    # CHANGED: SSRF guard — validate the download URL before fetching.
    parsed = urlparse(audio_url)
    if parsed.scheme != "https" or parsed.hostname not in _ALLOWED_AUDIO_HOSTS:
        log.warning(
            "Suno: blocked MP3 download from disallowed host %s", parsed.hostname
        )
        return None

    # Download the MP3.
    # CHANGED: was a blocking sync httpx.Client inside the async poll() coroutine,
    # which stalls the FastAPI event loop while a large MP3 downloads (up to 120s).
    # Use the async client and await it so the loop stays responsive. (audit #5)
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.get(audio_url)
            resp.raise_for_status()
            mp3_bytes = resp.content
    except Exception as exc:  # noqa: BLE001 — registration is best-effort; polling still works
        log.warning("Suno: failed to download MP3 for %s: %s", job_id, exc)
        return None

    meta = job.get("metadata") or {}
    mode = job.get("mode") or "custom"
    title = job.get("title") or f"suno_{str(job_id)[:8]}"
    prompt = meta.get("description") or meta.get("lyrics") or ""
    filename = f"{title}.mp3"

    try:
        from backend.modules.library.router import get_store

        store = get_store()
        rec = store.import_blob(
            mp3_bytes,
            filename,
            "audio/mpeg",
            {
                "title": title,
                "prompt": prompt,
                "model": "suno",
                "source": "generate",
                # The sunoid tag is what lets future cover/mashup children
                # resolve THIS track as their parent in the lineage graph.
                "tags": ["suno", mode, f"sunoid:{job_id}"],
            },
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("Suno: failed to register library entry for %s: %s", job_id, exc)
        return None

    entry_id = rec.id

    # Lineage edges for derived tracks (cover/mashup).
    if mode in ("cover", "mashup"):
        parents = _gather_parent_clip_ids(job, meta)
        for parent_clip_id in parents:
            from_id = _resolve_parent_entry_id(store, parent_clip_id) or parent_clip_id
            try:
                if store.db is not None:
                    store.db.add_relation(from_id=from_id, to_id=entry_id, kind=mode)
            except Exception as exc:  # noqa: BLE001 — lineage is best-effort
                log.debug(
                    "Suno: add_relation %s→%s (%s) failed: %s",
                    from_id,
                    entry_id,
                    mode,
                    exc,
                )

    # Mark the job registered so re-polling never double-imports.
    job["library_entry_id"] = entry_id
    _jobs[job_id] = job
    _save_jobs(_jobs)
    return entry_id


def _gather_parent_clip_ids(job: dict[str, Any], meta: dict[str, Any]) -> list[str]:
    """Collect the Suno clip ids that are parents of this derived track.

    Prefers the parents we recorded at submit time (authoritative), and falls
    back to the upstream metadata (cover_audio_id / mashup_clip_ids)."""
    parents: list[str] = list(job.get("parents") or [])
    cover_audio_id = meta.get("cover_audio_id")
    if cover_audio_id:
        parents.append(str(cover_audio_id))
    for cid in meta.get("mashup_clip_ids") or []:
        if cid:
            parents.append(str(cid))
    # De-dupe while preserving order.
    seen: set[str] = set()
    out: list[str] = []
    for p in parents:
        if p and p not in seen:
            seen.add(p)
            out.append(p)
    return out


# ---------------------------------------------------------------------------
# Routes (relative — loader prepends /api/suno)
# ---------------------------------------------------------------------------


@router.get("/status")
async def status() -> dict[str, Any]:
    """Whether a key is configured + a non-sensitive prefix for the UI."""
    key = _read_api_key()
    return {"configured": bool(key), "key_prefix": (key[:12] + "...") if key else None}


@router.post("/key")
async def set_key(key: str = Body(..., embed=True)) -> dict[str, Any]:
    """Store the Suno API key server-side (gitignored data file)."""
    k = (key or "").strip()
    if not k:
        raise HTTPException(status_code=400, detail="Empty key.")
    # CHANGED: atomic write — write to a tmp file then rename, so a crash mid-write
    # can't leave a truncated/corrupt JSON that silently 503s all generation routes.
    target = _key_file()
    fd, tmp = tempfile.mkstemp(dir=str(target.parent), suffix=".tmp")
    try:
        # fdopen takes ownership of fd and closes it exactly once on block exit,
        # so a later failure can't double-close or probe a closed descriptor.
        with os.fdopen(fd, "wb") as f:
            f.write(json.dumps({"key": k}).encode("utf-8"))
        Path(tmp).replace(target)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return {"configured": True, "key_prefix": k[:12] + "..."}


@router.get("/voices")
async def voices() -> dict[str, Any]:
    """The three hackathon preset voices."""
    return {"voices": PRESET_VOICES}


@router.post("/simple")
async def simple(req: SimpleReq) -> dict[str, Any]:
    """Simple generation from a free-text description (no style)."""
    body: dict[str, Any] = {"description": req.description}
    if req.title:
        body["title"] = req.title
    if req.voice_id:
        body["voice_id"] = req.voice_id
    return _track(await _post("/v0/audio", body), mode="simple")


@router.post("/custom")
async def custom(req: CustomReq) -> dict[str, Any]:
    """Custom generation from an explicit style (+ optional lyrics)."""
    body: dict[str, Any] = {"style": req.style}
    if req.lyrics:
        body["lyrics"] = req.lyrics
    if req.title:
        body["title"] = req.title
    if req.voice_id:
        body["voice_id"] = req.voice_id
    if req.instrumental:
        body["instrumental"] = True
    return _track(await _post("/v0/audio", body), mode="custom")


@router.post("/cover")
async def cover(req: CoverReq) -> dict[str, Any]:
    """Cover an existing Suno clip. The source clip becomes the lineage parent."""
    body: dict[str, Any] = {}
    if req.lyrics is not None:
        body["lyrics"] = req.lyrics
    if req.style:
        body["style"] = req.style
    if req.voice_id:
        body["voice_id"] = req.voice_id
    result = await _post(f"/v0/audio/{req.source_id}/covers", body)
    return _track(result, mode="cover", parents=[req.source_id])


@router.post("/mashup")
async def mashup(req: MashupReq) -> dict[str, Any]:
    """Mash up two Suno clips. Both become lineage parents."""
    body: dict[str, Any] = {"additional_audio_id": req.additional_audio_id}
    if req.lyrics is not None:
        body["lyrics"] = req.lyrics
    if req.style:
        body["style"] = req.style
    if req.title:
        body["title"] = req.title
    result = await _post(f"/v0/audio/{req.source_id}/mashups", body)
    return _track(
        result, mode="mashup", parents=[req.source_id, req.additional_audio_id]
    )


@router.get("/poll/{job_id}")
async def poll(job_id: str) -> dict[str, Any]:
    """Poll a job. On completion, register it as a first-class library entry
    (idempotent) and surface the resulting ``library_entry_id``."""
    result = await _get(f"/v0/audio/{job_id}")

    # Merge the upstream result onto our tracked job so we preserve our own
    # bookkeeping (mode / parents / library_entry_id) across polls.
    existing = _jobs.get(job_id, {})
    merged = {**existing, **result}
    _jobs[job_id] = merged
    _save_jobs(_jobs)

    if merged.get("status") == "complete" and merged.get("audio_url"):
        # CHANGED: lock prevents two concurrent polls from both passing the
        # library_entry_id guard and double-importing the same track.
        async with _register_lock:
            # Re-read after acquiring lock — another request may have registered it.
            if not _jobs.get(job_id, {}).get("library_entry_id"):
                entry_id = await _register_completed_job(merged)
                if entry_id:
                    merged["library_entry_id"] = entry_id
                    _jobs[job_id] = merged
                    _save_jobs(_jobs)
            else:
                merged["library_entry_id"] = _jobs[job_id]["library_entry_id"]
        result["library_entry_id"] = merged.get("library_entry_id")
    return merged


@router.get("/jobs")
async def jobs() -> dict[str, Any]:
    """All tracked jobs (submitted this/previous sessions)."""
    return {"jobs": list(_jobs.values())}


@router.get("/usage")
async def usage() -> dict[str, Any]:
    """Account usage / credits from the Suno API."""
    return await _get("/v0/account/usage")


@router.get("/audio/{job_id}")
async def audio(job_id: str) -> Response:
    """Stream the finished MP3 through the backend (media_type audio/mpeg).

    This avoids browser CORS against the Suno CDN. Prefers the registered
    library entry's bytes; otherwise fetches the tracked job's ``audio_url``."""
    # 1) Prefer the registered library entry's audio on disk.
    job = _jobs.get(job_id) or {}
    entry_id = job.get("library_entry_id")
    if entry_id:
        try:
            from backend.modules.library.router import get_store

            audio_path = get_store().get_audio_path(entry_id)
            if audio_path and audio_path.is_file():
                return Response(
                    content=audio_path.read_bytes(), media_type="audio/mpeg"
                )
        except Exception as exc:  # noqa: BLE001 — fall through to CDN
            log.debug("Suno: library audio read failed for %s: %s", entry_id, exc)

    # 2) Fall back to the remote CDN url from the tracked job.
    audio_url = job.get("audio_url")
    if not audio_url:
        # Last resort: re-poll to discover the url.
        try:
            refreshed = await _get(f"/v0/audio/{job_id}")
            audio_url = refreshed.get("audio_url")
        except HTTPException:
            audio_url = None
    if not audio_url:
        raise HTTPException(status_code=404, detail="Audio not available yet.")

    # CHANGED: validate the URL before fetching — prevents SSRF if suno_jobs.json
    # is tampered with (the server would otherwise proxy to arbitrary hosts).
    parsed = urlparse(audio_url)
    if parsed.scheme != "https" or parsed.hostname not in _ALLOWED_AUDIO_HOSTS:
        log.warning("Suno: blocked audio fetch to disallowed host %s", parsed.hostname)
        raise HTTPException(status_code=400, detail="Audio URL host not allowed.")

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.get(audio_url)
    if resp.status_code >= 400:
        raise HTTPException(
            status_code=resp.status_code, detail="Failed to fetch audio from Suno CDN."
        )
    return Response(content=resp.content, media_type="audio/mpeg")
