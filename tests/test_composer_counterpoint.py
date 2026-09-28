"""Species counterpoint and invertible counterpoint: every species writes a
clean line over three cantus firmi, the fourth species shows prepared
suspensions, each species check flags a broken line, and a pair made for the
twelfth inverts cleanly while a pair of sixths does not.

Pure computation on music21's voice-leading checker; no model, no GPU.
"""

from __future__ import annotations

import pytest

from backend.modules.composer.counterpoint import (
    BAR,
    HALF,
    CounterpointError,
    check_species,
    consonant,
    invertible_check,
    parse_scale,
    species_counterpoint,
)
from backend.modules.composer.spec import CANTUS_FIRMI

Q = 960
CANTI = ("fux_dorian", "fux_aeolian", "fux_ionian")


def _write(name: str, species: int, above: bool = True, **kw) -> dict:
    cf = CANTUS_FIRMI[name]
    return species_counterpoint(
        cf["notes"], key=cf["key"], species=species, above=above, **kw
    )


def _cf_notes(name: str) -> list[dict]:
    return [
        {"note": p, "tick": i * BAR, "ticks": BAR}
        for i, p in enumerate(CANTUS_FIRMI[name]["notes"])
    ]


def _rules(flags) -> set[str]:
    return {f.rule for f in flags}


def _cf_at(cf: list[dict], t: int) -> int:
    return next(c["note"] for c in cf if c["tick"] <= t < c["tick"] + c["ticks"])


@pytest.mark.parametrize("above", [True, False])
@pytest.mark.parametrize("species", [1, 2, 3, 4, 5])
@pytest.mark.parametrize("name", CANTI)
def test_every_species_writes_a_clean_line(
    name: str, species: int, above: bool
) -> None:
    r = _write(name, species, above)
    assert r["violations"] == []
    assert r["flags"] == []  # the four-part checker's motion rules
    cp = r["parts"]["counterpoint"]
    cf = r["parts"]["cantus"]
    assert cp[-1]["tick"] == cf[-1]["tick"] and cp[-1]["ticks"] == BAR
    # the same rules, run over the written line from outside
    assert (
        check_species(
            cf, cp, species=species, key=CANTUS_FIRMI[name]["key"], above=above
        )
        == []
    )
    for n in cp:
        c = _cf_at(cf, n["tick"])
        assert n["note"] >= c if above else n["note"] <= c


def test_species_rhythms_are_the_species() -> None:
    durations = {1: {BAR}, 2: {HALF, BAR}, 3: {Q, BAR}, 4: {HALF, BAR}}
    for species, allowed in durations.items():
        cp = _write("fux_dorian", species)["parts"]["counterpoint"]
        assert {n["ticks"] for n in cp} <= allowed
    fourth = _write("fux_dorian", 4)["parts"]["counterpoint"]
    assert fourth[0]["tick"] == HALF  # after a half-note rest
    florid = _write("fux_dorian", 5)["parts"]["counterpoint"]
    assert len({n["ticks"] for n in florid}) >= 3


@pytest.mark.parametrize("name", CANTI)
def test_fourth_species_holds_prepared_suspensions(name: str) -> None:
    scale = parse_scale(CANTUS_FIRMI[name]["key"])
    for above in (True, False):
        r = _write(name, 4, above)
        cp, cf = r["parts"]["counterpoint"], r["parts"]["cantus"]
        assert r["suspensions"], f"no suspension {name} {'above' if above else 'below'}"
        for s in r["suspensions"]:
            t = s["tick"]
            assert t % BAR == 0
            k = next(
                i for i, n in enumerate(cp) if n["tick"] < t < n["tick"] + n["ticks"]
            )
            held = cp[k]
            # prepared: tied over from the half bar before, consonant there
            assert held["tick"] == t - HALF
            assert consonant(scale, held["note"], _cf_at(cf, held["tick"]))
            # dissonant on the downbeat, then down a step to a consonance
            assert not consonant(scale, held["note"], _cf_at(cf, t))
            nxt = cp[k + 1]
            assert nxt["tick"] == t + HALF and 1 <= held["note"] - nxt["note"] <= 2
            assert consonant(scale, nxt["note"], _cf_at(cf, nxt["tick"]))
            assert s["figure"] in (("7-6", "4-3", "9-8") if above else ("2-3",))


def _at(cp: list[dict], tick: int) -> int:
    return next(i for i, n in enumerate(cp) if n["tick"] == tick)


def test_first_species_check_flags_parallel_fifths_and_dissonance() -> None:
    cf = _cf_notes("fux_dorian")
    # D F E D G F A G F E D with fifths over the first three notes, and a
    # ninth over G.
    pitches = [69, 72, 71, 69, 69, 72, 76, 74, 72, 73, 74]
    cp = [{"note": p, "tick": i * BAR, "ticks": BAR} for i, p in enumerate(pitches)]
    rules = _rules(check_species(cf, cp, species=1, key="D dorian"))
    assert {"parallel_fifths", "dissonance"} <= rules


