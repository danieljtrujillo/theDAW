"""Where a caller on another machine may name a file.

The pairing token (``backend/lib/pairing.py``) proves WHO a LAN caller is; it
says nothing about which paths that caller should be trusted to name. The
routes below take a path from the request body and use this module to confine
a non-loopback caller to the user's projects folder and the library tree, so a
paired device, or anyone holding a stolen token, cannot name any other path
through them. This machine's own UI (a loopback caller) is unaffected.

The routes that apply it: the project router's save/load/export routes, its
recent list (which must not offer a LAN caller a project it would then refuse
to open), the ``.tasmo`` rows of the known-places recent list, and the VST
``/process`` route's audio paths. It is not a disk-wide rule: other known-places
routes (``/api/places/file`` among them) still serve a paired device the files
this machine's desktop shell remembered, wherever they live.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException, Request

from backend.lib import known_paths, paths
from backend.modules.genaiproxy.access import caller_is_loopback

__all__ = [
    "inside_project_roots",
    "lan_caller_may_name",
    "require_project_root_for_lan",
]


def _resolve_or_none(raw: str) -> Path | None:
    try:
        return Path(raw).expanduser().resolve()
    except (OSError, RuntimeError, ValueError):
        return None


def inside_project_roots(raw_path: str) -> bool:
    """True when ``raw_path`` resolves inside the user's projects folder or
    the library/generations tree."""
    resolved = _resolve_or_none(raw_path)
    if resolved is None:
        return False
    for root in (known_paths.projects_dir(), paths.library_root()):
        root_resolved = _resolve_or_none(str(root))
        if root_resolved is None:
            continue
        if resolved == root_resolved or resolved.is_relative_to(root_resolved):
            return True
    return False


def lan_caller_may_name(raw_path: str, request: Request) -> bool:
    """Whether this caller may name ``raw_path``: always for this machine's
    own UI, and only inside the project roots for anyone else."""
    return caller_is_loopback(request) or inside_project_roots(raw_path)


def require_project_root_for_lan(raw_path: str, request: Request, *, what: str) -> None:
    """403 when a caller on another machine names a path outside the projects
    folder and the library tree. Callers run their authentication gate
    (``require_loopback_launch_or_pairing_token``) first; this is the
    authorization on top of it."""
    if not lan_caller_may_name(raw_path, request):
        raise HTTPException(
            403, f"{what} must be inside a known projects or library folder."
        )
