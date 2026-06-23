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
override with THEDAW_MAGENTA_URL.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import threading
import time
import traceback

# GPU allocator (must be set before jax is imported). Default to the FAST path
# (BFC + preallocation): the engine has the card to itself while it runs (the
# backend parks Stable Audio to CPU before bringing this up), and JAX's
# "platform" allocator — the previous default — is documented as "very slow, not
# recommended for general use" because it allocates/frees per op, which taxes the
# per-frame streaming loop heavily. Set THEDAW_MAGENTA_LOWMEM=1 to fall back to
# the low-memory platform allocator.
if os.environ.get("THEDAW_MAGENTA_LOWMEM", "").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
):
    os.environ.setdefault("XLA_PYTHON_CLIENT_PREALLOCATE", "false")
    os.environ.setdefault("XLA_PYTHON_CLIENT_ALLOCATOR", "platform")
else:
    os.environ.setdefault("XLA_PYTHON_CLIENT_PREALLOCATE", "true")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, Form, UploadFile
from fastapi.responses import JSONResponse, Response

FPS = 25  # model emits 25 frames/s (40 ms each)
PORT = int(os.environ.get("MRT2_PORT", "8777"))
MODEL = os.environ.get("MRT2_MODEL", "mrt2_small")
# Frames per generate() call on the NO-NOTES path. Chunk size there is pure
# output segmentation (state threads across calls, so the audio is identical
# regardless), so a big chunk cuts host<->device round-trips ~10x vs the old 25
# (1s). The MIDI/notes path keeps the caller's fine chunk_frames for note timing.
NO_NOTES_CHUNK = max(1, int(os.environ.get("THEDAW_MAGENTA_NO_NOTES_CHUNK", "250")))


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
        # Current evolving piece for extend/morph: {state, emb, key, samples, sr}.
        self._gen: dict | None = None

    def load(self) -> None:
        try:
            self.status = "importing jax + magenta_rt"
            import jax

            # Persistent XLA compilation cache. MRT2's one-time XLA compile
            # dominates cold-start (and recurs on every re-spin after an
            # SA3<->Magenta GPU swap). Caching compiled executables to disk makes
            # every start after the first skip that recompile, which is the single
            # biggest lever for "spin up a faster one". Best-effort: wrapped so a
            # JAX version that renamed a config key can never block model load.
            # Override the dir with THEDAW_MAGENTA_JAX_CACHE.
            try:
                cache_dir = os.environ.get(
                    "THEDAW_MAGENTA_JAX_CACHE",
                    os.path.expanduser("~/.cache/thedaw-mrt2-jax"),
                )
                jax.config.update("jax_compilation_cache_dir", cache_dir)
                jax.config.update("jax_persistent_cache_min_entry_size_bytes", -1)
                jax.config.update("jax_persistent_cache_min_compile_time_secs", 0)
                print(f"[magenta] JAX compile cache -> {cache_dir}", flush=True)
            except Exception as e:  # noqa: BLE001 — cache is an optimization only
                print(f"[magenta] JAX compile cache unavailable: {e}", flush=True)

            # magenta-rt 2.x exposes the JAX system as ``MagentaRT2Jax`` (the
            # pre-2.0 name ``MagentaRT2System`` is no longer re-exported at the
            # top level). Use the current name, falling back defensively.
            try:
                from magenta_rt import MagentaRT2Jax as MagentaRT2
            except ImportError:  # older/renamed API
                from magenta_rt.jax.system import MagentaRT2System as MagentaRT2

            self.device = str(jax.devices()[0])
            self.status = f"loading {MODEL} + compiling (one-time)"
            self.mrt = MagentaRT2(size=MODEL)
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

    @staticmethod
    def _style_key(sources: list[dict], seed: int) -> str:
        basis = [
            (
                s.get("type", "text"),
                (s.get("text") or "").strip(),
                (s.get("audio_b64") or "")[:48],
                round(float(s.get("weight", 1.0)), 4),
            )
            for s in sources
        ]
        return hashlib.sha1((repr(basis) + f"|seed={seed}").encode()).hexdigest()

    def _embed_one(self, src: dict, seed: int):
        """Embed one style source: a text prompt OR an uploaded audio clip."""
        if src.get("type") == "audio" and src.get("audio_b64"):
            from magenta_rt import audio as mrt_audio

            raw = base64.b64decode(src["audio_b64"])
            samples, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
            wf = mrt_audio.Waveform(samples, sample_rate=int(sr))
            return self.mrt.embed_style(wf, use_mapper=True, seed=int(seed))
        text = (src.get("text") or "warm analog pads").strip()
        return self.mrt.embed_style(text, use_mapper=True, seed=int(seed))

    def build_style(self, prompt: str, styles: list[dict] | None, seed: int):
        """One style embedding from a prompt, or a weighted blend of text/audio
        sources (overrides prompt). Returns (embedding, cache_key)."""
        sources = (
            list(styles)
            if styles
            else [{"type": "text", "text": prompt, "weight": 1.0}]
        )
        key = self._style_key(sources, seed)
        emb = self._embed_cache.get(key)
        if emb is None:
            embs, weights = [], []
            for s in sources:
                embs.append(np.asarray(self._embed_one(s, seed), dtype=np.float32))
                weights.append(max(0.0, float(s.get("weight", 1.0))))
            w = np.asarray(weights, dtype=np.float32)
            if w.sum() <= 0:
                w = np.ones_like(w)
            emb = np.average(np.stack(embs, axis=0), axis=0, weights=w).astype(
                np.float32
            )
            if len(self._embed_cache) > 32:
                self._embed_cache.clear()
            self._embed_cache[key] = emb
        return emb, key


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
        # Identity field: theDAW's backend probe uses this to tell the extended
        # sidecar apart from the bundled Studio server (which also answers
        # ready:true on these ports but speaks an incompatible JSON protocol).
        "app": "mrt2-extended",
        "ready": ENGINE.ready,
        "status": ENGINE.status,
        "error": ENGINE.error,
        "model": MODEL,
        "device": ENGINE.device,
        "sample_rate": ENGINE.sample_rate,
    }


