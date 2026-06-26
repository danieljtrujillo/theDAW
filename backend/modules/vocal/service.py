"""Vocal engine orchestration.

Composes existing theDAW tools (restoration isolation and cleanup, the basic-pitch
midi engine) and the new analyzers (dense F0 curve, segment VAD) into the canonical
VocalArtifact. Heavy work runs inside a job; heavy libraries load lazily inside the
preprocess steps, so importing this module stays cheap at startup. Singing synthesis
stays out of scope.

Tempo context and Library persistence are wired below. The offline vocal_processing
FFmpeg chain shapes the OUTPUT vocal, so it belongs to the render path and stays with
deferred SOULX rather than the prerequisite artifact. Faster-whisper transcription is
Phase 2b.
"""

from __future__ import annotations

import asyncio
import logging
import tempfile
from pathlib import Path
from typing import Any, Optional

from backend.core.jobs import Job

from .preprocess import f0_curve, isolation
from .preprocess import notes as notes_step
from .preprocess import segments as segments_step
from .schema import Lyrics, Source, Timing, VocalArtifact

log = logging.getLogger(__name__)

# In-process artifact store so /metadata works in-session. A later increment also
# persists each artifact to the Library as a first-class item.
_artifacts: dict[str, dict] = {}

# Keep references to in-flight prepare tasks so they are not garbage-collected.
_running: set[asyncio.Task] = set()


def health() -> dict[str, Any]:
    return {"ok": True, "module": "vocal", "transcription": transcription_available()}


def transcription_available() -> bool:
    # Wired in Phase 2b (the faster-whisper sidecar). Until then lyrics are
    # hand-entered in the review step.
    return False


def load_artifact(asset_id: str) -> Optional[dict]:
    if asset_id in _artifacts:
        return _artifacts[asset_id]
    # Fall back to the persisted metadata file written next to the audio.
    try:
        import json

        from backend.modules.library.router import get_store

        audio = get_store().get_audio_path(asset_id)
        if audio:
            f = Path(audio).parent / "vocal_metadata.json"
            if f.is_file():
                return json.loads(f.read_text(encoding="utf-8"))
    except Exception as e:
        log.info("vocal: artifact load failed for %s: %s", asset_id, e)
    return None


def _resolve_path(asset_id: str) -> Optional[Path]:
    """Resolve a Library asset id to its audio file via the library store."""
    try:
        from backend.modules.library.router import get_store

        path = get_store().get_audio_path(asset_id)
        return Path(path) if path else None
    except Exception as e:
        log.info("vocal: asset path resolution failed for %s: %s", asset_id, e)
        return None


def _fill_source_info(art: VocalArtifact, path: Path) -> None:
    try:
        import soundfile as sf

        info = sf.info(str(path))
        art.source.sample_rate = int(info.samplerate)
        art.source.duration_ms = int(info.frames / max(1, info.samplerate) * 1000)
    except Exception as e:
        log.info("vocal: source info read failed for %s: %s", path.name, e)


def _persist(asset_id: str, src_path: Path, payload: dict) -> None:
    """Write the artifact next to the audio and register it as a first-class
    Library artifact (kind="vocal"), reusing the notation-artifact table."""
    try:
        import json
        import uuid

        from backend.modules.library.router import get_store

        out = src_path.parent / "vocal_metadata.json"
        out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        get_store().db.add_notation_artifact(
            artifact_id=str(uuid.uuid4()),
            entry_id=asset_id,
            kind="vocal",
            path=str(out),
            engine="vocal",
            metadata={"version": payload.get("version")},
        )
    except Exception as e:
        log.info("vocal: artifact persist failed for %s: %s", asset_id, e)


def _tempo_bpm(audio_path: Path) -> Optional[float]:
    """Estimate tempo from the full mix; vocals alone have weak beats."""
    try:
        import librosa
        import numpy as np
    except ImportError:
        return None
    try:
        y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
        if y.size == 0:
            return None
        tempo, _beats = librosa.beat.beat_track(y=y, sr=sr)
        val = float(np.atleast_1d(tempo)[0])
        return round(val, 2) if val > 0 else None
    except Exception as e:
        log.info("vocal.context: tempo failed: %s", e)
        return None


def _context(audio_path: Path) -> Timing:
    """Musical context. Tempo from the full mix; key and bars join later from the
    library analysis row when present."""
    return Timing(tempo_bpm=_tempo_bpm(audio_path))


async def _transcribe(path: Path, language: str) -> Lyrics:
    """Phase 2b: faster-whisper sidecar (lazy). Until then, empty lyrics."""
    return Lyrics(language=language)


def start_prepare(job: Job, req: dict[str, Any]) -> None:
    """Spawn the prepare pipeline and track the task so it survives GC."""
    task = asyncio.create_task(run_prepare(job, req))
    _running.add(task)
    task.add_done_callback(_running.discard)


async def run_prepare(job: Job, req: dict[str, Any]) -> None:
    asset_id = str(req.get("asset_id", ""))
    try:
        job.update(status="running", progress=0.05, message="starting")
        src_path = _resolve_path(asset_id)
        if src_path is None or not src_path.is_file():
            raise FileNotFoundError(f"no audio for asset {asset_id}")

        art = VocalArtifact(source=Source(asset_id=asset_id))
        _fill_source_info(art, src_path)

        with tempfile.TemporaryDirectory() as td:
            work = Path(td)
            cur = src_path

            isolate = bool(req.get("isolate", True))
            method = str(req.get("isolation", "vocal_isolate"))
            if isolate:
                cur = await isolation.isolate(cur, work / "isolated.wav", method)
                art.source.isolation = method
            else:
                art.source.isolation = "none"
            job.update(progress=0.2, message="isolated")

            if bool(req.get("cleanup", True)):
                cur = await isolation.cleanup(cur, work / "cleaned.wav")
            job.update(progress=0.35, message="cleaned")

            art.f0 = f0_curve.compute_f0_curve(cur)
            job.update(progress=0.5, message="pitch")

            art.notes = notes_step.extract_notes(cur)
            job.update(progress=0.7, message="notes")

            art.segments = segments_step.detect_segments(cur)
            art.timing = _context(src_path)
            job.update(progress=0.85, message="segments")

            if bool(req.get("transcribe", False)):
                art.lyrics = await _transcribe(cur, str(req.get("language", "en")))
            job.update(progress=0.95, message="lyrics")

        payload = art.model_dump()
        _artifacts[asset_id] = payload
        _persist(asset_id, src_path, payload)
        job.result = payload
        job.update(status="done", progress=1.0, message="artifact ready")
    except Exception as e:
        log.exception("vocal prepare failed")
        job.error = repr(e)
        job.update(status="failed", message=str(e))
