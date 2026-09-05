"""Render a MusicXML score to PDF through the frontend's OpenSheetMusicDisplay.

Two reasons the engraving lives in Node rather than in Python:

*Licence.* Every Python engraver that could do this is copyleft (verovio and svglib
were removed from this project for exactly that), while OSMD (BSD-3), jsPDF (MIT)
and svg2pdf.js (MIT) are already installed under the frontend and are permissive.
MuseScore, the other option ``engine.py`` reaches for, is GPL and only usable as an
optional external binary the user installs themselves.

*Fidelity.* The SCORE tab engraves with OSMD, so a bundle PDF produced by any other
engine would disagree with what the user was just looking at: different spacing,
different page breaks, different page count. ``frontend/scripts/renderScorePdf.mjs``
drives the same OSMD build with the same engraving rules and the same default zoom
under jsdom, so the bundle PDF is the sheet from the tab.

The script is spawned per render and exits; there is no sidecar process to manage.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)

# Repo root (.../stable-audio-3): backend/modules/notation/pdf_render.py -> parents[3].
_REPO_ROOT = Path(__file__).resolve().parents[3]

_SCRIPT_RELPATH = Path("scripts") / "renderScorePdf.mjs"
# Tablature renders through alphaTab rather than OSMD; see renderTabPdf.mjs.
_TAB_SCRIPT_RELPATH = Path("scripts") / "renderTabPdf.mjs"

# The Unity package that reads a note chart, vendored at the repo root so it
# ships WITH the code. It previously existed only inside a separate Unity
# checkout, which meant a bundle could only be assembled on one machine and the
# package would silently vanish from bundles anywhere else. The repo copy is the
# canonical source; the Unity project consumes it from here.
_UNITY_PACKAGE_RELPATH = Path("unity") / "com.gantasmo.notechart"
# Notation sources that can be engraved to PDF, by file extension.
PDF_RENDERABLE_SUFFIXES = frozenset({".musicxml", ".xml", ".alphatex"})

# Long scores are slow: a 68-page band arrangement takes ~15s, so this leaves
# generous headroom while still bounding a wedged process.
_TIMEOUT_SEC = 300.0

_NODE_HINT = (
    "Node.js was not found. Install Node 20+ and make sure `node` is on PATH, "
    "or point theDAW_NODE at the node binary."
)


def _node_path() -> Optional[str]:
    """The node binary to engrave with. Honors theDAW_NODE / THEDAW_NODE, else
    finds one on PATH (the packaged app prepends its bundled tools dir to PATH,
    so a shipped node is picked up automatically)."""
    for var in ("theDAW_NODE", "THEDAW_NODE"):
        explicit = os.getenv(var)
        if explicit and Path(explicit).is_file():
            return explicit
    return shutil.which("node") or shutil.which("node.exe")


def _frontend_dir() -> Optional[Path]:
    """The frontend checkout that owns the renderer and its node_modules.

    Every candidate is derived from this file's location (or an explicit env
    override), so it resolves the same on a dev clone and inside a packaged app.
    The first one that actually holds the render script wins.
    """
    override = os.getenv("theDAW_FRONTEND_DIR") or os.getenv("THEDAW_FRONTEND_DIR")
    candidates: list[Path] = []
    if override:
        candidates.append(Path(override).expanduser())
    candidates += [
        _REPO_ROOT / "frontend",  # dev clone and the release layout
        _REPO_ROOT.parent / "frontend",  # backend bundled one level in
    ]
    for candidate in candidates:
        if (candidate / _SCRIPT_RELPATH).is_file():
            return candidate
    return None


def renderer_version() -> str:
    """The OSMD version actually installed, for the artifact's engine_version."""
    frontend = _frontend_dir()
    if frontend is None:
        return "unknown"
    manifest = frontend / "node_modules" / "opensheetmusicdisplay" / "package.json"
    try:
        with open(manifest, encoding="utf-8") as fh:
            return str(json.load(fh).get("version") or "unknown")
    except (OSError, ValueError):
        return "unknown"


def unity_package_dir() -> Optional[Path]:
    """The vendored Unity note-chart package, or None when it is missing.

    Resolved from this file's location (or ``THEDAW_UNITY_PACKAGE_DIR``) so it
    works the same on a dev clone and inside a packaged app, rather than from an
    absolute path to somebody's Unity checkout.
    """
    override = os.getenv("THEDAW_UNITY_PACKAGE_DIR")
    candidates: list[Path] = []
    if override:
        candidates.append(Path(override).expanduser())
    candidates += [
        _REPO_ROOT / _UNITY_PACKAGE_RELPATH,
        _REPO_ROOT.parent / _UNITY_PACKAGE_RELPATH,
    ]
    for candidate in candidates:
        if (candidate / "package.json").is_file():
            return candidate
    return None


def available() -> dict[str, Any]:
    """Whether a headless engrave can run right now, and what is missing if not."""
    frontend = _frontend_dir()
    node = _node_path()
    deps = bool(
        frontend and (frontend / "node_modules" / "opensheetmusicdisplay").is_dir()
    )
    return {
        "ok": bool(node and frontend and deps),
        "node": node,
        "frontend_dir": str(frontend) if frontend else None,
        "deps": deps,
    }


