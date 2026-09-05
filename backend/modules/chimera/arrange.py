"""Arrangement planner for Chimera v2 (engine='v2' Phrase Weave).

Pure and deterministic: no audio, no I/O. Given one phrase table per clip
(SOURCE seconds, produced by ``analysis.phrases_for``) and a resolved
timeline, it decides which clip leads each slot, which clips support it,
merges consecutive phrases into runs, and emits seams for the renderer and
the diffusion healer.

Timebases (see ``types.py``):

* ``Run.src_*``, ``Phrase.start_sec/end_sec``  -> SOURCE seconds
* ``Placement.window_*``                       -> CONFORMED (source / ratio)
* ``Run.output_*``, ``Placement.output_*``, ``Seam.sec`` -> OUTPUT timeline

Invariants the rest of the engine relies on (all covered by
``tests/test_chimera_arrange.py``):

* every clip with phrases is placed at least once (coverage pass);
* per clip, phrase indices are non-decreasing across ALL placements,
  whatever the lane;
* the slot-0 lead is that clip's phrase 0;
* polyphony (audible spans INCLUDING crossfade tails) never exceeds the cap;
* at most one change (lead switch, support in or out) per line unless the
  line is a DROP (contour jump >= 0.35);
* the same seed yields the same schedule.
"""

from __future__ import annotations

import logging
import math
import random
from typing import Optional, TypedDict

import numpy as np

from backend.modules.chimera.tempo import fit_tempo_to_duration
from backend.modules.chimera.types import (
    Lane,
    Phrase,
    Placement,
    Role,
    Run,
    Schedule,
    Seam,
    Section,
)
from backend.modules.chimera.weave import (
    BEATS_PER_BAR,
    WEAVE_TOTAL_BARS_DEFAULT,
    WEAVE_TOTAL_BARS_MAX,
    WEAVE_TOTAL_BARS_MIN,
    bar_duration_sec,
)

__all__ = [
    "ClipPlanInput",
    "TimelinePlan",
    "MIN_RUN",
    "MAX_RUN",
    "MIN_SUPPORT_RUN",
    "MAX_SUPPORT_RUN",
    "DROP_DELTA",
    "resolve_timeline",
    "energy_contour",
    "density",
    "is_drop_line",
    "normalize_energy",
    "plan_lead",
    "plan_supports",
    "coverage_pass",
    "assign_role",
    "build_runs",
    "compute_seams",
    "seam_budget",
    "sections",
    "placements_from_runs",
    "plan_timeline",
]

log = logging.getLogger(__name__)

# Lead run length in slots.
MIN_RUN = 2
MAX_RUN = 4
# Support run length in slots.
MIN_SUPPORT_RUN = 2
MAX_SUPPORT_RUN = 4
# A line whose contour jumps by at least this much is a DROP: multiple
# changes are allowed there and the lead switch is a hard cut.
DROP_DELTA = 0.35
# The final timeline slot is merged into the previous one when shorter than
# this (bars); it also bounds crossfade tails to half a slot.
MIN_SLOT_BARS = 2
_MIN_TOTAL_BARS = 4

# Lead cost model (see plan_lead).
_SWITCH_COST = 0.25
_SKIP_COST = 0.15
_BASE_BONUS = 0.15
_INTRO_COST = 2.0
_OUTRO_COST = 1.0
_OUTLIER_COST = 1.5
_JITTER = 1e-3
# Support cost model (see plan_supports).
_SUPPORT_ENERGY_SLACK = 0.1
_SUPPORT_ENERGY_COST = 0.3
_SUPPORT_CONTRAST_WEIGHT = 0.3
_SUPPORT_REPEAT_COST = 0.1

_ARC_POINTS: dict[str, list[tuple[float, float]]] = {
    "song": [
        (0.0, 0.15),
        (0.2, 0.45),
        (0.4, 0.95),
        (0.55, 0.5),
        (0.75, 1.0),
        (0.9, 0.55),
        (1.0, 0.1),
    ],
    "rise": [(0.0, 0.1), (0.85, 1.0), (1.0, 0.6)],
}
_FLAT_ENERGY = 0.7


class ClipPlanInput(TypedDict):
    index: int
    phrases: list[Phrase]  # SOURCE seconds; ``energy`` filled by normalize_energy
    weight: float
    is_base: bool
    tonal: bool
    harmonic_outlier: bool
    downbeat_confidence: float
    steady: bool
    has_stems: bool
    ratio: float  # nominal conform ratio (CONFORMED = SOURCE / ratio)
    centroid_hz: float


class TimelinePlan(TypedDict):
    bpm: float
    total_bars: int
    n_slots: int
    slot_bars: list[int]
    length_source: (
        str  # 'weave_total_bars' | 'base clip' | 'target_duration' | 'default'
    )
    tempo_fit_pct: float


# --------------------------------------------------------------------------
# timeline
# --------------------------------------------------------------------------


def _round_half_up(x: float) -> int:
    return int(math.floor(x + 0.5))


def _split_slots(total_bars: int, phrase_bars: int) -> list[int]:
    p = max(1, int(phrase_bars))
    total = max(1, int(total_bars))
    n = max(1, int(math.ceil(total / p)))
    slots = [p] * (n - 1) + [total - p * (n - 1)]
    if len(slots) > 1 and slots[-1] < MIN_SLOT_BARS:
        last = slots.pop()
        slots[-1] += last
    return slots


