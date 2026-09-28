"""Bring a score into the library as a composition entry of its own.

``POST /api/notation/import`` takes an uploaded ``.musicxml``, ``.xml``,
``.mxl``, ``.krn`` or ``.abc`` file, and ``POST /api/notation/corpus/open``
takes a piece from the music21 corpus (:mod:`backend.modules.sheetimport.corpus`).
Both land in :func:`import_score`:

  1. music21 parses the score. A file it cannot read is refused before
     anything is written, so a failed import leaves nothing behind.
  2. A composition entry (library kind ``score``, see
     ``LibraryStore.create_score_entry``) is made for it, titled and credited
     from the file's own metadata.
  3. The entry's ``notation/`` folder gets the original file byte for byte,
     registered under its own kind (``musicxml``, ``mxl``, ``kern`` or
     ``abc``), and the MusicXML sheet the SCORE tab draws. An uncompressed
     MusicXML original IS that sheet; any other original gets a sheet music21
     writes beside it.

The title and the composer credit are the file's: nothing here stamps the
app's default artist on an imported score, and the notation backfill leaves
an imported sheet's credit alone (``backfill._keeps_own_credit``). The entry
records them as its notation identity (``notation_title`` /
``notation_artist``), so every later export (PDF, pack, ABC) credits the same
composer the file does.
"""

from __future__ import annotations

import io
import logging
import re
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Optional

from backend.lib.atomic import atomic_write

from .mxl_guard import MxlRefused, check_mxl
from .engine import (
    _musicxml_prolog_extras,
    _song_slug,
    _splice_musicxml_prolog_extras,
    _strip_invalid_xml_chars,
    _write_musicxml,
)
from .sheet_pitch import legacy_sounding_pitch
from .tempo_marks import engrave_tempo_marks

log = logging.getLogger(__name__)

#: The upload suffixes the import route takes, and the artifact kind the
#: original is kept as.
KIND_FOR_IMPORT_SUFFIX: dict[str, str] = {
    ".musicxml": "musicxml",
    ".xml": "musicxml",
    ".mxl": "mxl",
    ".krn": "kern",
    ".abc": "abc",
}
IMPORT_SUFFIXES: tuple[str, ...] = tuple(KIND_FOR_IMPORT_SUFFIX)

#: Scores are small; this only guards against an accidental huge upload. The
#: same ceiling the sheet parser (``/api/sheetimport/parse``) applies.
MAX_IMPORT_BYTES = 25 * 1024 * 1024
#: A compressed score (``.mxl``) may unpack to this many times
#: ``MAX_IMPORT_BYTES``; its members' declared sizes are summed before music21
#: unzips it (:mod:`.mxl_guard`).
MXL_EXPANSION_LIMIT = 4

#: The ``engine`` every artifact of an imported score is registered with, and
#: the flag its metadata carries: the file is the user's, not an engraving.
IMPORT_ENGINE = "score-import"
IMPORTED_FLAG = "imported"

# music21's stand-ins for a score with no title or no composer. They are not a
# credit, so an import never keeps them as one.
_PLACEHOLDER_TITLES = frozenset({"music21 fragment", "music21"})
_PLACEHOLDER_COMPOSERS = frozenset({"music21"})

# File suffixes music21 leaves in movementName when a file has no title of its
# own (the corpus's Bach chorales read as "bwv66.6.mxl").
_NAME_SUFFIX_RE = re.compile(
    r"\.(musicxml|xml|mxl|krn|abc|mid|midi|mei|rntxt|capx|md|nwc|tntxt)$", re.I
)


class ScoreImportError(ValueError):
    """An import refused for a reason the caller can report, with the HTTP
    status that describes it (415 wrong type, 422 unreadable score)."""

    def __init__(self, message: str, status: int = 422) -> None:
        super().__init__(message)
        self.status = status