def render_musicxml_pdf(
    source: Path,
    output: Path,
    artist: str = "",
    *,
    page_width: Optional[int] = None,
    zoom: Optional[float] = None,
    check_fit: bool = False,
) -> dict[str, Any]:
    """Engrave ``source`` (MusicXML) into ``output`` (PDF). Never raises.

    ``artist`` becomes the subtitle under the title, as in the SCORE tab. Left
    empty, the renderer falls back to the score's own composer credit.

    ``page_width`` is the container width in CSS px the renderer sizes one page
    from (the tab's initial 520 when omitted). ``zoom`` pins the zoom the way a
    user's manual zoom does; left ``None`` the renderer starts at the tab's
    default and auto-fits (lowers the zoom when a music system is taller than
    the printable page, exactly as the SCORE tab does), so the bundle PDF
    paginates like the sheet on screen. ``check_fit`` asks the renderer to
    report that measurement.

    Returns ``{"ok": True, "pages": int, "bytes": int, "zoom": float, "error":
    None}`` on success, plus ``"fit": {"tallestBottom", "usable", "printable",
    "pageHeight", "bottomMargin", "systems", "passes", "startZoom", "overflows"}``
    (OSMD page units; ``usable`` is the fit target the renderer keeps every system
    above, ``printable`` is OSMD's PageHeight - PageBottomMargin) when
    ``check_fit`` is set, or ``{"ok": False, "pages": 0, "bytes": 0, "error": "..."}`` with a
    message the caller can surface as-is. Tablature (alphaTex) renders through a
    different script that has no zoom/fit notion; those keys are absent then.
    """
    # Absolute: the child runs with cwd set to the frontend, so a relative path
    # from the caller would resolve against the wrong directory.
    source = Path(source).resolve()
    output = Path(output).resolve()

    def failure(error: str) -> dict[str, Any]:
        return {"ok": False, "pages": 0, "bytes": 0, "error": error}

    if not source.is_file():
        return failure(f"source not found: {source}")

    frontend = _frontend_dir()
    if frontend is None:
        return failure(
            f"the score renderer was not found (looked for {_SCRIPT_RELPATH.as_posix()} "
            f"under {_REPO_ROOT / 'frontend'})"
        )
    if not (frontend / "node_modules" / "opensheetmusicdisplay").is_dir():
        return failure(
            f"frontend dependencies are not installed; run `npm install` in {frontend}"
        )

    node = _node_path()
    if node is None:
        return failure(_NODE_HINT)

    try:
        output.parent.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        return failure(f"cannot create {output.parent}: {e}")

    # cwd is the frontend so node resolves frontend/node_modules; the script path
    # stays relative to it for the same reason.
    # Tablature is alphaTex, which OSMD cannot read; alphaTab renders it instead.
    # Both scripts share the same argv shape and the same one-line JSON result.
    is_tab = source.suffix.lower() == ".alphatex"
    script = _TAB_SCRIPT_RELPATH if is_tab else _SCRIPT_RELPATH
    cmd = [node, str(script.as_posix()), str(source), str(output)]
    if artist.strip() and not is_tab:
        cmd += ["--artist", artist.strip()]
    if not is_tab:
        if page_width is not None and page_width > 0:
            cmd += ["--page-width", str(int(page_width))]
        if zoom is not None and zoom > 0:
            cmd += ["--zoom", repr(float(zoom))]
        if check_fit:
            cmd.append("--check-fit")
    creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(frontend),
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_SEC,
            stdin=subprocess.DEVNULL,
            creationflags=creationflags,
            shell=False,
        )
    except FileNotFoundError:
        return failure(_NODE_HINT)
    except subprocess.TimeoutExpired:
        return failure(f"score render timed out after {int(_TIMEOUT_SEC)}s")
    except OSError as e:
        return failure(f"could not run node: {e}")

    stderr = (proc.stderr or "").strip()
    if proc.returncode != 0:
        last = stderr.splitlines()[-1] if stderr else ""
        return failure(
            last.removeprefix("renderScorePdf: ")
            if last
            else f"node exited {proc.returncode}"
        )

    # The script prints its JSON summary last; OSMD's own chatter can precede it,
    # so the last non-empty line is the result.
    line = next(
        (ln for ln in reversed((proc.stdout or "").splitlines()) if ln.strip()), ""
    )
    try:
        summary = json.loads(line)
    except ValueError:
        return failure(stderr or "the score renderer produced no result")
    if not summary.get("ok"):
        return failure(stderr or "the score renderer reported failure")

    # A zero-exit run that left no PDF header means the summary lied; callers get
    # a file path back, so it has to be a real PDF.
    try:
        with open(output, "rb") as fh:
            header = fh.read(5)
    except OSError as e:
        return failure(f"the score renderer wrote no readable PDF: {e}")
    if header != b"%PDF-":
        return failure(f"{output.name} is not a PDF")

    if stderr:
        log.debug("notation.pdf_render: %s", stderr)
    result: dict[str, Any] = {
        "ok": True,
        "pages": int(summary.get("pages") or 0),
        "bytes": int(summary.get("bytes") or 0),
        "error": None,
    }
    if isinstance(summary.get("zoom"), (int, float)):
        result["zoom"] = float(summary["zoom"])
    fit = summary.get("fit")
    if isinstance(fit, dict):
        result["fit"] = {
            "tallestBottom": float(fit.get("tallestBottom") or 0.0),
            "usable": float(fit.get("usable") or 0.0),
            "printable": float(fit.get("printable") or 0.0),
            "pageHeight": float(fit.get("pageHeight") or 0.0),
            "bottomMargin": float(fit.get("bottomMargin") or 0.0),
            "systems": int(fit.get("systems") or 0),
            "passes": int(fit.get("passes") or 0),
            "startZoom": float(fit.get("startZoom") or 0.0),
            "overflows": bool(fit.get("overflows")),
        }
    return result
