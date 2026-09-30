"""Replacing a file in place, safely, when more than one caller may be doing it.

Two hazards sit on top of the ordinary write-to-temp-then-rename dance, and
both of them only ever bite under concurrency — which on this backend means
any sync FastAPI handler, because those run on a threadpool and two requests
for the same entry land at the same instant.

**A shared temp name.** ``path.with_suffix(".tmp")`` gives every caller the
same scratch file. One call's write lands in the middle of another's, and
one call's cleanup deletes the other's half-written file. The fix is a name
carrying this call's uuid, so two writes never fight over a source.

**A contended destination.** Windows fails an atomic replace onto a file that
another thread is replacing at the same instant: MoveFileEx returns
ERROR_ACCESS_DENIED (WinError 5) for the few microseconds the other rename
holds the target. Nothing is wrong with either file — the loser just has to
ask again. POSIX has no equivalent, so the retry costs nothing there.

The second one is why this module exists rather than each caller rolling its
own: the failure is rare, platform-specific, and looks like a permissions
problem, so it reads as a fluke and gets retried by hand in one place and
ignored in five others.
"""

from __future__ import annotations

import logging
import os
import time
import uuid
from pathlib import Path
from typing import Union

log = logging.getLogger(__name__)

# Eight tries over ~360ms total. The contention window is microseconds, so a
# replace that has not landed by then is a real permission problem — an
# antivirus scanner holding the file, or a directory we may not write.
REPLACE_ATTEMPTS = 8
REPLACE_BACKOFF_SEC = 0.01


def atomic_replace(src: Union[str, Path], dest: Union[str, Path]) -> None:
    """``os.replace(src, dest)``, retried through a contended destination.

    Raises the last OSError if the destination stays unavailable, so a real
    permission problem still surfaces instead of being retried into silence.
    """
    for attempt in range(REPLACE_ATTEMPTS):
        try:
            os.replace(src, dest)
            return
        except OSError:
            if attempt == REPLACE_ATTEMPTS - 1:
                raise
            time.sleep(REPLACE_BACKOFF_SEC * (attempt + 1))


def temp_sibling(dest: Union[str, Path]) -> Path:
    """A scratch path beside ``dest`` that no concurrent call can also pick.

    Beside, not in the system temp dir, so the replace stays on one filesystem
    and therefore stays atomic.
    """
    dest = Path(dest)
    return dest.with_name(f".{dest.name}.{uuid.uuid4().hex}.tmp")


def atomic_write(
    dest: Union[str, Path],
    payload: Union[bytes, str],
    *,
    encoding: str = "utf-8",
    mode: int | None = None,
) -> None:
    """Write ``payload`` to ``dest`` so a reader sees the old file or the new one.

    Never a half-written one, and never another caller's. The parent directory
    is created if it is missing; the temp file is removed on any failure.

    ``mode``, when given, is applied to the temp file before the rename --
    e.g. owner-only (``0o600``) for a secret (backend/lib/pairing.py's
    token), which must never be world/group-readable even for the instant
    between write and rename. Left ``None`` (the default) for every other
    caller of this module, whose files (recent-projects lists, module
    configs, ...) have no reason to have their mode changed by every write.
    On Windows a POSIX mode only clears the read-only attribute bit (no
    POSIX-style multi-user ACL to restrict) -- real protection where it
    matters is the CI Linux runner and any future non-Windows target.
    """
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = temp_sibling(dest)
    # Tracks whether THIS call actually created `tmp`, so the except handler
    # below never unlinks a file it did not create -- the `mode` branch's
    # O_EXCL can fail on a name collision before the open happens, in which
    # case `tmp` belongs to whatever process/file already holds that name.
    created = False
    try:
        if mode is not None:
            # Create the file already at `mode`, instead of creating it under
            # the default umask and chmod-ing afterward: the latter leaves a
            # window -- however brief -- where the temp file sits on disk at
            # the umask's permissions before the chmod lands, which is
            # exactly the instant the docstring above claims never exists.
            # O_EXCL also guarantees this call, not a leftover temp name from
            # a previous failed write, is what ends up at `mode`.
            fd = os.open(tmp, os.O_CREAT | os.O_WRONLY | os.O_EXCL, mode)
            created = True
            binary = isinstance(payload, bytes)
            with os.fdopen(
                fd, "wb" if binary else "w", encoding=None if binary else encoding
            ) as f:
                f.write(payload)
        elif isinstance(payload, bytes):
            created = True
            tmp.write_bytes(payload)
        else:
            created = True
            tmp.write_text(payload, encoding=encoding)
        atomic_replace(tmp, dest)
    except BaseException:
        if created:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                log.debug("atomic_write: leftover temp file %s", tmp)
        raise
