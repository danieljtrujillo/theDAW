"""Batch 12 T11 — backend misc fixes.

- BE-005: a backup import that skips writes (unknown root id, disallowed
  settings name, merge-mode "already there", or a real write failure) must
  say so instead of reporting a silent ``done``.
- BE-006: the background-worker job table is bounded and duplicate-name
  lookups on enqueue are O(1) (no full scan of every job ever enqueued).
- BE-012: the ``core/jobs`` table is bounded, and a job a caller is actively
  ``subscribe()``d to (or that is still queued/running) is never evicted.
- BE-008: ``/api/studio/process`` reads its ffmpeg output off the event-loop
  thread so a large render doesn't stall other in-flight requests.
"""

from __future__ import annotations

import asyncio
import io
import json
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf
from fastapi import FastAPI, UploadFile
from fastapi.testclient import TestClient

from backend.core import jobs as core_jobs
from backend.core.background_workers import BackgroundQueue
from backend.core.idle import IdleManager
from backend.lib import known_paths
from backend.modules.backup import router as backup_router
from backend.modules.backup import service as backup_service
from backend.modules.effects import router as effects_router

# ---------------------------------------------------------------------------
# BE-005 — backup import reports skipped/failed writes
# ---------------------------------------------------------------------------


def _touch(path: Path, data: bytes = b"x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("theDAW_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path / "generations"))
    monkeypatch.setattr(
        known_paths, "_STORE_PATH", tmp_path / "state" / "known_paths.json"
    )
    monkeypatch.setattr(known_paths, "_GRANTS", {})
    return home


@pytest.fixture
def projects(home: Path, tmp_path: Path) -> Path:
    folder = tmp_path / "My Projects"
    known_paths.set_projects_dir(str(folder))
    return folder


@pytest.fixture
def backup(home: Path) -> TestClient:
    app = FastAPI()
    app.include_router(backup_router.router, prefix="/api/backup")
    # A loopback TCP peer: the backup routes answer only to this machine's own
    # UI, and TestClient's default peer ("testclient") is not an address.
    return TestClient(app, client=("127.0.0.1", 51000))


def _wait(client: TestClient, url: str, job: str) -> dict[str, Any]:
    deadline = time.monotonic() + 30.0
    while True:
        status = client.get(url, params={"job": job}).json()
        if status["state"] != "running" or time.monotonic() > deadline:
            return status
        time.sleep(0.05)


def _restore(client: TestClient, zip_path: str | Path, mode: str) -> dict[str, Any]:
    started = client.post(
        "/api/backup/import", json={"zip_path": str(zip_path), "mode": mode}
    )
    assert started.status_code == 200, started.text
    return _wait(client, "/api/backup/import/status", started.json()["job"])


def _crafted_archive(path: Path, members: dict[str, bytes]) -> Path:
    import zipfile

    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(
            backup_service.MANIFEST_NAME,
            json.dumps({"app": "theDAW", "roots": [{"id": "settings"}]}),
        )
        for name, data in members.items():
            zf.writestr(name, data)
    return path


def test_import_with_an_unknown_root_id_reports_the_skip(
    backup: TestClient, tmp_path: Path
) -> None:
    """An archive naming a root id this install doesn't have (e.g. it came
    from a build with a renamed/removed root) restores what it can but must
    not claim an unqualified ``done`` — the skip has to surface."""
    archive = _crafted_archive(
        tmp_path / "Downloads" / "theDAW-backup-crafted.zip",
        {
            "roots/settings/settings.json": b'{"theme": "restored"}',
            "roots/no-such-root/file.bin": b"orphaned",
        },
    )

    status = _restore(backup, archive, "merge")

    assert status["state"] == "done", status
    assert status.get("skipped", 0) >= 1
    assert status.get("message"), status


def test_a_clean_import_with_nothing_skipped_has_no_warning_message(
    backup: TestClient, tmp_path: Path
) -> None:
    archive = _crafted_archive(
        tmp_path / "Downloads" / "theDAW-backup-clean.zip",
        {"roots/settings/settings.json": b'{"theme": "restored"}'},
    )

    status = _restore(backup, archive, "merge")

    assert status["state"] == "done", status
    assert status.get("skipped", 0) == 0
    assert not status.get("message")


