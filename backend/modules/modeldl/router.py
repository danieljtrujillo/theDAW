"""FastAPI router for the model-download module (prefix ``/api/models``).

    POST   /{name}/download        start (or rejoin) a download for a catalog model
    GET    /downloads              every download job this session, with live progress
    POST   /downloads/clear        drop all finished (done|error) jobs

This is a session-scoped JOB REGISTRY, not a fire-and-forget downloader. Each
job tracks per-file byte progress and transfer speed so the Settings download
dock can render a live progress bar. A download fetches BOTH the model config
JSON and the checkpoint file from the Hugging Face Hub.

Live progress works by passing a custom ``tqdm`` subclass (``_JobTqdm``) to
``hf_hub_download``. ``huggingface_hub`` drives that tqdm during the transfer;
each ``update()`` writes the current byte count / total / rate back into the
job's file entry. The worker thread tags itself with the job id through a
``contextvars.ContextVar`` so the tqdm instance — created deep inside
``huggingface_hub`` — knows which job it belongs to.

Downloads run on a DEDICATED two-worker thread pool so they never starve the
event loop's shared default executor. The in-memory registry and every job
dict it holds are guarded by a single lock, because jobs are mutated from
worker threads and read from the request handlers.
"""

from __future__ import annotations

import atexit
import logging
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import APIRouter, HTTPException
from huggingface_hub.utils import tqdm

from stable_audio_3.model_configs import (
    AutoencoderModelConfig,
    ModelConfig,
    all_models,
    hf_download_with_mirror,
)

log = logging.getLogger(__name__)

router = APIRouter()

# job_id -> job dict. Guarded by _LOCK for every read and write, because worker
# threads mutate jobs while request handlers read them.
_REGISTRY: dict[str, dict] = {}
_LOCK = threading.Lock()

# A dedicated pool keeps long downloads off asyncio's shared default executor.
_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="modeldl")
# Tear the pool down on process exit / dev-server reload so it isn't leaked.
atexit.register(lambda: _EXECUTOR.shutdown(wait=False))

_LIVE_STATUSES = frozenset({"queued", "downloading"})
_FINISHED_STATUSES = frozenset({"done", "error"})

# Cap retained finished/errored jobs so a long session can't grow unbounded.
_MAX_TERMINAL_JOBS = 25


class _JobTqdm(tqdm):
    """tqdm subclass that mirrors transfer progress into the active job entry.

    The base is huggingface_hub's own tqdm wrapper, not ``tqdm.auto.tqdm``:
    ``hf_hub_download`` constructs the bar with ``name="huggingface_hub.http_get"``,
    a kwarg only that wrapper accepts. On a plain tqdm subclass the kwarg
    reaches tqdm's validator and every download died with
    ``TqdmKeyError: Unknown argument(s): {'name': ...}`` — but only when stderr
    is a terminal (tqdm skips validation when it disables itself on a pipe),
    which is why Pinokio users saw it and the piped test runs never did.

    The job id is bound to the (sub)class via ``_bound_tqdm`` rather than a
    contextvar: huggingface_hub's Xet backend drives ``update()`` from a native
    worker thread where a contextvar set on our Python thread is invisible.
    Reading ``self._job_id`` works no matter which thread fires the update.
    Every write is wrapped in try/except so a bookkeeping error can never abort
    an in-flight download.

    **The byte count is ours, not tqdm's.** ``hf_hub_download`` builds the bar
    with ``disable=is_tqdm_disabled(...)``, which is ``None``, so tqdm applies
    its own rule and turns itself off whenever stderr is not a TTY. Under the
    Electron shell (and theDAW.bat, and Pinokio) stderr is always a pipe, so
    the bar was always disabled — and a disabled tqdm's ``update()`` returns
    immediately WITHOUT advancing ``self.n``. ``total`` is still set at
    construction, which is exactly the reported symptom: "0 B / 8.6 GB",
    forever, while the download ran to completion. Measured before the fix: a
    34 MB file finished in 11.7s and published ``(0, 34362429)`` throughout.
    So ``update()`` accumulates into ``_bytes_done`` first and only then hands
    ``n`` to tqdm for whatever drawing it feels like doing.
    """

    _job_id: str | None = None

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        # A resumed transfer starts at `initial`; tqdm records that in `n` even
        # when it is disabled, so this picks up a part-downloaded file's offset.
        self._bytes_done: float = float(self.n or 0)
        self._t0 = time.monotonic()
        self._publish()

    def _publish(self) -> None:
        job_id = self._job_id
        if not job_id:
            return
        try:
            elapsed = max(1e-6, time.monotonic() - self._t0)
            # Rate computed here too: tqdm's format_dict rate is derived from
            # its own `n`, which a disabled bar never moves.
            speed = float(self._bytes_done) / elapsed
            with _LOCK:
                job = _REGISTRY.get(job_id)
                if job is None:
                    return
                idx = job["current_file"]
                if idx < 0 or idx >= len(job["files"]):
                    return
                entry = job["files"][idx]
                entry["bytes_done"] = int(self._bytes_done)
                entry["bytes_total"] = int(self.total or 0)
                entry["speed"] = speed
        except Exception:  # pragma: no cover - defensive, must never raise
            log.debug("modeldl: progress publish failed", exc_info=True)

    def update(self, n: int | float = 1) -> bool | None:
        # Ours first: super() is a no-op on a disabled bar.
        try:
            self._bytes_done += float(n or 0)
        except (TypeError, ValueError):
            pass
        displayed = super().update(n)
        self._publish()
        return displayed

    def close(self) -> None:
        # Flush a final reading (e.g. the closing 100% tick) before teardown.
        self._publish()
        super().close()


