"""FastAPI router for VST3 plugin hosting (/api/vst/*)."""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import io
import json
import logging
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from backend.modules.vst.scanner import (
    Vst3PluginInfo,
    carry_over_metadata,
    list_plugin_classes,
    scan_vst3_directories,
    load_cached_scan,
    read_cache_entries,
    save_scan_cache,
    start_background_enrichment,
)
from backend.modules.vst.host import (
    param_key,
    load_plugin,
    unload_plugin,
    get_instance,
    list_instances,
    process_chain,
    process_with_plugin,
    list_builtin_effects,
)
from backend.modules.vst.live_host import HostLocator, _os_reason
from backend.modules.vst import path_policy
from backend.modules.vst.path_policy import (
    PluginPathError,
    check_plugin_path,
)
from backend.modules.genaiproxy.access import _caller_is_loopback
from backend.lib.cross_site import (
    refuse_cross_site,
    require_loopback_launch_or_pairing_token,
    require_loopback_or_launch_token,
)
from backend.lib.lan_paths import require_project_root_for_lan
from backend.lib.known_paths import is_remote_or_device_path
from backend.lib import paths
from backend.lib.launch_token import child_env

log = logging.getLogger(__name__)

#: Render subprocesses are headless: no console window may flash on Windows.
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
router = APIRouter(dependencies=[Depends(refuse_cross_site)])

# Per-plugin captured editor state (from the native-GUI sidecar) lands here.
_PRESET_DIR = paths.data_path("vst_presets")

# Editor sidecars spawned by this process, so a crashed editor can be detected
# instead of leaving the frontend polling a status that will never change.
_editor_procs: dict[str, subprocess.Popen] = {}


# Only the desktop shell's own loopback socket ever needs a live VST host: the
# native process it spawns binds a loopback-only WebSocket (live_host.py), so
# a LAN caller could never reach the session it asked for, only spend a slot
# and an OS process on a plugin it can never talk to. In dev/desktop, the
# browser never talks to this server directly — it goes through the Vite
# proxy (frontend/vite.config.ts, electron-ui/electron.vite.config.ts), which
# runs ON THIS MACHINE and therefore always arrives here as a loopback peer
# itself, regardless of where the original browser request came from. The
# proxy's ``xfwd: true`` stamps X-Forwarded-For with the real caller's
# address, and uvicorn's ``ProxyHeadersMiddleware`` reads it back and rewrites
# ``request.client``. ``proxy_headers`` defaults to True; ``backend/run.py``
# pins ``forwarded_allow_ips="127.0.0.1"`` explicitly (T02) rather than
# leaning on that argument's own default, which reads the
# ``FORWARDED_ALLOW_IPS`` environment variable (falling back to the literal
# ``"127.0.0.1"`` only when it is unset — verified against the installed
# uvicorn's own source, ``uvicorn/config.py``) and so could be widened by
# whatever sets that variable on the machine or spawns this process.
def _require_loopback(request: Request) -> None:
    """403 for a caller whose TCP peer is not this machine (LAN2).

    Delegates to ``genaiproxy.access._caller_is_loopback`` — the same check
    ``backend.lib.cross_site.require_loopback_or_launch_token`` uses — rather
    than re-deriving loopback-ness from ``request.client`` here. 403, not
    409: every other identity refusal in the repo is 403
    (``backend/lib/cross_site.py``), and this route bars a caller from a slot
    the way those do, not a resource conflict a 409 would imply.
    """
    if not _caller_is_loopback(request):
        raise HTTPException(
            status_code=403, detail="Live VST sessions are loopback-only."
        )


def _require_this_machine_for_editor(request: Request) -> None:
    """403 for the plugin editor routes unless this machine's own UI or the
    desktop shell is asking.

    A paired device passes the scan and render routes, but a plugin's own
    window opens on the computer running theDAW, where a user on another
    device can neither see nor close it (and closing it is what captures the
    plugin's settings). So these stay loopback-or-launch-token, and the
    refusal says why in words the MIX error line can show as-is."""
    try:
        require_loopback_or_launch_token(request)
    except HTTPException as e:
        raise HTTPException(
            status_code=403,
            detail=(
                "Plugin windows open on the computer running theDAW. Open this "
                "plugin's window there."
            ),
        ) from e


def _validated_plugin_path(raw: str) -> Path:
    """A browser-supplied ``plugin_path``, policed by ``path_policy`` (R5-2).

    Validates shape (a real ``.vst3`` path, no UNC/network path) and
    containment inside ``path_policy.allowed_roots()`` — the same directories
    the scanner offers in the UI, a plugin linked into one of them included
    (``path_policy.is_allowed``). Deliberately does not check existence:
    ``path_policy.check_plugin_path`` reads the filesystem only to resolve
    the path and, for a path outside every root once resolved, to find the
    links inside the roots; it never asks whether the plugin itself exists.
    Callers that want a specific "not found" message do that check
    themselves, afterward, using the returned path.
    """
    try:
        return check_plugin_path(raw)
    except PluginPathError as e:
        raise HTTPException(status_code=e.status, detail=e.message)


def _validated_scan_directory(raw: str) -> Path:
    """A browser-supplied scan directory, policed the same way a plugin path
    is (R5-2's containment half only — a directory has no ``.vst3`` suffix to
    require)."""
    raw = str(raw or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="path is required")
    if is_remote_or_device_path(raw):
        raise HTTPException(
            status_code=400, detail="Network or device paths are not allowed."
        )
    try:
        resolved = Path(raw).resolve(strict=False)
    except (OSError, ValueError):
        raise HTTPException(status_code=400, detail="path could not be resolved.")
    if not path_policy.is_allowed(raw, resolved):
        roots = path_policy.allowed_roots()
        if not roots:
            # "not inside any of the 0 allowed VST3 directories" tells the
            # user nothing they can act on — this is the one case where NO
            # path could ever pass, because none of this platform's standard
            # VST3 directories exists on this machine yet (a fresh install,
            # or a machine with no plugins).
            raise HTTPException(
                status_code=403,
                detail=(
                    "No standard VST3 directory exists on this machine yet — "
                    "install a VST3 plugin in one of this platform's standard "
                    "locations first. This endpoint cannot scan a directory "
                    "outside them."
                ),
            )
        count = len(roots)
        noun = "directory" if count == 1 else "directories"
        raise HTTPException(
            status_code=403,
            detail=f"path is not inside any of the {count} allowed VST3 {noun}.",
        )
    return resolved


def _canonical_plugin_key(raw: str) -> str:
    """The one normalisation every editor route (open, rect, size, result,
    alive) must agree on before hashing a plugin path into its session key.

    ``/open-editor`` validates and resolves ``plugin_path`` through
    ``_validated_plugin_path`` once, when the sidecar is spawned. Every other
    editor route is a poll or a follow-up against a session that call already
    started — a forward-slash, different-case, or junction/symlink form of
    the SAME path the browser happens to send this time must still hash to
    the session ``/open-editor`` created, or the state capture, embed move,
    and close paths all silently miss it (the failure this function fixes).
    Unlike ``_validated_plugin_path`` this never raises and never enforces
    containment: a read/update route must not 403 or "not found" a caller
    over policy — it must find the session the validated route already
    started, using the exact same key, or correctly report none exists.
    """
    raw = str(raw or "").strip()
    if not raw:
        return raw
    try:
        return str(Path(raw).resolve(strict=False))
    except (OSError, ValueError):
        return raw


def _preset_path(plugin_path: str) -> Path:
    plugin_path = _canonical_plugin_key(plugin_path)
    h = hashlib.sha1(plugin_path.encode("utf-8")).hexdigest()[:16]
    stem = Path(plugin_path).stem
    safe = "".join(c for c in stem if c.isalnum() or c in "-_") or "plugin"
    return _PRESET_DIR / f"{safe}_{h}.json"


def _rect_path(plugin_path: str) -> Path:
    return _preset_path(plugin_path).with_suffix(".rect.json")


def _size_path(plugin_path: str) -> Path:
    return _preset_path(plugin_path).with_suffix(".size.json")


