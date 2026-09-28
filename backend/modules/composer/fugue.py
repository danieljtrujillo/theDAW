"""Fugue exposition: subject, answer, countersubject, free voices, episodes
and a stretto search, for two to four voices.

``build_fugue`` takes a subject (``{note, tick, ticks}``) or writes one
(``generate_subject``: two bars from the tonic or the dominant), and lays out
an exposition in 4/4:

* **Entries.** The voices enter one after another, a whole number of bars
  apart (the subject's last note is held to the bar line). Three voices enter
  alto, soprano, bass; four alto, soprano, tenor, bass; two soprano, bass;
  other orders are tried when these give no clean exposition. Entries
  alternate subject (tonic) and answer (dominant), each moved by octaves into
  its voice's range and next to the entry before it.
* **Answer.** ``answer_for`` makes a real answer (the subject a fifth up) or a
  tonal one. The answer is tonal when the subject's head (its opening notes
  on the tonic and dominant only) touches the dominant: in that head the
  dominant is answered by the tonic (up a fourth) and the tonic by the
  dominant, and the rest is a real answer a fifth up.
* **Countersubject.** The voice that just had the subject goes on with a
  countersubject against the answer, searched note by note (quarters, or
  halves where the other voices move) so that it is clean against the answer
  as written, against the answer with the two voices inverted at the octave
  (invertible counterpoint, so it can go above or below), and against every
  later entry it accompanies, moved to that entry's key and voice. When no
  such line exists it accompanies fewer entries, starts after a quarter rest,
  and only as a last resort gives up the inversion (``countersubject_inversion``
  says whether it inverts).
* **Free voices.** Voices past their countersubject go on in free
  counterpoint against everything sounding; a voice with no clean line rests
  (``resting``).
* **Episodes.** After the exposition, each episode sequences a fragment of
  the subject (its head, or for a second episode its second bar): the top (or
  bass) voice plays the fragment, then again a step lower (or higher), three
  or four times. The voice next to it and the far outer voice are searched
  once for the first statement and repeated along the same sequence, so the
  whole sequence is checked, joins included; a voice whose statement does
  not repeat cleanly plays free counterpoint instead (``sequential`` lists
  the voices that follow the sequence).
* **Stretto.** ``find_strettos`` tries every entry lag (in quarter notes)
  and interval (octave, fifth, fourth, unison... above and below) of a second
  subject entry overlapping the first, and lists those where the two stay
  clean.

Every search runs the counterpoint rules of counterpoint.py, with the
common-practice rule for perfect intervals (no hidden fifth or octave between
the outer voices with a leap on top); every segment ends on a settled note;
the assembled exposition is checked slice by slice and through the four-part
checker (ranges included), and the build tries again with fresh jitter when
a join fails.
"""

from __future__ import annotations

import random
from typing import Any, Callable, Sequence

from .counterpoint import (
    BAR,
    EIGHTH,
    FREE,
    HALF,
    MELODY,
    CounterpointError,
    Ev,
    Image,
    Line,
    Piece,
    Rules,
    Scale,
    Search,
    SearchFailed,
    checker_flags,
    invertible_check,
    melodic_kind,
    melodic_problems,
    parse_scale,
    rank,
)
from .spec import FUGUE_VOICES, PPQ

__all__ = ["answer_for", "build_fugue", "find_strettos", "generate_subject"]

# Fugal voice ranges (a little wider than the planner's SATB): two voices
# share the middle, so the pair can invert at the octave.
FUGUE_RANGES: dict[int, dict[str, tuple[int, int]]] = {
    2: {"soprano": (57, 81), "bass": (41, 67)},
    3: {"soprano": (60, 81), "alto": (53, 74), "bass": (40, 62)},
    4: {"soprano": (60, 81), "alto": (53, 74), "tenor": (48, 69), "bass": (40, 62)},
}
# Entry orders by voice index (0 is the top voice), the usual first.
ENTRY_ORDERS: dict[int, list[tuple[int, ...]]] = {
    2: [(0, 1), (1, 0)],
    3: [(1, 0, 2), (0, 1, 2), (2, 1, 0), (1, 2, 0)],
    4: [(1, 0, 2, 3), (2, 1, 0, 3), (0, 1, 2, 3), (3, 2, 1, 0)],
}
STRETTO_INTERVALS = (8, -8, 5, -5, 4, -4, 1, 3, -3, 6, -6)
# Outer voices of three or four may lie far apart; perfect intervals follow
# the common-practice rule (no hidden fifth or octave with a leap on top).
FUGUE_RULES = Rules(max_distance=36, strict_direct=False)
MAX_SUBJECT_TICKS = 4 * BAR

