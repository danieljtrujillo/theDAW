"""Fugue exposition: the answer is tonal when the subject opens on the
dominant and real when it opens on the tonic, the exposition gives every
voice its entry with nothing flagged, the countersubject inverts at the
octave, episodes sequence a subject fragment, the stretto search finds clean
overlaps, and a four-voice exposition comes back well inside ten seconds.

Pure computation; no model, no GPU.
"""

from __future__ import annotations

import time

import pytest

from backend.modules.composer.counterpoint import (
    BAR,
    FREE,
    CounterpointError,
    Line,
    Piece,
    checker_flags,
    invertible_check,
    parse_scale,
)
from backend.modules.composer.fugue import answer_for, build_fugue, find_strettos

Q = 960


def _subject(pitches: list[int], durations: list[int]) -> list[dict[str, int]]:
    out, t = [], 0
    for p, d in zip(pitches, durations):
        out.append({"note": p, "tick": t, "ticks": d})
        t += d
    return out


# C minor: G Ab G F | Eb D C, opening on the dominant.
ON_G = _subject([67, 68, 67, 65, 63, 62, 60], [Q, Q, Q, Q, Q, Q, 2 * Q])
# C minor: C D Eb F | G F Eb D | C, opening on the tonic.
ON_C = _subject([60, 62, 63, 65, 67, 65, 63, 62, 60], [Q, Q, Q, Q, 2 * Q, Q, Q, Q, Q])


def test_a_subject_on_the_dominant_gets_a_tonal_answer() -> None:
    scale = parse_scale("c")
    ans = answer_for(Line("s", ON_G), scale)
    assert ans["kind"] == "tonal"
    assert ans["mutations"] == [0]
    # the head's G is answered by C (up a fourth), not D (up a fifth) ...
    assert ans["line"].pitches[0] == 72
    # ... and the rest is the subject a fifth up
    assert ans["line"].pitches[1:] == [p + 7 for p in (68, 67, 65, 63, 62, 60)]


def test_a_subject_on_the_tonic_gets_its_answer_in_g() -> None:
    scale = parse_scale("c")
    ans = answer_for(Line("s", ON_C), scale)
    assert ans["kind"] == "real"
    assert ans["mutations"] == []
    assert ans["line"].pitches[0] % 12 == 7  # G
    assert ans["line"].pitches == [p + 7 for p in (60, 62, 63, 65, 67, 65, 63, 62, 60)]
    # a head of tonic and dominant together is tonal: C G -> G C
    head = answer_for(Line("s", _subject([60, 67, 65, 63], [Q, Q, Q, Q])), scale)
    assert head["kind"] == "tonal" and head["line"].pitches[:2] == [67, 72]


def test_a_three_voice_exposition_in_c_minor() -> None:
    r = build_fugue("c", voices=3, subject=ON_G, seed=0)
    assert r["key"] == "C minor"
    assert r["voices"] == ["soprano", "alto", "bass"]
    assert set(r["parts"]) == {"soprano", "alto", "bass"}
    assert all(r["parts"][v] for v in r["voices"])
    assert [e["form"] for e in r["entries"]] == ["subject", "answer", "subject"]
    assert sorted(e["voice"] for e in r["entries"]) == ["alto", "bass", "soprano"]
    assert r["answer"]["kind"] == "tonal"
    assert r["violations"] == []
    assert r["flags"] == []
    # each entry sounds its form in its voice, in whole bars
    span = r["entries"][1]["tick"] - r["entries"][0]["tick"]
    assert span % BAR == 0
    for e in r["entries"]:
        notes = [
            n
            for n in r["parts"][e["voice"]]
            if e["tick"] <= n["tick"] < e["tick"] + span
        ]
        form = r["subject"] if e["form"] == "subject" else r["answer"]["notes"]
        shift = notes[0]["note"] - form[0]["note"]
        assert shift % 12 == 0
        assert [n["note"] - shift for n in notes] == [n["note"] for n in form]