def _pid_path(plugin_path: str) -> Path:
    return _preset_path(plugin_path).with_suffix(".pid")


def _pid_alive(pid: int) -> bool:
    """Whether a process id is still running, without signalling it."""
    if pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes

        SYNCHRONIZE = 0x00100000
        WAIT_TIMEOUT = 0x00000102
        handle = ctypes.windll.kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if not handle:
            return False
        try:
            return ctypes.windll.kernel32.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _editor_alive(plugin_path: str) -> bool:
    """Whether the sidecar owning this plugin's editor is still running.

    The Popen handle is authoritative while the server that spawned it is up;
    the pid file covers the case where the server restarted underneath a live
    editor, so a running editor is never declared dead.
    """
    plugin_path = _canonical_plugin_key(plugin_path)
    proc = _editor_procs.get(plugin_path)
    if proc is not None:
        return proc.poll() is None
    pid_file = _pid_path(plugin_path)
    if not pid_file.is_file():
        return False
    try:
        return _pid_alive(int(pid_file.read_text(encoding="utf-8").strip()))
    except (OSError, ValueError):
        return False


# --- Request / Response models ---
class LoadRequest(BaseModel):
    plugin_path: str
    instance_id: str | None = None


class SetParamRequest(BaseModel):
    name: str
    value: float


class ProcessRequest(BaseModel):
    instance_ids: list[str]  # Ordered chain of instance IDs
    audio_path: str  # Path to a WAV/FLAC/etc. on disk
    output_path: str | None = None  # Where to write; temp file if omitted


class ScanResponse(BaseModel):
    plugins: list[dict]


class EditorRequest(BaseModel):
    plugin_path: str
    raw_state: str | None = None
    # Which plugin inside a multi-plugin .vst3 to open. Omitted -> the loader's
    # first entry, which need not be the one this chain node renders with.
    plugin_name: str | None = None
    # Embedding (Electron/Windows): the host BrowserWindow HWND + initial embed
    # rect. When parent_hwnd is set the editor is reparented into that window over
    # the rect; omitted -> the editor opens as a floating window (default).
    parent_hwnd: int | None = None
    rect: dict | None = None  # {x, y, w, h, dpr} in CSS px (+ devicePixelRatio)


class EditorRectRequest(BaseModel):
    plugin_path: str
    x: float = 0
    y: float = 0
    w: float = 0
    h: float = 0
    sx: float = 0  # scroll offset within the (natural-size) editor, physical px
    sy: float = 0
    dpr: float = 1
    close: bool = False  # set true to close the embedded editor


# --- Endpoints ---


@router.get("/scan", response_model=ScanResponse)
def scan_vst3(
    request: Request,
    refresh: bool = False,
    enrich: bool = True,
    include_unloadable: bool = False,
):
    """Scan standard VST3 directories.

    Serves the cache when it is still valid for the current contents of the scan
    roots; ``refresh=true`` forces a fresh walk and gives previously failed
    plugins another chance. A fresh walk lists each new module's classes
    through the native host before it answers, so the answer already says
    which plugins are instruments; ``enrich=false`` opens no plugin at all. Plugins this host cannot load are withheld unless
    ``include_unloadable`` asks for them, so the UI never offers a dead tile.

    Gated: this hands a caller the absolute plugin paths of this machine, and
    enumerating installed plugins is itself information this machine's
    filesystem layout should not leak to an unknown LAN caller.

    This route IS reachable from the LAN, not just from this machine's own
    UI: ``frontend/vite.config.ts`` and ``electron-ui/electron.vite.config.ts``
    both bind their dev server to ``host: '0.0.0.0'`` with ``xfwd: true``, so
    a LAN browser that loads ``http://<this-machine's-lan-ip>:5173/`` gets
    the full desktop SPA, and ``backend/server.py`` also mounts
    ``frontend/dist`` at ``/`` when it exists, serving the same UI over the
    LAN once built. Either way the MIX tab's own ``/api/vst/scan`` call then
    arrives here as a genuine LAN peer -- uvicorn's ``forwarded_allow_ips``
    is pinned to ``127.0.0.1`` in ``backend/run.py``, so ``request.client``
    is rewritten from ``X-Forwarded-For`` only for a proxy connecting from
    loopback. The gate therefore accepts the LAN pairing token the same way
    the project routes do: a device opened from the Mobile Access share link
    (which carries ``#pair=<token>``, see ``frontend/src/lib/pairing.ts``)
    sends it on every request and gets MIX, and an unpaired LAN browser is
    refused. ``frontend/src/state/vstStore.ts`` shows that refusal in the
    MIX effects browser as "pair this device", not as a failure.
    """
    require_loopback_launch_or_pairing_token(request)
    plugins: list[Vst3PluginInfo] | None = None
    if not refresh:
        plugins = load_cached_scan()
    if plugins is None:
        plugins = scan_vst3_directories()
        carry_over_metadata(plugins, read_cache_entries(), retry_failed=refresh)
        if enrich:
            # A module's factory names its classes' vendor, version and
            # instrument/effect category in well under a second, so the list
            # the user opened says which plugins are instruments.
            list_plugin_classes(plugins)
        save_scan_cache(plugins)
    body = _plugin_dicts(plugins, include_unloadable)
    if enrich:
        # What the host could not list is loaded through pedalboard, which is
        # far too slow to hold a request; the worker fills the cache in and the
        # next scan serves it.
        start_background_enrichment(plugins)
    return ScanResponse(plugins=body)


@router.get("/scan/{path:path}", response_model=ScanResponse)
def scan_vst3_custom(path: str, request: Request, include_unloadable: bool = False):
    """Scan one directory for VST3 plugins (always live, never cached).

    NOT a general "browse anywhere on disk" scan, despite the name and this
    route's original docstring: R5-2 requires ``path`` to already resolve
    inside one of ``path_policy.allowed_roots()`` — the same standard,
    per-platform VST3 directories ``/load``, ``/process-file``,
    ``/open-editor`` and ``/live/session`` require a plugin path to resolve
    inside. Scanning a directory outside them would only ever list plugins
    every one of those routes then refuses to load — a 403 the UI has no way
    to explain, since it already believed the scan — which is worse than this
    endpoint simply refusing that directory up front.

    There is currently no way for a user to ADD a non-standard directory to
    the allowed set: that would mean giving ``path_policy.allowed_roots()`` a
    user-configured-roots source that ``scanner._default_vst3_dirs()`` also
    reads, which is real, standalone feature work (a persisted, user-editable
    location list, its own settings UI, migration for whoever already has
    plugins outside the standard roots) — out of scope for this fix, and
    deliberately not bolted on here. Nothing in the app calls this route
    today (T03 batch-12 audit, grepped the whole frontend); it is left
    working for the one case still consistent with the rule above — browsing
    a SUBDIRECTORY of a standard root, e.g. one vendor folder inside
    ``...\\Common Files\\VST3\\`` — which ``/scan`` (no ``path``) does not
    offer on its own since it always walks every standard root at once.

    Gated for the same reason, and the same way, ``/scan`` is: it hands back
    absolute plugin paths.
    """
    require_loopback_launch_or_pairing_token(request)
    resolved = _validated_scan_directory(path)
    plugins = scan_vst3_directories(extra_paths=[str(resolved)])
    return ScanResponse(plugins=_plugin_dicts(plugins, include_unloadable))


