"""Unit tests for the pure window-candidate scoring used by the VST editor embed.

These run everywhere (the module is ctypes-free); they encode the failure modes
the embed actually hit on Windows: a preset-browser popup winning the race
against the editor, a splash window appearing first, and a re-acquire pass
latching onto something other than the editor it already had.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.modules.vst.window_pick import (  # noqa: E402
    WS_EX_TOOLWINDOW,
    WS_POPUP,
    Candidate,
    format_candidate,
    score_candidates,
)

OUR_PID = 4242
CONSOLE = 0x1000


def editor(hwnd: int = 0x2000, w: int = 1200, h: int = 800, **kw) -> Candidate:
    """A plain, unowned, visible top-level window of our process."""
    opts = {
        "pid": OUR_PID,
        "class_name": "JUCE_1.000",
        "title": "Pedalboard",
        "style": 0x16CF0000,  # WS_OVERLAPPEDWINDOW | WS_VISIBLE
        "exstyle": 0,
        "owner": 0,
        "rect": (100, 100, 100 + w, 100 + h),
        "visible": True,
    }
    opts.update(kw)
    return Candidate(hwnd=hwnd, **opts)


def test_single_editor_window_is_chosen():
    win = editor()
    assert score_candidates([win], None, our_pid=OUR_PID) is win


def test_no_candidates_returns_none():
    assert score_candidates([], None, our_pid=OUR_PID) is None


def test_window_of_another_process_is_rejected():
    foreign = editor(hwnd=0x3000, pid=OUR_PID + 1)
    assert score_candidates([foreign], None, our_pid=OUR_PID) is None


def test_console_window_is_rejected():
    console = editor(hwnd=CONSOLE, class_name="ConsoleWindowClass")
    assert (
        score_candidates([console], None, our_pid=OUR_PID, console_hwnd=CONSOLE) is None
    )


def test_invisible_window_is_rejected():
    hidden = editor(visible=False)
    assert score_candidates([hidden], None, our_pid=OUR_PID) is None


def test_window_smaller_than_80x80_is_rejected():
    tiny = editor(w=79, h=600)
    short = editor(hwnd=0x2001, w=600, h=79)
    assert score_candidates([tiny, short], None, our_pid=OUR_PID) is None


def test_exactly_80x80_is_accepted():
    small = editor(w=80, h=80)
    assert score_candidates([small], None, our_pid=OUR_PID) is small


def test_minimized_window_is_rejected():
    """A minimized window's rect is parked at Win32's sentinel (-32000,-32000)
    while IsWindowVisible() still reports True; 160x160 passes MIN_EDGE, so
    only the offscreen check can catch it."""
    minimized = editor(rect=(-32000, -32000, -31840, -31840))
    assert score_candidates([minimized], None, our_pid=OUR_PID) is None


def test_minimized_window_loses_to_the_real_editor():
    """The sentinel is 160x160 = 25,600px2. Give the real editor a SMALLER
    area (150x120 = 18,000px2) so a scorer missing the offscreen check would
    still pick the sentinel by area alone — only the offscreen rejection in
    is_eligible makes this pass."""
    minimized = editor(hwnd=0x9200, rect=(-32000, -32000, -31840, -31840))
    win = editor(hwnd=0x2000, w=150, h=120)
    assert score_candidates([minimized, win], None, our_pid=OUR_PID) is win


def test_a_window_on_a_left_hand_monitor_is_still_eligible():
    """A legitimate secondary monitor to the left of the origin must not be
    mistaken for the minimized sentinel."""
    left_monitor = editor(rect=(-1920, 0, -720, 800))
    assert score_candidates([left_monitor], None, our_pid=OUR_PID) is left_monitor


def test_owned_popup_enumerated_first_loses_to_the_editor():
    """Z-order puts a preset browser on top; the editor must still win."""
    popup = editor(
        hwnd=0x9000,
        class_name="JUCE_1.000",
        title="Preset Browser",
        style=0x96000000,  # WS_POPUP | WS_VISIBLE | WS_CLIPSIBLINGS
        owner=0x2000,
        w=600,
        h=400,
    )
    win = editor(hwnd=0x2000)
    assert score_candidates([popup, win], None, our_pid=OUR_PID) is win


def test_owned_popup_wins_when_it_is_the_only_candidate():
    """Fallback: an owned popup beats picking nothing at all."""
    popup = editor(
        hwnd=0x9000,
        style=WS_POPUP | 0x10000000,
        owner=0x2000,
        w=600,
        h=400,
    )
    assert score_candidates([popup], None, our_pid=OUR_PID) is popup


def test_unowned_popup_is_not_excluded():
    """Some plugin editors are WS_POPUP with no owner — those are real editors."""
    popup = editor(hwnd=0x9000, style=WS_POPUP | 0x10000000, owner=0)
    assert score_candidates([popup], None, our_pid=OUR_PID) is popup


def test_toolwindow_loses_to_the_editor():
    tool = editor(
        hwnd=0x9100,
        title="Tooltip",
        exstyle=WS_EX_TOOLWINDOW,
        w=1600,
        h=1000,  # bigger, so only the toolwindow rule can demote it
    )
    win = editor(hwnd=0x2000)
    assert score_candidates([tool, win], None, our_pid=OUR_PID) is win


def test_splash_then_editor_picks_the_editor_once_it_appears():
    """A splash is all there is at first; the editor wins as soon as it exists."""
    splash = editor(hwnd=0x1500, title="Loading", w=400, h=300)
    assert score_candidates([splash], None, our_pid=OUR_PID) is splash

    win = editor(hwnd=0x2000, w=1200, h=800)
    assert score_candidates([splash, win], None, our_pid=OUR_PID) is win


def test_largest_area_wins_among_equals():
    small = editor(hwnd=0x2000, w=400, h=300)
    big = editor(hwnd=0x2001, w=1200, h=800)
    assert score_candidates([small, big], None, our_pid=OUR_PID) is big
    assert score_candidates([big, small], None, our_pid=OUR_PID) is big


def test_equal_area_tie_breaks_on_the_lowest_hwnd():
    later = editor(hwnd=0x2009)
    earlier = editor(hwnd=0x2001)
    assert score_candidates([later, earlier], None, our_pid=OUR_PID) is earlier
    assert score_candidates([earlier, later], None, our_pid=OUR_PID) is earlier


def test_reacquire_keeps_the_previously_chosen_editor():
    """A popup opened after the editor must not steal the re-acquire."""
    win = editor(hwnd=0x2000, w=600, h=400)
    popup = editor(hwnd=0x9000, title="Preset Browser", w=1600, h=1000)
    assert score_candidates([popup, win], 0x2000, our_pid=OUR_PID) is win


def test_reacquire_falls_through_when_the_previous_window_is_gone():
    win = editor(hwnd=0x2000)
    assert score_candidates([win], 0x7777, our_pid=OUR_PID) is win


def test_reacquire_ignores_a_previous_window_that_is_no_longer_eligible():
    """The old editor is still enumerated but hidden — don't re-latch onto it."""
    stale = editor(hwnd=0x2000, visible=False)
    fresh = editor(hwnd=0x2100)
    assert score_candidates([stale, fresh], 0x2000, our_pid=OUR_PID) is fresh


