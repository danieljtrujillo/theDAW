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
storage. Two files hold it, because builds before this one read another shape
(see ``_LEGACY_ROOTS_NAME``): ``clip_audio_roots.json`` is this build's own,
and ``media_roots.json`` is kept current in the older builds' format. Each
start also takes over the folders an older build added to ``media_roots.json``
(see ``_load_session_roots``).
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from collections.abc import Iterable
from pathlib import Path
from backend.lib import paths
from backend.lib.atomic import atomic_write

log = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parents[3]
_ROOTS_STATE = paths.data_path("clip_audio_roots.json")

#: The file main and the builds before it read and write, as a bare JSON
#: list of folders; any other shape there reads as no grants at all to them.
#: It sits beside ``_ROOTS_STATE`` (derived from it, so a test that moves one
#: moves both) and is rewritten in that list format whenever the grants change
#: here, so a run of an older build still plays the clips this one was allowed
#: to serve.
_LEGACY_ROOTS_NAME = "media_roots.json"

# register_root runs on the threadpool (the sync save/load handlers). Held
# across check, insert and persist so two grants in flight cannot both pass
# the membership check, and so the two files are written from one snapshot.
_LOCK = threading.Lock()

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


# Format of ``_ROOTS_STATE``: ``{"v": 2, "roots": [...]}``. Any other shape in
# that file reads as no grants.
_ROOTS_STATE_VERSION = 2


def _legacy_state() -> Path:
    return _ROOTS_STATE.with_name(_LEGACY_ROOTS_NAME)


def _read_json(path: Path) -> object:
    """``path`` parsed, or None when it is missing or unreadable."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _parse_roots(items: object, *, existing_only: bool) -> list[Path]:
    """The usable folders in a persisted list: resolved, de-duped, capped.

    ``existing_only`` also drops a folder that is not a directory on disk now;
    the takeover from the older builds' file asks for that.
    """
    if not isinstance(items, list):
        return []
    out: list[Path] = []
    for item in items:
        if not isinstance(item, str):
            continue
        p = _safe_resolve(item)
        if p is None or _is_too_broad(p) or p in out:
            continue
        if existing_only and not p.is_dir():
            continue
        out.append(p)
    return out[:MAX_SESSION_ROOTS]


def _write_state(roots: list[Path]) -> None:
    """``_ROOTS_STATE`` in this build's format. Best effort."""
    try:
        atomic_write(
            _ROOTS_STATE,
            json.dumps(
                {"v": _ROOTS_STATE_VERSION, "roots": [str(p) for p in roots]},
                indent=2,
            ),
        )
    except OSError as e:
        log.warning("project.media_access: failed to persist %s: %s", _ROOTS_STATE, e)


def _write_legacy(roots: list[Path]) -> None:
    """``media_roots.json`` in the older builds' list format. Best effort.

    This build's grants come first, then every folder the file already listed
    that this build does not hold: those are grants an older build made on its
    own, and they stay in its file.
    """
    legacy = _legacy_state()
    if legacy == _ROOTS_STATE:
        return
    out = [str(p) for p in roots]
    held = set(roots)
    existing = _read_json(legacy)
    if isinstance(existing, list):
        for item in existing:
            if not isinstance(item, str):
                continue
            p = _safe_resolve(item)
            if p is None or p in held:
                continue
            held.add(p)
            out.append(item)
    try:
        atomic_write(legacy, json.dumps(out[:MAX_SESSION_ROOTS], indent=2))
    except OSError as e:
        log.warning("project.media_access: failed to persist %s: %s", legacy, e)


def _is_static(folder: Path) -> bool:
    """Whether ``folder`` is already covered by a root theDAW owns."""
    return any(folder == r or folder.is_relative_to(r) for r in _static_roots())


def _read_own_state() -> list[Path]:
    """This build's grants as ``_ROOTS_STATE`` records them."""
    raw = _read_json(_ROOTS_STATE)
    if not isinstance(raw, dict) or raw.get("v") != _ROOTS_STATE_VERSION:
        return []
    return _parse_roots(raw.get("roots"), existing_only=False)


def _load_session_roots() -> tuple[list[Path], bool]:
    """Every start: this build's grants, plus the older builds' new ones.

    ``media_roots.json`` holds a bare list when an older build wrote it, or the
    ``{"v": 2}`` object the first v2 build wrote there before this build's file
    had a name of its own. Each folder in it that this build does not hold is
    taken over when it is a directory now, is not a drive root or the home
    folder, and is not inside a root theDAW owns: the checks ``register_root``
    makes. That covers a folder an older build granted while this one was not
    running, so a project the UI restores from its own storage plays without
    being opened again.

    The older builds' project routes were ungated, so their list can hold a
    folder a LAN caller named rather than one a project the user opened drew
    from. Two routes read a granted folder: ``/api/project/clip-audio`` serves
    its audio, and ``/api/sheetimport/parse-path`` parses a score in it. Both
    answer only to this machine, the desktop shell or a paired phone.

    Reads only. The second value says whether the files need writing, which
    ``finish_start`` does once the app is starting: a folder was taken over,
    or the older builds' file holds the object they cannot read.
    """
    roots = _read_own_state()
    dirty = False
    legacy = _legacy_state()
    if legacy == _ROOTS_STATE:
        return roots, dirty
    raw = _read_json(legacy)
    if isinstance(raw, list):
        items: object = raw
    elif isinstance(raw, dict) and raw.get("v") == _ROOTS_STATE_VERSION:
        items = raw.get("roots")
        dirty = True
    else:
        return roots, dirty
    taken = 0
    for folder in _parse_roots(items, existing_only=True):
        if folder in roots or _is_static(folder) or len(roots) >= MAX_SESSION_ROOTS:
            continue
        roots.append(folder)
        taken += 1
    if taken:
        dirty = True
        log.info(
            "project.media_access: took over %d clip audio folder(s) from %s",
            taken,
            legacy,
        )
    return roots, dirty


_session_roots: list[Path]
_needs_write: bool
_session_roots, _needs_write = _load_session_roots()


def finish_start() -> None:
    """Write what ``_load_session_roots`` took over. Run once as the app
    starts (the ``clip-audio-roots`` startup hook), so importing this module
    never writes a file."""
    global _needs_write
    with _LOCK:
        if not _needs_write:
            return
        _needs_write = False
        _persist()


def _persist() -> None:
    """Best-effort: an unwritable data dir must not fail a save/load request.
    Call under ``_LOCK``."""
    _write_state(_session_roots)
    _write_legacy(_session_roots)


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
    if _is_static(folder):
        return False
    with _LOCK:
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