def test_merge_mode_skip_of_an_existing_file_is_also_counted(
    backup: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data_dir = tmp_path / "data"
    monkeypatch.setenv("theDAW_DATA_DIR", str(data_dir))
    _touch(data_dir / "settings.json", b'{"theme": "already-here"}')

    archive = _crafted_archive(
        tmp_path / "Downloads" / "theDAW-backup-merge.zip",
        {"roots/settings/settings.json": b'{"theme": "from-archive"}'},
    )

    status = _restore(backup, archive, "merge")

    assert status["state"] == "done", status
    assert status.get("skipped", 0) >= 1
    assert status.get("message"), status
    # Merge mode kept the file that was already there.
    assert (
        data_dir.joinpath("settings.json").read_bytes() == b'{"theme": "already-here"}'
    )


def test_import_of_a_malformed_path_member_logs_a_warning(
    backup: TestClient, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """The ``len(parts) < 3`` skip branch must log like every other skip
    branch already does — the UI message says 'see server log for
    details', so this one has to actually be in the log."""
    archive = _crafted_archive(
        tmp_path / "Downloads" / "theDAW-backup-malformed.zip",
        {"roots/tooshort": b"x"},
    )

    with caplog.at_level("WARNING", logger="backend.modules.backup.service"):
        status = _restore(backup, archive, "merge")

    assert status["state"] == "done", status
    assert status.get("skipped", 0) >= 1
    assert any("tooshort" in m for m in caplog.messages), caplog.messages


def test_merge_mode_skip_of_an_existing_file_logs_a_warning(
    backup: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The merge-mode 'already there' skip branch must also log, matching
    every other skip branch."""
    data_dir = tmp_path / "data"
    monkeypatch.setenv("theDAW_DATA_DIR", str(data_dir))
    _touch(data_dir / "settings.json", b'{"theme": "already-here"}')

    archive = _crafted_archive(
        tmp_path / "Downloads" / "theDAW-backup-merge-log.zip",
        {"roots/settings/settings.json": b'{"theme": "from-archive"}'},
    )

    with caplog.at_level("WARNING", logger="backend.modules.backup.service"):
        status = _restore(backup, archive, "merge")

    assert status["state"] == "done", status
    assert status.get("skipped", 0) >= 1
    assert any(
        "settings.json" in m and "merge" in m.lower() for m in caplog.messages
    ), caplog.messages


# ---------------------------------------------------------------------------
# BE-006 — background_workers: bounded table, O(1) duplicate-name enqueue
# ---------------------------------------------------------------------------


def test_background_queue_table_stays_bounded_across_many_jobs():
    async def scenario():
        idle = IdleManager(default_min_idle_seconds=0.0)
        q = BackgroundQueue(idle_manager=idle, poll_interval=0.01, max_jobs=5)
        q.start()

        async def work():
            return None

        try:
            for i in range(20):
                job = q.enqueue(f"job-{i}", work)
                for _ in range(50):
                    if job.status in ("done", "failed", "cancelled"):
                        break
                    await asyncio.sleep(0.01)
        finally:
            await q.stop()
        return len(q._jobs)

    table_size = asyncio.run(scenario())
    assert table_size <= 5


def test_background_queue_duplicate_name_lookup_does_not_scan_finished_jobs():
    """The dedupe check must key off the active-job index, not a linear scan
    of every job the queue has ever seen — a scan means enqueue cost grows
    with total history instead of staying O(1)."""

    async def scenario():
        idle = IdleManager(default_min_idle_seconds=0.0)
        q = BackgroundQueue(idle_manager=idle, poll_interval=0.01, max_jobs=1000)
        q.start()

        async def work():
            return None

        # Build up a lot of finished-job history.
        for i in range(200):
            job = q.enqueue(f"filler-{i}", work)
            for _ in range(50):
                if job.status in ("done", "failed", "cancelled"):
                    break
                await asyncio.sleep(0.005)

        async def slow_work():
            await asyncio.sleep(0.3)

        first = q.enqueue("dup-name", slow_work)
        second = q.enqueue("dup-name", slow_work)
        await q.stop()
        return first, second

    first, second = asyncio.run(scenario())
    assert first is second


def test_background_queue_finished_job_removed_from_active_index_so_name_reuse_works():
    async def scenario():
        idle = IdleManager(default_min_idle_seconds=0.0)
        q = BackgroundQueue(idle_manager=idle, poll_interval=0.01)
        q.start()

        async def work():
            return None

        try:
            first = q.enqueue("reusable", work)
            for _ in range(50):
                if first.status in ("done", "failed", "cancelled"):
                    break
                await asyncio.sleep(0.01)
            second = q.enqueue("reusable", work)
        finally:
            await q.stop()
        return first, second

    first, second = asyncio.run(scenario())
    assert first is not second
    assert first.status == "done"


# ---------------------------------------------------------------------------
# BE-012 — core/jobs: bounded table, subscribe() survives pruning
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_core_jobs(monkeypatch: pytest.MonkeyPatch):
    """core.jobs keeps a module-level table; isolate each test's writes."""
    monkeypatch.setattr(core_jobs, "_jobs", {})
    yield


def test_jobs_table_stays_bounded(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(core_jobs, "_MAX_JOBS", 5)
    for i in range(20):
        job = core_jobs.create_job("test", f"label-{i}")
        job.update(status="done")
    assert len(core_jobs._jobs) <= 5


def test_jobs_active_job_is_never_evicted(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(core_jobs, "_MAX_JOBS", 3)
    running = core_jobs.create_job("test", "still-running")
    for i in range(20):
        job = core_jobs.create_job("test", f"filler-{i}")
        job.update(status="done")
    assert core_jobs.get_job(running.id) is running


def test_jobs_subscribed_job_is_never_evicted(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(core_jobs, "_MAX_JOBS", 3)
    watched = core_jobs.create_job("test", "watched")
    watched.update(status="done")
    queue = watched.subscribe()

    for i in range(20):
        job = core_jobs.create_job("test", f"filler-{i}")
        job.update(status="done")

    assert core_jobs.get_job(watched.id) is watched
    watched.update(status="done", message="still here")
    assert queue.get_nowait()["message"] == "still here"


# ---------------------------------------------------------------------------
# BE-008 — /api/studio/process offloads the ffmpeg-output read
# ---------------------------------------------------------------------------


def test_studio_process_reads_output_off_the_event_loop_thread(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Regression test for BE-008: ``output_path.read_bytes()`` used to run
    synchronously inside the ``async def`` route, blocking the whole event
    loop for the duration of the read. A concurrently-scheduled heartbeat
    coroutine proves the loop keeps making progress while the (slowed-down)
    read is in flight, and the recorded thread id proves the read itself
    happened off the loop's thread."""

    wav_path = tmp_path / "in.wav"
    sf.write(str(wav_path), np.zeros(256, dtype=np.float32), 44100, subtype="PCM_16")
    audio_bytes = wav_path.read_bytes()

    produced = b"rendered-audio-bytes"
    read_thread_ids: list[int] = []
    main_thread_id = threading.get_ident()
    real_read_bytes = Path.read_bytes

    def slow_read_bytes(self: Path) -> bytes:
        read_thread_ids.append(threading.get_ident())
        time.sleep(0.2)
        return real_read_bytes(self)

    monkeypatch.setattr(Path, "read_bytes", slow_read_bytes)

    class _FakeProc:
        returncode = 0

        async def communicate(self):
            return b"", b""

    async def fake_create_subprocess_exec(*cmd, **kwargs):
        Path(cmd[-1]).write_bytes(produced)
        return _FakeProc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)

    async def scenario():
        heartbeats = 0

        async def heartbeat():
            nonlocal heartbeats
            for _ in range(8):
                await asyncio.sleep(0.03)
                heartbeats += 1

        upload = UploadFile(filename="in.wav", file=io.BytesIO(audio_bytes))

        response, _ = await asyncio.gather(
            effects_router.studio_process(
                audio=upload,
                effect="volume",
                params=json.dumps({"level": 1.0}),
                output_format="wav",
            ),
            heartbeat(),
        )
        return response, heartbeats

    response, heartbeats = asyncio.run(scenario())

    assert response.body == produced
    assert read_thread_ids
    assert main_thread_id not in read_thread_ids
    # If the read had blocked the loop, the heartbeat couldn't have ticked
    # while it was running.
    assert heartbeats >= 4


# ---------------------------------------------------------------------------
# T11 audit follow-up (BE-006 items 1-2, BE-005 item 3, BE-008 item 5)
# ---------------------------------------------------------------------------


def test_background_queue_enqueue_failure_leaves_the_name_free():
    """A queueing failure (e.g. ``call_soon_threadsafe`` on a loop that died
    without ``stop()`` clearing ``self._loop``) must not permanently block
    the job name — only a *successfully queued* job may occupy it."""
    idle = IdleManager(default_min_idle_seconds=0.0)
    q = BackgroundQueue(idle_manager=idle, poll_interval=0.01)

    dead_loop = asyncio.new_event_loop()
    dead_loop.close()
    q._loop = dead_loop  # simulates stop() not clearing a dead loop

    async def work():
        return None

    with pytest.raises(RuntimeError):
        q.enqueue("blocked-name", work)

    assert "blocked-name" not in q._active_by_name
    assert not any(j.name == "blocked-name" for j in q._jobs.values())

    # The name is free again: a later enqueue must create a brand-new job.
    q._loop = None
    second = q.enqueue("blocked-name", work)
    assert second.status == "queued"
    assert q._active_by_name["blocked-name"] is second


def test_background_queue_enqueue_thread_path_leaves_no_stale_active_entry_when_the_job_finishes_before_enqueue_returns():
    """Regression test: the sync-route (threadpool) path only *schedules*
    the put via call_soon_threadsafe and returns immediately, so the
    consumer can dequeue, run, and finish the job on the loop thread before
    the calling thread gets back around to registering it in
    self._active_by_name — if that registration happens *after* queueing,
    it overwrites the (already cleaned up) name with a stale, finished
    entry that a unique one-shot name (e.g. ``library-import:{id}``) will
    never get to reuse or clean up."""

    async def scenario():
        idle = IdleManager(default_min_idle_seconds=0.0)
        q = BackgroundQueue(idle_manager=idle, poll_interval=0.01)
        q.start()

        real_loop = q._loop
        finished = threading.Event()

        class _SlowLoopProxy:
            def call_soon_threadsafe(self, callback, *args):
                real_loop.call_soon_threadsafe(callback, *args)
                # Give the consumer (on real_loop's thread) a chance to
                # dequeue, run, and finish the job before this call returns
                # control to the calling (threadpool) thread.
                finished.wait(timeout=2.0)

        q._loop = _SlowLoopProxy()

        async def work():
            finished.set()

        result: dict[str, Any] = {}

        def call_from_thread():
            result["job"] = q.enqueue("library-import:abc", work)

        t = threading.Thread(target=call_from_thread)
        t.start()
        # Join from a worker thread, not synchronously in this coroutine:
        # a synchronous t.join() here would block the very event loop the
        # consumer task (and the proxy's real_loop.call_soon_threadsafe
        # callback) needs to run on, deadlocking the scenario instead of
        # reproducing the race.
        await asyncio.to_thread(t.join, 3.0)

        q._loop = real_loop
        await q.stop()
        return q, result.get("job")

    q, job = asyncio.run(scenario())
    assert job is not None
    assert job.status == "done"
    assert "library-import:abc" not in q._active_by_name
    assert q._jobs.get(job.id) is job


def test_background_queue_enqueue_direct_put_path_is_serialized_by_the_loop_lock():
    """A foreign-thread enqueue() with self._loop is None takes the direct
    ``self._queue.put_nowait(job)`` branch, which is not thread-safe against
    a concurrent start() spinning up the consumer on the real loop. Both
    must hold the same lock around the self._loop read + queue write."""
    idle = IdleManager(default_min_idle_seconds=0.0)
    q = BackgroundQueue(idle_manager=idle, poll_interval=0.01)

    async def work():
        return None

    result: dict[str, Any] = {}

    def do_enqueue():
        result["job"] = q.enqueue("race-name", work)

    with q._loop_lock:
        t = threading.Thread(target=do_enqueue)
        t.start()
        t.join(timeout=0.3)
        assert t.is_alive(), (
            "enqueue() did not take q._loop_lock before touching self._queue"
        )

    t.join(timeout=2.0)
    assert not t.is_alive()
    assert result["job"] is not None
    assert result["job"].status == "queued"


def test_background_queue_start_sets_the_loop_under_the_loop_lock():
    """start() must set self._loop under the same lock enqueue() uses, so a
    foreign-thread enqueue() in flight can't have self._loop swapped out
    from under it."""
    idle = IdleManager(default_min_idle_seconds=0.0)
    q = BackgroundQueue(idle_manager=idle, poll_interval=0.01)

    async def scenario():
        def hold_lock_briefly():
            with q._loop_lock:
                time.sleep(0.3)

        holder = threading.Thread(target=hold_lock_briefly)
        holder.start()
        time.sleep(0.05)  # let the holder thread grab the lock first

        started_at = time.monotonic()
        q.start()
        elapsed = time.monotonic() - started_at

        holder.join(timeout=2.0)
        await q.stop()
        return elapsed

    elapsed = asyncio.run(scenario())
    assert elapsed >= 0.2


def test_background_queue_stop_clears_the_captured_loop():
    async def scenario():
        idle = IdleManager(default_min_idle_seconds=0.0)
        q = BackgroundQueue(idle_manager=idle, poll_interval=0.01)
        q.start()
        assert q._loop is not None
        await q.stop()
        return q

    q = asyncio.run(scenario())
    assert q._loop is None


def test_background_queue_stop_during_idle_wait_frees_the_job_name():
    """A job parked in the idle-wait loop when ``stop()`` cancels the
    consumer task must still be marked finished (cancelled) so its name is
    released — a bare ``CancelledError`` from ``await asyncio.sleep`` must
    not skip ``_mark_finished``."""

    async def scenario():
        idle = IdleManager(default_min_idle_seconds=5.0)
        idle.bump_activity()  # keeps is_idle() False for the whole test
        q = BackgroundQueue(idle_manager=idle, poll_interval=0.05)
        q.start()

        async def work():
            return None

        job = q.enqueue("stuck", work)
        # Let the consumer pop the job and enter the idle-wait loop.
        await asyncio.sleep(0.1)
        await q.stop()
        return q, job

    q, job = asyncio.run(scenario())
    assert job.status == "cancelled"
    assert job.finished_at is not None
    assert "stuck" not in q._active_by_name


def test_background_queue_stop_drains_jobs_still_sitting_in_the_queue():
    """Jobs that never made it past ``self._queue`` before ``stop()`` cancels
    the consumer must also be marked finished, not left stranded holding
    their name forever."""

    async def scenario():
        idle = IdleManager(default_min_idle_seconds=5.0)
        idle.bump_activity()
        q = BackgroundQueue(idle_manager=idle, poll_interval=0.05)
        q.start()

        async def work():
            return None

        first = q.enqueue("a", work)
        second = q.enqueue("b", work)
        third = q.enqueue("c", work)
        # Let the consumer pop `first` and enter the idle-wait loop, leaving
        # `second`/`third` sitting unread in self._queue.
        await asyncio.sleep(0.1)
        await q.stop()
        return q, first, second, third

    q, first, second, third = asyncio.run(scenario())
    for job, name in ((first, "a"), (second, "b"), (third, "c")):
        assert job.status == "cancelled", (name, job.status)
        assert job.finished_at is not None
        assert name not in q._active_by_name


def test_import_progress_updates_on_every_skip_branch(
    home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The ``len(parts) < 3`` / zip-slip / resolve-``OSError`` /
    write-``OSError`` skip branches must move ``job.progress`` forward like
    the other skip branches already do, not leave it frozen at 0 while
    ``job.skipped`` grows only at the final unconditional flush."""
    archive = _crafted_archive(
        tmp_path / "Downloads" / "theDAW-backup-skip-progress.zip",
        {
            "roots/tooshort": b"a" * 1000,  # len(parts) < 3 -> skip at ~444
            "roots/settings/settings.json": b'{"theme": "restored"}',
        },
    )

    job = backup_service._register_job("import")
    snapshots: list[tuple[float, int]] = []
    real_lock = backup_service._jobs_lock

    class _SpyLock:
        def __enter__(self):
            real_lock.__enter__()
            return self

        def __exit__(self, *exc):
            snapshots.append((job.progress, job.skipped))
            return real_lock.__exit__(*exc)

    monkeypatch.setattr(backup_service, "_jobs_lock", _SpyLock())

    backup_service._run_import(job, archive, "merge")

    assert job.skipped >= 1
    # Exclude the final unconditional flush (last snapshot): some earlier,
    # lock-protected update must already show progress > 0 together with
    # skipped > 0, proving the skip branch updates both together.
    assert any(p > 0 and s > 0 for p, s in snapshots[:-1]), snapshots


def test_studio_process_rmtree_cleanup_runs_off_the_event_loop_thread(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Regression test: the success-path ``shutil.rmtree(tmp_dir,
    ignore_errors=True)`` used to run synchronously inside the ``async def``
    route, blocking the event loop for the duration of the temp-dir
    teardown."""
    wav_path = tmp_path / "in.wav"
    sf.write(str(wav_path), np.zeros(256, dtype=np.float32), 44100, subtype="PCM_16")
    audio_bytes = wav_path.read_bytes()

    produced = b"rendered-audio-bytes"
    rmtree_thread_ids: list[int] = []
    main_thread_id = threading.get_ident()
    real_rmtree = effects_router.shutil.rmtree

    def slow_rmtree(path, ignore_errors=False, **kwargs):
        rmtree_thread_ids.append(threading.get_ident())
        time.sleep(0.2)
        return real_rmtree(path, ignore_errors=ignore_errors, **kwargs)

    monkeypatch.setattr(effects_router.shutil, "rmtree", slow_rmtree)

    class _FakeProc:
        returncode = 0

        async def communicate(self):
            return b"", b""

    async def fake_create_subprocess_exec(*cmd, **kwargs):
        Path(cmd[-1]).write_bytes(produced)
        return _FakeProc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)

    async def scenario():
        heartbeats = 0

        async def heartbeat():
            nonlocal heartbeats
            for _ in range(8):
                await asyncio.sleep(0.03)
                heartbeats += 1

        upload = UploadFile(filename="in.wav", file=io.BytesIO(audio_bytes))

        response, _ = await asyncio.gather(
            effects_router.studio_process(
                audio=upload,
                effect="volume",
                params=json.dumps({"level": 1.0}),
                output_format="wav",
            ),
            heartbeat(),
        )
        return response, heartbeats

    response, heartbeats = asyncio.run(scenario())

    assert response.body == produced
    assert rmtree_thread_ids
    assert main_thread_id not in rmtree_thread_ids
    assert heartbeats >= 4


def test_studio_process_error_path_rmtree_cleanup_runs_off_the_event_loop_thread(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Regression test: the FFmpeg-error-path ``shutil.rmtree(tmp_dir,
    ignore_errors=True)`` (proc.returncode != 0) must also be offloaded to a
    thread, not just the success path — it used to run synchronously inside
    the ``async def`` route, blocking the event loop for the duration of the
    temp-dir teardown."""
    wav_path = tmp_path / "in.wav"
    sf.write(str(wav_path), np.zeros(256, dtype=np.float32), 44100, subtype="PCM_16")
    audio_bytes = wav_path.read_bytes()

    rmtree_thread_ids: list[int] = []
    main_thread_id = threading.get_ident()
    real_rmtree = effects_router.shutil.rmtree

    def slow_rmtree(path, ignore_errors=False, **kwargs):
        rmtree_thread_ids.append(threading.get_ident())
        time.sleep(0.2)
        return real_rmtree(path, ignore_errors=ignore_errors, **kwargs)

    monkeypatch.setattr(effects_router.shutil, "rmtree", slow_rmtree)

    class _FakeFailedProc:
        returncode = 1

        async def communicate(self):
            return b"", b"ffmpeg blew up"

    async def fake_create_subprocess_exec(*cmd, **kwargs):
        return _FakeFailedProc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)

    async def scenario():
        heartbeats = 0

        async def heartbeat():
            nonlocal heartbeats
            for _ in range(8):
                await asyncio.sleep(0.03)
                heartbeats += 1

        async def call_route():
            upload = UploadFile(filename="in.wav", file=io.BytesIO(audio_bytes))
            try:
                await effects_router.studio_process(
                    audio=upload,
                    effect="volume",
                    params=json.dumps({"level": 1.0}),
                    output_format="wav",
                )
            except Exception as e:  # HTTPException, expected
                return e

        error, _ = await asyncio.gather(call_route(), heartbeat())
        return error, heartbeats

    error, heartbeats = asyncio.run(scenario())

    assert error is not None
    assert rmtree_thread_ids
    assert main_thread_id not in rmtree_thread_ids
    # If the rmtree had blocked the loop, the heartbeat couldn't have ticked
    # while it was running.
    assert heartbeats >= 4
