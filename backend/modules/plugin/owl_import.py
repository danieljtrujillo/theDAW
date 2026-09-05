"""Import a VST Foundry project export into a .gan web plugin.

A VST Foundry export is a ``project.json`` (a flat list of absolutely-positioned
UI elements) plus a ``background.png``. Most elements are ``CustomCode`` (a
self-contained ``<script>`` that fills its window and posts
``{type:'updateValue', id, ...}`` to ``window.parent``); one is a native
``Knob``. This composes those into a single responsive ``index.html`` that:

  * lays each element out by percentage over the background (so it scales to the
    MIX stage while staying aligned to the artwork),
  * mounts each ``CustomCode`` element in its own iframe (``el_<id>.html``) so its
    full-document assumptions hold, and
  * relays every child ``updateValue`` message up to theDAW (the grand-parent).

The result is a controller-kind .gan: it emits control values, it does not
process audio.
"""

from __future__ import annotations

import hashlib
import html
import json
import logging
import re
from pathlib import Path

from backend.modules.plugin.gan_manifest import (
    GanCanvas,
    GanControl,
    GanManifest,
)

log = logging.getLogger(__name__)

_DEFAULT_W = 1672.0
_DEFAULT_H = 941.0

# Bump whenever the composed runtime (index.html / element wrapper markup or
# scripts) changes shape: it is folded into the source fingerprint so an
# already-installed bundle gets recomposed once, even though its project.json
# and artwork are unchanged.
RUNTIME_TEMPLATE_VERSION = 5

# The composed runtime never waits longer than this for its element frames and
# artwork before revealing whatever has arrived (a stuck asset must not leave
# the stage blank forever).
_REVEAL_TIMEOUT_MS = 6000


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.strip().lower()).strip("-")
    return s or "plugin"


def _png_size(data: bytes) -> tuple[int, int] | None:
    """Parse width/height from a PNG IHDR header, or None if not a PNG."""
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    if data[12:16] != b"IHDR":
        return None
    w = int.from_bytes(data[16:20], "big")
    h = int.from_bytes(data[20:24], "big")
    if w <= 0 or h <= 0:
        return None
    return w, h


# Runs before anything else in an element document. The composed index.html
# hands each element its render scale on its frame's dataset (``data-gz``; the
# URL fragment ``#gz=<k>`` is the fallback for a document loaded by src), so the
# zoom is in place BEFORE the element's own scripts measure their canvases:
# ``clientWidth`` then already reports design px and nothing has to re-size
# later. (Applying the zoom after load, as the previous runtime did, left the
# elements' cached W/H at the unzoomed box size — a root-zoom change fires no
# ``resize`` — so knob arcs and labels were drawn off/at the edge of a canvas a
# third of its intended size, and every canvas rendered upscaled.)
_EL_ZOOM_SCRIPT = (
    "<script>(function(){var k=0;try{var fe=window.frameElement;"
    "if(fe&&fe.dataset&&fe.dataset.gz)k=parseFloat(fe.dataset.gz);}catch(_){}"
    "if(!(k>0)){var m=/(?:^|[#&])gz=([0-9.]+)/.exec(location.hash||'');"
    "if(m)k=parseFloat(m[1]);}"
    "if(isFinite(k)&&k>0){document.documentElement.style.zoom=k;}})();</script>"
)


def _el_doc(custom_code: str) -> str:
    """Wrap a CustomCode body as a standalone, transparent full-window document."""
    return (
        '<!doctype html><html><head><meta charset="utf-8">'
        + _EL_ZOOM_SCRIPT
        + "<style>html,body{margin:0;padding:0;overflow:hidden;width:100%;height:100%;"
        "background:transparent}</style></head><body>" + custom_code + "</body></html>"
    )


