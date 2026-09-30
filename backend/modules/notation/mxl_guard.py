"""A compressed MusicXML (``.mxl``) checked before music21 unzips it.

An ``.mxl`` is a zip archive. Its size on the wire says nothing about its size
unpacked: a few kilobytes can declare gigabytes, and music21 inflates every
member it reads into memory. :func:`check_mxl` reads the archive's directory
(no member is inflated) and refuses it when its members together declare
more than ``max_unpacked`` bytes, or when one of them is an archive itself,
which a score never holds and which is the other way to multiply the size.
"""

from __future__ import annotations

import io
import zipfile
import zlib
from pathlib import Path
from typing import Union

# Member names of an archive inside the archive.
_ARCHIVE_SUFFIXES = (
    ".zip",
    ".mxl",
    ".gz",
    ".tgz",
    ".bz2",
    ".xz",
    ".7z",
    ".rar",
    ".tar",
    ".zst",
)
# The first bytes of an archive, whatever its member is named.
_ARCHIVE_MAGIC = (
    b"PK\x03\x04",  # zip, mxl
    b"\x1f\x8b",  # gzip
    b"BZh",  # bzip2
    b"\xfd7zXZ\x00",  # xz
    b"7z\xbc\xaf\x27\x1c",  # 7z
    b"Rar!",  # rar
    b"\x28\xb5\x2f\xfd",  # zstd
)


class MxlRefused(ValueError):
    """An ``.mxl`` refused before it was unpacked, with the HTTP status that
    says why: 413 too large unpacked, 422 not a readable score archive."""

    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.status = status


def check_mxl(source: Union[bytes, str, Path], max_unpacked: int) -> None:
    """Refuse the ``.mxl`` in ``source`` (its bytes, or its path) when its
    members declare more than ``max_unpacked`` bytes in all, when a member is
    an archive, or when it is not a zip archive at all."""
    opened = io.BytesIO(source) if isinstance(source, bytes) else str(source)
    try:
        with zipfile.ZipFile(opened) as archive:
            members = archive.infolist()
            declared = sum(member.file_size for member in members)
            if declared > max_unpacked:
                raise MxlRefused(
                    f"the compressed score unpacks to {declared} bytes; "
                    f"a score is at most {max_unpacked}",
                    status=413,
                )
            for member in members:
                if member.is_dir():
                    continue
                if member.filename.lower().endswith(_ARCHIVE_SUFFIXES):
                    raise MxlRefused(
                        f"the compressed score holds another archive, "
                        f"{member.filename}",
                        status=422,
                    )
                with archive.open(member) as stream:
                    head = stream.read(8)
                if head.startswith(_ARCHIVE_MAGIC):
                    raise MxlRefused(
                        f"the compressed score holds another archive, "
                        f"{member.filename}",
                        status=422,
                    )
    except (
        zipfile.BadZipFile,
        zlib.error,
        EOFError,
        NotImplementedError,
        RuntimeError,
    ) as exc:
        # Not a zip, a damaged one, or a member compressed or encrypted in a
        # way music21 could not read either.
        raise MxlRefused(
            f"the file is not a readable compressed MusicXML archive: {exc}",
            status=422,
        ) from exc
