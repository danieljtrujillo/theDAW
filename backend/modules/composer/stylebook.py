"""The style profile schema and the shipped styles, with no music21 import.

A style profile (``styles/<id>.json``) is written by :mod:`.profile` from
scores, or by hand for a composer the corpus lacks. This module reads and
checks them, so ``GET /api/composer/styles`` answers without loading music21.
"""

from __future__ import annotations

import json
import logging
import math
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping, Sequence

from .spec import CADENCES, ORCHESTRATIONS

log = logging.getLogger(__name__)

SCHEMA = "thedaw.composer.style"
SCHEMA_VERSION = 1
STYLES_DIR = Path(__file__).resolve().parent / "styles"
SOURCES = ("extracted", "authored")
INTERVAL_BUCKETS = tuple(str(i) for i in range(13)) + ("13+",)


class ProfileError(ValueError):
    """A profile could not be made or found (no scores, no notes, a bad
    document, an unknown style)."""


def _is_share_map(value: Any, keys: Sequence[str] | None = None) -> bool:
    if not isinstance(value, dict):
        return False
    if keys is not None and set(value) != set(keys):
        return False
    return all(
        isinstance(k, str) and isinstance(v, (int, float)) and 0 <= v <= 1
        for k, v in value.items()
    )


def _sums_to_one(value: Mapping[str, float], allow_empty: bool = False) -> bool:
    total = sum(value.values())
    if allow_empty and total == 0:
        return True
    return math.isclose(total, 1.0, abs_tol=0.02)


def validate_profile(doc: Any) -> list[str]:
    """What is wrong with a style profile document; an empty list when nothing."""
    errors: list[str] = []
    if not isinstance(doc, dict):
        return ["a profile is a JSON object"]

    def need(cond: bool, message: str) -> None:
        if not cond:
            errors.append(message)

    need(doc.get("schema") == SCHEMA, f"schema must be {SCHEMA!r}")
    need(
        doc.get("schemaVersion") == SCHEMA_VERSION,
        f"schemaVersion must be {SCHEMA_VERSION}",
    )
    for key in ("id", "name", "basis"):
        need(
            isinstance(doc.get(key), str) and bool(doc.get(key)),
            f"{key} is a non-empty string",
        )
    need(isinstance(doc.get("era", ""), str), "era is a string")
    source = doc.get("source")
    need(source in SOURCES, f"source is one of {SOURCES}")
    works = doc.get("works")
    need(
        isinstance(works, list) and all(isinstance(w, str) for w in works),
        "works is a list of strings",
    )
    sample = doc.get("sample")
    need(isinstance(sample, dict), "sample is an object")
    if source == "extracted":
        need(bool(works), "an extracted profile lists its works")
        if isinstance(sample, dict) and isinstance(works, list):
            need(
                sample.get("works") == len(works),
                "sample.works counts the works listed",
            )
    if source == "authored":
        need(
            works == [],
            "an authored profile lists no works (it was not counted from any)",
        )
    modes = doc.get("modes")
    need(
        _is_share_map(modes, ("major", "minor")) and _sums_to_one(modes),
        "modes are major/minor shares summing to 1",
    )
    vocab = doc.get("vocabulary")
    if not isinstance(vocab, dict) or set(vocab) != {"major", "minor"}:
        errors.append("vocabulary has a major and a minor map")
    else:
        for mode, table in vocab.items():
            ok = _is_share_map(table) and (
                not table or 0.5 <= sum(table.values()) <= 1.01
            )
            need(ok, f"vocabulary.{mode} maps chords to shares (at most 1 in all)")
            if isinstance(modes, dict) and modes.get(mode, 0) >= 0.05:
                need(
                    bool(table), f"vocabulary.{mode} is empty but the style uses {mode}"
                )
    cad = doc.get("cadences")
    need(
        _is_share_map(cad, CADENCES) and _sums_to_one(cad),
        "cadences are shares of the six cadence types summing to 1",
    )
    other = doc.get("cadence_other")
    need(
        isinstance(other, (int, float)) and 0 <= other <= 1, "cadence_other is a share"
    )
    hr = doc.get("harmonic_rhythm")
    need(
        isinstance(hr, dict)
        and all(
            isinstance(hr.get(k), (int, float)) and hr.get(k) > 0
            for k in ("chords_per_bar", "chords_per_pulse")
        ),
        "harmonic_rhythm has positive chords_per_bar and chords_per_pulse",
    )
    tex = doc.get("texture")
    need(
        isinstance(tex, dict)
        and isinstance(tex.get("voices"), (int, float))
        and tex.get("voices") >= 1
        and all(
            isinstance(tex.get(k), (int, float)) and 0 <= tex.get(k) <= 1
            for k in ("homophony", "polyphony")
        ),
        "texture has voices >= 1 and homophony/polyphony shares",
    )
    met = doc.get("meter")
    need(
        isinstance(met, dict)
        and _is_share_map(met.get("meters"))
        and bool(met.get("meters"))
        and _sums_to_one(met["meters"])
        and all(
            isinstance(met.get(k), (int, float)) and 0 <= met.get(k) <= 1
            for k in ("hemiola", "syncopation")
        ),
        "meter has meters (shares summing to 1), hemiola and syncopation rates",
    )
    iv = doc.get("intervals")
    need(
        _is_share_map(iv, INTERVAL_BUCKETS) and _sums_to_one(iv),
        "intervals are shares of 0-12 and 13+ semitones summing to 1",
    )
    need(
        doc.get("orchestration") in ORCHESTRATIONS,
        f"orchestration is one of {ORCHESTRATIONS}",
    )
    return errors


@lru_cache(maxsize=1)
def _styles() -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for path in sorted(STYLES_DIR.glob("*.json")):
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            log.warning("composer: style %s is unreadable: %s", path.name, exc)
            continue
        errors = validate_profile(doc)
        if errors:
            log.warning(
                "composer: style %s is invalid: %s", path.name, "; ".join(errors)
            )
            continue
        out[doc["id"]] = doc
    return out


def style_ids() -> list[str]:
    return list(_styles())


def load_style(style_id: str) -> dict[str, Any]:
    """A shipped style profile by id ('bach', 'debussy', ...)."""
    doc = _styles().get(str(style_id or "").strip().lower())
    if doc is None:
        raise ProfileError(
            f"no style {style_id!r}; the styles are {', '.join(style_ids())}"
        )
    return doc


def list_styles() -> list[dict[str, Any]]:
    """One line per shipped style, for a picker."""
    return [
        {
            "id": d["id"],
            "name": d["name"],
            "era": d.get("era", ""),
            "source": d["source"],
            "basis": d["basis"],
            "works": len(d["works"]),
            "orchestration": d["orchestration"],
            "chords_per_pulse": d["harmonic_rhythm"]["chords_per_pulse"],
        }
        for d in _styles().values()
    ]


__all__ = [
    "INTERVAL_BUCKETS",
    "ProfileError",
    "SCHEMA",
    "SCHEMA_VERSION",
    "SOURCES",
    "STYLES_DIR",
    "list_styles",
    "load_style",
    "style_ids",
    "validate_profile",
]
