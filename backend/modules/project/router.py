"""FastAPI router for .tasmo project save/load (/api/project/*)."""

from __future__ import annotations
import hashlib
import json
import logging
import mimetypes
import tempfile
import threading
import zipfile
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile as StarletteUploadFile

from backend.modules.genaiproxy.access import caller_is_loopback
from backend.modules.project import media_access
from backend.modules.project.tasmo_project import TasmoProject
from backend.modules.project.tasmo_file import TasmoFile
from backend.lib import known_paths, paths
from backend.lib.atomic import atomic_write
from backend.lib.cross_site import (
    refuse_cross_site,
    require_loopback_launch_or_pairing_token,
)

log = logging.getLogger(__name__)
# ITW security P1 follow-up (CRITICAL): this router writes and reads
# arbitrary-caller-named files (/save, /save-session, /load, /export/audio)
# and takes a multipart body (/save-session), which is a CORS-simple request
# reachable from a plain <form> on any website with no preflight -- the
# caller's TCP peer is then the user's OWN browser (loopback), so a gate that
# only checks the peer never sees it. Every other path-writing router
# (places/router.py, storage/router.py, backup/router.py) already carries
# this dependency at router level; this one did not.
router = APIRouter(dependencies=[Depends(refuse_cross_site)])

# Formats the browser (Electron/Chromium) decodes natively — served as-is.
_BROWSER_OK_EXTS = {
    ".wav",
    ".wave",
    ".bwf",
    ".flac",
    ".mp3",
    ".ogg",
    ".oga",
    ".m4a",
    ".aac",
    ".opus",
    ".webm",
    ".weba",
}
# Formats Chromium can't reliably decode (DAW-native sample formats) — these are
# transcoded to WAV on the fly so an imported project still plays.
_TRANSCODE_EXTS = {
    ".aif",
    ".aiff",
    ".aifc",
    ".caf",
    ".wv",
    ".wma",
    ".w64",
    ".rf64",
}
# RIFF-family extensions where the extension says "browser-native" but the
# sample format still might not be. Worth a header read before serving; every
# other extension is either always decodable or already being transcoded, and
# probing those would only buy an ffprobe subprocess per request.
_DEPTH_SENSITIVE_EXTS = {".wav", ".wave", ".bwf"}
# The endpoint only serves recognized audio (keeps it from being a general file
# reader). The union of what we serve directly and what we transcode.
_AUDIO_EXTS = _BROWSER_OK_EXTS | _TRANSCODE_EXTS


# --- Recent files tracking (in-memory, mirrored to disk so it survives restarts) ---
_RECENT_PATH = paths.data_path("recent_projects.json")
MAX_RECENT = 20


def _resolve_or_none(raw: str) -> Path | None:
    try:
        return Path(raw).expanduser().resolve()
    except (OSError, RuntimeError, ValueError):
        return None


def _within_known_project_roots(raw_path: str) -> bool:
    """True when ``raw_path`` resolves inside the user's projects folder or
    the library/generations tree."""
    resolved = _resolve_or_none(raw_path)
    if resolved is None:
        return False
    for root in (known_paths.projects_dir(), paths.library_root()):
        root_resolved = _resolve_or_none(str(root))
        if root_resolved is None:
            continue
        if resolved == root_resolved or resolved.is_relative_to(root_resolved):
            return True
    return False


def _require_known_root_for_lan(raw_path: str, request: Request, *, what: str) -> None:
    """Authorization on top of ``require_loopback_launch_or_pairing_token``'s
    authentication (ITW security P1 follow-up): a *paired* phone is a
    legitimate caller, but that only proves who it is, not that any path it
    names should be trusted -- without this, a paired phone (or anyone who
    steals its token) could still write to, or read from, any path on the
    machine via ``/save-session``/``/export/audio``. Loopback callers (this
    machine's own UI) are unaffected, same posture as the rest of this
    router's ``path``/``output_dir`` params, which is not a regression: they
    were open to any LAN caller before this batch."""
    if caller_is_loopback(request):
        return
    if not _within_known_project_roots(raw_path):
        raise HTTPException(
            403, f"{what} must be inside a known projects or library folder."
        )