@router.post("/load")
def load_vst(req: LoadRequest, request: Request):
    """Load a VST3 plugin and return its parameter descriptors.

    Gated: this initializes a third-party native DLL inside the server
    process and leaks an instance into ``_instances`` with no cap -- an
    unknown LAN caller looping this with a fresh ``instance_id`` each time
    must not be able to. A paired device is a known caller, the same as for
    the project routes.
    """
    require_loopback_launch_or_pairing_token(request)
    resolved = _validated_plugin_path(req.plugin_path)
    try:
        inst = load_plugin(str(resolved), req.instance_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load VST3: {e}")
    return {
        "instance_id": inst.instance_id,
        "plugin_name": inst.plugin_name,
        "plugin_path": inst.plugin_path,
        "parameters": inst.parameters,
    }


@router.get("/plugins")
def get_loaded_plugins(request: Request):
    """List all currently loaded plugin instances.

    Gated like ``/scan``: this hands back absolute plugin paths (the same
    leak ``/scan``'s docstring already flags) and the live ``instance_id``s
    that a caller would need to target ``/param/{instance_id}`` or
    ``/unload/{instance_id}``.
    """
    require_loopback_launch_or_pairing_token(request)
    return list_instances()


@router.post("/process")
def process_audio(req: ProcessRequest, request: Request):
    """Run an audio file through an ordered chain of loaded VST instances.

    Reads the file at its native sample rate, processes it through the
    instances named in ``instance_ids`` (in order), and writes a WAV to
    ``output_path`` (or a temp file) at the source's own bit depth. Returns
    the output path.

    Gated: this runs plugin code against an arbitrary instance chain.
    ``audio_path`` (arbitrary read) and ``output_path`` (arbitrary write) are
    also policed the same way every other path-taking route in this repo
    refuses a network/device path -- checked against BOTH the raw text and
    the ``resolve()``d path (``known_paths.is_remote_or_device_path`` -- the
    same check ``_validated_scan_directory`` and
    ``backend/modules/storage/router.py`` use). The raw-text check alone is
    not enough: an NT object-manager prefix like ``\\??\\UNC\\host\\share\\x``
    has only ONE leading backslash, so the raw-text regex misses it, but
    Windows honours the prefix and ``Path.resolve()`` normalises it to
    ``\\\\host\\share\\x``, which the same check then catches.

    A paired device passes the gate the same way it does on the project
    routes, and is confined the same way too: both paths must sit inside the
    projects folder or the library tree (``backend.lib.lan_paths``), checked
    before the file is touched so a refusal says nothing about what exists.
    This machine's own UI keeps naming any local path.
    """
    require_loopback_launch_or_pairing_token(request)
    import numpy as np

    from backend.lib.audio_depth import write_like_source
    from backend.lib.audio_io import load_audio_array

    def _reject_remote_or_device(raw: str) -> Path:
        """The resolved ``Path`` for ``raw``, after rejecting it (400) as a
        network/device path by BOTH its raw text and its resolved form.

        ``resolve(strict=False)`` can itself raise ``OSError`` for an
        object-manager path naming a device that does not exist on this
        machine (e.g. an out-of-range ``HarddiskVolumeN``) -- that is a
        malformed/inapplicable path, not a server error, so it is rejected
        the same way.
        """
        if is_remote_or_device_path(raw):
            raise HTTPException(
                status_code=400, detail="Network or device paths are not allowed."
            )
        try:
            resolved = Path(raw).resolve(strict=False)
        except (OSError, ValueError):
            raise HTTPException(
                status_code=400, detail="Network or device paths are not allowed."
            )
        if is_remote_or_device_path(str(resolved)):
            raise HTTPException(
                status_code=400, detail="Network or device paths are not allowed."
            )
        return resolved

    src = _reject_remote_or_device(req.audio_path)
    require_project_root_for_lan(str(src), request, what="audio_path")
    resolved_output_path = None
    if req.output_path:
        resolved_output_path = _reject_remote_or_device(req.output_path)
        require_project_root_for_lan(
            str(resolved_output_path), request, what="output_path"
        )

    if not src.is_file():
        raise HTTPException(
            status_code=404, detail=f"Audio file not found: {req.audio_path}"
        )
    try:
        # load_audio_array answers (channels, frames) float32; pedalboard and
        # write_like_source below both want (frames, channels).
        channels_first, sr = load_audio_array(src)
        audio = np.ascontiguousarray(channels_first.T)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read audio: {e}")

    try:
        processed = process_chain(req.instance_ids, audio, sr)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=e.args[0])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"VST processing failed: {e}")

    created_temp = False
    out_path = str(resolved_output_path) if resolved_output_path else req.output_path
    if out_path:
        out = Path(out_path)
        if out.is_dir():
            raise HTTPException(
                status_code=400, detail=f"output_path is a directory: {out_path}"
            )
        if not out.parent.exists():
            raise HTTPException(
                status_code=400,
                detail=f"output_path parent directory does not exist: {out.parent}",
            )
        if not out.suffix:
            # soundfile infers the container format from the extension.
            out_path = str(out.with_suffix(".wav"))
    else:
        fd, out_path = tempfile.mkstemp(suffix="_vst.wav")
        os.close(fd)
        created_temp = True

    try:
        # Float in, float out, same as /process-file below: a chain that
        # requantizes between stages loses a little at every plugin, and this
        # endpoint exists precisely to run several in a row.
        write_like_source(out_path, processed, sr, src)
    except Exception as e:
        if created_temp:
            try:
                os.unlink(out_path)
            except OSError:
                pass
        raise HTTPException(status_code=500, detail=f"Could not write output: {e}")

    return {
        "output_path": out_path,
        "sample_rate": int(sr),
        "instance_ids": req.instance_ids,
        "frames": int(processed.shape[0]),
    }


#: Temp input/output/state files for ``state_host=thedaw`` renders.
_RENDER_DIR = paths.data_path("vst_render")

#: The render mode's documented exit codes (``native/vst-host/src/util/Args.cpp``),
#: in words the user can act on. 0 never reaches this table.
RENDER_EXIT_MEANINGS: dict[int, str] = {
    1: "the rendered file could not be written",
    2: "the host rejected its command line",
    3: "the plugin file was not found",
    4: "the plugin failed to load or initialize",
    5: "the plugin does not support the uploaded channel layout",
    6: "the host could not open its local socket",
    7: "the uploaded audio could not be read by the host",
}

#: A render is faster than real time, but a plugin that hangs must not hold the
#: request open forever.
RENDER_TIMEOUT_SECONDS = 300.0

#: After a timed-out render is killed, how long to wait for it to actually
#: exit before giving up on reading its pipes. Bounded on purpose: the
#: unbounded wait ``subprocess.run`` performs after a post-timeout kill is
#: exactly what could stall the request (review R5 nit #10).
RENDER_KILL_WAIT_SECONDS = 5.0

#: Bytes read per chunk while streaming an upload past its cap check.
_UPLOAD_READ_CHUNK_BYTES = 1024 * 1024

#: Default cap on a thedaw render's uploaded audio; override with
#: THEDAW_VST_RENDER_MAX_BYTES (review R5 item #7 — uploads had no cap at all).
_DEFAULT_RENDER_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024

#: raw_state is a small serialized preset, not a rendered file; a caller
#: sending more than this is misusing the field, not tuning ops, so there is
#: no env override.
_RENDER_MAX_RAW_STATE_CHARS = 64 * 1024 * 1024


class _UploadTooLarge(Exception):
    """Raised internally when a capped upload read exceeds its byte limit."""


def _render_max_upload_bytes() -> int:
    """``THEDAW_VST_RENDER_MAX_BYTES``, or the 2 GiB default if unset/invalid."""
    raw = os.environ.get("THEDAW_VST_RENDER_MAX_BYTES", "")
    try:
        value = int(raw)
    except ValueError:
        value = 0
    return value if value > 0 else _DEFAULT_RENDER_MAX_UPLOAD_BYTES


