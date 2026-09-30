"""A synthetic library heavy enough to price the library API, for the guard.

Two features shipped in one week that were fast on a 68-song test library and
unusable on the user's: the provider filter read every row's ``metadata_json``
(13.3 s for one page) and the LEARN tab fetched the whole lineage graph
(128 MB, then a crash). Neither was caught, because every budget fixture in
this repository writes a two-byte metadata blob -- at that weight, reading
every row is free and a query that does it looks fast.

This module builds the fixture those tests needed: 20,000 entries whose
``metadata_json`` is padded to ~8 KB each, written through the REAL
:class:`~backend.modules.library.db.LibraryDB` so the rows, indexes and
migrations are production's, plus the on-disk ``<root>/<id>/metadata.json``
tree the store stats before it will show a row at all. The padding constant
and the padder are :mod:`tests.lineagescale_fixtures`' -- one weight for every
scale fixture in this repository, not a third one.

The shapes are the ones the API surface is sensitive to:

* mostly ``source='suno'`` with a ``chirp-*`` model, which is what the real
  library is, plus generate / studio / import, videos and images;
* a resolved ``provider`` column on some rows and NULL on others, so both
  halves of the provider rule are exercised -- and NO row whose column is
  NULL names a provider in its metadata, because that would make a plain GET
  write (``LibraryStore._fill_provider_column``) and a read probe must not;
* ~50,000 relations: ancestry kinds, ``mashup_source``, one 500-child hub,
  pairs linked by three kinds at once, a 2-cycle, and a couple of thousand
  songs with no lineage at all;
* stems, MIDI files and notation artifacts, so the ``/_all/*`` routes have
  something to return;
* favorites and play counts, so the ``favorite`` filter and the ``plays_desc``
  sort are not answering about an empty set.

Every id, title, model, provider slug and path below is invented by this file.
Nothing here reads, writes or names anything in anyone's library.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from backend.modules.library.db import LibraryDB
from tests.lineagescale_fixtures import METADATA_PAD_BYTES, _pad as metadata_pad

#: Entries in the fixture. The real library holds 194,508 at ~34 KB of
#: metadata a row; this is the largest size that still builds in seconds, and
#: every cost the API surface has is already linear well before 20,000.
ENTRIES = 20_000

#: Entry ids are ``scale-000000`` .. and carry no underscore on purpose:
#: ``LibraryStore._dir_for`` spends a second stat() on an id with one, looking
#: for the nested ``<job>/<index>`` generate layout.
ID_PREFIX = "scale-"

#: The block at the end of the table that gets NO relations -- the songs a
#: library mostly consists of.
STANDALONE_FROM = 18_000
STANDALONE = ENTRIES - STANDALONE_FROM

#: The hub and its children, as one contiguous run. The real library's biggest
#: fan-out is ~750-850 children on one song; 500 is past every grouping
#: threshold the lineage routes apply, which is what the shape is for.
HUB_INDEX = 10_000
HUB_CHILDREN = 500
#: Three kinds over the 500, so the hub is a fan of groups rather than one
#: 500-wide list.
_HUB_KINDS = ("cover_of", "edit_of", "upsample_of")

#: One source a great many mashups reach for.
POPULAR_SOURCE_INDEX = 1_000

#: A two-node cycle. The real library has them (A derived from B, B edited
#: from A after a round trip), and a walker that trusts the graph is acyclic
#: hangs on one.
CYCLE_A_INDEX = 100
CYCLE_B_INDEX = 101

#: ``(back_step, kind, modulus)``: an edge from entry *i* to entry *i - step*
#: whenever ``i % modulus == 0``. Sums to ~2.9 edges per non-standalone entry,
#: which is the ratio the real ``relations`` table holds (475,174 rows over
#: 194,508 entries). Overlapping recipes on one pair are the point, not an
#: accident: the real library stores a promoted stem as ``derived_from`` AND
#: ``edit_of`` AND ``stem_of``, and those are three rows on one pair.
_EDGE_RECIPES = (
    (1, "derived_from", 1),
    (1, "edit_of", 2),
    (1, "stem_of", 3),
    (2, "cover_of", 2),
    (5, "upsample_of", 4),
    (3, "mashup_source", 5),
)

#: Models, by source. ``chirp-*`` dominates because the real library does.
_SUNO_MODELS = ("chirp-v3-5", "chirp-v4", "chirp-v4-5", "chirp-bluejay")
_GENERATE_MODELS = ("small", "medium")

#: Provider slugs stored in metadata (and so resolved into the column).
#: Invented for this file.
_STORED_PROVIDERS = ("paper-lantern", "north-dial", "quiet-shelf")

#: A slug carried by ~7 of the 20,000 rows: the worst case for a filter that
#: cannot seek, because a scan runs to the end of the table before it has a
#: full page.
RARE_PROVIDER = "brass-kettle"
_RARE_EVERY = 3_001

#: A word every title carries ("fixture track 000123"), so a ``q=`` probe
#: matches all 20,000 rows -- the worst case for a search, and the only weight
#: at which the non-fts5 fallback's unindexed ``LIKE`` over every row's
#: ``lyrics`` shows up. Exported so the guard cannot probe with a word this
#: module stopped writing.
SEARCH_WORD = "fixture"

#: Songs that got separated / converted / engraved. A handful of each, so the
#: ``/_all/*`` routes answer about hundreds of rows rather than three without
#: the fixture paying for thousands of child rows it never reads.
SEPARATED_SONGS = 100
_STEM_NAMES = ("vocals", "drums", "bass", "other")
MIDI_SONGS = 150
SCORE_SONGS = 80

#: Entries that get a real audio file on disk. ``LibraryStore.get_entry``
#: resolves one before it will build a record, so the single-entry routes need
#: it; the list routes do not (they build from the row plus a directory stat),
#: which is why this is a handful and not 20,000 more files.
_TINY_WAV = b"RIFF$\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00D\xac\x00\x00\x88X\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
_TINY_JPEG = b"\xff\xd8\xff\xd9"
_TINY_MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom"


def entry_id(index: int) -> str:
    """The id of the ``index``-th entry."""
    return f"{ID_PREFIX}{index:06d}"


@dataclass(frozen=True)
class ScaleLibrary:
    """A built library plus the landmarks and measurements a test needs."""

    root: Path
    db_path: Path
    db: LibraryDB
    entries: int
    relations: int
    stems: int
    midis: int
    scores: int
    #: Total bytes of ``metadata_json`` across every row.
    blob_bytes: int
    #: The database file, including -wal, at the moment the build finished.
    db_bytes: int
    build_seconds: float
    #: An ordinary audio entry: stored provider, lineage, a file on disk.
    common_id: str
    #: The song with :data:`HUB_CHILDREN` children.
    hub_id: str
    #: An entry carrying the rare provider slug.
    rare_id: str
    #: A registered stem with its WAV on disk.
    stem_id: str
    #: A video entry with its file and poster on disk.
    media_id: str

    def close(self) -> None:
        self.db.close()


def _kind_for(index: int) -> str:
    if index % 250 == 7:
        return "video"
    if index % 250 == 11:
        return "image"
    return "audio"


def _source_model(index: int) -> tuple[str, str]:
    bucket = index % 10
    if bucket <= 6:
        return "suno", _SUNO_MODELS[index % len(_SUNO_MODELS)]
    if bucket == 7:
        return "generate", _GENERATE_MODELS[index % len(_GENERATE_MODELS)]
    if bucket == 8:
        return "studio", "medium"
    return "import", ""


def _provider_for(index: int) -> str:
    """The provider this row's METADATA names, or ``""`` for none.

    ``""`` leaves the column NULL and the ``(model, source)`` fallback
    answering -- and, critically, leaves nothing for a read to resolve and
    write back.
    """
    if index % _RARE_EVERY == 3:
        return RARE_PROVIDER
    if index % 4 == 0:
        return _STORED_PROVIDERS[index % len(_STORED_PROVIDERS)]
    return ""


def _metadata_for(index: int, pad: dict[str, Any]) -> dict[str, Any]:
    meta = dict(pad)
    provider = _provider_for(index)
    if provider:
        meta["provider"] = provider
    if index % 3 == 0:
        # Long lyrics on a third of the rows: the paged list replaces them
        # with a preview, and the single-entry read does not.
        meta["lyrics"] = "\n".join(f"line {n} of a synthetic lyric" for n in range(40))
    return meta


def _payloads(pad: dict[str, Any]) -> Iterator[dict[str, Any]]:
    for index in range(ENTRIES):
        kind = _kind_for(index)
        source, model = _source_model(index)
        yield {
            "id": entry_id(index),
            "kind": kind,
            "title": f"fixture track {index:06d}",
            "prompt": "a synthetic prompt" if source == "generate" else "",
            "model": model,
            "source": source,
            "duration": 30.0 + (index % 210),
            "audio_filename": "audio.mp3" if kind == "audio" else "media.mp4",
            "mime": "audio/mpeg" if kind == "audio" else "video/mp4",
            "file_size_bytes": 1_000 + index,
            "favorite": index % 17 == 0,
            "timestamp": "2026-01-01T00:00:00Z",
            "tags": ["synthetic", f"bucket-{index % 20:02d}"],
            "metadata_json": _metadata_for(index, pad),
        }


def _edges() -> list[tuple[str, str, str]]:
    out: list[tuple[str, str, str]] = []
    popular = entry_id(POPULAR_SOURCE_INDEX)
    for index in range(1, STANDALONE_FROM):
        for step, kind, modulus in _EDGE_RECIPES:
            if index % modulus == 0 and index - step >= 0:
                out.append((entry_id(index), entry_id(index - step), kind))
        if index % 7 == 0 and index > POPULAR_SOURCE_INDEX:
            out.append((entry_id(index), popular, "mashup_source"))
    hub = entry_id(HUB_INDEX)
    for offset in range(1, HUB_CHILDREN + 1):
        out.append(
            (
                entry_id(HUB_INDEX + offset),
                hub,
                _HUB_KINDS[offset % len(_HUB_KINDS)],
            )
        )
    # The 2-cycle, both directions, so a walk that does not remember where it
    # has been never terminates.
    out.append((entry_id(CYCLE_A_INDEX), entry_id(CYCLE_B_INDEX), "derived_from"))
    out.append((entry_id(CYCLE_B_INDEX), entry_id(CYCLE_A_INDEX), "derived_from"))
    return out


def _stem_rows() -> list[tuple]:
    now = time.time()
    rows: list[tuple] = []
    for n in range(SEPARATED_SONGS):
        parent = entry_id(n * 3)
        for name in _STEM_NAMES:
            rows.append(
                (
                    f"{parent}--{name}",
                    parent,
                    name,
                    str(Path("stems") / f"{name}.wav"),
                    1024,
                    "synthetic-separator",
                    "4-stem",
                    now,
                    1,
                )
            )
    return rows


def _midi_rows() -> list[tuple]:
    now = time.time()
    return [
        (
            f"{entry_id(n * 5)}--midi",
            entry_id(n * 5),
            "full",
            str(Path("midi") / "full.mid"),
            None,
            "synthetic-transcriber",
            "1.0",
            256,
            now,
            1,
        )
        for n in range(MIDI_SONGS)
    ]


def _score_rows() -> list[tuple]:
    now = time.time()
    return [
        (
            f"{entry_id(n * 9)}--score",
            entry_id(n * 9),
            "sheet",
            None,
            str(Path("scores") / "sheet.musicxml"),
            "synthetic-engraver",
            "1.0",
            "{}",
            now,
            1,
        )
        for n in range(SCORE_SONGS)
    ]


def _bulk_write(db: LibraryDB, sql: str, rows: list[tuple]) -> None:
    """One transaction for the child tables.

    ``add_stem`` / ``add_midi`` commit (and bump ``library_revision``) once per
    row, which is hundreds of transactions for the stems alone. This is
    fixture setup on a synthetic temp database, written the same way
    ``tests.lineagescale_fixtures._stamp_created_at`` writes its own.
    """
    if not rows:
        return
    conn = db._conn  # noqa: SLF001 - fixture setup, the convention db.py's tests use
    with db._writelock:  # noqa: SLF001 - fixture setup
        cur = conn.cursor()
        try:
            cur.executemany(sql, rows)
            conn.commit()
        finally:
            cur.close()


def _spread_created_at_and_plays(db: LibraryDB) -> None:
    """Distinct ``created_at`` per row, and a play count on every fifth.

    ``upsert_entries_bulk`` stamps one wall clock per batch, so thousands of
    rows share a timestamp and ``created_desc`` would be answered by the rowid
    tiebreak alone. A real library has one timestamp per song; a page of it is
    what the sort is measured on. ``play_count`` has no payload key -- the
    column is owned by ``increment_play_count`` -- so it is set here too, in
    the same pass.
    """
    base = 1_700_000_000.0
    rows = [
        (base + index, (index % 97) if index % 5 == 0 else 0, entry_id(index))
        for index in range(ENTRIES)
    ]
    _bulk_write(
        db,
        "UPDATE entries SET created_at = ?, play_count = ? WHERE id = ?",
        rows,
    )


def _write_disk_tree(root: Path) -> None:
    """``<root>/<id>/metadata.json`` for every entry.

    ``LibraryStore._dir_for`` stats this before any list route will emit a
    row, so a fixture without it measures an empty library through a full
    database. The payload is small on purpose: the fat blob lives in the
    column, which is the thing the queries must not read.
    """
    for index in range(ENTRIES):
        kind = _kind_for(index)
        entry_dir = root / entry_id(index)
        entry_dir.mkdir(parents=True, exist_ok=True)
        (entry_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "id": entry_id(index),
                    "kind": kind,
                    "title": f"fixture track {index:06d}",
                    "audio_filename": "audio.mp3" if kind == "audio" else "media.mp4",
                    "saved_at": 1_700_000_000.0 + index,
                }
            ),
            encoding="utf-8",
        )


def _materialise(root: Path, index: int) -> None:
    """Give one entry the files ``get_entry`` and the streaming routes need."""
    entry_dir = root / entry_id(index)
    kind = _kind_for(index)
    if kind == "audio":
        (entry_dir / "audio.mp3").write_bytes(_TINY_WAV)
        (entry_dir / "cover.jpg").write_bytes(_TINY_JPEG)
    else:
        (entry_dir / "media.mp4").write_bytes(_TINY_MP4)
        (entry_dir / "thumb.jpg").write_bytes(_TINY_JPEG)


def _first_media_index() -> int:
    return next(i for i in range(ENTRIES) if _kind_for(i) == "video")


def _rare_index() -> int:
    return next(i for i in range(ENTRIES) if _provider_for(i) == RARE_PROVIDER)


def build_scale_library(root: Path) -> ScaleLibrary:
    """Build the whole fixture under ``root`` and return it, measured.

    Anything that raises after :class:`LibraryDB` is open closes and deletes
    the database on the way out. It is the better part of 400 MB and a live
    sqlite handle by the time the rows are in, and a build that died halfway
    used to leave both behind for the rest of the session.
    """
    opened: list[LibraryDB] = []
    try:
        return _build_scale_library(root, opened)
    except BaseException:
        for db in opened:
            db.close()
        remove_database(root / "library.db")
        raise


def _build_scale_library(root: Path, opened: list[LibraryDB]) -> ScaleLibrary:
    """The build itself. ``opened`` collects the handle so the wrapper above
    can close it if any of this raises."""
    started = time.perf_counter()
    root.mkdir(parents=True, exist_ok=True)
    db_path = root / "library.db"
    # FTS stays ON: ``LibraryStore`` opens the database with the default, and
    # an index it finds empty is backfilled on open -- which would move the
    # cost of 20,000 padded rows into the first request instead of the build.
    db = LibraryDB(db_path)
    opened.append(db)
    pad = metadata_pad()

    written = db.upsert_entries_bulk(_payloads(pad), batch=2_000)
    if written != ENTRIES:
        raise AssertionError(f"wrote {written} entries, expected {ENTRIES}")
    db.add_relations_bulk(_edges())
    _spread_created_at_and_plays(db)
    _bulk_write(
        db,
        "INSERT OR REPLACE INTO stems (id, entry_id, stem_name, audio_path, "
        "file_size_bytes, model, model_variant, separated_at, version) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        _stem_rows(),
    )
    _bulk_write(
        db,
        "INSERT OR REPLACE INTO midis (id, entry_id, source, midi_path, source_ref, "
        "engine, engine_version, notes_count, converted_at, version) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        _midi_rows(),
    )
    _bulk_write(
        db,
        "INSERT OR REPLACE INTO notation_artifacts (id, entry_id, kind, source_ref, "
        "path, engine, engine_version, metadata_json, created_at, version) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        _score_rows(),
    )

    _write_disk_tree(root)
    media_index = _first_media_index()
    rare_index = _rare_index()
    for index in (0, HUB_INDEX, rare_index, media_index):
        _materialise(root, index)
    # The stem the audio route serves needs real bytes under the entry it
    # belongs to; the other stem rows are registrations only.
    stem_dir = root / entry_id(0) / "stems"
    stem_dir.mkdir(parents=True, exist_ok=True)
    (stem_dir / "vocals.wav").write_bytes(_TINY_WAV)
    _bulk_write(
        db,
        "UPDATE stems SET audio_path = ? WHERE id = ?",
        [(str(stem_dir / "vocals.wav"), f"{entry_id(0)}--vocals")],
    )

    conn = db._conn  # noqa: SLF001 - fixture measurement
    with db._writelock:  # noqa: SLF001 - fixture measurement
        relations = int(conn.execute("SELECT COUNT(*) FROM relations").fetchone()[0])
        blob_bytes = int(
            conn.execute("SELECT SUM(LENGTH(metadata_json)) FROM entries").fetchone()[0]
        )
        stems = int(conn.execute("SELECT COUNT(*) FROM stems").fetchone()[0])
        midis = int(conn.execute("SELECT COUNT(*) FROM midis").fetchone()[0])
        scores = int(
            conn.execute("SELECT COUNT(*) FROM notation_artifacts").fetchone()[0]
        )

    db_bytes = database_bytes(db_path)
    return ScaleLibrary(
        root=root,
        db_path=db_path,
        db=db,
        entries=ENTRIES,
        relations=relations,
        stems=stems,
        midis=midis,
        scores=scores,
        blob_bytes=blob_bytes,
        db_bytes=db_bytes,
        build_seconds=time.perf_counter() - started,
        common_id=entry_id(0),
        hub_id=entry_id(HUB_INDEX),
        rare_id=entry_id(rare_index),
        stem_id=f"{entry_id(0)}--vocals",
        media_id=entry_id(media_index),
    )


def database_bytes(db_path: Path) -> int:
    """The database plus its sidecars, as it stands on disk right now."""
    return sum(
        path.stat().st_size
        for path in (db_path, Path(f"{db_path}-wal"), Path(f"{db_path}-shm"))
        if path.exists()
    )


def remove_database(db_path: Path) -> None:
    """Delete the database and its sidecars.

    It is the better part of a couple of hundred megabytes, so it never waits
    for whoever remembers to clear the basetemp.
    """
    for suffix in ("", "-wal", "-shm"):
        Path(f"{db_path}{suffix}").unlink(missing_ok=True)


#: The landmark ids, as pure functions of the constants above, so a test can
#: parametrise over them at collection time -- before any fixture has run.
COMMON_ID = entry_id(0)
HUB_ID = entry_id(HUB_INDEX)
RARE_ID = entry_id(_rare_index())
MEDIA_ID = entry_id(_first_media_index())
STEM_ID = f"{entry_id(0)}--vocals"


__all__ = [
    "COMMON_ID",
    "ENTRIES",
    "HUB_CHILDREN",
    "HUB_ID",
    "HUB_INDEX",
    "MEDIA_ID",
    "METADATA_PAD_BYTES",
    "RARE_ID",
    "RARE_PROVIDER",
    "SEARCH_WORD",
    "STANDALONE",
    "STEM_ID",
    "ScaleLibrary",
    "build_scale_library",
    "database_bytes",
    "entry_id",
    "remove_database",
]