def _knob_html(el: dict, idx: int) -> str:
    """Render a native VST Foundry Knob as a minimal, draggable rotary that posts
    its 0..1 value to the host. Drag up/down to adjust."""
    eid = str(el.get("id") or f"knob{idx}")
    glow = str(el.get("glowColor") or "#888888")
    active = str(el.get("activeColor") or "#666666")
    default = float(el.get("value", 0.0) or 0.0)
    knob_id = f"gan-knob-{eid}"
    return (
        f'<div class="gan-knob" id="{knob_id}" '
        f'role="slider" aria-label="Knob {eid}" tabindex="0" '
        f'aria-valuemin="0" aria-valuemax="1" aria-valuenow="{default}" '
        f'style="--gan-glow:{glow};--gan-active:{active}">'
        f'<span class="gan-knob-ind"></span></div>'
        "<script>(function(){"
        f"var el=document.getElementById('{knob_id}');var id='{eid}';"
        f"var v={default};var dragging=false,sy=0,sv=0;"
        "function clamp(x){return x<0?0:(x>1?1:x);}"
        "function render(){el.style.transform='rotate('+(-135+v*270)+'deg)';"
        "el.setAttribute('aria-valuenow',v.toFixed(3));}"
        "function emit(){window.parent.postMessage({type:'updateValue',id:id,value:v},'*');}"
        "el.addEventListener('pointerdown',function(e){dragging=true;sy=e.clientY;sv=v;"
        "try{el.setPointerCapture(e.pointerId);}catch(_){}});"
        "window.addEventListener('pointermove',function(e){if(!dragging)return;"
        "v=clamp(sv+(sy-e.clientY)/200);render();emit();});"
        "window.addEventListener('pointerup',function(){dragging=false;});"
        "el.addEventListener('keydown',function(e){var s=0;"
        "if(e.key==='ArrowUp'||e.key==='ArrowRight')s=0.02;"
        "if(e.key==='ArrowDown'||e.key==='ArrowLeft')s=-0.02;"
        "if(s){e.preventDefault();v=clamp(v+s);render();emit();}});"
        "render();})();</script>"
    )


def _wrapper_style(el: dict, w: float, h: float) -> str:
    x = float(el.get("x", 0) or 0)
    y = float(el.get("y", 0) or 0)
    ew = float(el.get("width", 0) or 0)
    eh = float(el.get("height", 0) or 0)
    left = (x / w * 100) if w else 0
    top = (y / h * 100) if h else 0
    pw = (ew / w * 100) if w else 0
    ph = (eh / h * 100) if h else 0
    style = (
        f"position:absolute;left:{left:.4f}%;top:{top:.4f}%;"
        f"width:{pw:.4f}%;height:{ph:.4f}%;"
    )
    blend = el.get("blendMode")
    if blend and blend != "normal":
        style += f"mix-blend-mode:{blend};"
    # Apply the element's rotation so on-art labels can match angled artwork.
    # VST Foundry stores degrees, often wrapped into 0..360 (e.g. 357 = -3).
    rot = el.get("rotation")
    if rot:
        try:
            rf = float(rot)
        except (TypeError, ValueError):
            rf = 0.0
        if rf > 180:
            rf -= 360
        if abs(rf) > 0.01:
            style += f"transform:rotate({rf:.2f}deg);"
    return style