async def _read_upload_capped(upload: UploadFile, max_bytes: int, dest: Path) -> None:
    """Stream ``upload`` straight to ``dest`` in chunks, capped at ``max_bytes``.

    Each chunk is written to disk as it arrives instead of being accumulated
    into one big ``bytes`` object, so this process never buffers the whole
    upload in memory (review R5 item #7). Note this does not shorten the wire
    transfer itself — Starlette's multipart parser has already read and
    spooled the full request body before this handler ever runs — it only
    keeps OUR copy of it from doubling the memory footprint on its way to
    ``dest``. Stops at the first chunk that would push the running total over
    the cap, raising ``_UploadTooLarge`` before that chunk is written; ``dest``
    is left holding whatever was accepted so far, for the caller to remove.
    """
    total = 0
    with dest.open("wb") as f:
        while True:
            chunk = await upload.read(_UPLOAD_READ_CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise _UploadTooLarge(total)
            f.write(chunk)


def _strip_render_paths(text: str, paths_used: list[Path]) -> str:
    """Reduce any of this render's own temp-file paths to just their name.

    The host only ever learns these paths because they were put on its argv;
    if it echoes one back in a warning, the client should see the file name,
    never the server's directory layout (review R5 item #11).
    """
    for path in paths_used:
        text = text.replace(str(path), path.name)
    return text


def _render_log_tail(stderr: str, limit: int = 600) -> str:
    lines = [line.strip() for line in (stderr or "").splitlines() if line.strip()]
    if not lines:
        return "The host logged nothing."
    return "Log tail: " + " | ".join(lines[-8:])[:limit]


def _render_report_warnings(stdout: str) -> list[str]:
    """The ``warnings`` array out of the host's JSON report line, if any."""
    for line in reversed((stdout or "").splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            payload = json.loads(line)
        except ValueError:
            continue
        if not isinstance(payload, dict):
            continue
        found = payload.get("warnings")
        if isinstance(found, list):
            return [str(item) for item in found]
        return []
    return []


def _render_with_thedaw_host(
    work: Path,
    in_path: Path,
    plugin_path: str,
    plugin_name: str,
    state_blob: bytes | None,
    param_map: dict,
    warnings: list[str],
    midi_events: list[tuple[int, bytes]] | None = None,
    tail_seconds: str = "auto",
) -> bytes:
    """Render the audio already staged at ``in_path`` through
    ``thedaw-vst-host --render``.

    ``work`` is a directory the caller already created and already staged
    ``in_path`` under, and the caller owns removing it — in a ``finally`` that
    also covers the upload read that staged ``in_path``, not just this call
    (review R5 item #7). This function only adds the render's other files
    under ``work`` and reads the output back.

    Synchronous end to end (spawn, wait, read-back): the caller offloads this
    whole call with ``asyncio.to_thread`` so the up-to-``RENDER_TIMEOUT_SECONDS``
    wait never blocks the event loop. Returns the rendered WAV bytes. Every
    failure raises ``HTTPException``; there is deliberately no pedalboard
    fallback — a caller that asked for our host and silently got a different
    renderer would be shipping audio it never heard.

    Raises:
        HTTPException: 503 when the host binary is absent (with the locator's
            reason), 502 when the host exits non-zero or times out, 500 when the
            temp files cannot be written or the output cannot be read back.
    """
    locator = HostLocator()
    host = locator.resolve()
    if host is None:
        raise HTTPException(status_code=503, detail=locator.describe()["reason"])

    out_path = work / "out.wav"
    #: Every path the host was handed on its argv — the only paths it could
    #: possibly echo back in a warning or a log line (see
    #: ``_strip_render_paths``); applied to BOTH the warnings header and any
    #: stderr tail that reaches an error detail (review R5 item #11).
    temp_paths = [in_path, out_path]
    try:
        cmd = locator.launch_prefix(host) + [
            "--render",
            "--plugin",
            plugin_path,
            "--in",
            str(in_path),
            "--out",
            str(out_path),
            "--block-size",
            "1024",
            "--tail-seconds",
            tail_seconds,
        ]
        if midi_events:
            # An instrument: the MIDI it plays, one "<frame> <status> <data...>" line each.
            midi_path = work / "midi.txt"
            midi_path.write_text(
                "".join(
                    f"{frame} {' '.join(str(b) for b in data)}\n"
                    for frame, data in midi_events
                ),
                encoding="ascii",
            )
            temp_paths.append(midi_path)
            cmd += ["--midi-events", str(midi_path)]
        if plugin_name:
            cmd += ["--plugin-name", plugin_name]
        if state_blob:
            state_path = work / "state.bin"
            state_path.write_bytes(state_blob)
            temp_paths.append(state_path)
            cmd += ["--state-file", str(state_path)]
        if param_map:
            params_path = work / "params.json"
            params_path.write_text(json.dumps(param_map), encoding="utf-8")
            temp_paths.append(params_path)
            cmd += ["--params-json", str(params_path)]
    except OSError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not stage the render input: {_os_reason(e)}",
        )

    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(paths.PROJECT_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=_NO_WINDOW,
            env=child_env(),
        )
    except OSError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Could not start the VST host: {_os_reason(e)}",
        )

    try:
        stdout, stderr = proc.communicate(timeout=RENDER_TIMEOUT_SECONDS)
        returncode = proc.returncode
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
        except OSError:
            pass
        try:
            # A bounded wait, never the unbounded one subprocess.run does
            # after a post-timeout kill (review R5 nit #10). If the host
            # still won't die, stop waiting rather than stall the request.
            proc.communicate(timeout=RENDER_KILL_WAIT_SECONDS)
        except subprocess.TimeoutExpired:
            pass
        raise HTTPException(
            status_code=502,
            detail=(
                f"The VST host did not finish the render within "
                f"{RENDER_TIMEOUT_SECONDS:.0f}s and was stopped."
            ),
        )

    if returncode != 0:
        code = int(returncode)
        meaning = RENDER_EXIT_MEANINGS.get(code, f"the host exited with code {code}")
        raise HTTPException(
            status_code=502,
            detail=(
                f"The VST host could not render this file (exit code {code}): "
                f"{meaning}. "
                + _strip_render_paths(_render_log_tail(stderr), temp_paths)
            ),
        )

    try:
        rendered = out_path.read_bytes()
    except OSError as e:
        raise HTTPException(
            status_code=502,
            detail=(
                f"The VST host reported success but its output could not be "
                f"read ({_os_reason(e)}). "
                + _strip_render_paths(_render_log_tail(stderr), temp_paths)
            ),
        )
    warnings.extend(
        _strip_render_paths(w, temp_paths) for w in _render_report_warnings(stdout)
    )
    return rendered