@app.post("/reset")
async def reset():
    """Drop the evolving-piece state so the next generate starts a fresh track."""
    ENGINE._gen = None
    return {"ok": True}


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
    seed: int = Form(0),
    extend: bool = Form(False),
    styles: str = Form(""),
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
    try:
        style_list: list[dict] = json.loads(styles) if styles.strip() else []
    except json.JSONDecodeError:
        return JSONResponse({"error": "styles must be JSON"}, status_code=400)

    audio_bytes = await audio.read() if audio is not None else None
    # A single uploaded clip with no explicit blend list IS the audio style source.
    if audio_bytes and not style_list:
        style_list = [
            {
                "type": "audio",
                "audio_b64": base64.b64encode(audio_bytes).decode(),
                "weight": 1.0,
            }
        ]
    has_audio_style = any(s.get("type") == "audio" for s in style_list)

    def _run():
        with ENGINE.lock:
            t0 = time.time()
            prev = ENGINE._gen if extend else None
            emb, key = ENGINE.build_style(
                prompt or "warm analog pads", style_list, int(seed or 0)
            )
            if prev is not None and prev.get("key") == key:
                emb = prev["emb"]  # same vibe across an extend — keep the embedding
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

            # extend=True continues the current piece via the model's streaming
            # state, so changing the prompt/style/notes morphs it without a cut.
            state = prev["state"] if prev is not None else None
            parts = []
            if not timeline:
                # No note timing to honor, so use a big chunk to minimize
                # host<->device round-trips (the audio is identical regardless).
                nn_chunk = max(chunk, NO_NOTES_CHUNK)
                done = 0
                while done < total:
                    n = min(nn_chunk, total - done)
                    wav, state = ENGINE.mrt.generate(frames=n, state=state, **common)
                    parts.append(np.asarray(wav.samples, dtype=np.float32))
                    done += n
            else:
                # MIDI-conditioned accompaniment: per-chunk note states, threaded state.
                for start_f in range(0, total, chunk):
                    n = min(chunk, total - start_f)
                    ns = _notes_state_for_window(timeline, start_f, FPS)
                    wav, state = ENGINE.mrt.generate(
                        frames=n, state=state, notes=ns, **common
                    )
                    parts.append(np.asarray(wav.samples, dtype=np.float32))

            seg = np.concatenate(parts, axis=0)
            sr = ENGINE.sample_rate
            if prev is not None and prev.get("samples") is not None:
                full = np.concatenate([prev["samples"], seg], axis=0)
            else:
                full = seg
            ENGINE._gen = {
                "state": state,
                "emb": emb,
                "key": key,
                "samples": full,
                "sr": sr,
            }
            compute = time.time() - t0
        buf = io.BytesIO()
        sf.write(buf, full, sr, format="WAV", subtype="PCM_16")
        return buf.getvalue(), compute, full.shape[0] / sr, seg.shape[0] / sr, sr

    try:
        import anyio

        wav_bytes, compute, audio_s, seg_s, sr = await anyio.to_thread.run_sync(_run)
        rtf = (seg_s / compute) if compute > 0 else 0.0
        cond = "audio" if has_audio_style else ("notes" if timeline else "text")
        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={
                "X-Generate-Seconds": f"{compute:.2f}",
                "X-Audio-Seconds": f"{audio_s:.2f}",
                "X-Segment-Seconds": f"{seg_s:.2f}",
                "X-RTF": f"{rtf:.2f}",
                "X-Sample-Rate": str(sr),
                "X-Extend": "1" if extend else "0",
                "X-Conditioning": cond,
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
