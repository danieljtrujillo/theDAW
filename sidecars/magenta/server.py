#!/usr/bin/env python3
"""theDAW — extended Magenta RealTime 2 sidecar (runs in WSL2 on the NVIDIA GPU).

Supersedes the bundle's text-only ``studio_server.py`` by exposing the model's
FULL conditioning surface over one HTTP endpoint, so theDAW's backend
(``backend/modules/magenta``) can drive text-prompt generation, MIDI-conditioned
accompaniment, AND audio-style ("clone"/style-transfer) — all of which
``MagentaRT2System`` supports (see ``magenta_rt/jax/system.py``).

    GET  /health    -> {ready, status, model, device, sample_rate}
    POST /generate  -> multipart form, returns audio/wav (48 kHz stereo, sync)
        prompt        str    text style (used when no audio style is given)
        duration      float  seconds (frames = duration * 25)
        temperature   float  (default 1.3)
        top_k         int    (default 40)
        cfg_musiccoca float  (default 3.0)
        cfg_notes     float  (default 1.0)
        cfg_drums     float  (default 1.0)
        drums         int    -1 auto / 0 off / 1 on  (default -1)
        chunk_frames  int    note granularity; smaller = tighter timing, slower (default 25)
        notes         str    OPTIONAL JSON: [{"pitch":0-127,"start":sec,"end":sec}, ...]
                             -> MIDI-conditioned accompaniment
        audio         file   OPTIONAL wav -> style embedded from the clip (overrides prompt)

Run (inside WSL2, with magenta-rt + jax[cuda] installed and weights downloaded):

    pip install -r requirements.txt          # fastapi/uvicorn/multipart (+ magenta-rt, jax[cuda])
    MRT2_MODEL=mrt2_small python server.py    # serves http://0.0.0.0:8777

theDAW's backend reaches it at http://localhost:8777 (WSL2 forwards localhost);
override with STABLEDAW_MAGENTA_URL.
"""

from __future__ import annotations

import io
import json
import os
import threading
import time
import traceback

# Allocate GPU memory on demand (must be set before jax is imported).
os.environ.setdefault("XLA_PYTHON_CLIENT_PREALLOCATE", "false")
os.environ.setdefault("XLA_PYTHON_CLIENT_ALLOCATOR", "platform")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, Form, UploadFile
from fastapi.responses import JSONResponse, Response

FPS = 25  # model emits 25 frames/s (40 ms each)
PORT = int(os.environ.get("MRT2_PORT", "8777"))
MODEL = os.environ.get("MRT2_MODEL", "mrt2_small")


class Engine:
    """Loads MagentaRT2System once, serializes generate() (model is not reentrant)."""

    def __init__(self) -> None:
        self.mrt = None
        self.ready = False
        self.status = "starting"
        self.error: str | None = None
        self.device = "?"
        self.sample_rate = 48000
        self.lock = threading.Lock()
        self._embed_cache: dict[str, object] = {}

    def load(self) -> None:
        try:
            self.status = "importing jax + magenta_rt"
            import jax

            from magenta_rt import MagentaRT2System

            self.device = str(jax.devices()[0])
            self.status = f"loading {MODEL} + compiling (one-time)"
            self.mrt = MagentaRT2System(size=MODEL)
            self.sample_rate = int(getattr(self.mrt, "_sample_rate", 48000))
            # Warm up so the first real request is fast.
            emb = self.mrt.embed_style("warm up", use_mapper=True)
            self.mrt.generate(style=emb, frames=FPS)
            self.ready = True
            self.status = "ready"
            print(f"[magenta] READY on {self.device} (model={MODEL})", flush=True)
        except Exception as e:  # noqa: BLE001 — surface load failures in /health
            self.error = f"{type(e).__name__}: {e}"
            self.status = "error: " + self.error
            traceback.print_exc()

    def embed_text(self, prompt: str):
        emb = self._embed_cache.get(prompt)
        if emb is None:
            emb = self.mrt.embed_style(prompt, use_mapper=True)
            if len(self._embed_cache) > 32:
                self._embed_cache.clear()
            self._embed_cache[prompt] = emb
        return emb

    def embed_audio(self, wav_bytes: bytes):
        """Embed a style from an uploaded audio clip (clone / style-transfer)."""
        from magenta_rt import audio as mrt_audio

        samples, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32", always_2d=True)
        waveform = mrt_audio.Waveform(samples, sample_rate=int(sr))
        return self.mrt.embed_style(waveform, use_mapper=True)


ENGINE = Engine()
app = FastAPI(title="theDAW MRT2 sidecar")


