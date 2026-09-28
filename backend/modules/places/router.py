"""HTTP API for the paths theDAW remembers (backend/lib/known_paths.py).

    GET  /api/places/folder?kind=            the folder a picker for this kind starts in
    GET  /api/places/recent?kind=&exts=&limit=  remembered files, newest first
    POST /api/places/record                  remember a path the client knows about
    GET  /api/places/launch-token-check      does this request carry the launch token
    POST /api/places/reveal                  show a path in the OS file manager
    GET  /api/places/file?path=              a servable remembered file's bytes
    POST /api/places/save                    write an upload to a path a Save dialog granted
    GET  /api/places/projects-dir            the folder .tasmo projects go in
    PUT  /api/places/projects-dir            change it

The server binds 0.0.0.0, so nothing a request body says can make a file
servable or writable on its own. /record stores what it is given as ``client``,
which /file never serves, unless the request carries the desktop shell's launch
token (``backend.lib.launch_token``); /file serves only servable sources; /save
writes only to a path the user chose in a native Save dialog, with the nonce
that dialog issued, once.

CORS is open on this server, so a page on another site could otherwise list the
recent files and then read them. Every route refuses a call that the browser
labels as coming from such a page (``backend.lib.cross_site``).

That label is only a header, and a bare script on the LAN sends none, so the
routes also check who is asking, the same way the project router does:

* The reads and ``/record`` answer this machine's own UI, the desktop shell,
  and a paired device (the desktop UI opened from the Mobile Access share
  link, which carries the pairing token). An unknown LAN caller could
  otherwise list every path theDAW remembers -- the very leak the project
  router's ``/recent`` and ``/default-dir`` are gated against -- and read the
  servable ones.
* ``/reveal`` opens a window on this machine's desktop, and ``PUT
  /projects-dir`` moves the one folder a paired device may save into and open
  from (``backend.lib.lan_paths``), so both answer only this machine's own UI
  and the desktop shell. Letting a LAN caller move that folder would let it
  widen its own sandbox to the whole disk.
* ``/recent`` offers a caller on another machine only the ``.tasmo``
  projects it may open: ``/api/project/load`` refuses it any project outside
  the projects folder and the library tree.
* ``/save`` spends a grant only a native Save dialog on this machine issues.
"""

from __future__ import annotations

import logging
import mimetypes
import os
import shutil
import threading
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request
from fastapi import UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.lib import known_paths, lan_paths, launch_token, reveal
from backend.lib.atomic import atomic_replace, temp_sibling
from backend.lib.cross_site import (
    refuse_cross_site,
    require_loopback_launch_or_pairing_token,
    require_loopback_or_launch_token,
)
from backend.modules.genaiproxy.access import caller_is_loopback

log = logging.getLogger(__name__)


router = APIRouter(dependencies=[Depends(refuse_cross_site)])


def _require_this_machine(request: Request, refusal: str) -> None:
    """403 with ``refusal`` unless this machine's own UI or the desktop shell
    is asking (``require_loopback_or_launch_token``); the words say what only
    works on the computer running theDAW, for the UI to show as-is."""
    try:
        require_loopback_or_launch_token(request)
    except HTTPException as e:
        raise HTTPException(403, refusal) from e


def _is_tasmo(path: str) -> bool:
    return path.lower().endswith(".tasmo")


# One save at a time, from the grant check to spending it, so two requests
# holding the same grant cannot both write.
_SAVE_LOCK = threading.Lock()


class RecordBody(BaseModel):
    path: str
    kind: str | None = None


class PathBody(BaseModel):
    path: str


@router.get("/folder", dependencies=[Depends(require_loopback_launch_or_pairing_token)])
def get_folder(kind: str = Query("")) -> dict[str, Any]:
    return {"kind": kind, "folder": known_paths.last_folder(kind or None)}


@router.get("/recent", dependencies=[Depends(require_loopback_launch_or_pairing_token)])
def get_recent(
    request: Request,
    kind: str = Query(""),
    exts: str = Query("", description="comma-separated, e.g. .mid,.midi"),
    limit: int = Query(20),
) -> dict[str, Any]:
    wanted = [e for e in exts.split(",") if e.strip()] or None
    if caller_is_loopback(request):
        # This machine's own UI: every remembered path.
        return {"items": known_paths.recent(kind or None, wanted, limit)}
    # A caller on another machine: a .tasmo it could not open (see the module
    # docstring) is left out, and the limit counts only what is kept.
    keep = max(0, min(limit, known_paths.MAX_RECENT_LIMIT))
    rows = [
        row
        for row in known_paths.recent(
            kind or None, wanted, known_paths.MAX_RECENT_LIMIT
        )
        if not _is_tasmo(row["path"]) or lan_paths.inside_project_roots(row["path"])
    ]
    return {"items": rows[:keep]}


