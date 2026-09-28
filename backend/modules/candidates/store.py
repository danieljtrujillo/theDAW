"""Filesystem store for generate-several candidate sets.

A candidate is an audio result that is not yet in the library: the output
of one "generate several" batch, held for audition (accept / dismiss)
before anything is written into the library tree. Storage lives OUTSIDE
the generations/library root entirely — see :func:`default_candidates_root`
— so an unaccepted candidate never shows up as a library entry and a
library-wide rebuild/reindex never has to know this module exists.

Layout on disk::

    <root>/<set_id>/set.json                   -- header: source/provider/params/label
    <root>/<set_id>/<candidate_id><suffix>      -- candidate audio
    <root>/<set_id>/<candidate_id>.json         -- candidate metadata + status
    <root>/<set_id>/dismissed/<candidate_id>*   -- moved here on dismiss, never deleted

``get_set``/``list_sets`` rebuild each set's candidate list by scanning disk
(active + dismissed) instead of caching it in ``set.json``, because
candidates are appended one at a time — often from several generation jobs
running in parallel — and a single shared array would need a lock around
every append.

Accepting a candidate is the caller's job (F13-2's router calls
``backend.modules.library.store.LibraryStore.import_blob`` and then
:meth:`CandidateStore.mark_accepted`); this module never imports the
library module.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from backend.lib import paths
from backend.lib.atomic import atomic_write
from backend.lib.stamps import IncreasingClock

log = logging.getLogger(__name__)

MAX_CANDIDATE_BYTES = 200 * 1024 * 1024
MAX_CANDIDATES_PER_SET = 32

#: Audio extensions a candidate file may be written with. Anything else (or
#: no extension) falls back to ``.wav`` — mirrors the folder-import allowlist
#: philosophy in backend/modules/library/store.py.
_AUDIO_SUFFIXES = frozenset({".wav", ".mp3", ".flac", ".ogg", ".m4a"})

_TOKEN_RE = re.compile(r"[0-9a-f]{32}")

_SET_FILENAME = "set.json"
_DISMISSED_DIRNAME = "dismissed"


def default_candidates_root() -> Path:
    """Where candidate sets live: a sibling of the library root, NEVER inside
    it — an unaccepted candidate must not appear in a library scan/reindex."""
    return paths.library_root().parent / "candidates"


# list_sets orders sets newest first and each set's candidates oldest first
# by ``created_at``. Windows' clock moves in 15.6 ms steps, so two made in
# quick succession got the same value and fell back to folder order, whose
# names are random ids; the stamps are strictly increasing instead
# (backend/lib/stamps.py).
_created_at = IncreasingClock()


def new_token() -> str:
    """A fresh id for a set or a candidate."""
    return uuid.uuid4().hex


def is_token(value: str) -> bool:
    """Whether ``value`` is a plain id token: lowercase hex, nothing else.

    Ids are never taken from a caller and used as a path segment directly —
    every public method on :class:`CandidateStore` checks this first, before
    the id is joined onto a directory.
    """
    return bool(_TOKEN_RE.fullmatch(value))


def _contains(root_normcase: str, candidate: Path) -> bool:
    """Whether ``candidate`` resolves to something inside the candidates
    root.

    Same containment idiom as backend/modules/library/store.py's
    ``_contains`` (case-normalised prefix match on the resolved path) — the
    guard of last resort against a symlink planted in the tree, since
    :func:`is_token` already rules out ``..`` and path separators in any id
    that reaches this far.
    """
    try:
        target = os.path.normcase(str(candidate.resolve()))
    except OSError:
        return False
    return target.startswith(root_normcase + os.sep)


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    """Write ``payload`` atomically — a crash mid-write must never leave a
    truncated json file for the next read to choke on, and two writers can
    never share a temp file (``backend.lib.atomic.atomic_write``)."""
    atomic_write(path, json.dumps(payload, indent=2))


@dataclass
class CandidateSet:
    """One generate-several batch: a seed source, the provider/params used,
    and the candidates generated against it so far."""

    id: str
    source: dict[str, Any]
    provider: str
    params: dict[str, Any]
    label: str
    created_at: float
    candidates: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "source": dict(self.source),
            "provider": self.provider,
            "params": dict(self.params),
            "label": self.label,
            "created_at": self.created_at,
            "candidates": [dict(c) for c in self.candidates],
        }


class CandidateStore:
    """Filesystem-backed store for candidate sets. See the module docstring
    for the on-disk layout."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    # ---- id / path safety ---------------------------------------------------

    def _root_normcase(self) -> str:
        return os.path.normcase(str(self.root.resolve()))

    def _require_token(self, value: str) -> None:
        if not is_token(value):
            raise ValueError("bad id")

    def _set_dir(self, set_id: str, *, must_exist: bool = False) -> Path:
        """Validate ``set_id`` and return its directory.

        Raises ``ValueError('bad id')`` before touching the filesystem when
        the id is not a plain token, or when the resolved directory would
        fall outside :attr:`root`. ``must_exist`` additionally requires a
        ``set.json`` to already be there (for methods that operate on a set
        created earlier, as opposed to :meth:`create_set` itself).
        """
        self._require_token(set_id)
        set_dir = self.root / set_id
        if not _contains(self._root_normcase(), set_dir):
            raise ValueError("bad id")
        if must_exist and not (set_dir / _SET_FILENAME).is_file():
            raise ValueError("unknown candidate set")
        return set_dir

    def _read_candidate_meta_files(self, directory: Path) -> list[dict[str, Any]]:
        if not directory.is_dir():
            return []
        out: list[dict[str, Any]] = []
        for p in sorted(directory.iterdir()):
            if not p.is_file() or p.suffix != ".json" or p.name == _SET_FILENAME:
                continue
            try:
                out.append(_read_json(p))
            except (OSError, json.JSONDecodeError) as e:
                log.warning(
                    "candidates: skipping unreadable metadata file %s: %s", p, e
                )
                continue
        return out

    # ---- create / add ---------------------------------------------------------

    def create_set(
        self,
        *,
        source: dict[str, Any],
        provider: str,
        params: dict[str, Any],
        label: str,
    ) -> str:
        set_id = new_token()
        set_dir = self.root / set_id
        set_dir.mkdir(parents=True, exist_ok=True)
        header = {
            "id": set_id,
            "source": dict(source),
            "provider": provider,
            "params": dict(params),
            "label": label,
            "created_at": _created_at(),
        }
        _write_json(set_dir / _SET_FILENAME, header)
        return set_id

    def add_candidate(
        self,
        set_id: str,
        *,
        audio_bytes: bytes,
        filename: str,
        mime_type: str,
        provider_job_id: str | None,
        params: dict[str, Any],
        seed: int | None,
    ) -> str:
        set_dir = self._set_dir(set_id, must_exist=True)
        if not audio_bytes:
            raise ValueError("candidate audio is empty")
        if len(audio_bytes) > MAX_CANDIDATE_BYTES:
            raise ValueError(f"candidate exceeds {MAX_CANDIDATE_BYTES} bytes")
        if len(self._read_candidate_meta_files(set_dir)) >= MAX_CANDIDATES_PER_SET:
            raise ValueError("candidate set is full")

        candidate_id = new_token()
        suffix = Path(filename).suffix.lower()
        if suffix not in _AUDIO_SUFFIXES:
            suffix = ".wav"
        audio_name = f"{candidate_id}{suffix}"
        # Atomic, like the meta beside it: a write cut off halfway (disk full,
        # the backend stopped) leaves no half-written take at the take's name,
        # and the meta that would point at one is never written.
        atomic_write(set_dir / audio_name, audio_bytes)

        meta = {
            "id": candidate_id,
            "set_id": set_id,
            "status": "ready",
            "filename": audio_name,
            "mime_type": mime_type,
            "provider_job_id": provider_job_id,
            "params": dict(params),
            "seed": seed,
            "file_size_bytes": len(audio_bytes),
            "created_at": _created_at(),
            "library_entry_id": None,
        }
        _write_json(set_dir / f"{candidate_id}.json", meta)
        return candidate_id

    # ---- read -----------------------------------------------------------------

    def list_sets(self, source_id: str | None = None) -> list[dict[str, Any]]:
        """All candidate sets, newest first. ``source_id`` filters to sets
        whose ``source["id"]`` matches, when given."""
        if not self.root.is_dir():
            return []
        sets: list[dict[str, Any]] = []
        for child in self.root.iterdir():
            if not child.is_dir() or not is_token(child.name):
                continue
            set_path = child / _SET_FILENAME
            if not set_path.is_file():
                continue
            try:
                header = _read_json(set_path)
            except (OSError, json.JSONDecodeError) as e:
                log.warning(
                    "candidates: skipping unreadable set.json in %s: %s", child, e
                )
                continue
            if (
                source_id is not None
                and header.get("source", {}).get("id") != source_id
            ):
                continue
            candidates = self._read_candidate_meta_files(child)
            candidates += self._read_candidate_meta_files(child / _DISMISSED_DIRNAME)
            candidates.sort(key=lambda c: c.get("created_at", 0.0))
            header["candidates"] = candidates
            sets.append(header)
        sets.sort(key=lambda s: s.get("created_at", 0.0), reverse=True)
        return sets

    def get_set(self, set_id: str) -> dict[str, Any] | None:
        """The set header plus every candidate (any status), or ``None`` when
        ``set_id`` is a well-formed token that does not name an existing
        set."""
        set_dir = self._set_dir(set_id)
        set_path = set_dir / _SET_FILENAME
        if not set_path.is_file():
            return None
        header = _read_json(set_path)
        candidates = self._read_candidate_meta_files(set_dir)
        candidates += self._read_candidate_meta_files(set_dir / _DISMISSED_DIRNAME)
        candidates.sort(key=lambda c: c.get("created_at", 0.0))
        header["candidates"] = candidates
        return header

    def audio_path(self, set_id: str, candidate_id: str) -> Path | None:
        """The on-disk audio file for one candidate (active or dismissed), or
        ``None`` when it cannot be found or would resolve outside
        :attr:`root`."""
        set_dir = self._set_dir(set_id)
        self._require_token(candidate_id)
        root_normcase = self._root_normcase()

        for meta_dir in (set_dir, set_dir / _DISMISSED_DIRNAME):
            meta_path = meta_dir / f"{candidate_id}.json"
            if not meta_path.is_file():
                continue
            try:
                meta = _read_json(meta_path)
            except (OSError, json.JSONDecodeError):
                continue
            filename = meta.get("filename")
            if not filename:
                continue
            candidate_audio = meta_dir / filename
            if not _contains(root_normcase, candidate_audio):
                return None
            if candidate_audio.is_file():
                return candidate_audio
        return None

    # ---- transitions ------------------------------------------------------------

    def mark_accepted(
        self, set_id: str, candidate_id: str, library_entry_id: str
    ) -> dict[str, Any]:
        """Record that ``candidate_id`` was imported into the library as
        ``library_entry_id``. The candidate's files stay where they are —
        only ``dismiss`` moves anything."""
        set_dir = self._set_dir(set_id, must_exist=True)
        self._require_token(candidate_id)
        meta_path = set_dir / f"{candidate_id}.json"
        if not meta_path.is_file():
            raise ValueError("candidate not found")
        meta = _read_json(meta_path)
        meta["status"] = "accepted"
        meta["library_entry_id"] = library_entry_id
        _write_json(meta_path, meta)
        return meta

    def dismiss(self, set_id: str, candidate_id: str) -> dict[str, Any]:
        """Move the candidate's audio + metadata into ``<set_id>/dismissed/``.

        Never deletes: ``shutil.move`` relocates both files, it does not
        remove them from existence. The metadata is updated to status
        'dismissed' before the move, in place, so nothing is ever unlinked.
        """
        set_dir = self._set_dir(set_id, must_exist=True)
        self._require_token(candidate_id)
        meta_path = set_dir / f"{candidate_id}.json"
        if not meta_path.is_file():
            raise ValueError("candidate not found")

        meta = _read_json(meta_path)
        meta["status"] = "dismissed"
        _write_json(meta_path, meta)

        dismissed_dir = set_dir / _DISMISSED_DIRNAME
        dismissed_dir.mkdir(parents=True, exist_ok=True)

        audio_name = meta.get("filename")
        if audio_name:
            audio_path = set_dir / audio_name
            if audio_path.is_file():
                shutil.move(str(audio_path), str(dismissed_dir / audio_name))

        shutil.move(str(meta_path), str(dismissed_dir / f"{candidate_id}.json"))
        return meta