_Q, _H = PPQ, HALF
SUBJECT_RHYTHMS: list[list[int]] = [
    [_Q, _Q, _Q, _Q, _Q, _Q, _H],
    [_H, _Q, _Q, _Q, _Q, _H],
    [_Q, EIGHTH, EIGHTH, _Q, _Q, _Q, _Q, _H],
    [_H, _Q, _Q, _Q, EIGHTH, EIGHTH, _H],
    [_Q, _Q, _H, _Q, _Q, _H],
]


def _notes(notes: Sequence[Any]) -> Line:
    ln = Line("subject", notes)
    if not ln.pitches:
        raise CounterpointError("the subject has no notes")
    t0 = ln.starts[0]
    ln.starts = [s - t0 for s in ln.starts]
    ln.ends = [e - t0 for e in ln.ends]
    for k in range(1, len(ln.starts)):
        if ln.starts[k] < ln.ends[k - 1]:
            raise CounterpointError(
                "the subject is one line: its notes may not overlap"
            )
    return ln


# ---------------------------------------------------------------------------
# subject and answer
# ---------------------------------------------------------------------------


def generate_subject(
    scale: Scale, *, seed: int = 0, start: str = "tonic", budget: int = 20000
) -> Line:
    """A two-bar subject that opens on the tonic or the dominant, has one
    climax, passes the melodic rules and ends on the tonic or third."""
    if start not in ("tonic", "dominant"):
        raise CounterpointError("a subject starts on the 'tonic' or the 'dominant'")
    rng = random.Random(seed)
    base = 55 + (scale.tonic - 55) % 12  # the tonic from G3 up
    pool = scale.pitches(base - 5, base + 12, ficta=scale.mode == "minor")
    first_pc = (scale.tonic + (7 if start == "dominant" else 0)) % 12
    for _attempt in range(8):
        durs = rng.choice(SUBJECT_RHYTHMS)
        events, t = [], 0
        for d in durs:
            events.append(Ev(t, d))
            t += d
        line = Line("subject")
        piece = Piece([line], scale)

        def cands(k: int, s: Search) -> list[int]:
            if k == 0:
                return [
                    p for p in pool if p % 12 == first_pc and base - 5 <= p <= base + 7
                ]
            prev = s.pitches[-1]
            opts = [p for p in pool if melodic_kind(scale, prev, p) in ("step", "leap")]
            if k == len(events) - 1:
                opts = [p for p in opts if scale.degree(p) % 7 in (0, 2)]
            return rank(
                opts, prev, s.rng, lambda p: -2.0 if abs(p - prev) in (5, 7) else 0.0
            )

        def leaf(s: Search, line: Line = line) -> bool:
            P = line.pitches
            if P.count(max(P)) > 1 or max(P) - min(P) > 10:
                return False
            return any(abs(b - a) >= 5 for a, b in zip(P, P[1:]))

        try:
            Search(
                events, cands, [Image(piece, line)], leaf=leaf, budget=budget, rng=rng
            ).run()
        except SearchFailed:
            continue
        return line
    raise CounterpointError("no subject was found; try another seed")


def answer_for(subject: Line, scale: Scale) -> dict[str, Any]:
    """The answer a fifth up: tonal when the head touches the dominant."""
    degs = [scale.degree(p) % 7 for p in subject.pitches]
    head = 0
    while head < len(degs) and degs[head] in (0, 4):
        head += 1
    tonal = any(d == 4 for d in degs[:head])
    pitches, mutations = [], []
    for k, p in enumerate(subject.pitches):
        if tonal and k < head and degs[k] == 4:
            pitches.append(p + 5)
            mutations.append(k)
        else:
            pitches.append(p + 7)
    ans = Line("answer")
    for p, s, e in zip(pitches, subject.starts, subject.ends):
        ans.append(p, s, e)
    return {
        "kind": "tonal" if tonal else "real",
        "line": ans,
        "mutations": mutations,
        "head": head,
    }


