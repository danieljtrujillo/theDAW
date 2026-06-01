"""FastAPI router for the controllervision module.

Endpoints (prefix from module.json → ``/api/controllervision``):

    GET  /                  capability probe (is OpenCV available?)
    POST /detect            detect controls in an UPLOADED image (multipart)
    POST /detect-by-name    find a product image on Wikimedia for a device
                            name, fetch it, and run detection (returns the
                            source image url + detected controls)

Tier-3 controller recognition (see docs/plans/2026-06-01-dj-suite-foss-expansion
§7a). The result is a SUGGESTED layout the user verifies in the UI; the MIDI
mapping is never inferred from the image (that's Tier-2 capture / MIDI-learn).
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import HTMLResponse

from . import session as pairing
from .engine import (
    cv_available,
    detect_controls_in_image,
    fetch_image_bytes,
    search_wikimedia_image,
)

log = logging.getLogger(__name__)

router = APIRouter()

_MAX_IMAGE_BYTES = 20 * 1024 * 1024  # 20 MB


@router.get("")
@router.get("/")
def capabilities() -> dict[str, Any]:
    return {
        "ok": True,
        "available": cv_available(),
        "engine": "opencv (classical: hough circles + contour shape)",
        "note": "install opencv-python-headless to enable; mapping still comes from MIDI",
    }


def _gate(tag: str, acquire: bool) -> None:
    """Hold/release the idle gate around a foreground CV job (best-effort)."""
    try:
        from backend.core.idle import get_idle_manager

        mgr = get_idle_manager()
        mgr.bump_activity(tag=tag) if acquire else mgr.release(tag)
    except Exception:
        pass


@router.post("/detect")
async def detect_uploaded(image_file: UploadFile = File(...)) -> dict[str, Any]:
    """Detect controls in a user-supplied photo (Tier-3 source #1)."""
    if not cv_available():
        raise HTTPException(
            503,
            "OpenCV not installed — run the controllervision install or use a library/learned profile",
        )
    image_bytes = await image_file.read()
    if not image_bytes:
        raise HTTPException(400, "empty image")
    if len(image_bytes) > _MAX_IMAGE_BYTES:
        raise HTTPException(413, "image exceeds 20 MB")

    _gate("controllervision-detect", True)
    try:
        result = detect_controls_in_image(image_bytes)
    finally:
        _gate("controllervision-detect", False)
    result["source"] = "upload"
    return result


@router.post("/detect-by-name")
async def detect_by_name(device_name: str = Form(...)) -> dict[str, Any]:
    """Find a product image for a device name on Wikimedia, fetch it, detect
    controls (Tier-3 source #2). Returns the image url + detection so the UI can
    show the photo for the user to verify."""
    if not cv_available():
        raise HTTPException(503, "OpenCV not installed")
    name = device_name.strip()
    if not name:
        raise HTTPException(400, "device_name required")

    hit: Optional[dict[str, Any]] = await search_wikimedia_image(name)
    if not hit:
        return {
            "available": True,
            "found": False,
            "query": name,
            "controls": [],
            "counts": {},
        }

    try:
        image_bytes = await fetch_image_bytes(hit["url"])
    except Exception as e:
        raise HTTPException(502, f"failed to fetch image: {e}")
    if len(image_bytes) > _MAX_IMAGE_BYTES:
        raise HTTPException(413, "fetched image too large")

    _gate("controllervision-detect", True)
    try:
        result = detect_controls_in_image(image_bytes)
    finally:
        _gate("controllervision-detect", False)

    result["found"] = True
    result["query"] = name
    result["source"] = hit.get("source", "wikimedia")
    result["imageUrl"] = hit["url"]
    result["imageTitle"] = hit.get("title")
    result["descriptionUrl"] = hit.get("descriptionurl")
    return result


# ── Phone pairing — snap the controller photo from a phone over the LAN ──────


@router.post("/session")
def create_pairing_session() -> dict[str, Any]:
    """Desktop opens a session; returns an id + the mobile upload path. The
    frontend turns ``http://<lan-ip>:<backend-port>{mobile_path}`` into a QR."""
    sid = pairing.create_session()
    return {"id": sid, "mobile_path": f"/api/controllervision/m/{sid}"}


@router.get("/session/{sid}")
def poll_pairing_session(sid: str) -> dict[str, Any]:
    """Desktop polls for the phone's result. 404 when unknown/expired."""
    status = pairing.get_status(sid)
    if status is None:
        raise HTTPException(404, "session not found or expired")
    return status


@router.post("/session/{sid}/upload")
async def upload_from_phone(
    sid: str, image_file: UploadFile = File(...)
) -> dict[str, Any]:
    """Phone posts the controller photo here; we run CV and stash the result on
    the session for the desktop to pick up."""
    if not pairing.session_exists(sid):
        raise HTTPException(404, "session not found or expired")
    if not cv_available():
        raise HTTPException(503, "OpenCV not installed")
    image_bytes = await image_file.read()
    if not image_bytes:
        raise HTTPException(400, "empty image")
    if len(image_bytes) > _MAX_IMAGE_BYTES:
        raise HTTPException(413, "image exceeds 20 MB")

    _gate("controllervision-detect", True)
    try:
        result = detect_controls_in_image(image_bytes)
    finally:
        _gate("controllervision-detect", False)
    result["source"] = "phone"
    pairing.set_result(sid, result)
    return {"ok": True, "counts": result.get("counts", {})}


_MOBILE_PAGE = """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>theDAW — scan controller</title>
<style>
  :root {{ color-scheme: dark; }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; font-family: system-ui, sans-serif; background:#0a0810; color:#e8e6f0;
         min-height:100vh; display:flex; flex-direction:column; align-items:center; padding:24px 18px; }}
  h1 {{ font-size:15px; letter-spacing:.16em; text-transform:uppercase; color:#c4b5fd; margin:0 0 4px; }}
  p  {{ font-size:13px; color:#9a96a8; margin:0 0 20px; text-align:center; max-width:340px; line-height:1.5; }}
  label.btn {{ display:flex; align-items:center; justify-content:center; gap:10px;
         width:100%; max-width:340px; padding:18px; border-radius:14px; font-weight:800;
         text-transform:uppercase; letter-spacing:.1em; font-size:14px;
         background:linear-gradient(135deg,#6d28d9,#4f46e5); color:#fff; border:none; cursor:pointer; }}
  input[type=file] {{ display:none; }}
  #status {{ margin-top:20px; font-size:13px; min-height:20px; text-align:center; }}
  .ok {{ color:#6ee7b7; }} .err {{ color:#fca5a5; }} .muted {{ color:#807c8e; }}
  img#preview {{ margin-top:18px; max-width:100%; border-radius:12px; display:none; }}
</style></head><body>
<h1>Scan your controller</h1>
<p>Take a clear, straight-on photo of your MIDI controller. It goes to your computer over your local network — nothing leaves your LAN.</p>
<label class="btn" for="f">📷 Take / choose photo</label>
<input id="f" type="file" accept="image/*" capture="environment" />
<div id="status" class="muted">Waiting for a photo…</div>
<img id="preview" alt="preview" />
<script>
  var sid = {sid_js};
  var f = document.getElementById('f');
  var st = document.getElementById('status');
  var pv = document.getElementById('preview');
  f.addEventListener('change', function() {{
    var file = f.files && f.files[0];
    if (!file) return;
    pv.src = URL.createObjectURL(file); pv.style.display = 'block';
    st.className = 'muted'; st.textContent = 'Analyzing on your computer…';
    var fd = new FormData(); fd.append('image_file', file);
    fetch('/api/controllervision/session/' + sid + '/upload', {{ method:'POST', body: fd }})
      .then(function(r) {{ return r.ok ? r.json() : r.text().then(function(t){{ throw new Error(t); }}); }})
      .then(function(j) {{
        var c = j.counts || {{}};
        st.className = 'ok';
        st.textContent = 'Sent! Detected ' + (c.knob||0) + ' knobs, ' + (c.fader||0) + ' faders, ' + (c.pad||0) + ' pads. Back to your computer to confirm.';
      }})
      .catch(function(e) {{ st.className = 'err'; st.textContent = 'Upload failed: ' + e.message; }});
  }});
</script>
</body></html>"""


@router.get("/m/{sid}", response_class=HTMLResponse)
def mobile_upload_page(sid: str) -> HTMLResponse:
    """Self-contained mobile upload page (no frontend build needed on the phone).
    Served by the backend so a phone on the LAN can reach it directly."""
    import json

    if not pairing.session_exists(sid):
        return HTMLResponse(
            "<!doctype html><meta charset=utf-8><body style='font-family:system-ui;background:#0a0810;color:#e8e6f0;padding:40px;text-align:center'>"
            "<h2>Session expired</h2><p>Re-open the scan QR on your computer.</p></body>",
            status_code=404,
        )
    # json.dumps gives a safely-escaped JS string literal for the session id.
    return HTMLResponse(_MOBILE_PAGE.format(sid_js=json.dumps(sid)))