def safe_filename(name: str) -> str:
    """The last path component of an uploaded file name, either separator.

    A browser sends a bare name, but the multipart field is the caller's to
    fill; nothing an upload names may choose where a file is written, so only
    the final component is ever used, and only to pick a suffix and a
    display name.
    """
    return re.split(r"[\\/]", str(name or ""))[-1].strip()


def import_kind(filename: str) -> Optional[str]:
    """The artifact kind an uploaded file is kept as, or None when its suffix
    is not one the import takes."""
    return KIND_FOR_IMPORT_SUFFIX.get(Path(safe_filename(filename)).suffix.lower())


def first_score(parsed: Any) -> Any:
    """A score from what music21 parsed: an ABC book (and a MusicXML opus)
    parses as an ``Opus``, whose first score is the piece."""
    from music21 import stream

    if isinstance(parsed, stream.Opus):
        scores = list(parsed.scores)
        if not scores:
            raise ScoreImportError("the file holds no score")
        return scores[0]
    return parsed


def parse_score_bytes(data: bytes, filename: str) -> Any:
    """Parse an uploaded score with music21 and return the score.

    The bytes go to a scratch file named with the upload's suffix, because
    music21 picks its reader from the suffix (and unzips ``.mxl`` itself).
    ``forceSource`` keeps music21's parse cache out of it. Raises
    :class:`ScoreImportError` for a suffix the import does not take, a file
    music21 cannot read, or a score with no notes, and for an ``.mxl`` whose
    members declare more than ``MXL_EXPANSION_LIMIT x MAX_IMPORT_BYTES``
    (413) or hold another archive, before music21 unzips it.
    """
    name = safe_filename(filename)
    suffix = Path(name).suffix.lower()
    if suffix not in KIND_FOR_IMPORT_SUFFIX:
        raise ScoreImportError(
            f"{name or 'the file'} is not a score file; import takes "
            f"{', '.join(IMPORT_SUFFIXES)}",
            status=415,
        )
    if suffix == ".mxl":
        try:
            check_mxl(data, MXL_EXPANSION_LIMIT * MAX_IMPORT_BYTES)
        except MxlRefused as exc:
            raise ScoreImportError(f"{name}: {exc}", status=exc.status) from exc
    from music21 import converter

    with tempfile.TemporaryDirectory(prefix="thedaw-score-import-") as scratch:
        path = Path(scratch) / f"upload{suffix}"
        atomic_write(path, data)
        try:
            score = first_score(converter.parse(str(path), forceSource=True))
        except ScoreImportError:
            raise
        except Exception as exc:
            raise ScoreImportError(f"could not read {name} as a score: {exc}") from exc
    if score is None or not score.recurse().notes:
        raise ScoreImportError(f"{name} holds no notes")
    return score


def score_identity(score: Any, fallback: str) -> tuple[str, str]:
    """``(title, composer)`` as the score's own metadata states them.

    The title is the work title, else the movement name (with a file suffix
    music21 left in it dropped), else ``fallback``. The composer is ``""``
    when the file names none; music21's "Music21" stand-in is never kept as a
    credit.
    """
    md = getattr(score, "metadata", None)
    title = ""
    composer = ""
    if md is not None:
        title = str(md.title or "").strip()
        if not title:
            title = _NAME_SUFFIX_RE.sub("", str(md.movementName or "").strip())
        composer = str(md.composer or "").strip()
    if title.lower() in _PLACEHOLDER_TITLES:
        title = ""
    if composer.lower() in _PLACEHOLDER_COMPOSERS:
        composer = ""
    title = _strip_invalid_xml_chars(title or fallback or "Score")
    return title, _strip_invalid_xml_chars(composer)