# ---------------------------------------------------------------------------
# stretto
# ---------------------------------------------------------------------------


def find_strettos(
    subject: Line, scale: Scale, *, intervals: Sequence[int] = STRETTO_INTERVALS
) -> list[dict[str, Any]]:
    """Every (lag, interval) at which a second entry of the subject, moved
    diatonically by the interval and starting ``lag`` ticks after the first,
    stays clean against it."""
    end = subject.ends[-1]
    out = []
    for lag in range(PPQ, end, PPQ):
        for interval in intervals:
            steps = interval - 1 if interval > 0 else interval + 1
            follower = Line("follower")
            for p, s, e in zip(subject.pitches, subject.starts, subject.ends):
                follower.append(scale.transpose(p, steps), s + lag, e + lag)
            leader = subject.copy("leader")
            upper, lower = (follower, leader) if steps > 0 else (leader, follower)
            piece = Piece([upper, lower], scale, FREE)
            if piece.flags() or checker_flags(piece.lines):
                continue
            out.append(
                {
                    "lag": lag,
                    "lag_beats": lag / PPQ,
                    "interval": interval,
                    "follower": "above"
                    if steps > 0
                    else ("below" if steps < 0 else "unison"),
                }
            )
    return out


# ---------------------------------------------------------------------------
# the exposition
# ---------------------------------------------------------------------------


def _fit_octave(pitches: Sequence[int], rng_: tuple[int, int]) -> int:
    """The octave shift that puts these pitches best inside the range."""
    lo, hi = rng_
    mid = (lo + hi) / 2
    best = None
    for k in range(-5, 6):
        sh = 12 * k
        out = sum(max(0, lo - (p + sh)) + max(0, (p + sh) - hi) for p in pitches)
        centre = abs(sum(p + sh for p in pitches) / len(pitches) - mid)
        key = (out, centre)
        if best is None or key < best[0]:
            best = (key, sh)
    assert best is not None
    return best[1]


def _entry_octave(
    pitches: Sequence[int], rng_: tuple[int, int], near: float, above: bool | None
) -> int:
    """The octave shift that keeps an entry in its range, on its side of the
    entry before it (``above``), and as close to ``near`` as that allows."""
    lo, hi = rng_
    mean = sum(pitches) / len(pitches)
    best = None
    for k in range(-5, 6):
        sh = 12 * k
        out = sum(max(0, lo - (p + sh)) + max(0, (p + sh) - hi) for p in pitches)
        m = mean + sh
        wrong = above is not None and ((m <= near) if above else (m >= near))
        key = (out, wrong, abs(m - near))
        if best is None or key < best[0]:
            best = (key, sh)
    assert best is not None
    return best[1]


def _copy_shift(
    b: _Build,
    base: int,
    band: Sequence[int],
    voice: int,
    entry_voice: int,
    entry: Sequence[int],
) -> int:
    """The shift (``base`` plus octaves) that puts the countersubject in
    ``voice``'s range, on its side of the entry, as close to it as that
    allows."""
    lo, hi = b.ranges[b.names[voice]]
    mean_entry = sum(entry) / len(entry)
    above = voice < entry_voice
    best = None
    for k in range(-4, 5):
        sh = base + 12 * k
        a, z = band[0] + sh, band[-1] + sh
        out = max(0, lo - a) + max(0, z - hi)
        mean = (a + z) / 2
        wrong = (mean < mean_entry) if above else (mean > mean_entry)
        key = (wrong, out, abs(mean - mean_entry))
        if best is None or key < best[0]:
            best = (key, sh)
    assert best is not None
    return best[1]


