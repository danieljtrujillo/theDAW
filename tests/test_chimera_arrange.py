"""Unit tests for backend.modules.chimera.arrange (pure planner, no audio).

Fake phrase tables only: three clips with energy ramps (one flat, one
harmonic outlier, one with stems), a wider five-clip stack for the support
lane, and a ramp-only stack for contour tracking. The planner invariants
listed in the module docstring are the acceptance criteria here.
"""

from __future__ import annotations

import copy
import json

import numpy as np
import pytest

from backend.modules.chimera import arrange as A
from backend.modules.chimera.types import Phrase

BAR_SEC = 2.0  # 120 BPM
BEAT_SEC = 0.5
P = 8  # phrase bars


def _phrases(lufs: list[float], bars: int = P, bar_src: float = 2.0) -> list[Phrase]:
    out: list[Phrase] = []
    for i, level in enumerate(lufs):
        out.append(
            {
                "idx": i,
                "start_bar": i * bars,
                "bars": bars,
                "start_sec": i * bars * bar_src,
                "end_sec": (i + 1) * bars * bar_src,
                "lufs": float(level),
                "energy": 0.0,
                "low_frac": 0.3,
                "onset_density": 2.0,
                "centroid_hz": 1500.0,
                "section_label": "body",
            }
        )
    return out


def _clip(index: int, lufs: list[float], **kw) -> A.ClipPlanInput:
    d: dict = {
        "index": index,
        "phrases": _phrases(lufs),
        "weight": 1.0,
        "is_base": False,
        "tonal": True,
        "harmonic_outlier": False,
        "downbeat_confidence": 0.6,
        "steady": True,
        "has_stems": False,
        "ratio": 1.0,
        "centroid_hz": 1500.0,
    }
    d.update(kw)
    return d  # type: ignore[return-value]


def stack() -> list[A.ClipPlanInput]:
    """3 clips: base ramp, harmonic outlier with the quietest intro, flat
    clip with stems."""
    return [
        _clip(
            0, [-26, -27, -23, -18, -14, -15, -21, -29], is_base=True, centroid_hz=1200
        ),
        _clip(
            1,
            [-29, -32, -25, -20, -16, -13, -22, -31],
            harmonic_outlier=True,
            centroid_hz=2500,
        ),
        _clip(2, [-20] * 6, has_stems=True, centroid_hz=800, ratio=1.25),
    ]


def wide_stack() -> list[A.ClipPlanInput]:
    """The base stack plus two more ramps so the support lane fills."""
    c = stack()
    c.append(_clip(3, [-28, -24, -19, -15, -17, -23, -29], centroid_hz=600))
    c.append(_clip(4, [-27, -24, -19, -15, -17, -23, -29], centroid_hz=1500))
    return c


def ramp_stack() -> list[A.ClipPlanInput]:
    """Three song-shaped ramps, no flat clip and no outlier."""
    return [
        _clip(
            0, [-30, -27, -23, -18, -14, -15, -21, -29], is_base=True, centroid_hz=1200
        ),
        _clip(1, [-32, -29, -25, -20, -16, -13, -22, -31], centroid_hz=2500),
        _clip(2, [-31, -26, -22, -17, -13, -19, -28], centroid_hz=800),
    ]


def _plan(
    clips: list[A.ClipPlanInput],
    bars: int = 96,
    cap: int = 3,
    arc: str = "song",
    seed: int = 0,
    transition_bars: float = 0.0,
):
    tl = A.resolve_timeline(120.0, "median", 0.0, bars, None, P)
    return A.plan_timeline(
        clips, tl, BAR_SEC, BEAT_SEC, cap, arc, transition_bars, seed
    )


def _max_polyphony(sched, step: float = 0.25) -> int:
    spans = [(p["output_start_sec"], p["output_end_sec"]) for p in sched["placements"]]
    worst = 0
    t = 0.0
    while t < sched["total_sec"]:
        worst = max(worst, sum(1 for a, b in spans if a <= t < b))
        t += step
    return worst


def _lines(sched) -> list[float]:
    edges = [0.0]
    for b in sched["slot_bars"]:
        edges.append(edges[-1] + b * sched["bar_sec"])
    return edges[1:-1]


