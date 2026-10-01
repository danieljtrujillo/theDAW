"""Wall-clock bounds for tests, one rule for every machine.

A bound written on a developer machine is too tight for a hosted CI runner:
GitHub's runners have two vCPUs shared with whatever the test itself starts,
and one scheduler pause exceeds a sub-second bound. Every wall-clock assert
takes its bound from ``prompt_seconds`` so the author's local value stays in
the test and the runner gets its own.

A test whose only claim is a wall-clock bound also carries
``@pytest.mark.timing``: the gating ``pytest`` job runs ``-m "not timing"``
and the ``pytest-timing`` job reports those tests without blocking a merge.
"""

from __future__ import annotations

import os

#: How much slower a hosted runner is allowed to be when a test names no
#: CI bound of its own.
CI_FACTOR = 2.5


def on_ci() -> bool:
    """True on a GitHub Actions runner."""
    return os.environ.get("GITHUB_ACTIONS") == "true"


def prompt_seconds(local: float, ci: float | None = None) -> float:
    """The bound for this machine: ``local`` seconds on a developer machine,
    ``ci`` seconds on a GitHub runner (2.5 x ``local`` when not given)."""
    if on_ci():
        return float(ci) if ci is not None else float(local) * CI_FACTOR
    return float(local)
