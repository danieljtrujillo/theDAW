"""Unit tests for ``win_embed._apply_dpi_awareness``: the DPI-awareness
decision that used to ignore ``SetProcessDpiAwarenessContext``'s own return
value and report success unconditionally.

These exercise ``_apply_dpi_awareness`` purely through hand-written fake DLL
objects -- no ``ctypes.windll``, no real Win32 calls -- so they run on every
platform even though ``win_embed`` itself is Windows-only.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.modules.vst.win_embed import _apply_dpi_awareness  # noqa: E402

_E_ACCESSDENIED = -2147024891


class FakeUser32:
    """Records each call and replays a scripted BOOL return or exception."""

    def __init__(self, result=None, raises=None) -> None:
        self._result = result
        self._raises = raises
        self.calls: list[object] = []

    def SetProcessDpiAwarenessContext(self, value):
        self.calls.append(value)
        if self._raises is not None:
            raise self._raises
        return self._result


class FakeShcore:
    """Records each call and replays a scripted HRESULT or exception."""

    def __init__(self, result=None, raises=None) -> None:
        self._result = result
        self._raises = raises
        self.calls: list[int] = []

    def SetProcessDpiAwareness(self, value):
        self.calls.append(value)
        if self._raises is not None:
            raise self._raises
        return self._result


def test_v2_success_is_reported():
    user32 = FakeUser32(result=1)
    shcore = FakeShcore(result=0)

    mode = _apply_dpi_awareness(user32, shcore)

    assert mode == "per-monitor-v2"
    assert shcore.calls == []  # fallback must not be attempted on success


def test_v2_returning_false_falls_back_to_shcore():
    user32 = FakeUser32(result=0)  # FALSY BOOL, not an exception
    shcore = FakeShcore(result=0)

    mode = _apply_dpi_awareness(user32, shcore)

    assert shcore.calls == [2]  # PER_MONITOR_DPI_AWARE
    assert mode == "per-monitor"


def test_v2_raising_falls_back_to_shcore():
    user32 = FakeUser32(raises=OSError("no such DLL export"))
    shcore = FakeShcore(result=0)

    mode = _apply_dpi_awareness(user32, shcore)

    assert shcore.calls == [2]
    assert mode == "per-monitor"


def test_access_denied_from_shcore_counts_as_already_aware():
    user32 = FakeUser32(result=0)
    shcore = FakeShcore(result=_E_ACCESSDENIED)

    mode = _apply_dpi_awareness(user32, shcore)

    assert mode == "per-monitor"


def test_both_paths_failing_report_unchanged():
    user32 = FakeUser32(result=0)
    shcore = FakeShcore(result=1)  # some other HRESULT, e.g. E_INVALIDARG

    mode = _apply_dpi_awareness(user32, shcore)

    assert mode == "unchanged"


def test_missing_dlls_report_unchanged():
    mode = _apply_dpi_awareness(None, None)

    assert mode == "unchanged"
