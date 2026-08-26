"""Routes backing theDAW's SWAY tab.

The tab asks this module one question -- "is there a cockpit to show, and at
what URL?" -- and renders either the iframe or an actionable explanation of
what is missing. Mounted at /api/sway by backend/modules/loader.py.
"""

from __future__ import annotations

from fastapi import APIRouter

from . import sidecar

router = APIRouter()


@router.get("/status")
async def sway_status() -> dict:
    """Whether an embedded SwayCommand build is staged and mounted."""
    return sidecar.status()


@router.get("/url")
async def sway_url() -> dict:
    """The URL for the SWAY tab's iframe, or a reason there is none.

    The URL is RELATIVE on purpose. An absolute http://localhost:8600/... works
    in the packaged desktop app and breaks everywhere else (Docker, a phone on
    the LAN, any reverse proxy). Relative also keeps the iframe same-origin
    with theDAW, which is load-bearing: a cross-origin hidden iframe is
    throttled to zero rAF callbacks by Chromium, which would freeze
    SwayCommand's transport clock the moment the user switched tabs.

    The trailing slash is required. Without it the document base becomes "/"
    and the cockpit's relative asset loads (its AudioWorklet in particular)
    resolve against theDAW's root and 404.
    """
    if not sidecar.static_mount_active():
        return {
            "url": None,
            "mode": "unavailable",
            "detail": (
                "No SwayCommand build is staged. Run 'npm run fetch:sway' in "
                "electron-ui/, or point "
                f"{sidecar.DIST_ENV} at a SwayCommand dist-embed directory, "
                "then restart the backend."
            ),
            "status": sidecar.status(),
        }
    return {
        "url": f"{sidecar.STATIC_MOUNT_PATH}/",
        "mode": "static",
        "detail": None,
        "build": sidecar.read_build_stamp(),
    }
