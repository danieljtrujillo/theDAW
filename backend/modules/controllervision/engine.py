"""Computer-vision layout inference for MIDI controllers.

Detects a controller's physical controls (knobs / faders / pads) and their
positions from a product photo, using CLASSICAL computer vision (OpenCV) — no
trained model, no GPU, CPU-friendly, explainable:

  - KNOBS  → circles (Hough circle transform).
  - FADERS → tall/wide elongated rectangles (contour aspect-ratio).
  - PADS   → a grid of near-square rounded rectangles (contour squareness +
             clustering into rows/cols).

Why classical, not a neural detector: a pretrained COCO/YOLO model has no
"knob/fader/pad" classes, so it'd detect nothing useful without training data
we don't have. Hough + contour heuristics need zero training, run in
milliseconds on CPU, and — crucially — pair with the user-verify step + a
cross-check against the device's known control counts (library profile or a
MIDI capture). CV makes the surface *look* like the device; MIDI still makes it
*work* (binding is Tier-2 capture / MIDI-learn, never the picture).

OpenCV is an OPTIONAL dependency: the module imports lazily and reports
``available: false`` if cv2 isn't installed, so the backend still boots. Install
with ``opencv-python-headless`` (added to pyproject).

All coordinates returned are NORMALIZED to [0, 1] against the image width/height
so the frontend can lay controls out at any size.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

log = logging.getLogger(__name__)


def cv_available() -> bool:
    """True when OpenCV + numpy are importable (the CV path can run)."""
    try:
        import cv2  # noqa: F401
        import numpy  # noqa: F401

        return True
    except Exception:
        return False


def _normalize_box(
    x: float, y: float, w: float, h: float, iw: int, ih: int
) -> dict[str, float]:
    """A control box in normalized [0,1] coords (center + size)."""
    return {
        "cx": round((x + w / 2) / iw, 4),
        "cy": round((y + h / 2) / ih, 4),
        "w": round(w / iw, 4),
        "h": round(h / ih, 4),
    }


def detect_controls_in_image(image_bytes: bytes) -> dict[str, Any]:
    """Run CV detection over an image's raw bytes.

    Returns a dict::

        {
          "available": bool,         # was OpenCV present?
          "width": int, "height": int,
          "controls": [ {kind, cx, cy, w, h, confidence}, ... ],
          "counts": {"knob": n, "fader": n, "pad": n},
        }

    On any failure returns ``available``/``error`` so the caller can fall back to
    a library/learned profile instead of erroring the request.
    """
    if not cv_available():
        return {
            "available": False,
            "error": "opencv not installed",
            "controls": [],
            "counts": {},
        }

    import cv2
    import numpy as np

    try:
        arr = np.frombuffer(image_bytes, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            return {
                "available": True,
                "error": "could not decode image",
                "controls": [],
                "counts": {},
            }
    except Exception as e:  # pragma: no cover — defensive
        return {
            "available": True,
            "error": f"decode failed: {e}",
            "controls": [],
            "counts": {},
        }

    ih, iw = img.shape[:2]
    # Work at a bounded size for stable thresholds + speed.
    scale = 1200.0 / max(iw, ih) if max(iw, ih) > 1200 else 1.0
    if scale != 1.0:
        img = cv2.resize(
            img, (int(iw * scale), int(ih * scale)), interpolation=cv2.INTER_AREA
        )
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)

    controls: list[dict[str, Any]] = []

    # ── KNOBS: Hough circles ───────────────────────────────────────────────
    knob_centers: list[tuple[float, float, float]] = []
    try:
        minR = max(6, int(min(w, h) * 0.012))
        maxR = max(minR + 4, int(min(w, h) * 0.08))
        circles = cv2.HoughCircles(
            blur,
            cv2.HOUGH_GRADIENT,
            dp=1.2,
            minDist=int(min(w, h) * 0.05),
            param1=120,
            param2=32,
            minRadius=minR,
            maxRadius=maxR,
        )
        if circles is not None:
            for c in np.uint16(np.around(circles))[0, :]:
                cx, cy, r = float(c[0]), float(c[1]), float(c[2])
                knob_centers.append((cx, cy, r))
                controls.append(
                    {
                        "kind": "knob",
                        **_normalize_box(cx - r, cy - r, 2 * r, 2 * r, w, h),
                        "confidence": 0.7,
                    }
                )
    except Exception as e:
        log.info("controllervision: hough circles failed: %s", e)

    # ── FADERS + PADS: contour shape analysis ──────────────────────────────
    try:
        edges = cv2.Canny(blur, 50, 150)
        edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)
        contours, _ = cv2.findContours(
            edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        area_img = w * h
        for cnt in contours:
            x, y, cw, ch = cv2.boundingRect(cnt)
            area = cw * ch
            if area < area_img * 0.0008 or area > area_img * 0.25:
                continue  # too small (noise) or too big (panel/background)
            ar = cw / ch if ch else 0
            # skip boxes that coincide with a detected knob (circle in a box)
            bx, by = x + cw / 2, y + ch / 2
            if any(
                abs(bx - kx) < kr and abs(by - ky) < kr for kx, ky, kr in knob_centers
            ):
                continue
            if ar >= 2.2 or ar <= 0.45:
                # elongated → fader (horizontal or vertical travel)
                controls.append(
                    {
                        "kind": "fader",
                        **_normalize_box(x, y, cw, ch, w, h),
                        "confidence": 0.55,
                    }
                )
            elif 0.7 <= ar <= 1.4:
                # near-square → pad/button candidate
                controls.append(
                    {
                        "kind": "pad",
                        **_normalize_box(x, y, cw, ch, w, h),
                        "confidence": 0.5,
                    }
                )
    except Exception as e:
        log.info("controllervision: contour pass failed: %s", e)

    counts = {
        "knob": sum(1 for c in controls if c["kind"] == "knob"),
        "fader": sum(1 for c in controls if c["kind"] == "fader"),
        "pad": sum(1 for c in controls if c["kind"] == "pad"),
    }
    return {
        "available": True,
        "width": iw,
        "height": ih,
        "controls": controls,
        "counts": counts,
    }


# ── Image sourcing ─────────────────────────────────────────────────────────

WIKIMEDIA_API = "https://commons.wikimedia.org/w/api.php"
_HEADERS = {"User-Agent": "theDAW-ControllerVision/1.0 (FOSS MIDI controller layout)"}


async def search_wikimedia_image(query: str) -> Optional[dict[str, Any]]:
    """Best-effort: find a product image on Wikimedia Commons for a device name.

    Returns ``{url, title, descriptionurl}`` for the top image hit, or None.
    Uses the open Commons API (no key); honest about failure (returns None).
    """
    import httpx

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(10.0, connect=5.0), headers=_HEADERS
        ) as client:
            # 1. search Commons for files matching the device name
            r = await client.get(
                WIKIMEDIA_API,
                params={
                    "action": "query",
                    "format": "json",
                    "generator": "search",
                    "gsrsearch": f"{query} filetype:bitmap",
                    "gsrnamespace": "6",
                    "gsrlimit": "1",
                    "prop": "imageinfo",
                    "iiprop": "url|extmetadata",
                    "iiurlwidth": "1024",
                },
            )
            r.raise_for_status()
            data = r.json()
            pages = (data.get("query") or {}).get("pages") or {}
            for page in pages.values():
                info = (page.get("imageinfo") or [{}])[0]
                url = info.get("thumburl") or info.get("url")
                if url:
                    return {
                        "url": url,
                        "title": page.get("title"),
                        "descriptionurl": info.get("descriptionurl"),
                        "source": "wikimedia",
                    }
    except Exception as e:
        log.info("controllervision: wikimedia search failed for %r: %s", query, e)
    return None


async def fetch_image_bytes(url: str) -> bytes:
    """Fetch a remote image's bytes (Wikimedia / manufacturer URL)."""
    import httpx

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(15.0, connect=5.0), headers=_HEADERS
    ) as client:
        r = await client.get(url)
        r.raise_for_status()
        return r.content
