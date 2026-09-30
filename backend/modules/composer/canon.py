"""Two-voice canon at any interval and time lag.

``write_canon`` searches for a leader whose follower (the leader transposed by
the interval, diatonically in the key or by the exact interval, and delayed
by the lag) stays clean against it: every slice where the two sound together
passes the counterpoint rules of counterpoint.py (consonance or a treated
dissonance, no parallel or direct perfect intervals, no crossing or overlap)
and both lines pass the melodic rules. The leader's rhythm is seeded, bar by
bar.

The follower imitates strictly until the last two bars. There both voices
leave the canon for the closing cadence: whole notes making the clausula (a
major sixth to the octave or a minor third to the unison, by contrary step,
with the raised leading tone in minor) and the final on the tonic.

A search that finds no canon at the seed asked for goes on to
:data:`RETRY_SEEDS` seeds derived from it before the request is refused.

The search places one leader note at a time; each note also writes its
follower note ``lag`` ticks later, so a slice is checked as soon as both
voices are known there, and the cadence is chosen when the canonic part is
complete. The answer goes through the four-part checker's motion rules too.
"""

from __future__ import annotations

import random
from typing import Any

from .counterpoint import (
    BAR,
    FREE,
    HALF,
    MELODY,
    CounterpointError,
    Ev,
    Image,
    Line,
    Piece,
    Rules,
    Search,
    SearchFailed,
    checker_flags,
    clausula,
    melodic_kind,
    melodic_problems,
    melody_flags,
    parse_scale,
    rank,
)
from .spec import PPQ

__all__ = ["CANON_RHYTHMS", "write_canon"]

_H, _Q = HALF, PPQ
CANON_BARS: dict[str, list[tuple[int, int]]] = {
    "halves": [(0, _H), (_H, _H)],
    "half_quarters": [(0, _H), (_H, _Q), (_H + _Q, _Q)],
    "quarters_half": [(0, _Q), (_Q, _Q), (_H, _H)],
    "quarters": [(0, _Q), (_Q, _Q), (_H, _Q), (_H + _Q, _Q)],
    "whole": [(0, BAR)],
}
CANON_RHYTHMS = {
    "mixed": {"halves": 3, "half_quarters": 3, "quarters_half": 3, "quarters": 1},
    "halves": {"halves": 1},
    "quarters": {"quarters": 1},
}
MAX_BARS = 32
#: Seeds a canon searches after the one asked for before it answers that none
#: was found; each is derived from the asked seed (:func:`_search_seeds`).
RETRY_SEEDS = 4
_SEED_STRIDE = 1_000_003


def _rhythm(bars: int, rhythm: str, rng: random.Random) -> list[str]:
    weights = CANON_RHYTHMS[rhythm]
    names = list(weights)
    out = []
    for b in range(bars):
        if b == 0 and rhythm == "mixed":
            out.append(
                rng.choice(["halves", "half_quarters", "quarters_half", "quarters"])
            )
        else:
            out.append(rng.choices(names, [weights[n] for n in names])[0])
    return out