def resolve_timeline(
    target_bpm: float,
    bpm_source: str,
    target_duration_sec: float,
    weave_total_bars: int,
    base_len_sec: Optional[float],
    phrase_bars: int,
) -> TimelinePlan:
    """Decide the output length in bars (and possibly nudge the tempo).

    Priority: ``weave_total_bars`` > 0 (clamped 16..256) > ``base_len_sec``
    (the base clip's CONFORMED length, also capped by ``target_duration_sec``
    when given) > ``target_duration_sec`` (when the tempo came from the
    median the BPM is nudged <= 3% so whole bars land on the duration) >
    90 bars. Slots are ``phrase_bars`` wide; a final slot shorter than
    ``MIN_SLOT_BARS`` is merged into the previous one.
    """
    bpm = float(target_bpm)
    if bpm <= 0:
        raise ValueError("target_bpm must be positive")
    pct = 0.0
    bar_sec = bar_duration_sec(bpm)
    if weave_total_bars and weave_total_bars > 0:
        total = max(
            WEAVE_TOTAL_BARS_MIN, min(WEAVE_TOTAL_BARS_MAX, int(weave_total_bars))
        )
        source = "weave_total_bars"
    elif base_len_sec is not None and base_len_sec > 0:
        limit = float(base_len_sec)
        if target_duration_sec and target_duration_sec > 0:
            limit = min(limit, float(target_duration_sec))
        total = int(math.floor(limit / bar_sec + 1e-9))
        source = "base clip"
    elif target_duration_sec and target_duration_sec > 0:
        if bpm_source == "median":
            bpm, total, pct = fit_tempo_to_duration(bpm, float(target_duration_sec))
        else:
            total = int(math.floor(float(target_duration_sec) / bar_sec + 1e-9))
        source = "target_duration"
    else:
        total = WEAVE_TOTAL_BARS_DEFAULT
        source = "default"
    total = max(_MIN_TOTAL_BARS, total)
    slot_bars = _split_slots(total, phrase_bars)
    return {
        "bpm": float(bpm),
        "total_bars": int(total),
        "n_slots": len(slot_bars),
        "slot_bars": slot_bars,
        "length_source": source,
        "tempo_fit_pct": float(pct),
    }


def _slot_edges(slot_bars: list[int], bar_sec: float) -> list[float]:
    edges = [0.0]
    for b in slot_bars:
        edges.append(edges[-1] + b * bar_sec)
    return edges


# --------------------------------------------------------------------------
# energy contour / density
# --------------------------------------------------------------------------


def energy_contour(n_slots: int, arc: str) -> list[float]:
    """Target energy E*(s) in [0, 1] per slot for the given arc."""
    if n_slots <= 0:
        return []
    if arc == "flat":
        return [_FLAT_ENERGY] * n_slots
    if arc not in _ARC_POINTS:
        raise ValueError(f"unknown arc {arc!r}")
    xs = [p[0] for p in _ARC_POINTS[arc]]
    ys = [p[1] for p in _ARC_POINTS[arc]]
    u = [s / (n_slots - 1) if n_slots > 1 else 0.0 for s in range(n_slots)]
    return [float(v) for v in np.interp(u, xs, ys)]


def density(contour: list[float], cap: int, arc: str) -> list[int]:
    """Wanted number of simultaneous clips per slot (lead included)."""
    cap = max(1, int(cap))
    if arc == "flat":
        return [cap] * len(contour)
    d = [max(1, min(cap, 1 + _round_half_up((cap - 1) * e))) for e in contour]
    if d:
        d[0] = min(d[0], 2)
        d[-1] = min(d[-1], 2)
    return d


def is_drop_line(contour: list[float], s: int) -> bool:
    """True when line ``s`` (the boundary before slot ``s``) is a DROP."""
    return s > 0 and s < len(contour) and contour[s] - contour[s - 1] >= DROP_DELTA


def normalize_energy(clips: list[ClipPlanInput]) -> None:
    """Min-max phrase ``lufs`` ACROSS the stack -> ``phrase['energy']`` in
    [0, 1]. A range below 1 dB maps everything to 0.5."""
    vals = [
        float(p["lufs"])
        for c in clips
        for p in c["phrases"]
        if math.isfinite(float(p["lufs"]))
    ]
    if not vals:
        lo, hi = 0.0, 0.0
    else:
        lo, hi = min(vals), max(vals)
    span = hi - lo
    for c in clips:
        for p in c["phrases"]:
            v = float(p["lufs"])
            if span < 1.0 or not math.isfinite(v):
                p["energy"] = 0.5
            else:
                p["energy"] = float(min(1.0, max(0.0, (v - lo) / span)))


# --------------------------------------------------------------------------
# lead
# --------------------------------------------------------------------------


