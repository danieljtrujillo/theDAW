"""Tests for ``scripts/check_vst_host.py``, the advisory live-VST-host status line.

``scripts/`` is not a package (no ``__init__.py``, and other one-off helpers
living there, e.g. ``check_lock.py``, are run as scripts rather than
imported), so the module under test is loaded straight off disk via
``importlib`` instead of a normal ``import`` statement.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import textwrap
from pathlib import Path
from types import ModuleType

_REPO_ROOT = Path(__file__).resolve().parents[1]
_MODULE_PATH = _REPO_ROOT / "scripts" / "check_vst_host.py"


def _load_check_vst_host() -> ModuleType:
    spec = importlib.util.spec_from_file_location("check_vst_host", _MODULE_PATH)
    assert spec is not None and spec.loader is not None, (
        f"could not load {_MODULE_PATH}"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


check_vst_host = _load_check_vst_host()


def test_not_available_off_windows():
    """Non-Windows platforms get the one honest line: this never works there."""
    line = check_vst_host.status_line(platform="linux")
    assert line == "live VST host: not available on this platform"


def test_env_override_is_preferred(tmp_path):
    """``THEDAW_VST_HOST`` beats the built-in default path, same as the backend."""
    tmp_exe = tmp_path / "custom-host.exe"
    tmp_exe.write_bytes(b"")

    resolved = check_vst_host.host_path({"THEDAW_VST_HOST": str(tmp_exe)})

    assert resolved == tmp_exe


def test_default_path_when_env_unset():
    """With no override, the path points at the build output ``build.ps1`` makes."""
    resolved = check_vst_host.host_path({})

    assert resolved.as_posix().endswith("native/vst-host/bin/thedaw-vst-host.exe")


def test_missing_exe_reports_not_built(tmp_path):
    """No binary on disk (the common case pre-build) -> the build hint, not a crash."""
    missing = tmp_path / "does-not-exist.exe"

    line = check_vst_host.status_line(
        {"THEDAW_VST_HOST": str(missing)}, platform="win32"
    )

    assert line.startswith("live VST host: not built -")


def test_ready_line_uses_reported_version(tmp_path, monkeypatch):
    """A host that answers ``--version`` makes the line report exactly that version.

    The fake host has to be a real ``.py`` script (per the ticket) so this
    exercises real process output parsing rather than a mock's canned return
    value. A ``.py`` file cannot be launched directly by Windows'
    ``CreateProcess`` the way an ``.exe`` can (confirmed empirically: it
    raises ``WinError 193``), so ``probe_version`` is swapped for a version
    that runs the same real script through the interpreter -- the seam the
    ticket calls out -- while ``status_line``'s own branching is exercised
    unmodified.
    """
    fake_host = tmp_path / "fake_host.py"
    fake_host.write_text(
        textwrap.dedent(
            """\
            import sys

            print('{"name":"thedaw-vst-host","version":"9.9.9","protocol":1,"vst3":false}')
            sys.exit(0)
            """
        ),
        encoding="utf-8",
    )

    def probe_via_interpreter(exe: Path):
        done = subprocess.run(
            [sys.executable, str(exe), "--version"],
            capture_output=True,
            text=True,
            timeout=5.0,
        )
        if done.returncode != 0:
            return None
        for line in done.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            payload = json.loads(line)
            return payload.get("version")
        return None

    monkeypatch.setattr(check_vst_host, "probe_version", probe_via_interpreter)

    line = check_vst_host.status_line(
        {"THEDAW_VST_HOST": str(fake_host)}, platform="win32"
    )

    assert line == "live VST host: ready (9.9.9)"


def test_probe_version_returns_none_on_failure(tmp_path):
    """A host that exits non-zero on ``--version`` yields ``None``, not an exception.

    ``.bat`` is used (not ``.py``) so this runs directly -- Windows launches
    batch files without an interpreter prefix -- and genuinely exercises the
    non-zero-exit branch rather than the ``OSError`` branch.
    """
    failing_host = tmp_path / "failing-host.bat"
    failing_host.write_text("@exit /b 1\n", encoding="utf-8")

    assert check_vst_host.probe_version(failing_host) is None


def test_main_always_returns_zero(monkeypatch, tmp_path, capsys):
    """``main`` exits 0 and prints exactly one line even with a bogus host path."""
    monkeypatch.setenv("THEDAW_VST_HOST", str(tmp_path / "nope.exe"))

    result = check_vst_host.main([])

    assert result == 0
    out = capsys.readouterr().out
    assert out.count("\n") == 1
    assert out.strip()