def _load_recent() -> list[dict]:
    """Read the persisted recent list, dropping malformed entries. Any failure
    yields an empty list because recent-project history is a convenience and
    must never block module import or server startup."""
    try:
        raw = json.loads(_RECENT_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(raw, list):
        return []
    entries: list[dict] = []
    for item in raw:
        if (
            isinstance(item, dict)
            and isinstance(item.get("path"), str)
            and isinstance(item.get("name"), str)
        ):
            entries.append({"path": item["path"], "name": item["name"]})
    return entries[:MAX_RECENT]


def _recent_stamp() -> tuple[int, int] | None:
    """The recent file's mtime and size, or None when there is no file."""
    try:
        st = _RECENT_PATH.stat()
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


# Guards _recent_files and _recent_seen: the save and load handlers run on the
# threadpool and both rewrite the list.
_RECENT_LOCK = threading.Lock()
# Stamped before the read, so a write landing between the two reads again.
_recent_seen: tuple[int, int] | None = _recent_stamp()
_recent_files: list[dict] = _load_recent()

# Projects opened before this process started still have their folders in the
# recent list; seeding from it keeps their clips playable when the UI restores
# a session from its own storage without re-issuing /load.
media_access.register_paths(r["path"] for r in _recent_files)


def _sync_recent_locked() -> None:
    """Re-read recent_projects.json when something else has rewritten it.

    A backup restore writes the file straight to disk while this process holds
    its own copy, so without this the list served after a restore, and the one
    the next save wrote back, was the list from before it. The restored
    projects' folders are registered the way the startup seed registers them.
    Call under _RECENT_LOCK.
    """
    global _recent_files, _recent_seen
    stamp = _recent_stamp()
    if stamp == _recent_seen:
        return
    _recent_seen = stamp
    _recent_files = _load_recent()
    media_access.register_paths(r["path"] for r in _recent_files)


def _register_project_media(
    project: TasmoProject, *paths: str, request: Request | None
) -> None:
    """Grant /clip-audio the folders an opened project draws from.

    Opening a project is the user's consent for the files it names, so each
    clip's linked folder joins the allowlist. In-archive relative refs
    (``audio/kick.wav``) are ignored by register_paths.

    A clip's takes are enumerated as well as its own ``audio_file``. Embedded
    takes extract beside the clip's audio, so the clip's own path covered them
    incidentally -- but not when the clip's own file is gone while a take's is
    still there (nothing registers the folder and ``/clip-audio`` answers 403),
    and not when a linked project's alternate passes were recorded into another
    folder.

    CRITICAL follow-up: ``project.tracks[*].clips[*].audio_file`` (and each
    clip's takes) come straight from the caller's request body -- for a
    non-loopback caller that is not "the user's consent", it is arbitrary
    attacker-chosen text. Registering it would permanently widen the
    ``/clip-audio`` allowlist for whatever the caller named, so those refs are
    only folded in when the caller is this machine's own UI. ``paths`` (the
    ``.tasmo`` file's own location) is unaffected -- callers that reach this
    function have already had it checked by ``_require_known_root_for_lan``.
    ``request`` defaults to ``None`` for direct (non-HTTP) callers, which are
    trusted the same as loopback -- every HTTP route on this router passes
    its own ``Request`` explicitly.
    """

    refs: list[str | None] = [*paths]
    if request is None or caller_is_loopback(request):
        for track in project.tracks:
            for clip in track.clips:
                refs.append(clip.audio_file)
                refs.extend(take.audio_file for take in (clip.takes or []))
    media_access.register_paths(refs)


class SaveRequest(BaseModel):
    project: dict  # TasmoProject as JSON dict
    path: str  # Where to save the .tasmo file
    embed_audio: bool = False  # If True, bundle audio; if False, link


class LoadRequest(BaseModel):
    path: str  # Path to the .tasmo file to open


class ExportAudioRequest(BaseModel):
    path: str  # Path to the .tasmo file
    output_dir: str  # Directory to extract embedded audio into


class LoadResponse(BaseModel):
    project: dict
    manifest: dict


@router.post("/save")
def save_project(req: SaveRequest, request: Request):
    """Serialize current session → .tasmo file."""
    # ITW security P1 (CRITICAL follow-up): this gate used to sit inside
    # `if req.embed_audio:` only, on the theory that linking (embed_audio=
    # False) "writes no audio bytes". It still writes a caller-named .tasmo
    # file to an arbitrary path and still calls _register_project_media,
    # which (before that function's own fix) fed caller-body-controlled
    # clip.audio_file values into media_access.register_paths ->
    # register_root, permanently widening the /clip-audio allowlist for an
    # unauthenticated LAN caller. Both checks now cover /save unconditionally,
    # same as /save-session and /export/audio. The phone legitimately does
    # this over LAN, so the pairing token (not just the desktop shell's
    # launch token) unlocks it -- but only inside a known projects/library
    # root.
    require_loopback_launch_or_pairing_token(request)
    _require_known_root_for_lan(req.path, request, what="path")
    try:
        project = TasmoProject.model_validate(req.project)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid project data: {e}")

    # Auto-append .tasmo extension
    path = req.path
    if not path.endswith(".tasmo"):
        path += ".tasmo"

    # Create the destination folder if needed (e.g. a fresh default projects dir
    # the user never created by hand).
    try:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass

    try:
        manifest = TasmoFile.save(project, path, embed_audio=req.embed_audio)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save .tasmo: {e}")

    # Track in recent files
    _add_recent(path, project.project_name)
    _register_project_media(project, path, request=request)
    return {"status": "saved", "path": path, "manifest": manifest}


# A session save uploads one file part per clip and one per take. Starlette's
# multipart default of 1000 file parts is sized for a web form, and an
# arrangement with more than 1000 clips and takes failed against it with "Too
# many files". This ceiling is far above what a browser tab can hold in memory
# as clip audio, and still bounds the temp files one request can open. It is
# applied only after the caller has passed the token gate.
SESSION_MAX_FILES = 50_000

_SAVE_SESSION_BODY = {
    "required": True,
    "content": {
        "multipart/form-data": {
            "schema": {
                "type": "object",
                "required": ["project", "path"],
                "properties": {
                    "project": {
                        "type": "string",
                        "format": "binary",
                        "description": (
                            "The TasmoProject JSON as a file part. A plain text "
                            "field is also read, up to Starlette's 1 MB limit "
                            "for a non-file part."
                        ),
                    },
                    "path": {"type": "string"},
                    "files": {
                        "type": "array",
                        "items": {"type": "string", "format": "binary"},
                        "description": "One upload per clip and per take.",
                    },
                },
            }
        }
    },
}


def _parse_project(text: str | bytes) -> TasmoProject:
    """The project JSON of a session save, validated as a TasmoProject."""
    return TasmoProject.model_validate(json.loads(text))


@router.post("/save-session", openapi_extra={"requestBody": _SAVE_SESSION_BODY})
async def save_session(request: Request):
    """Save the LIVE session (the EDIT timeline) to a .tasmo, embedding each
    clip's audio bytes uploaded alongside the project JSON.

    The plain ``/save`` endpoint only links files already on disk, which cannot
    capture in-browser editor clips (their audio lives in memory). This accepts
    the project JSON plus one upload per clip and per take; matched by archive
    filename — each ``audio_file`` points at ``audio/<filename>`` and the
    matching upload is written into the archive.

    The project JSON arrives as a FILE part (``project``). Starlette holds a
    plain text part to 1 MB, and a project of about 9,000 notes filled that, so
    the save failed with "Part exceeded maximum size" before this handler ran.
    A file part has no such limit; a small text field is still read for callers
    that post one. The form is parsed here rather than through FastAPI's
    ``Form``/``File`` parameters so the file-part ceiling can be raised (see
    ``SESSION_MAX_FILES``) and so the token gate runs before any of the body is
    read.

    Always embeds (unconditionally, unlike ``/save``): gated the same way
    every other write/read on this router is."""
    require_loopback_launch_or_pairing_token(request)
    async with request.form(max_files=SESSION_MAX_FILES) as form:
        path = form.get("path")
        if not isinstance(path, str) or not path:
            raise HTTPException(status_code=422, detail="path is required")
        _require_known_root_for_lan(path, request, what="path")
        raw_project = form.get("project")
        if raw_project is None:
            raise HTTPException(status_code=422, detail="project is required")
        try:
            project_text = (
                await raw_project.read()
                if isinstance(raw_project, StarletteUploadFile)
                else raw_project
            )
            # Off the event loop, like the archive write below: a large
            # arrangement is megabytes of JSON.
            tasmo = await run_in_threadpool(_parse_project, project_text)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid project data: {e}")

        audio_files: dict[str, bytes] = {}
        for f in form.getlist("files"):
            # Starlette's class, not FastAPI's subclass: ``request.form()``
            # builds the Starlette one. A text value under "files" names no
            # upload, so it is passed over like a nameless one.
            if not isinstance(f, StarletteUploadFile):
                continue
            name = Path(f.filename or "").name
            if not name:
                continue
            audio_files[name] = await f.read()

    out_path = path if path.endswith(".tasmo") else path + ".tasmo"
    try:
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass

    try:
        # On the threadpool: compressing a large archive takes seconds, and on
        # the event loop it stalled every other request (playback streams
        # included) until the save finished.
        manifest = await run_in_threadpool(
            TasmoFile.save, tasmo, out_path, audio_files=audio_files or None
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save .tasmo: {e}")

    _add_recent(out_path, tasmo.project_name)
    _register_project_media(tasmo, out_path, request=request)
    return {"status": "saved", "path": out_path, "manifest": manifest}


@router.post("/load", response_model=LoadResponse)
def load_project(req: LoadRequest, request: Request):
    """Deserialize .tasmo → restore session state."""
    # CRITICAL follow-up: identical write/read exposure to /save -- this had
    # no gate and no Request param at all. Gated the same way /save is.
    require_loopback_launch_or_pairing_token(request)
    _require_known_root_for_lan(req.path, request, what="path")
    try:
        project, manifest = TasmoFile.load(req.path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load .tasmo: {e}")

    _add_recent(req.path, project.project_name)
    _register_project_media(project, req.path, request=request)
    return LoadResponse(project=project.model_dump(), manifest=manifest)


@router.get("/info")
def project_info(path: str, request: Request):
    """Read manifest from .tasmo without full project load.

    NOTE-turned-fix: this had no gate and no known-root check, so a missing
    file 404s and an existing non-.tasmo file raised an uncaught
    ``BadZipFile`` -> 500 -- an exists/does-not-exist oracle for any path
    from any LAN caller. Gated like ``/save``; the ``BadZipFile`` is now
    caught."""
    require_loopback_launch_or_pairing_token(request)
    _require_known_root_for_lan(path, request, what="path")
    try:
        return TasmoFile.info(path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except zipfile.BadZipFile as e:
        raise HTTPException(status_code=400, detail=f"Invalid .tasmo file: {e}")


@router.get("/recent")
def recent_projects(request: Request):
    """List recently opened/saved projects.

    Gated like the rest of this router: with only ``refuse_cross_site``, a
    bare LAN caller sending no ``Origin``/``Referer``/``Sec-Fetch-Site`` got
    200 back with every recently opened absolute ``.tasmo`` path. The phone
    legitimately reads this, so the pairing token unlocks it."""
    require_loopback_launch_or_pairing_token(request)
    with _RECENT_LOCK:
        _sync_recent_locked()
        return list(_recent_files)


@router.get("/default-dir")
def default_projects_dir(request: Request):
    """The folder .tasmo saves and catalog project installs go into (created on
    first save): the one the user chose, else Documents/theDAW Projects.

    Gated like ``/recent``: an ungated LAN caller could read the OS username
    and project layout off this (``C:\\Users\\<name>\\Documents\\theDAW
    Projects``). The phone legitimately reads this too."""
    require_loopback_launch_or_pairing_token(request)
    return {"path": str(known_paths.projects_dir())}


def _transcode_cache_dir() -> Path:
    d = Path(tempfile.gettempdir()) / "thedaw_transcode"
    d.mkdir(parents=True, exist_ok=True)
    return d


async def _transcode_to_wav(src: Path) -> Path:
    """Transcode a sample the browser cannot read to a WAV it can.

    The depth survives as far as Chromium's decoder set allows: 24-bit stays
    24-bit and a float source comes out pcm_f32le, so a float CAF from an
    imported DAW project is not flattened to 16 bits just to reach the
    timeline. 64-bit float steps down to 32 — that is the cap, not a choice.
    Cached by source path + mtime + size so re-opening a project is instant.
    The codec choice is part of the key too: the source has not changed when
    this behaviour does, and a 16-bit file left over from the old rule would
    otherwise outlive it."""
    from backend.lib import ffmpeg
    from backend.lib.audio_depth import browser_pcm_args, probe_depth

    stat = src.stat()
    codec = " ".join(browser_pcm_args(probe_depth(src)))
    key = hashlib.sha1(
        f"{src.resolve()}|{stat.st_mtime_ns}|{stat.st_size}|{codec}".encode("utf-8")
    ).hexdigest()
    out = _transcode_cache_dir() / f"{key}.wav"
    if out.is_file() and out.stat().st_size > 0:
        return out
    await ffmpeg.render(src, out, filter_args=[], extra_out_args=codec.split())
    return out


@router.get("/clip-audio")
async def clip_audio(path: str, request: Request):
    """Stream a clip's on-disk audio so the browser can load it when a project
    is opened. ``.tasmo`` clips reference linked files by absolute path (or files
    extracted from an embedded archive); the frontend cannot read those directly,
    so it fetches them here. Formats the browser reads are served as-is;
    DAW-native containers (AIFF/CAF/W64/…) and sample formats Chromium has no
    decoder for are transcoded to WAV on the fly. Restricted to audio
    inside theDAW's media roots (see media_access) because the server binds
    0.0.0.0 and this route would otherwise read any file on the machine.

    Gated the same as ``/save``/``/load``: this used to be the only route on
    this router with no ``Request`` param and no token gate, which
    ``refuse_cross_site`` alone does not close (a bare LAN script sending no
    ``Origin``/``Referer``/``Sec-Fetch-Site`` passes it). The module's
    original "deliberately anonymous, the phone needs it" rationale predates
    the LAN pairing token; the phone now carries one, so it gates like every
    other project route instead. Containment is unaffected: a phone's clips
    in a projects folder the user moved (not one of media_access's static
    roots) still resolve, because the ``.tasmo`` file's own path is folded
    into the session-root allowlist unconditionally by
    ``_register_project_media`` on every ``/load``/``/save``, regardless of
    whether the caller was loopback or a paired phone."""
    require_loopback_launch_or_pairing_token(request)
    p = media_access.resolve_media_path(path)
    if p is None:
        # Answered before any existence check, and identically for "outside the
        # roots" and "unparseable", so the route reveals nothing about the
        # filesystem to a caller that is not entitled to it.
        raise HTTPException(
            status_code=403, detail="Path is outside theDAW media roots"
        )
    ext = p.suffix.lower()
    if ext not in _AUDIO_EXTS:
        raise HTTPException(status_code=400, detail=f"Not an audio file: {p.name}")
    if not p.is_file():
        raise HTTPException(status_code=404, detail="Audio file not found")

    # Extension is not enough to decide this. A 64-bit float file is almost
    # always named .wav, lands in _BROWSER_OK_EXTS, and then fails
    # decodeAudioData silently — Chromium has no pcm_f64le decoder. So for the
    # RIFF family the file's actual sample format gets the vote.
    needs_transcode = ext in _TRANSCODE_EXTS
    if not needs_transcode and ext in _DEPTH_SENSITIVE_EXTS:
        from backend.lib.audio_depth import browser_can_decode, probe_depth

        needs_transcode = not browser_can_decode(probe_depth(p))

    if needs_transcode:
        try:
            wav = await _transcode_to_wav(p)
            return FileResponse(
                str(wav), media_type="audio/wav", filename=f"{p.stem}.wav"
            )
        except Exception as e:
            # Fall back to serving the original; the browser may still decode it.
            log.warning("clip-audio transcode failed for %s: %s", p.name, e)

    media_type, _ = mimetypes.guess_type(str(p))
    return FileResponse(
        str(p),
        media_type=media_type or "application/octet-stream",
        filename=p.name,
    )


@router.post("/export/audio")
def export_audio(req: ExportAudioRequest, request: Request):
    """Extract embedded audio files from .tasmo to disk.

    ``req.path`` is read and ``req.output_dir`` is written, both named by the
    caller -- gated the same as ``/save``'s ``embed_audio`` case."""
    require_loopback_launch_or_pairing_token(request)
    _require_known_root_for_lan(req.path, request, what="path")
    _require_known_root_for_lan(req.output_dir, request, what="output_dir")
    try:
        extracted = TasmoFile.extract_audio(req.path, req.output_dir)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to extract audio: {e}")
    # The user picked this destination, so its files are theirs to play back.
    media_access.register_paths(extracted)
    return {"extracted": extracted, "count": len(extracted)}


@router.get("/list-audio")
def list_audio(path: str, request: Request):
    """List embedded audio file names inside a .tasmo.

    NOTE-turned-fix: same exists/does-not-exist oracle as ``/info`` -- gated
    the same way, and ``BadZipFile`` is now caught instead of 500ing."""
    require_loopback_launch_or_pairing_token(request)
    _require_known_root_for_lan(path, request, what="path")
    try:
        return {"files": TasmoFile.list_audio(path)}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except zipfile.BadZipFile as e:
        raise HTTPException(status_code=400, detail=f"Invalid .tasmo file: {e}")


def _add_recent(path: str, name: str) -> None:
    """Add to recent files list (deduped, most recent first), and remember the
    file in known_paths for the Recent menus.

    The path comes from the request body, so known_paths stores it as 'client',
    never serves it (a save can embed any file the body names) and leaves the
    'tasmo' picker folder where it is. The Save and Open dialogs record that
    folder through /api/storage. A Recent .tasmo reopens through
    /api/project/load by path."""
    global _recent_files, _recent_seen
    with _RECENT_LOCK:
        _sync_recent_locked()
        entry = {"path": path, "name": name}
        _recent_files = [r for r in _recent_files if r["path"] != path]
        _recent_files.insert(0, entry)
        _recent_files = _recent_files[:MAX_RECENT]
        # Best-effort persistence: recent-list IO must never fail a save/load
        # request.
        try:
            atomic_write(_RECENT_PATH, json.dumps(_recent_files, indent=2))
            _recent_seen = _recent_stamp()
        except OSError as e:
            log.warning("project.recent: failed to persist %s: %s", _RECENT_PATH, e)
    known_paths.record(path, kind="tasmo", source="client", update_folder=False)
