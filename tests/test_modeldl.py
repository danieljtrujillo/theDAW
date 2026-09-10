"""Tests for the model-download job registry (backend.modules.modeldl.router).

The router's ``hf_download_with_mirror`` (the hf_hub_download wrapper with the
public-mirror fallback) is monkeypatched in the router namespace so
no network call or weight download ever happens. The download pool is real, so
each test that starts a job polls for the terminal state with a timeout to stay
deterministic without sleeping on a fixed delay.
"""

from __future__ import annotations

import io
import threading
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.modeldl import router as modeldl


@pytest.fixture
def client(monkeypatch):
    """A TestClient over an app that mounts only the modeldl router.

    The registry is reset before and after each test so jobs never leak between
    cases (it is module-global, shared with the live app).
    """
    with modeldl._LOCK:
        modeldl._REGISTRY.clear()

    app = FastAPI()
    app.include_router(modeldl.router, prefix="/api/models")
    with TestClient(app) as test_client:
        yield test_client

    with modeldl._LOCK:
        modeldl._REGISTRY.clear()


def _wait_for_status(
    client: TestClient, job_id: str, target: str, timeout: float = 5.0
):
    """Poll GET /downloads until the job reaches ``target`` or ``timeout`` elapses."""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        jobs = client.get("/api/models/downloads").json()["jobs"]
        last = next((j for j in jobs if j["id"] == job_id), None)
        if last is not None and last["status"] == target:
            return last
        time.sleep(0.02)
    raise AssertionError(
        f"job {job_id} did not reach {target!r} within {timeout}s; last={last!r}"
    )


def _first_catalog_name() -> str:
    return next(iter(modeldl.all_models))


def test_download_unknown_name_returns_404(client):
    resp = client.post("/api/models/not-a-real-model/download")
    assert resp.status_code == 404


def test_download_valid_name_reaches_done(client, monkeypatch):
    calls: list[tuple[str, str]] = []

    def fake_download(*, repo_id, filename, **kwargs):
        calls.append((repo_id, filename))
        # A job-bound _JobTqdm subclass must be forwarded so live progress works.
        tqdm_class = kwargs.get("tqdm_class")
        assert tqdm_class is not None and issubclass(tqdm_class, modeldl._JobTqdm)
        return f"/fake/cache/{repo_id}/{filename}"

    monkeypatch.setattr(modeldl, "hf_download_with_mirror", fake_download)

    name = _first_catalog_name()
    resp = client.post(f"/api/models/{name}/download")
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == name
    assert body["status"] in {"queued", "downloading", "done"}
    job_id = body["job_id"]
    assert job_id

    job = _wait_for_status(client, job_id, "done")
    # Both the config file and the checkpoint file were fetched, in that order.
    assert len(calls) == 2
    assert len(job["files"]) == 2
    assert all(f["done"] for f in job["files"])
    assert job["dest_dir"]
    assert job["error_detail"] is None


def test_duplicate_download_while_live_returns_same_job(client, monkeypatch):
    release = threading.Event()
    entered = threading.Event()

    def blocking_download(*, repo_id, filename, **kwargs):
        # Hold the worker inside the first file so the job stays "downloading"
        # for the duration of the duplicate POST, forcing the dedup path.
        entered.set()
        assert release.wait(timeout=5.0), "test never released the blocked download"
        return f"/fake/cache/{repo_id}/{filename}"

    monkeypatch.setattr(modeldl, "hf_download_with_mirror", blocking_download)

    name = _first_catalog_name()
    first = client.post(f"/api/models/{name}/download").json()
    assert entered.wait(timeout=5.0), "worker never started the download"

    second = client.post(f"/api/models/{name}/download").json()
    assert second["job_id"] == first["job_id"]
    assert second["status"] in {"queued", "downloading"}

    # Exactly one job exists for this name while it is live.
    jobs = client.get("/api/models/downloads").json()["jobs"]
    live = [j for j in jobs if j["name"] == name]
    assert len(live) == 1

    release.set()
    _wait_for_status(client, first["job_id"], "done")


