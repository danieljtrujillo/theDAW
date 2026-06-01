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


# ── AI vision identification (uses the Orb Assistant's providers/keys) ───────
#
# Classical CV is approximate. The far more accurate path — and the one the user
# asked for — is to send the photo to a VISION LLM (the user already has keys in
# the Orb Assistant) and ask it to IDENTIFY the device (brand/model) and return
# its control layout as strict JSON. We auto-pick a vision-capable provider that
# has a working key, reusing the assistant's PROVIDERS / key resolution so we
# never duplicate auth or model catalogs. The result is still user-verified, and
# the brand/model is cross-checked against our built-in library client-side.

# Vision-capable model per provider (cheap-but-capable default). Kept minimal +
# current; we do NOT touch the assistant's catalogs. If a provider's listed
# model is unavailable the call simply errors and we surface that.
_VISION_PICKS: list[tuple[str, str]] = [
    ("gemini", "gemini-flash-latest"),
    ("anthropic", "claude-sonnet-4-6"),
    ("openai", "gpt-4.1-mini"),
    ("grok", "grok-3"),
    ("openrouter", "google/gemini-flash-1.5"),
]

_VISION_PROMPT = (
    "You are identifying a MIDI controller from a photo. Respond with ONLY a JSON "
    "object, no prose, no markdown fences. Schema:\n"
    '{"brand": string|null, "model": string|null, "confidence": number 0..1, '
    '"knobs": integer, "faders": integer, "pads": integer, '
    '"notes": string}\n'
    "Count the PHYSICAL controls you can see: rotary knobs/encoders = knobs; "
    "linear sliders = faders; square/rectangular trigger buttons or pads = pads. "
    "If you recognize the exact product, give brand + model precisely. If unsure "
    "of the model, still return your best control counts and set confidence low."
)


def pick_vision_provider() -> Optional[tuple[str, str]]:
    """Return (provider_id, model) for the first vision pick that has a working
    key, or None when no provider is configured. Reuses the assistant's key pool
    + env-var resolution (no duplicate key storage)."""
    try:
        from backend.assistant_routes import _get_api_key
    except Exception:
        return None
    for provider_id, model in _VISION_PICKS:
        try:
            if _get_api_key(provider_id):
                return (provider_id, model)
        except Exception:
            continue
    return None


def _parse_vision_json(text: str) -> Optional[dict[str, Any]]:
    """Pull a JSON object out of a model reply (tolerates stray prose / fences)."""
    import json
    import re

    if not text:
        return None
    # Strip ```json fences if present.
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    raw = fenced.group(1) if fenced else None
    if raw is None:
        # else first {...} balanced-ish span
        start = text.find("{")
        end = text.rfind("}")
        raw = text[start : end + 1] if start != -1 and end > start else None
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


async def identify_with_vision_llm(
    image_bytes: bytes, mime: str = "image/jpeg"
) -> dict[str, Any]:
    """Send the photo to a vision LLM and parse an identify+layout JSON result.

    Returns ``{available, used (provider/model), brand, model, confidence,
    counts:{knob,fader,pad}, notes}`` or ``{available:false, error}``. Honest:
    this is the model's best read — the UI still has the user confirm, and the
    brand/model is cross-checked against the library on the client.
    """
    import base64

    pick = pick_vision_provider()
    if pick is None:
        return {
            "available": False,
            "error": "no vision-capable provider has a key (add one in the Assistant)",
        }
    provider_id, model = pick

    try:
        from backend.assistant_routes import PROVIDERS, _chat_url, _get_api_key
    except Exception as e:
        return {"available": False, "error": f"assistant unavailable: {e}"}

    api_key = _get_api_key(provider_id)
    b64 = base64.b64encode(image_bytes).decode("ascii")

    import httpx

    try:
        if provider_id == "anthropic":
            url = f"{PROVIDERS['anthropic']['base_url']}/v1/messages"
            headers = {
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            }
            payload = {
                "model": model,
                "max_tokens": 600,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": _VISION_PROMPT},
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": mime,
                                    "data": b64,
                                },
                            },
                        ],
                    }
                ],
            }
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(60.0, connect=10.0)
            ) as client:
                r = await client.post(url, headers=headers, json=payload)
                r.raise_for_status()
                data = r.json()
                text = "".join(
                    blk.get("text", "")
                    for blk in data.get("content", [])
                    if blk.get("type") == "text"
                )
        else:
            # OpenAI-compatible (gemini/openai/grok/openrouter) multimodal content.
            url = _chat_url(provider_id)
            headers = {"Content-Type": "application/json"}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            payload = {
                "model": model,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": _VISION_PROMPT},
                            {
                                "type": "image_url",
                                "image_url": {"url": f"data:{mime};base64,{b64}"},
                            },
                        ],
                    }
                ],
                "stream": False,
            }
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(60.0, connect=10.0)
            ) as client:
                r = await client.post(url, headers=headers, json=payload)
                r.raise_for_status()
                data = r.json()
                text = (((data.get("choices") or [{}])[0]).get("message") or {}).get(
                    "content"
                ) or ""
                if isinstance(text, list):  # some providers return content parts
                    text = "".join(
                        p.get("text", "") for p in text if isinstance(p, dict)
                    )
    except Exception as e:
        log.info(
            "controllervision: vision LLM call failed (%s/%s): %s",
            provider_id,
            model,
            e,
        )
        return {
            "available": False,
            "error": f"vision call failed: {e}",
            "used": f"{provider_id}/{model}",
        }

    parsed = _parse_vision_json(text)
    if parsed is None:
        return {
            "available": True,
            "error": "model did not return parseable JSON",
            "used": f"{provider_id}/{model}",
            "raw": text[:500],
        }

    def _int(v: Any) -> int:
        try:
            return max(0, int(v))
        except Exception:
            return 0

    return {
        "available": True,
        "used": f"{provider_id}/{model}",
        "brand": parsed.get("brand"),
        "model": parsed.get("model"),
        "confidence": parsed.get("confidence"),
        "notes": parsed.get("notes"),
        "counts": {
            "knob": _int(parsed.get("knobs")),
            "fader": _int(parsed.get("faders")),
            "pad": _int(parsed.get("pads")),
        },
    }