def plan_lead(
    clips: list[ClipPlanInput],
    contour: list[float],
    slot_bars: list[int],
    seed: int = 0,
    warnings: Optional[list[str]] = None,
) -> list[tuple[int, int]]:
    """Greedy forward pass choosing ``(clip, phrase_idx)`` per slot.

    Cost = |E - E*(s)| + 0.15 * skipped phrases + 0.25 switch + 2.0 when the
    slot-0 pick is not phrase 0 + 1.0 when the last slot is not the clip's
    last phrase - 0.15 base clip + 1.5 harmonic outlier (s > 0), with a
    seeded 1e-3 jitter for ties. A lead run holds >= MIN_RUN slots
    (contiguous phrases); once it has held MAX_RUN slots the switch cost
    moves onto STAYING (switching is free, continuing costs 0.25) so variety
    appears unless the current clip fits far better. A clip out of phrases
    ends its run; when every clip is exhausted the current lead repeats its
    last phrase (warned).
    """
    n = len(slot_bars)
    n_clips = len(clips)
    rng = random.Random(seed)
    cur = [0] * n_clips
    out: list[tuple[int, int]] = []
    lead: Optional[int] = None
    prev_i = -1
    run_len = 0
    exhausted_warned = False
    for s in range(n):
        target = contour[s]
        last = s == n - 1
        hold = (
            lead is not None
            and run_len < MIN_RUN
            and cur[lead] < len(clips[lead]["phrases"])
        )
        free_switch = lead is not None and run_len >= MAX_RUN
        best: Optional[tuple[float, int, int]] = None
        for c in range(n_clips):
            if hold and c != lead:
                continue
            clip = clips[c]
            ph = clip["phrases"]
            for i in range(cur[c], len(ph)):
                if hold and not last and i != cur[c]:
                    continue
                cost = abs(float(ph[i]["energy"]) - target)
                cost += _SKIP_COST * (i - cur[c])
                if lead is not None and (c != lead) != free_switch:
                    cost += _SWITCH_COST
                if s == 0 and i != 0:
                    cost += _INTRO_COST
                if last and i != len(ph) - 1:
                    cost += _OUTRO_COST
                if clip["is_base"]:
                    cost -= _BASE_BONUS
                if clip["harmonic_outlier"] and s > 0:
                    cost += _OUTLIER_COST
                cost += rng.random() * _JITTER
                if best is None or cost < best[0]:
                    best = (cost, c, i)
        if best is None:
            if lead is None:
                raise ValueError("no clip has any phrases to arrange")
            c = lead
            i = len(clips[c]["phrases"]) - 1
            if warnings is not None and not exhausted_warned:
                warnings.append(
                    f"material exhausted at slot {s}; clip {clips[c]['index']} "
                    "repeats its last phrase"
                )
                exhausted_warned = True
        else:
            _, c, i = best
        if lead == c and i == prev_i + 1:
            run_len += 1
        else:
            run_len = 1
        lead = c
        prev_i = i
        cur[c] = max(cur[c], i + 1)
        out.append((c, i))
    return out


def _lead_change_flags(lead: list[tuple[int, int]]) -> list[bool]:
    flags = [False] * len(lead)
    for s in range(1, len(lead)):
        flags[s] = lead[s][0] != lead[s - 1][0] or lead[s][1] != lead[s - 1][1] + 1
    return flags


# --------------------------------------------------------------------------
# supports
# --------------------------------------------------------------------------


class _Sup:
    __slots__ = ("clip", "since", "reserved")

    def __init__(self, clip: int, since: int, reserved: Optional[int]):
        self.clip = clip
        self.since = since
        self.reserved = reserved


class _LineBudget:
    """Change bookkeeping per line: non-drop lines allow ONE change (a lead
    switch counts); drop lines and the timeline edges are unlimited."""

    def __init__(self, n: int, lead_change: list[bool], drop: list[bool]):
        self.n = n
        self.limit = [math.inf if (s == 0 or drop[s]) else 1.0 for s in range(n)]
        self.used = [1 if lead_change[s] else 0 for s in range(n)]
        self.reserved = [0] * n

    def free(self, s: int) -> bool:
        if s >= self.n:
            return True
        return self.used[s] + self.reserved[s] < self.limit[s]

    def charge(self, s: int) -> None:
        if s < self.n:
            self.used[s] += 1

    def reserve(self, s: int) -> None:
        if s < self.n:
            self.reserved[s] += 1

    def release(self, s: Optional[int]) -> None:
        if s is not None and s < self.n:
            self.reserved[s] = max(0, self.reserved[s] - 1)

    def use_reservation(self, s: int) -> None:
        if s < self.n:
            self.reserved[s] = max(0, self.reserved[s] - 1)
            self.used[s] += 1


def _next_lead_phrase(lead_uses: list[tuple[int, int]], s: int) -> Optional[int]:
    """Smallest phrase the lead plays for this clip at a slot > s."""
    later = [i for (slot, i) in lead_uses if slot > s]
    return min(later) if later else None


def _support_hi(lead_uses: list[tuple[int, int]], n_phrases: int, s: int) -> int:
    nxt = _next_lead_phrase(lead_uses, s)
    return n_phrases - 1 if nxt is None else nxt - 1


def _horizon(
    clip: int,
    lead: list[tuple[int, int]],
    lead_uses: list[tuple[int, int]],
    n_phrases: int,
    s: int,
    i: int,
    slot_cap: Optional[list[int]] = None,
) -> int:
    """Consecutive slots from ``s`` a support of ``clip`` can play starting
    at phrase ``i`` (one phrase per slot, never colliding with the lead and
    never in a slot whose polyphony cap leaves no room for supports)."""
    n = len(lead)
    h = 0
    x = s
    while (
        x < n
        and lead[x][0] != clip
        and (slot_cap is None or slot_cap[x] > 0)
        and i + (x - s) <= _support_hi(lead_uses, n_phrases, x)
    ):
        h += 1
        x += 1
    return h