def _spearman(x: list[float], y: list[float]) -> float:
    def rank(v):
        order = np.argsort(v)
        r = np.empty(len(v))
        r[order] = np.arange(len(v))
        return r

    return float(np.corrcoef(rank(np.asarray(x)), rank(np.asarray(y)))[0, 1])


_CONFIGS = [
    (stack, 96, 3, "song"),
    (stack, 48, 3, "song"),
    (wide_stack, 96, 3, "song"),
    (wide_stack, 96, 3, "flat"),
    (wide_stack, 80, 4, "rise"),
    (wide_stack, 96, 2, "song"),
    (ramp_stack, 96, 1, "song"),
]


# --------------------------------------------------------------------------
# timeline / contour
# --------------------------------------------------------------------------


def test_resolve_timeline_variants():
    tl = A.resolve_timeline(120.0, "median", 0.0, 90, None, P)
    assert tl["total_bars"] == 90
    assert tl["length_source"] == "weave_total_bars"
    assert sum(tl["slot_bars"]) == 90
    assert tl["bpm"] == pytest.approx(120.0)

    tl = A.resolve_timeline(120.0, "median", 110.0, 0, None, P)
    assert tl["total_bars"] == 55
    assert tl["tempo_fit_pct"] == pytest.approx(0.0)
    assert tl["bpm"] == pytest.approx(120.0)
    assert tl["length_source"] == "target_duration"

    tl = A.resolve_timeline(120.0, "median", 111.0, 0, None, P)
    assert tl["total_bars"] == 56
    assert tl["bpm"] == pytest.approx(121.08, abs=0.01)
    assert 0 < tl["tempo_fit_pct"] < 3.0

    # a user tempo is never nudged
    tl = A.resolve_timeline(120.0, "user", 111.0, 0, None, P)
    assert tl["bpm"] == pytest.approx(120.0)
    assert tl["total_bars"] == 55

    tl = A.resolve_timeline(120.0, "base_clip", 0.0, 0, 40.0, P)
    assert tl["total_bars"] == 20
    assert tl["length_source"] == "base clip"
    # the base clip is capped by an explicit target duration
    tl = A.resolve_timeline(120.0, "base_clip", 24.0, 0, 40.0, P)
    assert tl["total_bars"] == 12

    tl = A.resolve_timeline(120.0, "median", 0.0, 0, None, P)
    assert tl["total_bars"] == 90
    assert tl["length_source"] == "default"

    tl = A.resolve_timeline(120.0, "median", 0.0, 300, None, P)
    assert tl["total_bars"] == 256


def test_short_final_slot_merged():
    tl = A.resolve_timeline(120.0, "median", 0.0, 17, None, P)
    assert tl["slot_bars"] == [8, 9]
    assert tl["n_slots"] == 2
    tl = A.resolve_timeline(120.0, "median", 0.0, 20, None, P)
    assert tl["slot_bars"] == [8, 8, 4]
    tl = A.resolve_timeline(120.0, "median", 0.0, 16, None, P)
    assert tl["slot_bars"] == [8, 8]


def test_contour_shapes_and_density():
    song = A.energy_contour(12, "song")
    assert len(song) == 12
    assert song[0] == pytest.approx(0.15)
    assert song[-1] == pytest.approx(0.1)
    assert max(song) >= 0.85
    d = A.density(song, 3, "song")
    assert d[0] <= 2 and d[-1] <= 2
    assert max(d) == 3
    assert all(1 <= x <= 3 for x in d)
    flat = A.energy_contour(6, "flat")
    assert flat == [0.7] * 6
    assert A.density(flat, 3, "flat") == [3] * 6
    rise = A.energy_contour(5, "rise")
    assert rise[0] == pytest.approx(0.1)
    assert rise[-1] == pytest.approx(0.6)
    assert A.energy_contour(1, "song") == [pytest.approx(0.15)]
    with pytest.raises(ValueError):
        A.energy_contour(4, "spiral")


def test_normalize_energy_across_stack():
    clips = stack()
    A.normalize_energy(clips)
    energies = [p["energy"] for c in clips for p in c["phrases"]]
    assert min(energies) == pytest.approx(0.0)
    assert max(energies) == pytest.approx(1.0)
    # the quietest phrase in the whole stack is clip 1 phrase 1
    assert clips[1]["phrases"][1]["energy"] == pytest.approx(0.0)
    flat = [_clip(0, [-20.0, -20.4, -19.8])]
    A.normalize_energy(flat)
    assert all(p["energy"] == 0.5 for p in flat[0]["phrases"])