def import_vst_foundry(
    project_json_path: str,
    *,
    name: str | None = None,
    plugin_id: str | None = None,
    background_path: str | None = None,
    exclude_substrings: list[str] | None = None,
) -> tuple[GanManifest, dict[str, bytes]]:
    """Parse a VST Foundry export and return (manifest, assets) for GanFile.save."""
    pj_path = Path(project_json_path)
    if not pj_path.is_file():
        raise FileNotFoundError(f"project.json not found: {project_json_path}")

    raw = pj_path.read_bytes()
    data = json.loads(raw.decode("utf-8"))
    elements = data.get("elements", [])
    if not isinstance(elements, list):
        raise ValueError("Invalid VST Foundry export: 'elements' is not a list")

    assets: dict[str, bytes] = {}

    # Canvas dimensions: prefer the background image's real pixel size (keeps the
    # percentage layout aligned to the artwork), then explicit canvas fields,
    # then element extents, then the documented default.
    bg_name = str(data.get("background") or "background.png")
    bg_path = Path(background_path) if background_path else (pj_path.parent / bg_name)
    canvas_w = canvas_h = None
    if bg_path.is_file():
        bg_bytes = bg_path.read_bytes()
        assets["background.png"] = bg_bytes
        size = _png_size(bg_bytes)
        if size:
            canvas_w, canvas_h = float(size[0]), float(size[1])
    if canvas_w is None:
        canvas_w = float(data.get("canvasWidth") or data.get("width") or 0) or None
        canvas_h = float(data.get("canvasHeight") or data.get("height") or 0) or None
    if canvas_w is None or canvas_h is None:
        max_x = max(
            (
                float(e.get("x", 0) or 0) + float(e.get("width", 0) or 0)
                for e in elements
            ),
            default=0,
        )
        max_y = max(
            (
                float(e.get("y", 0) or 0) + float(e.get("height", 0) or 0)
                for e in elements
            ),
            default=0,
        )
        canvas_w = canvas_w or max_x or _DEFAULT_W
        canvas_h = canvas_h or max_y or _DEFAULT_H

    has_bg = "background.png" in assets
    controls: list[GanControl] = []
    body_parts: list[str] = []

    for idx, el in enumerate(elements):
        etype = str(el.get("type") or "")
        eid = str(el.get("id") or f"el{idx}")
        ename = str(el.get("name") or eid)
        if exclude_substrings and any(
            s.lower() in ename.lower() for s in exclude_substrings
        ):
            continue
        style = _wrapper_style(el, canvas_w, canvas_h)

        if etype == "CustomCode":
            code = str(el.get("customCode") or "")
            asset_name = f"el_{eid}.html"
            el_html = _el_doc(code)
            assets[asset_name] = el_html.encode("utf-8")
            # No ``src`` here: the runtime script mounts the document once the
            # canvas has a size, with the render scale on the frame's dataset
            # (see _EL_ZOOM_SCRIPT). The document travels inline (``data-doc``
            # -> srcdoc) so a surface costs ONE html request plus its artwork
            # instead of a round trip per element; ``data-src`` names the same
            # document as a standalone asset (fallback / inspection).
            body_parts.append(
                f'<div class="gan-el" style="{style}">'
                f'<iframe class="gan-frame" data-src="{asset_name}" '
                f'data-doc="{html.escape(el_html, quote=True)}" '
                f'title="{ename}" scrolling="no"></iframe></div>'
            )
            kind = "xy" if "valueX" in code else "value"
            controls.append(GanControl(id=eid, name=ename, kind=kind))
        elif etype == "Knob":
            body_parts.append(
                f'<div class="gan-el gan-knob-wrap" style="{style}">'
                f"{_knob_html(el, idx)}</div>"
            )
            controls.append(GanControl(id=eid, name=ename, kind="value"))
        elif etype == "Image":
            # This export carries no asset bytes for Image elements and the
            # artwork is already baked into background.png, so a borderless,
            # non-interactive placeholder is the faithful rendering; if a
            # future export ships asset data, render an <img> from it instead.
            log.info("owl import: image element without asset data (%s)", eid)
            body_parts.append(
                f'<div class="gan-el gan-image" style="{style}" title="{ename}"></div>'
            )
        else:
            # Unknown native type — render a labelled placeholder rather than
            # silently dropping it, so nothing disappears without a trace.
            log.info("owl import: unhandled element type %r (%s)", etype, eid)
            body_parts.append(
                f'<div class="gan-el gan-unknown" style="{style}" '
                f'title="{ename} ({etype})"></div>'
            )

    disp_name = name or pj_path.parent.name or "Owl Tool"
    pid = plugin_id or f"{_slug(disp_name)}-{hashlib.sha256(raw).hexdigest()[:8]}"
    index_html = _compose_index(canvas_w, canvas_h, has_bg, body_parts, pid)
    assets["index.html"] = index_html.encode("utf-8")

    manifest = GanManifest(
        id=pid,
        name=disp_name,
        description="Imported from a VST Foundry export.",
        kind="controller",
        canvas=GanCanvas(width=canvas_w, height=canvas_h),
        controls=controls,
        source="vst-foundry",
        source_hash=source_fingerprint(
            project_json_path,
            name=name,
            plugin_id=plugin_id,
            background_path=background_path,
            exclude_substrings=exclude_substrings,
        ),
    )
    return manifest, assets


def source_fingerprint(
    project_json_path: str,
    *,
    name: str | None = None,
    plugin_id: str | None = None,
    background_path: str | None = None,
    exclude_substrings: list[str] | None = None,
) -> str:
    """Fingerprint everything ``import_vst_foundry`` composes from: the export's
    bytes, the artwork it would bundle, the import options, and the runtime
    template version. Equal fingerprints mean an identical package, so a
    packager can skip rewriting an installed bundle (and its extracted runtime)
    when nothing changed."""
    pj_path = Path(project_json_path)
    h = hashlib.sha256()
    h.update(f"template:{RUNTIME_TEMPLATE_VERSION}\n".encode())
    h.update(f"name:{name or ''}\nid:{plugin_id or ''}\n".encode())
    h.update(f"exclude:{','.join(sorted(exclude_substrings or []))}\n".encode())
    raw = pj_path.read_bytes() if pj_path.is_file() else b""
    h.update(b"project:")
    h.update(raw)
    bg_name = "background.png"
    try:
        bg_name = str(json.loads(raw.decode("utf-8")).get("background") or bg_name)
    except (ValueError, UnicodeDecodeError, AttributeError):
        pass
    bg_path = Path(background_path) if background_path else (pj_path.parent / bg_name)
    h.update(b"\nbackground:")
    if bg_path.is_file():
        h.update(bg_path.read_bytes())
    return h.hexdigest()


