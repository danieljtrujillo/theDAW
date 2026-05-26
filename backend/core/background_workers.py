"""Idle-gated background worker queue.

One asyncio queue, one consumer task. Workers pull jobs only when the
shared ``IdleManager`` reports the app is currently idle. Foreground
endpoints don't interact with this directly — they call
``idle_manager.bump_activity()`` and the queue automatically pauses.

Job payload is intentionally generic: a callable + args + kwargs. Each
job is named so we can log progress meaningfully and surface a
``snapshot()`` for a future ``/api/jobs`` endpoint.

We keep this small: no priority lanes, no retries, no persistence. The
failure mode for a backgroundable job (analysis, stems, MIDI) is
"the user can right-click 'retry' on the entry" — there's no value in
durable queues for that workload.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

from .idle import IdleManager, get_idle_manager

log = logging.getLogger(__name__)


JobFunc = Callable[..., Awaitable[Any]]


@dataclass
class BackgroundJob:
    id: str
    name: str
    fn: JobFunc
    args: tuple[Any, ...] = ()
    kwargs: dict[str, Any] = field(default_factory=dict)
    queued_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    status: str = "queued"  # queued | running | done | failed | cancelled
    error: Optional[str] = None

    def snapshot(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "status": self.status,
            "queued_at": self.queued_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "error": self.error,
        }


class BackgroundQueue:
    """Single-consumer queue gated on idle. ``start()`` spawns the
    consumer task; ``stop()`` cancels it. ``enqueue()`` is safe to call
    from any coroutine."""

    def __init__(
        self,
        *,
        idle_manager: Optional[IdleManager] = None,
        poll_interval: float = 5.0,
    ) -> None:
        self._idle = idle_manager or get_idle_manager()
        self._poll_interval = float(poll_interval)
        self._queue: asyncio.Queue[BackgroundJob] = asyncio.Queue()
        self._consumer_task: Optional[asyncio.Task] = None
        self._jobs: dict[str, BackgroundJob] = {}
        self._stopped = asyncio.Event()
        self._stopped.set()

    # ---- Lifecycle ----------------------------------------------------------

    def start(self) -> None:
        if self._consumer_task is not None and not self._consumer_task.done():
            return
        self._stopped.clear()
        self._consumer_task = asyncio.create_task(self._consumer_loop())
        log.info("background_workers: consumer started")

    async def stop(self) -> None:
        self._stopped.set()
        if self._consumer_task is not None:
            self._consumer_task.cancel()
            try:
                await self._consumer_task
            except asyncio.CancelledError:
                pass
            self._consumer_task = None
        log.info("background_workers: consumer stopped")

    @property
    def running(self) -> bool:
        return self._consumer_task is not None and not self._consumer_task.done()

    # ---- Enqueue ------------------------------------------------------------

    def enqueue(
        self,
        name: str,
        fn: JobFunc,
        *args: Any,
        **kwargs: Any,
    ) -> BackgroundJob:
        job = BackgroundJob(
            id=str(uuid.uuid4()),
            name=name,
            fn=fn,
            args=args,
            kwargs=kwargs,
        )
        self._jobs[job.id] = job
        self._queue.put_nowait(job)
        log.debug("background_workers: enqueued %s (%s)", name, job.id)
        return job

    # ---- Observability ------------------------------------------------------

    def snapshot(self) -> dict[str, Any]:
        statuses: dict[str, int] = {}
        for j in self._jobs.values():
            statuses[j.status] = statuses.get(j.status, 0) + 1
        return {
            "running": self.running,
            "queue_depth": self._queue.qsize(),
            "statuses": statuses,
            "idle": self._idle.snapshot(),
        }

    def list_jobs(self, *, limit: int = 100) -> list[dict[str, Any]]:
        jobs = sorted(
            self._jobs.values(),
            key=lambda j: j.finished_at or j.started_at or j.queued_at,
            reverse=True,
        )
        return [j.snapshot() for j in jobs[:limit]]

    # ---- Consumer -----------------------------------------------------------

    async def _consumer_loop(self) -> None:
        while not self._stopped.is_set():
            try:
                job = await asyncio.wait_for(
                    self._queue.get(), timeout=self._poll_interval
                )
            except asyncio.TimeoutError:
                continue

            # Wait until the system is idle before doing anything heavy.
            while not self._idle.is_idle():
                await asyncio.sleep(self._poll_interval)
                if self._stopped.is_set():
                    job.status = "cancelled"
                    return

            job.started_at = time.time()
            job.status = "running"
            log.info("background_workers: running job %s (%s)", job.name, job.id)
            try:
                await job.fn(*job.args, **job.kwargs)
                job.status = "done"
            except asyncio.CancelledError:
                job.status = "cancelled"
                raise
            except Exception as e:
                job.status = "failed"
                job.error = repr(e)
                log.warning(
                    "background_workers: job %s failed: %s",
                    job.name,
                    e,
                )
            finally:
                job.finished_at = time.time()


# Process-wide singleton.
_default_queue: Optional[BackgroundQueue] = None


def get_background_queue() -> BackgroundQueue:
    global _default_queue
    if _default_queue is None:
        _default_queue = BackgroundQueue()
    return _default_queue