def test_download_error_path_records_detail(client, monkeypatch):
    def boom(*, repo_id, filename, **kwargs):
        raise RuntimeError("network exploded")

    monkeypatch.setattr(modeldl, "hf_download_with_mirror", boom)

    name = _first_catalog_name()
    job_id = client.post(f"/api/models/{name}/download").json()["job_id"]

    job = _wait_for_status(client, job_id, "error")
    assert job["status"] == "error"
    assert job["error_detail"] == "network exploded"
    assert job["error_repo_id"] == modeldl._repo_id(modeldl.all_models[name])


def test_clear_removes_finished_jobs(client, monkeypatch):
    monkeypatch.setattr(
        modeldl,
        "hf_download_with_mirror",
        lambda *, repo_id, filename, **kwargs: f"/fake/{repo_id}/{filename}",
    )

    name = _first_catalog_name()
    job_id = client.post(f"/api/models/{name}/download").json()["job_id"]
    _wait_for_status(client, job_id, "done")

    cleared = client.post("/api/models/downloads/clear").json()
    assert cleared["cleared"] == 1

    jobs = client.get("/api/models/downloads").json()["jobs"]
    assert all(j["id"] != job_id for j in jobs)


def test_jobtqdm_publishes_from_foreign_thread():
    """Live progress must update even when tqdm.update() runs on a different
    thread than the worker — as huggingface_hub's Xet backend does. This fails
    with a contextvar-based binding and passes with the job-bound subclass.
    """
    job_id = "foreign-thread-job"
    with modeldl._LOCK:
        modeldl._REGISTRY[job_id] = {
            "id": job_id,
            "name": "x",
            "repo_id": "x/x",
            "label": "X",
            "status": "downloading",
            "files": [
                {
                    "filename": "f",
                    "bytes_done": 0,
                    "bytes_total": 0,
                    "speed": 0.0,
                    "done": False,
                }
            ],
            "current_file": 0,
            "dest_dir": "",
            "error_detail": None,
            "error_repo_id": None,
        }
    try:
        bar = modeldl._bound_tqdm(job_id)(total=100, file=io.StringIO())
        # Drive update() from a foreign thread; a contextvar would not carry here.
        worker = threading.Thread(target=lambda: bar.update(40))
        worker.start()
        worker.join()
        bar.close()

        with modeldl._LOCK:
            entry = modeldl._REGISTRY[job_id]["files"][0]
        assert entry["bytes_done"] == 40
        assert entry["bytes_total"] == 100
    finally:
        with modeldl._LOCK:
            modeldl._REGISTRY.pop(job_id, None)


def test_job_tqdm_accepts_huggingface_hub_name_kwarg():
    """hf_hub_download builds the bar as ``tqdm_class(..., name="huggingface_hub.http_get")``.

    A subclass of plain ``tqdm`` rejects that kwarg with ``TqdmKeyError`` — but
    only when stderr is a terminal, because tqdm validates kwargs after the
    early return it takes when it disables itself on a pipe. Pinokio runs the
    backend in a pty, so every model download there died on the first byte
    while piped test runs never noticed. The class must be built on
    ``huggingface_hub.utils.tqdm``, which owns the ``name`` kwarg.
    """

    class _Tty(io.StringIO):
        def isatty(self) -> bool:
            return True

    cls = modeldl._bound_tqdm("job-tty")
    bar = cls(total=4, disable=None, file=_Tty(), name="huggingface_hub.http_get")
    try:
        bar.update(2)
        assert bar.n == 2
    finally:
        bar.close()


def _fake_job(job_id: str, filename: str = "f") -> dict:
    return {
        "id": job_id,
        "name": "x",
        "repo_id": "x/x",
        "label": "X",
        "status": "downloading",
        "files": [
            {
                "filename": filename,
                "bytes_done": 0,
                "bytes_total": 0,
                "speed": 0.0,
                "done": False,
            }
        ],
        "current_file": 0,
        "dest_dir": "",
        "error_detail": None,
        "error_repo_id": None,
    }


