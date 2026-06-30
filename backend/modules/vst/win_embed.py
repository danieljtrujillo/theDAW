"""Windows-only: embed the sidecar's VST3 editor window into a parent HWND.

``pedalboard.show_editor()`` creates a top-level OS window owned by THIS process
and blocks the main thread until it closes. To make it look native inside the
Electron app, a background daemon thread here:

  1. finds that editor window (the only sizeable, visible top-level window owned
     by our PID),
  2. makes the Electron window its OWNER (not parent) so it stays pinned above
     the app and closes/minimizes with it, WITHOUT becoming a WS_CHILD (which
     crashes many plugin UIs),
  3. keeps it at its NATURAL size, positions it over the MIX embed rect offset by
     the frontend's scroll, and CLIPS it (SetWindowRgn) to that rect — so an
     oversized editor is contained + scrollable instead of covering the UI,
  4. re-acquires the window if the plugin recreates it, and publishes the natural
     size so the frontend can size its scroll area.

The frontend writes the viewport + scroll offset (and a ``{"close": true}``) to
``rect_file``; close posts WM_CLOSE so ``show_editor()`` returns and the sidecar
captures state. Everything here is a no-op off win32 and never raises into the
caller — if anything fails the editor simply stays a floating window.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path

# Win32 style / SetWindowPos / message constants.
_WM_CLOSE = 0x0010
_GWLP_HWNDPARENT = -8  # owner (NOT parent): keeps the editor pinned above Electron
_SWP_NOSIZE = 0x0001  # move without resizing — let the plugin keep its natural size
_SWP_NOZORDER = 0x0004
_SWP_SHOWWINDOW = 0x0040


def enable_dpi_awareness() -> None:
    """Make this process per-monitor DPI aware so MoveWindow uses physical px
    (matching the CSS-px * devicePixelRatio rect the frontend reports). Call once
    before the editor window is created. No-op / best-effort off win32."""
    plat: str = sys.platform
    if plat != "win32":
        return
    import ctypes

    try:
        # PER_MONITOR_AWARE_V2 = -4 (Win10 1703+).
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        return
    except Exception:
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PER_MONITOR_DPI_AWARE
    except Exception:
        pass


def _load_rect(rect_file: str | None) -> dict | None:
    if not rect_file:
        return None
    p = Path(rect_file)
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _phys(rect: dict) -> tuple[int, int, int, int]:
    # The frontend already reports PHYSICAL SCREEN px (content-bounds origin +
    # element rect, scaled by devicePixelRatio), so no further scaling here.
    x = int(round(float(rect.get("x", 0))))
    y = int(round(float(rect.get("y", 0))))
    w = max(2, int(round(float(rect.get("w", 320)))))
    h = max(2, int(round(float(rect.get("h", 240)))))
    return x, y, w, h


def _watch(parent_hwnd: int, rect_file: str | None) -> None:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
    LONG_PTR = ctypes.c_ssize_t

    # 64-bit safety: HWNDs are pointer-sized, so every handle in/out MUST be typed
    # as a pointer, or ctypes truncates it to 32 bits and the calls silently fail.
    user32.GetWindowThreadProcessId.argtypes = [
        wintypes.HWND,
        ctypes.POINTER(wintypes.DWORD),
    ]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.IsWindow.argtypes = [wintypes.HWND]
    user32.IsWindow.restype = wintypes.BOOL
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.GetWindowRect.restype = wintypes.BOOL
    user32.SetWindowPos.argtypes = [
        wintypes.HWND,
        wintypes.HWND,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        wintypes.UINT,
    ]
    user32.SetWindowPos.restype = wintypes.BOOL
    # Region clipping: show only the part of the (natural-size) editor window that
    # overlaps the MIX viewport, so an oversized plugin is clipped + scrollable
    # instead of covering the rest of the UI.
    user32.SetWindowRgn.argtypes = [wintypes.HWND, wintypes.HANDLE, wintypes.BOOL]
    user32.SetWindowRgn.restype = ctypes.c_int
    gdi32.CreateRectRgn.argtypes = [
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
    ]
    gdi32.CreateRectRgn.restype = wintypes.HANDLE
    user32.PostMessageW.argtypes = [
        wintypes.HWND,
        wintypes.UINT,
        wintypes.WPARAM,
        wintypes.LPARAM,
    ]
    user32.PostMessageW.restype = wintypes.BOOL
    kernel32.GetConsoleWindow.restype = wintypes.HWND

    # SetWindowLongPtrW exists on 64-bit; fall back to the 32-bit name. Used to set
    # the owner (GWLP_HWNDPARENT).
    set_long = getattr(user32, "SetWindowLongPtrW", None) or user32.SetWindowLongW
    set_long.argtypes = [wintypes.HWND, ctypes.c_int, LONG_PTR]
    set_long.restype = LONG_PTR

    EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [EnumProc, wintypes.LPARAM]
    user32.EnumWindows.restype = wintypes.BOOL

    our_pid = os.getpid()
    console = kernel32.GetConsoleWindow()

    def find_editor(timeout: float = 10.0):
        found: list[int] = []

        def cb(hwnd, _):
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value != our_pid:
                return True
            if console and hwnd == console:
                return True
            if not user32.IsWindowVisible(hwnd):
                return True
            r = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r))
            if (r.right - r.left) < 80 or (r.bottom - r.top) < 80:
                return True
            found.append(hwnd)
            return False  # stop enumerating

        proc = EnumProc(cb)
        deadline = time.time() + timeout
        while time.time() < deadline:
            found.clear()
            user32.EnumWindows(proc, 0)
            if found:
                return found[0]
            time.sleep(0.12)
        return None

    def log(msg: str) -> None:
        print(f"[win_embed] {msg}", file=sys.stderr, flush=True)

    def make_owned(hwnd) -> None:
        # OWNER, not parent: the editor stays a normal top-level window (so the
        # plugin's UI toolkit doesn't crash the way it does when forced into a
        # WS_CHILD of a foreign process), but it's pinned above the Electron
        # window and closes/minimizes with it. Far more robust than SetParent.
        try:
            set_long(hwnd, _GWLP_HWNDPARENT, parent_hwnd)
        except Exception:
            pass

    # Publish the editor's natural (physical px) size so the frontend can size its
    # scroll content — derive the path from the rect file the backend gave us.
    size_file = (
        rect_file[: -len(".rect.json")] + ".size.json"
        if rect_file and rect_file.endswith(".rect.json")
        else None
    )

    def natural_size(hwnd) -> tuple[int, int]:
        r = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(r))
        return (r.right - r.left, r.bottom - r.top)

    try:
        log(f"watcher start; parent_hwnd={parent_hwnd} pid={our_pid}")
        hwnd = find_editor()
        if not hwnd:
            log("editor window not found within timeout; leaving it floating")
            return
        log(f"found editor hwnd={int(hwnd) if hwnd else 0}")
        make_owned(hwnd)
        last_pos: tuple[int, int] | None = None
        last_clip: tuple[int, int, int, int] | None = None
        last_size: tuple[int, int] | None = None

        while True:
            # The editor may close (user) or recreate its window (some plugins do
            # on first paint). Re-acquire instead of dying; exit when truly gone.
            if not user32.IsWindow(hwnd):
                hwnd2 = find_editor(timeout=1.5)
                if not hwnd2:
                    log("editor window gone; watcher exiting")
                    return
                hwnd = hwnd2
                make_owned(hwnd)
                last_pos = last_clip = None
                log(f"re-acquired editor hwnd={int(hwnd)}")

            rect = _load_rect(rect_file)
            if rect:
                if rect.get("close"):
                    log("close requested -> WM_CLOSE")
                    user32.PostMessageW(hwnd, _WM_CLOSE, 0, 0)
                    return

                # The editor keeps its OWN (natural) size; publish it so the
                # frontend's scroll area matches.
                nw, nh = natural_size(hwnd)
                if (nw, nh) != last_size and nw > 0 and nh > 0:
                    if size_file:
                        try:
                            Path(size_file).write_text(
                                json.dumps({"w": nw, "h": nh}), encoding="utf-8"
                            )
                        except Exception:
                            pass
                    last_size = (nw, nh)

                # Viewport (the MIX embed box) in physical screen px, plus the
                # frontend's scroll offset within the (natural-size) content.
                vx, vy, vw, vh = _phys(rect)
                sx = int(round(float(rect.get("sx", 0))))
                sy = int(round(float(rect.get("sy", 0))))

                # Offset the window by the scroll so panning reveals more of it;
                # move only (SWP_NOSIZE) so we never fight the plugin's own size.
                px, py = vx - sx, vy - sy
                if (px, py) != last_pos:
                    user32.SetWindowPos(
                        hwnd,
                        None,
                        px,
                        py,
                        0,
                        0,
                        _SWP_NOSIZE | _SWP_NOZORDER | _SWP_SHOWWINDOW,
                    )
                    last_pos = (px, py)

                # Clip to the viewport (window-local coords); window top-left sits
                # at (px,py), so the viewport starts at (sx,sy) within the window.
                clip = (sx, sy, vw, vh)
                if clip != last_clip and vw > 2 and vh > 2:
                    rgn = gdi32.CreateRectRgn(sx, sy, sx + vw, sy + vh)
                    user32.SetWindowRgn(hwnd, rgn, True)  # window owns rgn now
                    last_clip = clip
            time.sleep(0.1)
    except Exception:
        import traceback

        traceback.print_exc()
        return


def start_embed_watcher(parent_hwnd: int, rect_file: str | None) -> None:
    """Start the reparent/track watcher on a daemon thread. No-op off win32 or
    when no parent HWND is supplied (the editor then stays a floating window)."""
    plat: str = sys.platform
    if plat != "win32" or not parent_hwnd:
        return
    threading.Thread(
        target=_watch, args=(int(parent_hwnd), rect_file), daemon=True
    ).start()
