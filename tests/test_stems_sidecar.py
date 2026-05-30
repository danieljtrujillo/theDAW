"""Unit tests for backend.modules.stems.sidecar.

These tests cover non-network paths: probe shape, config resolution,
``stop()`` idempotency. We do NOT spawn the real sidecar here — that
needs the integration-package and the heavy ML deps to be installed,
which we can't assume in CI. Spawn behavior is exercised manually via
``POST /api/stems/start`` on a developer's machine.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from backend.modules.stems.sidecar import (
    SidecarConfig,
    StemsSidecar,
    probe,
    reset_sidecar,
    resolve_config,
)


def test_resolve_config_defaults_to_sidecar_venv(monkeypatch):
    """Without theDAW_STEMS_PYTHON the config points at the
    integration-package's dedicated .sidecar_venv (auto-created on
    first install). The exe may not exist yet — we only assert the path
    shape so we don't accidentally test against an already-populated
    venv on the dev machine."""
    monkeypatch.delenv("theDAW_STEMS_PYTHON", raising=False)
    monkeypatch.delenv("theDAW_STEMS_PORT", raising=False)
    cfg = resolve_config()
    assert isinstance(cfg, SidecarConfig)
    assert ".sidecar_venv" in str(cfg.python_exe)
    assert cfg.port is None
    assert cfg.auto_port is True


def test_resolve_config_honours_env_overrides(monkeypatch, tmp_path: Path):
    pkg = tmp_path / "pkg"
    pkg.mkdir()
    py = tmp_path / "python.exe"
    py.write_text("")  # presence check only
    monkeypatch.setenv("theDAW_STEMS_PACKAGE", str(pkg))
    monkeypatch.setenv("theDAW_STEMS_PYTHON", str(py))
    monkeypatch.setenv("theDAW_STEMS_PORT", "8123")
    cfg = resolve_config()
    assert cfg.package_path == pkg.resolve()
    assert cfg.python_exe == py.resolve()
    assert cfg.port == 8123
    assert cfg.auto_port is False


def test_probe_reports_missing_package(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("theDAW_STEMS_PACKAGE", str(tmp_path / "nope"))
    monkeypatch.delenv("theDAW_STEMS_PYTHON", raising=False)
    out = probe()
    assert out["package_exists"] is False
    assert out["ok"] is False
    assert "integration-package not found" in out.get("error", "")


def test_probe_against_default_package_path():
    """If the user has the integration-package at the expected location,
    the probe at least reports package_exists True. We don't assert OK
    because that requires demucs installed in the main venv (heavy)."""
    out = probe()
    assert isinstance(out, dict)
    assert "package_exists" in out
    assert "demucs_importable" in out
    # The 'running' field should be populated regardless.
    assert "running" in out


def test_stop_is_safe_without_spawn():
    reset_sidecar()
    sc = StemsSidecar()
    # No process to stop — should not raise.
    sc.stop()
    assert sc.running is False
    assert sc.port is None


@pytest.mark.skipif(
    not os.getenv("STEMS_RUN_LIVE"),
    reason="set STEMS_RUN_LIVE=1 to exercise the real spawn flow",
)
def test_ensure_running_against_real_sidecar():
    """Live smoke test (developer opt-in via STEMS_RUN_LIVE=1).
    Spawns the actual sidecar and waits for /health to return 200."""
    sc = StemsSidecar()
    port = sc.ensure_running()
    try:
        assert port is not None
        assert sc.running is True
    finally:
        sc.stop()
