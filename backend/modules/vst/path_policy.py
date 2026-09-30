"""Plugin path policy for the live-VST entry points.

The VST routes accept a plugin path from the browser — untrusted input. This
module is the single choke point every route (router.py's ``/load``,
``/process-file``, ``/open-editor``, ``/scan/{path}``, and live_host.py's
session spawn) calls before that path reaches the native host. It only
validates shape and containment: no filesystem writes, no plugin loading.

A path is accepted only when it is a local, non-empty ``.vst3`` file or bundle
directory that sits inside one of ``allowed_roots()`` — the same directories
the scanner itself would offer in the UI. Network and device paths are
rejected from the raw text alone, before anything touches the filesystem, the
same way ``backend.lib.known_paths`` already refuses them.

"Inside" covers a plugin installed as a symlink or junction in a VST3 folder
(a bundle kept on another drive and linked into ``Common Files\\VST3``). The
scanner lists such a plugin under its resolved target, which lies outside every
root, so containment is judged three ways and any one is enough (see
``is_allowed``): the resolved path is inside a root; the raw absolute path is
inside a root as written and has no ``..`` segment; or the resolved path is
inside the target of a link the scan itself walks under a root. A link inside a
VST3 folder is something the machine's owner put there, so its target is a
plugin location the same way the folder is.

The link targets come from a walk of every root, and a MIX freeze or bounce
checks the same linked plugin once per stage and stem, so the walk's result is
kept for ``LINKED_TARGETS_TTL_SEC`` (see ``_linked_targets``). A kept target is
trusted only after the one link that produced it is re-resolved and still
leads there; a path no kept target covers always gets a fresh walk.
"""

from __future__ import annotations

import os
import re
import threading
import time
from collections.abc import Iterator
from pathlib import Path

from backend.lib.known_paths import is_remote_or_device_path
from backend.modules.vst.scanner import (
    _default_vst3_dirs,
    _resolve_bundle_binary,
    _walk_vst3_paths,
)


class PluginPathError(Exception):
    """A browser-supplied plugin path failed policy.

    ``status`` is the HTTP status a route should answer with; ``message`` is
    safe to send to the client verbatim (it never repeats the input path or
    names an allowed root).
    """

    status: int
    message: str

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def allowed_roots() -> list[Path]:
    """The VST3 directories a plugin path is allowed to sit inside.

    Delegates to the scanner's own directory resolver so this policy can
    never drift from the directories the app actually scans and offers in
    the UI.
    """
    return [root.resolve(strict=False) for root in _default_vst3_dirs()]


def root_contains(root: Path, resolved: Path) -> bool:
    """Whether ``resolved`` sits inside ``root``, case-insensitively on
    Windows (an install under ``C:\\Program Files`` must match regardless of
    how either side happens to be cased).

    The one containment predicate for a path against a single directory;
    ``is_allowed`` below applies it to every root and every linked target.
    """
    return Path(os.path.normcase(str(resolved))).is_relative_to(
        Path(os.path.normcase(str(root)))
    )


def _has_parent_segment(raw: str) -> bool:
    """Whether the raw text names a ``..`` segment anywhere."""
    return any(part == ".." for part in re.split(r"[\\/]+", raw))


def _lexically_inside(raw: str, roots: list[Path]) -> bool:
    """Whether the raw absolute path, as written, sits inside a root.

    A path under a symlinked or junctioned bundle is inside the root as written
    and outside it once resolved. Only an absolute path with no ``..`` segment
    counts: ``os.path.abspath`` folds ``..`` away as text, while a POSIX
    kernel resolves ``link/..`` against the link's target, so the two could
    disagree about where such a path really leads.
    """
    if _has_parent_segment(raw):
        return False
    try:
        written = Path(raw)
        if not written.is_absolute():
            return False
        absolute = Path(os.path.abspath(written))
    except (OSError, ValueError):
        return False
    return any(root_contains(root, absolute) for root in roots)


def _linked_plugin_sources(roots: list[Path]) -> Iterator[tuple[Path, Path]]:
    """``(link, target)`` for every plugin the scan reaches through a link.

    Walks each root with the scanner's own walker (``scanner._walk_vst3_paths``:
    it descends into a junctioned folder the way the scan does, skips a
    junction cycle, and stops at each bundle). For each bundle or standalone
    ``.vst3`` whose resolved form leaves the root, ``link`` is that walked path
    and ``target`` its resolved form. A real bundle whose loadable module is
    itself a link gives the module path and the module's target. The targets
    are the paths the scanner lists for linked plugins
    (``scan_vst3_directories`` records ``load_path.resolve()``), and so the
    paths an effect chain or a project saved from a scan carries.
    """
    for root in roots:
        for item in _walk_vst3_paths(root):
            try:
                target = item.resolve(strict=True)
            except (OSError, RuntimeError):
                continue
            if not root_contains(root, target):
                yield item, target
                continue
            if not item.is_dir():
                continue
            binary = _resolve_bundle_binary(item)
            if binary is None:
                continue
            try:
                binary_target = binary.resolve(strict=True)
            except (OSError, RuntimeError):
                continue
            if not root_contains(root, binary_target):
                yield binary, binary_target


