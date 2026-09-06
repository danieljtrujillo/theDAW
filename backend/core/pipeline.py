"""One coordinator for the heavy per-entry artifacts: stems, MIDI, lyrics.

Every producer of these artifacts (the auto-on-import background queue, the
manual routes, the lyrics aligner that needs a vocal stem, favoriting) goes
through the ``ensure_*`` helpers here, so:

* the same artifact is never produced twice at the same time — a second
  caller for an entry AWAITS the run already in flight instead of starting
  another Demucs / whisper / basic-pitch process, or falling back to a worse
  input because "it is already running";
* what exists is not redone — an entry with stems keeps them, an entry with
  MIDI keeps it, a timed lyrics document is left alone;
* the GPU is used by ONE heavy model at a time (``gpu()``), whichever module
  asked, and while it is busy the idle-gated background queue stays parked
  (an idle "hold" is taken for the duration), so a foreground align does not
  run under a background separation of the next track;
* MIDI conversion that wants the stems waits for a separation in flight
  rather than converting only the full mix.

Nothing heavy is imported at module load; every engine is reached lazily so
this stays a cheap import for the routers.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable, Optional

log = logging.getLogger(__name__)

# key ("stems:<entry>", "midi:<entry>", "lyrics:<entry>") -> the task doing it.
_inflight: dict[str, "asyncio.Task[Any]"] = {}
_gpu_lock: Optional[asyncio.Lock] = None


def _lock() -> asyncio.Lock:
    global _gpu_lock
    if _gpu_lock is None:
        _gpu_lock = asyncio.Lock()
    return _gpu_lock


def in_flight(key: str) -> bool:
    task = _inflight.get(key)
    return task is not None and not task.done()


def active_keys() -> list[str]:
    return [k for k, t in _inflight.items() if not t.done()]


async def run_once(key: str, factory: Callable[[], Awaitable[Any]]) -> Any:
    """Run ``factory()`` unless a run with the same key is in flight, in
    which case wait for that one and return its result. The in-flight run is
    shielded from a waiter's cancellation: the user closing the SING tab
    must not kill the separation the background queue also wants."""
    task = _inflight.get(key)
    if task is not None and not task.done():
        log.info("pipeline: joining %s already in flight", key)
        return await asyncio.shield(task)
    task = asyncio.create_task(factory(), name=key)
    _inflight[key] = task
    try:
        return await asyncio.shield(task)
    finally:
        if task.done() and _inflight.get(key) is task:
            _inflight.pop(key, None)


async def wait_for(key: str) -> None:
    """Wait for a run in flight (no-op when there is none). Errors are the
    runner's to report; a waiter only needs to know it finished."""
    task = _inflight.get(key)
    if task is None or task.done():
        return
    try:
        await asyncio.shield(task)
    except Exception:  # noqa: BLE001 - the owner logs it
        pass


@contextlib.asynccontextmanager
async def gpu(tag: str) -> AsyncIterator[None]:
    """The single GPU lane. Whisper, Demucs and basic-pitch each take it for
    the duration of their model run, so two of them never share the card;
    the idle manager holds a tag meanwhile so the background queue does not
    start its own heavy job underneath. Never nest: the lock is not
    re-entrant, and a coordinator that holds it while awaiting an
    ``ensure_*`` would deadlock on itself."""
    idle = None
    try:
        from backend.core.idle import get_idle_manager

        idle = get_idle_manager()
        idle.bump_activity(tag=f"gpu:{tag}")
    except Exception:  # noqa: BLE001 - idle tracking is best effort
        idle = None
    try:
        async with _lock():
            yield
    finally:
        if idle is not None:
            try:
                idle.release(f"gpu:{tag}")
            except Exception:  # noqa: BLE001
                pass


def _settings(section: str) -> dict[str, Any]:
    try:
        from backend.modules.settings.router import get_store as get_settings_store

        return dict(get_settings_store().get_section(section) or {})
    except Exception:  # noqa: BLE001 - defaults below
        return {}


def gpu_device() -> str:
    """'cuda' when torch sees a CUDA device, else 'cpu'. Cached by torch."""
    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:  # noqa: BLE001
        return "cpu"


def _library():
    from backend.modules.library.router import get_store

    return get_store()


def _entry_paths(entry_id: str) -> tuple[Any, Path, Path]:
    store = _library()
    if store.db is None:
        raise RuntimeError("library DB not available")
    audio = store.get_audio_path(entry_id)
    entry_dir = store._dir_for(entry_id)  # noqa: SLF001
    if audio is None or not Path(audio).is_file() or entry_dir is None:
        raise FileNotFoundError(f"no audio on disk for entry {entry_id}")
    return store.db, Path(audio), Path(entry_dir)


# ---- stems ------------------------------------------------------------------