def test_the_countersubject_inverts_at_the_octave() -> None:
    r = build_fugue("c", voices=3, subject=ON_G, seed=0)
    assert r["countersubject"]
    assert r["countersubject_inversion"]["ok"] is True
    # rebuilt from the parts: the voice after the subject against the answer
    first, second = r["entries"][0], r["entries"][1]
    t0, t1 = second["tick"], second["tick"] + (second["tick"] - first["tick"])
    cs = [n for n in r["parts"][first["voice"]] if t0 <= n["tick"] < t1]
    ans = [n for n in r["parts"][second["voice"]] if t0 <= n["tick"] < t1]
    upper, lower = (
        (ans, cs)
        if r["voices"].index(second["voice"]) < r["voices"].index(first["voice"])
        else (cs, ans)
    )
    check = invertible_check(upper, lower, 8, key="c")
    assert check["ok"] is True
    assert check["inverted"]["violations"] == [] and check["inverted"]["flags"] == []


def test_an_episode_sequences_a_subject_fragment() -> None:
    r = build_fugue("c", voices=3, subject=ON_G, seed=0, episodes=1)
    (ep,) = r["episodes"]
    assert ep["tick"] == r["exposition_end"]
    assert ep["reps"] >= 3 and ep["direction"] == "down"
    motif = [
        n
        for n in r["parts"][ep["voice"]]
        if ep["tick"] <= n["tick"] < ep["tick"] + ep["ticks"]
    ]
    per = ep["fragment_notes"]
    scale = parse_scale("c")
    first = motif[:per]
    for rep in range(1, ep["reps"]):
        again = motif[rep * per : (rep + 1) * per]
        assert [n["note"] for n in again] == [
            scale.transpose(n["note"], -rep) for n in first
        ]
        assert [n["tick"] - rep * ep["model"] for n in again] == [
            n["tick"] for n in first
        ]


def test_the_stretto_search_finds_clean_overlaps() -> None:
    scale = parse_scale("c")
    subject = Line("subject", ON_G)
    found = find_strettos(subject, scale)
    assert found
    for s in found[:3]:
        steps = s["interval"] - 1 if s["interval"] > 0 else s["interval"] + 1
        follower = Line("follower")
        for p, a, b in zip(subject.pitches, subject.starts, subject.ends):
            follower.append(scale.transpose(p, steps), a + s["lag"], b + s["lag"])
        lead = subject.copy("leader")
        pair = [follower, lead] if steps > 0 else [lead, follower]
        assert s["lag"] < subject.ends[-1]  # the entries overlap
        assert Piece(pair, scale, FREE).flags() == []
        assert checker_flags(pair) == []
    assert build_fugue("c", voices=3, subject=ON_G, seed=0)["strettos"] == found


@pytest.mark.parametrize("voices", [2, 4])
def test_two_and_four_voice_expositions_are_clean(voices: int) -> None:
    r = build_fugue("c", voices=voices, subject=ON_C, seed=0)
    assert len(r["parts"]) == voices == len(r["entries"])
    assert r["violations"] == [] and r["flags"] == []


def test_a_generated_subject_starts_where_asked() -> None:
    r = build_fugue("G", voices=3, subject_start="dominant", seed=3)
    assert r["subject"][0]["note"] % 12 == 2  # D, the dominant of G
    assert r["answer"]["kind"] == "tonal"
    assert r["violations"] == [] and r["flags"] == []


def test_a_four_voice_exposition_returns_in_under_ten_seconds() -> None:
    t = time.perf_counter()
    r = build_fugue("c", voices=4, subject_start="dominant", seed=0, episodes=2)
    elapsed = time.perf_counter() - t
    assert len(r["parts"]) == 4
    assert elapsed < 10.0, f"{elapsed:.1f} s"


def test_fugue_refuses_what_it_cannot_write() -> None:
    with pytest.raises(CounterpointError):
        build_fugue("c", voices=5)
    with pytest.raises(CounterpointError):
        build_fugue("c", voices=3, subject=[{"note": 60, "tick": 0, "ticks": Q}])
    with pytest.raises(CounterpointError):
        build_fugue("c", voices=3, episodes=3)