@router.post("/process-file")
async def process_file(
    request: Request,
    audio: UploadFile = File(...),
    plugin_path: str = Form(...),
    params: str = Form("{}"),
    raw_state: str = Form(""),
    state_host: str = Form(""),
    plugin_name: str = Form(""),
):
    """Process an UPLOADED audio file through one VST3 plugin; return WAV bytes.

    Stateless mirror of /api/studio/process so a VST3 can be one stage of the
    MIX effect chain: the frontend uploads the running audio plus the plugin
    path and receives processed WAV back. The plugin is loaded fresh and
    discarded (never added to the instance registry).

    Gated: this loads and runs a plugin, same as ``/load`` and ``/process``,
    and a paired device passes the same way (MIX on a device opened from the
    share link renders its VST stages here).
    """
    require_loopback_launch_or_pairing_token(request)
    import numpy as np

    from backend.lib.audio_io import load_audio_array, save_audio

    resolved = _validated_plugin_path(plugin_path)
    if not resolved.exists():
        raise HTTPException(
            status_code=404, detail=f"VST3 plugin not found: {plugin_path}"
        )
    plugin_path = str(resolved)

    mode = (state_host or "").strip().lower() or "pedalboard"
    if mode not in ("pedalboard", "thedaw"):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown state_host {state_host!r}: expected 'thedaw' or "
                "'pedalboard' (or no value for the default)."
            ),
        )
    if mode == "thedaw":
        # Our own host renders the file. Deliberately a separate branch: it
        # neither reads nor rewrites the audio here, so the bytes the plugin
        # sees are the bytes that were uploaded.
        host_warnings: list[str] = []
        state_blob: bytes | None = None
        if raw_state:
            if len(raw_state) > _RENDER_MAX_RAW_STATE_CHARS:
                raise HTTPException(
                    status_code=413,
                    detail=(
                        f"raw_state exceeds the {_RENDER_MAX_RAW_STATE_CHARS} "
                        "byte limit for a thedaw render."
                    ),
                )
            try:
                state_blob = base64.b64decode(raw_state, validate=True)
            except (binascii.Error, ValueError) as e:
                raise HTTPException(
                    status_code=400, detail=f"raw_state was not valid base64: {e}"
                )
        try:
            host_params = json.loads(params) if params else {}
            if not isinstance(host_params, dict):
                host_warnings.append(
                    "params was not a JSON object; no parameters applied"
                )
                host_params = {}
        except json.JSONDecodeError as e:
            host_warnings.append(
                f"params was not valid JSON ({e}); no parameters applied"
            )
            host_params = {}
        try:
            _RENDER_DIR.mkdir(parents=True, exist_ok=True)
            work = Path(tempfile.mkdtemp(prefix="render-", dir=str(_RENDER_DIR)))
        except OSError as e:
            raise HTTPException(
                status_code=500,
                detail=f"Could not create the render directory: {_os_reason(e)}",
            )

        in_path = work / "in.wav"
        max_upload_bytes = _render_max_upload_bytes()
        try:
            try:
                await _read_upload_capped(audio, max_upload_bytes, in_path)
            except _UploadTooLarge:
                raise HTTPException(
                    status_code=413,
                    detail=(
                        f"The uploaded audio exceeds the {max_upload_bytes} byte "
                        "limit for a thedaw render."
                    ),
                )
            except OSError as e:
                raise HTTPException(
                    status_code=400,
                    detail=f"Could not read uploaded audio: {_os_reason(e)}",
                )
            except Exception as e:
                raise HTTPException(
                    status_code=400, detail=f"Could not read uploaded audio: {e}"
                )
            # Only the spawn+wait needs a thread — everything else here is
            # small, local file I/O that would not meaningfully block the
            # event loop.
            rendered = await asyncio.to_thread(
                _render_with_thedaw_host,
                work,
                in_path,
                plugin_path,
                plugin_name,
                state_blob,
                host_params,
                host_warnings,
            )
        finally:
            # Covers the upload read above as well as the render below — a
            # cap that rejects the upload must not leave a partial file
            # behind any more than a failed render would (review R5 item #7).
            shutil.rmtree(work, ignore_errors=True)
        host_headers: dict[str, str] = {}
        if host_warnings:
            host_headers["X-Vst-Warnings"] = json.dumps(
                host_warnings, ensure_ascii=True
            )[:4000]
            host_headers["Access-Control-Expose-Headers"] = "X-Vst-Warnings"
        return Response(content=rendered, media_type="audio/wav", headers=host_headers)

    try:
        data = await audio.read()
        # load_audio_array answers (channels, frames) float32; pedalboard wants
        # (frames, channels).
        channels_first, sr = load_audio_array(data)
        signal = np.ascontiguousarray(channels_first.T)
    except Exception as e:
        raise HTTPException(
            status_code=400, detail=f"Could not read uploaded audio: {e}"
        )

    warnings: list[str] = []
    try:
        param_map = json.loads(params) if params else {}
        if not isinstance(param_map, dict):
            warnings.append("params was not a JSON object; no parameters applied")
            param_map = {}
    except json.JSONDecodeError as e:
        warnings.append(f"params was not valid JSON ({e}); no parameters applied")
        param_map = {}

    try:
        processed = process_with_plugin(
            plugin_path, signal, sr, param_map, raw_state or None, warnings
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"VST processing failed: {e}")

    buf = io.BytesIO()
    # Float WAV: this is one stage of a chain, and 16-bit here would requantize
    # the signal at every plugin it passes through. save_audio takes
    # (channels, frames); processed is (frames, channels).
    save_audio(buf, np.asarray(processed).T, sr, format="wav", subtype="FLOAT")
    headers: dict[str, str] = {}
    if warnings:
        # The body is audio, so a state or parameter that did not apply has to
        # ride along in a header, otherwise it renders at defaults in silence.
        headers["X-Vst-Warnings"] = json.dumps(warnings, ensure_ascii=True)[:4000]
        headers["Access-Control-Expose-Headers"] = "X-Vst-Warnings"
    return Response(content=buf.getvalue(), media_type="audio/wav", headers=headers)


#: /render-midi limits. A part is at most an hour long and carries at most a
#: million messages; a request renders at most 64 tracks. Each is far past any
#: arrangement EDIT holds and small enough that a bad request cannot pin the
#: plugin thread for long. The audio a request asks for, all its tracks
#: together, also stays under THEDAW_VST_RENDER_MAX_BYTES (2 GiB by default).
RENDER_MIDI_MAX_TRACKS = 64
RENDER_MIDI_MAX_SECONDS = 3600.0
RENDER_MIDI_MAX_EVENTS = 1_000_000
RENDER_MIDI_MIN_RATE = 8000
RENDER_MIDI_MAX_RATE = 192000
RENDER_MIDI_MAX_CHANNELS = 8
_RENDER_MIDI_MAX_ID_CHARS = 200


class RenderMidiEvent(BaseModel):
    #: Seconds from the start of the render.
    t: float
    #: One channel voice message: the status byte, then its data bytes.
    data: list[int]


class RenderMidiTrack(BaseModel):
    track_id: str
    plugin_path: str
    raw_state: str = ""
    #: Which host captured ``raw_state`` (``vst.state_host``): ``thedaw`` renders
    #: through our own host, which reads the state it wrote; anything else
    #: renders through pedalboard.
    state_host: str = ""
    params: dict[str, float] = {}
    #: Seconds of audio to render, the release tail included.
    duration: float
    events: list[RenderMidiEvent]


class RenderMidiRequest(BaseModel):
    sample_rate: int = 44100
    channels: int = 2
    tracks: list[RenderMidiTrack]


def _render_midi_messages(track: RenderMidiTrack) -> list[tuple[bytes, float]]:
    """A track's events as pedalboard's ``(bytes, seconds)`` list, in time order.

    A message before 0 s is played at 0 s; one at or past the track's duration
    is left out, since pedalboard would ignore it anyway. The sort is stable, so
    a note-off and a note-on at one instant keep the order the caller wrote.
    """
    from backend.modules.vst.host import midi_message_bytes

    out: list[tuple[bytes, float]] = []
    for i, event in enumerate(track.events):
        if not math.isfinite(event.t):
            raise HTTPException(
                status_code=400,
                detail=f"Track {track.track_id}: event {i} has no finite time.",
            )
        try:
            data = midi_message_bytes(event.data)
        except ValueError as e:
            raise HTTPException(
                status_code=400, detail=f"Track {track.track_id}: event {i}: {e}."
            )
        t = max(0.0, float(event.t))
        if t < track.duration:
            out.append((data, t))
    out.sort(key=lambda m: m[1])
    return out


def _multipart(parts: list[tuple[str, str, str | None, bytes]]) -> tuple[bytes, str]:
    """``multipart/form-data`` bytes for ``(name, content_type, filename, body)``
    parts, and the Content-Type header that names the boundary."""
    boundary = "thedaw-render-" + os.urandom(12).hex()
    chunks: list[bytes] = []
    for name, content_type, filename, body in parts:
        disposition = f'form-data; name="{name}"'
        if filename:
            disposition += f'; filename="{filename}"'
        chunks.append(
            (
                f"--{boundary}\r\nContent-Disposition: {disposition}\r\n"
                f"Content-Type: {content_type}\r\n\r\n"
            ).encode("ascii")
        )
        chunks.append(body)
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode("ascii"))
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def _render_instrument_with_thedaw_host(
    track: RenderMidiTrack,
    plugin_path: str,
    messages: list[tuple[bytes, float]],
    sample_rate: int,
    channels: int,
    warnings: list[str],
) -> tuple[bytes, int]:
    """One instrument track through ``thedaw-vst-host --render --midi-events``.

    The host renders a file, so it is handed ``duration`` seconds of silence at
    the render's rate and channel count, the track's messages at their sample
    frames, its state and parameters, and no tail of its own (the duration
    already carries the release). Returns the WAV and its frame count.
    """
    import numpy as np
    import soundfile as sf

    from backend.lib.audio_io import save_audio

    frames = int(round(track.duration * sample_rate))
    try:
        _RENDER_DIR.mkdir(parents=True, exist_ok=True)
        work = Path(tempfile.mkdtemp(prefix="render-midi-", dir=str(_RENDER_DIR)))
    except OSError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not create the render directory: {_os_reason(e)}",
        )
    try:
        in_path = work / "in.wav"
        try:
            save_audio(
                in_path,
                np.zeros((channels, frames), dtype=np.float32),
                sample_rate,
                format="wav",
                subtype="FLOAT",
            )
        except OSError as e:
            raise HTTPException(
                status_code=500,
                detail=f"Could not stage the render input: {_os_reason(e)}",
            )
        state_blob = base64.b64decode(track.raw_state) if track.raw_state else None
        events = [(int(round(t * sample_rate)), data) for data, t in messages]
        wav = _render_with_thedaw_host(
            work,
            in_path,
            plugin_path,
            "",
            state_blob,
            dict(track.params),
            warnings,
            events,
            "0",
        )
    finally:
        shutil.rmtree(work, ignore_errors=True)
    try:
        rendered_frames = int(sf.info(io.BytesIO(wav)).frames)
    except Exception:
        rendered_frames = frames
    return wav, rendered_frames


