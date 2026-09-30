"""Where an entry's sections live: ``data/sections/<entry_id>.json``.

Written atomically, versioned by ``SECTIONS_VERSION`` so a file from an older
finder reads as pending and is found again. A section the user renamed or
re-roled carries ``named_by_user`` / ``role_by_user``; a new run keeps those
edits for the section that starts on the same bar (see ``carry_edits``).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Optional

from backend.lib import paths
from backend.lib.atomic import atomic_write

from .finder import ROLES, SECTIONS_VERSION, section_names

log = logging.getLogger(__name__)

NAME_MAX = 64


def sections_dir() -> Path:
    return paths.data_path("sections")


def _path(entry_id: str) -> Path:
    safe = "".join(c for c in entry_id if c.isalnum() or c in "-_") or "entry"
    return sections_dir() / f"{safe}.json"


def read_sections(entry_id: str) -> Optional[dict[str, Any]]:
    """The stored result, or None when there is none (or it is from an older
    finder, or unreadable)."""
    p = _path(entry_id)
    if not p.is_file():
        return None
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        log.info("sections: unreadable %s (%s)", p.name, e)
        return None
    if int(doc.get("version") or 0) < SECTIONS_VERSION:
        return None
    return doc


def write_sections(entry_id: str, doc: dict[str, Any]) -> None:
    p = _path(entry_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(p, json.dumps(doc))


def clean_name(name: Any) -> str:
    text = " ".join(str(name or "").split())
    return text[:NAME_MAX]


def carry_edits(old: Optional[dict[str, Any]], new: dict[str, Any]) -> dict[str, Any]:
    """The user's names and roles from ``old`` onto the sections of ``new``
    that start on the same bar (or within a quarter of a bar's time when the
    grid moved)."""
    if not old:
        return new
    edited = [
        s
        for s in old.get("sections") or []
        if s.get("named_by_user") or s.get("role_by_user")
    ]
    if not edited:
        return new
    for s in new.get("sections") or []:
        bar_len = max(
            0.25, (s["end_sec"] - s["start_sec"]) / max(1, s.get("bars") or 1)
        )
        for o in edited:
            same_bar = o.get("start_bar") == s.get("start_bar")
            near = abs(float(o.get("start_sec", -1e9)) - s["start_sec"]) <= bar_len / 4
            if not (same_bar or near):
                continue
            if o.get("named_by_user"):
                s["name"] = o["name"]
                s["named_by_user"] = True
            if o.get("role_by_user") and o.get("role") in ROLES:
                s["role"] = o["role"]
                s["role_by_user"] = True
            break
    return renumber(new)


def renumber(doc: dict[str, Any]) -> dict[str, Any]:
    """Names from the roles ("Verse", "Chorus", "Verse 2") for every section
    the user has not named, so a re-roled section reads its new role."""
    sections = doc.get("sections") or []
    auto = section_names([str(s.get("role") or "verse") for s in sections])
    for s, name in zip(sections, auto):
        if not s.get("named_by_user"):
            s["name"] = name
    return doc


def edit_section(
    doc: dict[str, Any],
    index: int,
    *,
    name: Optional[str] = None,
    role: Optional[str] = None,
) -> dict[str, Any]:
    """``doc`` with section ``index`` renamed and/or re-roled. Raises
    ``IndexError`` for no such section and ``ValueError`` for a blank name or
    an unknown role."""
    sections = doc.get("sections") or []
    if not 0 <= index < len(sections):
        raise IndexError(f"no section {index}")
    s = sections[index]
    if name is not None:
        text = clean_name(name)
        if not text:
            raise ValueError("a section name cannot be blank")
        s["name"] = text
        s["named_by_user"] = True
    if role is not None:
        if role not in ROLES:
            raise ValueError(f"unknown role {role!r}; one of {', '.join(ROLES)}")
        s["role"] = role
        s["role_by_user"] = True
    return renumber(doc)


def spans_of(doc: Optional[dict[str, Any]]) -> list[tuple[float, float, str]]:
    """``(start_sec, end_sec, role)`` per section, in order."""
    if not doc:
        return []
    return [
        (float(s["start_sec"]), float(s["end_sec"]), str(s.get("role") or ""))
        for s in doc.get("sections") or []
    ]


def role_at(spans: list[tuple[float, float, str]], t: float) -> str:
    """The role of the section holding ``t``; before the first section, the
    first's; '' with no sections."""
    if not spans:
        return ""
    if t < spans[0][0]:
        return spans[0][2]
    for s0, s1, role in spans:
        if s0 <= t < s1:
            return role
    return spans[-1][2]
