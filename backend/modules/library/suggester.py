"""Analysis-driven playlist suggester.

Given a target duration and a few preferences (a bpm range, harmonic mixing, an
energy flow, an optional text/genre filter, an optional seed track), build an
ordered playlist from the library by sequencing analyzed entries so consecutive
tracks mix well:

  - harmonically-compatible keys (Camelot wheel),
  - bpm that follows the requested flow (steady / build / wind-down / wave),
  - a nudge toward popular picks and stylistically-varied neighbours (the
    "unique juxtaposition" a user asks for).

Pure stdlib plus the library DB. The Camelot logic mirrors
``frontend/src/lib/camelot.ts`` so the wheel matches what the DJ tab shows.
"""

from __future__ import annotations

from typing import Any, Optional

# --------------------------------------------------------------------------- #
#  Camelot wheel (ported from frontend/src/lib/camelot.ts)
# --------------------------------------------------------------------------- #
_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_FLAT_TO_SHARP = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#"}
_MAJOR_NUM = {
    "C": 8,
    "C#": 3,
    "D": 10,
    "D#": 5,
    "E": 12,
    "F": 7,
    "F#": 2,
    "G": 9,
    "G#": 4,
    "A": 11,
    "A#": 6,
    "B": 1,
}
_MINOR_NUM = {
    "A": 8,
    "A#": 3,
    "B": 10,
    "C": 5,
    "C#": 12,
    "D": 7,
    "D#": 2,
    "E": 9,
    "F": 4,
    "F#": 11,
    "G": 6,
    "G#": 1,
}


def _normalize_note(note: str) -> str:
    n = note.strip()
    if len(n) >= 2:
        head = n[0].upper() + n[1:]
        if head in _FLAT_TO_SHARP:
            return _FLAT_TO_SHARP[head]
    return (n[0].upper() + n[1:]) if n else ""


def _is_minor(scale: Optional[str]) -> bool:
    s = (scale or "").lower()
    return s.startswith("min") or s == "m" or s == "aeolian"


def to_camelot(note: Optional[str], scale: Optional[str]) -> Optional[dict[str, Any]]:
    """Resolve note+scale to ``{code, number, letter, compatible}`` or None."""
    if not note:
        return None
    n = _normalize_note(note)
    if n not in _NOTE_NAMES:
        return None
    minor = _is_minor(scale)
    number = (_MINOR_NUM if minor else _MAJOR_NUM).get(n)
    if number is None:
        return None
    letter = "A" if minor else "B"
    up = (number % 12) + 1
    down = ((number + 10) % 12) + 1
    other = "B" if letter == "A" else "A"
    compatible = [
        f"{number}{letter}",
        f"{up}{letter}",
        f"{down}{letter}",
        f"{number}{other}",
    ]
    return {
        "code": f"{number}{letter}",
        "number": number,
        "letter": letter,
        "compatible": compatible,
    }


def _harmonic_score(a: Optional[dict], b: Optional[dict]) -> float:
    """3 for the same key, 2 for a Camelot-compatible neighbour, else 0."""
    if not a or not b:
        return 0.0
    if a["code"] == b["code"]:
        return 3.0
    if b["code"] in a["compatible"]:
        return 2.0
    return 0.0


def _flow_target_bpm(flow: str, base: float, pos: float) -> float:
    """Target bpm at normalized position ``pos`` (0..1) for the given flow.
    The spread is +/-15% of the pool's median bpm."""
    spread = base * 0.15
    if flow == "build":
        return base - spread + 2.0 * spread * pos
    if flow == "wind_down":
        return base + spread - 2.0 * spread * pos
    if flow == "wave":
        return base + spread * (1.0 - abs(2.0 * pos - 1.0))
    return base  # steady