@router.post("/render-midi")
def render_midi(req: RenderMidiRequest, request: Request):
    """Render EDIT MIDI tracks through their VST3 instruments.

    Each track names its instrument (``plugin_path``, with the ``raw_state``
    captured from its editor and any ``params``), the seconds to render and its
    messages: notes, controller changes (modulation, volume, pan, expression,
    the pedal and any other CC the part writes), pressure and pitch bend, each
    at its second. Every track is rendered on its own through a fresh plugin
    (``host.render_instrument``), in request order.

    The answer is ``multipart/form-data``: a ``report`` part (JSON:
    ``{"tracks": [{"track_id", "part", "frames", "sample_rate", "warnings"}]}``)
    and one ``audio/wav`` part per track, 32-bit float, named in the report.

    Gated the way ``/process-file`` is: this loads and runs plugins, and a
    paired device passes. Plugin paths go through the same ``path_policy``
    containment as every other plugin route.
    """
    require_loopback_launch_or_pairing_token(request)
    import numpy as np

    from backend.lib.audio_io import save_audio
    from backend.modules.vst.host import render_instrument

    if not req.tracks:
        raise HTTPException(status_code=400, detail="No tracks to render.")
    if len(req.tracks) > RENDER_MIDI_MAX_TRACKS:
        raise HTTPException(
            status_code=413,
            detail=f"At most {RENDER_MIDI_MAX_TRACKS} tracks render in one request.",
        )
    if not RENDER_MIDI_MIN_RATE <= req.sample_rate <= RENDER_MIDI_MAX_RATE:
        raise HTTPException(
            status_code=400,
            detail=(
                f"sample_rate must be {RENDER_MIDI_MIN_RATE}-{RENDER_MIDI_MAX_RATE} Hz."
            ),
        )
    if not 1 <= req.channels <= RENDER_MIDI_MAX_CHANNELS:
        raise HTTPException(
            status_code=400,
            detail=f"channels must be 1-{RENDER_MIDI_MAX_CHANNELS}.",
        )

    # Every track is checked before any plugin loads, so a bad last track does
    # not cost the user the minutes the first ones took.
    plans: list[tuple[RenderMidiTrack, str, list[tuple[bytes, float]]]] = []
    # The float32 audio the request asks for, all tracks together: it is held in
    # memory as rendered and again in the multipart answer, so it stays under
    # the same byte budget a /process-file upload has.
    budget = _render_max_upload_bytes()
    asked_bytes = 0
    for track in req.tracks:
        if not track.track_id or len(track.track_id) > _RENDER_MIDI_MAX_ID_CHARS:
            raise HTTPException(
                status_code=400,
                detail=f"track_id must be 1-{_RENDER_MIDI_MAX_ID_CHARS} characters.",
            )
        if not (
            math.isfinite(track.duration)
            and 0 < track.duration <= RENDER_MIDI_MAX_SECONDS
        ):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Track {track.track_id}: duration must be above 0 and at most "
                    f"{int(RENDER_MIDI_MAX_SECONDS)} seconds."
                ),
            )
        asked_bytes += int(round(track.duration * req.sample_rate)) * req.channels * 4
        if asked_bytes > budget:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"The render would hold {asked_bytes} bytes of audio, past the "
                    f"{budget} byte budget (THEDAW_VST_RENDER_MAX_BYTES): render "
                    "fewer tracks, a shorter span, a lower rate or fewer channels."
                ),
            )
        if len(track.events) > RENDER_MIDI_MAX_EVENTS:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"Track {track.track_id}: at most {RENDER_MIDI_MAX_EVENTS} "
                    "MIDI messages render in one track."
                ),
            )
        if len(track.raw_state) > _RENDER_MAX_RAW_STATE_CHARS:
            raise HTTPException(
                status_code=413,
                detail=f"Track {track.track_id}: raw_state is too large.",
            )
        resolved = _validated_plugin_path(track.plugin_path)
        if not resolved.exists():
            raise HTTPException(
                status_code=404,
                detail=f"VST3 instrument not found: {track.plugin_path}",
            )
        mode = (track.state_host or "").strip().lower() or "pedalboard"
        if mode not in ("pedalboard", "thedaw"):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Track {track.track_id}: unknown state_host {track.state_host!r}: "
                    "expected 'thedaw' or 'pedalboard'."
                ),
            )
        if mode == "thedaw" and track.raw_state:
            try:
                base64.b64decode(track.raw_state, validate=True)
            except (binascii.Error, ValueError) as e:
                raise HTTPException(
                    status_code=400,
                    detail=f"Track {track.track_id}: raw_state was not valid base64: {e}",
                )
        plans.append((track, str(resolved), _render_midi_messages(track)))

    report: list[dict] = []
    parts: list[tuple[str, str, str | None, bytes]] = []
    for index, (track, plugin_path, messages) in enumerate(plans):
        warnings: list[str] = []
        part = f"track-{index}"
        if (track.state_host or "").strip().lower() == "thedaw":
            # Our own host wrote this state, so our own host renders it: a VST3 state blob
            # does not survive the trip to pedalboard for every plugin (see /process-file).
            wav, frames = _render_instrument_with_thedaw_host(
                track, plugin_path, messages, req.sample_rate, req.channels, warnings
            )
            report.append(
                {
                    "track_id": track.track_id,
                    "part": part,
                    "frames": frames,
                    "sample_rate": int(req.sample_rate),
                    "warnings": warnings,
                }
            )
            parts.append((part, "audio/wav", f"{part}.wav", wav))
            continue
        try:
            rendered = render_instrument(
                plugin_path,
                messages,
                track.duration,
                req.sample_rate,
                track.params or None,
                track.raw_state or None,
                warnings,
                req.channels,
            )
        except FileNotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except ValueError as e:
            raise HTTPException(status_code=400, detail=f"Track {track.track_id}: {e}")
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Track {track.track_id}: the instrument failed to render: {e}",
            )
        buf = io.BytesIO()
        # save_audio takes (channels, frames); rendered is (frames, channels).
        save_audio(
            buf,
            np.asarray(rendered).T,
            req.sample_rate,
            format="wav",
            subtype="FLOAT",
        )
        report.append(
            {
                "track_id": track.track_id,
                "part": part,
                "frames": int(rendered.shape[0]),
                "sample_rate": int(req.sample_rate),
                "warnings": warnings,
            }
        )
        parts.append((part, "audio/wav", f"{part}.wav", buf.getvalue()))

    report_body = json.dumps({"tracks": report}, ensure_ascii=True).encode("utf-8")
    body, content_type = _multipart(
        [("report", "application/json", None, report_body), *parts]
    )
    return Response(content=body, media_type=content_type)


