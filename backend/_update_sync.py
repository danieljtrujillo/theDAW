"""Dependency sync that runs BETWEEN backend processes after an in-app update.

`POST /api/updates/apply` pulls the new code and then exits the backend with
sentinel code 89 (`UPDATE_EXIT_CODE`). The process that spawned the backend
(`backend._supervisor`, `backend._devstack`, or the Electron shell through
the supervisor) catches that code, calls `run_dependency_sync` here, and
respawns the backend. Doing it from the outside matters on Windows: `uv sync`
cannot replace a DLL the running interpreter has loaded (torch, numpy), so a
sync from inside the backend fails exactly when a release bumps a wheel.

Stdlib only: this module is imported by the supervisor, which must start even
when the venv is half-built.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Callable

UPDATE_EXIT_CODE = 89

Emit = Callable[[str], None]


def _run(cmd: list[str], cwd: Path, emit: Emit, env: dict[str, str]) -> int:
    emit("$ " + " ".join(cmd) + f"   (in {cwd})")
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(cwd),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            encoding="utf-8",
            errors="replace",
        )
    except OSError as exc:
        emit(f"could not start {cmd[0]}: {exc}")
        return 1
    assert proc.stdout is not None
    for line in proc.stdout:
        emit(line.rstrip())
    return proc.wait()


def run_dependency_sync(repo_root: Path, emit: Emit = print) -> int:
    """`uv sync --group dev`, then `npm install` where package.json changed.

    Mirrors what theDAW.bat / theDAW.sh do on launch, so a pulled release with
    new wheels or npm packages runs on the next spawn. Returns the first
    non-zero exit code, 0 when everything succeeded. Never raises.
    """
    env = os.environ.copy()
    # Keep uv's cache on the repo's drive so wheels hardlink into .venv
    # (same reason theDAW.bat sets it).
    env.setdefault("UV_CACHE_DIR", str(repo_root / ".uv-cache"))
    worst = 0

    uv = shutil.which("uv")
    if uv is None:
        emit("uv is not on PATH; skipping the Python dependency sync")
        worst = 1
    else:
        rc = _run([uv, "sync", "--group", "dev"], repo_root, emit, env)
        if rc != 0 and sys.platform == "linux":
            # pyk4a-bundle only ships a manylinux_2_38 wheel; theDAW.sh and
            # the Dockerfile retry without it on older glibc.
            emit("uv sync failed; retrying without pyk4a-bundle (glibc < 2.38)")
            rc = _run(
                [uv, "sync", "--group", "dev", "--no-install-package", "pyk4a-bundle"],
                repo_root,
                emit,
                env,
            )
        worst = worst or rc

    npm = shutil.which("npm")
    if npm is None:
        emit("npm is not on PATH; skipping the frontend dependency sync")
        return worst or 1
    for rel in ("frontend", "VST-Foundry-UI/VST-UI-FOUNDRY", "vj"):
        d = repo_root / rel
        if not (d / "package.json").is_file():
            continue
        if rel != "frontend" and not (d / "node_modules").is_dir():
            # Optional trees are installed on first use by their own code
            # paths; only refresh ones that already exist.
            continue
        rc = _run([npm, "install", "--no-audit", "--no-fund"], d, emit, env)
        worst = worst or rc
    return worst