def _bound_tqdm(job_id: str) -> type[_JobTqdm]:
    """A ``_JobTqdm`` subclass pinned to ``job_id`` — used as ``tqdm_class`` so
    the progress callback finds its job from any thread (incl. Xet's native one)."""
    return type(f"_JobTqdm_{job_id[:8]}", (_JobTqdm,), {"_job_id": job_id})


def _blob_dirs(repo_id: str) -> list[Path]:
    """Where the cache keeps ``repo_id``'s blobs, plus its public mirror's.

    Both are watched because ``hf_download_with_mirror`` may fall back to the
    mirror mid-job, and the job only learns which repo it used when the call
    returns.
    """
    try:
        from huggingface_hub.constants import HF_HUB_CACHE
        from huggingface_hub.file_download import repo_folder_name

        from stable_audio_3.model_configs import _model_mirrors
    except Exception:  # pragma: no cover - hub layout changed
        return []
    repos = [repo_id]
    mirror = _model_mirrors().get(repo_id)
    if mirror:
        repos.append(mirror)
    out = []
    for repo in repos:
        try:
            out.append(
                Path(HF_HUB_CACHE)
                / repo_folder_name(repo_id=repo, repo_type="model")
                / "blobs"
            )
        except Exception:  # pragma: no cover - defensive
            continue
    return out


def _incomplete_bytes(dirs: list[Path]) -> int:
    """Bytes written so far to the in-flight blob, or 0.

    The largest ``*.incomplete`` wins: a job downloads a small config and then
    a multi-gigabyte checkpoint, and only one of them is ever in flight, but a
    previous run's abandoned part-file can sit beside it.
    """
    best = 0
    for d in dirs:
        try:
            for f in d.glob("*.incomplete"):
                try:
                    best = max(best, f.stat().st_size)
                except OSError:
                    continue
        except OSError:
            continue
    return best


class _CacheProgress(threading.Thread):
    """Publish the in-flight blob's size into the job while a file downloads.

    Deliberately cooperative with ``_JobTqdm``: it only ever raises
    ``bytes_done``, so whichever source is further along wins and the number a
    reader sees never goes backwards.
    """

    #: Often enough to look alive, rare enough to cost nothing on a slow disk.
    INTERVAL_S = 0.5

    def __init__(self, job_id: str, repo_id: str) -> None:
        super().__init__(name=f"modeldl-progress-{job_id[:8]}", daemon=True)
        self._job_id = job_id
        self._dirs = _blob_dirs(repo_id)
        # NOT `_stop`: threading.Thread has a private _stop() that join()
        # calls, and shadowing it with an Event makes every join() raise
        # TypeError: 'Event' object is not callable.
        self._stopping = threading.Event()

    def stop(self) -> None:
        self._stopping.set()

    def run(self) -> None:
        if not self._dirs:
            return
        while not self._stopping.wait(self.INTERVAL_S):
            try:
                seen = _incomplete_bytes(self._dirs)
                if seen <= 0:
                    continue
                with _LOCK:
                    job = _REGISTRY.get(self._job_id)
                    if job is None:
                        return
                    idx = job["current_file"]
                    if idx < 0 or idx >= len(job["files"]):
                        continue
                    entry = job["files"][idx]
                    if seen <= entry["bytes_done"]:
                        continue
                    now = time.monotonic()
                    prev_bytes = entry["bytes_done"]
                    prev_at = entry.get("_seen_at") or now
                    dt = max(1e-6, now - prev_at)
                    entry["bytes_done"] = seen
                    entry["_seen_at"] = now
                    if prev_bytes:
                        entry["speed"] = (seen - prev_bytes) / dt
            except Exception:  # pragma: no cover - must never kill the thread
                log.debug("modeldl: cache progress poll failed", exc_info=True)


def _config_files(cfg: ModelConfig | AutoencoderModelConfig) -> list[str]:
    """The (config, checkpoint) filenames to fetch for a catalog entry, in order."""
    if isinstance(cfg, AutoencoderModelConfig):
        return [cfg.ae_config_path, cfg.ae_ckpt_path]
    return [cfg.config_path, cfg.ckpt_path]


def _repo_id(cfg: ModelConfig | AutoencoderModelConfig) -> str:
    if isinstance(cfg, AutoencoderModelConfig):
        return cfg.ae_repo_id
    return cfg.repo_id


