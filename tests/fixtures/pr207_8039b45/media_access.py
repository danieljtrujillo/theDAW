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
from backend.lib import paths
from backend.lib.atomic import atomic_write

log = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parents[3]
_ROOTS_STATE = paths.data_path("media_roots.json")

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
    roots.append(paths.library_root())
    # The data tree holds the default generations dir plus uploads, bundles
    # and the media folders .tasmo archives extract into. Both the writable
    # root and the in-install one: they differ when the install directory is
    # read-only, and content that shipped with the app still reads fine.
    roots.append(paths.data_dir())
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


# Persisted-file format version. A bare JSON list is the pre-v2 shape written
# before roots were narrowed at registration time: a machine that was already
# exploited under that bug could have a widened root (e.g. a drive root or
# System32) sitting in the file, and nothing about that old entry re-validates
# it against today's `_is_too_broad`/static-root rules. Any file that is not
# `{"v": 2, "roots": [...]}` is treated as empty, forcing a re-grant the next
# time the user opens each project instead of silently re-admitting it.
_ROOTS_STATE_VERSION = 2


def _load_session_roots() -> list[Path]:
    try:
        raw = json.loads(_ROOTS_STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(raw, dict) or raw.get("v") != _ROOTS_STATE_VERSION:
        return []
    items = raw.get("roots")
    if not isinstance(items, list):
        return []
    out: list[Path] = []
    for item in items:
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
        atomic_write(
            _ROOTS_STATE,
            json.dumps(
                {"v": _ROOTS_STATE_VERSION, "roots": [str(p) for p in _session_roots]},
                indent=2,
            ),
        )
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


# A staged SwayCommand template names its song by the absolute path the song had
# on the author's machine. When nothing is at that path here, the server serves
# the copy of the song theDAW ships instead. Only server code registers these,
# from templates it read off disk; a request can never add one.
_stand_ins: dict[str, Path] = {}


def _stand_in_key(p: Path) -> str:
    return os.path.normcase(str(p))


def register_stand_in(missing: str | os.PathLike[str], shipped: Path) -> bool:
    """Serve ``shipped`` for ``missing`` whenever no file exists at ``missing``."""
    src = _safe_resolve(missing)
    dst = _safe_resolve(shipped)
    if src is None or dst is None or not dst.is_file():
        return False
    _stand_ins[_stand_in_key(src)] = dst
    log.info("project.media_access: %s plays from %s", src, dst)
    return True


def resolve_media_path(raw: str) -> Path | None:
    """Return the real location of ``raw`` when it is inside an allowed root.

    None means "refuse", and the caller must answer the same way whether the
    path was outside the roots or malformed: a distinct error per case is a
    filesystem oracle for anything that can reach the port.
    """
    p = _safe_resolve(raw)
    if p is None:
        return None
    stand_in = _stand_ins.get(_stand_in_key(p))
    if stand_in is not None and not p.is_file():
        return stand_in
    for root in allowed_roots():
        # Containment is checked AFTER resolution, so ``..`` and symlinks
        # cannot point the final path outside the root that let it through.
        if p == root or p.is_relative_to(root):
            return p
    return None