@router.post("/open-editor")
def open_editor(req: EditorRequest, request: Request):
    """Open a VST3 plugin's native GUI in a sidecar process.

    pedalboard's ``show_editor()`` blocks its thread and must run on a process
    main thread, so it runs as a subprocess. On window close the sidecar writes
    the plugin's full state to a per-plugin JSON file; poll ``/editor-result`` to
    read it back and store it on the chain node, so the dialed-in sound is reused
    at process time.

    A LAN caller must not be able to pop a native plugin GUI open on this
    machine's desktop, paired or not (``_require_this_machine_for_editor``:
    loopback or the launch token, not the local ``_require_loopback``,
    because the desktop shell, not only this machine's browser tab,
    legitimately opens editors too).
    """
    _require_this_machine_for_editor(request)
    resolved = _validated_plugin_path(req.plugin_path)
    if not resolved.exists():
        raise HTTPException(
            status_code=404, detail=f"VST3 plugin not found: {req.plugin_path}"
        )
    # Every other editor route (rect/size/result/alive) hashes its own
    # plugin_path through this same helper — going through it here too, on
    # top of the already-resolved path, is what makes all five routes
    # provably agree on one key rather than merely computing the same thing
    # twice by coincidence.
    plugin_path = _canonical_plugin_key(str(resolved))
    path = resolved
    _PRESET_DIR.mkdir(parents=True, exist_ok=True)
    out = _preset_path(plugin_path)
    # Clear any prior result so the poller tracks THIS session, not a stale one.
    out.write_text(
        json.dumps({"status": "launching", "plugin_path": plugin_path}),
        encoding="utf-8",
    )
    # The published editor size belongs to the session too: leaving the old one
    # in place would size this session's scroll area to the last plugin's window.
    for stale in (_size_path(plugin_path), _pid_path(plugin_path)):
        stale.unlink(missing_ok=True)

    preset_in: Path | None = None
    if req.raw_state:
        preset_in = out.with_suffix(".in.json")
        preset_in.write_text(json.dumps({"raw_state": req.raw_state}), encoding="utf-8")

    repo_root = Path(__file__).resolve().parents[3]
    cmd = [
        sys.executable,
        "-m",
        "backend.modules.vst.editor_sidecar",
        "--plugin-path",
        str(path),
        "--preset-out",
        str(out),
    ]
    if preset_in is not None:
        cmd += ["--preset-in", str(preset_in)]
    if req.plugin_name:
        cmd += ["--plugin-name", req.plugin_name]

    # Embedding: seed the rect file with the initial geometry and hand the sidecar
    # the parent HWND + rect file so its watcher reparents the editor in-window.
    rect_file = _rect_path(plugin_path)
    if req.parent_hwnd:
        r = req.rect or {}
        rect_file.write_text(
            json.dumps(
                {
                    "x": r.get("x", 0),
                    "y": r.get("y", 0),
                    "w": r.get("w", 480),
                    "h": r.get("h", 320),
                    "dpr": r.get("dpr", 1),
                    "close": False,
                }
            ),
            encoding="utf-8",
        )
        cmd += [
            "--parent-hwnd",
            str(int(req.parent_hwnd)),
            "--rect-file",
            str(rect_file),
        ]

    # Capture the sidecar's stdout+stderr so editor/embed failures are diagnosable
    # (the editor + watcher run in that subprocess, out of the server's sight).
    log_path = out.with_suffix(".log")
    log_fh = None
    try:
        log_fh = open(log_path, "w")
    except Exception:
        log_fh = None
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(repo_root),
            stdout=log_fh or None,
            stderr=(subprocess.STDOUT if log_fh else None),
            env=child_env(),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not launch editor: {e}")
    finally:
        if log_fh:
            log_fh.close()
    _editor_procs[plugin_path] = proc
    # Also on disk, so an editor that outlives a server restart is still
    # recognized as running rather than reported dead.
    _pid_path(plugin_path).write_text(str(proc.pid), encoding="utf-8")
    # No directory, no extension: the app only ever polls /editor-result with
    # the plugin_path it already has, so this key never needs to round-trip
    # back to the client. Returning the real on-disk path here would leak the
    # server's filesystem layout (and Windows profile name) to the browser.
    return {"status": "launched", "preset_key": out.stem}


@router.post("/editor-rect")
def editor_rect(req: EditorRectRequest, request: Request):
    """Push a live embed-rect update (or a close request) for an open editor.

    The frontend calls this as the MIX embed area moves/resizes, or with
    close=true to dismiss the embedded editor. The sidecar's watcher polls this
    file and re-positions (or WM_CLOSEs) the reparented window.

    Gated unconditionally, not just the close=true branch: the non-close
    branch writes the same rect file ``win_embed.py`` reads to ``SetWindowPos``
    and clip the embedded window's region, so a LAN caller could otherwise
    shove an open editor offscreen (or to a 1x1 clip) repeatedly without ever
    sending close=true. A plain viewport move/resize still only repositions a
    window that is already open, on a session the caller must already know
    the (session-scoped) plugin_path for -- but that is not a reason to leave
    it reachable from the LAN.
    """
    _require_this_machine_for_editor(request)
    plugin_path = _canonical_plugin_key(req.plugin_path)
    rect_file = _rect_path(plugin_path)
    if not rect_file.parent.exists():
        rect_file.parent.mkdir(parents=True, exist_ok=True)
    rect_file.write_text(
        json.dumps(
            {
                "x": req.x,
                "y": req.y,
                "w": req.w,
                "h": req.h,
                "sx": req.sx,
                "sy": req.sy,
                "dpr": req.dpr,
                "close": req.close,
            }
        ),
        encoding="utf-8",
    )
    return {"status": "updated"}


@router.get("/editor-size")
def editor_size(plugin_path: str, request: Request):
    """Natural (physical px) size of the embedded editor window, published by the
    sidecar watcher so the frontend can size its scroll area. ``{status:'none'}``
    until it is known.

    Gated: a LAN caller who guesses a plugin path can otherwise poll another
    session's editor state.
    """
    _require_this_machine_for_editor(request)
    plugin_path = _canonical_plugin_key(plugin_path)
    size_file = _size_path(plugin_path)
    if not size_file.is_file():
        return {"status": "none"}
    try:
        data = json.loads(size_file.read_text(encoding="utf-8"))
        return {"status": "ok", "w": data.get("w"), "h": data.get("h")}
    except Exception:
        return {"status": "none"}


@router.get("/editor-result")
def editor_result(plugin_path: str, request: Request):
    """Read the latest captured state from a plugin's editor session.

    Returns ``{"status": "none"|"launching"|"opening"|"ok"|"error", ...}``. When
    ``ok``, includes the base64 ``raw_state`` to store on the chain node. A
    sidecar that died before writing its result is reported as an error here,
    because the in-progress statuses are otherwise terminal and the frontend
    would poll them forever.

    Gated: on success this returns the session's captured base64
    ``raw_state``, and this route also writes a file, unlinks the pid file,
    and pops ``_editor_procs`` -- a LAN caller who guesses a plugin path must
    not be able to read that state back or force a live session's tracking
    entry into an error.
    """
    _require_this_machine_for_editor(request)
    plugin_path = _canonical_plugin_key(plugin_path)
    out = _preset_path(plugin_path)
    if not out.is_file():
        return {"status": "none"}
    payload = _read_json(out)
    if payload is None:
        return {"status": "none"}
    if payload.get("status") not in ("launching", "opening"):
        return payload
    if _editor_alive(plugin_path):
        return payload
    # It may have finished between the read and the liveness check.
    settled = _read_json(out)
    if settled is not None and settled.get("status") not in ("launching", "opening"):
        return settled
    error = {
        "status": "error",
        "plugin_path": plugin_path,
        "error": _editor_failure_detail(out),
    }
    # Persist it so every later poll agrees, and drop the stale pid.
    try:
        out.write_text(json.dumps(error), encoding="utf-8")
    except OSError:
        pass
    _pid_path(plugin_path).unlink(missing_ok=True)
    _editor_procs.pop(plugin_path, None)
    log.warning("VST3 editor sidecar died for %s: %s", plugin_path, error["error"])
    return error


def _read_json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _scrub_paths(text: str) -> str:
    """Replace this server's home directory and repo root with placeholders.

    A sidecar log tail can echo either one (a traceback frame, a printed
    argv) and that tail can reach an HTTP error detail; neither the user's
    Windows profile name nor the repo's on-disk location belongs in a
    client-visible response. The repo root is replaced before the home
    directory on purpose — it is a home-relative path, so scrubbing the home
    directory first would leave the (now shorter) repo root unmatched.
    """
    if not text:
        return text
    repo_root = str(Path(__file__).resolve().parents[3])
    home = str(Path.home())
    for needle, placeholder in ((repo_root, "<repo>"), (home, "~")):
        if not needle:
            continue
        if sys.platform == "win32":
            text = re.sub(re.escape(needle), placeholder, text, flags=re.IGNORECASE)
        else:
            text = text.replace(needle, placeholder)
    return text


