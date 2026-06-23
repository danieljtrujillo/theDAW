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

import contextvars
import logging
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, HTTPException
from huggingface_hub import hf_hub_download
from tqdm.auto import tqdm

from stable_audio_3.model_configs import (
    AutoencoderModelConfig,
    ModelConfig,
    all_models,
)

log = logging.getLogger(__name__)

router = APIRouter()

# job_id -> job dict. Guarded by _LOCK for every read and write, because worker
# threads mutate jobs while request handlers read them.
_REGISTRY: dict[str, dict] = {}
_LOCK = threading.Lock()

# A dedicated pool keeps long downloads off asyncio's shared default executor.
_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="modeldl")

# The worker thread stamps its job id here so _JobTqdm (constructed inside
# huggingface_hub, out of our control) can find the job it is reporting on.
_CURRENT_JOB: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "modeldl_current_job", default=None
)

_LIVE_STATUSES = frozenset({"queued", "downloading"})
_FINISHED_STATUSES = frozenset({"done", "error"})


class _JobTqdm(tqdm):
    """tqdm subclass that mirrors transfer progress into the active job entry.

    Every progress write is wrapped in try/except: a bookkeeping error must
    never abort an in-flight download.
    """

    def _publish(self) -> None:
        job_id = _CURRENT_JOB.get()
        if not job_id:
            return
        try:
            rate = self.format_dict.get("rate")
            with _LOCK:
                job = _REGISTRY.get(job_id)
                if job is None:
                    return
                idx = job["current_file"]
                if idx < 0 or idx >= len(job["files"]):
                    return
                entry = job["files"][idx]
                entry["bytes_done"] = self.n
                entry["bytes_total"] = self.total or 0
                entry["speed"] = float(rate) if rate else 0.0
        except Exception:  # pragma: no cover - defensive, must never raise
            log.debug("modeldl: progress publish failed", exc_info=True)

    def update(self, n: int | float = 1) -> bool | None:
        displayed = super().update(n)
        self._publish()
        return displayed

    def close(self) -> None:
        # Flush a final reading (e.g. the closing 100% tick) before teardown.
        self._publish()
        super().close()


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
    _CURRENT_JOB.set(job_id)
    with _LOCK:
        job = _REGISTRY.get(job_id)
        if job is None:
            return
        job["status"] = "downloading"
        repo_id = job["repo_id"]
        filenames = list(job["_filenames"])

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

            path = hf_hub_download(
                repo_id=repo_id, filename=filename, tqdm_class=_JobTqdm
            )

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
    """A job dict stripped of private keys, safe to serialize. Caller holds _LOCK."""
    return {k: v for k, v in job.items() if not k.startswith("_")}


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