def write_canon(
    key: str = "C",
    mode: str | None = None,
    *,
    interval: int = 5,
    lag: int = BAR,
    bars: int = 8,
    seed: int = 0,
    transposition: str = "diatonic",
    rhythm: str = "mixed",
    start_tick: int = 0,
    budget: int = 60000,
) -> dict[str, Any]:
    """A two-voice canon. ``interval`` is the follower's generic interval from
    the leader: 1 the unison, 5 a fifth above, -4 a fourth below, 8 an octave
    above. ``lag`` is in ticks, a whole number of quarter notes."""
    scale = parse_scale(key, mode)
    if interval in (0, -1) or abs(interval) > 15:
        raise CounterpointError(
            "interval is a generic interval: 1 (unison), 2 to 15, or -2 to -15"
        )
    if transposition not in ("diatonic", "real"):
        raise CounterpointError("transposition is 'diatonic' or 'real'")
    if rhythm not in CANON_RHYTHMS:
        raise CounterpointError(f"rhythm is one of {', '.join(CANON_RHYTHMS)}")
    if lag <= 0 or lag % PPQ:
        raise CounterpointError("the lag is a whole number of quarter notes, in ticks")
    cad = (bars - 2) * BAR
    if bars > MAX_BARS or lag + PPQ > cad:
        raise CounterpointError(
            f"a canon with a lag of {lag} ticks needs at least "
            f"{-(-(lag + PPQ) // BAR) + 2} bars, and at most {MAX_BARS}"
        )
    start = start_tick - start_tick % BAR
    steps = interval - 1 if interval > 0 else interval + 1
    semis = scale.natural(steps) - scale.natural(0)

    def shift(p: int) -> int:
        return scale.transpose(p, steps) if transposition == "diatonic" else p + semis

    base = 60 + (scale.tonic - 60) % 12  # the tonic from C4 up
    lo, hi = base - 5, base + 11
    rules = Rules(allow_crossing=steps == 0) if steps == 0 else FREE
    tries = 8
    per_try = max(1000, budget // tries)
    last: Exception | None = None
    for search_seed in _search_seeds(seed):
        rng = random.Random(search_seed)
        for _attempt in range(tries):
            pattern = _rhythm(bars - 2, rhythm, rng)
            events = [
                Ev(start + b * BAR + off, ticks)
                for b, name in enumerate(pattern)
                for off, ticks in CANON_BARS[name]
            ]
            leader = Line("leader")
            follower = Line("follower")
            lines = [follower, leader] if steps > 0 else [leader, follower]
            piece = Piece(lines, scale, rules)
            images = [
                Image(piece, leader),
                Image(piece, follower, offset=lag, shift=shift, cutoff=start + cad),
            ]
            pool = scale.pitches(lo, hi, ficta=scale.mode == "minor")
            firsts = [p for p in pool if (p - scale.tonic) % 12 in (0, 7)]

            def cands(k: int, s: Search) -> list[int]:
                if k == 0:
                    return rank(firsts, None, s.rng)
                prev = s.pitches[-1]
                opts = [
                    p for p in pool if melodic_kind(scale, prev, p) in ("step", "leap")
                ]
                return rank(opts, prev, s.rng)

            def leaf(
                s: Search,
                piece: Piece = piece,
                leader: Line = leader,
                follower: Line = follower,
            ) -> bool:
                return _close(piece, leader, follower, scale, start + cad, steps)

            search = Search(events, cands, images, leaf=leaf, budget=per_try, rng=rng)
            try:
                search.run()
            except SearchFailed as e:
                last = e
                continue
            violations = piece.flags() + [
                f for i in range(len(lines)) for f in melody_flags(piece, i)
            ]
            ignore = ("voice_crossing", "voice_overlap") if steps == 0 else ()
            return {
                "key": scale.label,
                "ppq": PPQ,
                "bar_ticks": BAR,
                "interval": interval,
                "transposition": transposition,
                "lag": lag,
                "bars": bars,
                "seed": seed,
                "search_seed": search_seed,
                "canonic_until": start + cad,
                "rhythm": pattern,
                "order": piece.names,
                "parts": {"leader": leader.notes(), "follower": follower.notes()},
                "violations": [f.as_dict() for f in violations],
                "flags": [f.as_dict() for f in checker_flags(lines, ignore=ignore)],
            }
    raise CounterpointError(
        f"no canon was found at seed {seed} or the {RETRY_SEEDS} seeds derived "
        f"from it ({last}); try another seed, lag or interval"
    )


def _search_seeds(seed: int) -> list[int]:
    """The seed asked for, then :data:`RETRY_SEEDS` seeds derived from it.
    The same request searches the same seeds in the same order, so it always
    answers with the same canon."""
    return [seed] + [seed + k * _SEED_STRIDE for k in range(1, RETRY_SEEDS + 1)]


def _close(
    piece: Piece, leader: Line, follower: Line, scale: Any, cad: int, steps: int
) -> bool:
    """Append the closing cadence (the clausula, then the final) to both
    voices; True when one passes every rule."""
    upper, lower = (follower, leader) if steps > 0 else (leader, follower)
    tonic_pcs = scale.tonic

    def near(ln: Line) -> list[int]:
        last = ln.pitches[-1]
        return [p for p in range(last - 12, last + 13) if p % 12 == tonic_pcs]

    options = []
    for fu in near(upper):
        for fl in near(lower):
            if fu - fl not in (0, 12, 24) and not (steps == 0 and fu == fl):
                continue
            for pu in (fu - 2, fu - 1, fu + 1, fu + 2):
                for pl in (fl - 2, fl - 1, fl + 1, fl + 2):
                    if pu < pl or clausula(scale, pu, fu, pl, fl) is not None:
                        continue
                    if not all(
                        (p % 12) in scale.pcs or scale.is_leading_tone(p)
                        for p in (pu, pl)
                    ):
                        continue
                    cost = abs(pu - upper.pitches[-1]) + abs(pl - lower.pitches[-1])
                    options.append((cost, pu, fu, pl, fl))
    options.sort()
    for _cost, pu, fu, pl, fl in options:
        upper.append(pu, cad, cad + BAR)
        upper.append(fu, cad + BAR, cad + 2 * BAR)
        lower.append(pl, cad, cad + BAR)
        lower.append(fl, cad + BAR, cad + 2 * BAR)
        ok = not any(
            melodic_problems(scale, ln, k, MELODY)
            for ln in (upper, lower)
            for k in (len(ln.pitches) - 2, len(ln.pitches) - 1)
        )
        ignore = ("voice_crossing", "voice_overlap") if steps == 0 else ()
        ok = ok and not piece.flags() and not checker_flags(piece.lines, ignore=ignore)
        if ok:
            return True
        for ln in (upper, lower):
            ln.pop()
            ln.pop()
    return False