def test_sections_labels():
    sched = _plan(stack(), 96)
    labels = [s["label"] for s in sched["sections"]]
    assert labels[0] == "intro"
    assert labels[-1] == "outro"
    assert "peak" in labels and "build" in labels and "release" in labels
    assert sched["sections"][0]["start_sec"] == 0.0
    assert sched["sections"][-1]["end_sec"] == pytest.approx(sched["total_sec"])
    for a, b in zip(sched["sections"], sched["sections"][1:]):
        assert a["end_sec"] == pytest.approx(b["start_sec"])


# --------------------------------------------------------------------------
# lead lane
# --------------------------------------------------------------------------


@pytest.mark.parametrize("make,bars,cap,arc", _CONFIGS)
def test_lead_starts_at_phrase_zero_and_ends_at_last(make, bars, cap, arc):
    clips = make()
    sched = _plan(clips, bars, cap, arc)
    leads = [p for p in sched["placements"] if p["lane"] == "lead"]
    leads.sort(key=lambda p: p["nominal_start_sec"])
    assert leads[0]["nominal_start_sec"] == 0.0
    assert leads[0]["phrase_idx"] == 0
    last = leads[-1]
    assert last["nominal_end_sec"] == pytest.approx(sched["total_sec"])
    if arc == "song":
        # the outro preference is a cost, not a rule: arcs that do not end
        # quietly (flat, rise) may legitimately keep a louder phrase at the end
        assert last["phrase_idx"] == len(clips[last["clip"]]["phrases"]) - 1
    assert len(leads) == sched["n_slots"]
    assert sched["lead_by_slot"] == [p["clip"] for p in leads]


def test_lead_energy_tracks_contour():
    clips = ramp_stack()
    sched = _plan(clips, 96, 3, "song")
    assert sched["n_slots"] == 12
    leads = sorted(
        (p for p in sched["placements"] if p["lane"] == "lead"),
        key=lambda p: p["nominal_start_sec"],
    )
    energies = [clips[p["clip"]]["phrases"][p["phrase_idx"]]["energy"] for p in leads]
    rho = _spearman(energies, sched["contour"])
    assert rho > 0.6, rho


def test_lead_runs_respect_min_and_max_hold():
    sched = _plan(wide_stack(), 96, 3, "song")
    lead_runs = [r for r in sched["runs"] if r["lane"] == "lead"]
    slots = [
        round((r["output_end_sec"] - r["output_start_sec"]) / (P * BAR_SEC))
        for r in lead_runs
    ]
    # variety appears: no single clip leads the whole timeline
    assert len({r["clip"] for r in lead_runs}) >= 2
    # every run but the last holds at least MIN_RUN slots unless its clip
    # ran out of phrases at that point
    for r, n in zip(lead_runs[:-1], slots[:-1]):
        exhausted = r["last_phrase"] == len(wide_stack()[r["clip"]]["phrases"]) - 1
        assert n >= A.MIN_RUN or exhausted


# --------------------------------------------------------------------------
# invariants across lanes
# --------------------------------------------------------------------------


@pytest.mark.parametrize("make,bars,cap,arc", _CONFIGS)
def test_per_clip_phrase_order_monotonic_across_lanes(make, bars, cap, arc):
    sched = _plan(make(), bars, cap, arc)
    by_clip: dict[int, list[int]] = {}
    for p in sorted(sched["placements"], key=lambda p: p["nominal_start_sec"]):
        by_clip.setdefault(p["clip"], []).append(p["phrase_idx"])
    for c, seq in by_clip.items():
        assert seq == sorted(seq), (c, seq)
    for p in sched["placements"]:
        assert p["chunk_idx"] == p["phrase_idx"]