def plan_supports(
    clips: list[ClipPlanInput],
    lead: list[tuple[int, int]],
    contour: list[float],
    dens: list[int],
    cap: int,
    seed: int = 0,
    warnings: Optional[list[str]] = None,
) -> list[list[tuple[int, int]]]:
    """Support ``(clip, phrase_idx)`` entries per slot.

    Wants ``density - 1`` supports per slot. Candidates: not the lead, not a
    harmonic outlier, cursor-forward and strictly between the clip's lead
    uses; preferred with energy <= lead energy + 0.1 (soft +0.3), ranked by
    spectral contrast to the lead then fewest placements so far. A support
    holds >= MIN_SUPPORT_RUN slots; at most one change per non-drop line
    (a lead switch counts); polyphony is checked on the union of both sides
    of every line so crossfade tails never exceed ``cap``; when over density
    the oldest support exits; a support whose clip becomes the lead is
    promoted (no extra change).
    """
    n = len(lead)
    n_clips = len(clips)
    cap = max(1, int(cap))
    rng = random.Random(seed)
    lc = _lead_change_flags(lead)
    drop = [is_drop_line(contour, s) for s in range(n)]
    budget = _LineBudget(n, lc, drop)
    lead_uses: list[list[tuple[int, int]]] = [[] for _ in range(n_clips)]
    for s, (c, i) in enumerate(lead):
        lead_uses[c].append((s, i))
    n_ph = [len(c["phrases"]) for c in clips]
    cur = [0] * n_clips
    placed = [0] * n_clips
    active: list[_Sup] = []
    result: list[list[tuple[int, int]]] = [[] for _ in range(n)]
    prev_set: set[int] = set()
    # Supports allowed in slot x once the lead (and an adjacent lead switch's
    # crossfade tail) have taken their share of the polyphony cap.
    slot_cap = [
        max(
            0,
            cap - 1 - max(1 if lc[x] else 0, 1 if (x + 1 < n and lc[x + 1]) else 0),
        )
        for x in range(n)
    ]

    def exit_plan(c: int, s: int, i: int, min_slots: int) -> Optional[tuple[int, bool]]:
        """Latest line the support can leave at -> (line, needs_reservation)."""
        h = _horizon(c, lead, lead_uses[c], n_ph[c], s, i, slot_cap)
        if h < min_slots:
            return None
        for t in range(s + h, s + min_slots - 1, -1):
            if t >= n:
                return (n, False)
            if lead[t][0] == c and t == s + h:
                return (t, False)
            if budget.free(t):
                return (t, True)
        return None

    for s in range(n):
        lead_c, lead_i = lead[s]
        cur[lead_c] = max(cur[lead_c], lead_i + 1)
        lead_e = float(clips[lead_c]["phrases"][lead_i]["energy"])
        lead_cent = float(clips[lead_c]["centroid_hz"] or 0.0)
        want = max(0, dens[s] - 1)
        hard_cap = slot_cap[s]

        cont: list[_Sup] = []
        for a in active:
            c = a.clip
            if c == lead_c:
                budget.release(a.reserved)  # promoted: part of the lead switch
                continue
            if a.reserved == s:
                budget.use_reservation(s)
                continue
            if cur[c] > _support_hi(lead_uses[c], n_ph[c], s):
                budget.charge(s)
                if warnings is not None:
                    warnings.append(
                        f"support of clip {clips[c]['index']} forced out at line {s}"
                    )
                budget.release(a.reserved)
                continue
            cont.append(a)

        def drop_oldest() -> None:
            a = cont.pop(0)
            budget.release(a.reserved)
            budget.charge(s)

        while len(cont) > hard_cap:
            drop_oldest()
        while (
            len(cont) > want and budget.free(s) and cont[0].since <= s - MIN_SUPPORT_RUN
        ):
            drop_oldest()

        # candidates for entering at this line
        taken = {a.clip for a in cont}
        cands: list[tuple[float, int, int, int, bool]] = []
        for c in range(n_clips):
            clip = clips[c]
            if c == lead_c or c in taken or clip["harmonic_outlier"] or n_ph[c] == 0:
                continue
            hi = _support_hi(lead_uses[c], n_ph[c], s)
            best_c: Optional[tuple[float, int, int, bool]] = None
            for i in range(cur[c], hi + 1):
                plan = exit_plan(c, s, i, MIN_SUPPORT_RUN)
                if plan is None:
                    continue
                e = float(clip["phrases"][i]["energy"])
                cost = (
                    0.0 if e <= lead_e + _SUPPORT_ENERGY_SLACK else _SUPPORT_ENERGY_COST
                )
                cost += _SKIP_COST * (i - cur[c])
                cent = float(clip["centroid_hz"] or 0.0)
                if cent > 0 and lead_cent > 0:
                    contrast = min(2.0, abs(math.log2(cent / lead_cent))) / 2.0
                else:
                    contrast = 0.0
                cost -= _SUPPORT_CONTRAST_WEIGHT * contrast
                cost += _SUPPORT_REPEAT_COST * placed[c]
                cost += rng.random() * _JITTER
                if best_c is None or cost < best_c[0]:
                    best_c = (cost, i, plan[0], plan[1])
            if best_c is not None:
                cands.append((best_c[0], c, best_c[1], best_c[2], best_c[3]))
        cands.sort(key=lambda t: (t[0], t[1]))

        # rotate a long-held support out when someone else could take over
        if (
            cont
            and cands
            and budget.free(s)
            and cont[0].since <= s - MAX_SUPPORT_RUN
            and len(cont) >= want
        ):
            drop_oldest()

        for a in cont:
            c = a.clip
            result[s].append((c, cur[c]))
            cur[c] += 1
            placed[c] += 1

        # a new support must fit for its whole minimum hold, so entries are
        # bounded by the cap of the next MIN_SUPPORT_RUN - 1 slots as well
        target = min([want] + slot_cap[s : s + MIN_SUPPORT_RUN])
        new_active = list(cont)
        cur_set = {a.clip for a in cont}
        for cost, c, i, t, needs in cands:
            if len(new_active) >= target or not budget.free(s):
                break
            if c in cur_set:
                continue
            union = prev_set | cur_set | {c}
            if (1 + (1 if lc[s] else 0)) + len(union) > cap:
                continue
            # the plan may have been computed before this line's other
            # entries; re-check its exit line is still free
            if needs and not budget.free(t):
                plan = exit_plan(c, s, i, MIN_SUPPORT_RUN)
                if plan is None:
                    continue
                t, needs = plan
            if s > 0:
                budget.charge(s)
            if needs:
                budget.reserve(t)
            sup = _Sup(c, s, t if needs else None)
            new_active.append(sup)
            cur_set.add(c)
            result[s].append((c, i))
            cur[c] = i + 1
            placed[c] += 1

        active = new_active
        prev_set = cur_set

    return result


