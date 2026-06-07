"""Tiny in-process job + progress registry for long-running (GPU) tasks.

Neural tools can take seconds to minutes; the frontend polls ``/jobs/{id}`` for
progress (same pattern as the existing stems separation). This is a minimal,
thread-safe-enough registry for a single-process dev backend.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Optional


@dataclass
class Job:
    id: str
    kind: str
    status: str = "pending"  # pending | running | done | failed
    progress: float = 0.0  # 0..1
    message: str = ""
    result_path: Optional[str] = None
    error: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "progress": round(self.progress, 4),
            "message": self.message,
            "error": self.error,
        }


class JobRegistry:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}

    def create(self, kind: str) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], kind=kind)
        self._jobs[job.id] = job
        return job

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def update(self, job_id: str, **fields) -> None:
        job = self._jobs.get(job_id)
        if job:
            for k, v in fields.items():
                setattr(job, k, v)


JOBS = JobRegistry()