@pytest.mark.parametrize("make,bars,cap,arc", _CONFIGS)
def test_one_change_per_line_except_drops(make, bars, cap, arc):
    sched = _plan(make(), bars, cap, arc)
    contour = sched["contour"]
    for s, line in enumerate(_lines(sched), start=1):
        at_line = [x for x in sched["seams"] if abs(x["sec"] - line) < 1e-6]
        if A.is_drop_line(contour, s):
            assert any(x["kind"] == "drop" for x in at_line) or all(
                x["kind"] != "lead_switch" for x in at_line
            )
            continue
        assert len(at_line) <= 1, (line, at_line)
        assert all(x["kind"] != "drop" for x in at_line)
    # every run boundary inside the timeline is covered by a seam at its line
    seam_secs = {round(x["sec"], 6) for x in sched["seams"]}
    for r in sched["runs"]:
        if r["output_start_sec"] > 0:
            assert round(r["output_start_sec"], 6) in seam_secs
        if r["output_end_sec"] < sched["total_sec"] - 1e-6:
            assert round(r["output_end_sec"], 6) in seam_secs


@pytest.mark.parametrize("make,bars,cap,arc", _CONFIGS)
def test_polyphony_cap_counts_tails(make, bars, cap, arc):
    sched = _plan(make(), bars, cap, arc)
    assert _max_polyphony(sched) <= cap
    if cap < 2:
        # no room for a crossfade partner: every seam is a zero-tail cut
        assert all(
            p["output_start_sec"] == p["nominal_start_sec"]
            and p["output_end_sec"] == p["nominal_end_sec"]
            for p in sched["placements"]
        )
        assert all(
            s["transition"] == "cut" and s["bars"] == 0.0 for s in sched["seams"]
        )
        return
    # tails really are part of the audible spans
    assert any(
        p["output_start_sec"] < p["nominal_start_sec"]
        or p["output_end_sec"] > p["nominal_end_sec"]
        for p in sched["placements"]
    )


@pytest.mark.parametrize("make,bars,cap,arc", [c for c in _CONFIGS if c[2] >= 3])
def test_every_clip_represented(make, bars, cap, arc):
    clips = make()
    sched = _plan(clips, bars, cap, arc)
    placed = {p["clip"] for p in sched["placements"]}
    for c in clips:
        if c["index"] in placed:
            continue
        # a harmonic outlier can only ever lead; when the arc never lets it
        # (flat), it is reported rather than forced in as a clashing support
        assert c["harmonic_outlier"], sched["warnings"]
        assert any(
            f"clip {c['index']} (harmonic outlier)" in w for w in sched["warnings"]
        )
    non_outliers = {c["index"] for c in clips if not c["harmonic_outlier"]}
    assert non_outliers <= placed, sched["warnings"]
    if arc != "flat":
        assert placed == {c["index"] for c in clips}, sched["warnings"]


@pytest.mark.parametrize("make,bars,cap,arc", _CONFIGS)
def test_outlier_never_support(make, bars, cap, arc):
    clips = make()
    sched = _plan(clips, bars, cap, arc)
    outliers = {c["index"] for c in clips if c["harmonic_outlier"]}
    if not outliers:
        pytest.skip("stack has no harmonic outlier")
    for p in sched["placements"]:
        if p["clip"] in outliers:
            assert p["lane"] == "lead"


@pytest.mark.parametrize("make,bars,cap,arc", _CONFIGS)
def test_supports_hold_two_slots(make, bars, cap, arc):
    sched = _plan(make(), bars, cap, arc)
    sup_runs = [r for r in sched["runs"] if r["lane"] == "support"]
    if cap >= 3 and arc != "song":
        assert sup_runs
    covered = {int(w.split()[1]) for w in sched["warnings"] if "coverage pass" in w}
    for r in sup_runs:
        n_slots = round((r["output_end_sec"] - r["output_start_sec"]) / (P * BAR_SEC))
        assert n_slots >= A.MIN_SUPPORT_RUN or r["clip"] in covered, r
        assert r["role"] in ("hp", "stem_layer")
    for r in sched["runs"]:
        if r["lane"] == "lead":
            assert r["role"] in ("full", "stem_found")


def test_roles_follow_stems():
    sched = _plan(wide_stack(), 96, 3, "flat")
    for r in sched["runs"]:
        if r["clip"] == 2:  # has_stems
            assert r["role"] == ("stem_found" if r["lane"] == "lead" else "stem_layer")
        else:
            assert r["role"] == ("full" if r["lane"] == "lead" else "hp")
    assert A.assign_role("lead", False) == "full"
    assert A.assign_role("support", True) == "stem_layer"


