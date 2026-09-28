"""Canon: the follower is the leader moved by the interval and delayed by the
lag until the closing cadence, and the two voices pass the counterpoint rules
and the four-part checker with nothing flagged.

Pure computation; no model, no GPU.
"""

from __future__ import annotations

import pytest

from backend.modules.composer.canon import write_canon
from backend.modules.composer.counterpoint import (
    BAR,
    CounterpointError,
    Line,
    checker_flags,
    parse_scale,
)

Q = 960


def test_a_canon_at_the_fifth_a_bar_behind_has_no_checker_flags() -> None:
    r = write_canon("C", interval=5, lag=BAR, bars=8, seed=0)
    assert r["flags"] == []
    assert r["violations"] == []
    leader, follower = r["parts"]["leader"], r["parts"]["follower"]
    # the checker again, from outside, top voice first
    lines = [Line("follower", follower), Line("leader", leader)]
    assert checker_flags(lines) == []
    # strict imitation a diatonic fifth up, one bar later, until the cadence
    scale = parse_scale("C")
    canonic = [n for n in follower if n["tick"] < r["canonic_until"]]
    assert canonic and canonic[0]["tick"] == BAR
    for f in canonic[:-1]:
        src = next(n for n in leader if n["tick"] == f["tick"] - BAR)
        assert f["note"] == scale.transpose(src["note"], 4)
        assert f["ticks"] == src["ticks"]
    # both voices close on the tonic, the follower above
    assert leader[-1]["note"] % 12 == 0 and follower[-1]["note"] % 12 == 0
    assert follower[-1]["note"] >= leader[-1]["note"]
    assert r["order"] == ["follower", "leader"]


@pytest.mark.parametrize(
    ("key", "interval", "lag"),
    [("a", 8, 2 * Q), ("D dorian", -4, BAR), ("G", 3, 2 * Q), ("c", -5, Q)],
)
def test_canons_at_other_intervals_and_lags_are_clean(
    key: str, interval: int, lag: int
) -> None:
    r = write_canon(key, interval=interval, lag=lag, bars=8, seed=1)
    assert r["flags"] == [] and r["violations"] == []
    first_follow = r["parts"]["follower"][0]["tick"]
    assert first_follow == lag


def test_a_real_canon_moves_by_the_exact_interval() -> None:
    r = write_canon("C", interval=5, lag=BAR, bars=6, seed=2, transposition="real")
    assert r["flags"] == [] and r["violations"] == []
    leader = {n["tick"]: n["note"] for n in r["parts"]["leader"]}
    for f in r["parts"]["follower"]:
        if f["tick"] < r["canonic_until"] - BAR:
            assert f["note"] == leader[f["tick"] - BAR] + 7


def test_canon_refuses_what_it_cannot_write() -> None:
    with pytest.raises(CounterpointError):
        write_canon("C", interval=0)
    with pytest.raises(CounterpointError):
        write_canon("C", interval=5, lag=3 * BAR, bars=4)  # no room before the cadence
    with pytest.raises(CounterpointError):
        write_canon("C", interval=5, lag=Q + 1)