def test_progress_survives_a_tqdm_that_disabled_itself():
    """The bar theDAW actually gets is a DISABLED one, and a disabled tqdm does
    not count.

    ``hf_hub_download`` builds it with ``disable=is_tqdm_disabled(...)``, which
    returns ``None``, so tqdm applies its own rule: off whenever the stream is
    not a terminal. Under the Electron shell stderr is always a pipe, so the
    bar was always disabled — and ``tqdm.update()`` returns immediately without
    moving ``n`` when it is. ``total`` is still set at construction, which is
    why the download dock read "0 B / 8.6 GB" for a transfer that was running
    perfectly (GH: "downloads remain stuck at 0 B").
    """
    job_id = "disabled-bar-job"
    with modeldl._LOCK:
        modeldl._REGISTRY[job_id] = _fake_job(job_id)
    try:
        # disable=None + a non-tty stream is exactly what the app sees.
        bar = modeldl._bound_tqdm(job_id)(
            total=1000, disable=None, file=io.StringIO(), name="huggingface_hub.xet_get"
        )
        assert bar.disable is True, "the premise: this bar draws nothing"
        bar.update(250)
        bar.update(250)
        with modeldl._LOCK:
            entry = modeldl._REGISTRY[job_id]["files"][0]
        assert entry["bytes_done"] == 500, "bytes are ours to count, not tqdm's"
        assert entry["bytes_total"] == 1000
        assert entry["speed"] > 0
        bar.close()
    finally:
        with modeldl._LOCK:
            modeldl._REGISTRY.pop(job_id, None)


def test_two_xet_bars_never_move_the_readout_backwards():
    """huggingface_hub >= 1.23 constructs the tqdm_class TWICE per Xet file: a
    reconstruction bar counting file bytes and a ".transfer" bar counting
    compressed network bytes, driven concurrently and ending below the file
    size. Under 1.7.1 there was one bar. This replays the interleaving that
    dropped the Settings readout by 209 MB mid-download: the transfer bar runs
    ahead, the reconstruction bar catches up in bursts, the transfer bar closes
    short of the total."""
    job_id = "dual-bar-job"
    with modeldl._LOCK:
        modeldl._REGISTRY[job_id] = _fake_job(job_id)
    try:
        make = modeldl._bound_tqdm(job_id)
        recon = make(
            total=1000,
            disable=None,
            file=io.StringIO(),
            name="huggingface_hub.xet_get",
            position=1,
        )
        xfer = make(
            total=900,
            disable=None,
            file=io.StringIO(),
            name="huggingface_hub.xet_get.transfer",
            position=0,
        )
        seen: list[tuple[int, int]] = []

        def read() -> None:
            with modeldl._LOCK:
                entry = modeldl._REGISTRY[job_id]["files"][0]
                seen.append((entry["bytes_done"], entry["bytes_total"]))

        for bar, n in [
            (xfer, 300),
            (recon, 100),
            (xfer, 300),
            (recon, 500),
            (xfer, 300),
            (recon, 400),
        ]:
            bar.update(n)
            read()
        xfer.close()
        read()
        recon.close()
        read()
        dones = [d for d, _ in seen]
        assert dones == sorted(dones), f"readout went backwards: {dones}"
        assert dones[-1] == 1000
        assert all(t == 1000 for _, t in seen), (
            "the transfer bar's compressed total must never show"
        )
    finally:
        with modeldl._LOCK:
            modeldl._REGISTRY.pop(job_id, None)


def test_a_resumed_transfer_starts_from_its_offset():
    """``initial=`` is how hub reports a part-downloaded file. Counting from
    zero there would show a 4 GB resume restarting."""
    job_id = "resume-job"
    with modeldl._LOCK:
        modeldl._REGISTRY[job_id] = _fake_job(job_id)
    try:
        bar = modeldl._bound_tqdm(job_id)(
            total=1000, initial=400, disable=None, file=io.StringIO()
        )
        bar.update(100)
        with modeldl._LOCK:
            entry = modeldl._REGISTRY[job_id]["files"][0]
        assert entry["bytes_done"] == 500
        bar.close()
    finally:
        with modeldl._LOCK:
            modeldl._REGISTRY.pop(job_id, None)