# --------------------------------------------------------------------------
# runs / seams
# --------------------------------------------------------------------------


def test_runs_merge_contiguous_phrases():
    clips = [_clip(0, [-20.0, -20.0, -20.0])]
    sched = _plan(clips, 24, 3, "flat")
    assert sched["n_slots"] == 3
    assert len(sched["runs"]) == 1
    r = sched["runs"][0]
    assert (r["first_phrase"], r["last_phrase"]) == (0, 2)
    assert r["output_start_sec"] == 0.0
    assert r["output_end_sec"] == pytest.approx(48.0)
    assert r["src_start_sec"] == 0.0
    assert r["src_end_sec"] == pytest.approx(48.0)
    assert sched["seams"] == []
    assert r["fade_in_sec"] == 0.0 and r["fade_out_sec"] == 0.0
    assert [p["chunk_idx"] for p in sched["placements"]] == [0, 1, 2]


def test_run_source_span_follows_ratio_and_merged_slot():
    clips = [_clip(0, [-20.0] * 2, ratio=1.25)]
    tl = A.resolve_timeline(120.0, "median", 0.0, 17, None, P)  # slots [8, 9]
    sched = A.plan_timeline(clips, tl, BAR_SEC, BEAT_SEC, 3, "flat", 0.0, 0)
    r = sched["runs"][0]
    assert r["output_end_sec"] == pytest.approx(34.0)
    # 17 bars of output = 34 s -> 42.5 s of source at ratio 1.25
    assert r["src_end_sec"] == pytest.approx(34.0 * 1.25)
    p0, p1 = sched["placements"]
    assert p0["window_start_sec"] == pytest.approx(0.0)
    assert p0["window_end_sec"] == pytest.approx(16.0)
    assert p1["window_start_sec"] == pytest.approx(16.0 / 1.25)
    assert p1["window_end_sec"] == pytest.approx(16.0 / 1.25 + 18.0)


def _hand_runs(clips, contour):
    # entering runs start at phrase 1 so a whole phrase of source material
    # exists before them (pre-roll is clamped to the material available)
    lead = [(0, 0), (0, 1), (1, 1), (1, 2)]
    supports = [[], [(2, 1)], [(2, 2)], []]
    slot_bars = [P] * 4
    runs = A.build_runs(lead, supports, clips, slot_bars, BAR_SEC)
    seams, runs = A.compute_seams(
        runs, contour, BAR_SEC, BEAT_SEC, 0.0, clips, slot_bars, arc="song"
    )
    return seams, runs


def test_seams_types_and_heal_windows():
    clips = ramp_stack()
    A.normalize_energy(clips)
    seams, runs = _hand_runs(clips, [0.2, 0.4, 0.6, 0.8])
    kinds = {(s["sec"], s["kind"]) for s in seams}
    assert kinds == {(16.0, "support_in"), (32.0, "lead_switch"), (48.0, "support_out")}
    sw = next(s for s in seams if s["kind"] == "lead_switch")
    assert sw["transition"] == "blend"
    assert sw["bars"] == 1.0
    assert (sw["heal_start_sec"], sw["heal_end_sec"]) == (31.0, 33.0)
    assert sw["clips"] == [0, 1] and sw["lanes"] == ["lead", "lead"]
    si = next(s for s in seams if s["kind"] == "support_in")
    assert si["transition"] == "fade"
    assert (si["heal_start_sec"], si["heal_end_sec"]) == (15.5, 16.5)
    so = next(s for s in seams if s["kind"] == "support_out")
    assert (so["heal_start_sec"], so["heal_end_sec"]) == (47.5, 48.5)
    by = {(r["clip"], r["lane"]): r for r in runs}
    assert by[(0, "lead")]["fade_in_sec"] == 0.0  # timeline edge
    assert by[(0, "lead")]["fade_out_sec"] == pytest.approx(BAR_SEC)
    assert by[(1, "lead")]["fade_in_sec"] == pytest.approx(BAR_SEC)
    assert by[(1, "lead")]["fade_out_sec"] == 0.0  # timeline edge
    assert by[(2, "support")]["fade_in_sec"] == pytest.approx(BAR_SEC)
    assert by[(2, "support")]["fade_out_sec"] == pytest.approx(BAR_SEC)

    # a DROP at line 2 turns the switch into a cut with 1-beat fades
    seams, runs = _hand_runs(clips, [0.2, 0.4, 0.9, 0.8])
    dr = next(s for s in seams if s["sec"] == 32.0)
    assert dr["kind"] == "drop" and dr["transition"] == "cut"
    assert (dr["heal_start_sec"], dr["heal_end_sec"]) == (31.5, 34.0)
    by = {(r["clip"], r["lane"]): r for r in runs}
    assert by[(1, "lead")]["fade_in_sec"] == pytest.approx(BEAT_SEC)
    assert by[(0, "lead")]["fade_out_sec"] == pytest.approx(BEAT_SEC)


