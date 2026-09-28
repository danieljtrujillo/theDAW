import asyncio
import uuid
from dataclasses import dataclass, field
from typing import Literal, Optional

from backend.lib.stamps import IncreasingClock

JobStatus = Literal["queued", "running", "done", "failed", "cancelled"]

# created_at / updated_at, strictly increasing: _prune_jobs evicts the least
# recently updated first, and jobs updated in one 15.6 ms tick of Windows'
# clock tied (backend/lib/stamps.py).
_stamp = IncreasingClock()


@dataclass
class Job:
    id: str
    module: str
    label: str
    status: JobStatus = "queued"
    progress: float = 0.0
    message: str = ""
    created_at: float = field(default_factory=_stamp)
    updated_at: float = field(default_factory=_stamp)
    result: Optional[dict] = None
    error: Optional[str] = None
    _subscribers: list = field(default_factory=list, repr=False)

    def update(
        self,
        status: Optional[JobStatus] = None,
        progress: Optional[float] = None,
        message: Optional[str] = None,
    ) -> None:
        if status:
            self.status = status
        if progress is not None:
            self.progress = progress
        if message:
            self.message = message
        self.updated_at = _stamp()
        payload = dict(status=self.status, progress=self.progress, message=self.message)
        for q in self._subscribers:
            q.put_nowait(payload)

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass


_jobs: dict[str, Job] = {}

# Bound on the in-memory job table. Nothing ever calls list_jobs() today, so
# nothing was trimming this dict — it grew for the life of the process.
# Eviction never touches a job that is still queued/running or that a caller
# is watching via subscribe(): only finished, unwatched jobs are prunable.
_MAX_JOBS = 500


def create_job(module: str, label: str) -> Job:
    job = Job(id=str(uuid.uuid4()), module=module, label=label)
    _jobs[job.id] = job
    _prune_jobs()
    return job


def _prune_jobs() -> None:
    if len(_jobs) <= _MAX_JOBS:
        return
    terminal = {"done", "failed", "cancelled"}
    evictable = sorted(
        (j for j in _jobs.values() if j.status in terminal and not j._subscribers),
        key=lambda j: j.updated_at,
    )
    overflow = len(_jobs) - _MAX_JOBS
    for j in evictable[:overflow]:
        _jobs.pop(j.id, None)


def get_job(job_id: str) -> Optional[Job]:
    return _jobs.get(job_id)


def list_jobs(module: Optional[str] = None) -> list[Job]:
    jobs = list(_jobs.values())
    if module:
        jobs = [j for j in jobs if j.module == module]
    return jobs
