"""FastAPI router for VST3 plugin hosting (/api/vst/*)."""

from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from backend.modules.vst.scanner import (
    Vst3PluginInfo,
    carry_over_metadata,
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

log = logging.getLogger(__name__)
router = APIRouter()

# Per-plugin captured editor state (from the native-GUI sidecar) lands here.
_PRESET_DIR = Path(__file__).resolve().parents[3] / "data" / "vst_presets"

# Editor sidecars spawned by this process, so a crashed editor can be detected
# instead of leaving the frontend polling a status that will never change.
_editor_procs: dict[str, subprocess.Popen] = {}


def _preset_path(plugin_path: str) -> Path:
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
    refresh: bool = False, enrich: bool = True, include_unloadable: bool = False
):
    """Scan standard VST3 directories.

    Serves the cache when it is still valid for the current contents of the scan
    roots; ``refresh=true`` forces a fresh walk and gives previously failed
    plugins another chance. Plugins this host cannot load are withheld unless
    ``include_unloadable`` asks for them, so the UI never offers a dead tile.
    """
    plugins: list[Vst3PluginInfo] | None = None
    if not refresh:
        plugins = load_cached_scan()
    if plugins is None:
        plugins = scan_vst3_directories()
        carry_over_metadata(plugins, read_cache_entries(), retry_failed=refresh)
        save_scan_cache(plugins)
    body = _plugin_dicts(plugins, include_unloadable)
    if enrich:
        # Vendor/version/category only come from opening the plugin, which is far
        # too slow to hold a request; the worker fills the cache in and the next
        # scan serves it.
        start_background_enrichment(plugins)
    return ScanResponse(plugins=body)


@router.get("/scan/{path:path}", response_model=ScanResponse)
def scan_vst3_custom(path: str, include_unloadable: bool = False):
    """Scan a custom directory for VST3 plugins (always live, never cached)."""
    plugins = scan_vst3_directories(extra_paths=[path])
    return ScanResponse(plugins=_plugin_dicts(plugins, include_unloadable))


@router.post("/load")
def load_vst(req: LoadRequest):
    """Load a VST3 plugin and return its parameter descriptors."""
    try:
        inst = load_plugin(req.plugin_path, req.instance_id)
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
def get_loaded_plugins():
    """List all currently loaded plugin instances."""
    return list_instances()


@router.post("/process")
def process_audio(req: ProcessRequest):
    """Run an audio file through an ordered chain of loaded VST instances.

    Reads the file at its native sample rate, processes it through the
    instances named in ``instance_ids`` (in order), and writes a WAV to
    ``output_path`` (or a temp file). Returns the output path.
    """
    import soundfile as sf

    src = Path(req.audio_path)
    if not src.is_file():
        raise HTTPException(
            status_code=404, detail=f"Audio file not found: {req.audio_path}"
        )
    try:
        # soundfile returns (frames, channels) float32 — the layout pedalboard expects.
        audio, sr = sf.read(str(src), dtype="float32", always_2d=True)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read audio: {e}")

    try:
        processed = process_chain(req.instance_ids, audio, sr)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=e.args[0])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"VST processing failed: {e}")

    created_temp = False
    out_path = req.output_path
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
        sf.write(out_path, processed, sr)
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


@router.post("/process-file")
async def process_file(
    audio: UploadFile = File(...),
    plugin_path: str = Form(...),
    params: str = Form("{}"),
    raw_state: str = Form(""),
):
    """Process an UPLOADED audio file through one VST3 plugin; return WAV bytes.

    Stateless mirror of /api/studio/process so a VST3 can be one stage of the
    MIX effect chain: the frontend uploads the running audio plus the plugin
    path and receives processed WAV back. The plugin is loaded fresh and
    discarded (never added to the instance registry).
    """
    import soundfile as sf

    path = Path(plugin_path)
    if not path.exists():
        raise HTTPException(
            status_code=404, detail=f"VST3 plugin not found: {plugin_path}"
        )
    try:
        data = await audio.read()
        # soundfile returns (frames, channels) float32 — the layout pedalboard expects.
        signal, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
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
    # the signal at every plugin it passes through.
    sf.write(buf, processed, sr, format="WAV", subtype="FLOAT")
    headers: dict[str, str] = {}
    if warnings:
        # The body is audio, so a state or parameter that did not apply has to
        # ride along in a header, otherwise it renders at defaults in silence.
        headers["X-Vst-Warnings"] = json.dumps(warnings, ensure_ascii=True)[:4000]
        headers["Access-Control-Expose-Headers"] = "X-Vst-Warnings"
    return Response(content=buf.getvalue(), media_type="audio/wav", headers=headers)


