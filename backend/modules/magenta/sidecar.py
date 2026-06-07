"""Client for the Magenta RealTime 2 (mrt2) sidecar.

The live sidecar is the "MRT2 Studio" HTTP server that runs in WSL2 on the NVIDIA
GPU (``port/oneclick/studio/studio_server.py`` in the MRT2 bundle). It loads
``MagentaRT2Jax`` once and exposes a tiny synchronous HTTP API:

    GET  /health    -> {"ready": bool, "status": str, "model": str, "device": str}
    POST /generate  -> JSON {prompt, duration, temperature, top_k,
                             cfg_musiccoca, cfg_notes}  ->  audio/wav bytes

This is a TEXT-PROMPT -> AUDIO model (style-conditioned real-time continuation).
It does NOT take MIDI notes or an input audio file — ``drums``/``cfg_notes`` are
generation knobs, not user note lists. Override the URL with
``STABLEDAW_MAGENTA_URL`` (default ``http://localhost:8777``).
"""

from __future__ import annotations

import json
import logging
import os

import httpx

log = logging.getLogger(__name__)

SIDECAR_URL = os.getenv("STABLEDAW_MAGENTA_URL", "http://localhost:8777").rstrip("/")


async def health() -> dict:
    """Probe the sidecar. Always returns a dict with an ``available`` flag."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{SIDECAR_URL}/health")
            r.raise_for_status()
            data = r.json()
            return {**data, "available": bool(data.get("ready")), "url": SIDECAR_URL}
    except Exception as e:
        log.debug("Magenta sidecar not reachable at %s: %s", SIDECAR_URL, e)
        return {"available": False, "url": SIDECAR_URL}


async def generate(
    *,
    prompt: str,
    duration: float = 10.0,
    temperature: float = 1.3,
    top_k: int = 40,
    cfg_musiccoca: float = 3.0,
    cfg_notes: float = 1.0,
    cfg_drums: float = 1.0,
    drums: int = -1,
    chunk_frames: int = 25,
    notes: list[dict] | str | None = None,
    audio_bytes: bytes | None = None,
    audio_mime: str = "audio/wav",
) -> tuple[bytes, dict]:
    """Generate audio. Returns ``(wav_bytes, meta_headers)``.

    Conditioning (all optional, combinable per the model):
      - ``prompt``: text style (used when no ``audio_bytes`` style is given).
      - ``notes``: piano-roll events ``[{pitch, start, end}, ...]`` (or a JSON
        string) -> MIDI-conditioned accompaniment.
      - ``audio_bytes``: a clip whose style is embedded (clone / style-transfer).

    Sent as multipart to the extended sidecar (sidecars/magenta/server.py), which
    renders synchronously and replies with WAV bytes + ``X-RTF`` / ``X-Audio-Seconds``
    / ``X-Generate-Seconds`` / ``X-Sample-Rate`` / ``X-Conditioning`` headers.
    """
    data: dict[str, str] = {
        "prompt": prompt or "",
        "duration": str(float(duration)),
        "temperature": str(float(temperature)),
        "top_k": str(int(top_k)),
        "cfg_musiccoca": str(float(cfg_musiccoca)),
        "cfg_notes": str(float(cfg_notes)),
        "cfg_drums": str(float(cfg_drums)),
        "drums": str(int(drums)),
        "chunk_frames": str(int(chunk_frames)),
    }
    if notes:
        data["notes"] = notes if isinstance(notes, str) else json.dumps(notes)
    files = {"audio": ("style.wav", audio_bytes, audio_mime)} if audio_bytes else None

    # Generation can take a while for long durations; allow a long read timeout.
    async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=600)) as client:
        r = await client.post(f"{SIDECAR_URL}/generate", data=data, files=files)
        r.raise_for_status()
        meta = {
            k: r.headers.get(k)
            for k in (
                "X-RTF",
                "X-Audio-Seconds",
                "X-Generate-Seconds",
                "X-Sample-Rate",
                "X-Conditioning",
            )
            if r.headers.get(k)
        }
        return r.content, meta
