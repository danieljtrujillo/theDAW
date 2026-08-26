"""Where the SwayCommand cockpit build lives, and whether it is servable.

SwayCommand (github.com/danieljtrujillo/SwayCommand) is a standalone Electron
app: a gesture VJ instrument for the Audima Labs Sway. Its renderer is a plain
static bundle, so the same sources produce a second "embedded" build that
theDAW serves at ``/sway-app`` and shows in an iframe -- exactly how theDAW
already hosts VJ-9000 at ``/vj-app``.

Static only. Unlike ``backend/modules/vj/sidecar.py`` there is no Node dev
server to spawn and no process to supervise: either a build is resolvable and
we mount it, or the tab reports that none is staged. That keeps the whole
module side-effect free at import.

The embedded build is NOT the standalone app. It runs the same cockpit through
a browser bridge instead of Electron IPC, so the capabilities that need a
desktop process (USB doctor probes, the DFU driver installer, WASAPI loopback
capture, native file dialogs) are absent by design and the cockpit degrades to
theDAW's equivalents. See ``docs/guides/swaycommand-embed.md``.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

# backend/modules/sway/sidecar.py -> repo root is three parents up, matching
# backend/modules/vj/sidecar.py:64. Every candidate below is derived from this
# or from an env var; nothing is machine-specific.
_REPO_ROOT = Path(__file__).resolve().parents[3]

# The URL the cockpit is served from. The build is compiled with this as its
# base href, so it must match on both sides. The trailing slash matters at the
# request end (see router.build_url) but not here.
STATIC_MOUNT_PATH = "/sway-app"

# Env override for a build directory, mirroring theDAW_VJ_DIST.
DIST_ENV = "theDAW_SWAY_DIST"

# Sibling-checkout names to look in when running from a dev clone.
_SIBLING_NAMES = ("SwayCommand", "swaycommand")


def _dist_candidates() -> list[Path]:
    """Search order for a servable SwayCommand embed build.

    Most explicit first: an env override, then the release-bundle location,
    then where ``npm run fetch:sway`` stages it during dev, then a sibling
    source checkout's own output. A candidate is only used if it actually
    holds an ``index.html`` (see resolve_dist_dir).
    """
    cands: list[Path] = []
    override = os.getenv(DIST_ENV)
    if override:
        cands.append(Path(override).expanduser().resolve())
    # Release bundle: electron-builder copies resources/sway-dist to
    # python/sway-dist, which sits beside the backend at the repo root.
    cands.append(_REPO_ROOT / "sway-dist")
    # Dev: where scripts/fetch-sway-build.mjs stages it, so testing the
    # embedded path locally needs no env var, just that one command.
    cands.append(_REPO_ROOT / "electron-ui" / "resources" / "sway-dist")
    # Dev fallback: a sibling SwayCommand checkout that has been built.
    for name in _SIBLING_NAMES:
        cands.append(_REPO_ROOT.parent / name / "dist-embed")
    return cands


def resolve_dist_dir() -> Optional[Path]:
    """First candidate that holds a real build, or None when nothing is
    servable yet."""
    for c in _dist_candidates():
        try:
            if (c / "index.html").is_file():
                return c
        except OSError:
            # A candidate can be an unreadable or invalid path (a stale env
            # override pointing at a removed drive). Skip it rather than
            # taking down module import.
            continue
    return None


def is_static_mode() -> bool:
    """True when a build is resolvable and should be mounted."""
    return resolve_dist_dir() is not None


# Set True by server.py when the /sway-app StaticFiles mount is actually
# registered (mounting happens once, at server import). Routes must key the
# "return the embed URL" decision off THIS, not is_static_mode(): a build
# staged later in the session flips is_static_mode() true while no mount
# exists, which would hand the iframe a /sway-app/ URL that 404s. The VJ
# module learned this the hard way; the same race exists here.
STATIC_MOUNTED = False


def static_mount_active() -> bool:
    return STATIC_MOUNTED


def read_build_stamp() -> Optional[dict]:
    """The staged build's provenance, written by SwayCommand's embed build.

    Two repos and one artifact means a stale bundle is invisible without
    this: the tab renders an older cockpit and nothing says so. Surfacing the
    stamp turns that into a readable version instead of a mystery.
    """
    dist = resolve_dist_dir()
    if dist is None:
        return None
    stamp = dist / "build.json"
    try:
        if stamp.is_file():
            data = json.loads(stamp.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
    except (OSError, ValueError):
        # A missing or malformed stamp is not a reason to refuse to serve a
        # perfectly good build.
        return None
    return None


def status() -> dict:
    """What the SWAY tab needs to decide what to render."""
    dist = resolve_dist_dir()
    return {
        "available": static_mount_active(),
        "resolved": str(dist) if dist is not None else None,
        "mount": STATIC_MOUNT_PATH,
        "build": read_build_stamp(),
        # Named so the UI can tell the user exactly how to fix "no build".
        "dist_env": DIST_ENV,
        "searched": [str(c) for c in _dist_candidates()],
    }