@router.post(
    "/record", dependencies=[Depends(require_loopback_launch_or_pairing_token)]
)
def post_record(body: RecordBody, request: Request) -> dict[str, Any]:
    # The body names the path. Only the desktop shell that started this backend
    # holds the launch token, and it sends it for a download it finished, so
    # that record is servable and its folder becomes where the next picker of
    # that kind opens. Every other call is remembered as 'client', for Recent
    # menus only: it is never served and it moves no picker's folder.
    trusted = launch_token.header_matches(request)
    entry = known_paths.record(
        body.path,
        body.kind,
        source="download" if trusted else "client",
        update_folder=trusted,
    )
    return {"recorded": entry is not None, "kind": entry["kind"] if entry else None}


@router.get("/launch-token-check")
def get_launch_token_check(request: Request) -> dict[str, bool]:
    """Whether this request carries the launch token this backend was given.

    The desktop shell asks once when it attaches to a backend it did not start.
    The answer is a boolean and says nothing about the token itself."""
    return {"matches": launch_token.header_matches(request)}


@router.post("/reveal")
def post_reveal(body: PathBody, request: Request) -> dict[str, Any]:
    _require_this_machine(
        request,
        "Show in folder opens a window on the computer running theDAW, so it "
        "works only there.",
    )
    try:
        shown = reveal.reveal(body.path)
    except FileNotFoundError as e:
        raise HTTPException(404, f"Not found: {body.path}") from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except OSError as e:
        raise HTTPException(500, f"Could not open the file manager: {e}") from e
    return {"status": "ok", "path": shown}


@router.get("/file", dependencies=[Depends(require_loopback_launch_or_pairing_token)])
def get_file(path: str = Query("")) -> FileResponse:
    served = known_paths.find_servable(path)
    if served is None:
        # One answer for a path never recorded, one recorded but not servable,
        # and one that has since gone, so the route reveals nothing about the
        # filesystem to a caller that is not entitled to it.
        raise HTTPException(403, "theDAW does not serve that file.")
    media_type, _ = mimetypes.guess_type(served)
    return FileResponse(
        served,
        media_type=media_type or "application/octet-stream",
        filename=os.path.basename(served),
    )


@router.post("/save")
def post_save(
    file: UploadFile = File(...),
    path: str = Form(...),
    kind: str | None = Form(None),
    grant: str = Form(""),
) -> dict[str, Any]:
    """Write the upload to ``path``, which the user chose in a Save dialog.

    ``grant`` is the nonce /api/storage/pick-save returned for that path. It is
    spent only after the file is written, so a failed write can be retried with
    the same grant, and a second write with it is refused."""
    if known_paths.is_blocked_save_path(path):
        raise HTTPException(403, "That file type cannot be saved from theDAW.")
    with _SAVE_LOCK:
        if not known_paths.peek_save_grant(path, grant):
            raise HTTPException(403, "Choose where to save in the Save dialog first.")
        dest = Path(os.path.abspath(os.path.expanduser(path)))
        tmp = temp_sibling(dest)
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            with tmp.open("wb") as out:
                shutil.copyfileobj(file.file, out, 1 << 20)
            atomic_replace(tmp, dest)
        except OSError as e:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                log.debug("places.save: leftover temp file %s", tmp)
            raise HTTPException(500, f"Could not save {dest.name}: {e}") from e
        known_paths.consume_save_grant(path, grant)

    entry = known_paths.record(dest, kind or None, source="save")
    log.info("places: saved %s", dest)
    return {
        "path": str(dest),
        "kind": entry["kind"] if entry else known_paths.kind_for_path(dest),
    }


@router.get(
    "/projects-dir", dependencies=[Depends(require_loopback_launch_or_pairing_token)]
)
def get_projects_dir() -> dict[str, Any]:
    return {
        "path": str(known_paths.projects_dir()),
        "configured": known_paths.projects_dir_configured(),
    }


@router.put("/projects-dir")
def put_projects_dir(body: PathBody, request: Request) -> dict[str, str]:
    _require_this_machine(
        request,
        "The projects folder can be changed only on the computer running theDAW.",
    )
    try:
        chosen = known_paths.set_projects_dir(body.path)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"path": str(chosen)}