@router.post("/open-editor")
def open_editor(req: EditorRequest):
    """Open a VST3 plugin's native GUI in a sidecar process.

    pedalboard's ``show_editor()`` blocks its thread and must run on a process
    main thread, so it runs as a subprocess. On window close the sidecar writes
    the plugin's full state to a per-plugin JSON file; poll ``/editor-result`` to
    read it back and store it on the chain node, so the dialed-in sound is reused
    at process time.
    """
    path = Path(req.plugin_path)
    if not path.exists():
        raise HTTPException(
            status_code=404, detail=f"VST3 plugin not found: {req.plugin_path}"
        )
    _PRESET_DIR.mkdir(parents=True, exist_ok=True)
    out = _preset_path(req.plugin_path)
    # Clear any prior result so the poller tracks THIS session, not a stale one.
    out.write_text(
        json.dumps({"status": "launching", "plugin_path": req.plugin_path}),
        encoding="utf-8",
    )
    # The published editor size belongs to the session too: leaving the old one
    # in place would size this session's scroll area to the last plugin's window.
    for stale in (_size_path(req.plugin_path), _pid_path(req.plugin_path)):
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

    # Embedding: seed the rect file with the initial geometry and hand the sidecar
    # the parent HWND + rect file so its watcher reparents the editor in-window.
    rect_file = _rect_path(req.plugin_path)
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
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not launch editor: {e}")
    finally:
        if log_fh:
            log_fh.close()
    _editor_procs[req.plugin_path] = proc
    # Also on disk, so an editor that outlives a server restart is still
    # recognized as running rather than reported dead.
    _pid_path(req.plugin_path).write_text(str(proc.pid), encoding="utf-8")
    return {"status": "launched", "preset_path": str(out), "log_path": str(log_path)}


@router.post("/editor-rect")
def editor_rect(req: EditorRectRequest):
    """Push a live embed-rect update (or a close request) for an open editor.

    The frontend calls this as the MIX embed area moves/resizes, or with
    close=true to dismiss the embedded editor. The sidecar's watcher polls this
    file and re-positions (or WM_CLOSEs) the reparented window.
    """
    rect_file = _rect_path(req.plugin_path)
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
def editor_size(plugin_path: str):
    """Natural (physical px) size of the embedded editor window, published by the
    sidecar watcher so the frontend can size its scroll area. ``{status:'none'}``
    until it is known."""
    size_file = _size_path(plugin_path)
    if not size_file.is_file():
        return {"status": "none"}
    try:
        data = json.loads(size_file.read_text(encoding="utf-8"))
        return {"status": "ok", "w": data.get("w"), "h": data.get("h")}
    except Exception:
        return {"status": "none"}


@router.get("/editor-result")
def editor_result(plugin_path: str):
    """Read the latest captured state from a plugin's editor session.

    Returns ``{"status": "none"|"launching"|"opening"|"ok"|"error", ...}``. When
    ``ok``, includes the base64 ``raw_state`` to store on the chain node. A
    sidecar that died before writing its result is reported as an error here,
    because the in-progress statuses are otherwise terminal and the frontend
    would poll them forever.
    """
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


def _editor_failure_detail(preset_out: Path) -> str:
    """Explain a dead sidecar using the tail of the log it wrote, when there is one."""
    base = "Editor process exited before the plugin state was captured."
    log_path = preset_out.with_suffix(".log")
    try:
        tail = log_path.read_text(encoding="utf-8", errors="replace").strip()[-400:]
    except OSError:
        tail = ""
    return f"{base} {tail}" if tail else base


@router.get("/param/{instance_id}")
def get_params(instance_id: str):
    """Read all current parameter values on a loaded plugin."""
    try:
        inst = get_instance(instance_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=e.args[0])
    return {"instance_id": instance_id, "parameters": inst.parameters}


@router.put("/param/{instance_id}")
def set_param(instance_id: str, req: SetParamRequest):
    """Set a single parameter value on a loaded plugin."""
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
def unload_vst(instance_id: str):
    """Unload a plugin instance."""
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
