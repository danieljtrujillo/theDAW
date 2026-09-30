"""FastAPI router for the section finder (prefix ``/api/sections``).

    GET   /                        capability report
    GET   /{entry_id}              the stored sections: 200 with ``status:
                                   pending`` when none are found yet (the
                                   DETAILS panel polls this; a 404 would paint
                                   the Network tab red for a normal state)
    POST  /{entry_id}/run          find them now (keeps the user's names)
    PATCH /{entry_id}/sections/{index}
                                   rename and/or re-role one section

A found section is ``{index, start_sec, end_sec, start_bar, bars, letter,
role, name, confidence, repeat_of, similarity, energy, stems}``; the document
also holds the bar grid it was found on (``grid``, ``bars``), the boundaries
with their confidence and the novelty curve.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import store
from .finder import ROLES, SECTIONS_VERSION

log = logging.getLogger(__name__)

router = APIRouter()


class EditBody(BaseModel):
    name: Optional[str] = None
    role: Optional[str] = None


def _library_db() -> Any:
    from backend.modules.library.router import get_store as get_library_store

    s = get_library_store()
    return s.db


@router.get("")
@router.get("/")
def health() -> dict[str, Any]:
    return {
        "module": "sections",
        "version": SECTIONS_VERSION,
        "roles": list(ROLES),
        "features": [
            "bar_grid",
            "stem_activity",
            "self_similarity",
            "novelty_boundaries",
            "repeat_letters",
            "roles",
            "boundary_confidence",
            "rename",
        ],
    }


@router.get("/{entry_id}")
def get_sections(entry_id: str) -> dict[str, Any]:
    doc = store.read_sections(entry_id)
    if doc is None:
        return {"entry_id": entry_id, "status": "pending"}
    return {"status": "ready", **doc, "entry_id": entry_id}


@router.post("/{entry_id}/run")
async def run_sections(entry_id: str) -> dict[str, Any]:
    from backend.core import pipeline

    try:
        doc = await pipeline.ensure_sections(entry_id, force=True)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e
    except Exception as e:  # noqa: BLE001 - surfaced with its cause
        log.exception("sections: finding failed for %s", entry_id)
        raise HTTPException(500, f"finding the sections failed: {e}") from e
    return {"status": "ready", **doc, "entry_id": entry_id}


@router.patch("/{entry_id}/sections/{index}")
def edit_section(entry_id: str, index: int, body: EditBody) -> dict[str, Any]:
    from .service import edit_entry_section

    if body.name is None and body.role is None:
        raise HTTPException(400, "give a name, a role, or both")
    try:
        doc = edit_entry_section(
            _library_db(), entry_id, index, name=body.name, role=body.role
        )
    except LookupError as e:
        # IndexError is a LookupError too: both are a 404 here.
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"status": "ready", **doc, "entry_id": entry_id}