def _drop_placeholder_composer(path: Path) -> None:
    """Remove the ``<creator type="composer">Music21</creator>`` music21's
    writer puts on a score that names no composer. An imported score with no
    credit keeps none; the placeholder is not the composer."""
    try:
        raw = path.read_bytes()
        parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True))
        tree = ET.parse(io.BytesIO(raw), parser=parser)
    except (OSError, ET.ParseError):
        return
    identification = tree.getroot().find("identification")
    if identification is None:
        return
    placeholders = [
        creator
        for creator in identification.findall("creator")
        if (creator.get("type") or "composer").strip().lower() == "composer"
        and (creator.text or "").strip().lower() in _PLACEHOLDER_COMPOSERS
    ]
    if not placeholders:
        return
    for creator in placeholders:
        identification.remove(creator)
    buf = io.BytesIO()
    tree.write(buf, encoding="UTF-8", xml_declaration=True)
    body = _splice_musicxml_prolog_extras(buf.getvalue(), _musicxml_prolog_extras(raw))
    try:
        ET.fromstring(body)
    except ET.ParseError:
        # The prolog splice would not parse: the ElementTree body alone, and
        # only when that parses; otherwise the sheet is left as it was.
        body = buf.getvalue()
        try:
            ET.fromstring(body)
        except ET.ParseError:
            return
    atomic_write(path, body)


def _write_sheet(score: Any, path: Path, *, title: str, composer: str) -> Path:
    """Write ``score`` as the entry's MusicXML sheet at ``path``.

    A score whose file named no title at all is given the display title, so
    the sheet does not print music21's "Music21 Fragment"; a title or credit
    the file did name is written as it is.
    """
    from music21 import metadata

    md = score.metadata
    if md is None:
        md = metadata.Metadata()
        score.insert(0, md)
    if not (md.title or md.movementName):
        md.title = title
    engrave_tempo_marks(score)
    written = _write_musicxml(score, path, what=f"importing {title}")
    if not composer:
        _drop_placeholder_composer(written)
    return written


def _unique_path(directory: Path, stem: str, suffix: str) -> Path:
    """``<directory>/<stem><suffix>``, numbered when that name is taken."""
    candidate = directory / f"{stem}{suffix}"
    n = 2
    while candidate.exists():
        candidate = directory / f"{stem}-{n}{suffix}"
        n += 1
    return candidate