def _change_count(
    lead: list[tuple[int, int]], supports: list[list[tuple[int, int]]], s: int
) -> int:
    """Changes on line ``s``: lead switch + support ins/outs (promotions
    excluded). 0 for the timeline start."""
    if s <= 0 or s >= len(lead):
        return 0
    lc = _lead_change_flags(lead)
    before = {c for c, _ in supports[s - 1]}
    after = {c for c, _ in supports[s]}
    outs = {c for c in before - after if c != lead[s][0]}
    return int(lc[s]) + len(outs) + len(after - before)


def coverage_pass(
    clips: list[ClipPlanInput],
    lead: list[tuple[int, int]],
    supports: list[list[tuple[int, int]]],
    contour: list[float],
    cap: int,
    warnings: Optional[list[str]] = None,
) -> None:
    """Give every unplaced clip one support slot (mutates ``supports``).

    Picks the slot whose contour best matches one of the clip's phrases, on
    lines where no other change happens and the polyphony union holds;
    falls back to a line with another change (warned); harmonic outliers
    are never supports and are reported instead.
    """
    n = len(lead)
    if n == 0:
        return
    lc = _lead_change_flags(lead)
    placed = [0] * len(clips)
    for c, _ in lead:
        placed[c] += 1
    for row in supports:
        for c, _ in row:
            placed[c] += 1
    for c, clip in enumerate(clips):
        if placed[c] or not clip["phrases"]:
            continue
        if clip["harmonic_outlier"]:
            if warnings is not None:
                warnings.append(
                    f"clip {clip['index']} (harmonic outlier) could not be placed"
                )
            continue
        energies = [float(p["energy"]) for p in clip["phrases"]]
        ranked = sorted(
            range(n),
            key=lambda s: (min(abs(e - contour[s]) for e in energies), s),
        )
        pick: Optional[tuple[int, bool]] = None
        for strict in (True, False):
            for s in ranked:
                if lead[s][0] == c:
                    continue
                here = {cc for cc, _ in supports[s]}
                before = {cc for cc, _ in supports[s - 1]} if s > 0 else set()
                after = {cc for cc, _ in supports[s + 1]} if s + 1 < n else set()
                if 2 + len(here) > cap:
                    continue
                if s > 0 and (1 + int(lc[s])) + len(before | here | {c}) > cap:
                    continue
                if s + 1 < n and (1 + int(lc[s + 1])) + len(here | after | {c}) > cap:
                    continue
                if strict:
                    if (
                        s > 0
                        and _change_count(lead, supports, s) > 0
                        and not is_drop_line(contour, s)
                    ):
                        continue
                    if (
                        s + 1 < n
                        and _change_count(lead, supports, s + 1) > 0
                        and not is_drop_line(contour, s + 1)
                    ):
                        continue
                pick = (s, strict)
                break
            if pick is not None:
                break
        if pick is None:
            if warnings is not None:
                warnings.append(
                    f"clip {clip['index']} could not be placed (polyphony cap {cap})"
                )
            continue
        s, strict = pick
        i = min(range(len(energies)), key=lambda k: (abs(energies[k] - contour[s]), k))
        supports[s].append((c, i))
        if warnings is not None:
            msg = f"clip {clip['index']} placed by coverage pass at slot {s}"
            if not strict:
                msg += " (on a line with another change)"
            warnings.append(msg)


# --------------------------------------------------------------------------
# runs
# --------------------------------------------------------------------------


def assign_role(lane: Lane, has_stems: bool) -> Role:
    """Lead -> 'full' ('stem_found' with stems: the renderer places found +
    layer for it); support -> 'hp' ('stem_layer' with stems)."""
    if lane == "lead":
        return "stem_found" if has_stems else "full"
    return "stem_layer" if has_stems else "hp"