def _new_job(name: str, cfg: ModelConfig | AutoencoderModelConfig) -> dict:
    """Build a fresh job dict. Caller must hold _LOCK when inserting it."""
    return {
        "id": uuid.uuid4().hex,
        "name": name,
        "repo_id": _repo_id(cfg),
        "label": name.replace("-", " ").title(),
        "status": "queued",
        "files": [],
        "current_file": -1,
        "dest_dir": "",
        "error_detail": None,
        "error_repo_id": None,
    }


def _run_job(job_id: str) -> None:
    """Worker body: fetch the config file then the checkpoint, tracking progress.

    Runs on the dedicated download pool. All registry/job mutations take _LOCK.
    Any failure flips the job to ``error`` with the raw exception text so the
    frontend can classify and surface it; success flips it to ``done``.
    """
    with _LOCK:
        job = _REGISTRY.get(job_id)
        if job is None:
            return
        job["status"] = "downloading"
        repo_id = job["repo_id"]
        filenames = list(job["_filenames"])

    bound_tqdm = _bound_tqdm(job_id)

    try:
        for filename in filenames:
            with _LOCK:
                job = _REGISTRY.get(job_id)
                if job is None:
                    return
                job["files"].append(
                    {
                        "filename": filename,
                        "bytes_done": 0,
                        "bytes_total": 0,
                        "speed": 0.0,
                        "done": False,
                    }
                )
                job["current_file"] = len(job["files"]) - 1

            # Falls back to a public mirror when the gated official repo is
            # inaccessible, so a tokenless user's Setup-screen download still
            # succeeds instead of 401-ing (see model_configs._DEFAULT_MIRRORS).
            #
            # The cache watcher runs alongside because the Xet backend reports
            # nothing until the transfer finishes; see _CacheProgress.
            watcher = _CacheProgress(job_id, repo_id)
            watcher.start()
            try:
                path = hf_download_with_mirror(
                    repo_id=repo_id, filename=filename, tqdm_class=bound_tqdm
                )
            finally:
                watcher.stop()

            with _LOCK:
                job = _REGISTRY.get(job_id)
                if job is None:
                    return
                entry = job["files"][job["current_file"]]
                entry["done"] = True
                if entry["bytes_total"]:
                    entry["bytes_done"] = entry["bytes_total"]
                if path:
                    job["dest_dir"] = os.path.dirname(path)
    except Exception as exc:
        log.exception("modeldl: download job %s for %r failed", job_id, repo_id)
        with _LOCK:
            job = _REGISTRY.get(job_id)
            if job is not None:
                job["status"] = "error"
                job["error_detail"] = str(exc)
                job["error_repo_id"] = repo_id
        return

    with _LOCK:
        job = _REGISTRY.get(job_id)
        if job is not None:
            job["status"] = "done"


def _public_job(job: dict) -> dict:
    """A job dict stripped of private keys, safe to serialize. Caller holds _LOCK.

    Strips per-file private keys too — the cache watcher stamps ``_seen_at`` on
    a file entry to derive a transfer rate, and that is bookkeeping, not API.
    """
    public = {k: v for k, v in job.items() if not k.startswith("_")}
    public["files"] = [
        {k: v for k, v in entry.items() if not k.startswith("_")}
        for entry in job.get("files", [])
    ]
    return public


@router.post("/{name}/download")
def start_download(name: str) -> dict:
    cfg = all_models.get(name)
    if cfg is None:
        raise HTTPException(404, f"Unknown model {name!r}")

    # Atomic check-and-set: if a live job for this model already exists, rejoin
    # it instead of starting a duplicate. The existence check and the insert
    # happen under the SAME lock acquisition so two concurrent POSTs cannot both
    # decide to enqueue (no TOCTOU).
    with _LOCK:
        for existing in _REGISTRY.values():
            if existing["name"] == name and existing["status"] in _LIVE_STATUSES:
                return {
                    "job_id": existing["id"],
                    "name": existing["name"],
                    "status": existing["status"],
                }
        job = _new_job(name, cfg)
        job["_filenames"] = _config_files(cfg)
        _REGISTRY[job["id"]] = job
        job_id = job["id"]
        status = job["status"]

        # Bound growth: evict the oldest terminal jobs beyond the cap.
        terminal = [
            jid for jid, j in _REGISTRY.items() if j["status"] in _FINISHED_STATUSES
        ]
        for jid in terminal[: max(0, len(terminal) - _MAX_TERMINAL_JOBS)]:
            del _REGISTRY[jid]

    _EXECUTOR.submit(_run_job, job_id)
    return {"job_id": job_id, "name": name, "status": status}


@router.get("/downloads")
def list_downloads() -> dict:
    with _LOCK:
        jobs = [_public_job(job) for job in _REGISTRY.values()]
    return {"jobs": jobs}


@router.post("/downloads/clear")
def clear_downloads() -> dict:
    with _LOCK:
        finished = [
            job_id
            for job_id, job in _REGISTRY.items()
            if job["status"] in _FINISHED_STATUSES
        ]
        for job_id in finished:
            del _REGISTRY[job_id]
    return {"cleared": len(finished)}