def _quarters(t0: int, t1: int) -> list[Ev]:
    """Quarter notes whose second quarter in each half bar may hold the
    first (a tie), so the search picks quarters or halves as it goes."""
    return [Ev(q, PPQ, tie=q % HALF != 0) for q in range(t0, t1, PPQ)]


def _busy(lines: Sequence[Line], t: int) -> bool:
    """True when another voice attacks twice or more in the half bar at t."""
    h = t - t % HALF
    return any(sum(1 for s in ln.starts if h <= s < h + HALF) >= 2 for ln in lines)


class _Build:
    def __init__(
        self, scale: Scale, voices: int, rng: random.Random, budget: int
    ) -> None:
        self.scale = scale
        self.n = voices
        self.names = list(FUGUE_VOICES[voices])
        self.ranges = FUGUE_RANGES[voices]
        self.lines = [Line(nm) for nm in self.names]
        self.piece = Piece(self.lines, scale, FUGUE_RULES)
        self.rng = rng
        self.budget = budget
        self.pool = {
            nm: scale.pitches(*self.ranges[nm], ficta=scale.mode == "minor")
            for nm in self.names
        }
        self.fixed: set[tuple[int, int]] = (
            set()
        )  # (voice, start) of entry and fragment notes

    def place(self, v: int, src: Line, t0: int, shift: int) -> None:
        for p, s, e in zip(src.pitches, src.starts, src.ends):
            self.lines[v].append(p + shift, s + t0, e + t0)
            self.fixed.add((v, s + t0))

    def between(self, v: int, t: int, p: int) -> bool:
        """p at t keeps voice v between the voices above and below it."""
        for u in range(v - 1, -1, -1):
            q = self.lines[u].pitch(t)
            if q is not None:
                if p > q:
                    return False
                break
        for u in range(v + 1, self.n):
            q = self.lines[u].pitch(t)
            if q is not None:
                if p < q:
                    return False
                break
        return True

    def search(
        self,
        v: int,
        events: list[Ev],
        extra_images: Sequence[Image] = (),
        *,
        pool: Sequence[int] | None = None,
        continues: bool = True,
        leaf_extra: Callable[[], bool] | None = None,
        window: tuple[int, int] | None = None,
    ) -> None:
        line = self.lines[v]
        scale = self.scale
        opts_all = list(pool if pool is not None else self.pool[self.names[v]])
        first_new = len(line.pitches)
        images = [Image(self.piece, line, continues=continues, melody_from=first_new)]
        images += list(extra_images)
        lo_t = events[0].tick
        hi_t = events[-1].tick + events[-1].ticks
        if window is not None:
            lo_t, hi_t = min(lo_t, window[0]), max(hi_t, window[1])
        if first_new:
            lo_t = min(lo_t, line.starts[first_new - 1])

        others = [ln for u, ln in enumerate(self.lines) if u != v]

        def cands(k: int, s: Search) -> list[int]:
            ev = events[k]
            prev = (
                s.pitches[-1]
                if s.pitches
                else (line.pitches[-1] if first_new else None)
            )
            opts = [p for p in opts_all if self.between(v, ev.tick, p)]
            if prev is not None:
                opts = [
                    p
                    for p in opts
                    if (ev.tie and p == prev and bool(s.pitches))
                    or melodic_kind(scale, prev, p) in ("step", "leap")
                ]
            if not ev.tie:
                return rank(opts, prev, s.rng)
            # Hold where the other voices move, move where they hold.
            hold = -4.0 if _busy(others, ev.tick) else 1.0
            return rank(opts, prev, s.rng, lambda p: hold if p == prev else 0.0)

        def leaf(s: Search) -> bool:
            # A segment ends settled: its last note is no passing tone left
            # for whatever follows to resolve.
            opened = [im.line for im in images if im.line.open]
            for ln in opened:
                ln.open = False
            try:
                for im in images:
                    if im.piece is not self.piece and im.piece.flags():
                        return False
                if self.piece.flags(lo_t, hi_t):
                    return False
                return leaf_extra is None or leaf_extra()
            finally:
                for ln in opened:
                    ln.open = True

        Search(events, cands, images, leaf=leaf, budget=self.budget, rng=self.rng).run()