def build_runs(
    lead: list[tuple[int, int]],
    supports: list[list[tuple[int, int]]],
    clips: list[ClipPlanInput],
    slot_bars: list[int],
    bar_sec: float,
) -> list[Run]:
    """Merge consecutive slots with the same (clip, lane) and consecutive
    phrase indices into runs. ``src_start`` is the first phrase's SOURCE
    start; ``src_end`` covers exactly the run's output span (so a merged
    long final slot keeps playing contiguous source audio)."""
    edges = _slot_edges(slot_bars, bar_sec)
    n = len(lead)
    open_runs: dict[tuple[int, Lane], dict] = {}
    finished: list[dict] = []

    def close(key: tuple[int, Lane]) -> None:
        r = open_runs.pop(key, None)
        if r is not None:
            finished.append(r)

    for s in range(n):
        items: list[tuple[int, int, Lane]] = [(lead[s][0], lead[s][1], "lead")]
        items += [(c, i, "support") for c, i in supports[s]]
        seen: set[tuple[int, Lane]] = set()
        for c, i, lane in items:
            key = (c, lane)
            seen.add(key)
            r = open_runs.get(key)
            if r is not None and r["last_slot"] == s - 1 and r["last_phrase"] + 1 == i:
                r["last_slot"] = s
                r["last_phrase"] = i
                continue
            close(key)
            open_runs[key] = {
                "clip": c,
                "lane": lane,
                "first_phrase": i,
                "last_phrase": i,
                "first_slot": s,
                "last_slot": s,
            }
        for key in list(open_runs):
            if key not in seen:
                close(key)
    for key in list(open_runs):
        close(key)

    finished.sort(
        key=lambda r: (r["first_slot"], 0 if r["lane"] == "lead" else 1, r["clip"])
    )
    runs: list[Run] = []
    for rid, r in enumerate(finished):
        clip = clips[r["clip"]]
        ratio = float(clip["ratio"]) if clip["ratio"] and clip["ratio"] > 0 else 1.0
        out_start = edges[r["first_slot"]]
        out_end = edges[r["last_slot"] + 1]
        src_start = float(clip["phrases"][r["first_phrase"]]["start_sec"])
        src_end = src_start + (out_end - out_start) * ratio
        runs.append(
            {
                "run_id": rid,
                "clip": r["clip"],
                "lane": r["lane"],
                "role": assign_role(r["lane"], bool(clip["has_stems"])),
                "first_phrase": r["first_phrase"],
                "last_phrase": r["last_phrase"],
                "output_start_sec": float(out_start),
                "output_end_sec": float(out_end),
                "src_start_sec": src_start,
                "src_end_sec": float(src_end),
                "fade_in_sec": 0.0,
                "fade_out_sec": 0.0,
                "gain_db": 0.0,
            }
        )
    return runs


# --------------------------------------------------------------------------
# seams
# --------------------------------------------------------------------------


def _auto_transition_bars(arc: str) -> float:
    return 2.0 if arc == "flat" else 1.0


def compute_seams(
    runs: list[Run],
    contour: list[float],
    bar_sec: float,
    beat_sec: float,
    transition_bars: float,
    clips: list[ClipPlanInput],
    slot_bars: list[int],
    arc: str = "song",
    polyphony_cap: int = 3,
) -> tuple[list[Seam], list[Run]]:
    """Fill run fade tails and emit seams at every slot line.

    lead_switch -> 'blend' over L bars (auto: 1 for song/rise, 2 for flat;
    doubled when either clip has downbeat_confidence < 0.15 or is not
    steady; capped at half the shortest slot): incoming fade_in L bars
    BEFORE the line, outgoing fade_out L bars after, heal +/- L/2 bar.
    drop -> 'cut': 1-beat fades, heal [line - 1 beat, line + 1 bar].
    support_in / support_out -> 'fade' 1 bar, heal +/- 1 beat. A support
    that becomes the lead at the same line is promoted (no extra seam).
    Pre-roll is clamped to the material before ``src_start`` and to the
    timeline start; post-roll to the timeline end; timeline edges fade 0.
    With ``polyphony_cap`` < 2 there is no room for a crossfade partner, so
    every lead switch becomes a zero-tail 'cut' (heal +/- 1 beat).
    """
    edges = _slot_edges(slot_bars, bar_sec)
    total = edges[-1]
    eps = 1e-6
    min_slot = min(slot_bars) if slot_bars else MIN_SLOT_BARS
    max_l = max(0.25, min_slot / 2.0)
    no_tails = int(polyphony_cap) < 2
    seams: list[Seam] = []

    def clamp_in(r: Run, want: float) -> float:
        ratio = float(clips[r["clip"]]["ratio"]) or 1.0
        avail = r["src_start_sec"] / ratio if ratio > 0 else want
        v = max(0.0, min(want, avail, r["output_start_sec"]))
        r["fade_in_sec"] = float(v)
        return v

    def clamp_out(r: Run, want: float) -> float:
        v = max(0.0, min(want, total - r["output_end_sec"]))
        r["fade_out_sec"] = float(v)
        return v

    for s in range(1, len(edges) - 1):
        line = edges[s]
        starts = [r for r in runs if abs(r["output_start_sec"] - line) < eps]
        ends = [r for r in runs if abs(r["output_end_sec"] - line) < eps]
        lead_in = [r for r in starts if r["lane"] == "lead"]
        lead_out = [r for r in ends if r["lane"] == "lead"]
        sup_in = [r for r in starts if r["lane"] == "support"]
        sup_out = [r for r in ends if r["lane"] == "support"]
        drop = is_drop_line(contour, s)
        promoted: set[int] = set()
        if lead_in and lead_out:
            inc, outg = lead_in[0], lead_out[0]
            promoted = {r["clip"] for r in sup_out if r["clip"] == inc["clip"]}
            if no_tails:
                inc["fade_in_sec"] = 0.0
                outg["fade_out_sec"] = 0.0
                seams.append(
                    {
                        "sec": float(line),
                        "kind": "drop" if drop else "lead_switch",
                        "transition": "cut",
                        "bars": 0.0,
                        "heal_start_sec": float(max(0.0, line - beat_sec)),
                        "heal_end_sec": float(min(total, line + beat_sec)),
                        "clips": [outg["clip"], inc["clip"]],
                        "lanes": ["lead", "lead"],
                    }
                )
            elif drop:
                clamp_in(inc, beat_sec)
                clamp_out(outg, beat_sec)
                seams.append(
                    {
                        "sec": float(line),
                        "kind": "drop",
                        "transition": "cut",
                        "bars": float(beat_sec / bar_sec),
                        "heal_start_sec": float(max(0.0, line - beat_sec)),
                        "heal_end_sec": float(min(total, line + bar_sec)),
                        "clips": [outg["clip"], inc["clip"]],
                        "lanes": ["lead", "lead"],
                    }
                )
            else:
                length = (
                    float(transition_bars)
                    if transition_bars > 0
                    else _auto_transition_bars(arc)
                )
                shaky = any(
                    float(clips[r["clip"]]["downbeat_confidence"]) < 0.15
                    or not clips[r["clip"]]["steady"]
                    for r in (inc, outg)
                )
                if shaky:
                    length *= 2.0
                length = min(length, max_l)
                clamp_in(inc, length * bar_sec)
                clamp_out(outg, length * bar_sec)
                half = length * bar_sec / 2.0
                seams.append(
                    {
                        "sec": float(line),
                        "kind": "lead_switch",
                        "transition": "blend",
                        "bars": float(length),
                        "heal_start_sec": float(max(0.0, line - half)),
                        "heal_end_sec": float(min(total, line + half)),
                        "clips": [outg["clip"], inc["clip"]],
                        "lanes": ["lead", "lead"],
                    }
                )
        for r in sup_in:
            clamp_in(r, bar_sec)
            seams.append(
                {
                    "sec": float(line),
                    "kind": "support_in",
                    "transition": "fade",
                    "bars": 1.0,
                    "heal_start_sec": float(max(0.0, line - beat_sec)),
                    "heal_end_sec": float(min(total, line + beat_sec)),
                    "clips": [r["clip"]],
                    "lanes": ["support"],
                }
            )
        for r in sup_out:
            clamp_out(r, bar_sec)
            if r["clip"] in promoted:
                continue
            seams.append(
                {
                    "sec": float(line),
                    "kind": "support_out",
                    "transition": "fade",
                    "bars": 1.0,
                    "heal_start_sec": float(max(0.0, line - beat_sec)),
                    "heal_end_sec": float(min(total, line + beat_sec)),
                    "clips": [r["clip"]],
                    "lanes": ["support"],
                }
            )
    seams.sort(key=lambda x: (x["sec"], x["kind"]))
    return seams, runs