def test_our_pid_is_optional_when_the_caller_already_filtered():
    win = editor(pid=0)
    assert score_candidates([win], None) is win


def test_non_integer_previous_hwnd_is_rejected():
    with pytest.raises(TypeError):
        score_candidates([editor()], "0x2000")  # type: ignore[arg-type]


def test_negative_dimensions_are_rejected():
    with pytest.raises(ValueError):
        Candidate(
            hwnd=1,
            pid=OUR_PID,
            class_name="",
            title="",
            style=0,
            exstyle=0,
            owner=0,
            rect=(100, 100, 50, 400),
            visible=True,
        )


def test_format_candidate_reports_the_diagnostic_fields():
    line = format_candidate(
        editor(hwnd=0x2000, title="Ozone 11", exstyle=0x00000100), chosen=True
    )
    assert "hwnd=0x2000" in line
    assert "class='JUCE_1.000'" in line
    assert "title='Ozone 11'" in line
    assert "style=0x16CF0000" in line
    assert "exstyle=0x00000100" in line
    assert "owner=0x0" in line
    assert "rect=(100,100,1300,900) 1200x800" in line
    assert "CHOSEN" in line


def test_format_candidate_marks_the_rejects():
    line = format_candidate(editor(visible=False), chosen=False)
    assert "CHOSEN" not in line
    assert "visible=False" in line


def test_format_candidate_marks_offscreen():
    line = format_candidate(editor(rect=(-32000, -32000, -31840, -31840)), chosen=False)
    assert "OFFSCREEN" in line
    assert "CHOSEN" not in line
