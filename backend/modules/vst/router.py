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
    scan_vst3_directories,
    load_cached_scan,
    save_scan_cache,
)
from backend.modules.vst.host import (
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


def _preset_path(plugin_path: str) -> Path:
    h = hashlib.sha1(plugin_path.encode("utf-8")).hexdigest()[:16]
    stem = Path(plugin_path).stem
    safe = "".join(c for c in stem if c.isalnum() or c in "-_") or "plugin"
    return _PRESET_DIR / f"{safe}_{h}.json"


def _rect_path(plugin_path: str) -> Path:
    return _preset_path(plugin_path).with_suffix(".rect.json")


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
def scan_vst3(refresh: bool = False):
    """Scan standard VST3 directories. Uses cache unless refresh=true."""
    if not refresh:
        cached = load_cached_scan()
        if cached is not None:
            return ScanResponse(plugins=[_plugin_dict(p) for p in cached])
    plugins = scan_vst3_directories()
    save_scan_cache(plugins)
    return ScanResponse(plugins=[_plugin_dict(p) for p in plugins])


@router.get("/scan/{path:path}", response_model=ScanResponse)
def scan_vst3_custom(path: str):
    """Scan a custom directory for VST3 plugins (always live, never cached)."""
    plugins = scan_vst3_directories(extra_paths=[path])
    return ScanResponse(plugins=[_plugin_dict(p) for p in plugins])


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

    try:
        param_map = json.loads(params) if params else {}
        if not isinstance(param_map, dict):
            param_map = {}
    except json.JSONDecodeError:
        param_map = {}

    try:
        processed = process_with_plugin(
            plugin_path, signal, sr, param_map, raw_state or None
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"VST processing failed: {e}")

    buf = io.BytesIO()
    sf.write(buf, processed, sr, format="WAV")
    return Response(content=buf.getvalue(), media_type="audio/wav")


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
        subprocess.Popen(
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
    size_file = _preset_path(plugin_path).with_suffix(".size.json")
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
    ``ok``, includes the base64 ``raw_state`` to store on the chain node.
    """
    out = _preset_path(plugin_path)
    if not out.is_file():
        return {"status": "none"}
    try:
        return json.loads(out.read_text(encoding="utf-8"))
    except Exception:
        return {"status": "none"}


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
    inst.set_parameter(req.name, req.value)
    return {"instance_id": instance_id, "name": req.name, "value": req.value}


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
