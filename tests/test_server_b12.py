"""Batch-12 T01 fixes in ``backend.server``.

- BE-004: the module-enabled toggle reads/writes ``module.json`` as UTF-8.
- MAKE seed: ``-1`` ("pick one for me") is resolved to a concrete 32-bit seed
  before generation, and that seed is reported back in the job's result JSON
  and saved metadata (CONTRACT for T17: item/metadata key ``seed``).
- A01: ``GET /api/build-info`` reports commit/built/version, resolved once at
  startup and tolerant of a missing git or pyproject.toml.

``backend.server`` is cheap to import (no torch, no model load — see
test_server_inpaint_regions.py); every test here stays on that cheap path.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
import torch
from fastapi.testclient import TestClient

import backend.modules.library.router as library_router
import backend.server as server
from backend.core.idle import get_idle_manager
from backend.server import app


# --- BE-004: module.json read/write must be UTF-8 both ways -----------------


@pytest.fixture
def modules_client(tmp_path: Path, monkeypatch) -> TestClient:
    """Point the module-toggle route at a private ``modules/`` tree.

    ``set_module_enabled`` resolves its directory from ``Path(__file__)`` at
    call time, so pointing the module's own ``__file__`` at a file inside
    ``tmp_path`` redirects it without touching the real modules directory.
    """
    fake_server_file = tmp_path / "backend" / "server.py"
    fake_server_file.parent.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(server, "__file__", str(fake_server_file))
    return TestClient(app)


def test_module_toggle_round_trips_bytes_exactly(
    modules_client: TestClient, tmp_path: Path
):
    """A module.json written as raw UTF-8 bytes (LF line endings, one literal
    ``\\uXXXX`` escape, non-ASCII elsewhere) survives a PATCH byte-for-byte,
    aside from the one ``enabled`` literal:

    - ``write_text`` on Windows would translate the fixture's ``\\n`` to
      ``\\r\\n`` on the way out unless newline translation is disabled — this
      is checked with ``read_bytes()``, which a text-mode round-trip
      comparison would hide.
    - A full ``json.dumps(..., ensure_ascii=False)`` re-serialization would
      decode the fixture's literal ``\\u00e9`` escape into an actual ``é``
      byte, changing content the toggle never touched.
    """
    module_dir = tmp_path / "backend" / "modules" / "cafe"
    module_dir.mkdir(parents=True)
    config_path = module_dir / "module.json"
    original_bytes = (
        b"{\n"
        b'  "name": "caf\\u00e9",\n'
        b'  "label": "Caf\xc3\xa9 \xe2\x80\x94 R\xc3\xa9sum\xc3\xa9 \xe2\x98\x95",\n'
        b'  "enabled": false\n'
        b"}\n"
    )
    config_path.write_bytes(original_bytes)

    resp = modules_client.patch("/api/modules/cafe/enabled", json={"enabled": True})

    assert resp.status_code == 200
    body = resp.json()
    assert body["enabled"] is True
    assert body["name"] == "café"
    assert body["label"] == "Café — Résumé ☕"

    expected_bytes = original_bytes.replace(b'"enabled": false', b'"enabled": true')
    assert config_path.read_bytes() == expected_bytes


def test_module_toggle_rejects_unknown_module(modules_client: TestClient):
    resp = modules_client.patch(
        "/api/modules/does-not-exist/enabled", json={"enabled": True}
    )
    assert resp.status_code == 404


@pytest.mark.parametrize(
    "real_module_json",
    sorted(
        (Path(__file__).parent.parent / "backend" / "modules").glob("*/module.json")
    ),
    ids=lambda p: p.parent.name,
)
def test_module_toggle_round_trips_every_real_module_json(
    modules_client: TestClient, tmp_path: Path, real_module_json: Path
):
    """Every real ``backend/modules/*/module.json``, toggled off then back on
    against a copy, ends up byte-identical to the original — proving the
    in-place edit (or its json.dumps fallback) never corrupts a real file's
    encoding, escapes, or line endings, whichever `enabled` value it starts
    from."""
    module_name = real_module_json.parent.name
    module_dir = tmp_path / "backend" / "modules" / module_name
    module_dir.mkdir(parents=True)
    config_path = module_dir / "module.json"
    original_bytes = real_module_json.read_bytes()
    config_path.write_bytes(original_bytes)
    original_config = json.loads(original_bytes.decode("utf-8"))
    started_enabled = bool(original_config.get("enabled", True))

    resp_off = modules_client.patch(
        f"/api/modules/{module_name}/enabled",
        json={"enabled": not started_enabled},
    )
    assert resp_off.status_code == 200

    resp_on = modules_client.patch(
        f"/api/modules/{module_name}/enabled",
        json={"enabled": started_enabled},
    )
    assert resp_on.status_code == 200

    assert config_path.read_bytes() == original_bytes


# --- MAKE seed: -1 resolves to a concrete seed and is reported back --------


def test_resolve_seed_passes_through_non_negative_one():
    assert server._resolve_seed(7) == 7
    assert server._resolve_seed(0) == 0


def test_resolve_seed_resolves_negative_one_within_the_ui_slider_range():
    """AdvancedGenPanel.tsx's Seed slider caps at 2147483647 (2**31 - 1); a
    resolved random seed above that would be silently clamped or rejected by
    the UI on "reuse seed"."""
    seen = {server._resolve_seed(-1) for _ in range(50)}
    assert all(isinstance(v, int) and 0 <= v <= 2147483647 for v in seen)
    assert all(v < 2**31 for v in seen)
    # 50 draws from a 31-bit range being all identical would be a broken RNG.
    assert len(seen) > 1


class _FakePipeline:
    """Minimal stand-in for StableAudioPipeline.generate (see
    test_generate_job_cancel.py's ``_FakePipeline``): returns silence and
    ignores every kwarg, including ``seed`` — the pipeline layer already
    resolves -1 internally (stable_audio_3/pipeline.py) but never reports
    what it picked back to the caller, which is exactly the bug T01 fixes at
    the server layer, upstream of this call."""

    model_config = {"sample_rate": 44100}

    def generate(self, callback=None, **_kwargs):
        if callback:
            callback({"i": 0})
        return torch.zeros(1, 2, 4410)


@pytest.fixture
def jobs(monkeypatch, tmp_path):
    """Same private-job-table fixture as test_generate_job_cancel.py, plus
    capturing every ``metadata`` dict passed to the artifact save so the
    resolved seed can be asserted there too."""
    table: dict[str, dict] = {}
    monkeypatch.setattr(server, "JOBS", table)
    monkeypatch.setattr(server, "_JOB_CANCEL_EVENTS", {})
    monkeypatch.setattr(server, "_generation_job_lock", asyncio.Lock())
    saved_metadata: list[dict] = []

    def record_save(**kwargs):
        saved_metadata.append(kwargs["metadata"])
        return {}

    class _NoLibrary:
        db = None

        def get_entry(self, _entry_id):
            return None

    monkeypatch.setattr(server, "_save_generation_artifacts_sync", record_save)
    monkeypatch.setattr(server, "_generate_spectrograms", lambda *_a: {})
    monkeypatch.setattr(server, "_get_generation_artifacts_root", lambda: tmp_path)
    monkeypatch.setattr(library_router, "get_store", lambda: _NoLibrary())
    mgr = get_idle_manager()
    for tag in list(mgr.active_tags()):
        mgr.release(tag)
    yield table, saved_metadata
    for tag in list(mgr.active_tags()):
        mgr.release(tag)


def _queue(table: dict, job_id: str) -> None:
    table[job_id] = {
        "id": job_id,
        "kind": "generate",
        "status": "queued",
        "progress": {"step": 0, "steps": 1},
    }


def test_run_generate_job_reports_the_resolved_seed(jobs):
    """What POST /api/generate-jobs does before handing off to the job: -1 is
    resolved once, up front. The job must never see -1 downstream, and must
    put the resolved value in both the result item and the saved metadata."""
    table, saved_metadata = jobs
    _queue(table, "j1")
    resolved = server._resolve_seed(-1)
    assert resolved != -1

    asyncio.run(
        server._run_generate_job(
            "j1",
            _FakePipeline(),
            {"prompt": "a test tone", "seed": resolved},
            1,
            "wav",
            "16",
            "verbose",
            "",
            [],
            [],
            None,
        )
    )

    assert table["j1"]["status"] == "completed"
    item = table["j1"]["result"]["item"]
    assert item["seed"] == resolved
    assert item["seed"] != -1
    assert saved_metadata[0]["seed"] == resolved


def test_run_generate_job_batch_derives_each_seed_from_the_resolved_base(jobs):
    """Batch_size > 1 with an already-resolved base seed: each take's seed is
    base + index (existing behaviour), and every item reports its own."""
    table, saved_metadata = jobs
    _queue(table, "j2")
    resolved = server._resolve_seed(-1)

    asyncio.run(
        server._run_generate_job(
            "j2",
            _FakePipeline(),
            {"prompt": "a test tone", "seed": resolved},
            3,
            "wav",
            "16",
            "verbose",
            "",
            [],
            [],
            None,
        )
    )

    items = table["j2"]["result"]["items"]
    assert [it["seed"] for it in items] == [resolved, resolved + 1, resolved + 2]
    assert [m["seed"] for m in saved_metadata] == [resolved, resolved + 1, resolved + 2]


@pytest.fixture
def generate_jobs_ok(monkeypatch):
    """Patch POST /api/generate-jobs's pre-dispatch work to succeed on a real
    TestClient call, without loading a model (same shape as
    test_idle_gate_release.py's ``generate_ok`` fixture)."""
    monkeypatch.setattr(server, "_ensure_gpu_clear_of_magenta", lambda: None)
    monkeypatch.setattr(server, "_get_or_load_generation_pipeline", lambda _n: object())
    monkeypatch.setattr(server, "_compute_request_sample_size", lambda *_a: 441000)

    async def no_loras(_form, _job_id):
        return [], [], None

    monkeypatch.setattr(server, "_persist_lora_uploads", no_loras)
    mgr = get_idle_manager()
    for tag in list(mgr.active_tags()):
        mgr.release(tag)
    yield monkeypatch
    for tag in list(mgr.active_tags()):
        mgr.release(tag)


def test_generate_jobs_route_resolves_default_seed_before_dispatch(generate_jobs_ok):
    """A real TestClient POST with the default (unset) seed: the handler must
    resolve -1 to a concrete seed itself, before ``_run_generate_job`` ever
    sees it. ``_run_generate_job`` is replaced with a plain function (not a
    coroutine function) so the capture below runs synchronously during the
    route's own `asyncio.create_task(...)` call, independent of when the
    background task itself would be scheduled.

    The response also carries that resolved seed at ``job.seed`` — the field
    ``generateStore.extractResolvedSeed`` reads for the UI's "Seed used" —
    so the "reuse seed" flow works without waiting for a job poll."""
    captured: list[dict] = []

    def fake_run_generate_job(_job_id, _pipeline, base_args, *_rest):
        captured.append(base_args)
        return asyncio.sleep(0)

    generate_jobs_ok.setattr(server, "_run_generate_job", fake_run_generate_job)

    resp = TestClient(app).post("/api/generate-jobs", data={"prompt": "a test tone"})

    assert resp.status_code == 200
    assert len(captured) == 1
    assert captured[0]["seed"] != -1
    assert captured[0]["seed"] >= 0
    assert resp.json()["job"]["seed"] == captured[0]["seed"]


def test_generate_jobs_response_reports_the_batch_base_seed(generate_jobs_ok):
    """For batch_size > 1, take i uses base + i (see
    test_run_generate_job_batch_derives_each_seed_from_the_resolved_base
    above); the immediate POST response reports the base, not a per-take
    value — there is no single "the" seed for a batch response."""
    captured: list[dict] = []

    def fake_run_generate_job(_job_id, _pipeline, base_args, *_rest):
        captured.append(base_args)
        return asyncio.sleep(0)

    generate_jobs_ok.setattr(server, "_run_generate_job", fake_run_generate_job)

    resp = TestClient(app).post(
        "/api/generate-jobs",
        data={"prompt": "a test tone", "seed": 100, "batch_size": 3},
    )

    assert resp.status_code == 200
    assert resp.json()["job"]["seed"] == 100
    assert captured[0]["seed"] == 100


def test_generate_route_resolves_default_seed_without_loading_a_model(monkeypatch):
    """POST /api/generate with the default seed, using a fake pipeline (same
    shape as ``_FakePipeline`` above) so no real model load is needed: the
    seed reaching ``pipeline.generate`` and the ``X-Seed`` response header
    must both be a resolved, non-negative concrete value."""
    captured: list[dict] = []

    class _CapturingFakePipeline:
        model_config = {"sample_rate": 44100}

        def generate(self, **kwargs):
            captured.append(kwargs)
            return torch.zeros(1, 2, 4410)

    monkeypatch.setattr(server, "_ensure_gpu_clear_of_magenta", lambda: None)
    monkeypatch.setattr(
        server, "_get_or_load_generation_pipeline", lambda _n: _CapturingFakePipeline()
    )
    monkeypatch.setattr(server, "_compute_request_sample_size", lambda *_a: 4410)

    resp = TestClient(app).post("/api/generate", data={"prompt": "a test tone"})

    assert resp.status_code == 200
    assert len(captured) == 1
    assert captured[0]["seed"] != -1
    assert captured[0]["seed"] >= 0
    assert int(resp.headers["X-Seed"]) == captured[0]["seed"]


# --- explicit seed < -1 is rejected, not silently miscomputed ---------------


def test_generate_jobs_rejects_seed_below_negative_one(generate_jobs_ok):
    """base + i (batch takes) can land on -1 — the sentinel for "pick one for
    me" — when the caller passes a seed below -1 (e.g. base -2, batch 3).
    Reject it outright instead of ever producing a take seed of -1, and
    reject it before any model load or idle-gate hold: a 400 for a bad seed
    must not wake a parked model or leave the gate held."""
    calls: list[str | None] = []
    generate_jobs_ok.setattr(
        server,
        "_get_or_load_generation_pipeline",
        lambda n: calls.append(n) or object(),
    )
    mgr = get_idle_manager()

    resp = TestClient(app).post(
        "/api/generate-jobs",
        data={"prompt": "a test tone", "seed": -2, "batch_size": 3},
    )

    assert resp.status_code == 400
    assert calls == []
    assert mgr.active_tags() == []


def test_generate_rejects_seed_below_negative_one(monkeypatch):
    calls: list[str | None] = []

    class _CapturingFakePipeline:
        model_config = {"sample_rate": 44100}

        def generate(self, **kwargs):
            return torch.zeros(1, 2, 4410)

    monkeypatch.setattr(server, "_ensure_gpu_clear_of_magenta", lambda: None)
    monkeypatch.setattr(
        server,
        "_get_or_load_generation_pipeline",
        lambda n: calls.append(n) or _CapturingFakePipeline(),
    )
    monkeypatch.setattr(server, "_compute_request_sample_size", lambda *_a: 4410)
    mgr = get_idle_manager()
    for tag in list(mgr.active_tags()):
        mgr.release(tag)

    resp = TestClient(app).post(
        "/api/generate", data={"prompt": "a test tone", "seed": -2}
    )

    assert resp.status_code == 400
    assert calls == []
    assert mgr.active_tags() == []


# --- A01: GET /api/build-info -----------------------------------------------


def test_build_info_route_returns_the_resolved_state(monkeypatch):
    monkeypatch.setitem(server._BUILD_INFO, "commit", "deadbeef")
    monkeypatch.setitem(server._BUILD_INFO, "built", "2026-09-19T00:00:00Z")
    monkeypatch.setitem(server._BUILD_INFO, "version", "0.2.0")

    resp = TestClient(app).get("/api/build-info")

    assert resp.status_code == 200
    assert resp.json() == {
        "commit": "deadbeef",
        "built": "2026-09-19T00:00:00Z",
        "version": "0.2.0",
    }


def test_build_info_defaults_are_null_before_startup_runs():
    """A bare TestClient (this module's convention) never runs the lifespan,
    so the route must still answer instead of raising."""
    resp = TestClient(app).get("/api/build-info")
    assert resp.status_code == 200
    assert set(resp.json()) == {"commit", "built", "version"}


def test_resolve_build_commit_tolerates_a_non_repo(tmp_path: Path):
    assert server._resolve_build_commit(tmp_path) is None


def test_resolve_build_commit_tolerates_missing_git(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(
        server.subprocess,
        "run",
        lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError("no git")),
    )
    assert server._resolve_build_commit(tmp_path) is None


def test_resolve_build_commit_returns_the_sha_on_success(tmp_path: Path, monkeypatch):
    class _Result:
        returncode = 0
        stdout = "abc123def456\n"

    monkeypatch.setattr(server.subprocess, "run", lambda *a, **k: _Result())
    assert server._resolve_build_commit(tmp_path) == "abc123def456"


def test_read_pyproject_version_reads_the_project_table(tmp_path: Path):
    (tmp_path / "pyproject.toml").write_text(
        '[project]\nname = "x"\nversion = "1.2.3"\n', encoding="utf-8"
    )
    assert server._read_pyproject_version(tmp_path) == "1.2.3"


def test_read_pyproject_version_none_when_missing(tmp_path: Path):
    assert server._read_pyproject_version(tmp_path) is None


def test_read_pyproject_version_none_when_malformed(tmp_path: Path):
    (tmp_path / "pyproject.toml").write_text("not = [valid toml", encoding="utf-8")
    assert server._read_pyproject_version(tmp_path) is None