def _compose_index(
    w: float, h: float, has_bg: bool, body_parts: list[str], plugin_id: str = ""
) -> str:
    bg_css = (
        "background:url(background.png) 0 0/100% 100% no-repeat;"
        if has_bg
        else "background:#0a0a0f;"
    )
    head = (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        "<style>"
        "html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;"
        "background:#07080c;}"
        "#gan-stage{position:absolute;inset:0;display:flex;align-items:center;"
        "justify-content:center;container-type:size;}"
        # Letterbox the canvas to the artwork's native aspect: it grows to the
        # largest W:H rectangle that fits the stage (min of full width vs the
        # width implied by full height), so background-size:100% 100% no longer
        # distorts the art and the percent-positioned controls stay aligned.
        # overflow:hidden clips to the art: elements an author parked outside
        # the canvas (negative x/y) used to float in the letterbox gutters.
        # The canvas stays invisible until the reveal script has the artwork
        # decoded and every element frame laid out at its final scale, then
        # fades in as one unit (no piecemeal pop-in, no unscaled first paint).
        f"#gan-canvas{{position:relative;aspect-ratio:{w:.0f}/{h:.0f};"
        f"width:min(100cqw,calc(100cqh*{w:.0f}/{h:.0f}));height:auto;"
        "max-width:100%;max-height:100%;overflow:hidden;"
        "opacity:0;transition:opacity .18s ease-out;"
        f"{bg_css}}}"
        "html.gan-ready #gan-canvas{opacity:1;}"
        "@media (prefers-reduced-motion:reduce){#gan-canvas{transition:none;}}"
        ".gan-el{box-sizing:border-box;}"
        ".gan-frame{width:100%;height:100%;border:0;display:block;background:transparent;}"
        ".gan-knob-wrap{display:flex;align-items:center;justify-content:center;}"
        ".gan-knob{width:80%;height:80%;border-radius:50%;cursor:ns-resize;"
        "background:radial-gradient(circle at 50% 40%,var(--gan-active),#111);"
        "box-shadow:0 0 18px var(--gan-glow);display:flex;align-items:flex-start;"
        "justify-content:center;touch-action:none;}"
        ".gan-knob-ind{width:3px;height:38%;margin-top:8%;border-radius:2px;"
        "background:#fff;box-shadow:0 0 6px var(--gan-glow);}"
        ".gan-image{pointer-events:none;}"
        ".gan-unknown{border:1px dashed rgba(255,255,255,0.15);border-radius:4px;}"
        "</style></head><body>"
    )
    # Relay control values UP to the host, and forward host->plugin messages
    # (e.g. live audio 'level' for the meter) DOWN to every element iframe.
    # Level pushes are broadcast to every element frame; capped at ~30 fps and
    # dropped until the surface has revealed, so a host's 60 fps meter feed
    # never competes with the element documents for the main thread while
    # they are still loading.
    relay = (
        "<script>(function(){var lastLevel=0;"
        "window.addEventListener('message',function(e){"
        "var d=e.data;if(!d)return;"
        "if(d.type==='updateValue'){window.parent.postMessage(d,'*');}"
        "else if(d.type==='level'){"
        "if(!document.documentElement.classList.contains('gan-ready'))return;"
        "var now=performance.now();if(now-lastLevel<33)return;lastLevel=now;"
        "var fr=document.querySelectorAll('#gan-canvas iframe');"
        "for(var i=0;i<fr.length;i++){try{fr[i].contentWindow.postMessage(d,'*');}catch(_){}}}"
        "});})();</script>"
    )
    # Element iframes carry CustomCode authored against the native canvas size
    # (hardcoded px fonts and shapes). The percentage layout scales their BOXES
    # with the letterboxed canvas but nothing scales their CONTENT, so each
    # element document is zoomed by rendered/native width and lays out against
    # its design-size viewport. The scale must be in place BEFORE the element's
    # scripts run (they size their canvases from clientWidth once, and a root
    # zoom change fires no resize), so frames start with no src: once the canvas
    # has a size the script assigns src with the scale in the fragment, which
    # the element's head script applies first thing. A later stage resize
    # re-zooms every frame and dispatches a resize into it so the elements
    # re-measure.
    #
    # Reveal: the canvas is opacity:0 until the artwork is decoded and every
    # element frame has loaded at its final scale, then two rAFs later (layout
    # + paint of the zoomed frames settled) html gets .gan-ready, the canvas
    # fades in as one unit, and the host is told via postMessage so it can drop
    # its skeleton in the same beat. A timeout reveals whatever arrived so a
    # stuck asset never leaves the stage blank.
    scaler = (
        "<script>(function(){"
        f"var W={w:.0f},HAS_BG={'true' if has_bg else 'false'},PID={json.dumps(plugin_id)};"
        "var canvas=document.getElementById('gan-canvas');"
        "var frames=Array.prototype.slice.call(document.querySelectorAll('#gan-canvas iframe'));"
        "var pending=frames.length,bgReady=!HAS_BG,revealed=false,lastK=0;"
        "function scale(){var k=canvas.clientWidth/W;return(isFinite(k)&&k>0)?k:0;}"
        "function zoomFrame(fr,k,notify){try{var d=fr.contentDocument;"
        "if(!d||!d.documentElement||d.URL==='about:blank')return;"
        "d.documentElement.style.zoom=k;"
        "if(notify){var cw=fr.contentWindow;cw.dispatchEvent(new cw.Event('resize'));}}catch(_){}}"
        "function reveal(){if(revealed)return;revealed=true;"
        "requestAnimationFrame(function(){requestAnimationFrame(function(){"
        "document.documentElement.classList.add('gan-ready');"
        "try{window.parent.postMessage({type:'gan-ready',plugin:PID},'*');}catch(_){}});});}"
        # Once every frame is in, the artwork gets a short grace period only:
        # a decode that never settles must not hold the surface hostage.
        "var bgGrace=null;"
        "function maybeReveal(){if(pending<=0&&bgReady)reveal();"
        "else if(pending<=0&&bgGrace==null)bgGrace=setTimeout(reveal,1500);}"
        "function onLoad(fr){return function(){"
        "try{if(fr.contentDocument&&fr.contentDocument.URL==='about:blank')return;}catch(_){}"
        "if(fr.__ganLoaded)return;fr.__ganLoaded=true;"
        "var k=scale();if(k&&k!==fr.__ganK){fr.__ganK=k;zoomFrame(fr,k,true);}"
        "pending--;maybeReveal();};}"
        # First sizing mounts each element: the scale goes on the frame's
        # dataset, then the inline document (srcdoc) or, failing that, the
        # standalone asset with the scale in its fragment.
        "function start(fr,k){fr.__ganStarted=true;fr.__ganK=k;fr.dataset.gz=k;"
        "var doc=fr.getAttribute('data-doc');"
        "if(doc!==null){fr.removeAttribute('data-doc');fr.srcdoc=doc;}"
        "else{fr.src=fr.getAttribute('data-src')+'#gz='+k;}}"
        "function apply(){var k=scale();if(!k)return;"
        "for(var i=0;i<frames.length;i++){var fr=frames[i];"
        "if(!fr.__ganStarted){start(fr,k);}"
        "else if(fr.__ganLoaded&&k!==lastK){fr.__ganK=k;fr.dataset.gz=k;zoomFrame(fr,k,true);}}"
        "lastK=k;}"
        "for(var i=0;i<frames.length;i++){frames[i].addEventListener('load',onLoad(frames[i]));}"
        # Keep a strong reference to the probe image: Chromium can leave a
        # decode() promise unsettled when the element is collected mid-decode.
        "if(HAS_BG){var img=new Image();window.__ganBg=img;"
        "var done=function(){bgReady=true;maybeReveal();};"
        "img.onload=function(){(img.decode?img.decode():Promise.resolve()).then(done,done);};"
        "img.onerror=done;img.src='background.png';"
        "if(img.complete&&img.naturalWidth)img.onload();}"
        # Diagnostics for hosts/tests: where the reveal stands right now.
        "window.__ganState=function(){return{pending:pending,bgReady:bgReady,revealed:revealed,lastK:lastK};};"
        "if(typeof ResizeObserver!=='undefined'){new ResizeObserver(apply).observe(canvas);}"
        "else{window.addEventListener('resize',apply);}"
        "apply();"
        f"setTimeout(reveal,{_REVEAL_TIMEOUT_MS});"
        "})();</script>"
    )
    body = (
        '<div id="gan-stage"><div id="gan-canvas">'
        + "".join(body_parts)
        + "</div></div>"
        + relay
        + scaler
        + "</body></html>"
    )
    return head + body