def build_fugue(
    key: str = "C",
    mode: str | None = None,
    *,
    voices: int = 3,
    subject: Sequence[Any] | None = None,
    subject_start: str = "tonic",
    seed: int = 0,
    countersubject: bool = True,
    episodes: int = 1,
    start_tick: int = 0,
    budget: int = 20000,
) -> dict[str, Any]:
    """A fugue exposition (and episodes) in ``voices`` parts, with the
    answer, countersubject and the stretto possibilities of the subject."""
    if voices not in FUGUE_VOICES:
        raise CounterpointError(
            f"a fugue has {min(FUGUE_VOICES)} to {max(FUGUE_VOICES)} voices"
        )
    if not 0 <= episodes <= 2:
        raise CounterpointError("episodes is 0, 1 or 2")
    scale = parse_scale(key, mode)
    rng = random.Random(seed)
    subj = (
        _notes(subject)
        if subject
        else generate_subject(scale, seed=seed, start=subject_start)
    )
    if not 2 <= len(subj.pitches) <= 32 or subj.ends[-1] > MAX_SUBJECT_TICKS:
        raise CounterpointError(
            "a subject has 2 to 32 notes and lasts at most four bars"
        )
    answer = answer_for(subj, scale)
    strettos = find_strettos(subj, scale)
    last: Exception | None = None
    # Each entry order in turn, a few times each with fresh jitter; a
    # countersubject that inverts at the octave first, then one that holds
    # only as written.
    # The first round takes only an exposition whose entries all sit in their
    # voices' ranges.
    orders = ENTRY_ORDERS[voices]
    tries = [(True, order, True) for order in orders] + [
        (invertible, order, False)
        for invertible in (True, False)
        for _round in range(3)
        for order in orders
    ]
    for invertible, order, in_range in tries:
        try:
            out = _build(
                scale,
                voices,
                subj,
                answer,
                countersubject,
                episodes,
                rng,
                budget,
                order,
                invertible,
                in_range,
            )
        except SearchFailed as e:
            last = e
            continue
        if out is not None:
            b, info = out
            return _payload(
                b,
                info,
                scale,
                subj,
                answer,
                strettos,
                seed,
                start_tick - start_tick % BAR,
            )
    raise CounterpointError(
        f"no clean exposition was found for this subject ({last or 'a join failed'}); "
        "try another seed"
    )