def _notes_state_for_window(
    timeline: list[dict], start_f: int, fps: int
) -> list[int] | None:
    """Build the 128-pitch note-state array (per system.py) for a chunk.

    Per pitch 0-127: 2 = onset in this frame, 1 = held, 0 = off (pitch used
    elsewhere but silent now), -1 = masked (pitch never used -> model free to
    harmonize). Returns None if the timeline is empty.
    """
    if not timeline:
        return None
    used = set()
    state = [-1] * 128
    for ev in timeline:
        try:
            pitch = int(ev["pitch"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (0 <= pitch <= 127):
            continue
        used.add(pitch)
        s = float(ev.get("start", 0.0)) * fps
        e = float(ev.get("end", 0.0)) * fps
        if s <= start_f < e:
            # onset if the note begins within this frame, else held
            state[pitch] = 2 if int(round(s)) == start_f else 1
    for p in used:
        if state[p] < 0:
            state[p] = 0  # used pitch, silent this window
    return state


@app.get("/health")
async def health():
    return {
        "ready": ENGINE.ready,
        "status": ENGINE.status,
        "error": ENGINE.error,
        "model": MODEL,
        "device": ENGINE.device,
        "sample_rate": ENGINE.sample_rate,
    }


@app.post("/generate")
async def generate(
    prompt: str = Form(""),
    duration: float = Form(10.0),
    temperature: float = Form(1.3),
    top_k: int = Form(40),
    cfg_musiccoca: float = Form(3.0),
    cfg_notes: float = Form(1.0),
    cfg_drums: float = Form(1.0),
    drums: int = Form(-1),
    chunk_frames: int = Form(FPS),
    notes: str = Form(""),
    audio: UploadFile | None = None,
):
    if not ENGINE.ready:
        return JSONResponse(
            {"error": "engine not ready", "status": ENGINE.status}, status_code=503
        )

    try:
        timeline: list[dict] = json.loads(notes) if notes.strip() else []
    except json.JSONDecodeError:
        return JSONResponse({"error": "notes must be JSON"}, status_code=400)

    audio_bytes = await audio.read() if audio is not None else None

    def _run():
        with ENGINE.lock:
            t0 = time.time()
            emb = (
                ENGINE.embed_audio(audio_bytes)
                if audio_bytes
                else ENGINE.embed_text(prompt or "warm analog pads")
            )
            total = max(1, int(round(float(duration) * FPS)))
            chunk = max(1, int(chunk_frames))
            common = dict(
                style=emb,
                temperature=float(temperature),
                top_k=int(top_k),
                cfg_musiccoca=float(cfg_musiccoca),
                cfg_notes=float(cfg_notes),
                cfg_drums=float(cfg_drums),
                drums=[int(drums)],
            )

            if not timeline:
                # No MIDI: one continuous stream (state kept across chunks for continuity).
                state = None
                parts = []
                done = 0
                while done < total:
                    n = min(chunk, total - done)
                    wav, state = ENGINE.mrt.generate(frames=n, state=state, **common)
                    parts.append(np.asarray(wav.samples, dtype=np.float32))
                    done += n
            else:
                # MIDI-conditioned accompaniment: per-chunk note states, threaded state.
                state = None
                parts = []
                for start_f in range(0, total, chunk):
                    n = min(chunk, total - start_f)
                    ns = _notes_state_for_window(timeline, start_f, FPS)
                    wav, state = ENGINE.mrt.generate(
                        frames=n, state=state, notes=ns, **common
                    )
                    parts.append(np.asarray(wav.samples, dtype=np.float32))

            samples = np.concatenate(parts, axis=0)
            compute = time.time() - t0
        sr = ENGINE.sample_rate
        buf = io.BytesIO()
        sf.write(buf, samples, sr, format="WAV", subtype="PCM_16")
        return buf.getvalue(), compute, samples.shape[0] / sr, sr

    try:
        import anyio

        wav_bytes, compute, audio_s, sr = await anyio.to_thread.run_sync(_run)
        rtf = (audio_s / compute) if compute > 0 else 0.0
        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={
                "X-Generate-Seconds": f"{compute:.2f}",
                "X-Audio-Seconds": f"{audio_s:.2f}",
                "X-RTF": f"{rtf:.2f}",
                "X-Sample-Rate": str(sr),
                "X-Conditioning": "audio"
                if audio_bytes
                else ("notes" if timeline else "text"),
            },
        )
    except Exception as e:  # noqa: BLE001 — return the real error to the client
        traceback.print_exc()
        return JSONResponse({"error": f"{type(e).__name__}: {e}"}, status_code=500)


def main() -> None:
    threading.Thread(target=ENGINE.load, daemon=True).start()
    print(f"[magenta] serving http://0.0.0.0:{PORT}  (model={MODEL})", flush=True)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
