"""Pure candidate scoring for "which top-level window is the plugin's editor?".

``pedalboard.show_editor()`` gives us no handle: the editor window has to be
found by enumerating the process's own windows. The original rule — first
visible window of our PID that is at least 80x80 — is a race. A plugin like
Ozone also opens a preset browser, a splash and assorted tool windows in the
same process, and whichever one EnumWindows reaches first (z-order, so the
newest popup is FIRST) won. The embed then pinned and clipped the wrong window
while the real editor stayed floating somewhere off-screen.

This module holds the decision, deliberately free of ctypes so it can be unit
tested on any platform: :func:`score_candidates` takes an already-enumerated
list of :class:`Candidate` snapshots and returns the one to embed, or ``None``.
``win_embed`` owns everything that touches Win32.

Units: ``rect`` is ``(left, top, right, bottom)`` in PHYSICAL screen pixels, the
same coordinate space ``GetWindowRect`` reports and the frontend sends.
"""

from __future__ import annotations

from dataclasses import dataclass

# Win32 window style bits used by the rules below (winuser.h).
WS_POPUP = 0x80000000
WS_EX_TOOLWINDOW = 0x00000080

# A window smaller than this in either axis is a tooltip, a drag proxy or a
# message-only leftover — never a plugin editor.
MIN_EDGE = 80

# Win32 parks a MINIMIZED window's rect at (-32000, -32000, -31840, -31840) —
# 160x160, well past MIN_EDGE — while IsWindowVisible() still reports TRUE. A
# coordinate this negative can only be that sentinel; no real monitor layout
# reaches it.
OFFSCREEN_SENTINEL = -30000


@dataclass(frozen=True)
class Candidate:
    """One enumerated top-level window, as a plain snapshot.

    hwnd/pid/owner are the raw integer handles; ``style``/``exstyle`` the raw
    ``GWL_STYLE``/``GWL_EXSTYLE`` bits; ``rect`` is ``(left, top, right,
    bottom)`` in physical screen px.
    """

    hwnd: int
    pid: int
    class_name: str
    title: str
    style: int
    exstyle: int
    owner: int
    rect: tuple[int, int, int, int]
    visible: bool

    def __post_init__(self) -> None:
        if len(self.rect) != 4:
            raise ValueError(
                f"rect must be (left, top, right, bottom), got {self.rect!r}"
            )
        if self.width < 0 or self.height < 0:
            raise ValueError(f"rect has negative extent: {self.rect!r}")

    @property
    def width(self) -> int:
        """Window width in physical screen px."""
        return self.rect[2] - self.rect[0]

    @property
    def height(self) -> int:
        """Window height in physical screen px."""
        return self.rect[3] - self.rect[1]

    @property
    def area(self) -> int:
        """Window area in physical screen px²."""
        return self.width * self.height


def is_toolwindow(cand: Candidate) -> bool:
    """WS_EX_TOOLWINDOW — a palette/tooltip frame, never the main editor."""
    return bool(cand.exstyle & WS_EX_TOOLWINDOW)


def is_owned_popup(cand: Candidate) -> bool:
    """An owned WS_POPUP: a preset browser / modal / menu of another window.

    Unowned popups are NOT demoted — plenty of plugin editors are WS_POPUP with
    no owner, and the editor is exactly the window others are owned BY.
    """
    return cand.owner != 0 and bool(cand.style & WS_POPUP)


def is_offscreen(cand: Candidate) -> bool:
    """A minimized window still reports IsWindowVisible()==TRUE, and its rect
    is parked at the sentinel; a legitimate secondary monitor never reaches
    -30000."""
    return cand.rect[0] <= OFFSCREEN_SENTINEL or cand.rect[1] <= OFFSCREEN_SENTINEL


def is_eligible(
    cand: Candidate, our_pid: int | None = None, console_hwnd: int = 0
) -> bool:
    """Could this window be our plugin's editor at all?

    Ours, visible, big enough, not parked at the minimized sentinel, and not
    the console we were launched from. ``our_pid=None`` skips the process
    check (the caller already filtered).
    """
    if cand.hwnd == 0:
        return False
    if our_pid is not None and cand.pid != our_pid:
        return False
    if console_hwnd and cand.hwnd == console_hwnd:
        return False
    if not cand.visible:
        return False
    if is_offscreen(cand):
        return False
    return cand.width >= MIN_EDGE and cand.height >= MIN_EDGE


def score_candidates(
    cands: list[Candidate],
    previous_hwnd: int | None,
    *,
    our_pid: int | None = None,
    console_hwnd: int = 0,
) -> Candidate | None:
    """Pick the window to embed, or ``None`` when nothing qualifies.

    Rules, in order:

    1. Drop anything not eligible (see :func:`is_eligible`).
    2. If ``previous_hwnd`` is still eligible, keep it. Re-acquisition must not
       hand the embed to a popup that opened after the editor.
    3. Prefer unowned, non-toolwindow windows. Owned popups and tool windows
       are only considered when nothing else is left, so a plugin whose editor
       genuinely is one still gets embedded instead of floating.
    4. Largest area wins; ties break on the lowest hwnd, so repeated passes
       over an unchanged window set always return the same window.

    Raises TypeError if ``previous_hwnd`` is neither ``None`` nor an int.
    """
    if previous_hwnd is not None and not isinstance(previous_hwnd, int):
        raise TypeError(f"previous_hwnd must be an int or None, got {previous_hwnd!r}")

    eligible = [c for c in cands if is_eligible(c, our_pid, console_hwnd)]
    if not eligible:
        return None

    if previous_hwnd:
        for cand in eligible:
            if cand.hwnd == previous_hwnd:
                return cand

    pool = [c for c in eligible if not is_toolwindow(c) and not is_owned_popup(c)]
    if not pool:
        pool = eligible
    return max(pool, key=lambda c: (c.area, -c.hwnd))


def format_candidate(cand: Candidate, chosen: bool) -> str:
    """One log line per enumerated window — the whole reason a pick is arguable.

    Style bits are hex because that is how they are documented in winuser.h and
    how anyone reading the log will look them up.
    """
    left, top, right, bottom = cand.rect
    flags = []
    if is_offscreen(cand):
        flags.append("OFFSCREEN")
    if is_toolwindow(cand):
        flags.append("TOOLWINDOW")
    if is_owned_popup(cand):
        flags.append("OWNED_POPUP")
    if chosen:
        flags.append("CHOSEN")
    suffix = f" [{' '.join(flags)}]" if flags else ""
    return (
        f"hwnd=0x{cand.hwnd:X} pid={cand.pid} class={cand.class_name!r} "
        f"title={cand.title!r} style=0x{cand.style:08X} exstyle=0x{cand.exstyle:08X} "
        f"owner=0x{cand.owner:X} rect=({left},{top},{right},{bottom}) "
        f"{cand.width}x{cand.height} visible={cand.visible}{suffix}"
    )