def _union_length(intervals: list[tuple[float, float]]) -> float:
    if not intervals:
        return 0.0
    ivs = sorted(intervals)
    total = 0.0
    cs, ce = ivs[0]
    for a, b in ivs[1:]:
        if a <= ce:
            ce = max(ce, b)
        else:
            total += ce - cs
            cs, ce = a, b
    total += ce - cs
    return total


def seam_budget(
    seams: list[Seam],
    total_sec: float,
    max_ratio: float = 0.35,
    min_sec: float = 0.5,
) -> list[Seam]:
    """Widen every heal window to >= ``min_sec``; if the union of windows
    exceeds ``max_ratio * total_sec`` shrink them all about their seam
    (never below ``min_sec``). Mutates and returns ``seams``."""
    if not seams or total_sec <= 0:
        return seams
    for sm in seams:
        w = sm["heal_end_sec"] - sm["heal_start_sec"]
        if w < min_sec:
            grow = (min_sec - w) / 2.0
            sm["heal_start_sec"] -= grow
            sm["heal_end_sec"] += grow
        sm["heal_start_sec"] = float(max(0.0, sm["heal_start_sec"]))
        sm["heal_end_sec"] = float(min(total_sec, sm["heal_end_sec"]))
    used = _union_length([(s["heal_start_sec"], s["heal_end_sec"]) for s in seams])
    allowed = max_ratio * total_sec
    if used > allowed and used > 0:
        f = allowed / used
        for sm in seams:
            left = sm["sec"] - sm["heal_start_sec"]
            right = sm["heal_end_sec"] - sm["sec"]
            w = left + right
            new_w = max(min_sec, w * f)
            scale = new_w / w if w > 0 else 1.0
            sm["heal_start_sec"] = float(max(0.0, sm["sec"] - left * scale))
            sm["heal_end_sec"] = float(min(total_sec, sm["sec"] + right * scale))
    return seams


# --------------------------------------------------------------------------
# sections / placements
# --------------------------------------------------------------------------


def sections(
    contour: list[float], slot_bars: list[int], bar_sec: float
) -> list[Section]:
    """Label the contour: leading < .3 'intro', trailing < .3 'outro',
    >= .85 'peak', rising 'build', falling 'release', else 'body'."""
    n = len(contour)
    if n == 0:
        return []
    labels = [""] * n
    s = 0
    while s < n and contour[s] < 0.3:
        labels[s] = "intro"
        s += 1
    e = n - 1
    while e >= s and contour[e] < 0.3:
        labels[e] = "outro"
        e -= 1
    for k in range(s, e + 1):
        v = contour[k]
        if v >= 0.85:
            labels[k] = "peak"
        elif k > 0 and v > contour[k - 1] + 1e-9:
            labels[k] = "build"
        elif k > 0 and v < contour[k - 1] - 1e-9:
            labels[k] = "release"
        else:
            labels[k] = "body"
    edges = _slot_edges(slot_bars, bar_sec)
    out: list[Section] = []
    start = 0
    for k in range(1, n + 1):
        if k == n or labels[k] != labels[start]:
            seg = contour[start:k]
            out.append(
                {
                    "start_sec": float(edges[start]),
                    "end_sec": float(edges[k]),
                    "label": labels[start],
                    "target_energy": float(sum(seg) / len(seg)),
                }
            )
            start = k
    return out


