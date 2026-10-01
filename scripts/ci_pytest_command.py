#!/usr/bin/env python
"""Print a command of the CI ``pytest`` job, read out of the workflow file.

scripts/ci_linux.sh runs the same pytest command the pull-request runner runs.
The command is parsed from .github/workflows/test.yml at run time, so the local
Linux run and CI cannot drift: there is one copy, the workflow's.

    python scripts/ci_pytest_command.py                 # the pytest step's command
    python scripts/ci_pytest_command.py --env           # the job's env, as export lines
    python scripts/ci_pytest_command.py --step "Install dependencies"
    python scripts/ci_pytest_command.py --workflow path/to/test.yml

Plain text parsing, standard library only: the WSL mirror runs this before its
venv exists.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _job_lines(text: str, job: str) -> list[str]:
    """The lines of one job under ``jobs:``."""
    lines = text.splitlines()
    start = None
    for index, line in enumerate(lines):
        if re.match(rf"^  {re.escape(job)}:\s*$", line):
            start = index + 1
            break
    if start is None:
        raise SystemExit(f"ci_pytest_command: no job {job!r} in the workflow")
    out: list[str] = []
    for line in lines[start:]:
        if line.strip() and not line.lstrip().startswith("#") and _indent(line) <= 2:
            break
        out.append(line)
    return out


def job_env(text: str, job: str) -> dict[str, str]:
    """The job-level ``env:`` mapping."""
    lines = _job_lines(text, job)
    env: dict[str, str] = {}
    for index, line in enumerate(lines):
        if re.match(r"^    env:\s*$", line):
            for entry in lines[index + 1 :]:
                if not entry.strip() or entry.lstrip().startswith("#"):
                    continue
                if _indent(entry) <= 4:
                    break
                match = re.match(r"^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$", entry)
                if match:
                    env[match.group(1)] = match.group(2).strip("\"'")
            break
    return env


def step_command(text: str, job: str, step: str) -> str:
    """The ``run:`` of one named step, as a single line."""
    lines = _job_lines(text, job)
    for index, line in enumerate(lines):
        if not re.match(rf"^\s*- name:\s*{re.escape(step)}\s*$", line):
            continue
        for offset, entry in enumerate(lines[index + 1 :], start=index + 1):
            if re.match(r"^\s*- ", entry):
                break
            match = re.match(r"^(\s*)run:\s*(.*)$", entry)
            if not match:
                continue
            inline = match.group(2).strip()
            if inline and inline not in ("|", ">", "|-", ">-"):
                return inline
            base = len(match.group(1))
            block: list[str] = []
            for body in lines[offset + 1 :]:
                if body.strip() and _indent(body) <= base:
                    break
                block.append(body.strip())
            joined = " ".join(part.rstrip("\\").strip() for part in block if part)
            return re.sub(r"\s+", " ", joined).strip()
    raise SystemExit(f"ci_pytest_command: no step {step!r} in job {job!r}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--workflow", default=".github/workflows/test.yml")
    parser.add_argument("--job", default="pytest")
    parser.add_argument("--step", default="pytest")
    parser.add_argument("--env", action="store_true", help="print export lines")
    args = parser.parse_args(argv)
    path = Path(args.workflow)
    if not path.is_file():
        print(f"ci_pytest_command: no workflow at {path}", file=sys.stderr)
        return 2
    text = path.read_text(encoding="utf-8")
    if args.env:
        for name, value in job_env(text, args.job).items():
            print(f"export {name}='{value}'")
        return 0
    print(step_command(text, args.job, args.step))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
