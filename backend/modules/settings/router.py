"""FastAPI router for app-wide feature settings.

Endpoints (prefix from module.json → ``/api/settings``):

    GET   /            full settings payload
    PATCH /            partial update; returns the merged payload

The PATCH body is a partial nested object: only the sections / keys you
want to change need to be present. Unknown sections / keys are dropped,
not rejected, so the frontend never gets a 400 for sending a slightly
newer or older shape than the backend knows about.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Body

from .store import SettingsStore, default_settings_path

log = logging.getLogger(__name__)


_store: Optional[SettingsStore] = None


def get_store() -> SettingsStore:
    global _store
    if _store is None:
        _store = SettingsStore(default_settings_path())
    return _store


router = APIRouter()


@router.get("")
@router.get("/")
def get_settings() -> dict[str, Any]:
    return get_store().get_all()


@router.patch("")
@router.patch("/")
def patch_settings(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return get_store().get_all()
    return get_store().patch(payload)
