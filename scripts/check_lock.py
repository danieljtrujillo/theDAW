"""Prove uv.lock installs on every platform theDAW ships to, before it is pushed.

`uv lock` records whatever wheels the index listed at that minute. On
2026-09-10 onnxruntime-gpu 1.30.0 was locked twenty minutes before its Linux
x86_64 wheels reached PyPI; the lock carried only the aarch64 and Windows
wheels, and the first Linux CI run after the merge failed with "no wheel for
the current platform". This is the check that would have caught it on the
developer's machine: `uv lock --check`, then a cross-platform dry-run sync per
target with exactly the flags .github/workflows/test.yml installs with.

Run from the repo root with any Python (it only shells out to uv):

    python scripts/check_lock.py

The pre-commit hook (.githooks/pre-commit) runs it whenever pyproject.toml or
uv.lock is staged; the `lock` job in test.yml runs it on every pull request.
When it fails, fix pyproject.toml / uv.lock (see tool.uv.required-environments)
and never the CI.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# ubuntu-latest, the runner test.yml uses (glibc 2.39), and the Windows desktop
# build. Keep the glibc tag at the runner's: a wheel tagged above it fails there.
TARGETS = ("x86_64-manylinux_2_39", "windows")

SYNC = (
    "uv",
    "sync",
    "--frozen",
    "--dry-run",
    "--group",
    "dev",
    "--no-install-package",
    "pyk4a-bundle",
    "--no-progress",
)


def run(cmd: tuple[str, ...]) -> int:
    print("$", " ".join(cmd), flush=True)
    return subprocess.run(cmd, cwd=ROOT).returncode


def main() -> int:
    if run(("uv", "lock", "--check", "--no-progress")):
        print(
            "uv.lock is out of date with pyproject.toml: run `uv lock` and commit both."
        )
        return 1
    for target in TARGETS:
        if run((*SYNC, "--python-platform", target)):
            print(
                f"uv.lock cannot be installed on {target}. Fix pyproject.toml / uv.lock "
                "(tool.uv.required-environments names the platforms), not the CI."
            )
            return 1
    print(f"uv.lock installs on every target: {', '.join(TARGETS)}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
