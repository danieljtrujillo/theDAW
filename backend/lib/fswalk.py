"""One directory walk for every platform.

``Path.rglob`` and a default ``os.walk`` stop at a directory symlink (the way
Linux and macOS users keep a folder on another drive) and enter a Windows
junction, so the same layout lists different files per platform.
``walk_files`` follows both kinds of link and visits each real directory once,
by ``(st_dev, st_ino)``, which keeps a link cycle finite.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Callable, Iterator, Optional


def _identity(path: str) -> Optional[tuple[int, int]]:
    """``(st_dev, st_ino)`` of the directory a path leads to, or None when it
    cannot be read or the filesystem reports no inode number."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    if st.st_ino == 0:
        return None
    return (st.st_dev, st.st_ino)


def walk_files(
    root: str | os.PathLike[str],
    *,
    skip_dir: Optional[Callable[[str], bool]] = None,
) -> Iterator[Path]:
    """Every file under ``root``, directories in name order, files in name
    order inside each directory.

    Directory symlinks and junctions are followed; a directory already walked
    in this call is entered once only. ``skip_dir`` receives a directory NAME
    and returns True to leave that subtree out. Unreadable directories are
    skipped.
    """
    visited: set[tuple[int, int]] = set()
    root_id = _identity(os.fspath(root))
    if root_id is not None:
        visited.add(root_id)
    for dirpath, dirnames, filenames in os.walk(root, followlinks=True):
        kept: list[str] = []
        for name in sorted(dirnames):
            if skip_dir is not None and skip_dir(name):
                continue
            sub_id = _identity(os.path.join(dirpath, name))
            if sub_id is not None:
                if sub_id in visited:
                    continue
                visited.add(sub_id)
            kept.append(name)
        dirnames[:] = kept
        for name in sorted(filenames):
            yield Path(dirpath) / name