def placements_from_runs(
    runs: list[Run],
    clips: list[ClipPlanInput],
    slot_bars: list[int],
    bar_sec: float,
) -> list[Placement]:
    """One placement per (run, slot). ``output_*`` is the AUDIBLE span (slot
    edges extended by the run's tails on its first/last slot);
    ``nominal_*`` the slot edges; ``window_*`` the phrase in CONFORMED
    seconds; ``chunk_idx`` == phrase index; ``rms`` = 10 ** (lufs / 20)."""
    edges = _slot_edges(slot_bars, bar_sec)
    eps = 1e-6
    out: list[Placement] = []
    for r in runs:
        clip = clips[r["clip"]]
        ratio = float(clip["ratio"]) if clip["ratio"] and clip["ratio"] > 0 else 1.0
        first_slot = next(
            k
            for k in range(len(slot_bars))
            if abs(edges[k] - r["output_start_sec"]) < eps
        )
        last_slot = next(
            k
            for k in range(len(slot_bars))
            if abs(edges[k + 1] - r["output_end_sec"]) < eps
        )
        for k in range(first_slot, last_slot + 1):
            idx = min(len(clip["phrases"]) - 1, r["first_phrase"] + (k - first_slot))
            ph = clip["phrases"][idx]
            nom_s, nom_e = edges[k], edges[k + 1]
            aud_s = nom_s - (r["fade_in_sec"] if k == first_slot else 0.0)
            aud_e = nom_e + (r["fade_out_sec"] if k == last_slot else 0.0)
            w_s = float(ph["start_sec"]) / ratio
            lufs = float(ph["lufs"])
            out.append(
                {
                    "output_start_sec": float(aud_s),
                    "output_end_sec": float(aud_e),
                    "window_start_sec": float(w_s),
                    "window_end_sec": float(w_s + (nom_e - nom_s)),
                    "chunk_idx": int(idx),
                    "rms": float(10 ** (lufs / 20.0)) if math.isfinite(lufs) else 0.0,
                    "clip": int(r["clip"]),
                    "phrase_idx": int(idx),
                    "lane": r["lane"],
                    "role": r["role"],
                    "run_id": int(r["run_id"]),
                    "gain_db": float(r["gain_db"]),
                    "fade_in_sec": float(r["fade_in_sec"] if k == first_slot else 0.0),
                    "fade_out_sec": float(r["fade_out_sec"] if k == last_slot else 0.0),
                    "nominal_start_sec": float(nom_s),
                    "nominal_end_sec": float(nom_e),
                }
            )
    out.sort(key=lambda p: (p["nominal_start_sec"], p["lane"] != "lead", p["clip"]))
    return out


# --------------------------------------------------------------------------
# composition
# --------------------------------------------------------------------------


def plan_timeline(
    clips: list[ClipPlanInput],
    tl: TimelinePlan,
    bar_sec: float,
    beat_sec: float,
    polyphony_cap: int = 3,
    arc: str = "song",
    transition_bars: float = 0.0,
    seed: int = 0,
) -> Schedule:
    """Compose the whole arrangement (see the module docstring for the
    invariants). ``clips`` phrase energies are normalised in place."""
    warnings: list[str] = []
    slot_bars = list(tl["slot_bars"])
    n = len(slot_bars)
    total_sec = float(sum(slot_bars) * bar_sec)
    phrase_bars = max(slot_bars) if slot_bars else 0
    cap = max(1, int(polyphony_cap))
    contour = energy_contour(n, arc)
    dens = density(contour, cap, arc)
    normalize_energy(clips)
    base: Schedule = {
        "total_sec": total_sec,
        "total_bars": int(tl["total_bars"]),
        "bar_sec": float(bar_sec),
        "beat_sec": float(beat_sec),
        "phrase_bars": int(phrase_bars),
        "n_slots": n,
        "slot_bars": slot_bars,
        "contour": contour,
        "density": dens,
        "lead_by_slot": [],
        "runs": [],
        "placements": [],
        "seams": [],
        "sections": sections(contour, slot_bars, bar_sec),
        "warnings": warnings,
    }
    if n == 0 or not any(c["phrases"] for c in clips):
        warnings.append("no phrases to arrange")
        return base
    for c in clips:
        if not c["phrases"]:
            warnings.append(f"clip {c['index']} has no phrases and cannot be placed")

    lead = plan_lead(clips, contour, slot_bars, seed, warnings)
    supports = plan_supports(clips, lead, contour, dens, cap, seed, warnings)
    coverage_pass(clips, lead, supports, contour, cap, warnings)
    runs = build_runs(lead, supports, clips, slot_bars, bar_sec)
    seams, runs = compute_seams(
        runs,
        contour,
        bar_sec,
        beat_sec,
        transition_bars,
        clips,
        slot_bars,
        arc=arc,
        polyphony_cap=cap,
    )
    seams = seam_budget(seams, total_sec)
    placements = placements_from_runs(runs, clips, slot_bars, bar_sec)
    base["lead_by_slot"] = [c for c, _ in lead]
    base["runs"] = runs
    base["placements"] = placements
    base["seams"] = seams
    log.debug(
        "plan_timeline: %d slots, %d runs, %d placements, %d seams, cap %d, arc %s",
        n,
        len(runs),
        len(placements),
        len(seams),
        cap,
        arc,
    )
    return base


# keep the beats-per-bar constant importable from here for callers that
# derive beat_sec from bar_sec
BEATS_PER_BAR_V2 = BEATS_PER_BAR