def _editor_failure_detail(preset_out: Path) -> str:
    """Explain a dead sidecar using the tail of the log it wrote, when there is one."""
    base = "Editor process exited before the plugin state was captured."
    log_path = preset_out.with_suffix(".log")
    try:
        tail = log_path.read_text(encoding="utf-8", errors="replace").strip()[-400:]
    except OSError:
        tail = ""
    tail = _scrub_paths(tail)
    return f"{base} {tail}" if tail else base


@router.get("/param/{instance_id}")
def get_params(instance_id: str, request: Request):
    """Read all current parameter values on a loaded plugin.

    Gated: matches the write half of this pair (``PUT /param``) -- an
    unknown LAN caller must not be able to read a loaded plugin's live
    parameter state. A paired device passes, as on ``/load``.
    """
    require_loopback_launch_or_pairing_token(request)
    try:
        inst = get_instance(instance_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=e.args[0])
    return {"instance_id": instance_id, "parameters": inst.parameters}


@router.put("/param/{instance_id}")
def set_param(instance_id: str, req: SetParamRequest, request: Request):
    """Set a single parameter value on a loaded plugin.

    Gated: this mutates a loaded plugin's live parameter state; an unknown
    LAN caller must not be able to change what the user's own mix is doing.
    A paired device passes, as on ``/load``.
    """
    require_loopback_launch_or_pairing_token(request)
    try:
        inst = get_instance(instance_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=e.args[0])
    try:
        inst.set_parameter(req.name, req.value)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=e.args[0])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    # Echo what the plugin actually holds now: it may quantize or clamp.
    applied = inst.parameters.get(req.name) or inst.parameters.get(
        param_key(req.name), {}
    )
    return {
        "instance_id": instance_id,
        "name": req.name,
        "value": applied.get("value", req.value),
        "raw_value": applied.get("raw_value"),
        "label": applied.get("label", ""),
    }


@router.delete("/unload/{instance_id}")
def unload_vst(instance_id: str, request: Request):
    """Unload a plugin instance.

    Gated: this destroys server-side state; an unknown LAN caller must not be
    able to unload instances out from under the session the desktop UI still
    believes exist. A paired device passes, as on ``/load``.
    """
    require_loopback_launch_or_pairing_token(request)
    try:
        unload_plugin(instance_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=e.args[0])
    return {"status": "unloaded", "instance_id": instance_id}


@router.get("/builtin")
def builtin_effects():
    """List pedalboard's built-in effects (no VST3 required)."""
    return list_builtin_effects()


def _plugin_dict(p: Vst3PluginInfo) -> dict:
    from dataclasses import asdict

    return asdict(p)


def _plugin_dicts(
    plugins: list[Vst3PluginInfo], include_unloadable: bool
) -> list[dict]:
    if include_unloadable:
        return [_plugin_dict(p) for p in plugins]
    hidden = [p.name for p in plugins if not p.loadable]
    if hidden:
        log.info("Withholding %d VST3 plugin(s) this host cannot load", len(hidden))
    return [_plugin_dict(p) for p in plugins if p.loadable]


# ---------------------------------------------------------------------------
# Live VST hosting — /api/vst/live/*
# ---------------------------------------------------------------------------
# One native ``thedaw-vst-host`` process per live chain entry, so the user's
# real plugin processes the live signal. The backend only spawns, tracks and
# reaps those processes: the browser opens the returned ``ws_url`` itself and
# no audio passes through here. Contract: docs/design/vst-live-protocol.md
# ("Backend API"). The session manager lives in ``live_host.py``.
#
# The import sits with the routes rather than in the header block above so the
# whole feature is one contiguous addition to this file.
from backend.modules.vst import live_host  # noqa: E402
from backend.modules.vst.live_host import LiveHostError  # noqa: E402


class LiveSessionRequest(BaseModel):
    """``POST /api/vst/live/session``.

    Ranges are checked in the manager rather than declared here so that the
    HTTP path and direct callers reject exactly the same things with exactly
    the same messages.
    """

    chain_entry_id: str
    plugin_path: str
    sample_rate: int
    plugin_name: str | None = None
    block_size: int = 512
    channels: int = 2
    # Base64 of the shared VST3 state container — the SAME blob the offline
    # (pedalboard) path stores on the chain entry. Written to the session's
    # state file before the host starts, never logged.
    raw_state: str | None = None


class LiveSessionCreated(BaseModel):
    session_id: str
    ws_url: str
    pid: int
    protocol: int


class LiveSessionInfo(BaseModel):
    session_id: str
    chain_entry_id: str
    # The plugin's file name only: the API never echoes back its directory.
    plugin_file: str
    plugin_name: str | None = None
    sample_rate: int
    block_size: int
    channels: int
    alive: bool
    pid: int
    port: int | None = None
    ws_url: str | None = None
    protocol: int
    started_at: float
    ended_at: float | None = None
    exit_code: int | None = None
    has_state: bool
    log_tail: list[str]


class LiveSessionList(BaseModel):
    sessions: list[LiveSessionInfo]


class LiveSessionClosed(BaseModel):
    session_id: str
    chain_entry_id: str
    exit_code: int | None = None
    # The state the host wrote on its way out, base64, or null when it wrote
    # none (a force-killed host that never got to save).
    raw_state: str | None = None
    log_tail: list[str]


class LiveHostInfo(BaseModel):
    available: bool
    path: str | None = None
    version: str | None = None
    # Why live VST is off, so the UI can say how to turn it on.
    reason: str | None = None


@router.get("/live/host", response_model=LiveHostInfo)
def live_host_status(request: Request):
    """Whether the native host is built, and if not, why live VST is off.

    Gated the same way every other ``/live/*`` route is (``_require_loopback``):
    ``LiveHostInfo.path`` is the absolute path of the native host binary, and
    this route otherwise has no caller-supplied input to police -- gating the
    whole route is simpler than special-casing one field of the response for
    a non-loopback caller, and matches ``/live/sessions``,
    ``/live/session/{id}`` and the DELETE variant, which are all
    loopback-only already.
    """
    _require_loopback(request)
    return live_host.get_manager().host_info()


@router.post("/live/session", response_model=LiveSessionCreated)
def create_live_session(req: LiveSessionRequest, request: Request):
    """Start a host for a chain entry, or return the one it already has."""
    _require_loopback(request)
    try:
        session = live_host.get_manager().create(
            chain_entry_id=req.chain_entry_id,
            plugin_path=req.plugin_path,
            plugin_name=req.plugin_name,
            sample_rate=req.sample_rate,
            block_size=req.block_size,
            channels=req.channels,
            raw_state=req.raw_state,
        )
    except LiveHostError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)
    return {
        "session_id": session.session_id,
        "ws_url": session.ws_url,
        "pid": session.pid,
        "protocol": session.protocol,
    }


@router.get("/live/sessions", response_model=LiveSessionList)
def list_live_sessions(request: Request):
    """Every tracked session, including ones that died recently."""
    _require_loopback(request)
    manager = live_host.get_manager()
    manager.reap()
    return {"sessions": [s.to_dict() for s in manager.list()]}


@router.get("/live/session/{session_id}", response_model=LiveSessionInfo)
def get_live_session(session_id: str, request: Request):
    """One session's state, with the tail of its host log."""
    _require_loopback(request)
    manager = live_host.get_manager()
    manager.reap()
    try:
        return manager.get(session_id).to_dict()
    except LiveHostError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


@router.delete("/live/session/{session_id}", response_model=LiveSessionClosed)
def delete_live_session(session_id: str, request: Request):
    """Shut a host down and return the plugin state it saved on the way out."""
    _require_loopback(request)
    try:
        return live_host.get_manager().delete(session_id)
    except LiveHostError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)