def test_drop_emitted_end_to_end():
    sched = _plan(stack(), 48, 3, "song")
    drops = [s for s in sched["seams"] if s["kind"] == "drop"]
    assert drops and drops[0]["transition"] == "cut"
    assert A.is_drop_line(sched["contour"], 2)
    assert drops[0]["sec"] == pytest.approx(32.0)


def test_low_confidence_doubles_transition():
    clips = ramp_stack()
    A.normalize_energy(clips)
    clips[1]["downbeat_confidence"] = 0.05
    seams, runs = _hand_runs(clips, [0.2, 0.4, 0.6, 0.8])
    sw = next(s for s in seams if s["kind"] == "lead_switch")
    assert sw["bars"] == 2.0
    assert (sw["heal_start_sec"], sw["heal_end_sec"]) == (30.0, 34.0)
    by = {(r["clip"], r["lane"]): r for r in runs}
    assert by[(1, "lead")]["fade_in_sec"] == pytest.approx(2 * BAR_SEC)
    assert by[(0, "lead")]["fade_out_sec"] == pytest.approx(2 * BAR_SEC)

    clips = ramp_stack()
    A.normalize_energy(clips)
    clips[0]["steady"] = False
    seams, _ = _hand_runs(clips, [0.2, 0.4, 0.6, 0.8])
    assert next(s for s in seams if s["kind"] == "lead_switch")["bars"] == 2.0

    # explicit transition bars win over the auto value, doubling still applies
    clips = ramp_stack()
    A.normalize_energy(clips)
    runs = A.build_runs(
        [(0, 0), (0, 1), (1, 0), (1, 1)], [[]] * 4, clips, [P] * 4, BAR_SEC
    )
    seams, _ = A.compute_seams(
        runs, [0.2, 0.4, 0.6, 0.8], BAR_SEC, BEAT_SEC, 1.5, clips, [P] * 4
    )
    assert seams[0]["bars"] == 1.5


def test_preroll_clamped_to_source_material():
    clips = ramp_stack()
    A.normalize_energy(clips)
    # clip 1 enters as lead with its phrase 0 -> no source audio before it
    lead = [(0, 0), (0, 1), (1, 0), (1, 1)]
    runs = A.build_runs(lead, [[]] * 4, clips, [P] * 4, BAR_SEC)
    _, runs = A.compute_seams(runs, [0.2] * 4, BAR_SEC, BEAT_SEC, 0.0, clips, [P] * 4)
    inc = next(r for r in runs if r["clip"] == 1)
    assert inc["fade_in_sec"] == 0.0
    # entering with phrase 1 has a whole phrase of material before it
    lead = [(0, 0), (0, 1), (1, 1), (1, 2)]
    runs = A.build_runs(lead, [[]] * 4, clips, [P] * 4, BAR_SEC)
    _, runs = A.compute_seams(runs, [0.2] * 4, BAR_SEC, BEAT_SEC, 0.0, clips, [P] * 4)
    inc = next(r for r in runs if r["clip"] == 1)
    assert inc["fade_in_sec"] == pytest.approx(BAR_SEC)