def import_score(
    store: Any,
    score: Any,
    *,
    display_name: str,
    original: Optional[tuple[bytes, str]] = None,
    origin: str = "upload",
    extra_metadata: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Make a composition entry for ``score`` and register its artifacts.

    ``original`` is ``(bytes, suffix)`` of the file the score was read from,
    kept byte for byte; None when there is no file of its own to keep (a
    tune cut from a corpus ABC book). ``origin`` ("upload" | "corpus") and
    ``extra_metadata`` are recorded on the entry and on each artifact.

    Returns ``{"ok", "entry_id", "entry", "title", "composer", "sheet",
    "artifacts"}``. On any failure after the entry was made, the entry is
    deleted again and the error raised.
    """
    if store.db is None:
        raise ScoreImportError("library DB not available", status=503)
    title, composer = score_identity(score, display_name)
    extra = dict(extra_metadata or {})
    entry_meta: dict[str, Any] = {
        "title": title,
        "notation_title": title,
        "model": IMPORT_ENGINE,
        "score_origin": origin,
        **extra,
    }
    if composer:
        entry_meta["notation_artist"] = composer
        entry_meta["composer"] = composer
    if original is not None:
        entry_meta["filename"] = f"{display_name}{original[1]}"
    record, entry_dir = store.create_score_entry(title=title, metadata=entry_meta)
    entry_id = record.id
    try:
        notation_dir = entry_dir / "notation"
        notation_dir.mkdir(parents=True, exist_ok=True)
        stem = _song_slug(title)
        artifact_meta: dict[str, Any] = {
            IMPORTED_FLAG: True,
            "origin": origin,
            "title": title,
            "composer": composer,
            **extra,
        }
        registered: list[str] = []
        original_id: Optional[str] = None
        sheet_path: Optional[Path] = None
        if original is not None:
            data, suffix = original
            kind = KIND_FOR_IMPORT_SUFFIX.get(suffix.lower(), suffix.lstrip("."))
            original_path = _unique_path(notation_dir, stem, suffix.lower())
            atomic_write(original_path, data)
            if kind == "musicxml":
                # An uncompressed MusicXML file is the sheet itself. One music21
                # encoded elsewhere, with a <transpose> and no written-pitch
                # stamp, would read here as a sheet an older build wrote at
                # sounding pitch; it is music21's output anyway, so it is
                # written again, stamped, over the same name.
                if legacy_sounding_pitch(original_path):
                    _write_sheet(score, original_path, title=title, composer=composer)
                sheet_path = original_path
            else:
                original_id = f"{entry_id}__{original_path.stem}__{kind}"
                store.db.add_notation_artifact(
                    artifact_id=original_id,
                    entry_id=entry_id,
                    kind=kind,
                    path=str(original_path),
                    source_ref=None,
                    engine=IMPORT_ENGINE,
                    engine_version="1",
                    metadata={**artifact_meta, "format": kind, "original": True},
                )
                registered.append(original_id)
        if sheet_path is None:
            sheet_path = _write_sheet(
                score,
                _unique_path(notation_dir, stem, ".musicxml"),
                title=title,
                composer=composer,
            )
        sheet_id = f"{entry_id}__{sheet_path.stem}__musicxml"
        store.db.add_notation_artifact(
            artifact_id=sheet_id,
            entry_id=entry_id,
            kind="musicxml",
            path=str(sheet_path),
            source_ref=original_id,
            engine=IMPORT_ENGINE,
            engine_version="1",
            metadata={
                **artifact_meta,
                "format": "musicxml",
                "original": original_id is None and original is not None,
            },
        )
        registered.append(sheet_id)
        if original_id is not None:
            store.db.add_relation(
                from_id=original_id,
                to_id=sheet_id,
                kind="rendered_as_notation",
                metadata={"format": "musicxml", "engine": IMPORT_ENGINE},
            )
    except Exception:
        log.warning("notation: import of %s failed; removing entry %s", title, entry_id)
        store.delete_entry(entry_id)
        raise
    log.info(
        "notation: imported %r (%s) as composition %s",
        title,
        composer or "no credit",
        entry_id,
    )
    return {
        "ok": True,
        "entry_id": entry_id,
        "entry": record.to_dict(),
        "title": title,
        "composer": composer,
        "sheet": store.db.get_notation_artifact(sheet_id),
        "artifacts": [store.db.get_notation_artifact(a) for a in registered],
    }


def import_corpus_piece(store: Any, piece_id: str) -> dict[str, Any]:
    """Open one piece of the music21 corpus and import it the same way an
    upload is (see :func:`import_score`). A piece that is a whole file of a
    type the import keeps brings that file along as its original."""
    from backend.modules.sheetimport.corpus import open_piece

    try:
        parsed, described, original = open_piece(piece_id, IMPORT_SUFFIXES)
    except KeyError as exc:
        raise ScoreImportError(
            f"no piece {piece_id!r} in the music21 corpus", status=404
        ) from exc
    except Exception as exc:
        raise ScoreImportError(
            f"could not read corpus piece {piece_id}: {exc}"
        ) from exc
    score = first_score(parsed)
    if score is None or not score.recurse().notes:
        raise ScoreImportError(f"corpus piece {piece_id} holds no notes")
    return import_score(
        store,
        score,
        display_name=str(described.get("title") or Path(described["path"]).stem),
        original=original,
        origin="corpus",
        extra_metadata={"corpus_id": described["id"], "corpus_path": described["path"]},
    )


def import_score_upload(store: Any, data: bytes, filename: str) -> dict[str, Any]:
    """Parse an uploaded score file and import it (see :func:`import_score`)."""
    name = safe_filename(filename)
    score = parse_score_bytes(data, name)
    return import_score(
        store,
        score,
        display_name=Path(name).stem or "Score",
        original=(data, Path(name).suffix.lower()),
        origin="upload",
    )