def test_cache_watcher_reports_the_part_file_and_never_goes_backwards(tmp_path):
    """Xet says nothing until it finishes, so the bytes come off the disk.

    ``hf_xet`` drives the tqdm shim with ``update(0)`` on a ~200 ms tick and
    then hands over the whole byte count in one final call — measured, on a
    34 MB file: nine zero-updates and one 34,362,429. Both backends write the
    same ``*.incomplete`` blob, so that is what the watcher reads.

    It may only ever RAISE the count: the tqdm path and this one run at the
    same time, and a reader must never watch the number fall.
    """
    job_id = "watcher-job"
    blobs = tmp_path / "blobs"
    blobs.mkdir()
    with modeldl._LOCK:
        modeldl._REGISTRY[job_id] = _fake_job(job_id)
    try:
        assert modeldl._incomplete_bytes([blobs]) == 0, "nothing in flight yet"
        (blobs / "abc123.incomplete").write_bytes(b"x" * 4096)
        # A finished blob beside it is not progress on anything.
        (blobs / "done-blob").write_bytes(b"y" * 999999)
        assert modeldl._incomplete_bytes([blobs]) == 4096
        # The largest part-file wins: an abandoned one from a previous run must
        # not mask the real transfer.
        (blobs / "def456.incomplete").write_bytes(b"z" * 8192)
        assert modeldl._incomplete_bytes([blobs]) == 8192
        # A directory that does not exist is simply no reading, never a crash.
        assert modeldl._incomplete_bytes([tmp_path / "nope"]) == 0

        watcher = modeldl._CacheProgress(job_id, "x/x")
        watcher._dirs = [blobs]
        watcher.INTERVAL_S = 0.01
        watcher.start()
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            with modeldl._LOCK:
                if modeldl._REGISTRY[job_id]["files"][0]["bytes_done"] == 8192:
                    break
            time.sleep(0.01)
        # Something further along already published: the watcher must not undo it.
        with modeldl._LOCK:
            modeldl._REGISTRY[job_id]["files"][0]["bytes_done"] = 50000
        time.sleep(0.05)
        watcher.stop()
        watcher.join(timeout=2.0)
        with modeldl._LOCK:
            assert modeldl._REGISTRY[job_id]["files"][0]["bytes_done"] == 50000
    finally:
        with modeldl._LOCK:
            modeldl._REGISTRY.pop(job_id, None)


def test_blob_dirs_covers_the_mirror_as_well_as_the_repo():
    """A job may fall back to the public mirror mid-flight and only says so when
    it returns, so both cache folders are watched."""
    from stable_audio_3.model_configs import _DEFAULT_MIRRORS

    official = next(iter(_DEFAULT_MIRRORS))
    mirror = _DEFAULT_MIRRORS[official]
    dirs = [str(d) for d in modeldl._blob_dirs(official)]
    assert len(dirs) == 2
    assert any(official.split("/", 1)[0] in d for d in dirs)
    assert any(mirror.split("/", 1)[0] in d for d in dirs)
    # An unmirrored repo watches only itself, and never raises.
    assert len(modeldl._blob_dirs("some-org/not-mirrored")) == 1


def test_public_job_hides_private_per_file_bookkeeping():
    """The watcher stamps ``_seen_at`` on a file entry to derive a rate. That is
    bookkeeping; the API must not grow a field because of it."""
    job = _fake_job("public-job")
    job["_filenames"] = ["a", "b"]
    job["files"][0]["_seen_at"] = 123.0
    public = modeldl._public_job(job)
    assert "_filenames" not in public
    assert "_seen_at" not in public["files"][0]
    assert public["files"][0]["filename"] == "f"
