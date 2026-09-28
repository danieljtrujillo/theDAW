"""HTTP API for the user's sound banks (store.py).

    GET    /api/soundfonts             every stored bank, its presets and offset
                                       (downloaded banks not listed yet are added first)
    POST   /api/soundfonts/upload      add a bank from an uploaded .sf2/.sf3/.dls
    POST   /api/soundfonts/add-path    add a bank from a file on this machine
    GET    /api/soundfonts/{id}/file   a stored bank's bytes, for the synths
    GET    /api/soundfonts/{id}/manifest  its build manifest (playback gains), if any
    DELETE /api/soundfonts/{id}        remove a bank and delete its file (a downloaded
                                       bank's installed file too)

Every route answers this machine's own UI, the desktop shell and a paired
device, and refuses a call a browser labels as coming from another site.
``add-path`` reads a file named in the request body, so it answers only this
machine's own UI and the desktop shell.
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.lib import known_paths
from backend.lib.cross_site import (
    refuse_cross_site,
    require_loopback_launch_or_pairing_token,
    require_loopback_or_launch_token,
)
from backend.modules.genaiproxy.access import caller_is_loopback

from . import store

router = APIRouter(
    dependencies=[
        Depends(refuse_cross_site),
        Depends(require_loopback_launch_or_pairing_token),
    ]
)

_MEDIA = {"sf2": "audio/x-soundfont", "sf3": "audio/x-soundfont", "dls": "audio/dls"}


class PathBody(BaseModel):
    path: str


def _shown(entry: dict[str, Any], request: Request) -> dict[str, Any]:
    # A caller on another machine is not told where files live on this one.
    if caller_is_loopback(request):
        return entry
    return {k: v for k, v in entry.items() if k not in ("path", "source_path")}


@router.get("")
def get_banks(request: Request) -> dict[str, Any]:
    # A bank the download manager installed before this list held downloads
    # is listed on the first read, with no download again.
    store.sync_downloaded()
    return {
        "banks": [_shown(b, request) for b in store.list_banks()],
        "offset_range": [store.USER_OFFSET_FIRST, store.USER_OFFSET_LAST],
    }


@router.post("/upload")
def post_upload(request: Request, file: UploadFile = File(...)) -> dict[str, Any]:
    try:
        entry = store.add_bank(file.file, file.filename or "bank.sf2")
    except store.BankStoreError as e:
        raise HTTPException(400, str(e)) from e
    return {"bank": _shown(entry, request)}


@router.post("/add-path", dependencies=[Depends(require_loopback_or_launch_token)])
def post_add_path(body: PathBody, request: Request) -> dict[str, Any]:
    path = os.path.abspath(os.path.expanduser(body.path))
    if known_paths.is_remote_or_device_path(path) or not os.path.isfile(path):
        raise HTTPException(404, f"Not found: {body.path}")
    try:
        with open(path, "rb") as f:
            entry = store.add_bank(f, os.path.basename(path), source_path=path)
    except store.BankStoreError as e:
        raise HTTPException(400, str(e)) from e
    except OSError as e:
        raise HTTPException(500, f"Could not read {os.path.basename(path)}: {e}") from e
    # The file the user picked is remembered too, so the next pick of a sound
    # bank starts in its folder.
    known_paths.record(path, "soundfont", source="pick")
    return {"bank": _shown(entry, request)}


@router.get("/{bank_id}/file")
def get_bank_file(bank_id: str) -> FileResponse:
    f = store.bank_file(bank_id)
    if f is None:
        raise HTTPException(404, "No sound bank with that id.")
    fmt = f.suffix.lower().lstrip(".")
    return FileResponse(
        f, media_type=_MEDIA.get(fmt, "application/octet-stream"), filename=f.name
    )


@router.get("/{bank_id}/manifest")
def get_bank_manifest(bank_id: str) -> dict[str, Any]:
    data = store.bank_manifest(bank_id)
    if data is None:
        raise HTTPException(404, "That sound bank has no manifest.")
    return data


@router.delete("/{bank_id}")
def delete_bank(bank_id: str) -> dict[str, Any]:
    if not store.remove_bank(bank_id):
        raise HTTPException(404, "No sound bank with that id.")
    return {"removed": bank_id}
