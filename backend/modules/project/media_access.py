"""Path containment for the audio bytes ``/api/project/*`` hands to the browser.

``/clip-audio`` takes a server-side path because a .tasmo links its clips by
absolute path, but the server binds 0.0.0.0 so the phone companion and the
headset can reach it. Without a containment check that route is a file reader
for every browser tab and every device on the network. Every path it serves is
resolved first, so ``..`` segments and symlinks collapse to a real location,
and is then required to sit inside one of the roots below.

Two kinds of root:

  - Static roots cover everything theDAW writes itself: the library/generations
    tree, ``data/``, the on-the-fly transcode cache, the default projects
    folder. These exist before any request arrives.
  - Session roots are added when a project is opened. A .tasmo (or an imported
    DAW set) may link samples from anywhere on disk, and the user choosing to
    open that project is the consent for the files it names. Nothing a request
    body says can widen the allowlist on its own; only a project the server
    actually parsed can.

The registry is persisted next to the recent-projects list so re-opening the
app does not silently break playback of a session the UI restores from its own
storage.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from collections.abc import Iterable
from pathlib import Path

log = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parents[3]
_ROOTS_STATE = _PROJECT_ROOT / "data" / "media_roots.json"

# A session root is remembered per opened project; the cap keeps a long-lived
# install from accumulating an unbounded allowlist.
MAX_SESSION_ROOTS = 64


def _safe_resolve(raw: str | os.PathLike[str]) -> Path | None:
    """Resolve to a real absolute location (symlinks and ``..`` collapsed).

    Non-strict so a not-yet-created save target still resolves; existence is a
    separate question from containment.
    """
    text = str(raw).strip()
    if not text:
        return None
    try:
        return Path(text).expanduser().resolve()
    except (OSError, RuntimeError, ValueError):
        return None


def _is_too_broad(p: Path) -> bool:
    """Reject roots that would re-open the hole we are closing.

    A drive/filesystem root or the bare home directory as an allowlist entry
    would make every subsequent containment check pass.
    """
    return p == Path(p.anchor) or p == Path.home().resolve()


def _static_roots() -> list[Path]:
    """Roots theDAW owns, recomputed per call so an env change takes effect
    without a restart (the generations dir is user-configurable)."""
    roots: list[Path] = []

    # The library/generations tree, wherever the user pointed it.
    configured = os.getenv("theDAW_GENERATIONS_DIR")
    if configured:
        roots.append(Path(configured).expanduser())
    # data/ holds the default generations dir plus uploads, bundles and the
    # media folders .tasmo archives extract into.
    roots.append(_PROJECT_ROOT / "data")
    roots.append(Path(tempfile.gettempdir()) / "thedaw_transcode")
    roots.append(Path.home() / "Documents" / "theDAW Projects")

    extra = os.getenv("theDAW_MEDIA_ROOTS", "")
    if extra:
        roots.extend(Path(part) for part in extra.split(os.pathsep) if part.strip())

    out: list[Path] = []
    for r in roots:
        resolved = _safe_resolve(r)
        if resolved and not _is_too_broad(resolved) and resolved not in out:
            out.append(resolved)
    return out


def _load_session_roots() -> list[Path]:
    try:
        raw = json.loads(_ROOTS_STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(raw, list):
        return []
    out: list[Path] = []
    for item in raw:
        if not isinstance(item, str):
            continue
        p = _safe_resolve(item)
        if p and not _is_too_broad(p) and p not in out:
            out.append(p)
    return out[:MAX_SESSION_ROOTS]


_session_roots: list[Path] = _load_session_roots()


def _persist() -> None:
    """Best-effort: an unwritable data dir must not fail a save/load request."""
    try:
        _ROOTS_STATE.parent.mkdir(parents=True, exist_ok=True)
        tmp = _ROOTS_STATE.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps([str(p) for p in _session_roots], indent=2), encoding="utf-8"
        )
        tmp.replace(_ROOTS_STATE)
    except OSError as e:
        log.warning("project.media_access: failed to persist %s: %s", _ROOTS_STATE, e)


def register_root(path: str | os.PathLike[str]) -> bool:
    """Allow ``/clip-audio`` to serve from a directory an opened project uses.

    A file path registers its parent folder. Returns True when the allowlist
    changed, so callers can tell a no-op from a new grant when logging.
    """
    p = _safe_resolve(path)
    if p is None:
        return False
    folder = p if p.is_dir() else p.parent
    if not folder.name or _is_too_broad(folder):
        return False
    if any(folder == r or folder.is_relative_to(r) for r in _static_roots()):
        return False
    if folder in _session_roots:
        return False

    _session_roots.insert(0, folder)
    del _session_roots[MAX_SESSION_ROOTS:]
    _persist()
    log.info("project.media_access: allowing clip audio from %s", folder)
    return True


def register_paths(paths: Iterable[str | os.PathLike[str] | None]) -> None:
    """Register every folder named by an opened project, skipping blanks and
    the in-archive relative refs (``audio/kick.wav``) that never touch disk."""
    for raw in paths:
        if not raw:
            continue
        text = str(raw)
        if not Path(text).is_absolute():
            continue
        register_root(text)


def allowed_roots() -> list[Path]:
    """Every root a media path may live under, static first."""
    return [*_static_roots(), *_session_roots]


def resolve_media_path(raw: str) -> Path | None:
    """Return the real location of ``raw`` when it is inside an allowed root.

    None means "refuse", and the caller must answer the same way whether the
    path was outside the roots or malformed: a distinct error per case is a
    filesystem oracle for anything that can reach the port.
    """
    p = _safe_resolve(raw)
    if p is None:
        return None
    for root in allowed_roots():
        # Containment is checked AFTER resolution, so ``..`` and symlinks
        # cannot point the final path outside the root that let it through.
        if p == root or p.is_relative_to(root):
            return p
    return None