# --------------------------------------------------------------------------- #
#  Suggester
# --------------------------------------------------------------------------- #
def suggest_playlist(
    db: Any,
    *,
    target_duration_sec: float,
    bpm_min: Optional[float] = None,
    bpm_max: Optional[float] = None,
    harmonic: bool = True,
    flow: str = "steady",
    genre: Optional[str] = None,
    query: Optional[str] = None,
    seed_id: Optional[str] = None,
    max_tracks: int = 60,
) -> dict[str, Any]:
    """Return an ordered playlist that fits the time budget and the criteria.

    ``db`` is a ``LibraryDB`` (needs ``list_entries_with_analysis``). The result
    is ``{tracks: [...], total_duration_sec, track_count, flow, base_bpm}`` where
    each track carries its bpm / key / camelot / play_count and a short reason."""
    rows = db.list_entries_with_analysis()

    pool: list[dict[str, Any]] = []
    for raw in rows:
        dur = float(raw.get("duration_sec") or 0.0)
        if dur <= 0:
            continue
        bpm = raw.get("bpm")
        if bpm_min is not None and (bpm is None or bpm < bpm_min):
            continue
        if bpm_max is not None and (bpm is None or bpm > bpm_max):
            continue
        if genre and (raw.get("genre") or "").lower() != genre.lower():
            continue
        if query:
            hay = " ".join(
                str(raw.get(k) or "") for k in ("title", "prompt", "genre", "model")
            ).lower()
            if query.lower() not in hay:
                continue
        item = dict(raw)
        item["_camelot"] = to_camelot(raw.get("key"), raw.get("scale"))
        pool.append(item)

    if not pool:
        return {
            "tracks": [],
            "total_duration_sec": 0.0,
            "track_count": 0,
            "flow": flow,
            "base_bpm": 0.0,
            "reason": "no analyzed tracks match the criteria",
        }

    bpms = sorted(b for b in (p.get("bpm") for p in pool) if b)
    base_bpm = float(bpms[len(bpms) // 2]) if bpms else 120.0

    budget = float(target_duration_sec)
    tolerance = budget * 0.12

    # Seed: an explicit pick, else the most-played track nearest the flow's
    # opening bpm.
    seed = next((p for p in pool if p["id"] == seed_id), None)
    if seed is None:
        start_bpm = _flow_target_bpm(flow, base_bpm, 0.0)
        seed = max(
            pool,
            key=lambda p: (
                p.get("play_count") or 0,
                -abs((p.get("bpm") or base_bpm) - start_bpm),
            ),
        )

    used: set[str] = {seed["id"]}
    seq: list[dict[str, Any]] = [seed]
    total = float(seed.get("duration_sec") or 0.0)

    while total < budget and len(seq) < max_tracks:
        current = seq[-1]
        pos = min(1.0, total / budget) if budget > 0 else 0.0
        target_bpm = _flow_target_bpm(flow, base_bpm, pos)
        best: Optional[dict[str, Any]] = None
        best_score = -1e9
        for cand in pool:
            if cand["id"] in used:
                continue
            cdur = float(cand.get("duration_sec") or 0.0)
            if total + cdur > budget + tolerance:
                continue
            h = (
                _harmonic_score(current["_camelot"], cand["_camelot"])
                if harmonic
                else 0.0
            )
            cbpm = cand.get("bpm")
            bpm_pen = abs((cbpm if cbpm else target_bpm) - target_bpm)
            bpm_score = max(0.0, 1.0 - bpm_pen / 12.0)
            pop = min(1.0, (cand.get("play_count") or 0) / 5.0) * 0.3
            jux = (
                0.2
                if (cand.get("genre") and cand.get("genre") != current.get("genre"))
                else 0.0
            )
            score = h * 1.5 + bpm_score + pop + jux
            if score > best_score:
                best_score = score
                best = cand
        if best is None:
            break
        used.add(best["id"])
        seq.append(best)
        total += float(best.get("duration_sec") or 0.0)

    tracks: list[dict[str, Any]] = []
    for i, t in enumerate(seq):
        prev = seq[i - 1] if i > 0 else None
        bits: list[str] = []
        if prev and harmonic and t["_camelot"] and prev["_camelot"]:
            hs = _harmonic_score(prev["_camelot"], t["_camelot"])
            if hs >= 3:
                bits.append("same key")
            elif hs >= 2:
                bits.append(
                    f"harmonic {prev['_camelot']['code']}->{t['_camelot']['code']}"
                )
        if t.get("bpm"):
            bits.append(f"{round(float(t['bpm']))} bpm")
        tracks.append(
            {
                "id": t["id"],
                "title": t.get("title") or t["id"],
                "duration_sec": float(t.get("duration_sec") or 0.0),
                "bpm": t.get("bpm"),
                "key": t.get("key"),
                "scale": t.get("scale"),
                "camelot": t["_camelot"]["code"] if t["_camelot"] else None,
                "genre": t.get("genre"),
                "play_count": t.get("play_count") or 0,
                "reason": ", ".join(bits) or "seed",
            }
        )

    return {
        "tracks": tracks,
        "total_duration_sec": round(total, 1),
        "track_count": len(tracks),
        "flow": flow,
        "base_bpm": round(base_bpm, 1),
    }
