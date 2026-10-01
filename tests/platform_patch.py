"""Give ONE module a fake ``sys.platform``.

``monkeypatch.setattr(module.sys, "platform", ...)`` patches the one global
``sys`` module, so ``subprocess``, ``pathlib`` and every other backend module
report the fake platform for the whole test: an unmocked call then builds a
``cmd.exe`` command on Linux, or reads a ``subprocess`` flag that exists on
Windows only. ``patch_platform`` swaps the module's own ``sys`` name for a
proxy instead, so only the module under test takes the other platform's branch.
"""

from __future__ import annotations

import sys
from types import ModuleType
from typing import Any

import pytest


class _SysProxy:
    """``sys`` with a different ``platform``; every other attribute is the
    real one."""

    def __init__(self, platform: str) -> None:
        self.platform = platform

    def __getattr__(self, name: str) -> Any:
        return getattr(sys, name)


def patch_platform(
    monkeypatch: pytest.MonkeyPatch, module: ModuleType, platform: str
) -> None:
    """Make ``module.sys.platform`` read ``platform`` for this test only."""
    monkeypatch.setattr(module, "sys", _SysProxy(platform))