def test_seam_budget_cap():
    total = 60.0
    seams = []
    for k in range(1, 30):
        sec = k * 2.0
        seams.append(
            {
                "sec": sec,
                "kind": "support_in",
                "transition": "fade",
                "bars": 1.0,
                "heal_start_sec": sec - 1.0,
                "heal_end_sec": sec + 1.0,
                "clips": [0],
                "lanes": ["support"],
            }
        )
    out = A.seam_budget(copy.deepcopy(seams), total)
    for s in out:
        assert s["heal_end_sec"] - s["heal_start_sec"] >= 0.5 - 1e-9
        assert s["heal_start_sec"] <= s["sec"] <= s["heal_end_sec"]
    union = A._union_length([(s["heal_start_sec"], s["heal_end_sec"]) for s in out])
    assert union <= 0.35 * total + 1e-6
    # tiny windows are widened to the minimum
    tiny = [dict(seams[0], heal_start_sec=1.9, heal_end_sec=2.1)]
    out = A.seam_budget(tiny, total)
    assert out[0]["heal_end_sec"] - out[0]["heal_start_sec"] == pytest.approx(0.5)


def test_schedule_heal_windows_inside_timeline_and_budget():
    for make, bars, cap, arc in _CONFIGS:
        sched = _plan(make(), bars, cap, arc)
        for s in sched["seams"]:
            assert 0.0 <= s["heal_start_sec"] < s["heal_end_sec"] <= sched["total_sec"]
            assert s["heal_end_sec"] - s["heal_start_sec"] >= 0.5 - 1e-9
        union = A._union_length(
            [(s["heal_start_sec"], s["heal_end_sec"]) for s in sched["seams"]]
        )
        assert union <= 0.35 * sched["total_sec"] + 1e-6


# --------------------------------------------------------------------------
# coverage / determinism / shape
# --------------------------------------------------------------------------


def test_coverage_pass_places_unplaced_clip():
    clips = ramp_stack()[:2]
    A.normalize_energy(clips)
    contour = A.energy_contour(4, "song")
    lead = [(0, 0), (0, 1), (0, 2), (0, 3)]
    supports: list[list[tuple[int, int]]] = [[], [], [], []]
    warnings: list[str] = []
    A.coverage_pass(clips, lead, supports, contour, 3, warnings)
    placed = [(s, c, i) for s, row in enumerate(supports) for c, i in row]
    assert len(placed) == 1 and placed[0][1] == 1
    assert any("coverage pass" in w for w in warnings)
    # an outlier is reported instead of being placed as support
    clips[1]["harmonic_outlier"] = True
    supports = [[], [], [], []]
    warnings = []
    A.coverage_pass(clips, lead, supports, contour, 3, warnings)
    assert all(not row for row in supports)
    assert any("harmonic outlier" in w for w in warnings)


def test_deterministic_for_seed():
    a = _plan(wide_stack(), 96, 3, "song", seed=7)
    b = _plan(wide_stack(), 96, 3, "song", seed=7)
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def test_placements_v1_keys_present():
    sched = _plan(stack(), 96)
    v1 = {
        "output_start_sec",
        "output_end_sec",
        "window_start_sec",
        "window_end_sec",
        "chunk_idx",
        "rms",
    }
    v2 = {
        "clip",
        "phrase_idx",
        "lane",
        "role",
        "run_id",
        "gain_db",
        "fade_in_sec",
        "fade_out_sec",
        "nominal_start_sec",
        "nominal_end_sec",
    }
    assert sched["placements"]
    for p in sched["placements"]:
        assert v1 | v2 <= set(p.keys())
        assert (
            p["output_start_sec"]
            <= p["nominal_start_sec"]
            < p["nominal_end_sec"]
            <= p["output_end_sec"]
        )
        assert p["window_end_sec"] > p["window_start_sec"]
        assert 0.0 < p["rms"] <= 1.0
    for key in (
        "total_sec",
        "total_bars",
        "bar_sec",
        "beat_sec",
        "phrase_bars",
        "n_slots",
        "slot_bars",
        "contour",
        "density",
        "lead_by_slot",
        "runs",
        "placements",
        "seams",
        "sections",
        "warnings",
    ):
        assert key in sched
    assert sched["total_sec"] == pytest.approx(96 * BAR_SEC)
    assert sched["phrase_bars"] == P


def test_empty_stack_returns_empty_schedule():
    tl = A.resolve_timeline(120.0, "median", 0.0, 32, None, P)
    sched = A.plan_timeline([_clip(0, [])], tl, BAR_SEC, BEAT_SEC, 3, "song", 0.0, 0)
    assert sched["placements"] == [] and sched["runs"] == []
    assert sched["warnings"]