def stems_device(requested: Optional[str] = None) -> Optional[str]:
    """The device Demucs should use: the request, else the stems setting,
    with 'auto' resolved to the GPU when there is one. ``None`` lets the
    sidecar pick (it also picks CUDA when it can)."""
    dev = (requested or str(_settings("stems").get("device") or "")).strip().lower()
    if dev in ("", "auto"):
        return gpu_device()
    return dev


async def ensure_stems(
    entry_id: str,
    *,
    force: bool = False,
    stems: Optional[int] = None,
    device: Optional[str] = None,
    quality: Optional[str] = None,
) -> list[dict[str, Any]]:
    """The entry's stem rows, separating first when there are none (or when
    ``force``). A separation already in flight for the entry is joined."""
    db, audio, entry_dir = _entry_paths(entry_id)
    if not force:
        rows = db.list_stems(entry_id)
        if rows:
            return rows
    cfg = _settings("stems")
    count = int(stems or cfg.get("default_count") or 4)
    dev = stems_device(device)
    qual = quality or str(cfg.get("quality") or "") or None

    async def _run() -> list[dict[str, Any]]:
        from backend.modules.stems.engine import separate_entry

        async with gpu("stems"):
            await separate_entry(
                db, entry_id, audio, entry_dir, stems=count, device=dev, quality=qual
            )
        return db.list_stems(entry_id)

    return await run_once(f"stems:{entry_id}", _run)


# ---- midi -------------------------------------------------------------------


async def ensure_midi(
    entry_id: str,
    *,
    force: bool = False,
    from_stems: Optional[bool] = None,
) -> list[dict[str, Any]]:
    """The entry's MIDI rows, converting first when there are none (or when
    ``force``). Waits for a stem separation in flight so the per-stem
    conversions see the stems."""
    db, audio, entry_dir = _entry_paths(entry_id)
    if not force:
        rows = db.list_midis(entry_id)
        if rows:
            return rows
    use_stems = (
        bool(_settings("midi").get("from_stems", True))
        if from_stems is None
        else from_stems
    )

    async def _run() -> list[dict[str, Any]]:
        from backend.modules.midi.runner import convert_entry

        if use_stems:
            await wait_for(f"stems:{entry_id}")
        async with gpu("midi"):
            await asyncio.to_thread(
                convert_entry, db, entry_id, audio, entry_dir, from_stems=use_stems
            )
        return db.list_midis(entry_id)

    return await run_once(f"midi:{entry_id}", _run)


# ---- lyrics -----------------------------------------------------------------


async def ensure_lyrics(
    entry_id: str,
    *,
    force: bool = False,
    transcribe_when_empty: Optional[bool] = None,
    language: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """A timed lyrics document for the entry: aligned from its lyric text
    when it has one, transcribed by whisper when it has none and
    ``transcribe_when_empty`` (the ``lyrics.auto_transcribe`` setting) is on.
    Returns the document dict, or ``None`` when there was nothing to do or
    transcription is not installed. An align/transcribe job already running
    for the entry is joined. The GPU lane is taken by the inner steps
    (separation, whisper), never here."""
    from backend.core.jobs import create_job
    from backend.modules.lyrics import service as lyrics
    from backend.modules.vocal.transcription import available

    existing = lyrics.load_doc(entry_id)
    if (
        not force
        and existing is not None
        and any(ln.start_ms is not None for ln in existing.lines)
    ):
        return existing.model_dump()
    if not available():
        return None
    text = ""
    if existing is not None:
        text = existing.text
    if not text.strip():
        record = _library().get_entry(entry_id)
        text = str(getattr(record, "lyrics", "") or "")
    cfg = _settings("lyrics")
    want_transcribe = (
        bool(cfg.get("auto_transcribe", False))
        if transcribe_when_empty is None
        else transcribe_when_empty
    )
    if not text.strip() and not want_transcribe:
        return None
    lang = language or str(cfg.get("language") or "auto")

    async def _run() -> Optional[dict[str, Any]]:
        job = lyrics.active_job(entry_id)
        if job is None:
            kind = "align" if text.strip() else "transcribe"
            job = create_job("lyrics", f"{kind.title()} lyrics ({entry_id})")
            lyrics.register_job(entry_id, job)
            req = {"language": lang, "isolate": True}
            if kind == "align":
                req["text"] = text
                await lyrics.run_align(job, entry_id, req)
            else:
                await lyrics.run_transcribe(job, entry_id, req)
        else:
            await lyrics.wait_job(job)
        return job.result if job.status == "done" else None

    return await run_once(f"lyrics:{entry_id}", _run)


__all__ = [
    "active_keys",
    "ensure_lyrics",
    "ensure_midi",
    "ensure_stems",
    "gpu",
    "gpu_device",
    "in_flight",
    "run_once",
    "stems_device",
    "wait_for",
]
