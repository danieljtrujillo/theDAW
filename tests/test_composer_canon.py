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


# The probe: seven keys, four modes, eleven intervals (unison through the
# octave, the tenth, the twelfth and the double octave) and two lags, all at
# seed 0. 112 of the 616 found no canon when only the seed asked for was
# searched; with the four derived seeds after it, 91 find none, all at the
# twelfth and the double octave, where the follower sits at or past the
# twelfth the two voices may be apart.
PROBE_KEYS = ("C", "D", "E", "F", "G", "A", "Bb")
PROBE_MODES = ("major", "minor", "dorian", "mixolydian")
PROBE_INTERVALS = (1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15)
PROBE_LAGS = (BAR, BAR // 2)
PROBE_MAX_FAILURES = 91


def _probe_case(case: tuple[str, str, int, int]) -> str | None:
    key, mode, interval, lag = case
    try:
        write_canon(key, mode, interval=interval, lag=lag, bars=8, seed=0)
    except CounterpointError as e:
        return str(e)
    return None


def test_the_canon_probe_finds_a_canon_for_all_but_the_widest_intervals() -> None:
    from concurrent.futures import ProcessPoolExecutor

    cases = [
        (key, mode, interval, lag)
        for key in PROBE_KEYS
        for mode in PROBE_MODES
        for interval in PROBE_INTERVALS
        for lag in PROBE_LAGS
    ]
    with ProcessPoolExecutor(max_workers=8) as pool:
        errors = list(pool.map(_probe_case, cases, chunksize=4))
    failed = [(case, e) for case, e in zip(cases, errors) if e is not None]

    assert len(failed) <= PROBE_MAX_FAILURES, len(failed)
    assert {case[2] for case, _e in failed} <= {12, 15}
    for _case, error in failed:
        assert error.count("try another seed") == 1, error


def test_a_canon_that_fails_at_its_seed_is_found_at_a_derived_seed() -> None:
    """At the twelfth a bar behind in C major, seed 0 finds no canon; one of
    the seeds derived from it does, and the same request answers the same
    canon every time."""
    first = write_canon("C", "major", interval=12, lag=BAR, bars=8, seed=0)
    again = write_canon("C", "major", interval=12, lag=BAR, bars=8, seed=0)

    assert first["seed"] == 0 and first["search_seed"] != 0
    assert first["parts"] == again["parts"]
    assert first["flags"] == [] and first["violations"] == []