def test_second_species_check_flags_a_dissonance_reached_by_leap() -> None:
    r = _write("fux_dorian", 2)
    cp = [dict(n) for n in r["parts"]["counterpoint"]]
    cf = r["parts"]["cantus"]
    t = 3 * BAR + HALF  # the weak half of bar 3, over D
    k = _at(cp, t)
    c, prev = _cf_at(cf, t), cp[k - 1]["note"]
    # a ninth, eleventh or seventh over the cantus, leapt into
    cp[k]["note"] = next(d for d in (c + 14, c + 17, c + 10) if abs(d - prev) > 2)
    flags = check_species(cf, cp, species=2, key="D dorian")
    assert any(f.rule == "dissonance" and f.tick == t for f in flags)


def test_third_species_check_flags_a_downbeat_dissonance() -> None:
    r = _write("fux_aeolian", 3)
    cp = [dict(n) for n in r["parts"]["counterpoint"]]
    cf = r["parts"]["cantus"]
    t = 4 * BAR
    cp[_at(cp, t)]["note"] = _cf_at(cf, t) + 14  # a ninth on the downbeat
    flags = check_species(cf, cp, species=3, key="A aeolian")
    assert any(f.rule == "dissonance" and f.tick == t for f in flags)


def test_fourth_species_check_flags_a_suspension_that_rises() -> None:
    r = _write("fux_ionian", 4)
    cp = [dict(n) for n in r["parts"]["counterpoint"]]
    cf = r["parts"]["cantus"]
    t = r["suspensions"][0]["tick"]
    k = next(i for i, n in enumerate(cp) if n["tick"] < t < n["tick"] + n["ticks"])
    cp[k + 1]["note"] = cp[k]["note"] + 2  # resolve up instead of down
    flags = check_species(cf, cp, species=4, key="C ionian")
    assert any(f.rule == "dissonance" and f.tick == t for f in flags)
    # a line that attacks every downbeat instead of tying over breaks the
    # species' rhythm
    straight = [{"note": n["note"] + 12, "tick": n["tick"], "ticks": BAR} for n in cf]
    assert "rhythm" in _rules(check_species(cf, straight, species=4, key="C ionian"))


def test_fifth_species_check_flags_a_leaping_eighth() -> None:
    eighths: list[int] = []
    for seed in range(8):
        r = _write("fux_dorian", 5, seed=seed)
        cp = [dict(n) for n in r["parts"]["counterpoint"]]
        eighths = [i for i, n in enumerate(cp) if n["ticks"] == Q // 2]
        if eighths:
            break
    assert eighths, "no florid line with eighths in eight seeds"
    k = eighths[1]
    cp[k]["note"] = cp[k - 1]["note"] + 5
    flags = check_species(r["parts"]["cantus"], cp, species=5, key="D dorian")
    assert "eighths" in _rules(flags)


def test_species_refuses_a_cantus_it_cannot_close() -> None:
    with pytest.raises(CounterpointError):
        species_counterpoint(
            [62, 65, 64, 69, 62], key="D dorian", species=1
        )  # leaps to the end
    with pytest.raises(CounterpointError):
        species_counterpoint([62, 64, 62], key="D dorian", species=1)  # too short
    with pytest.raises(CounterpointError):
        species_counterpoint([62, 65, 64, 62], key="D dorian", species=6)


def test_a_pair_made_for_the_twelfth_inverts_and_a_pair_of_sixths_does_not() -> None:
    r = _write("fux_dorian", 1, above=False, invertible=12)
    assert r["violations"] == [] and r["flags"] == []
    assert r["inversion"]["ok"] is True
    check = invertible_check(
        r["parts"]["cantus"], r["parts"]["counterpoint"], 12, key="D dorian"
    )
    assert check["ok"] is True
    assert (
        check["original"]["violations"] == [] and check["inverted"]["violations"] == []
    )

    # Parallel sixths are clean as written and become sevenths at the twelfth.
    lower = [
        {"note": p, "tick": i * BAR, "ticks": BAR}
        for i, p in enumerate([60, 62, 64, 60])
    ]
    upper = [
        {"note": p, "tick": i * BAR, "ticks": BAR}
        for i, p in enumerate([69, 71, 72, 69])
    ]
    bad = invertible_check(upper, lower, 12, key="C")
    assert bad["ok"] is False
    assert bad["original"]["violations"] == []
    assert "dissonance" in {f["rule"] for f in bad["inverted"]["violations"]}
    # the same pair inverts at the octave, where sixths become thirds
    assert invertible_check(upper, lower, 8, key="C")["ok"] is True


def test_invertible_species_lines_pass_their_own_inversion() -> None:
    for species in (1, 3, 5):
        r = _write("fux_ionian", species, above=True, invertible=8)
        assert r["inversion"]["ok"] is True, species