def linked_plugin_targets(roots: list[Path]) -> Iterator[Path]:
    """The resolved target of every plugin the scan reaches through a link,
    from a fresh walk (see ``_linked_plugin_sources``)."""
    for _link, target in _linked_plugin_sources(roots):
        yield target


#: How long one walk's link targets answer later checks. A freeze or bounce of
#: a long chain checks the same plugin many times inside this window.
LINKED_TARGETS_TTL_SEC = 30.0

_linked_cache_lock = threading.Lock()
#: roots key -> (monotonic time of the walk, [(link, target), ...])
_linked_cache: dict[tuple[str, ...], tuple[float, list[tuple[Path, Path]]]] = {}


def _roots_key(roots: list[Path]) -> tuple[str, ...]:
    return tuple(os.path.normcase(str(root)) for root in roots)


def _still_leads_to(link: Path, target: Path) -> bool:
    """Whether ``link`` resolves to ``target`` right now (the link was not
    removed or pointed somewhere else since it was walked)."""
    try:
        now = link.resolve(strict=True)
    except (OSError, RuntimeError):
        return False
    return os.path.normcase(str(now)) == os.path.normcase(str(target))


def _covered_by(pairs: list[tuple[Path, Path]], resolved: Path) -> bool:
    return any(
        root_contains(target, resolved) and _still_leads_to(link, target)
        for link, target in pairs
    )


def _linked_targets_cover(roots: list[Path], resolved: Path) -> bool:
    """Whether ``resolved`` is inside the target of a link the scan walks.

    A walk less than ``LINKED_TARGETS_TTL_SEC`` old answers first; a target it
    kept counts only while its link still resolves there. When the kept walk
    covers nothing (a plugin linked since, or a path no link leads to) the
    roots are walked again and that walk is kept.
    """
    key = _roots_key(roots)
    now = time.monotonic()
    with _linked_cache_lock:
        kept = _linked_cache.get(key)
    if kept is not None and now - kept[0] < LINKED_TARGETS_TTL_SEC:
        if _covered_by(kept[1], resolved):
            return True
    fresh = list(_linked_plugin_sources(roots))
    with _linked_cache_lock:
        _linked_cache[key] = (time.monotonic(), fresh)
    return _covered_by(fresh, resolved)


def is_allowed(raw: str, resolved: Path) -> bool:
    """Whether a path the browser named (``raw``, and its ``resolved`` form)
    is inside the VST3 folders this machine scans.

    True when ``resolved`` is inside a root; when ``raw`` is an absolute path
    with no ``..`` segment that sits inside a root as written (a path under a
    linked bundle); or when ``resolved`` is inside the target of a link the
    scan walks under a root (the resolved path the scanner lists for a linked
    plugin). The link test runs only when the first two fail, so a plugin
    installed the ordinary way never pays for it.
    """
    roots = allowed_roots()
    if any(root_contains(root, resolved) for root in roots):
        return True
    if _lexically_inside(raw, roots):
        return True
    return _linked_targets_cover(roots, resolved)


def check_plugin_path(raw: str) -> Path:
    """Validate a browser-supplied plugin path and return its resolved form.

    Raises ``PluginPathError``:
      * 400 - the input is empty, is a network/device path (decided from the
        text alone, before any filesystem access), cannot be resolved, or
        does not end in ``.vst3`` (case-insensitive);
      * 403 - the path is outside every directory in ``allowed_roots()``, as
        ``is_allowed`` judges it.
    """
    if not raw or not raw.strip():
        raise PluginPathError(400, "Plugin path is required.")

    if is_remote_or_device_path(raw):
        raise PluginPathError(400, "Network or device paths are not allowed.")

    try:
        resolved = Path(raw).resolve(strict=False)
    except (OSError, ValueError) as e:
        raise PluginPathError(400, "Plugin path could not be resolved.") from e

    if resolved.suffix.lower() != ".vst3":
        raise PluginPathError(400, "Plugin path must be a .vst3 file or bundle.")

    if not is_allowed(raw, resolved):
        count = len(allowed_roots())
        noun = "directory" if count == 1 else "directories"
        raise PluginPathError(
            403,
            f"Plugin path is not inside any of the {count} allowed VST3 {noun}.",
        )

    return resolved
