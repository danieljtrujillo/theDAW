"""Windows-only: embed the sidecar's VST3 editor window into a parent HWND.

``pedalboard.show_editor()`` creates a top-level OS window owned by THIS process
and blocks the main thread until it closes. To make it look native inside the
Electron app, a background daemon thread here:

  1. finds that editor window — every top-level window of our PID is
     enumerated and scored by :mod:`window_pick`, because a plugin also opens
     preset browsers, splashes and tool windows and the first one EnumWindows
     reaches is routinely not the editor,
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

from backend.modules.vst.embed_close import CloseSequencer, describe
from backend.modules.vst.window_pick import (
    Candidate,
    format_candidate,
    score_candidates,
)

# Win32 style / SetWindowPos / message constants.
_WM_CLOSE = 0x0010
_GWLP_HWNDPARENT = -8  # owner (NOT parent): keeps the editor pinned above Electron
_GWL_STYLE = -16
_GWL_EXSTYLE = -20
_GW_OWNER = 4
_SWP_NOSIZE = 0x0001  # move without resizing — let the plugin keep its natural size
_SWP_NOZORDER = 0x0004
_SWP_SHOWWINDOW = 0x0040


def _apply_dpi_awareness(user32, shcore) -> str:
    """Try PER_MONITOR_AWARE_V2, fall back to PER_MONITOR_DPI_AWARE, and report
    which mode (if any) ended up active.

    ``user32``/``shcore`` are duck-typed DLL handles exposing
    ``SetProcessDpiAwarenessContext``/``SetProcessDpiAwareness`` respectively,
    so this stays testable against fakes instead of real Win32 calls; either
    may be ``None`` (its DLL failed to load), in which case that stage is
    skipped. Returns ``"per-monitor-v2"``, ``"per-monitor"`` or
    ``"unchanged"`` -- never raises.
    """
    import ctypes

    if user32 is not None:
        try:
            # PER_MONITOR_AWARE_V2 = -4 (Win10 1703+). A FALSY return means
            # the call failed -- fall through to the shcore fallback instead
            # of assuming success.
            if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
                return "per-monitor-v2"
        except Exception:
            pass

    if shcore is not None:
        try:
            # PER_MONITOR_DPI_AWARE = 2. S_OK (0) is success; E_ACCESSDENIED
            # (-2147024891) means some other code already set an awareness
            # mode for this process, which counts as success too.
            hresult = shcore.SetProcessDpiAwareness(2)
            if hresult == 0 or hresult == -2147024891:
                return "per-monitor"
        except Exception:
            pass

    return "unchanged"


def enable_dpi_awareness() -> None:
    """Make this process per-monitor DPI aware so MoveWindow uses physical px
    (matching the CSS-px * devicePixelRatio rect the frontend reports). Call once
    before the editor window is created. No-op / best-effort off win32."""
    plat: str = sys.platform
    if plat != "win32":
        return
    import ctypes

    try:
        user32 = ctypes.windll.user32
    except Exception:
        user32 = None
    try:
        shcore = ctypes.windll.shcore
    except Exception:
        shcore = None

    mode = _apply_dpi_awareness(user32, shcore)
    msg = f"[win_embed] dpi awareness: {mode}"
    if mode == "unchanged":
        msg += " -- editor placement may be wrong on a HiDPI display"
    print(msg, file=sys.stderr, flush=True)


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


def run_close(ops, hwnd: int, log, *, sequencer, sleep, clock) -> str:
    """Run a bounded "ask the plugin to close" sequence against ``hwnd``.

    Loops on :meth:`CloseSequencer.step`, driving ``ops`` -- a duck-typed
    object exposing ``post_close(hwnd) -> bool``, ``is_window(hwnd) -> bool``,
    ``unclip(hwnd) -> None`` and ``disown(hwnd) -> None`` -- so this stays
    ctypes-free and unit-testable against a fake.

    Returns ``"closed"`` once the window is gone by itself, or ``"gave_up"``
    once ``sequencer`` times out -- in which case the window is unclipped and
    disowned first, handing it back to the user unpinned and reachable
    instead of leaving a clipped orphan behind.
    """
    start: float | None = None
    while True:
        now = clock()
        elapsed = 0.0 if start is None else now - start
        action = sequencer.step(elapsed, ops.is_window(hwnd))

        if action == "post":
            ops.post_close(hwnd)
            if start is None:
                start = now
        elif action == "wait":
            sleep(0.1)
        elif action == "give_up":
            ops.unclip(hwnd)
            ops.disown(hwnd)

        log(describe(action, elapsed, sequencer.posts))

        if action == "closed":
            return "closed"
        if action == "give_up":
            return "gave_up"


def _watch(parent_hwnd: int, rect_file: str | None, plugin_name: str | None) -> None:
    import ctypes
    from ctypes import wintypes
    from types import SimpleNamespace

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
    # Only SetWindowRgn SUCCESS transfers ownership of the region to the window;
    # a failed call leaves us holding a GDI object that nothing would ever free.
    gdi32.DeleteObject.argtypes = [wintypes.HANDLE]
    gdi32.DeleteObject.restype = wintypes.BOOL
    # Window identity, for scoring + for the diagnostic log.
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.restype = ctypes.c_int
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetWindowTextW.restype = ctypes.c_int
    user32.SetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPCWSTR]
    user32.SetWindowTextW.restype = wintypes.BOOL
    user32.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
    user32.GetWindow.restype = wintypes.HWND
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
    get_long = getattr(user32, "GetWindowLongPtrW", None) or user32.GetWindowLongW
    get_long.argtypes = [wintypes.HWND, ctypes.c_int]
    get_long.restype = LONG_PTR

    EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [EnumProc, wintypes.LPARAM]
    user32.EnumWindows.restype = wintypes.BOOL

    our_pid = os.getpid()
    console_hwnd = int(kernel32.GetConsoleWindow() or 0)

    def log(msg: str) -> None:
        print(f"[win_embed] {msg}", file=sys.stderr, flush=True)

    def snapshot(hwnd: int) -> Candidate | None:
        """Read one window's identity/geometry. None when it is unreadable."""
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        r = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
            return None
        if r.right < r.left or r.bottom < r.top:
            return None  # minimized/degenerate; nothing to embed
        cls_buf = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls_buf, 256)
        title_buf = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, title_buf, 512)
        return Candidate(
            hwnd=hwnd,
            pid=int(pid.value),
            class_name=cls_buf.value,
            title=title_buf.value,
            # LONG_PTR is signed and the style bits are not: mask to the 32 bits
            # winuser.h documents, or WS_POPUP arrives as a negative number.
            style=int(get_long(hwnd, _GWL_STYLE)) & 0xFFFFFFFF,
            exstyle=int(get_long(hwnd, _GWL_EXSTYLE)) & 0xFFFFFFFF,
            owner=int(user32.GetWindow(hwnd, _GW_OWNER) or 0),
            rect=(r.left, r.top, r.right, r.bottom),
            visible=bool(user32.IsWindowVisible(hwnd)),
        )

    def enumerate_candidates() -> list[Candidate]:
        """EVERY top-level window of this process, not just the first match."""
        cands: list[Candidate] = []

        def cb(hwnd, _):
            handle = int(hwnd) if hwnd else 0
            if handle:
                try:
                    cand = snapshot(handle)
                except Exception as e:  # a window can die mid-enumeration
                    log(f"could not inspect hwnd=0x{handle:X}: {e}")
                    cand = None
                if cand is not None and cand.pid == our_pid:
                    cands.append(cand)
            return True  # keep going — the editor is rarely the first hit

        user32.EnumWindows(EnumProc(cb), 0)
        return cands

    def find_editor(timeout: float = 10.0, previous: int | None = None):
        """Score every window of our PID; log the whole pass either way."""
        deadline = time.time() + timeout
        attempt = 0
        while True:
            attempt += 1
            cands = enumerate_candidates()
            chosen = score_candidates(
                cands, previous, our_pid=our_pid, console_hwnd=console_hwnd
            )
            prev_note = f" previous=0x{previous:X}" if previous else ""
            log(
                f"enum pass {attempt}: {len(cands)} window(s) of pid {our_pid}"
                f"{prev_note} console=0x{console_hwnd:X}"
            )
            for cand in cands:
                picked = chosen is not None and cand.hwnd == chosen.hwnd
                log("  " + format_candidate(cand, picked))
            if chosen is not None:
                return chosen.hwnd
            if time.time() >= deadline:
                return None
            time.sleep(0.12)

    def set_title(hwnd) -> None:
        """Replace pedalboard's own window title with the plugin's real name."""
        if not plugin_name:
            return
        try:
            ok = user32.SetWindowTextW(hwnd, plugin_name)
            log(f"SetWindowTextW(0x{int(hwnd):X}, {plugin_name!r}) -> {bool(ok)}")
        except Exception as e:
            log(f"SetWindowTextW failed: {e}")

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

    # A small ops object over the raw ctypes bindings above, so the bounded
    # close policy (run_close) and the exit-time restore below stay
    # ctypes-free and unit-testable against a fake.
    def post_close(hwnd) -> bool:
        return bool(user32.PostMessageW(hwnd, _WM_CLOSE, 0, 0))

    def is_window(hwnd) -> bool:
        return bool(user32.IsWindow(hwnd))

    def unclip(hwnd) -> None:
        user32.SetWindowRgn(hwnd, None, True)

    def disown(hwnd) -> None:
        set_long(hwnd, _GWLP_HWNDPARENT, 0)

    ops = SimpleNamespace(
        post_close=post_close, is_window=is_window, unclip=unclip, disown=disown
    )

    hwnd = 0
    try:
        log(
            f"watcher start; parent_hwnd={parent_hwnd} pid={our_pid} "
            f"plugin_name={plugin_name!r}"
        )
        hwnd = find_editor()
        if not hwnd:
            log("editor window not found within timeout; leaving it floating")
            return
        log(f"found editor hwnd=0x{int(hwnd):X}")
        make_owned(hwnd)
        set_title(hwnd)
        last_pos: tuple[int, int] | None = None
        last_clip: tuple[int, int, int, int] | None = None
        last_size: tuple[int, int] | None = None

        while True:
            # The editor may close (user) or recreate its window (some plugins do
            # on first paint). Re-acquire instead of dying; exit when truly gone.
            if not user32.IsWindow(hwnd):
                # Pass the hwnd we had: if the plugin kept it (it was merely
                # hidden for a beat) we keep the editor instead of latching onto
                # whichever popup happens to be on top right now.
                hwnd2 = find_editor(timeout=1.5, previous=int(hwnd))
                if not hwnd2:
                    log("editor window gone; watcher exiting")
                    return
                hwnd = hwnd2
                make_owned(hwnd)
                set_title(hwnd)
                last_pos = last_clip = None
                log(f"re-acquired editor hwnd=0x{int(hwnd):X}")

            rect = _load_rect(rect_file)
            if rect:
                if rect.get("close"):
                    log("close requested -> WM_CLOSE")
                    run_close(
                        ops,
                        hwnd,
                        log,
                        sequencer=CloseSequencer(),
                        sleep=time.sleep,
                        clock=time.time,
                    )
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
                    ok = user32.SetWindowPos(
                        hwnd,
                        None,
                        px,
                        py,
                        0,
                        0,
                        _SWP_NOSIZE | _SWP_NOZORDER | _SWP_SHOWWINDOW,
                    )
                    log(
                        f"SetWindowPos hwnd=0x{int(hwnd):X} -> ({px},{py}) "
                        f"viewport=({vx},{vy},{vw}x{vh}) scroll=({sx},{sy}) "
                        f"natural={natural_size(hwnd)} ok={bool(ok)}"
                    )
                    last_pos = (px, py)

                # Clip to the viewport (window-local coords); window top-left sits
                # at (px,py), so the viewport starts at (sx,sy) within the window.
                clip = (sx, sy, vw, vh)
                if clip != last_clip and vw > 2 and vh > 2:
                    rgn = gdi32.CreateRectRgn(sx, sy, sx + vw, sy + vh)
                    if not rgn:
                        # NULL means GDI refused (handle exhaustion): clipping is
                        # off, so say so rather than let the editor silently
                        # cover the UI.
                        log(
                            f"CreateRectRgn({sx},{sy},{sx + vw},{sy + vh}) returned "
                            f"NULL (last_error={ctypes.get_last_error()}); "
                            "editor left UNCLIPPED"
                        )
                    else:
                        res = user32.SetWindowRgn(hwnd, rgn, True)
                        log(
                            f"SetWindowRgn hwnd=0x{int(hwnd):X} window-local "
                            f"({sx},{sy},{sx + vw},{sy + vh}) -> {res}"
                        )
                        if not res:
                            # Ownership only transfers on success.
                            gdi32.DeleteObject(rgn)
                    last_clip = clip
            time.sleep(0.1)
    except Exception:
        import traceback

        traceback.print_exc()
        return
    finally:
        if hwnd and user32.IsWindow(hwnd):
            log(f"watcher exiting with hwnd=0x{int(hwnd):X} still alive; restoring it")
            try:
                ops.unclip(hwnd)
            except Exception:
                pass
            try:
                ops.disown(hwnd)
            except Exception:
                pass


def start_embed_watcher(
    parent_hwnd: int, rect_file: str | None, plugin_name: str | None = None
) -> None:
    """Start the reparent/track watcher on a daemon thread. No-op off win32 or
    when no parent HWND is supplied (the editor then stays a floating window).

    ``plugin_name`` is the plugin's own name; when given it replaces the native
    window title (otherwise the strip reads "Pedalboard", the title the host
    library sets)."""
    plat: str = sys.platform
    if plat != "win32" or not parent_hwnd:
        return
    threading.Thread(
        target=_watch,
        args=(int(parent_hwnd), rect_file, plugin_name or None),
        daemon=True,
    ).start()
