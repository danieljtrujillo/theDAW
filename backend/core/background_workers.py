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
import threading
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

from backend.lib.stamps import IncreasingClock

from .idle import IdleManager, get_idle_manager

# queued_at / started_at / finished_at, strictly increasing: list_jobs orders
# newest first by them, and jobs stamped in one 15.6 ms tick of Windows' clock
# tied and listed oldest first (backend/lib/stamps.py).
_stamp = IncreasingClock()

log = logging.getLogger(__name__)


JobFunc = Callable[..., Awaitable[Any]]


@dataclass
class BackgroundJob:
    id: str
    name: str
    fn: JobFunc
    args: tuple[Any, ...] = ()
    kwargs: dict[str, Any] = field(default_factory=dict)
    queued_at: float = field(default_factory=_stamp)
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
        max_jobs: int = 500,
    ) -> None:
        self._idle = idle_manager or get_idle_manager()
        self._poll_interval = float(poll_interval)
        self._max_jobs = int(max_jobs)
        self._queue: asyncio.Queue[BackgroundJob] = asyncio.Queue()
        self._consumer_task: Optional[asyncio.Task] = None
        self._jobs: dict[str, BackgroundJob] = {}
        # Active (queued/running) job per name, so enqueue()'s duplicate check
        # is a dict lookup instead of a scan over every job ever enqueued.
        self._active_by_name: dict[str, BackgroundJob] = {}
        # Finished-job ids in finish order, so pruning the table back down to
        # max_jobs is an O(1)-amortized popleft instead of a full rescan.
        self._finished_order: deque[str] = deque()
        self._stopped = asyncio.Event()
        self._stopped.set()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        # Guards self._loop (read + write) together with the direct
        # self._queue.put_nowait() enqueue() takes when self._loop is None:
        # without it, a foreign-thread enqueue() reading self._loop as None
        # and a concurrent start() setting it (and spinning up the consumer)
        # can race, letting that direct put_nowait touch the queue at the
        # same time the newly-started consumer's queue.get() does.
        self._loop_lock = threading.Lock()

    # ---- Lifecycle ----------------------------------------------------------

    def start(self) -> None:
        if self._consumer_task is not None and not self._consumer_task.done():
            return
        self._stopped.clear()
        # Captured so enqueue() can marshal puts from threadpool threads
        # (sync routes) onto this loop instead of touching the asyncio.Queue
        # cross-thread, which races the consumer's wakeup.
        with self._loop_lock:
            self._loop = asyncio.get_running_loop()
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
        with self._loop_lock:
            self._loop = None
        # Any job still sitting in self._queue never reached the consumer's
        # `await self._queue.get()`, so it would otherwise stay "queued"
        # forever, permanently blocking its name.
        while True:
            try:
                stranded = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            stranded.status = "cancelled"
            self._mark_finished(stranded)
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
        existing = self._active_by_name.get(name)
        if existing is not None and existing.status in {"queued", "running"}:
            log.info(
                "background_workers: skipping duplicate active job %s (%s)",
                name,
                existing.id,
            )
            return existing
        job = BackgroundJob(
            id=str(uuid.uuid4()),
            name=name,
            fn=fn,
            args=args,
            kwargs=kwargs,
        )
        # Register BEFORE queueing: the sync-route (threadpool) path below
        # only *schedules* the put via call_soon_threadsafe and returns
        # immediately, so the consumer can dequeue, run, and finish the job
        # on the loop thread before this thread gets back around to
        # registering it — if that registration happened after queueing, it
        # would overwrite the (already cleaned up) name with a stale,
        # finished entry that a unique one-shot name never gets to reuse.
        self._active_by_name[name] = job
        self._jobs[job.id] = job
        try:
            try:
                asyncio.get_running_loop()
                on_loop = True
            except RuntimeError:
                on_loop = False
            # self._loop (read) and the direct put_nowait branch below share
            # a lock with start()/stop()'s writes to self._loop: without it,
            # a foreign-thread enqueue() reading self._loop as None could
            # race a concurrent start() spinning up the consumer, touching
            # self._queue at the same time the new consumer's queue.get()
            # does.
            with self._loop_lock:
                loop = self._loop
                if on_loop or loop is None:
                    self._queue.put_nowait(job)
                else:
                    # Sync routes run in the threadpool; touching the
                    # asyncio.Queue cross-thread races the consumer, so
                    # marshal onto the loop.
                    loop.call_soon_threadsafe(self._queue.put_nowait, job)
        except Exception:
            # Queueing failed (e.g. call_soon_threadsafe on a closed loop):
            # undo the registration above so the name isn't permanently
            # blocked by a job that was never actually queued. Only remove
            # entries that still point at this exact job — a concurrent
            # enqueue() for the same name may have already superseded it.
            if self._active_by_name.get(name) is job:
                del self._active_by_name[name]
            if self._jobs.get(job.id) is job:
                del self._jobs[job.id]
            raise
        self._prune_finished()
        log.debug("background_workers: enqueued %s (%s)", name, job.id)
        return job

    def _prune_finished(self) -> None:
        """Evict the oldest finished jobs once the table exceeds
        ``max_jobs``. ``_finished_order`` already holds ids in finish order,
        so this is a bounded number of popleft() calls, not a scan of
        ``self._jobs``."""
        while len(self._jobs) > self._max_jobs and self._finished_order:
            jid = self._finished_order.popleft()
            self._jobs.pop(jid, None)

    def _mark_finished(self, job: BackgroundJob) -> None:
        """Record a job's terminal status: stamp ``finished_at`` (every
        caller sets ``status`` itself first), drop it from the active-name
        index (so its name can be reused), and queue it for pruning."""
        if job.finished_at is None:
            job.finished_at = _stamp()
        if self._active_by_name.get(job.name) is job:
            del self._active_by_name[job.name]
        self._finished_order.append(job.id)

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
            try:
                while not self._idle.is_idle():
                    await asyncio.sleep(self._poll_interval)
                    if self._stopped.is_set():
                        job.status = "cancelled"
                        self._mark_finished(job)
                        return
            except asyncio.CancelledError:
                # stop() cancelled the consumer task while this job was
                # parked in the idle wait: `await asyncio.sleep()` raises
                # immediately, before the `self._stopped.is_set()` check
                # above ever runs. Without this, the job stays "queued"
                # forever and its name is permanently blocked.
                job.status = "cancelled"
                self._mark_finished(job)
                raise

            job.started_at = _stamp()
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
                job.finished_at = _stamp()
                self._mark_finished(job)


# Process-wide singleton.
_default_queue: Optional[BackgroundQueue] = None


def get_background_queue() -> BackgroundQueue:
    global _default_queue
    if _default_queue is None:
        _default_queue = BackgroundQueue()
    return _default_queue