def _build(
    scale: Scale,
    voices: int,
    subj: Line,
    answer: dict[str, Any],
    with_cs: bool,
    episodes: int,
    rng: random.Random,
    budget: int,
    order: tuple[int, ...],
    invertible: bool = True,
    in_range: bool = False,
) -> tuple[_Build, dict[str, Any]] | None:
    b = _Build(scale, voices, rng, budget)
    n = voices
    span = -(-subj.ends[-1] // BAR) * BAR  # entries a whole number of bars apart
    padded = subj.copy("subject")
    padded.ends[-1] = span
    ans = answer["line"].copy("answer")
    ans.ends[-1] = span
    entries = []
    prev_mean: float | None = None
    for j, v in enumerate(order):
        form = padded if j % 2 == 0 else ans
        if prev_mean is None:
            # between its own range and the next voice's, so the two interlock
            nxt = b.ranges[b.names[order[1]]]
            own = b.ranges[b.names[v]]
            target = (sum(own) + sum(nxt)) / 4
            shift = _entry_octave(form.pitches, own, target, None)
        else:
            shift = _entry_octave(
                form.pitches, b.ranges[b.names[v]], prev_mean, v < order[j - 1]
            )
        prev_mean = sum(form.pitches) / len(form.pitches) + shift
        entries.append(
            {
                "voice": v,
                "form": "subject" if j % 2 == 0 else "answer",
                "shift": shift,
                "pitches": [p + shift for p in form.pitches],
            }
        )
        b.place(v, form, j * span, shift)
    expo_end = n * span

    ep_plans = _plan_episodes(b, subj, episodes, expo_end)

    cs_notes: list[dict[str, int]] = []
    inversion = None
    cs_last = 0  # the last entry the countersubject accompanies
    cs_rest = 0
    if with_cs:
        # With every later entry if it can, else with fewer; straight after
        # the subject, else after a quarter rest.
        for last in range(n - 1, 0, -1):
            for rest in (0, PPQ):
                try:
                    _countersubject(
                        b, order, entries, span, expo_end, last, rest, invertible
                    )
                except SearchFailed:
                    continue
                cs_last, cs_rest = last, rest
                break
            if cs_last:
                break
        if not cs_last:
            raise SearchFailed("no countersubject fits against this answer")
        v0, v1 = order[0], order[1]
        t0, t1 = span, 2 * span
        line0, a_line = b.lines[v0], b.lines[v1]
        cs_line = Line("countersubject")
        for p, s, e in zip(line0.pitches, line0.starts, line0.ends):
            if t0 <= s < t1:
                cs_line.append(p, s - t0, e - t0)
        cs_notes = cs_line.notes()
        upper, lower = (line0, a_line) if v0 < v1 else (a_line, line0)
        inversion = invertible_check(
            [x for x in upper.notes() if t0 <= x["tick"] < t1],
            [x for x in lower.notes() if t0 <= x["tick"] < t1],
            8,
            scale=scale,
            names=(upper.name, lower.name),
        )

    # Free counterpoint for every voice after its countersubject; a voice
    # with no clean line there rests.
    resting = []
    for j, v in enumerate(order):
        f0 = (j + (2 if j + 1 <= cs_last else 1)) * span
        if f0 >= expo_end:
            continue
        try:
            b.search(v, _quarters(f0, expo_end), continues=bool(ep_plans))
        except SearchFailed:
            resting.append({"voice": b.names[v], "tick": f0, "ticks": expo_end - f0})

    ep_info = []
    for i, plan in enumerate(ep_plans):
        last = i == len(ep_plans) - 1
        if last:
            # Nothing follows the last episode: every line ends where it is.
            for ln in b.lines:
                ln.open = False
        ep_info.append(_episode(b, plan, last))
    for ln in b.lines:
        ln.open = False
    if b.piece.flags() or (in_range and checker_flags(b.lines, ranges=b.ranges)):
        return None
    return b, {
        "entries": [
            {
                "voice": b.names[e["voice"]],
                "form": e["form"],
                "tick": j * span,
                "ticks": span,
                "transpose": e["shift"] + (0 if e["form"] == "subject" else 7),
            }
            for j, e in enumerate(entries)
        ],
        "span": span,
        "countersubject": cs_notes,
        "countersubject_with": cs_last,
        "resting": resting,
        "countersubject_rest": cs_rest,
        "inversion": inversion,
        "episodes": ep_info,
        "exposition_end": expo_end,
    }


def _countersubject(
    b: _Build,
    order: tuple[int, ...],
    entries: list[dict[str, Any]],
    span: int,
    expo_end: int,
    last: int,
    rest: int,
    invertible: bool = True,
) -> None:
    """Search the countersubject in the first voice against the answer, as
    written and inverted at the octave, and copied into the voice that
    accompanies each entry up to ``last``."""
    scale = b.scale
    v0, v1 = order[0], order[1]
    t0, t1 = span, 2 * span
    a_line = b.lines[v1]
    cs_inv = Line(b.names[v0])
    ans_now = Line(b.names[v1])
    for p, s, e in zip(a_line.pitches, a_line.starts, a_line.ends):
        if t0 <= s < t1:
            ans_now.append(p, s, e)
    if v0 < v1:
        moved = Line(b.names[v1])
        for p, s, e in zip(ans_now.pitches, ans_now.starts, ans_now.ends):
            moved.append(p + 12, s, e)
        inv_image = Image(Piece([moved, cs_inv], scale, FREE), cs_inv, melody=None)
    else:
        inv_image = Image(
            Piece([cs_inv, ans_now], scale, FREE),
            cs_inv,
            shift=lambda p: p + 12,
            melody=None,
        )
    images = [inv_image] if invertible else []
    band = b.pool[b.names[v0]]
    pool = set(band)
    for j in range(2, last + 1):
        vj_prev = order[j - 1]
        base = (-7 if j % 2 == 0 else 0) + entries[j]["shift"] - entries[1]["shift"]
        sh = _copy_shift(b, base, band, vj_prev, order[j], entries[j]["pitches"])
        images.append(
            Image(
                b.piece,
                b.lines[vj_prev],
                offset=(j - 1) * span,
                shift=lambda p, sh=sh: p + sh,
                continues=True,
                melody_from=len(b.lines[vj_prev].pitches),
            )
        )
        lo, hi = b.ranges[b.names[vj_prev]]
        pool &= {p for p in band if lo <= p + sh <= hi}
    b.search(
        v0, _quarters(t0 + rest, t1), images, pool=sorted(pool), window=(t0, expo_end)
    )


def _fragment(subj: Line, which: int) -> tuple[list[tuple[int, int, int]], int]:
    """(pitch, offset, ticks) of a subject fragment and its model length: the
    head (or, for ``which`` 1, the second bar) cut to a half bar when that
    holds two notes, else to a bar."""
    t0 = BAR if which == 1 and subj.ends[-1] > BAR + HALF else 0
    for m in (HALF, BAR):
        notes = [
            (p, s - t0, min(e, t0 + m) - s)
            for p, s, e in zip(subj.pitches, subj.starts, subj.ends)
            if t0 <= s < t0 + m
        ]
        if len(notes) >= 2 or m == BAR:
            break
    if not notes or notes[0][1] != 0:
        # the fragment starts where a note is held: take the head instead
        return _fragment(subj, 0) if t0 else (notes, m)
    last = notes[-1]
    notes[-1] = (last[0], last[1], m - last[1])
    return notes, m


def _plan_episodes(
    b: _Build, subj: Line, episodes: int, t: int
) -> list[dict[str, Any]]:
    plans = []
    for e in range(episodes):
        frag, m = _fragment(subj, e)
        reps = 4 if m == HALF else 3
        direction = -1 if e == 0 else 1
        plans.append(
            {
                "voice": 0 if e == 0 else b.n - 1,
                "tick": t,
                "model": m,
                "reps": reps,
                "direction": direction,
                "fragment": frag,
            }
        )
        t += m * reps
    return plans


def _episode(b: _Build, plan: dict[str, Any], last: bool = True) -> dict[str, Any]:
    scale = b.scale
    t, m, reps, d = plan["tick"], plan["model"], plan["reps"], plan["direction"]
    frag = plan["fragment"]
    seq = [scale.transpose(p, d * r) for r in range(reps) for p, _o, _t in frag]
    # The planned voice carries the fragment, or the nearest voice whose last
    # note leads into it legally, at the octave that fits its range.
    voices = sorted(range(b.n), key=lambda u: abs(u - plan["voice"]))
    chosen = None
    for mv in voices:
        motif = b.lines[mv]
        lo, hi = b.ranges[b.names[mv]]

        def outside(sh: int, lo: int = lo, hi: int = hi) -> int:
            return sum(max(0, lo - (p + sh)) + max(0, (p + sh) - hi) for p in seq)

        fit = _fit_octave(seq, (lo, hi))
        for shift in [fit + 12 * k for k in (0, -1, 1) if outside(fit + 12 * k) == 0]:
            motif.append(frag[0][0] + shift, t, t + frag[0][2])
            k = len(motif.pitches) - 1
            bad = melodic_problems(scale, motif, k, MELODY, k)
            if not bad and k > 0:
                bad = b.piece.flags(motif.starts[k - 1], t + 1)
            motif.pop()
            if not bad:
                chosen = (mv, shift)
                break
        if chosen:
            break
    if chosen is None:
        raise SearchFailed("the episode's fragment cannot follow any voice")
    mv, shift = chosen
    motif = b.lines[mv]
    for r in range(reps):
        for p, off, ticks in frag:
            q = scale.transpose(p, d * r) + shift
            motif.append(q, t + r * m + off, t + r * m + off + ticks)
            b.fixed.add((mv, t + r * m + off))
    end = t + m * reps
    # The voice next to the motif answers it; the far outer voice supports.
    counter = mv + 1 if mv < b.n - 1 else mv - 1
    far = [u for u in (0, b.n - 1) if u not in (mv, counter)]
    searched = [counter] + far[-1:]
    frag_notes = len(plan["fragment"])
    sequential = []
    for v in searched:
        line = b.lines[v]
        k0 = len(line.pitches)

        def reps_ok(line: Line = line, k0: int = k0) -> bool:
            model = list(zip(line.pitches[k0:], line.starts[k0:], line.ends[k0:]))
            added = 0
            for r in range(1, reps):
                for p, s, e in model:
                    line.append(scale.transpose(p, d * r), s + r * m, e + r * m)
                    added += 1
            line.open = False
            lo, hi = b.ranges[line.name]
            ok = (
                all(lo <= p <= hi for p in line.pitches[k0:])
                and not any(
                    melodic_problems(scale, line, k, MELODY, k0)
                    for k in range(k0, len(line.pitches))
                )
                and not b.piece.flags(t, end)
            )
            line.open = True
            if not ok:
                for _ in range(added):
                    line.pop()
            return ok

        try:
            # The voice follows the sequence: its first statement, repeated.
            b.search(
                v,
                _quarters(t, t + m),
                continues=not last,
                leaf_extra=reps_ok,
                window=(t, end),
            )
            sequential.append(b.names[v])
        except SearchFailed:
            # No statement repeats cleanly: free counterpoint under the motif.
            b.search(v, _quarters(t, end), continues=not last, window=(t, end))
    return {
        "tick": t,
        "ticks": end - t,
        "voice": b.names[mv],
        "fragment_notes": frag_notes,
        "model": m,
        "reps": reps,
        "direction": "down" if d < 0 else "up",
        "voices": [b.names[v] for v in [mv] + searched],
        "sequential": [b.names[mv]] + sequential,
    }


def _payload(
    b: _Build,
    info: dict[str, Any],
    scale: Scale,
    subj: Line,
    answer: dict[str, Any],
    strettos: list[dict[str, Any]],
    seed: int,
    start: int,
) -> dict[str, Any]:
    violations = b.piece.flags()
    for v, ln in enumerate(b.lines):
        for k in range(len(ln.pitches)):
            if (v, ln.starts[k]) in b.fixed and (
                k == 0 or (v, ln.starts[k - 1]) in b.fixed
            ):
                continue
            for rule, msg in melodic_problems(scale, ln, k, MELODY, k):
                violations.append(b.piece.flag(ln.starts[k], [v], rule, msg))
    flags = checker_flags(b.lines, ranges=b.ranges)

    def moved(notes: list[dict[str, int]]) -> list[dict[str, int]]:
        return [{**x, "tick": x["tick"] + start} for x in notes]

    for e in info["entries"]:
        e["tick"] += start
    for e in info["episodes"]:
        e["tick"] += start
    return {
        "key": scale.label,
        "ppq": PPQ,
        "bar_ticks": BAR,
        "voices": b.names,
        "seed": seed,
        "subject": subj.notes(),
        "answer": {
            "kind": answer["kind"],
            "mutations": answer["mutations"],
            "head": answer["head"],
            "notes": answer["line"].notes(),
        },
        "countersubject": info["countersubject"],
        "countersubject_inversion": info["inversion"],
        # the countersubject accompanies entries 1 to this one (0: none)
        "countersubject_entries": info["countersubject_with"],
        "countersubject_rest": info["countersubject_rest"],
        "resting": [{**r, "tick": r["tick"] + start} for r in info["resting"]],
        "entries": info["entries"],
        "episodes": info["episodes"],
        "strettos": strettos,
        "exposition_end": info["exposition_end"] + start,
        "parts": {ln.name: moved(ln.notes()) for ln in b.lines},
        "ranges": {k: list(v) for k, v in b.ranges.items()},
        "violations": [_moved_flag(f.as_dict(), start) for f in violations],
        "flags": [_moved_flag(f.as_dict(), start) for f in flags],
    }


def _moved_flag(f: dict[str, Any], start: int) -> dict[str, Any]:
    return {**f, "tick": f["tick"] + start, "bar": f["bar"] + start // BAR}
