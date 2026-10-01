"""SQLite-backed query layer for the library.

The filesystem layout under ``data/generations/<entry_id>/`` remains the
durable source of truth (each entry's ``metadata.json`` survives any DB
corruption). SQLite is a query accelerator + the home for the richer
data we accumulate as features land:

  - ``entries``       core record, mirrors metadata.json
  - ``analysis``      bpm / key / pitch / genre / loudness etc.
  - ``stems``         separated stems linked to a parent entry
  - ``midis``         MIDI conversions (from full track or per-stem)
  - ``relations``     directed edges for lineage / chimera-sources /
                      inits / inpaint / stems-of / midi-of / derived-from
  - ``tag_index``     denormalized many-to-many (entry_id, tag) for fast filters
  - ``prompt_corpus`` (entry_id, prompt_kind, prompt_text) for LoRA labelling
  - ``schema_meta``   key/value store for the schema version, first-init time,
                      and ``library_revision`` (one bump per committed write)

Edge tables are designed so a future export to a real graph DB (kuzudb /
oxigraph) is a ~30-line script.

Zero external deps — stdlib ``sqlite3`` only. JSON1 is compiled into
CPython's bundled SQLite; a Python linked against a system SQLite built
without it gets the two functions this module uses from ``_ensure_json1``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import sqlite3
import sys
import threading
import time
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Optional, Sequence

from backend.lib.stamps import IncreasingClock

from .provider import PROVIDER_SLUG_MAX, detect_provider

log = logging.getLogger(__name__)

# ---- JSON1 -----------------------------------------------------------------
# json_valid / json_extract are a compile-time SQLite feature. The probe below
# asks the linked SQLite once per connection; a build without JSON1 gets the
# same two functions from Python, so every library query answers either way.

_JSON_PATH_STEP = re.compile(r'\.(?:"([^"]+)"|([^.\[\]]+))|\[(\d+)\]')


def _py_json_valid(text: Any) -> Optional[int]:
    if text is None:
        return None
    try:
        json.loads(text)
    except (TypeError, ValueError):
        return 0
    return 1


def _py_json_extract(text: Any, path: Any) -> Any:
    """``json_extract`` for one ``$.key[0].key`` path, with SQLite's result
    types: text, number, 1/0 for a boolean, JSON text for a container, NULL
    for JSON null, a missing path or unreadable JSON."""
    if text is None or not isinstance(path, str) or not path.startswith("$"):
        return None
    try:
        node = json.loads(text)
    except (TypeError, ValueError):
        return None
    pos = 1
    for step in _JSON_PATH_STEP.finditer(path, 1):
        if step.start() != pos:
            return None
        pos = step.end()
        key = step.group(1) or step.group(2)
        if key is not None:
            if not isinstance(node, dict) or key not in node:
                return None
            node = node[key]
        else:
            index = int(step.group(3))
            if not isinstance(node, list) or index >= len(node):
                return None
            node = node[index]
    if pos != len(path):
        return None
    if isinstance(node, bool):
        return int(node)
    if isinstance(node, (dict, list)):
        return json.dumps(node, separators=(",", ":"))
    return node


def _ensure_json1(conn: sqlite3.Connection) -> bool:
    """True when the linked SQLite has JSON1. When it does not, register
    Python ``json_valid`` and ``json_extract`` on ``conn`` (deterministic, so
    expression indexes accept them) and return False."""
    try:
        conn.execute(
            "SELECT json_valid('{}'), json_extract('{\"a\":1}', '$.a')"
        ).fetchone()
        return True
    except sqlite3.OperationalError as e:
        conn.create_function("json_valid", 1, _py_json_valid, deterministic=True)
        conn.create_function("json_extract", 2, _py_json_extract, deterministic=True)
        log.warning(
            "library.db: this SQLite build has no JSON1 (%s); json_valid and "
            "json_extract run in Python",
            e,
        )
        return False


SCHEMA_VERSION = 13

#: How long a statement waits for another connection's write lock before it
#: gives up with "database is locked". Python's sqlite3 default is 5 s;
#: :meth:`LibraryDB._migrate` describes index builds that take "seconds to
#: minutes", so 5 s turned a slow-but-fine open into an unopenable library.
#: Bounded on purpose: a true deadlock must still fail rather than hang.
BUSY_TIMEOUT_MS = 30_000


# Each tuple is (schema_version_after_running, statements list).
# Add new migration tuples as the schema evolves; never edit a shipped one.
_MIGRATIONS: list[tuple[int, list[str]]] = [
    (
        1,
        [
            """
            CREATE TABLE IF NOT EXISTS entries (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL DEFAULT 'audio',
                title TEXT NOT NULL DEFAULT '',
                prompt TEXT NOT NULL DEFAULT '',
                negative_prompt TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL DEFAULT '',
                duration_sec REAL NOT NULL DEFAULT 0,
                steps INTEGER NOT NULL DEFAULT 0,
                cfg REAL NOT NULL DEFAULT 0,
                seed INTEGER NOT NULL DEFAULT 0,
                mime TEXT NOT NULL DEFAULT 'audio/wav',
                audio_filename TEXT NOT NULL DEFAULT '',
                file_size_bytes INTEGER NOT NULL DEFAULT 0,
                source TEXT NOT NULL DEFAULT 'generate',
                favorite INTEGER NOT NULL DEFAULT 0,
                rating TEXT,
                notes TEXT NOT NULL DEFAULT '',
                timestamp TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                analysis_status TEXT NOT NULL DEFAULT 'pending',
                stems_status TEXT NOT NULL DEFAULT 'pending',
                midi_status TEXT NOT NULL DEFAULT 'pending',
                metadata_json TEXT NOT NULL DEFAULT '{}'
            )
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_entries_created_at
                ON entries(created_at DESC)
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_entries_source
                ON entries(source)
            """,
            """
            CREATE TABLE IF NOT EXISTS analysis (
                entry_id TEXT PRIMARY KEY,
                bpm REAL,
                beats_json TEXT,
                key TEXT,
                key_confidence REAL,
                scale TEXT,
                pitch_mean_hz REAL,
                pitch_std_hz REAL,
                loudness_lufs REAL,
                rms_db REAL,
                bars_estimated REAL,
                genre TEXT,
                genre_confidence REAL,
                embedded_tags_json TEXT,
                ffprobe_json TEXT,
                analyzed_at REAL,
                version INTEGER NOT NULL DEFAULT 1,
                FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS stems (
                id TEXT PRIMARY KEY,
                entry_id TEXT NOT NULL,
                stem_name TEXT NOT NULL,
                audio_path TEXT NOT NULL,
                file_size_bytes INTEGER NOT NULL DEFAULT 0,
                model TEXT,
                model_variant TEXT,
                separated_at REAL,
                version INTEGER NOT NULL DEFAULT 1,
                FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
            )
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_stems_entry_id
                ON stems(entry_id)
            """,
            """
            CREATE TABLE IF NOT EXISTS midis (
                id TEXT PRIMARY KEY,
                entry_id TEXT NOT NULL,
                source TEXT NOT NULL,            -- 'full' | 'stem'
                source_ref TEXT,                 -- stem_id if source='stem'
                midi_path TEXT NOT NULL,
                engine TEXT NOT NULL DEFAULT '',
                engine_version TEXT NOT NULL DEFAULT '',
                notes_count INTEGER NOT NULL DEFAULT 0,
                converted_at REAL,
                version INTEGER NOT NULL DEFAULT 1,
                FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
            )
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_midis_entry_id
                ON midis(entry_id)
            """,
            """
            CREATE TABLE IF NOT EXISTS relations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_id TEXT NOT NULL,
                to_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                weight REAL NOT NULL DEFAULT 1.0,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at REAL NOT NULL,
                UNIQUE (from_id, to_id, kind)
            )
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_id)
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_id)
            """,
            """
            CREATE TABLE IF NOT EXISTS tag_index (
                entry_id TEXT NOT NULL,
                tag TEXT NOT NULL,
                PRIMARY KEY (entry_id, tag),
                FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
            )
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_tag_index_tag ON tag_index(tag)
            """,
            """
            CREATE TABLE IF NOT EXISTS prompt_corpus (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_id TEXT NOT NULL,
                prompt_kind TEXT NOT NULL,       -- 'positive' | 'negative' | 'embedded' | 'user'
                prompt_text TEXT NOT NULL,
                FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
            )
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_prompt_corpus_entry
                ON prompt_corpus(entry_id)
            """,
            """
            CREATE TABLE IF NOT EXISTS schema_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """,
        ],
    ),
    (
        2,
        [
            """
            CREATE TABLE IF NOT EXISTS notation_artifacts (
                id TEXT PRIMARY KEY,
                entry_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                source_ref TEXT,
                path TEXT NOT NULL,
                engine TEXT NOT NULL DEFAULT '',
                engine_version TEXT NOT NULL DEFAULT '',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at REAL NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,
                FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
            )
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_notation_artifacts_entry_id
                ON notation_artifacts(entry_id)
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_notation_artifacts_kind
                ON notation_artifacts(kind)
            """,
        ],
    ),
    (
        3,
        [
            "ALTER TABLE analysis ADD COLUMN prompt_guess TEXT",
            "ALTER TABLE analysis ADD COLUMN prompt_confidence REAL",
            "ALTER TABLE analysis ADD COLUMN semantic_tags_json TEXT NOT NULL DEFAULT '[]'",
        ],
    ),
    (
        4,
        [
            "ALTER TABLE entries ADD COLUMN play_count INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE entries ADD COLUMN last_played_at REAL",
            "CREATE INDEX IF NOT EXISTS idx_entries_play_count ON entries(play_count DESC)",
        ],
    ),
    (
        5,
        [
            # Stems and MIDI become first-class library items: they can be
            # favorited just like parent tracks. Default 0 keeps existing
            # rows unflagged.
            "ALTER TABLE stems ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE midis ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0",
        ],
    ),
    (
        6,
        [
            # The Shard Index (docs/design/loom.md): bar/beat-aligned fragments
            # of every source (stem or mix) with the descriptors LOOM, the DJ
            # pads and PERFORM query. Rows are rebuilt per entry by
            # backend.modules.shards.extract; the filesystem stays the truth
            # for audio, the row only says WHERE to cut.
            """
            CREATE TABLE IF NOT EXISTS shards (
                id TEXT PRIMARY KEY,
                entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                stem_name TEXT NOT NULL,
                role TEXT NOT NULL,
                start_sec REAL NOT NULL,
                end_sec REAL NOT NULL,
                beats INTEGER NOT NULL,
                bar_index INTEGER NOT NULL,
                bpm REAL NOT NULL,
                key TEXT NOT NULL DEFAULT '',
                scale TEXT NOT NULL DEFAULT '',
                camelot TEXT NOT NULL DEFAULT '',
                pc_root INTEGER NOT NULL DEFAULT -1,
                rms_db REAL NOT NULL DEFAULT -90,
                low_frac REAL NOT NULL DEFAULT 0,
                onset_density REAL NOT NULL DEFAULT 0,
                centroid_hz REAL NOT NULL DEFAULT 0,
                onset_mask INTEGER NOT NULL DEFAULT 0,
                energy REAL NOT NULL DEFAULT 0,
                section TEXT NOT NULL DEFAULT '',
                chord TEXT NOT NULL DEFAULT '',
                words TEXT NOT NULL DEFAULT '',
                chroma_json TEXT NOT NULL DEFAULT '[]',
                mfcc_json TEXT NOT NULL DEFAULT '[]',
                version INTEGER NOT NULL DEFAULT 1
            )
            """,
            "CREATE INDEX IF NOT EXISTS idx_shards_entry ON shards(entry_id)",
            "CREATE INDEX IF NOT EXISTS idx_shards_role_beats ON shards(role, beats)",
            "CREATE INDEX IF NOT EXISTS idx_shards_camelot ON shards(camelot)",
            # Kept pairings: the user's taste memory for the complement ranking.
            """
            CREATE TABLE IF NOT EXISTS shard_pairings (
                a_id TEXT NOT NULL,
                b_id TEXT NOT NULL,
                weight REAL NOT NULL DEFAULT 1,
                kept_at REAL NOT NULL,
                PRIMARY KEY (a_id, b_id)
            )
            """,
        ],
    ),
    (
        7,
        [
            # A library of ~200,000 imported songs. Every one of these backs a
            # filter or a sort offered by ``list_entries_page``; without them a
            # deep page is a full table sort, which is the whole problem.
            #
            # Each index ends (implicitly) with the rowid, so the ORDER BY
            # clauses in ``_SORT_SQL`` -- which all end in ``e.rowid`` in the
            # direction the index is scanned -- are answered by an index walk
            # with no temp b-tree. That is what makes OFFSET 150000 cheap:
            # SQLite skips rows before materializing their columns.
            "CREATE INDEX IF NOT EXISTS idx_entries_kind ON entries(kind)",
            "CREATE INDEX IF NOT EXISTS idx_entries_favorite ON entries(favorite)",
            "CREATE INDEX IF NOT EXISTS idx_entries_title ON entries(title COLLATE NOCASE)",
            # Not named in the ticket but required by it: `duration_desc` /
            # `duration_asc` are offered sorts and are the only two with no
            # index, so a deep page on them would sort the whole table.
            "CREATE INDEX IF NOT EXISTS idx_entries_duration ON entries(duration_sec)",
            # The library list always filters on `kind` (the tab strip), so the
            # sort indexes above would still need a table lookup per skipped
            # row. Leading with `kind` keeps the OFFSET walk inside the index.
            "CREATE INDEX IF NOT EXISTS idx_entries_kind_created ON entries(kind, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_entries_kind_title ON entries(kind, title COLLATE NOCASE)",
            "CREATE INDEX IF NOT EXISTS idx_entries_kind_plays ON entries(kind, play_count DESC)",
            "CREATE INDEX IF NOT EXISTS idx_entries_kind_duration ON entries(kind, duration_sec)",
        ],
    ),
    (
        8,
        [
            # Facet counts (the model / provider / source dropdowns). Every
            # facet column AND every filter column the listing accepts lives in
            # these two indexes, so each facet query is a COVERING index scan:
            # no table lookup per row, which is the difference between 14 ms and
            # 260 ms at 200,000 rows.
            #
            # Column order is what removes the temp b-tree as well: with
            # ``kind`` equality-constrained (every tab but "all"), the rows
            # arrive already grouped by ``model`` -- and by ``(model, source)``,
            # which is what the derived `provider` facet groups on. `favorite`
            # rides along last purely so it can be tested from the index.
            #
            # Measured at 200,000 rows (see tests/test_library_facets.py):
            # worst facet query 65 ms with these, 170 ms without, and the
            # `kind + favorite` combination regressed to 260 ms under the
            # obvious (kind, model) index because it stopped being covering.
            #
            # No new COLUMN and no backfill: model / source / kind are already
            # columns, and `provider` is derived from (model, source) rather
            # than stored -- see :func:`infer_provider`.
            "CREATE INDEX IF NOT EXISTS idx_entries_facet_model "
            "ON entries(kind, model, source, favorite)",
            "CREATE INDEX IF NOT EXISTS idx_entries_facet_source "
            "ON entries(kind, source, favorite)",
        ],
    ),
]


# ---- Search index ----------------------------------------------------------
#
# What a library search matches is what the client-side matcher on main
# matched (``getFiltered`` in frontend/src/state/libraryStore.ts at 851f6a0,
# kept as ``applyClientQuery`` for an unpaged backend): a case-insensitive
# SUBSTRING over title, prompt, negative prompt, model, notes, source, MIME
# type, rating, tags, chimera sources, every analysis value (BPM and key
# included), every embedded file tag (artist, album, ...), and -- for a
# numeric query -- the duration in seconds or minutes. On top of that it
# matches the lyrics and the provider's slug and label.
#
# The text lives in two PLAIN tables that only this module writes:
#
#   ``entries_search_head``  the short values (<= SEARCH_SHORT_VALUE_MAX
#                            characters, plus the title and the tags always),
#                            one row per entry;
#   ``entries_search_body``  the long values (lyrics, a Suno prompt that holds
#                            the lyrics, long notes), only for entries that
#                            have one.
#
# ``entries_search`` is an fts5 TRIGRAM index over both, with the view
# ``entries_search_text`` as its external content. A trigram index answers a
# substring query of three or more characters from the index, so "shine"
# finds "sunshine" and "120" finds a 120.0 BPM without reading a row.
#
# A trigram index cannot answer a word of one or two characters, so a second
# fts5 index, ``entries_search_short``, answers those: it holds, per entry,
# every distinct character and every distinct pair of adjacent characters of
# the head and body text (:func:`short_grams`), each spelled as one plain
# ASCII token. "4k" is then one term lookup, wherever in the entry it occurs
# -- a title, a tag, or the middle of a 3,000-character prompt. It is
# contentless; its rows are removed with the grams recomputed from
# ``entries_search_text``, the same exact-delete rule as the trigram index.
#
# Keeping the indexed text in tables this module owns is what makes the index
# impossible to corrupt from outside. An fts5 row can only be removed by
# handing back the values it was indexed with, and those are read out of
# ``entries_search_text`` -- never re-derived from ``entries``, which an older
# build rewrites without knowing the index exists. The head/body rows and the
# fts5 rows are always written together in one transaction, so the view
# always holds exactly what the index holds.
#
# Nothing that writes ``entries`` has to know any of this. Triggers on
# ``entries``, ``tag_index`` and ``analysis`` put the touched rowid into
# ``search_dirty``, and :meth:`LibraryDB._txn` re-indexes those rows before it
# commits. The triggers are part of the database file, so they also fire for
# a build that predates the index -- main's schema-6 code writes rows and the
# rowids wait in ``search_dirty`` until this build next opens the file.

#: How many characters a value may have and still be kept in
#: ``entries_search_head``. Longer values go to ``entries_search_body``. Both
#: are searched for every word, whatever its length; the split keeps the
#: head, which the title lookups read, small.
SEARCH_SHORT_VALUE_MAX = 200

#: The version of what :func:`search_text` and :func:`short_grams` index.
#: Bump it when either changes: the next open rebuilds the index from
#: scratch.
SEARCH_TEXT_VERSION = 3

#: ``schema_meta`` key holding the highest ``entries.rowid`` an in-progress
#: (re)build of the search index has durably indexed. Written in the same
#: commit as the batch it covers, so a build interrupted by a crash or a kill
#: resumes from that row instead of starting again from the top.
FTS_BACKFILL_ROWID_KEY = "fts_backfill_rowid"

#: ``schema_meta`` key naming the index a finished build produced, e.g.
#: ``v1:fts``. Anything else -- absent, another text version, or ``plain``
#: when this SQLite has fts5 -- means the index has to be (re)built.
SEARCH_STATE_KEY = "search_index"

#: ``schema_meta`` key naming the index an in-progress build is producing.
#: The cursor in :data:`FTS_BACKFILL_ROWID_KEY` belongs to this target only.
SEARCH_TARGET_KEY = "search_index_target"

#: The contentless fts5 table the first paged-library build kept, and its
#: done flag. Both are removed the first time this build opens the file: that
#: build maintained the table only from its own writes, so it goes stale under
#: every other writer, and without the flag that build rebuilds the table from
#: scratch if it is ever run against this file again.
LEGACY_FTS_TABLE = "entries_fts"
LEGACY_FTS_BACKFILL_KEY = "fts_backfill"

#: The most rows indexed per commit while the index is (re)built. A batch is
#: usually smaller: its size follows :data:`SEARCH_BATCH_TARGET_SEC`.
SEARCH_BACKFILL_BATCH = 2000

#: ``schema_meta`` key present while the store reads every ``metadata.json``
#: into a database that had none of them (a first start, or a lost or deleted
#: ``library.db`` beside a full library). Written before the read starts and
#: removed after its last batch, so a read cut short by a close or a crash
#: runs again on the next start instead of leaving the library half listed:
#: without it the next start saw a non-empty database and never read the rest.
DISK_READ_PENDING_KEY = "disk_read_pending"

#: The name of the thread a background build of the index runs on.
SEARCH_BUILD_THREAD = "library-search-build"

#: The rowids ``search_dirty`` lists, each once (the table holds repeats; see
#: migration step 13).
_DIRTY_ROWIDS_SQL = "SELECT DISTINCT rid FROM search_dirty WHERE rid IS NOT NULL"

_SEARCH_FTS_SQL = """
    CREATE VIRTUAL TABLE IF NOT EXISTS entries_search USING fts5(
        head, body,
        content='entries_search_text', content_rowid='rid',
        tokenize='trigram case_sensitive 0'
    )
"""

#: The one- and two-character index (see "Search index"). ``detail=none``
#: keeps only which rows hold a term, which is all a word match needs, and
#: the ``ascii`` tokenizer reads each gram token back exactly as written.
_SEARCH_SHORT_FTS_SQL = """
    CREATE VIRTUAL TABLE IF NOT EXISTS entries_search_short USING fts5(
        grams, content='', detail='none', columnsize=0, tokenize='ascii'
    )
"""

#: Words shorter than this are answered by ``entries_search_short``; the
#: rest by the trigram index.
SHORT_WORD_MAX = 2

#: The ``analysis`` columns a library entry carries as ``entry.analysis``
#: (``router._analysis_payload``), and so the ones main's matcher searched.
ANALYSIS_SCALAR_KEYS = (
    "bpm",
    # The tempo detector's own confidence in ``bpm``, 0..1 (clamped where it
    # is measured). Without it only GET /api/analysis/{id} carried the number
    # and every list-driven surface saw a BPM with no confidence behind it.
    "bpm_confidence",
    "key",
    "key_confidence",
    "scale",
    "pitch_mean_hz",
    "pitch_std_hz",
    "loudness_lufs",
    "rms_db",
    "bars_estimated",
    "genre",
    "genre_confidence",
    "prompt_guess",
    "prompt_confidence",
    "analyzed_at",
)

#: The ffprobe ``_summary`` keys an entry carries in ``entry.analysis``.
FFPROBE_SUMMARY_KEYS = (
    "sample_rate",
    "channels",
    "bit_depth",
    "bit_depth_is_float",
    "sample_fmt",
    "codec",
    "container",
    "duration_sec",
)

#: Where the analysis engine records which profile wrote a row
#: (``backend.modules.analysis.engine.PROFILE_MARKER_KEY``; that module
#: imports this one, so the name is repeated here and a test pins the two).
ANALYSIS_PROFILE_MARKER_KEY = "_analysis_profile"


#: Letters and digits only (underscore excluded). Everything a user can type
#: that fts5 would read as an operator -- quotes, ``*``, ``^``, ``NEAR()``,
#: ``:`` -- is dropped here rather than escaped later, so a search string is
#: never a query expression.
_TOKEN_RE = re.compile(r"[^\W_]+", re.UNICODE)

#: Bounds the cost of a pathological query string.
MAX_SEARCH_TOKENS = 16


def search_tokens(q: Optional[str]) -> list[str]:
    """The runs of letters and digits in ``q``, lowercased. The lineage
    explorer's sanitiser; library search matches :func:`search_words`."""
    return [t.lower() for t in _TOKEN_RE.findall(q or "")][:MAX_SEARCH_TOKENS]


def search_words(q: Optional[str]) -> list[str]:
    """The words of a library search: ``q`` split at whitespace, lowercased,
    punctuation kept. Each word must occur, as written, in an entry's search
    text for the entry to match -- so "f#" finds the key F# and not every
    entry with an "f" in it, as main's substring test did. Every word is bound
    as a parameter, and handed to fts5 only as a quoted string literal, so no
    search string is ever read as a query expression."""
    return [w.lower() for w in (q or "").split()][:MAX_SEARCH_TOKENS]


def _gram_token(gram: str) -> str:
    """One gram (a character, or two adjacent ones) as the ASCII token
    ``entries_search_short`` stores: ``u`` and the code point in hex for one
    character, ``b``, the first code point, ``g`` and the second for two.
    Letters and digits only, so the ``ascii`` tokenizer keeps it whole."""
    if len(gram) == 1:
        return f"u{ord(gram):x}"
    return f"b{ord(gram[0]):x}g{ord(gram[1]):x}"


def short_grams(head: str, body: str) -> str:
    """Every distinct character and pair of adjacent characters in the words
    of ``head`` and ``body``, as space-separated :func:`_gram_token` tokens in
    a fixed order. A search word never holds whitespace, so pairs that span a
    space or a newline are left out. Deterministic: the index removes a row
    by being handed this exact text again."""
    grams: set[str] = set()
    for text in (head, body):
        for word in text.split():
            grams.update(word)
            grams.update([word[i : i + 2] for i in range(len(word) - 1)])
    cache = _GRAM_TOKENS
    if len(cache) > _GRAM_TOKENS_MAX:
        cache.clear()
    tokens: list[str] = []
    for gram in grams:
        token = cache.get(gram)
        if token is None:
            token = cache[gram] = _gram_token(gram)
        tokens.append(token)
    tokens.sort()
    return " ".join(tokens)


#: :func:`_gram_token` answers, remembered: the same few thousand grams make
#: up nearly every entry, and an index build spells each one per entry.
_GRAM_TOKENS: dict[str, str] = {}
_GRAM_TOKENS_MAX = 200_000


def _fts_phrase(text: str) -> str:
    """``text`` as one fts5 string literal. Under the trigram tokenizer a
    string literal matches wherever the text occurs, inside a word or not."""
    return '"' + text.replace('"', '""') + '"'


#: JavaScript's ``parseFloat``: the longest numeric prefix of a trimmed
#: string.
_JS_FLOAT_RE = re.compile(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?")


def js_parse_float(text: str) -> Optional[float]:
    """What ``parseFloat(text)`` returns in a browser, or None for NaN.

    Main's matcher treated any query ``parseFloat`` could read -- "120",
    "120 bpm", "5min", "3:30" -- as a duration as well as text, and this is
    the same reading. ``parseFloat`` also reads ``Infinity``, which matches no
    duration, so it is None here.
    """
    match = _JS_FLOAT_RE.match(text)
    if not match:
        return None
    value = float(match.group(0))
    return value if math.isfinite(value) else None


def js_round(value: float) -> int:
    """JavaScript's ``Math.round``: halves round towards +infinity."""
    return math.floor(value + 0.5)


def _js_float_text(value: float) -> str:
    """``String(value)`` for a finite JavaScript number: ``120`` rather than
    Python's ``120.0``; other values already agree (shortest round trip)."""
    return str(int(value)) if value.is_integer() else repr(value)


def _search_values(value: Any) -> Iterator[str]:
    """Every searchable text inside one stored value, spelled the way main's
    matcher saw it (``String(v)`` in JavaScript). A list gives its elements;
    a mapping gives its values, which is what a person searching a nested tag
    means (JavaScript would have indexed ``[object Object]``)."""
    if value is None:
        return
    if isinstance(value, bool):
        yield "true" if value else "false"
    elif isinstance(value, int):
        yield str(value)
    elif isinstance(value, float):
        if math.isfinite(value):
            yield _js_float_text(value)
    elif isinstance(value, str):
        yield value
    elif isinstance(value, Mapping):
        for item in value.values():
            yield from _search_values(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _search_values(item)
    else:
        yield str(value)


def _loose_json_value(text: Any) -> Any:
    """A stored JSON column decoded, or None when it is absent or broken."""
    if not isinstance(text, str) or not text:
        return None
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def search_text(row: Mapping[str, Any]) -> tuple[str, str]:
    """``(head, body)``: the text one entry is found by, from one row of
    :func:`_search_rows_sql`. Both are lowercased, so every word, whatever
    its length, matches case-insensitively in every script.

    Short values go to the head and long ones to the body (see
    :data:`SEARCH_SHORT_VALUE_MAX`); the title and the tags are always head,
    which is what the title lookups read. Values are
    newline-separated, and no token or query spans a newline, so a match can
    never straddle two fields.
    """
    head: dict[str, None] = {}
    body: dict[str, None] = {}

    def put(value: Any, *, always_head: bool = False) -> None:
        for text in _search_values(value):
            text = " ".join(text.split())
            if not text:
                continue
            short = always_head or len(text) <= SEARCH_SHORT_VALUE_MAX
            (head if short else body)[text] = None

    put(row["title"], always_head=True)
    for tag in str(row["tags"] or "").split("\n"):
        put(tag, always_head=True)
    for column in (
        "prompt",
        "negative_prompt",
        "model",
        "notes",
        "source",
        "mime",
        "m_mime",
        "rating",
    ):
        put(row[column])
    slug = row["provider_slug"]
    put(slug)
    put(row["m_provider_label"])
    if slug in DERIVED_PROVIDERS:
        put(DERIVED_PROVIDERS[slug][0])
    lyrics = row["m_lyrics"]
    # A Suno entry's prompt frame IS its lyrics (provider.py copies one into
    # the other), so the same text is indexed once.
    if isinstance(lyrics, str) and lyrics.strip() != str(row["prompt"] or "").strip():
        put(lyrics)
    put(_loose_json_value(row["m_chimera"]))
    if row["analyzed"]:
        for key in ANALYSIS_SCALAR_KEYS:
            put(row[key])
        bpm = row["bpm"]
        if isinstance(bpm, (int, float)) and math.isfinite(bpm) and bpm > 0:
            # "120 bpm" -- what main's own comment promised a search could say.
            put(f"{js_round(float(bpm))} bpm")
        put(_loose_json_value(row["semantic_tags_json"]))
        summary = _loose_json_value(row["ff_summary"])
        if isinstance(summary, Mapping):
            for key in FFPROBE_SUMMARY_KEYS:
                put(summary.get(key))
        profile = row["ff_profile"]
        put(profile if profile in ("full", "dj") else "full")
        put(_loose_json_value(row["embedded_tags_json"]))
    return "\n".join(head).lower(), "\n".join(body).lower()


#: JavaScript ``foldTitle`` in frontend/src/state/shardIndexStore.ts.
_FOLD_EXTENSION_RE = re.compile(r"\.[a-z0-9]{2,4}\Z")
_FOLD_SEPARATORS_RE = re.compile(r"[\s_\-–—.]+")


def fold_title(text: str) -> str:
    """A title as LOOM compares it: lowercased, a file extension dropped,
    every run of spaces, underscores, dashes and dots one space."""
    lowered = _FOLD_EXTENSION_RE.sub("", (text or "").lower())
    return _FOLD_SEPARATORS_RE.sub(" ", lowered).strip()


@dataclass(frozen=True)
class EntryFilters:
    """What narrows a library listing. ``kinds=None`` means every kind (the
    ``?kind=all`` tab); an empty set matches nothing. ``q`` is free text, not a
    query language.

    ``source`` and ``provider`` are different axes and both may be set:
    ``source`` is the generate / studio / import column, ``provider`` is the
    origin slug :data:`PROVIDER_SQL` resolves for every entry."""

    kinds: Optional[frozenset[str]] = None
    favorite: Optional[bool] = None
    source: Optional[str] = None
    provider: Optional[str] = None
    q: Optional[str] = None


#: ORDER BY per sort key. Every clause ends with ``e.rowid`` in the direction
#: the backing index is scanned (SQLite appends the rowid ascending to every
#: index key), so the whole ordering is answered by an index walk -- no temp
#: b-tree -- and a deep OFFSET costs index steps, not row reads. The rowid also
#: makes the order total, so consecutive pages never overlap or skip a row.
_SORT_SQL: dict[str, str] = {
    "created_desc": "e.created_at DESC, e.rowid ASC",
    "created_asc": "e.created_at ASC, e.rowid DESC",
    "title_asc": "e.title COLLATE NOCASE ASC, e.rowid ASC",
    "title_desc": "e.title COLLATE NOCASE DESC, e.rowid DESC",
    "plays_desc": "e.play_count DESC, e.rowid ASC",
    "duration_desc": "e.duration_sec DESC, e.rowid DESC",
    "duration_asc": "e.duration_sec ASC, e.rowid ASC",
    # The EDIT library picker's "Favorites first" order: starred rows, then
    # the rest, each by name. Walked from idx_entries_kind_fav_title (step 13).
    "favorites_first": "e.favorite DESC, e.title COLLATE NOCASE ASC, e.rowid ASC",
}

#: The sort keys the API accepts, in the order they are documented.
SORTS: tuple[str, ...] = tuple(_SORT_SQL)

DEFAULT_SORT = "created_desc"


# ---- Provider ---------------------------------------------------------------
#
# Which service an entry came from. ONE rule, resolved in TWO stages so the
# half of it that needs an entry's metadata is paid once per ENTRY instead of
# once per query:
#
#   1. the resolved ``entries.provider`` COLUMN -- everything only an entry's
#      metadata knows: a stored ``$.provider`` (written at import, by the
#      read-path write-through, or by a user edit) and the legacy Suno markers
#      (``$.suno_id``, a ``suno`` / ``sunoid:<id>`` tag). Every writer fills it
#      from the metadata dict it is already holding, through
#      :func:`resolved_provider_slug`. NULL means "not resolved yet": either
#      nothing in this row's metadata named a provider, or the row predates the
#      column and no request has returned it since.
#   2. failing that, :data:`PROVIDER_FALLBACK_SQL` over the indexed columns:
#        'suno' in ``source`` or ``model``       -> suno
#        'magenta' / 'gemini' in ``model``       -> gemini-magenta
#        'udio' in ``model`` minus the word      -> udio
#        'audio' (see _PROVIDER_BY_MODEL_SUBSTRING)
#        'riffusion' in ``model``                -> riffusion
#        ``source`` of 'import'                  -> import
#        ``source`` of 'generate' / 'studio'     -> stable-audio
#        otherwise                               -> thedaw
#
#      The last arm is ``thedaw`` and not ``stable-audio``. Only 'generate' is
#      a Stable Audio generation -- and 'studio', which is a bounce of one, so
#      it keeps that slug. Everything ELSE theDAW makes reached the old
#      ``ELSE 'stable-audio'`` and was badged "Stable Audio (AI)": measured on
#      the user's library, 25 ``source='performance-set'`` DJ sets, 14
#      ``source='vj'`` stills and 6 VJ clips. They were made IN theDAW, not
#      generated by a model, and ``thedaw`` is not an AI provider.
#
# The fallback is ``inferProvider`` in frontend/src/catalog/catalogProviders.ts,
# which is what every catalogue row, badge and dropdown has always shown, and
# :func:`infer_provider` is its Python twin. Its last arm always answers, so
# every entry has a provider and the facet -- unlike ``model`` -- never has an
# "unset" bucket.
#
# :data:`PROVIDER_SQL` is ``COALESCE`` of the two and is what the list filter,
# its count, the id list AND the provider facet all group or compare on, so
# those four can never file one row under different slugs. The facet's
# documented divergence from the filter is gone with them.
#
# WHY THE COLUMN. Stage 1 used to be ``json_extract(metadata_json, '$.provider')``
# behind an ``instr`` prefilter. Evaluating that for a filtered list or count
# means SQLite READS every row's ``metadata_json``, and the user's real rows
# carry their provider's own record at ~34 KB each: 194,508 of them is ~6.6 GB
# of text per filtered page. Measured on that library,
# ``GET /entries?provider=suno&limit=200`` took 13.3 s where an unfiltered page
# took 0.10 s. Nothing below opens ``metadata_json``, an audio file or an
# analysis blob.

#: ``(word removed from the model first, substring, provider id)``, in priority
#: order.
#:
#: The removal exists for exactly one arm. "udio" is a substring of "audio", so
#: a bare test files every model whose name contains "audio" --
#: ``stable-audio-3-medium``, ``audiocraft`` -- under Udio, labels it "Udio" in
#: the catalogue, and counts it there in the facet. Deleting the word "audio"
#: from the model before looking keeps ``udio-1``, ``Udio v1.5`` and even
#: ``audio-udio-blend`` matching while ``stable-audio-3-medium`` does not.
#: ``inferProvider`` in frontend/src/catalog/catalogProviders.ts spells the
#: same rule (``model.toLowerCase().replace(/audio/g, '').includes('udio')``)
#: and both sides walk the same parity table.
#:
#: ``chirp`` is Suno's model family -- ``chirp-v3``, ``chirp-v4``,
#: ``chirp-crow``, ``chirp-bluejay``, ``chirp-fenix``, ``chirp-auk`` -- and it
#: is the only thing an exported Suno song's ``model`` column ever says. The
#: word "suno" is not in it, so before T14 a Suno row whose ``source`` was
#: anything but 'suno' (an import of the audio, a lineage row read by model
#: alone) fell all the way through to the last arm and was badged "Stable
#: Audio", then "theDAW" once T13 changed that arm.
_PROVIDER_BY_MODEL_SUBSTRING: tuple[tuple[str, str, str], ...] = (
    ("", "suno", "suno"),
    ("", "chirp", "suno"),
    ("", "magenta", "gemini-magenta"),
    ("", "gemini", "gemini-magenta"),
    ("audio", "udio", "udio"),
    ("", "riffusion", "riffusion"),
    # INT-002. theDAW's embedded Lyria 3 Pro sidecar; `lyria.importer` writes a
    # bare "lyria" model column. Appended, never inserted: "lyria" is not a
    # substring of any needle above and none of them is a substring of it, so
    # this arm can only ever answer for a row the others already fell through.
    #
    # NOT mirrored into `_PROVIDER_FALLBACK_TEMPLATE` below, which is the ONE
    # divergence from the twin rule this table otherwise keeps. Mirroring it is
    # a change to the text two expression indexes are declared on and therefore
    # a schema step (see 10 and 11), and it is not needed for correctness here:
    # `provider._legacy_lyria` reads the same substring off the model column at
    # WRITE time, so every row this arm could answer for already has its
    # `provider` column resolved to 'lyria' and never reaches the fallback.
    # This arm exists for the callers that have no row at all -- a lineage
    # node, which carries a model and a source and nothing else.
    ("", "lyria", "lyria"),
)

#: theDAW's own Stable Audio generations (``source`` of 'generate') and the
#: studio bounces of them ('studio'). Still a known provider, still AI -- it is
#: only no longer the answer for everything the rule cannot place.
STABLE_AUDIO_PROVIDER = "stable-audio"

#: Made IN theDAW but not generated by a model: a DJ performance set, VJ media,
#: and any ``source`` this rule has never heard of. The fallback's LAST arm, so
#: it is what an entry nothing else identifies is filed under -- which is
#: exactly why it must not name a generator.
DEFAULT_PROVIDER = "thedaw"

#: Display name and AI-ness per derived slug. Mirrors ``KNOWN_PROVIDERS`` in
#: ``frontend/src/catalog/catalogProviders.ts``. A store or host would be
#: ``False``; every ENGINE the fallback can name is a generator, while an
#: import of unknown origin and theDAW's own non-generated media (a DJ set, a
#: VJ clip) are not claimed to be one.
DERIVED_PROVIDERS: dict[str, tuple[str, bool]] = {
    "suno": ("Suno", True),
    "gemini-magenta": ("Magenta", True),
    "udio": ("Udio", True),
    "riffusion": ("Riffusion", True),
    "lyria": ("Lyria 3 Pro", True),
    "import": ("Imported", False),
    STABLE_AUDIO_PROVIDER: ("Stable Audio", True),
    DEFAULT_PROVIDER: ("theDAW", False),
}


def infer_provider(model: Optional[str], source: Optional[str]) -> str:
    """The FALLBACK above: which engine produced an entry, from its columns.

    The Python twin of :data:`PROVIDER_FALLBACK_SQL` -- exactly, which is why
    it takes the two columns that expression reads and nothing else. Anything
    only an entry's metadata knows (a stored ``$.provider``, a ``$.suno_id``)
    is resolved into the ``provider`` column by :func:`resolved_provider_slug`
    and is this function's business no more; ``provider.detect_provider``
    answers it for Python. Always answers.
    """
    if (source or "").strip().lower() == "suno":
        return "suno"
    haystack = (model or "").lower()
    for remove, needle, provider in _PROVIDER_BY_MODEL_SUBSTRING:
        if needle in (haystack.replace(remove, "") if remove else haystack):
            return provider
    if (source or "") == "import":
        return "import"
    if (source or "") in ("generate", "studio"):
        return STABLE_AUDIO_PROVIDER
    return DEFAULT_PROVIDER


def derived_provider_wire(
    model: Optional[str], source: Optional[str]
) -> dict[str, Any]:
    """The four provider wire fields for an entry nothing better identified.

    Used when neither a stored label nor the file's own embedded tags say
    anything: the row still gets the slug the catalogue has always shown it
    under, so a filter offering that slug can never come back empty. There is
    no ``provider_id`` -- a derivation from a model string does not know one.
    """
    slug = infer_provider(model, source)
    label, is_ai = DERIVED_PROVIDERS.get(slug, (slug, False))
    return {
        "provider": slug,
        "provider_label": label,
        "provider_is_ai": is_ai,
        "provider_id": None,
    }


def bounded_provider_slug(value: Any) -> Optional[str]:
    """``value`` as a provider slug no longer than :data:`PROVIDER_SLUG_MAX`,
    or None when nothing usable is left.

    An unrecognised generator frame becomes its own slug, so without a bound a
    file with a multi-kilobyte frame would mint a multi-kilobyte identifier --
    and this one is compared in SQL and stored in an indexed column. The cut
    can land on a separator, which no other code would produce, so the ends are
    stripped afterwards. Idempotent: ``provider.py`` applies the same bound
    where a slug is minted, and applying both is applying it once.
    """
    slug = str(value or "").strip().lower()
    if len(slug) > PROVIDER_SLUG_MAX:
        slug = slug[:PROVIDER_SLUG_MAX]
    return slug.strip("-") or None


def resolved_provider_slug(meta: Optional[Mapping[str, Any]]) -> Optional[str]:
    """What an entry's METADATA says its provider is, or None when it says
    nothing -- the value of the ``entries.provider`` column.

    This is the half of the provider rule a query must never pay for: a stored
    ``$.provider`` and the legacy Suno markers, decided ONCE by
    ``provider.detect_provider`` at the moment a writer is already holding the
    metadata dict, and written into a column beside the row. The file's own
    embedded tags are deliberately not consulted here -- reading those means
    opening an audio file, which no writer of a row may do.

    None leaves the column NULL and :data:`PROVIDER_FALLBACK_SQL` answering
    for the row, which is the same answer the catalogue has always given it.
    """
    if not meta:
        return None
    try:
        info = detect_provider({}, meta)
    except Exception as e:  # noqa: BLE001 - a hand-edited blob never blocks a write
        log.debug("library.db: provider resolution failed: %s", e)
        return None
    return bounded_provider_slug(info.provider) if info is not None else None


#: The fallback half of the provider rule, over the ``source`` and ``model``
#: COLUMNS alone -- no ``metadata_json``, no join, nothing an index cannot
#: carry. ``{a}`` is the table alias prefix, so the one text below is both the
#: expression the queries compare against and the expression the provider
#: indexes are built on (migration 9, rebuilt by migrations 10 and 11); they cannot
#: drift, because there is only one.
_PROVIDER_FALLBACK_TEMPLATE = """CASE
        WHEN {a}source = 'suno'
             OR instr(lower({a}model), 'suno') > 0
             OR instr(lower({a}model), 'chirp') > 0 THEN 'suno'
        WHEN instr(lower({a}model), 'magenta') > 0
             OR instr(lower({a}model), 'gemini') > 0 THEN 'gemini-magenta'
        WHEN instr(replace(lower({a}model), 'audio', ''), 'udio') > 0 THEN 'udio'
        WHEN instr(lower({a}model), 'riffusion') > 0 THEN 'riffusion'
        WHEN {a}source = 'import' THEN 'import'
        WHEN {a}source = 'generate'
             OR {a}source = 'studio' THEN '__STABLE_AUDIO__'
        ELSE '__DEFAULT__'
    END""".replace("__STABLE_AUDIO__", STABLE_AUDIO_PROVIDER).replace(
    "__DEFAULT__", DEFAULT_PROVIDER
)

#: ``NULLIF`` and not a bare COALESCE: "unresolved" is spelled NULL by every
#: writer here, but an empty string is what a hand-edited row or a future
#: writer could leave, and it must mean the same thing on both sides -- the
#: Python fold in :meth:`LibraryDB._provider_facet` reads a blank column as
#: unresolved, so the SQL has to as well or the two would file a row
#: differently.
_PROVIDER_RESOLVED_TEMPLATE = (
    "COALESCE(NULLIF({a}provider, ''), " + _PROVIDER_FALLBACK_TEMPLATE + ")"
)

#: The fallback alone, over an ``entries e``.
PROVIDER_FALLBACK_SQL = _PROVIDER_FALLBACK_TEMPLATE.format(a="e.")

#: The WHOLE provider rule as one SQL expression over an ``entries e``: the
#: resolved column when it has an answer, the fallback when it does not. Used
#: by the list filter, its count, the id list and the provider facet, so those
#: four can never file the same row under different slugs.
PROVIDER_SQL = _PROVIDER_RESOLVED_TEMPLATE.format(a="e.")

#: The same expression with no alias -- what the indexes are declared on.
#: SQLite matches an indexed expression against the query's after name
#: resolution, so the aliased and unaliased spellings are the same expression
#: and the filter is an index SEEK rather than a table scan. The test
#: ``test_library_provider_column.py`` asserts the plan, because a drift here
#: is silent: the query would still be correct, just 60,000 rows slower. THIS
#: IS WHY CHANGING THE FALLBACK'S TEXT NEEDS A MIGRATION -- see steps 10 and 11.
_PROVIDER_INDEX_EXPR = _PROVIDER_RESOLVED_TEMPLATE.format(a="")


_MIGRATIONS.append(
    (
        9,
        [
            # The resolved provider. Nullable, no default, NO BACKFILL: an
            # ``ALTER TABLE ... ADD COLUMN`` with no default is O(1) in rows
            # (SQLite only rewrites the schema; existing records are read back
            # with the column missing, which reads as NULL), so this costs the
            # same on an empty library and on 200,000 entries and never opens
            # one row's metadata. NULL rows keep being answered by the
            # fallback, exactly as they were before the column existed, and
            # are filled as requests return them.
            #
            # A build that does not know the column still reads and writes this
            # database: nothing about the older schema changed. It cannot
            # MAINTAIN the column, though -- its upsert does not name it -- so
            # an entry edited under an older build keeps whatever slug it was
            # last resolved to until a writer that knows the column touches it
            # again, or ``reindex()`` rebuilds it from disk.
            "ALTER TABLE entries ADD COLUMN provider TEXT",
            # The raw column on its own. It answers the one question the two
            # below cannot -- which rows are still unresolved -- and SQLite
            # picks it for the provider facet over EVERY kind, where nothing
            # constrains the leading ``kind`` column of the covering index
            # (measured at 60,000 rows: 131 ms).
            "CREATE INDEX IF NOT EXISTS idx_entries_provider ON entries(provider)",
            # The filtered, sorted page. ``kind`` leads because every library
            # tab but "all" constrains it; then the resolved slug, so
            # ``provider = ?`` is an equality seek; then ``created_at DESC``,
            # so the page comes back in order from an index WALK with no temp
            # b-tree and a deep OFFSET stays index steps rather than row reads
            # -- the same shape as ``idx_entries_kind_created``, which cannot
            # serve this filter because the slug is not in it.
            "CREATE INDEX IF NOT EXISTS idx_entries_provider_created "
            f"ON entries(kind, {_PROVIDER_INDEX_EXPR}, created_at DESC)",
            # The same page on the "all" tab, which sends no ``kind`` at all
            # (``router._KIND_FILTERS['all']`` is None) and so cannot seek the
            # index above -- its leading column is unconstrained. Measured at
            # 60,000 realistic rows, a RARE slug on that tab took 317 ms
            # without this index (the scan runs to the end of the table before
            # it has 200 rows) against a 150 ms budget, and 0.2 ms with it.
            "CREATE INDEX IF NOT EXISTS idx_entries_provider_any_kind "
            f"ON entries({_PROVIDER_INDEX_EXPR}, created_at DESC)",
            # The provider facet: every COLUMN the rule reads, in one COVERING
            # index, so the group-by never visits the table. Deliberately NOT
            # the expression -- SQLite does not treat an index on an expression
            # as covering, so grouping on one costs a table lookup per row
            # (measured at 60,000 rows: 348 ms on the expression against 6 ms
            # here, and the facet's budget is 300 ms). ``provider`` joins the
            # ``idx_entries_facet_model`` shape so the distinct
            # ``(provider, model, source)`` triples -- a handful of rows -- can
            # be folded into slugs in Python by the same rule the SQL spells.
            # That is what closes the facet's old divergence from the filter:
            # the resolved column is now part of the group key.
            "CREATE INDEX IF NOT EXISTS idx_entries_facet_provider "
            "ON entries(kind, provider, model, source, favorite)",
        ],
    )
)


_MIGRATIONS.append(
    (
        10,
        [
            # The fallback's last arm stopped being ``'stable-audio'``, and TWO
            # of the indexes above are declared ON THAT EXPRESSION. SQLite
            # stores an expression index's text as it was written and matches a
            # query's expression against it: an index built from the old text
            # can no longer serve the new comparison, so every provider filter
            # in an existing library would silently become a table scan -- and
            # the index would still be maintained, holding the OLD slug for
            # every row. Neither is repairable by anything but a rebuild, which
            # is why a text change here is a schema change.
            #
            # All four provider indexes are dropped and recreated together:
            # ``idx_entries_provider`` and ``idx_entries_facet_provider`` are on
            # columns rather than on the expression, so rebuilding them is not
            # strictly required, but doing the set in one step leaves no doubt
            # that no index in this database was built from the old rule.
            #
            # NO ROW IS REWRITTEN and no ``metadata_json`` is opened: a row
            # whose ``provider`` column is already set keeps it -- it was
            # resolved from that row's real metadata and is still right -- and
            # only the FALLBACK, which is computed and never stored, changes
            # its answer for the NULL rows.
            #
            # Step 9 interpolates the same live ``_PROVIDER_INDEX_EXPR``, so on
            # a v8 database it now builds these two indexes with the new text
            # and this step rebuilds them once more. That is deliberate: there
            # is exactly ONE provider expression in this module, which is what
            # keeps the queries and the indexes from drifting, and freezing a
            # second historical copy of it to save one index build on an
            # upgrade path would give that guarantee up.
            "DROP INDEX IF EXISTS idx_entries_provider",
            "DROP INDEX IF EXISTS idx_entries_provider_created",
            "DROP INDEX IF EXISTS idx_entries_provider_any_kind",
            "DROP INDEX IF EXISTS idx_entries_facet_provider",
            "CREATE INDEX IF NOT EXISTS idx_entries_provider ON entries(provider)",
            "CREATE INDEX IF NOT EXISTS idx_entries_provider_created "
            f"ON entries(kind, {_PROVIDER_INDEX_EXPR}, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_entries_provider_any_kind "
            f"ON entries({_PROVIDER_INDEX_EXPR}, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_entries_facet_provider "
            "ON entries(kind, provider, model, source, favorite)",
        ],
    )
)


_MIGRATIONS.append(
    (
        11,
        [
            # T14: the Suno arm learned ``chirp``, Suno's model family, and the
            # fallback is the text TWO of these indexes are declared on. Same
            # reasoning as step 10, one step later: SQLite stores an expression
            # index's text as written and matches a query against that text, so
            # an index built before this change can neither serve the new
            # comparison (every provider filter silently becomes a table scan)
            # nor hold the right slug for a ``chirp-*`` row. Only a rebuild
            # repairs either, which is why a text change here is a schema
            # change.
            #
            # The same four indexes, dropped and recreated together, for the
            # reason step 10 did all four: two of them are on columns and would
            # survive, but doing the set in one step leaves no doubt that no
            # index in this database was built from the old rule.
            #
            # NO ROW IS REWRITTEN and no ``metadata_json`` is opened. A row
            # whose ``provider`` column is set keeps it -- that answer came from
            # the row's own metadata and is still right -- and only the
            # FALLBACK, computed per query and never stored, changes what it
            # says about a ``chirp-*`` model.
            "DROP INDEX IF EXISTS idx_entries_provider",
            "DROP INDEX IF EXISTS idx_entries_provider_created",
            "DROP INDEX IF EXISTS idx_entries_provider_any_kind",
            "DROP INDEX IF EXISTS idx_entries_facet_provider",
            "CREATE INDEX IF NOT EXISTS idx_entries_provider ON entries(provider)",
            "CREATE INDEX IF NOT EXISTS idx_entries_provider_created "
            f"ON entries(kind, {_PROVIDER_INDEX_EXPR}, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_entries_provider_any_kind "
            f"ON entries({_PROVIDER_INDEX_EXPR}, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_entries_facet_provider "
            "ON entries(kind, provider, model, source, favorite)",
        ],
    )
)


_MIGRATIONS.append(
    (
        12,
        [
            # DJ-1: the tempo detector has always returned a confidence next to
            # the BPM and this table had nowhere to keep it, so it was dropped
            # on the floor at every persist. A deck needs it -- a BPM detected
            # at 0.1 confidence is a number to grey out, not to beatmatch on --
            # and it is the one extra field the DJ analysis profile gets for
            # free, since it falls out of the beat detection it already runs.
            #
            # Nullable with no default: every existing row means "never
            # measured", which is the truth, and re-analysis fills it the
            # normal way. Idempotent through _add_column_stmt/_has_column like
            # every other ADD COLUMN step here.
            "ALTER TABLE analysis ADD COLUMN bpm_confidence REAL",
        ],
    )
)


_MIGRATIONS.append(
    (
        13,
        [
            # The search index's text (see "Search index" above). Plain tables,
            # written only by this module and always together with the fts5
            # index over them, so what the index holds can be read back out --
            # which is what an exact fts5 delete needs. The fts5 table itself
            # is created by `_ensure_search`, because fts5 is a property of the
            # SQLite build rather than of this file.
            """
            CREATE TABLE IF NOT EXISTS entries_search_head (
                rid INTEGER PRIMARY KEY,
                head TEXT NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS entries_search_body (
                rid INTEGER PRIMARY KEY,
                body TEXT NOT NULL
            )
            """,
            """
            CREATE VIEW IF NOT EXISTS entries_search_text AS
                SELECT h.rid AS rid, h.head AS head, COALESCE(b.body, '') AS body
                FROM entries_search_head h
                LEFT JOIN entries_search_body b ON b.rid = h.rid
            """,
            # Rowids whose indexed text may be stale. The triggers below are
            # stored in the file, so every writer fires them -- this build, and
            # a build that has never heard of the index (main's schema-6 code
            # keeps opening this file). `_txn` drains the table before each
            # commit; what an older build leaves behind is drained on open.
            #
            # The table has NO key and NO constraint, and a rowid may be listed
            # many times. That is what keeps a trigger from ever failing the
            # write that fired it: SQLite applies the OUTER statement's
            # conflict policy to a trigger's inserts, so an `INSERT OR IGNORE`
            # into a keyed table still aborts main's `INSERT ... ON CONFLICT
            # DO UPDATE` the moment a rowid is listed twice. A plain insert
            # into an unconstrained table cannot conflict under any policy;
            # the readers de-duplicate.
            """
            CREATE TABLE IF NOT EXISTS search_dirty (
                rid INTEGER
            )
            """,
            "CREATE INDEX IF NOT EXISTS idx_search_dirty_rid ON search_dirty(rid)",
            """
            CREATE TRIGGER IF NOT EXISTS search_dirty_entry_insert
            AFTER INSERT ON entries BEGIN
                INSERT INTO search_dirty (rid) VALUES (NEW.rowid);
            END
            """,
            # Only the columns the index reads: a play-count bump or a status
            # change re-indexes nothing.
            """
            CREATE TRIGGER IF NOT EXISTS search_dirty_entry_update
            AFTER UPDATE OF title, prompt, negative_prompt, model, notes, source,
                mime, rating, provider, metadata_json
            ON entries BEGIN
                INSERT INTO search_dirty (rid) VALUES (OLD.rowid);
                INSERT INTO search_dirty (rid) VALUES (NEW.rowid);
            END
            """,
            """
            CREATE TRIGGER IF NOT EXISTS search_dirty_entry_delete
            AFTER DELETE ON entries BEGIN
                INSERT INTO search_dirty (rid) VALUES (OLD.rowid);
            END
            """,
            """
            CREATE TRIGGER IF NOT EXISTS search_dirty_tag_insert
            AFTER INSERT ON tag_index BEGIN
                INSERT INTO search_dirty (rid)
                    SELECT rowid FROM entries WHERE id = NEW.entry_id;
            END
            """,
            """
            CREATE TRIGGER IF NOT EXISTS search_dirty_tag_update
            AFTER UPDATE ON tag_index BEGIN
                INSERT INTO search_dirty (rid)
                    SELECT rowid FROM entries WHERE id IN (OLD.entry_id, NEW.entry_id);
            END
            """,
            """
            CREATE TRIGGER IF NOT EXISTS search_dirty_tag_delete
            AFTER DELETE ON tag_index BEGIN
                INSERT INTO search_dirty (rid)
                    SELECT rowid FROM entries WHERE id = OLD.entry_id;
            END
            """,
            """
            CREATE TRIGGER IF NOT EXISTS search_dirty_analysis_insert
            AFTER INSERT ON analysis BEGIN
                INSERT INTO search_dirty (rid)
                    SELECT rowid FROM entries WHERE id = NEW.entry_id;
            END
            """,
            """
            CREATE TRIGGER IF NOT EXISTS search_dirty_analysis_update
            AFTER UPDATE ON analysis BEGIN
                INSERT INTO search_dirty (rid)
                    SELECT rowid FROM entries WHERE id IN (OLD.entry_id, NEW.entry_id);
            END
            """,
            """
            CREATE TRIGGER IF NOT EXISTS search_dirty_analysis_delete
            AFTER DELETE ON analysis BEGIN
                INSERT INTO search_dirty (rid)
                    SELECT rowid FROM entries WHERE id = OLD.entry_id;
            END
            """,
            # The favourites / size / duration totals (`entry_stats`): every
            # column the aggregate reads, after the `kind` every tab but "all"
            # constrains, so the sums are a covering index scan and never open
            # an entries row.
            "CREATE INDEX IF NOT EXISTS idx_entries_kind_stats "
            "ON entries(kind, favorite, duration_sec, file_size_bytes)",
            # The `favorites_first` sort, walked in order on a kind tab. The
            # EDIT picker, its one user, always asks for one kind (audio), so
            # the "all" shape is left to a sort rather than taxing every insert
            # with a third index.
            "CREATE INDEX IF NOT EXISTS idx_entries_kind_fav_title "
            "ON entries(kind, favorite DESC, title COLLATE NOCASE)",
        ],
    )
)


# ---- Facets ----------------------------------------------------------------
#
# The filter dropdowns. ``model``, ``source`` and ``kind`` are columns and are
# counted directly. ``provider`` groups on the three columns
# :data:`PROVIDER_SQL` reads -- the resolved ``provider`` plus the
# ``(model, source)`` its fallback reads -- inside the covering
# ``idx_entries_facet_provider`` index, and folds them into slugs by that same
# rule. See :meth:`LibraryDB._provider_facet`.

#: Facet fields the API accepts, in the order they are documented.
FACET_FIELDS: tuple[str, ...] = ("model", "provider", "source", "kind")

#: The column each column-backed facet groups on.
_FACET_COLUMNS: dict[str, str] = {
    "model": "e.model",
    "source": "e.source",
    "kind": "e.kind",
}

#: How many values one field reports. A dropdown cannot show more, and an
#: unbounded list is exactly the response this endpoint exists to avoid.
MAX_FACET_VALUES = 200


#: How many ids one ``IN (...)`` list carries. SQLite's parameter ceiling is
#: 32766 on modern builds and 999 on very old ones; 900 is under both.
_MAX_SQL_PARAMS = 900

#: Entries removed per transaction by :meth:`LibraryDB.delete_entries_bulk`.
#: Small enough that a crash loses little, large enough that clearing 50,000
#: entries is 100 commits rather than 50,000.
DEFAULT_DELETE_BATCH = 500

#: Columns :meth:`LibraryDB.get_all_analysis` reads for the library list's
#: enrichment path (backend/modules/library/router.py -- ``_analysis_payload``
#: / ``_ANALYSIS_SCALAR_KEYS``). Excludes ``beats_json`` (a per-beat timeline,
#: never surfaced in the list enrichment) and ``version`` (an internal
#: re-analysis marker) -- a ``SELECT *`` here pulls both into memory for every
#: entry in a 200,000-track library for nothing (LIB-004). Keep in sync with
#: what ``_analysis_payload`` actually reads.
_ANALYSIS_LIST_COLUMNS = (
    "entry_id",
    "bpm",
    "bpm_confidence",
    "key",
    "key_confidence",
    "scale",
    "pitch_mean_hz",
    "pitch_std_hz",
    "loudness_lufs",
    "rms_db",
    "bars_estimated",
    "genre",
    "genre_confidence",
    "prompt_guess",
    "prompt_confidence",
    "analyzed_at",
    "semantic_tags_json",
    "embedded_tags_json",
    "ffprobe_json",
)


#: ``ALTER TABLE <table> ADD COLUMN <column> ...`` -- the one migration shape
#: SQLite has no ``IF NOT EXISTS`` for. Anchored and whitespace-tolerant; it
#: matches only the statements in :data:`_MIGRATIONS`, which this module writes.
_ADD_COLUMN_RE = re.compile(
    r"^\s*ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)\b",
    re.IGNORECASE,
)


def _add_column_stmt(stmt: str) -> Optional[tuple[str, str]]:
    """``(table, column)`` when ``stmt`` adds a column, else None.

    Lets :meth:`LibraryDB._migrate` skip an ``ADD COLUMN`` whose column is
    already there. Every other migration statement spells its own
    ``IF NOT EXISTS``; this is the shape that cannot, and the shape that turns
    an interrupted upgrade into a library nobody can open.
    """
    match = _ADD_COLUMN_RE.match(stmt)
    return (match.group(1), match.group(2)) if match else None


def _chunks(items: Sequence[Any], size: int) -> Iterator[Sequence[Any]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


# created_at / updated_at, strictly increasing within this process: every
# listing orders entries newest first by created_at, and two entries saved in
# one 15.6 ms tick of Windows' clock tied, so the one saved second could list
# after the first (backend/lib/stamps.py). A bulk batch still shares one stamp
# on purpose; the listings break that tie by rowid.
_clock = IncreasingClock()


def _now() -> float:
    return _clock()


# Sub-folder each artifact kind is superseded into. Kept out of the live
# listing (register_on_disk_artifacts only scans notation/ + midi/, and the
# stems/notation routers list DB rows), so a superseded copy never reappears.
DEPRECATED_DIRNAME = "deprecated"

# Every table that points at an artifact file, and the column holding it. Used
# to answer "is this file still referenced by some OTHER row?" before a
# superseding move, so a shared physical file is never moved out from under a
# row that still resolves through it.
ARTIFACT_PATH_COLUMNS: tuple[tuple[str, str], ...] = (
    ("notation_artifacts", "path"),
    ("midis", "midi_path"),
    ("stems", "audio_path"),
)


def normalize_artifact_path(path: str) -> str:
    """Canonical spelling of an artifact path for identity comparisons.

    Two rows can store the same file with different spellings (case, separators,
    ``..`` segments, a symlinked root), so every path identity check in the
    artifact layer goes through this. Resolution is best-effort: a path that
    cannot be realpath'd still normalizes so comparisons never raise.
    """
    if not path:
        return ""
    try:
        return os.path.normcase(os.path.realpath(path))
    except OSError:
        return os.path.normcase(path)


def _same_file_content(a: Path, b: Path) -> bool:
    """Whether two existing files are byte-identical (cheap size check first).

    Two writers can spell the SAME artifact's filename differently (the
    ``/from-midi`` route scores the name with the song slug, the notation
    backfill does not) while registering the same stable artifact id. Without
    this check, alternating runs would shuttle identical copies into
    ``deprecated/`` forever; with it, an identical payload is recognised as the
    same artifact and nothing is moved.
    """
    try:
        if a.stat().st_size != b.stat().st_size:
            return False
        return _sha256(a) == _sha256(b)
    except OSError:
        return False


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def supersede_artifact_file(
    old_path: str, new_path: str, *, skip_identical: bool = True
) -> Optional[str]:
    """When an artifact row is re-pointed from ``old_path`` to a DIFFERENT
    ``new_path`` on disk, move the now-orphaned old file into a sibling
    ``deprecated/`` folder instead of leaving it as a duplicate copy.

    This is the anti-duplication invariant for every ``add_*`` create path:
    the row is keyed on a stable id and ``INSERT OR REPLACE``d, and the file it
    used to point at is preserved (never deleted) but moved out of the live
    directory so exactly one copy per key remains where the listing looks.

    Returns the destination path when a move happened, else ``None``. It is
    best-effort: any filesystem error is logged and swallowed so a housekeeping
    move never blocks persistence of the row itself. A no-op when the paths are
    equal, the old file is gone, or the two paths resolve to the same file
    (in-place overwrite).

    ``skip_identical`` (default True) additionally treats a byte-identical
    ``old``/``new`` pair as the same artifact and declines to move — that is the
    create-path behaviour, which must not shuttle identical copies around when
    two writers spell one filename differently. The consolidation tool passes
    False, because there an identical duplicate copy is exactly what it is
    retiring.
    """
    if not old_path or not new_path or old_path == new_path:
        return None
    old = Path(old_path)
    new = Path(new_path)
    try:
        if not old.is_file():
            return None
        if normalize_artifact_path(old_path) == normalize_artifact_path(new_path):
            return None
        # An in-place overwrite (same file, e.g. differing string form) leaves
        # nothing to supersede.
        if new.exists():
            try:
                if old.samefile(new):
                    return None
            except OSError:
                pass
            # Same artifact written under a differently-spelled filename by
            # another writer: identical payload, so there is no stale copy to
            # retire. Without this, two writers that disagree about the name
            # would ping-pong identical files into deprecated/ on every run.
            if skip_identical and _same_file_content(old, new):
                log.debug(
                    "library.db: %s and %s are byte-identical; not superseding",
                    old,
                    new,
                )
                return None
        dep_dir = old.parent / DEPRECATED_DIRNAME
        dep_dir.mkdir(parents=True, exist_ok=True)
        dest = dep_dir / old.name
        if dest.exists():
            stamp = time.strftime("%Y%m%d_%H%M%S")
            candidate = dep_dir / f"{old.stem}.superseded_{stamp}{old.suffix}"
            counter = 1
            while candidate.exists():
                candidate = (
                    dep_dir / f"{old.stem}.superseded_{stamp}_{counter}{old.suffix}"
                )
                counter += 1
            dest = candidate
        # os.replace, NOT shutil.move: deprecated/ is a sub-directory of the
        # file's own parent, so the move never crosses a filesystem and needs no
        # copy fallback. shutil.move WOULD fall back to copy-then-unlink when the
        # rename is refused (a Windows handle held on the file), leaving a COPY in
        # deprecated/ beside the still-live original -- precisely the duplicate
        # this function exists to prevent. A failed rename simply changes nothing.
        # Per platform: Windows refuses the move while another handle is open,
        # and the old file stays in place. Linux and macOS move the file under
        # an open handle; the reader keeps its bytes until it closes. Both
        # outcomes leave the row authoritative and exactly one live copy.
        os.replace(old, dest)
        log.info("library.db: superseded orphaned artifact copy %s -> %s", old, dest)
        return str(dest)
    except Exception as exc:  # noqa: BLE001 - housekeeping never blocks the write
        log.warning("library.db: could not supersede %s: %s", old_path, exc)
        return None


def _entry_row(payload: dict[str, Any]) -> dict[str, Any]:
    """Normalise a flattened entry payload into the ``entries`` column set.

    Unknown keys are ignored; missing keys take the column default. Shared by
    :meth:`LibraryDB.upsert_entry` and :meth:`LibraryDB.upsert_entries_bulk` so
    the two can never drift into writing different rows for one payload
    (``tests/test_library_bulk.py`` pins that they don't). ``created_at`` and
    ``updated_at`` are the caller's business.

    Deliberately excludes ``analysis_status`` / ``stems_status`` /
    ``midi_status``: those are owned by the analysis, stems, and midi engines
    via their own dedicated ``UPDATE`` statements (each module's own
    ``_set_status`` -- ``backend.modules.analysis.engine._set_status``,
    ``backend.modules.midi.runner._set_status``,
    ``backend.modules.stems.engine._set_status``), never by a metadata
    upsert. A routine title/tag edit or a ``reindex()`` pass must not reset a
    track's analysis progress back to 'pending' (``tests/test_library_b12.py``
    pins this).

    ``provider`` is the one column DERIVED here rather than read from a payload
    key: it is resolved from the very ``metadata_json`` dict this row is
    written with (:func:`resolved_provider_slug`), so every writer -- a
    generation, an import, a folder registration, a user edit, ``reindex()`` --
    fills it without having to know it exists, and the column can never
    disagree with the metadata it was written beside. A payload whose metadata
    names no provider writes NULL and :data:`PROVIDER_FALLBACK_SQL` answers for
    that row.
    """
    meta = payload.get("metadata_json") or {}
    return {
        "id": str(payload["id"]),
        "kind": str(payload.get("kind") or "audio"),
        "title": str(payload.get("title") or ""),
        "prompt": str(payload.get("prompt") or ""),
        "negative_prompt": str(payload.get("negative_prompt") or ""),
        "model": str(payload.get("model") or ""),
        "duration_sec": float(
            payload.get("duration") or payload.get("duration_sec") or 0.0
        ),
        "steps": int(payload.get("steps") or 0),
        "cfg": float(payload.get("cfg") or 0.0),
        "seed": int(payload.get("seed") or 0),
        "mime": str(payload.get("mime") or payload.get("mime_type") or "audio/wav"),
        "audio_filename": str(payload.get("audio_filename") or ""),
        "file_size_bytes": int(payload.get("file_size_bytes") or 0),
        "source": str(payload.get("source") or "generate"),
        "favorite": 1 if payload.get("favorite") else 0,
        "rating": payload.get("rating")
        if payload.get("rating") in ("like", "dislike")
        else None,
        "notes": str(payload.get("notes") or ""),
        "timestamp": str(payload.get("timestamp") or ""),
        "provider": resolved_provider_slug(meta if isinstance(meta, Mapping) else None),
        "metadata_json": json.dumps(meta),
    }


def _entry_tag_rows(payload: dict[str, Any], entry_id: str) -> list[tuple[str, str]]:
    tags = payload.get("tags") or []
    if not isinstance(tags, list):
        return []
    return [(entry_id, str(tag)) for tag in tags if tag]


def _entry_prompt_rows(row: dict[str, Any]) -> list[tuple[str, str, str]]:
    out: list[tuple[str, str, str]] = []
    if row["prompt"]:
        out.append((row["id"], "positive", row["prompt"]))
    if row["negative_prompt"]:
        out.append((row["id"], "negative", row["negative_prompt"]))
    return out


_UPSERT_ENTRY_SQL = """
    INSERT INTO entries (
        id, kind, title, prompt, negative_prompt, model,
        duration_sec, steps, cfg, seed, mime, audio_filename,
        file_size_bytes, source, favorite, rating, notes,
        timestamp, created_at, updated_at, provider, metadata_json
    ) VALUES (
        :id, :kind, :title, :prompt, :negative_prompt, :model,
        :duration_sec, :steps, :cfg, :seed, :mime, :audio_filename,
        :file_size_bytes, :source, :favorite, :rating, :notes,
        :timestamp, :created_at, :updated_at, :provider, :metadata_json
    )
    ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        title = excluded.title,
        prompt = excluded.prompt,
        negative_prompt = excluded.negative_prompt,
        model = excluded.model,
        duration_sec = excluded.duration_sec,
        steps = excluded.steps,
        cfg = excluded.cfg,
        seed = excluded.seed,
        mime = excluded.mime,
        audio_filename = excluded.audio_filename,
        file_size_bytes = excluded.file_size_bytes,
        source = excluded.source,
        favorite = excluded.favorite,
        rating = excluded.rating,
        notes = excluded.notes,
        timestamp = excluded.timestamp,
        updated_at = excluded.updated_at,
        -- Written together with the metadata it was resolved from, so the two
        -- can never describe different providers for one row.
        provider = excluded.provider,
        metadata_json = excluded.metadata_json
    -- analysis_status / stems_status / midi_status are intentionally NOT
    -- listed above (neither INSERT column nor ON CONFLICT SET): a brand new
    -- row gets the column's own 'pending' DEFAULT, and an existing row's
    -- status is left exactly as the analysis/stems/midi engines last set it.
    -- See LIB-001 and the docstring on _entry_row().
"""


def _search_rows_sql(marks: str) -> str:
    """Everything :func:`search_text` reads for the entries whose rowid is in
    ``(marks)``: the entry columns, the few ``metadata_json`` keys a record
    exposes, the tags, and the analysis row.

    Every ``json_extract`` is guarded by ``json_valid`` inside a CASE, so a
    hand-edited or truncated blob indexes as absent rather than aborting the
    write that triggered the re-index.
    """
    meta = (
        "CASE WHEN json_valid(e.metadata_json) "
        "THEN json_extract(e.metadata_json, '{path}') END"
    )
    probe = (
        "CASE WHEN json_valid(a.ffprobe_json) "
        "THEN json_extract(a.ffprobe_json, '{path}') END"
    )
    analysis = ", ".join(f'a."{key}" AS "{key}"' for key in ANALYSIS_SCALAR_KEYS)
    return f"""
        SELECT e.rowid AS rid, e.title AS title, e.prompt AS prompt,
               e.negative_prompt AS negative_prompt, e.model AS model,
               e.notes AS notes, e.source AS source, e.mime AS mime,
               e.rating AS rating,
               {PROVIDER_SQL} AS provider_slug,
               {meta.format(path="$.lyrics")} AS m_lyrics,
               {meta.format(path="$.mime_type")} AS m_mime,
               {meta.format(path="$.provider_label")} AS m_provider_label,
               {meta.format(path="$.chimera_sources")} AS m_chimera,
               (SELECT group_concat(t.tag, char(10)) FROM tag_index t
                 WHERE t.entry_id = e.id) AS tags,
               a.entry_id IS NOT NULL AS analyzed,
               {analysis},
               a.semantic_tags_json AS semantic_tags_json,
               a.embedded_tags_json AS embedded_tags_json,
               {probe.format(path="$._summary")} AS ff_summary,
               {probe.format(path="$." + ANALYSIS_PROFILE_MARKER_KEY)} AS ff_profile
        FROM entries e
        LEFT JOIN analysis a ON a.entry_id = e.id
        WHERE e.rowid IN ({marks})
    """


class SearchIndexFailed(RuntimeError):
    """A background build of the search index stopped part way. Searches
    raise it until the next open resumes the build from its cursor."""


#: The long jobs opening a library can run, in the order they run and the
#: order :meth:`LibraryProgress.snapshot` reports them: the schema upgrade,
#: the read of every ``metadata.json`` into an empty (or half-filled)
#: database, and the search index build.
PROGRESS_TASKS: tuple[str, ...] = ("upgrade", "read", "index")

#: What each task is called on the LIBRARY tab's progress bar.
PROGRESS_LABELS: dict[str, str] = {
    "upgrade": "Upgrading the library database",
    "read": "Reading the library from disk",
    "index": "Building the search index",
}


class LibraryProgress:
    """How far the long jobs of opening a library have got, readable from any
    thread without touching the database.

    ``GET /api/library/index-status`` answers from :meth:`snapshot` while the
    schema upgrade still holds the write lock, so nothing here may take that
    lock or read the file. Each task counts its own units -- migration
    statements, top-level library folders, entries -- and an ETA comes from
    the rate of the units done since the task (re)started, so a build that
    resumes at row 150,000 does not claim it did those rows in no time.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._tasks: dict[str, dict[str, Any]] = {}
        self._error: Optional[str] = None
        self._error_label = ""
        self._opened = False

    def begin(self, task: str, total: int, done: int = 0) -> None:
        with self._lock:
            self._tasks[task] = {
                "total": max(0, int(total)),
                "done": max(0, int(done)),
                "base": max(0, int(done)),
                "items": 0,
                "started": time.monotonic(),
                "finished": False,
            }

    def advance(self, task: str, units: int = 0, *, items: int = 0) -> None:
        """Add ``units`` of progress (and ``items`` counted alongside, such as
        the entries a folder walk found) to a running task."""
        with self._lock:
            state = self._tasks.get(task)
            if state is None or state["finished"]:
                return
            state["done"] = min(state["total"], state["done"] + int(units))
            state["items"] += int(items)

    def finish(self, task: str) -> None:
        with self._lock:
            state = self._tasks.get(task)
            if state is not None:
                state["done"] = state["total"]
                state["finished"] = True

    def fail(
        self, message: str, *, label: str = "The library could not be opened"
    ) -> None:
        with self._lock:
            self._error = message
            self._error_label = label

    def clear_failure(self) -> None:
        """Forget a failure, for a task that is being started again (a search
        index build restarted by the Retry button)."""
        with self._lock:
            self._error = None
            self._error_label = ""

    def mark_opened(self) -> None:
        """The store answers requests from here on (a task may still run)."""
        with self._lock:
            self._opened = True

    def snapshot(self) -> dict[str, Any]:
        """``{phase, label, done, total, items, eta_sec, opened, error}``.

        ``phase`` is the first running task of :data:`PROGRESS_TASKS`,
        ``"opening"`` before the store has opened with nothing running yet,
        ``"failed"`` when the open or a task stopped, else ``"ready"``.
        ``eta_sec`` is None until a task has a rate to go by."""
        with self._lock:
            now = time.monotonic()
            if self._error is not None:
                return {
                    "phase": "failed",
                    "label": self._error_label,
                    "done": 0,
                    "total": 0,
                    "items": 0,
                    "eta_sec": None,
                    "opened": self._opened,
                    "error": self._error,
                }
            for task in PROGRESS_TASKS:
                state = self._tasks.get(task)
                if state is None or state["finished"]:
                    continue
                gained = state["done"] - state["base"]
                elapsed = now - state["started"]
                remaining = state["total"] - state["done"]
                eta: Optional[float] = None
                if gained > 0 and elapsed > 0:
                    eta = round(remaining * elapsed / gained, 1)
                return {
                    "phase": task,
                    "label": PROGRESS_LABELS[task],
                    "done": state["done"],
                    "total": state["total"],
                    "items": state["items"],
                    "eta_sec": eta,
                    "opened": self._opened,
                    "error": None,
                }
            return {
                "phase": "ready" if self._opened else "opening",
                "label": "Ready" if self._opened else "Opening the library",
                "done": 0,
                "total": 0,
                "items": 0,
                "eta_sec": None,
                "opened": self._opened,
                "error": None,
            }


#: How long one batch of a search index build may hold the write lock. Every
#: library read takes that lock too, so this is the longest one read waits on
#: the build; a list request makes three or four of them. The batch size
#: follows the measured rate toward it. At 0.1 s a search during the build
#: measured 0.26-0.36 s; each commit costs little next to the rows it holds.
SEARCH_BATCH_TARGET_SEC = 0.05

#: The smallest batch a build shrinks to on a slow disk.
SEARCH_BATCH_MIN = 50

#: Rows per hold of the write lock when a whole ``entries`` read runs
#: (:meth:`LibraryDB._entry_rows_in_chunks`).
WHOLE_TABLE_READ_CHUNK = 1000


class FairRLock:
    """A re-entrant lock that is handed to its waiters in the order they
    arrived.

    :class:`LibraryDB` serializes every read and write of its one connection
    on this lock. ``threading.RLock`` is not fair: a thread that releases it
    and asks again at once usually gets it back, however long another thread
    has waited. With the search index build (one batch after another) and the
    notation backfill (several calls per entry over 200,000 entries) both
    looping on it after a start, a library search measured a 4 s wait for its
    turn at 200,000 rows. Here a release hands the lock straight to the
    longest waiter, so a request waits for the critical sections queued ahead
    of it and no longer.

    Same use as ``RLock``: ``with lock:``, ``acquire(blocking, timeout)``,
    ``release()``, re-entrant for the owning thread.
    """

    def __init__(self) -> None:
        self._mutex = threading.Lock()
        self._owner: Optional[int] = None
        self._depth = 0
        self._queue: deque[tuple[int, threading.Lock]] = deque()

    def acquire(self, blocking: bool = True, timeout: float = -1) -> bool:
        me = threading.get_ident()
        with self._mutex:
            if self._owner == me:
                self._depth += 1
                return True
            if self._owner is None and not self._queue:
                self._owner = me
                self._depth = 1
                return True
            if not blocking:
                return False
            gate = threading.Lock()
            gate.acquire()
            ticket = (me, gate)
            self._queue.append(ticket)
        # release() makes this thread the owner BEFORE it opens the gate.
        if gate.acquire(timeout=timeout):
            return True
        with self._mutex:
            if self._owner == me:
                # Handed over just as the wait ran out: it is ours.
                return True
            self._queue.remove(ticket)
            return False

    def release(self) -> None:
        with self._mutex:
            if self._owner != threading.get_ident():
                raise RuntimeError("cannot release un-acquired lock")
            self._depth -= 1
            if self._depth:
                return
            if self._queue:
                owner, gate = self._queue.popleft()
                self._owner = owner
                self._depth = 1
                gate.release()
            else:
                self._owner = None

    def __enter__(self) -> bool:
        return self.acquire()

    def __exit__(self, *exc: object) -> None:
        self.release()


class LibraryDB:
    """Thin DAO over a single SQLite file.

    The connection uses ``check_same_thread=False`` so it survives
    FastAPI's threadpool, gated by an internal ``RLock``. All writes go
    through ``_writelock`` so concurrent updates serialize cleanly.
    """

    #: One log line per process when the SQLite build has no FTS5, not one per
    #: opened database.
    _fts_warned = False

    def __init__(
        self,
        path: Path,
        *,
        enable_fts: bool = True,
        build_search_in_background: bool = False,
        progress: Optional[LibraryProgress] = None,
    ) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        #: What the schema upgrade and the search index build report to, read
        #: by ``GET /api/library/index-status`` (see :class:`LibraryProgress`).
        self.progress = progress if progress is not None else LibraryProgress()
        #: Fair, so a request never starves behind a background loop
        #: (:class:`FairRLock`).
        self._writelock = FairRLock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        #: Whether the linked SQLite has JSON1 (``_ensure_json1`` supplies the
        #: functions when it does not).
        self.json1_native = _ensure_json1(self._conn)
        # FIRST, before any statement that can need a lock. sqlite3.connect's
        # `timeout` default is a 5 s busy timeout, and 5 s is not enough here:
        # `_migrate` builds indexes that its own docstring measures in "seconds
        # to minutes" over a large library, and the two statements below plus
        # the migration's DDL all want the write lock. Whatever else holds it --
        # a background analysis writer, a reindex, another test's store on the
        # same file -- SQLITE_BUSY surfaces as `sqlite3.OperationalError:
        # database is locked` straight out of __init__, which is an unopenable
        # library rather than a slow one. 30 s is the conventional single-app
        # SQLite value and is bounded, so a real deadlock still fails loudly.
        #
        # It is set before `journal_mode = WAL` deliberately: switching to WAL
        # needs a momentary EXCLUSIVE lock, so that PRAGMA is the single most
        # likely statement in this constructor to meet a concurrent reader, and
        # it used to run with only the implicit connect() timeout behind it.
        self._conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
        # Foreign keys are off by default; we rely on CASCADE deletes.
        self._conn.execute("PRAGMA foreign_keys = ON")
        # WAL gives us readers concurrent with writers.
        self._conn.execute("PRAGMA journal_mode = WAL")
        self._conn.execute("PRAGMA synchronous = NORMAL")
        # Statement journals in memory. A statement on a table with a trigger
        # (the search-index triggers of migration step 13) opens a statement
        # journal every time it runs; in a temp FILE that is a file created
        # and removed per row of an executemany, measured at 0.4 ms a row on
        # Windows -- four times the cost of the insert itself.
        self._conn.execute("PRAGMA temp_store = MEMORY")
        self._enable_fts = bool(enable_fts)
        #: Whether library search runs on fts5. False when this SQLite build
        #: lacks the module or a caller asked for the instr path; read it rather
        #: than assuming, and see :meth:`_text_match_sql` for what changes.
        self.fts_enabled = False
        #: Whether the search tables exist (see :meth:`_ensure_search`).
        self.search_ready = False
        #: Set once the search index answers for every entry. Only a build
        #: running in the background leaves it clear past the constructor; a
        #: search meanwhile answers from the rows indexed so far and says so
        #: (:meth:`search_status`).
        self._search_built = threading.Event()
        #: What stopped a background build, raised to every search after it.
        self._search_build_error: Optional[BaseException] = None
        #: Set by :meth:`close`; a background build stops at its next batch.
        self._closed = False
        #: Open :meth:`checkpoint_once` blocks, and the autocheckpoint
        #: setting the outermost one restores.
        self._checkpoint_depth = 0
        self._checkpoint_previous = 1000
        try:
            self._migrate()
            self._ensure_search(background=build_search_in_background)
        except BaseException:
            # An open that failed part way must not keep the file open: the
            # backend retries a failed open, and every attempt would leave a
            # connection behind.
            self.close()
            raise

    def close(self) -> None:
        with self._writelock:
            self._closed = True
            self._conn.close()
        self._search_built.set()

    @property
    def closed(self) -> bool:
        """Whether :meth:`close` has run: a job queued against this database
        before the library was closed or replaced finds it closed."""
        return self._closed

    # ---- Schema -------------------------------------------------------------

    def _current_schema_version(self) -> int:
        cur = self._conn.cursor()
        # If schema_meta isn't there yet, this is a fresh DB.
        try:
            row = cur.execute(
                "SELECT value FROM schema_meta WHERE key = 'schema_version'"
            ).fetchone()
        except sqlite3.OperationalError:
            return 0
        if not row:
            return 0
        try:
            return int(row["value"])
        except (KeyError, ValueError):
            return 0

    def _migrate(self) -> None:
        """Bring the schema up to :data:`SCHEMA_VERSION`, one ALL-OR-NOTHING
        step at a time.

        Each step's statements AND its ``schema_version`` bump share ONE
        explicit transaction. That is the difference between an interrupted
        upgrade being resumable and the library refusing to open:

        * SQLite DDL is transactional -- a rolled back ``ALTER TABLE`` /
          ``CREATE INDEX`` leaves no trace -- so a step either happened or did
          not, and the recorded version always matches the schema on disk.
        * Python's sqlite3 in legacy transaction mode opens an implicit
          transaction before DML only, NEVER before DDL, so without the
          explicit ``BEGIN`` every ``ALTER`` and ``CREATE INDEX`` below would
          commit on its own, ahead of the version bump that says they ran.
          Building three indexes over a 200,000-entry library takes seconds to
          minutes; a close, a crash or a kill inside that window left the
          column added and the version still behind, and the next open re-ran
          the bare ``ALTER`` and raised "duplicate column name" out of
          ``__init__`` -- an unopenable library.

        ``BEGIN`` is issued through the connection rather than relying on the
        module's implicit handling precisely because the statements are DDL.
        Once it has run, SQLite is out of autocommit, so the bump's INSERT
        joins this transaction instead of starting its own.

        :func:`_add_column_stmt` makes the second guarantee independent of the
        first: a database ALREADY left half-migrated by an older, non-atomic
        build is repaired rather than rejected, because an ``ADD COLUMN`` whose
        column is present is skipped instead of raising. Every other statement
        in ``_MIGRATIONS`` already carries ``IF NOT EXISTS``.
        """
        with self._writelock:
            current = self._current_schema_version()
            pending = [
                statements
                for target_version, statements in _MIGRATIONS
                if target_version > current
            ]
            if pending:
                # One unit per statement: an index build over 200,000 rows is
                # the slow part, and every CREATE INDEX is one statement.
                self.progress.begin("upgrade", sum(len(s) for s in pending))
            for target_version, statements in _MIGRATIONS:
                if target_version <= current:
                    continue
                log.info("library.db: migrating to schema v%d", target_version)
                self._conn.execute("BEGIN")
                try:
                    for stmt in statements:
                        column = _add_column_stmt(stmt)
                        if column is not None and self._has_column(*column):
                            log.info(
                                "library.db: %s.%s is already there; "
                                "finishing an interrupted migration",
                                *column,
                            )
                            self.progress.advance("upgrade", 1)
                            continue
                        self._conn.execute(stmt)
                        self.progress.advance("upgrade", 1)
                    self._conn.execute(
                        "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)",
                        (str(target_version),),
                    )
                    if current == 0:
                        self._conn.execute(
                            "INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('initialized_at', ?)",
                            (str(_now()),),
                        )
                    self._conn.commit()
                except Exception:
                    self._conn.rollback()
                    log.error(
                        "library.db: migration to schema v%d failed and was "
                        "rolled back; the database is still at v%d",
                        target_version,
                        current,
                    )
                    raise
                current = target_version
            if pending:
                self.progress.finish("upgrade")

    def _has_column(self, table: str, column: str) -> bool:
        rows = self._conn.execute(f"PRAGMA table_info({table})").fetchall()
        return any(str(row[1]) == column for row in rows)

    # ---- Search index -------------------------------------------------------

    def _ensure_search(self, *, background: bool = False) -> None:
        """Bring the search index up to date on open.

        1. Create the fts5 trigram index and the one- and two-character
           index when this SQLite has fts5 and the
           trigram tokenizer. Not a migration step: both are properties of the
           SQLite build, not of the file, so a library first opened without
           them picks the index up the next time a build that has them opens
           it.
        2. Drop the first paged build's contentless ``entries_fts``.
        3. Build the index when it is missing, from an older text version, or
           was built without fts5 -- resuming an interrupted build from
           :data:`FTS_BACKFILL_ROWID_KEY`.
        4. Re-index whatever another build changed since this one last had the
           file (:meth:`_reconcile_search`).

        A file whose migrations stop short of step 13 has none of the search
        tables; the index then stays off (:attr:`search_ready` is False) and
        writes carry on without it. Only a test that migrates a file part way
        opens one: a real open either reaches ``SCHEMA_VERSION`` or raises.

        With ``background`` the rows of step 3, and step 4 after them, are
        indexed on a thread of their own, which takes the write lock one short
        batch at a time (:data:`SEARCH_BATCH_TARGET_SEC`). The backend opens
        the library off its startup, and a 200,000-entry build takes minutes.
        Writes keep their own rows indexed meanwhile (:meth:`_sync_dirty`), and
        a search answers at once from the rows indexed so far, with
        :meth:`search_status` saying how far the build has got.
        """
        with self._writelock:
            self.search_ready = (
                self._conn.execute(
                    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' "
                    "AND name IN ('entries_search_head', 'entries_search_body', "
                    "'search_dirty')"
                ).fetchone()["n"]
                == 3
            )
            if not self.search_ready:
                self._search_built.set()
                return
            if self._enable_fts:
                try:
                    self._conn.execute(_SEARCH_FTS_SQL)
                    self._conn.execute(_SEARCH_SHORT_FTS_SQL)
                    # A table created by a SQLite that had the trigram
                    # tokenizer exists even where this one lacks it; asking it
                    # something is what proves it is usable here.
                    self._conn.execute(
                        "SELECT rowid FROM entries_search "
                        "WHERE entries_search MATCH '\"abc\"' LIMIT 1"
                    ).fetchall()
                    self._conn.execute(
                        "SELECT rowid FROM entries_search_short "
                        "WHERE entries_search_short MATCH 'u61' LIMIT 1"
                    ).fetchall()
                    self._conn.commit()
                    self.fts_enabled = True
                except sqlite3.OperationalError as e:
                    self._conn.rollback()
                    if not LibraryDB._fts_warned:
                        LibraryDB._fts_warned = True
                        log.warning(
                            "library.db: this SQLite build has no FTS5 trigram "
                            "index (%s); library search scans the search text "
                            "tables instead",
                            e,
                        )
            if self.fts_enabled:
                self._drop_legacy_fts()
            start = self._start_search_build()
            if start is None:
                self._reconcile_search()
                self._search_built.set()
                return
            if not background:
                self._index_search_rows(start)
                self._reconcile_search()
                self._search_built.set()
                return
            # Counted here, under the lock, so the progress bar has its total
            # before the first batch runs.
            self._begin_index_progress(start)
        log.info(
            "library.db: building the search index in the background; "
            "a search answers from the rows indexed so far until it finishes"
        )
        threading.Thread(
            target=self._finish_search_build,
            args=(start,),
            name=SEARCH_BUILD_THREAD,
            daemon=True,
        ).start()

    def _begin_index_progress(self, start: int) -> None:
        """Start the ``index`` task of :attr:`progress`: every entry, the ones
        at or below ``start`` (a resumed build's cursor) already done."""
        row = self._conn.execute(
            "SELECT COUNT(*) AS n, "
            "COALESCE(SUM(CASE WHEN rowid <= ? THEN 1 ELSE 0 END), 0) AS done "
            "FROM entries",
            (start,),
        ).fetchone()
        self.progress.begin("index", int(row["n"]), int(row["done"]))

    def _finish_search_build(self, start: int) -> None:
        """The background half of :meth:`_ensure_search`: index the rows,
        then reconcile. Whatever stops it is kept and raised to every search
        after it (:meth:`_raise_if_search_failed`); the next open resumes the
        build from its last committed batch.

        A finished build moves ``library_revision`` once, after the index
        answers for every entry: every search answer a client cached while it
        ran (pages, facets, the stats chips, all keyed by revision) covered
        part of the library, and the bump is what tells it to ask again.
        Never per batch, which would make every client refetch hundreds of
        times over a 200,000-row build."""
        finished = False
        try:
            finished = self._index_search_rows(start)
            if finished:
                self._reconcile_search()
        except BaseException as e:
            finished = False
            self._search_build_error = e
            self.progress.fail(
                f"the search index build stopped ({e}); it resumes from where it "
                "stopped the next time theDAW starts",
                label="The search index build stopped",
            )
            log.exception("library.db: the search index build stopped")
        finally:
            self.progress.finish("index")
            self._search_built.set()
        if not finished:
            return
        try:
            with self._writelock:
                if not self._closed:
                    with self._txn() as cur:
                        cur.execute("SELECT 1")
        except sqlite3.Error:
            log.warning(
                "library.db: the search index is built, but announcing it to "
                "the clients failed; they see it on the next library write",
                exc_info=True,
            )

    @property
    def search_complete(self) -> bool:
        """Whether the search index answers for every entry."""
        return self._search_built.is_set() and self._search_build_error is None

    def wait_for_search_build(self, timeout: Optional[float] = None) -> bool:
        """Block until the search index build has ended (finished, stopped
        or never needed), at most ``timeout`` seconds. True when it ended.

        For a background pass over the whole library: run beside the build,
        such a pass and the build starve every request thread of the
        interpreter (on a CI machine the two together held ``/api/health``
        for over a second while 200,000 rows were indexed), so a pass that
        nobody is waiting for runs after the build instead."""
        return self._search_built.wait(timeout)

    def search_status(self) -> dict[str, Any]:
        """``{"complete": True}`` once the index answers for every entry;
        while a background build runs, ``{"complete": False, "indexed",
        "total", "eta_sec"}`` -- a search then covers the ``indexed`` rows.
        A build that stopped answers ``{"complete": False, "failed": True,
        "error"}``: nothing finishes it until :meth:`restart_search_build`
        or the next open. Reads no row and takes no lock."""
        if self.search_complete:
            return {"complete": True}
        error = self._search_build_error
        if error is not None:
            return {
                "complete": False,
                "failed": True,
                "error": str(error) or type(error).__name__,
                "indexed": 0,
                "total": 0,
                "eta_sec": None,
            }
        snap = self.progress.snapshot()
        if snap["phase"] == "index":
            return {
                "complete": False,
                "indexed": snap["done"],
                "total": snap["total"],
                "eta_sec": snap["eta_sec"],
            }
        return {"complete": False, "indexed": 0, "total": 0, "eta_sec": None}

    def restart_search_build(self) -> bool:
        """Start a background search index build that stopped again, from its
        last committed batch (the LIBRARY tab's Retry button). False when
        there is nothing to restart: no build failed, or the database is
        closed."""
        with self._writelock:
            if self._closed or self._search_build_error is None:
                return False
            self._search_build_error = None
            self._search_built.clear()
            self.progress.clear_failure()
        log.info("library.db: restarting the search index build")
        try:
            self._ensure_search(background=True)
        except BaseException as e:
            self._search_build_error = e
            self._search_built.set()
            self.progress.fail(
                f"the search index build could not be restarted ({e})",
                label="The search index build stopped",
            )
            log.exception("library.db: restarting the search index build failed")
            return False
        return True

    def _raise_if_search_failed(self) -> None:
        """Raise :class:`SearchIndexFailed` when a background build of the
        index stopped: the index then holds part of the library and nothing
        is filling in the rest until the next open resumes the build. A build
        still running raises nothing; the search answers from the rows done
        so far (:meth:`search_status`)."""
        if self._search_build_error is not None:
            raise SearchIndexFailed(
                f"the library search index could not be built: "
                f"{self._search_build_error}"
            ) from self._search_build_error

    def _unindexed_after(self) -> Optional[int]:
        """The rowid a running build has indexed up to, or None when the index
        answers for every entry. Rows above it hold no search text yet unless
        a write indexed them. Call it holding :attr:`_writelock`."""
        if self.search_complete:
            return None
        cursor = self._meta_value(FTS_BACKFILL_ROWID_KEY)
        return None if cursor is None else int(cursor)

    def _meta_value(self, key: str) -> Optional[str]:
        row = self._conn.execute(
            "SELECT value FROM schema_meta WHERE key = ?", (key,)
        ).fetchone()
        return None if row is None else str(row["value"])

    def get_flag(self, key: str) -> Optional[str]:
        """A ``schema_meta`` value, or None. For the store's bookkeeping
        (:data:`DISK_READ_PENDING_KEY`), never for library data."""
        with self._writelock:
            return self._meta_value(key)

    def set_flag(self, key: str, value: Optional[str]) -> None:
        """Write (or, with None, remove) a ``schema_meta`` value, committed at
        once. Bookkeeping, not a library mutation: ``library_revision`` does
        not move, so no client refetches for it."""
        with self._writelock:
            try:
                if value is None:
                    self._conn.execute("DELETE FROM schema_meta WHERE key = ?", (key,))
                else:
                    self._conn.execute(
                        "INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)",
                        (key, str(value)),
                    )
                self._conn.commit()
            except Exception:
                self._conn.rollback()
                raise

    def _search_state(self) -> str:
        """The :data:`SEARCH_STATE_KEY` value a finished build leaves here."""
        return f"v{SEARCH_TEXT_VERSION}:{'fts' if self.fts_enabled else 'plain'}"

    def _drop_legacy_fts(self) -> None:
        """Remove the first paged build's ``entries_fts`` and its done flag.

        That build filled the table once and then maintained it from its own
        writes, deleting with values re-derived from ``entries``. Every write
        this build or main makes leaves it stale, and a stale contentless
        index corrupts on the next delete. With the table and the flag gone,
        that build recreates and backfills it from scratch if it is run
        against this file again.
        """
        exists = self._conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (LEGACY_FTS_TABLE,),
        ).fetchone()
        flagged = self._meta_value(LEGACY_FTS_BACKFILL_KEY) is not None
        if not exists and not flagged:
            return
        try:
            if exists:
                self._conn.execute(f"DROP TABLE {LEGACY_FTS_TABLE}")
            self._conn.execute(
                "DELETE FROM schema_meta WHERE key = ?", (LEGACY_FTS_BACKFILL_KEY,)
            )
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise
        log.info("library.db: removed the previous search index (%s)", LEGACY_FTS_TABLE)

    def _start_search_build(self) -> Optional[int]:
        """Get a build of the search index ready to run: None when the index
        is already the one this build keeps, else the rowid to index after.

        The cursor in :data:`FTS_BACKFILL_ROWID_KEY` belongs to the target
        named in :data:`SEARCH_TARGET_KEY`; a cursor left by a build of a
        different target is discarded and the build starts over, and a start
        from the top clears the index first. That part is cheap and runs
        under the caller's write lock; the rows are indexed by
        :meth:`_index_search_rows`.

        Commits directly instead of going through ``_txn``: building an index
        is not a library mutation, and a 200k build would otherwise push
        ``library_revision`` forward once per batch and make every connected
        client refetch.
        """
        expected = self._search_state()
        cursor_text = self._meta_value(FTS_BACKFILL_ROWID_KEY)
        if self._meta_value(SEARCH_STATE_KEY) == expected and cursor_text is None:
            return None
        if self._meta_value(SEARCH_TARGET_KEY) == expected and cursor_text is not None:
            last_rowid = int(cursor_text)
            log.info(
                "library.db: resuming the search index build after row %d",
                last_rowid,
            )
            return last_rowid
        cur = self._conn.cursor()
        try:
            # From the top. Everything indexed so far was indexed for a
            # different target, so it goes -- the head and body rows and,
            # when there is an fts5 index, every row of it -- and the dirty
            # list with it, since this pass covers every row.
            cur.execute("DELETE FROM entries_search_head")
            cur.execute("DELETE FROM entries_search_body")
            if self.fts_enabled:
                cur.execute(
                    "INSERT INTO entries_search(entries_search) VALUES('delete-all')"
                )
                cur.execute(
                    "INSERT INTO entries_search_short(entries_search_short) "
                    "VALUES('delete-all')"
                )
            cur.execute("DELETE FROM search_dirty")
            cur.execute("DELETE FROM schema_meta WHERE key = ?", (SEARCH_STATE_KEY,))
            cur.execute(
                "INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)",
                (SEARCH_TARGET_KEY, expected),
            )
            cur.execute(
                "INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, '0')",
                (FTS_BACKFILL_ROWID_KEY,),
            )
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise
        finally:
            cur.close()
        return 0

    def _index_search_rows(
        self, last_rowid: int, *, batch: int = SEARCH_BACKFILL_BATCH
    ) -> bool:
        """Index every entry after ``last_rowid``, in batches, then record the
        finished index. True when it finished; False when :meth:`close` ran
        first.

        Each batch takes the write lock and commits together with
        :data:`FTS_BACKFILL_ROWID_KEY`, the highest rowid it covered, so a
        build interrupted by a crash, a kill or a full disk resumes after the
        last committed batch. A row a write changes meanwhile is indexed by
        that write (:meth:`_sync_dirty`) and again when the build reaches it,
        the same text both times. Commits directly, for the reason
        :meth:`_start_search_build` gives.

        Every library read takes the same lock, so a batch is sized to hold
        it for about :data:`SEARCH_BATCH_TARGET_SEC`: the size follows the
        measured rate, between :data:`SEARCH_BATCH_MIN` and ``batch``. At
        2,000 rows a batch held the lock for 0.3 s on a fast disk and more
        than a second on a slow one, and every read waited that long. The
        lock is fair (:class:`FairRLock`), so a read that arrives during a
        batch runs before the next one.
        """
        expected = self._search_state()
        indexed = 0
        reported = time.monotonic()
        top: Optional[int] = None
        # The first batch is the smallest: its rate sets the next size, and a
        # 500-row first batch held the lock for over a second on a slow runner
        # while every read (and the event loop under it) waited.
        size = max(1, min(batch, SEARCH_BATCH_MIN))
        while True:
            with self._writelock:
                if self._closed:
                    return False
                began = time.perf_counter()
                cur = self._conn.cursor()
                try:
                    if top is None:
                        top = cur.execute(
                            "SELECT MAX(rowid) AS m FROM entries"
                        ).fetchone()["m"]
                    rows = cur.execute(
                        "SELECT rowid FROM entries WHERE rowid > ? "
                        "ORDER BY rowid LIMIT ?",
                        (last_rowid, size),
                    ).fetchall()
                    if rows:
                        rids = [int(r["rowid"]) for r in rows]
                        self._sync_search(cur, rids)
                        last_rowid = rids[-1]
                        cur.execute(
                            "INSERT OR REPLACE INTO schema_meta (key, value) "
                            "VALUES (?, ?)",
                            (FTS_BACKFILL_ROWID_KEY, str(last_rowid)),
                        )
                    else:
                        cur.execute(
                            "INSERT OR REPLACE INTO schema_meta (key, value) "
                            "VALUES (?, ?)",
                            (SEARCH_STATE_KEY, expected),
                        )
                        cur.execute(
                            "DELETE FROM schema_meta WHERE key IN (?, ?)",
                            (SEARCH_TARGET_KEY, FTS_BACKFILL_ROWID_KEY),
                        )
                    self._conn.commit()
                except Exception:
                    self._conn.rollback()
                    raise
                finally:
                    cur.close()
                held = time.perf_counter() - began
            if not rows:
                break
            indexed += len(rows)
            self.progress.advance("index", len(rows))
            # Between batches the interpreter is handed to whoever is waiting:
            # a request thread that only needs the GIL for a few steps was
            # starved by this loop on Linux, where a thread that has just
            # released the GIL wins it back before a waiter is scheduled.
            time.sleep(sys.getswitchinterval())
            if held > 0:
                size = int(len(rows) * SEARCH_BATCH_TARGET_SEC / held)
            size = max(min(SEARCH_BATCH_MIN, batch), min(batch, size))
            if time.monotonic() - reported >= 10.0:
                reported = time.monotonic()
                log.info(
                    "library.db: search index build at row %d of %s (%d indexed)",
                    last_rowid,
                    top,
                    indexed,
                )
        if indexed:
            log.info("library.db: indexed %d entries for search", indexed)
        return True

    def _reconcile_search(self, *, batch: int = SEARCH_BACKFILL_BATCH) -> None:
        """Re-index every row the index may be wrong about, on open.

        * ``search_dirty``: rows another build changed -- one that predates
          the index, whose writes the triggers recorded -- and rows a writer
          in this process committed without going through ``_txn``.
        * rows with no head row, and head rows with no entry: whatever a
          writer the triggers could not see left behind -- an ``INSERT OR
          REPLACE`` into ``entries`` (its implied delete fires no trigger
          unless recursive triggers are on), or a hand edit.
          The two rowid lists are read and compared as sets: at 200,000
          rows that is about 0.1 s per list, where ``rowid NOT IN (SELECT rid
          FROM entries_search_head)`` took 1.1 s -- it walks ``entries`` in
          an index's order and looks every rowid up in the head table's
          text-laden pages at random, all of it under the write lock.

        Takes the write lock per list and per batch, and commits per batch,
        directly, for the reason ``_start_search_build`` gives. A write that
        lands between the two lists only adds a rowid to re-index, and
        re-indexing a row that needs nothing writes back the same text; a
        row a write re-indexes in between is indexed again here with the
        same text.
        """
        with self._writelock:
            if self._closed:
                return
            todo = {int(r["rid"]) for r in self._conn.execute(_DIRTY_ROWIDS_SQL)}
            entry_rowids = {
                int(r["rowid"]) for r in self._conn.execute("SELECT rowid FROM entries")
            }
        with self._writelock:
            if self._closed:
                return
            head_rowids = {
                int(r["rid"])
                for r in self._conn.execute("SELECT rid FROM entries_search_head")
            }
        todo.update(entry_rowids.symmetric_difference(head_rowids))
        if not todo:
            return
        ordered = sorted(todo)
        for chunk in _chunks(ordered, batch):
            with self._writelock:
                if self._closed:
                    return
                cur = self._conn.cursor()
                try:
                    self._sync_search(cur, chunk)
                    for part in _chunks(list(chunk), _MAX_SQL_PARAMS):
                        marks = ", ".join("?" * len(part))
                        cur.execute(
                            f"DELETE FROM search_dirty WHERE rid IN ({marks})",
                            list(part),
                        )
                    self._conn.commit()
                except Exception:
                    self._conn.rollback()
                    raise
                finally:
                    cur.close()
        log.info(
            "library.db: re-indexed %d entries changed outside this build",
            len(ordered),
        )

    def _sync_search(self, cur: sqlite3.Cursor, rids: Sequence[int]) -> None:
        """Make the index hold exactly the current text of these rowids.

        For each chunk: remove what the index holds for them -- the fts5
        'delete's read the indexed values back out of ``entries_search_text``,
        which is the only place they can come from exactly (the grams are
        recomputed from those same values) -- then write the text of every
        rowid that is still an entry. A rowid with no entry (deleted, by this
        build or another) is simply left out.
        """
        ids = sorted({int(rid) for rid in rids})
        for chunk in _chunks(ids, _MAX_SQL_PARAMS):
            marks = ", ".join("?" * len(chunk))
            params = list(chunk)
            if self.fts_enabled:
                self._unindex_search(cur, marks, params)
            cur.execute(
                f"DELETE FROM entries_search_head WHERE rid IN ({marks})", params
            )
            cur.execute(
                f"DELETE FROM entries_search_body WHERE rid IN ({marks})", params
            )
            texts = [
                (int(row["rid"]), *search_text(row))
                for row in cur.execute(_search_rows_sql(marks), params).fetchall()
            ]
            if not texts:
                continue
            cur.executemany(
                "INSERT INTO entries_search_head (rid, head) VALUES (?, ?)",
                [(rid, head) for rid, head, _ in texts],
            )
            cur.executemany(
                "INSERT INTO entries_search_body (rid, body) VALUES (?, ?)",
                [(rid, body) for rid, _, body in texts if body],
            )
            if self.fts_enabled:
                cur.executemany(
                    "INSERT INTO entries_search (rowid, head, body) VALUES (?, ?, ?)",
                    texts,
                )
                cur.executemany(
                    "INSERT INTO entries_search_short (rowid, grams) VALUES (?, ?)",
                    [(rid, short_grams(head, body)) for rid, head, body in texts],
                )

    @staticmethod
    def _unindex_search(cur: sqlite3.Cursor, marks: str, params: list[Any]) -> None:
        """Remove the fts5 rows of the rowids in ``params`` (``marks`` is its
        placeholder list), handing each index back exactly what it was given.
        The head and body rows are left for the caller."""
        indexed = cur.execute(
            f"SELECT rid, head, body FROM entries_search_text WHERE rid IN ({marks})",
            params,
        ).fetchall()
        if not indexed:
            return
        cur.executemany(
            "INSERT INTO entries_search(entries_search, rowid, head, body) "
            "VALUES ('delete', ?, ?, ?)",
            [(r["rid"], r["head"], r["body"]) for r in indexed],
        )
        cur.executemany(
            "INSERT INTO entries_search_short(entries_search_short, rowid, grams) "
            "VALUES ('delete', ?, ?)",
            [(r["rid"], short_grams(r["head"], r["body"])) for r in indexed],
        )

    def _sync_dirty(self, cur: sqlite3.Cursor) -> None:
        """Re-index the rows this transaction's writes touched (the triggers
        listed them in ``search_dirty``), inside the same transaction, so a
        committed write and its index entry can never disagree."""
        if not self.search_ready:
            return
        rids = [int(r["rid"]) for r in cur.execute(_DIRTY_ROWIDS_SQL)]
        if not rids:
            return
        self._sync_search(cur, rids)
        cur.execute("DELETE FROM search_dirty")

    # ---- Connection helper --------------------------------------------------

    # One revision per committed mutating transaction. EVERY writing method
    # goes through ``_txn`` (reads take ``_writelock`` and a bare cursor), so
    # the bump belongs here and no writer can commit without moving it --
    # deletes and cascades included. The statement is read-modify-write in a
    # single SQL step and ``_writelock`` serializes writers, so the sequence
    # is strictly increasing and never repeats a value. A rolled-back
    # transaction rolls the bump back with it.
    #
    # ``_txn(bump_revision=False)`` is the ONE exception, and it is not a
    # loophole: the revision is a cache-invalidation signal, not a write
    # counter. A client reads it as "the library moved under us" and throws
    # away every cached page and facet answer it holds
    # (``applyPage`` in frontend/src/state/libraryStore.ts). A write that
    # changes nothing a client caches -- no column any list shows, no tag, no
    # index, no ordering -- must not fire it, or an ordinary first scroll
    # through the library becomes cache thrash. Reserved for exactly that:
    # :meth:`set_entry_metadata` and :meth:`fill_entry_providers`, whose
    # values were already in the response that caused the write, and the
    # analysis engine's status updates when it asks for it. Anything that
    # changes what a client could be showing keeps the default.
    #
    # Every transaction also brings the search index along before it commits
    # (:meth:`_sync_dirty`), whichever way the revision goes.
    _BUMP_REVISION_SQL = """
        INSERT INTO schema_meta (key, value) VALUES ('library_revision', '1')
        ON CONFLICT(key) DO UPDATE
            SET value = CAST(CAST(schema_meta.value AS INTEGER) + 1 AS TEXT)
    """

    @contextmanager
    def _txn(self, *, bump_revision: bool = True) -> Iterator[sqlite3.Cursor]:
        with self._writelock:
            cur = self._conn.cursor()
            try:
                yield cur
                self._sync_dirty(cur)
                if bump_revision:
                    cur.execute(self._BUMP_REVISION_SQL)
                self._conn.commit()
            except Exception:
                self._conn.rollback()
                raise
            finally:
                cur.close()

    # ---- Entry CRUD ---------------------------------------------------------

    def upsert_entry(self, payload: dict[str, Any]) -> None:
        """Insert or update a single entry row from a flattened payload.
        Unknown keys are silently ignored; missing keys keep defaults."""
        now = _now()
        row = _entry_row(payload)
        entry_id = row["id"]
        # The search index follows by itself: the triggers list this row as
        # dirty and `_txn` re-indexes it before the commit.
        with self._txn() as cur:
            existing = cur.execute(
                "SELECT created_at FROM entries WHERE id = ?", (entry_id,)
            ).fetchone()
            created_at = existing["created_at"] if existing else now
            cur.execute(
                _UPSERT_ENTRY_SQL,
                {**row, "created_at": created_at, "updated_at": now},
            )
            # Refresh tag_index for this entry.
            cur.execute("DELETE FROM tag_index WHERE entry_id = ?", (entry_id,))
            cur.executemany(
                "INSERT OR IGNORE INTO tag_index (entry_id, tag) VALUES (?, ?)",
                _entry_tag_rows(payload, entry_id),
            )
            # Refresh prompt_corpus 'positive' + 'negative' rows from row data.
            cur.execute(
                "DELETE FROM prompt_corpus WHERE entry_id = ? AND prompt_kind IN ('positive', 'negative')",
                (entry_id,),
            )
            cur.executemany(
                "INSERT INTO prompt_corpus (entry_id, prompt_kind, prompt_text) VALUES (?, ?, ?)",
                _entry_prompt_rows(row),
            )

    def upsert_entries_bulk(
        self,
        records: Iterable[dict[str, Any]],
        batch: int = 1000,
    ) -> int:
        """Write many entries with ONE transaction (and one ``library_revision``
        bump) per ``batch``, rather than one per row.

        This is the import path for a large folder: 200,000 calls to
        :meth:`upsert_entry` means 200,000 committed transactions, 200,000
        revision bumps, and an fsync storm. Rows are identical to what
        ``upsert_entry`` writes -- both go through :func:`_entry_row` -- and
        ``created_at`` is preserved on rows that already exist, because the
        ON CONFLICT branch never sets it.

        ``records`` is consumed lazily, so a caller can stream a huge import
        without materializing it. Returns the number of records written.
        """
        if int(batch) < 1:
            raise ValueError(f"batch must be >= 1, got {batch!r}")
        written = 0
        pending: list[dict[str, Any]] = []
        for payload in records:
            pending.append(payload)
            if len(pending) >= batch:
                written += self._write_entry_batch(pending)
                pending = []
        if pending:
            written += self._write_entry_batch(pending)
        return written

    def _write_entry_batch(self, payloads: list[dict[str, Any]]) -> int:
        now = _now()
        rows = [_entry_row(p) for p in payloads]
        # A payload repeated inside one batch is still one row: the IN-list
        # statements below name each id once.
        unique_ids = list(dict.fromkeys(r["id"] for r in rows))
        tag_rows: list[tuple[str, str]] = []
        prompt_rows: list[tuple[str, str, str]] = []
        for payload, row in zip(payloads, rows):
            tag_rows.extend(_entry_tag_rows(payload, row["id"]))
            prompt_rows.extend(_entry_prompt_rows(row))

        with self._txn() as cur:
            cur.executemany(
                _UPSERT_ENTRY_SQL,
                [{**r, "created_at": now, "updated_at": now} for r in rows],
            )
            for chunk in _chunks(unique_ids, _MAX_SQL_PARAMS):
                marks = ", ".join("?" * len(chunk))
                cur.execute(
                    f"DELETE FROM tag_index WHERE entry_id IN ({marks})", list(chunk)
                )
                cur.execute(
                    f"DELETE FROM prompt_corpus WHERE entry_id IN ({marks}) "
                    "AND prompt_kind IN ('positive', 'negative')",
                    list(chunk),
                )
            cur.executemany(
                "INSERT OR IGNORE INTO tag_index (entry_id, tag) VALUES (?, ?)",
                tag_rows,
            )
            cur.executemany(
                "INSERT INTO prompt_corpus (entry_id, prompt_kind, prompt_text) VALUES (?, ?, ?)",
                prompt_rows,
            )
        return len(rows)

    def set_entry_metadata(
        self, metadata_by_id: Mapping[str, Mapping[str, Any]]
    ) -> int:
        """Replace ``metadata_json`` on rows that ALREADY exist, and nothing else.

        Deliberately narrower than :meth:`upsert_entry`, which is the path a
        user edit takes: no column is written, so ``updated_at`` keeps the
        value the last real edit left on it and every sort order stays where
        it was; the tag index and the prompt corpus are not rebuilt; and an id
        with no row inserts nothing. That is what lets the read path record a
        fact it DERIVED about a row without the row looking edited. The search
        index does follow the new metadata, as it follows every write: the
        triggers list the row and ``_txn`` re-indexes it.

        The ONE exception is the ``provider`` column, which is written in the
        same statement from the same dict (:func:`resolved_provider_slug`).
        That is not a second write to keep in step -- it is the same write:
        :data:`PROVIDER_SQL` reads the column, so a metadata update that
        renamed an entry's provider while leaving the column behind would
        label the row one way and file it another, which is the exact
        disagreement this method's caller exists to end. Neither is an edit:
        no sort order or timestamp can notice either.

        Otherwise only safe for metadata keys no column mirrors: the entry
        columns are written from their own payload fields, so a caller that
        changes one of those must go through :meth:`upsert_entry` instead.
        Its one caller, :meth:`~.store.LibraryStore.record_detected_providers`,
        adds only the ``provider*`` keys.

        One transaction for the whole mapping, and NO ``library_revision``
        bump: the revision tells a client its cached pages are stale, and
        nothing a client caches changed here. The rows whose metadata this
        writes were in the response that decided to write it, already
        carrying the values being stored, so a client holding that page is
        not holding a stale label. What does change is which slug the SQL
        filter files the row under, and that is only ever read by a fresh
        request -- changing the provider filter clears the page cache and
        refetches on its own. See the note on ``_BUMP_REVISION_SQL``.

        Returns the number of rows actually updated.
        """
        rows = [
            (
                json.dumps(dict(meta)),
                resolved_provider_slug(meta),
                str(entry_id),
            )
            for entry_id, meta in metadata_by_id.items()
        ]
        if not rows:
            return 0
        with self._txn(bump_revision=False) as cur:
            cur.executemany(
                "UPDATE entries SET metadata_json = ?, provider = ? WHERE id = ?",
                rows,
            )
            return int(cur.rowcount or 0)

    def fill_entry_providers(self, provider_by_id: Mapping[str, str]) -> int:
        """Fill the resolved ``provider`` column on rows that do not have one.

        The lazy half of the column's life. A row imported or labeled before
        the column existed carries its provider in ``metadata_json`` and NULL
        in the column, so :data:`PROVIDER_SQL` answers for it with the
        fallback. The read path already parsed that metadata to build the
        response, so it knows the right slug for free: it hands the answer
        here and the row is resolved, once, with no query to find candidates
        and no walk of the library.

        ``WHERE provider IS NULL`` is what makes it once-only and safe:

        * a row already resolved is never rewritten, so this can never
          overwrite an importer's, a user's or the write-through's answer --
          the same never-overwrite rule the metadata blob lives under, spelled
          in the WHERE clause so two threads racing on one row cannot both
          win with different values;
        * calling it again for the same entry updates nothing, so a second
          view of the same page costs one statement and zero writes.

        Like :meth:`set_entry_metadata` this writes no other column, rebuilds
        no index, and does NOT bump ``library_revision``: the rows are the
        ones the request is already returning, carrying the label being
        stored, so no client's cache became stale. Returns how many rows were
        actually filled.
        """
        rows = [
            (slug, str(entry_id))
            for entry_id, slug in provider_by_id.items()
            if slug and str(entry_id)
        ]
        if not rows:
            return 0
        with self._txn(bump_revision=False) as cur:
            cur.executemany(
                "UPDATE entries SET provider = ? WHERE id = ? AND provider IS NULL",
                rows,
            )
            return int(cur.rowcount or 0)

    def get_entry(self, entry_id: str) -> Optional[dict[str, Any]]:
        with self._writelock:
            cur = self._conn.cursor()
            row = cur.execute(
                "SELECT * FROM entries WHERE id = ?", (entry_id,)
            ).fetchone()
            cur.close()
            return dict(row) if row else None

    def _entry_rows_in_chunks(
        self, columns: str, *, chunk: int = WHOLE_TABLE_READ_CHUNK
    ) -> list[dict[str, Any]]:
        """Every ``entries`` row's ``columns``, read ``chunk`` rows at a time
        in rowid order, with the write lock taken per chunk.

        A whole-table read under one hold of the lock kept every other
        library call waiting for it: at 200,000 rows ``SELECT * FROM
        entries`` (the notation backfill runs it on every start) held the
        lock for seconds, longer still while another thread kept the GIL
        busy, and a library search waited behind it. A write that lands
        between two chunks is seen or not depending on its rowid, which is
        what a read a moment earlier or later would have seen too."""
        out: list[dict[str, Any]] = []
        last = -(2**63)
        while True:
            with self._writelock:
                rows = self._conn.execute(
                    f"SELECT rowid AS _chunk_rowid, {columns} FROM entries "
                    "WHERE rowid > ? ORDER BY rowid LIMIT ?",
                    (last, chunk),
                ).fetchall()
            if not rows:
                return out
            last = int(rows[-1]["_chunk_rowid"])
            for row in rows:
                item = dict(row)
                del item["_chunk_rowid"]
                out.append(item)
            if len(rows) < chunk:
                return out

    def list_entries(self) -> list[dict[str, Any]]:
        """Every entry, newest first. Read in chunks
        (:meth:`_entry_rows_in_chunks`) and sorted here, so no single hold of
        the write lock lasts the whole table. The chunks arrive in rowid
        order and the sort is stable, so entries created in one clock tick
        keep rowid order (``created_at DESC, rowid ASC``)."""
        rows = self._entry_rows_in_chunks("*")
        rows.sort(key=lambda r: r.get("created_at") or 0.0, reverse=True)
        return rows

    def list_entries_filtered(
        self,
        *,
        source: Optional[str] = None,
        tag: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        join = ""
        if source:
            clauses.append("e.source = ?")
            params.append(source)
        if tag:
            join = "JOIN tag_index t ON t.entry_id = e.id"
            clauses.append("t.tag = ?")
            params.append(tag)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        limit_sql = f"LIMIT {int(limit)}" if limit else ""
        sql = f"""
            SELECT e.* FROM entries e {join}
            {where}
            ORDER BY e.created_at DESC, e.rowid ASC
            {limit_sql}
        """
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(sql, params).fetchall()
            cur.close()
            return [dict(r) for r in rows]

    def list_entries_with_analysis(self) -> list[dict[str, Any]]:
        """Each entry joined with its analysis row (bpm / key / scale / genre /
        loudness). Analysis columns are NULL for entries not yet analyzed. The
        playlist suggester sequences on bpm + harmonic key from this."""
        sql = """
            SELECT
                e.id, e.title, e.prompt, e.model, e.duration_sec, e.source,
                e.favorite, e.play_count, e.last_played_at,
                a.bpm, a.key, a.scale, a.genre, a.loudness_lufs, a.bars_estimated
            FROM entries e
            LEFT JOIN analysis a ON a.entry_id = e.id
            ORDER BY e.created_at DESC, e.rowid ASC
        """
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(sql).fetchall()
            cur.close()
            return [dict(r) for r in rows]

    def delete_entry(self, entry_id: str) -> bool:
        with self._txn() as cur:
            cur.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
            deleted = cur.rowcount > 0
            # ``relations`` is polymorphic (from_id / to_id may reference a
            # stem, midi, or even an external source label string) so there's
            # no FK cascade. Wipe edges that reference this entry by id.
            cur.execute(
                "DELETE FROM relations WHERE from_id = ? OR to_id = ?",
                (entry_id, entry_id),
            )
            return deleted

    def existing_entry_ids(self, entry_ids: Sequence[str]) -> set[str]:
        """Which of these ids have a row. Lets a bulk delete tell "this entry
        is gone" from "this entry never existed" without a query per id."""
        ids = [str(entry_id) for entry_id in entry_ids]
        if not ids:
            return set()
        found: set[str] = set()
        with self._writelock:
            cur = self._conn.cursor()
            try:
                for chunk in _chunks(ids, _MAX_SQL_PARAMS):
                    marks = ", ".join("?" * len(chunk))
                    rows = cur.execute(
                        f"SELECT id FROM entries WHERE id IN ({marks})", list(chunk)
                    ).fetchall()
                    found.update(str(r["id"]) for r in rows)
            finally:
                cur.close()
        return found

    def new_or_changed_entry_ids(self, payloads: Sequence[dict[str, Any]]) -> list[str]:
        """Which of these :func:`_entry_row`-shaped upsert payloads are a new
        row, or differ from what is already stored, by ``file_size_bytes``,
        ``duration_sec``, and ``audio_filename``.

        MUST be called before the matching upsert commits -- it reads the
        pre-upsert state to compare against. Lets :meth:`LibraryStore.reindex`
        enqueue analysis only for entries it actually changed, instead of
        every entry in the library on every reindex pass (LIB-002).
        """
        rows = [_entry_row(p) for p in payloads]
        ids = [row["id"] for row in rows]
        if not ids:
            return []
        prior: dict[str, tuple[int, float, str]] = {}
        with self._writelock:
            cur = self._conn.cursor()
            try:
                for chunk in _chunks(ids, _MAX_SQL_PARAMS):
                    marks = ", ".join("?" * len(chunk))
                    for r in cur.execute(
                        "SELECT id, file_size_bytes, duration_sec, audio_filename "
                        f"FROM entries WHERE id IN ({marks})",
                        list(chunk),
                    ).fetchall():
                        prior[str(r["id"])] = (
                            int(r["file_size_bytes"]),
                            float(r["duration_sec"]),
                            str(r["audio_filename"]),
                        )
            finally:
                cur.close()
        changed: list[str] = []
        for row in rows:
            fingerprint = (
                row["file_size_bytes"],
                row["duration_sec"],
                row["audio_filename"],
            )
            if prior.get(row["id"]) != fingerprint:
                changed.append(row["id"])
        return changed

    def entries_summary_for(
        self,
        entry_ids: Sequence[str],
        *,
        json_keys: Sequence[str] = (),
    ) -> dict[str, dict[str, Any]]:
        """The user-owned columns of these entries, plus chosen ``metadata_json`` keys.

        The sibling of :meth:`existing_entry_ids` for a writer that has to
        MERGE rather than overwrite: a bulk re-import needs to know, for a page
        of ids at a time, which already exist and what the user has since done
        to them -- without pulling ``metadata_json`` (kilobytes of provider
        record per row) back for every one.

        ``json_keys`` are JSON paths (``'$.suno_revision'``); each is bound as
        a parameter, never interpolated, and lands in the result under its own
        name. Missing ids are simply absent from the mapping.
        """
        ids = [str(entry_id) for entry_id in entry_ids]
        if not ids:
            return {}
        paths = [str(key) for key in json_keys]
        projection = "".join(
            f", CASE WHEN json_valid(metadata_json)"
            f" THEN json_extract(metadata_json, ?) END AS j{index}"
            for index in range(len(paths))
        )
        out: dict[str, dict[str, Any]] = {}
        with self._writelock:
            cur = self._conn.cursor()
            try:
                for chunk in _chunks(ids, _MAX_SQL_PARAMS - len(paths)):
                    marks = ", ".join("?" * len(chunk))
                    rows = cur.execute(
                        f"SELECT id, title, favorite, rating, notes, source,"
                        f" timestamp{projection} FROM entries WHERE id IN ({marks})",
                        [*paths, *chunk],
                    ).fetchall()
                    for row in rows:
                        summary = {
                            "id": str(row["id"]),
                            "title": row["title"],
                            "favorite": bool(row["favorite"]),
                            "rating": row["rating"],
                            "notes": row["notes"],
                            "source": row["source"],
                            "timestamp": row["timestamp"],
                        }
                        for index, key in enumerate(paths):
                            summary[key] = row[f"j{index}"]
                        out[summary["id"]] = summary
            finally:
                cur.close()
        return out

    def delete_entries_bulk(
        self, entry_ids: Sequence[str], *, batch: int = DEFAULT_DELETE_BATCH
    ) -> int:
        """Delete many entries, ONE transaction per batch. Returns the number of
        rows actually removed.

        Does exactly what :meth:`delete_entry` does, a batch at a time: the
        rows go (cascading to analysis / stems / midis / tags / prompts /
        notation / shards), the polymorphic ``relations`` edges that name these
        ids are wiped by hand because they have no foreign key, and the search
        index drops them before the batch commits (the delete trigger lists
        them for ``_txn``).

        One revision bump per batch, not per row: clearing 50,000 entries must
        not push ``library_revision`` forward 50,000 times and make every
        connected client refetch that many times. Ids that are not there are
        simply not deleted -- the caller decides whether that is an error.
        """
        ids = [str(entry_id) for entry_id in entry_ids]
        if not ids:
            return 0
        # Two of the statements below carry the chunk as an ``IN (...)`` list,
        # so a batch can never exceed the parameter ceiling.
        size = max(1, min(int(batch), _MAX_SQL_PARAMS))
        removed = 0
        with self.checkpoint_once():
            for chunk in _chunks(ids, size):
                marks = ", ".join("?" * len(chunk))
                params = list(chunk)
                with self._txn() as cur:
                    cur.execute(f"DELETE FROM entries WHERE id IN ({marks})", params)
                    removed += cur.rowcount
                    # Split rather than ``from_id IN (...) OR to_id IN (...)``
                    # so one batch is never two parameter lists wide, and so
                    # each half can use its own index.
                    cur.execute(
                        f"DELETE FROM relations WHERE from_id IN ({marks})", params
                    )
                    cur.execute(
                        f"DELETE FROM relations WHERE to_id IN ({marks})", params
                    )
        return removed

    @contextmanager
    def checkpoint_once(self) -> Iterator[None]:
        """Hold WAL checkpoints back for a run of batch commits, then run ONE.

        Every batch of a bulk delete rewrites the same hot pages -- the
        entries indexes, the search index, the cascade tables -- and past
        ``wal_autocheckpoint`` pages each commit copies them all back into the
        database file again: measured at half the time of a 10,000-row delete.
        Deferred, each page is copied once. The checkpoint at the end is
        PASSIVE, so it never waits on, or blocks, a reader or another writer;
        whatever it cannot copy is left to the next automatic one.

        Nests: only the outermost block checkpoints. The store wraps its whole
        bulk delete in one, because it calls :meth:`delete_entries_bulk` once
        per batch, and a checkpoint per 500-row batch cost 10 of the 21 s a
        50,000-row delete took.
        """
        with self._writelock:
            outermost = self._checkpoint_depth == 0
            self._checkpoint_depth += 1
            if outermost:
                row = self._conn.execute("PRAGMA wal_autocheckpoint").fetchone()
                self._checkpoint_previous = int(row[0]) if row is not None else 1000
                self._conn.execute("PRAGMA wal_autocheckpoint = 0")
        try:
            yield
        finally:
            with self._writelock:
                self._checkpoint_depth -= 1
                if outermost:
                    self._conn.execute(
                        f"PRAGMA wal_autocheckpoint = {self._checkpoint_previous}"
                    )
                    self._conn.execute("PRAGMA wal_checkpoint(PASSIVE)").fetchall()

    def all_entry_ids(self) -> list[str]:
        """Every entry id, read in chunks (:meth:`_entry_rows_in_chunks`)."""
        return [r["id"] for r in self._entry_rows_in_chunks("id")]

    def count_entries(self) -> int:
        with self._writelock:
            cur = self._conn.cursor()
            row = cur.execute("SELECT COUNT(*) AS c FROM entries").fetchone()
            cur.close()
            return int(row["c"]) if row else 0

    # ---- Paged / filtered / searched listing ---------------------------------
    #
    # Everything below answers in SQL: no per-row filesystem access, no
    # json.loads of metadata_json for a field that is already a column, and
    # play_count read from the row it belongs to instead of a second pass over
    # the whole table. The store builds records for the PAGE only.

    def _search_rids_sql(self, q: str) -> Optional[tuple[str, list[Any]]]:
        """``(select, params)``: one ``SELECT rid`` of the rowids a free-text
        search matches -- main's matcher in SQL -- or None when ``q`` says
        nothing (a blank search matches nothing; the list without a search is
        the request that omits ``q``).

        An entry matches when every word of ``q`` (:func:`search_words`)
        occurs in its search text (see "Search index"), OR -- when ``q`` reads
        as a number the way ``parseFloat`` reads it -- when its duration
        rounds to that number of seconds or of minutes. Main tested the whole
        query as one substring, and every word of a substring that occurs
        occurs too, so this finds everything main's matcher found.

        The rowids are never matched one entry at a time: written as a join
        that SQLite drives from the ``kind`` index, fts5 is asked "does THIS
        rowid match?" once per row -- measured at 18.8 s for one page on
        200,000 rows. :meth:`_filter_sql` and :meth:`_source_sql` use this
        select only as a whole set.

        No rowid is listed twice, so an aggregate can drive from the select
        as it stands. The duration arm seeks ``idx_entries_duration`` and
        leaves out the rows the text arm already lists, by testing the same
        words on those rows' text; a ``UNION`` would instead sort every
        matching rowid into a temporary b-tree to remove the repeats.

        While a background build of the index runs, the select matches the
        rows indexed so far and never waits for the rest: a search that waited
        held a request thread for the whole build, 52 to 170 s at 200,000
        rows. :meth:`search_status` says how much of the library that is. A
        build that stopped raises :class:`SearchIndexFailed` here
        (:meth:`_raise_if_search_failed`).
        """
        raw = q.strip()
        if not raw:
            return None
        self._raise_if_search_failed()
        words = search_words(raw)
        text_sql, params = self._text_match_sql(words)
        number = js_parse_float(raw)
        if number is None:
            return text_sql, params
        # Math.round(duration) === Math.round(n), and the same in minutes.
        target = js_round(number)
        bounds = [
            bound
            for scale in (1.0, 60.0)
            for bound in ((target - 0.5) * scale, (target + 0.5) * scale)
        ]
        in_text = " AND ".join(
            "(instr(COALESCE(h.head, ''), ?) > 0 OR instr(COALESCE(b.body, ''), ?) > 0)"
            for _ in words
        )
        duration_sql = (
            "SELECT d.rowid AS rid FROM entries d "
            "LEFT JOIN entries_search_head h ON h.rid = d.rowid "
            "LEFT JOIN entries_search_body b ON b.rid = d.rowid "
            "WHERE ((d.duration_sec >= ? AND d.duration_sec < ?) "
            "OR (d.duration_sec >= ? AND d.duration_sec < ?)) "
            f"AND NOT ({in_text})"
        )
        params.extend(bounds)
        params.extend(v for w in words for v in (w, w))
        # Each arm wrapped, so nothing inside one can bind to its neighbour.
        return (
            f"SELECT rid FROM ({text_sql}) UNION ALL SELECT rid FROM ({duration_sql})",
            params,
        )

    def _text_match_sql(self, tokens: Sequence[str]) -> tuple[str, list[Any]]:
        """One ``SELECT rid`` of the rowids whose search text holds every one
        of ``tokens`` (at least one; :meth:`_search_rids_sql` never passes
        none), in the head or the body alike.

        Words of three characters or more are answered by the trigram index
        and shorter ones by ``entries_search_short``. When a query has both,
        the trigram index narrows and each short word is tested with
        ``instr`` on the candidates' head and body, looked up by primary key:
        measured at 200,000 rows that is cheaper than intersecting two fts5
        results, which sorts both sets into a temporary b-tree.

        Without fts5 the text tables are scanned with ``instr``: slower, the
        same answers.
        """
        long_tokens = [t for t in tokens if len(t) > SHORT_WORD_MAX]
        short_tokens = [t for t in tokens if len(t) <= SHORT_WORD_MAX]
        in_text = "(instr(h.head, ?) > 0 OR instr(COALESCE(b.body, ''), ?) > 0)"
        if self.fts_enabled:
            match = " ".join(_fts_phrase(t) for t in long_tokens)
            if not short_tokens:
                return (
                    "SELECT rowid AS rid FROM entries_search "
                    "WHERE entries_search MATCH ?",
                    [match],
                )
            if not long_tokens:
                return (
                    "SELECT rowid AS rid FROM entries_search_short "
                    "WHERE entries_search_short MATCH ?",
                    [" ".join(_gram_token(t) for t in short_tokens)],
                )
            return (
                "SELECT h.rid AS rid FROM entries_search s "
                "CROSS JOIN entries_search_head h ON h.rid = s.rowid "
                "LEFT JOIN entries_search_body b ON b.rid = h.rid "
                "WHERE s.entries_search MATCH ? AND "
                + " AND ".join(in_text for _ in short_tokens),
                [match, *(v for t in short_tokens for v in (t, t))],
            )
        return (
            "SELECT h.rid AS rid FROM entries_search_head h "
            "LEFT JOIN entries_search_body b ON b.rid = h.rid WHERE "
            + " AND ".join(in_text for _ in tokens),
            [v for t in tokens for v in (t, t)],
        )

    def _filter_sql(self, filters: EntryFilters) -> tuple[str, list[Any]]:
        """``(where, params)`` for one :class:`EntryFilters`, the search as
        ``e.rowid IN (...)``: the shape for a sorted page, which walks the
        sort's index and stops after one page, however many rows match."""
        clauses: list[str] = []
        params: list[Any] = []
        if filters.q is not None:
            search = self._search_rids_sql(filters.q)
            if search is None:
                clauses.append("0")
            else:
                clauses.append(f"e.rowid IN ({search[0]})")
                params.extend(search[1])
        rest, rest_params = self._column_filter_sql(filters)
        clauses.extend(rest)
        params.extend(rest_params)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        return where, params

    def _source_sql(self, filters: EntryFilters) -> tuple[str, list[Any]]:
        """``(from_and_where, params)`` for an aggregate over everything
        ``filters`` matches (a count, the stats chips). A text search drives:
        its rowids come out of fts5 in rowid order, and each entry is looked
        up by primary key in that order, where the ``IN`` shape first copies
        every matching rowid into a temporary index (measured at 200,000
        matches: 67 ms against 162 ms for a count, 104 ms against 155 ms for
        the stats).

        A query that also reads as a duration keeps the ``IN`` shape: the
        duration arm lists rowids in duration order, and looking those up one
        by one in the table reads its pages at random (145 ms for the 7,821
        rows three minutes matched on 200,000)."""
        search = None if filters.q is None else self._search_rids_sql(filters.q)
        if search is None or js_parse_float(filters.q.strip()) is not None:
            where, params = self._filter_sql(filters)
            return f"entries e {where}", params
        clauses, params = self._column_filter_sql(filters)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        return (
            f"({search[0]}) s CROSS JOIN entries e NOT INDEXED ON e.rowid = s.rid "
            f"{where}",
            [*search[1], *params],
        )

    @staticmethod
    def _column_filter_sql(filters: EntryFilters) -> tuple[list[str], list[Any]]:
        """The clauses and params of every filter but the search."""
        clauses: list[str] = []
        params: list[Any] = []
        if filters.kinds is not None:
            kinds = sorted(filters.kinds)
            if not kinds:
                clauses.append("0")
            elif len(kinds) == 1:
                # The single-kind form (every library tab but "all") is what
                # the idx_entries_kind_* composites are built for.
                clauses.append("e.kind = ?")
                params.append(kinds[0])
            else:
                clauses.append(f"e.kind IN ({', '.join('?' * len(kinds))})")
                params.extend(kinds)
        if filters.favorite is not None:
            clauses.append("e.favorite = ?")
            params.append(1 if filters.favorite else 0)
        if filters.source:
            clauses.append("e.source = ?")
            params.append(filters.source)
        if filters.provider:
            # One expression, one comparison: an entry is filed under exactly
            # one slug, so no row can match two providers and none can be
            # missed. Slugs are lowercase by construction (`provider.py`
            # slugifies, `infer_provider` returns literals), so the parameter
            # is folded to match.
            clauses.append(f"{PROVIDER_SQL} = ?")
            params.append(str(filters.provider).strip().lower())
        return clauses, params

    @staticmethod
    def _order_sql(sort: str) -> str:
        try:
            return _SORT_SQL[sort]
        except KeyError:
            raise ValueError(
                f"sort must be one of {', '.join(SORTS)}, got {sort!r}"
            ) from None

    def list_entries_page(
        self,
        filters: EntryFilters,
        *,
        sort: str = DEFAULT_SORT,
        limit: int = 200,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """One page of ``entries`` rows, filtered / searched / sorted in SQL.

        ``play_count`` and ``last_played_at`` ride along on the row (they are
        columns), so nothing has to re-read the table to attach them. Raises
        ``ValueError`` for an unknown ``sort``."""
        order = self._order_sql(sort)
        where, params = self._filter_sql(filters)
        sql = f"SELECT e.* FROM entries e {where} ORDER BY {order} LIMIT ? OFFSET ?"
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(
                sql, [*params, max(0, int(limit)), max(0, int(offset))]
            ).fetchall()
            cur.close()
        return [dict(r) for r in rows]

    def count_entries_filtered(self, filters: EntryFilters) -> int:
        """How many entries match ``filters`` -- the ``total`` a paged client
        sizes its scrollbar from."""
        source, params = self._source_sql(filters)
        with self._writelock:
            cur = self._conn.cursor()
            row = cur.execute(f"SELECT COUNT(*) AS c FROM {source}", params).fetchone()
            cur.close()
            return int(row["c"]) if row else 0

    def list_entry_ids(
        self,
        filters: EntryFilters,
        cap: int,
        *,
        sort: str = DEFAULT_SORT,
    ) -> list[str]:
        """Matching entry ids in ``sort`` order, for select-all / shift-range.

        Returns at most ``cap + 1`` ids: the extra one is how the caller tells
        "more than the cap matched" (and answers 413) without paying for a
        second COUNT over the same predicate.
        """
        order = self._order_sql(sort)
        where, params = self._filter_sql(filters)
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(
                f"SELECT e.id FROM entries e {where} ORDER BY {order} LIMIT ?",
                [*params, max(0, int(cap)) + 1],
            ).fetchall()
            cur.close()
        return [str(r["id"]) for r in rows]

    def entry_stats(self, filters: EntryFilters) -> dict[str, Any]:
        """Totals over EVERYTHING ``filters`` matches -- the favourites, size
        and duration chips above the library list, which must not change as
        the user scrolls pages in and out.

        One aggregate over the same filters as the page query, so the chips
        and the list can never be about different rows. With a kind (and a
        favourite) filter it is a covering scan of ``idx_entries_kind_stats``;
        a search drives from its matching rowids (:meth:`_source_sql`) with a
        primary-key lookup per match, and a provider filter adds a row lookup
        per row.
        """
        source, params = self._source_sql(filters)
        with self._writelock:
            cur = self._conn.cursor()
            try:
                row = cur.execute(
                    "SELECT COUNT(*) AS n, TOTAL(e.favorite) AS favorites, "
                    "TOTAL(e.file_size_bytes) AS size_bytes, "
                    "TOTAL(e.duration_sec) AS duration_sec "
                    f"FROM {source}",
                    params,
                ).fetchone()
            finally:
                cur.close()
        return {
            "count": int(row["n"]),
            "favorites": int(row["favorites"]),
            "size_bytes": int(row["size_bytes"]),
            "duration_sec": float(row["duration_sec"]),
        }

    def resolve_entry_ref(self, ref: str) -> Optional[str]:
        """The audio entry a LOOM score or template names, or None.

        ``resolveEntryRef`` in frontend/src/state/shardIndexStore.ts, answered
        over the whole library instead of the rows a browser happens to hold,
        in the same order of preference: the exact id; an id that starts with
        ``ref`` (eight characters or more); then by title, folded the way
        :func:`fold_title` folds it -- equal, then starting with, then
        containing. Among several, the newest wins, which is the order the
        browser's list was in.

        Title candidates come from the search index (every token of the folded
        reference occurs in a folded title that contains it), so only the
        matching rows' ids and titles are read. While a background build of
        the index runs, the rows it has not reached yet are candidates too:
        their titles are folded and tested here, so a score opened during the
        build still finds its track.
        """
        text = str(ref or "")
        if not text.strip():
            return None
        with self._writelock:
            cur = self._conn.cursor()
            try:
                row = cur.execute(
                    "SELECT id FROM entries WHERE id = ? AND kind = 'audio'", (text,)
                ).fetchone()
                if row is not None:
                    return str(row["id"])
                if len(text) >= 8:
                    row = cur.execute(
                        "SELECT e.id AS id FROM entries e WHERE e.id >= ? "
                        "AND substr(e.id, 1, ?) = ? "
                        f"AND e.kind = 'audio' ORDER BY {_SORT_SQL[DEFAULT_SORT]} LIMIT 1",
                        (text, len(text), text),
                    ).fetchone()
                    if row is not None:
                        return str(row["id"])
                needle = fold_title(text)
                if not needle:
                    return None
                search = self._search_rids_sql(needle)
                assert search is not None  # a folded needle is never blank
                match = f"e.rowid IN ({search[0]})"
                params = list(search[1])
                floor = self._unindexed_after()
                if floor is not None:
                    match = f"({match} OR e.rowid > ?)"
                    params.append(floor)
                titled = [
                    (str(r["id"]), fold_title(str(r["title"] or "")))
                    for r in cur.execute(
                        "SELECT e.id AS id, e.title AS title FROM entries e "
                        f"WHERE {match} AND e.kind = 'audio' "
                        f"ORDER BY {_SORT_SQL[DEFAULT_SORT]}",
                        params,
                    ).fetchall()
                ]
            finally:
                cur.close()
        for accept in (
            lambda t: t == needle,
            lambda t: t.startswith(needle),
            lambda t: needle in t,
        ):
            for entry_id, folded in titled:
                if accept(folded):
                    return entry_id
        return None

    # ---- Facets --------------------------------------------------------------

    def facet_counts(
        self, filters: EntryFilters, fields: Sequence[str]
    ) -> dict[str, list[dict[str, Any]]]:
        """``{field: [{'value', 'count'}, ...]}`` over everything ``filters``
        matches -- not over a page of it.

        One aggregate query per field, sharing the page query's WHERE clause so
        a dropdown can never offer a value the list would not show. Values come
        back sorted by count descending, then by value ascending, with the
        "unset" bucket last, and are capped at :data:`MAX_FACET_VALUES`.

        Raises ``ValueError`` for a field outside :data:`FACET_FIELDS`.
        """
        wanted: list[str] = []
        for field in fields:
            if field not in FACET_FIELDS:
                raise ValueError(
                    f"fields must be among {', '.join(FACET_FIELDS)}, got {field!r}"
                )
            if field not in wanted:
                wanted.append(field)
        where, params = self._filter_sql(filters)
        out: dict[str, list[dict[str, Any]]] = {}
        with self._writelock:
            cur = self._conn.cursor()
            try:
                for field in wanted:
                    if field == "provider":
                        out[field] = self._provider_facet(cur, where, params)
                    else:
                        out[field] = self._column_facet(
                            cur, _FACET_COLUMNS[field], where, params
                        )
            finally:
                cur.close()
        return out

    @staticmethod
    def _column_facet(
        cur: sqlite3.Cursor, column: str, where: str, params: list[Any]
    ) -> list[dict[str, Any]]:
        """Counts for one column-backed facet.

        The nesting is load-bearing, not style. Grouping directly on
        ``NULLIF(col, '')`` -- which is what folds the empty string and SQL NULL
        into one "unset" bucket -- is an expression SQLite cannot match against
        an index, so it sorts every matching row into a temp b-tree: 96-111 ms
        at 200,000 rows. Grouping on the bare column in a subquery keeps the
        index order (the scan is covering and needs no sort at all), and the
        fold then runs over the handful of distinct values instead: 10-14 ms.
        """
        sql = (
            "SELECT v, SUM(c) AS n FROM ("
            f"  SELECT NULLIF({column}, '') AS v, COUNT(*) AS c"
            f"  FROM entries e {where}"
            f"  GROUP BY {column}"
            ") GROUP BY v ORDER BY n DESC, v IS NULL, v LIMIT ?"
        )
        rows = cur.execute(sql, [*params, MAX_FACET_VALUES]).fetchall()
        return [{"value": r["v"], "count": int(r["n"])} for r in rows]

    @staticmethod
    def _provider_facet(
        cur: sqlite3.Cursor, where: str, params: list[Any]
    ) -> list[dict[str, Any]]:
        """Counts for the ``provider`` facet.

        One query, grouped on the three COLUMNS the rule reads -- the resolved
        ``provider`` and the ``(model, source)`` its fallback reads -- inside
        the covering ``idx_entries_facet_provider`` index; the fold into slugs
        runs in Python over the distinct triples, a handful of rows, and is
        :data:`PROVIDER_SQL` spelled out: the column when it has an answer,
        :func:`infer_provider` when it does not.

        That fold is why a slug's count here and the number of rows
        ``provider=<slug>`` returns are the same number. It was NOT before:
        this used to group on ``(model, source)`` alone, because the other half
        of the rule was a ``json_extract`` over ``metadata_json`` and grouping
        on it meant reading every row's metadata -- 570 ms at 200,000 rows
        against a 300 ms budget. So an entry labeled at import was COUNTED
        under what its columns imply while the FILTER returned it under its
        stored label, and the divergence was documented rather than fixed.
        Resolving that half into a column put it in the group key for the price
        of one more column in the index.

        Grouping on :data:`PROVIDER_SQL` itself would be more obviously one
        rule, and is affordable now in the sense that it opens no metadata --
        but SQLite does not treat an index on an EXPRESSION as covering, so it
        costs a table lookup per row: 348 ms at 60,000 rows against 6 ms here.
        """
        # ``kind`` leads the group key although no slug depends on it: it leads
        # the index too, so grouping by it keeps the whole aggregate inside the
        # covering index in index ORDER -- no temp b-tree and no table lookup
        # -- for the ``?kind=all`` tab, where nothing constrains that column.
        # It costs one more distinct row per kind for the fold below to sum.
        rows = cur.execute(
            "SELECT e.provider AS p, e.model AS m, e.source AS s, COUNT(*) AS c "
            f"FROM entries e {where} GROUP BY e.kind, e.provider, e.model, e.source",
            params,
        ).fetchall()
        tally: dict[str, int] = {}
        for row in rows:
            # `or` and not `is None`: the SQL side folds a blank column to
            # unresolved with NULLIF, so this has to as well.
            provider = row["p"] or infer_provider(row["m"], row["s"])
            tally[provider] = tally.get(provider, 0) + int(row["c"])
        ranked = sorted(tally.items(), key=lambda kv: (-kv[1], kv[0]))
        return [
            {"value": value, "count": count}
            for value, count in ranked[:MAX_FACET_VALUES]
        ]

    def play_counts_for(self, entry_ids: Sequence[str]) -> dict[str, dict[str, Any]]:
        """``{id: {'play_count', 'last_played_at'}}`` for these ids only.

        The list endpoint used to read the ENTIRE entries table to attach play
        counts to a page of 200 rows."""
        out: dict[str, dict[str, Any]] = {}
        if not entry_ids:
            return out
        with self._writelock:
            cur = self._conn.cursor()
            for chunk in _chunks(list(entry_ids), _MAX_SQL_PARAMS):
                marks = ", ".join("?" * len(chunk))
                for row in cur.execute(
                    "SELECT id, play_count, last_played_at FROM entries "
                    f"WHERE id IN ({marks})",
                    list(chunk),
                ).fetchall():
                    out[str(row["id"])] = {
                        "play_count": int(row["play_count"] or 0),
                        "last_played_at": row["last_played_at"],
                    }
            cur.close()
        return out

    def all_play_counts(self) -> dict[str, dict[str, Any]]:
        """``{id: {'play_count', 'last_played_at'}}`` for EVERY entry -- the
        unpaged sibling of :meth:`play_counts_for`, for the list endpoint's
        no-filter ("select all") path.

        Reads only these three columns rather than every column of every row
        (LIB-004): ``_attach_play_counts`` used to call :meth:`list_entries`
        (``SELECT *``, including ``metadata_json``) just to read two fields,
        which is ruinous once the library has 200,000 rows.
        """
        out: dict[str, dict[str, Any]] = {}
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(
                "SELECT id, play_count, last_played_at FROM entries"
            ).fetchall()
            cur.close()
        for row in rows:
            out[str(row["id"])] = {
                "play_count": int(row["play_count"] or 0),
                "last_played_at": row["last_played_at"],
            }
        return out

    def get_analysis_for(self, entry_ids: Sequence[str]) -> dict[str, dict[str, Any]]:
        """Analysis rows for these ids only -- the page-sized sibling of
        :meth:`get_all_analysis`, which loads every analyzed entry."""
        out: dict[str, dict[str, Any]] = {}
        if not entry_ids:
            return out
        with self._writelock:
            cur = self._conn.cursor()
            for chunk in _chunks(list(entry_ids), _MAX_SQL_PARAMS):
                marks = ", ".join("?" * len(chunk))
                for row in cur.execute(
                    f"SELECT * FROM analysis WHERE entry_id IN ({marks})", list(chunk)
                ).fetchall():
                    out[str(row["entry_id"])] = dict(row)
            cur.close()
        return out

    def registered_source_paths(self) -> set[str]:
        """Every ``source_path`` a reference-in-place entry already points at.

        One scan answers "which of these 200,000 files do I already have?" for
        a whole import, which is what makes re-running a folder import cheap
        and safe instead of duplicating the library.
        """
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(
                "SELECT CASE WHEN json_valid(metadata_json) "
                "            THEN json_extract(metadata_json, '$.source_path') END AS sp "
                "FROM entries"
            ).fetchall()
            cur.close()
        return {str(r["sp"]) for r in rows if r["sp"]}

    def entry_id_for_source_path(self, source_path: str, source: str) -> Optional[str]:
        """The id of the reference-in-place entry already pointing at
        ``source_path``, or None.

        The single-file counterpart to :meth:`registered_source_paths`, which
        answers the same question for a whole folder import with one scan.
        Scanning the library per file would be the 13.3 s blob read all over
        again, so this is narrowed by ``source`` first -- ``idx_entries_source``
        -- and only those rows' metadata are opened. A performance set's
        handful of rows is nothing; the whole library would not be.
        """
        with self._writelock:
            cur = self._conn.cursor()
            row = cur.execute(
                "SELECT id FROM entries WHERE source = ? "
                "  AND json_valid(metadata_json) "
                "  AND json_extract(metadata_json, '$.source_path') = ? "
                "LIMIT 1",
                (source, source_path),
            ).fetchone()
            cur.close()
        return str(row["id"]) if row else None

    def library_revision(self) -> int:
        """The counter ``_txn`` bumps once per committed write. 0 before the
        first one. Cheaper than :meth:`library_counts` when only the revision
        is wanted (every paged response carries it)."""
        with self._writelock:
            cur = self._conn.cursor()
            row = cur.execute(
                "SELECT value FROM schema_meta WHERE key = 'library_revision'"
            ).fetchone()
            cur.close()
        try:
            return int(row["value"])
        except (TypeError, ValueError):
            return 0

    def increment_play_count(self, entry_id: str) -> Optional[int]:
        """Bump play_count and stamp last_played_at for one entry. Returns the
        new play_count, or None when the entry does not exist. Independent of
        upsert_entry, which never touches play_count, so metadata edits and
        re-analysis leave the count intact."""
        now = _now()
        with self._txn() as cur:
            cur.execute(
                "UPDATE entries SET play_count = play_count + 1, last_played_at = ? WHERE id = ?",
                (now, entry_id),
            )
            if cur.rowcount == 0:
                return None
            row = cur.execute(
                "SELECT play_count FROM entries WHERE id = ?", (entry_id,)
            ).fetchone()
            return int(row["play_count"]) if row else None

    # ---- Relations ----------------------------------------------------------

    def add_relation(
        self,
        from_id: str,
        to_id: str,
        kind: str,
        *,
        weight: float = 1.0,
        metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        with self._txn() as cur:
            cur.execute(
                """
                INSERT OR IGNORE INTO relations (from_id, to_id, kind, weight, metadata_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    from_id,
                    to_id,
                    kind,
                    weight,
                    json.dumps(metadata or {}),
                    _now(),
                ),
            )

    def add_relations_bulk(self, edges: Iterable[tuple[str, str, str]]) -> int:
        """Insert many ``(from_id, to_id, kind)`` edges in ONE transaction.

        The batched sibling of :meth:`add_relation`, for reindex: a library
        with chimera lineage would otherwise open one transaction (and bump
        ``library_revision``) per edge. Existing edges are left alone, same as
        the single-edge form. Returns the number of edges offered."""
        rows = [
            (str(f), str(t), str(k), 1.0, "{}", _now()) for f, t, k in edges if f and t
        ]
        if not rows:
            return 0
        with self._txn() as cur:
            cur.executemany(
                "INSERT OR IGNORE INTO relations "
                "(from_id, to_id, kind, weight, metadata_json, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                rows,
            )
        return len(rows)

    def list_relations(
        self,
        *,
        from_id: Optional[str] = None,
        to_id: Optional[str] = None,
        kind: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if from_id:
            clauses.append("from_id = ?")
            params.append(from_id)
        if to_id:
            clauses.append("to_id = ?")
            params.append(to_id)
        if kind:
            clauses.append("kind = ?")
            params.append(kind)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        sql = f"SELECT * FROM relations {where} ORDER BY created_at"
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(sql, params).fetchall()
            cur.close()
            return [dict(r) for r in rows]

    # ---- Analysis / stems / midi (lightweight inserts) ----------------------

    def upsert_analysis(self, entry_id: str, payload: dict[str, Any]) -> None:
        row = {
            "entry_id": entry_id,
            "bpm": payload.get("bpm"),
            "bpm_confidence": payload.get("bpm_confidence"),
            "beats_json": json.dumps(payload.get("beats") or []),
            "key": payload.get("key"),
            "key_confidence": payload.get("key_confidence"),
            "scale": payload.get("scale"),
            "pitch_mean_hz": payload.get("pitch_mean_hz"),
            "pitch_std_hz": payload.get("pitch_std_hz"),
            "loudness_lufs": payload.get("loudness_lufs"),
            "rms_db": payload.get("rms_db"),
            "bars_estimated": payload.get("bars_estimated"),
            "genre": payload.get("genre"),
            "genre_confidence": payload.get("genre_confidence"),
            "prompt_guess": payload.get("prompt_guess"),
            "prompt_confidence": payload.get("prompt_confidence"),
            "semantic_tags_json": json.dumps(payload.get("semantic_tags") or []),
            "embedded_tags_json": json.dumps(payload.get("embedded_tags") or {}),
            "ffprobe_json": json.dumps(payload.get("ffprobe") or {}),
            "analyzed_at": _now(),
            "version": int(payload.get("version") or 1),
        }
        with self._txn() as cur:
            cur.execute(
                """
                INSERT INTO analysis (
                    entry_id, bpm, bpm_confidence, beats_json, key,
                    key_confidence, scale,
                    pitch_mean_hz, pitch_std_hz, loudness_lufs, rms_db,
                    bars_estimated, genre, genre_confidence,
                    prompt_guess, prompt_confidence, semantic_tags_json,
                    embedded_tags_json, ffprobe_json, analyzed_at, version
                ) VALUES (
                    :entry_id, :bpm, :bpm_confidence, :beats_json, :key,
                    :key_confidence, :scale,
                    :pitch_mean_hz, :pitch_std_hz, :loudness_lufs, :rms_db,
                    :bars_estimated, :genre, :genre_confidence,
                    :prompt_guess, :prompt_confidence, :semantic_tags_json,
                    :embedded_tags_json, :ffprobe_json, :analyzed_at, :version
                )
                ON CONFLICT(entry_id) DO UPDATE SET
                    bpm = excluded.bpm,
                    bpm_confidence = excluded.bpm_confidence,
                    beats_json = excluded.beats_json,
                    key = excluded.key,
                    key_confidence = excluded.key_confidence,
                    scale = excluded.scale,
                    pitch_mean_hz = excluded.pitch_mean_hz,
                    pitch_std_hz = excluded.pitch_std_hz,
                    loudness_lufs = excluded.loudness_lufs,
                    rms_db = excluded.rms_db,
                    bars_estimated = excluded.bars_estimated,
                    genre = excluded.genre,
                    genre_confidence = excluded.genre_confidence,
                    prompt_guess = excluded.prompt_guess,
                    prompt_confidence = excluded.prompt_confidence,
                    semantic_tags_json = excluded.semantic_tags_json,
                    embedded_tags_json = excluded.embedded_tags_json,
                    ffprobe_json = excluded.ffprobe_json,
                    analyzed_at = excluded.analyzed_at,
                    version = excluded.version
                """,
                row,
            )

    def get_analysis(self, entry_id: str) -> Optional[dict[str, Any]]:
        with self._writelock:
            cur = self._conn.cursor()
            row = cur.execute(
                "SELECT * FROM analysis WHERE entry_id = ?", (entry_id,)
            ).fetchone()
            cur.close()
            return dict(row) if row else None

    def get_all_analysis(self) -> dict[str, dict[str, Any]]:
        """Return ``{entry_id: analysis_row}`` for every analyzed entry in a
        SINGLE query.

        This is the batched sibling of :meth:`get_analysis`. The library list
        endpoint enriches every entry with its analysis (so the Catalogue
        inspector + library search can read ``entry.analysis``); doing that
        with a per-entry ``get_analysis`` call would be an N+1 query storm on a
        large library. One narrowed query (see :data:`_ANALYSIS_LIST_COLUMNS`)
        + a dict keyed by ``entry_id`` keeps the enrichment O(1) queries
        without pulling every column (e.g. ``beats_json``) of every row into
        memory. Callers parse the ``*_json`` columns themselves."""
        cols = ", ".join(_ANALYSIS_LIST_COLUMNS)
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(f"SELECT {cols} FROM analysis").fetchall()
            cur.close()
            return {row["entry_id"]: dict(row) for row in rows}

    def path_referenced_elsewhere(
        self, path: str, *, table: str, row_id: str, entry_id: str
    ) -> Optional[str]:
        """The id of another artifact row that still points at ``path``, or
        ``None``.

        A physical artifact file is legitimately shared by more than one row:
        the on-disk recovery scan registers a file under a filename-derived id
        while a real conversion registers the same file under its create-scheme
        id. Superseding (moving) such a file would leave the other row resolving
        to nothing, so every create path asks this first and skips the move when
        the answer is not ``None``. Scoped to the entry plus any exact-string
        match elsewhere, then compared on normalized paths so different
        spellings of one file still count as a reference.
        """
        target = normalize_artifact_path(path)
        if not target:
            return None
        with self._writelock:
            cur = self._conn.cursor()
            try:
                for tbl, col in ARTIFACT_PATH_COLUMNS:
                    rows = cur.execute(
                        f"SELECT id, {col} AS artifact_path FROM {tbl} "
                        f"WHERE entry_id = ? OR {col} = ?",
                        (entry_id, path),
                    ).fetchall()
                    for row in rows:
                        other_id = str(row["id"] or "")
                        if tbl == table and other_id == row_id:
                            continue  # the row we just wrote
                        if (
                            normalize_artifact_path(str(row["artifact_path"] or ""))
                            == target
                        ):
                            return other_id
            finally:
                cur.close()
        return None

    def _supersede_unless_shared(
        self,
        old_path: str,
        new_path: str,
        *,
        table: str,
        row_id: str,
        entry_id: str,
    ) -> None:
        """Retire ``old_path`` after a row was re-pointed to ``new_path``,
        unless another row still references it."""
        if not old_path or normalize_artifact_path(old_path) == normalize_artifact_path(
            new_path
        ):
            return
        holder = self.path_referenced_elsewhere(
            old_path, table=table, row_id=row_id, entry_id=entry_id
        )
        if holder is not None:
            log.info(
                "library.db: not superseding %s — still referenced by %s",
                old_path,
                holder,
            )
            return
        supersede_artifact_file(old_path, new_path)

    def add_stem(
        self,
        *,
        stem_id: str,
        entry_id: str,
        stem_name: str,
        audio_path: str,
        file_size_bytes: int = 0,
        model: Optional[str] = None,
        model_variant: Optional[str] = None,
    ) -> None:
        prior = self.get_stem(stem_id)
        with self._txn() as cur:
            cur.execute(
                """
                INSERT OR REPLACE INTO stems
                    (id, entry_id, stem_name, audio_path, file_size_bytes,
                     model, model_variant, separated_at, version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
                """,
                (
                    stem_id,
                    entry_id,
                    stem_name,
                    audio_path,
                    file_size_bytes,
                    model,
                    model_variant,
                    _now(),
                ),
            )
        if prior is not None:
            self._supersede_unless_shared(
                str(prior.get("audio_path") or ""),
                audio_path,
                table="stems",
                row_id=stem_id,
                entry_id=entry_id,
            )

    def list_stems(self, entry_id: str) -> list[dict[str, Any]]:
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(
                "SELECT * FROM stems WHERE entry_id = ? ORDER BY stem_name",
                (entry_id,),
            ).fetchall()
            cur.close()
            return [dict(r) for r in rows]

    def get_stem(self, stem_id: str) -> Optional[dict[str, Any]]:
        """Look one stem row up by its globally-unique id."""
        with self._writelock:
            cur = self._conn.cursor()
            row = cur.execute("SELECT * FROM stems WHERE id = ?", (stem_id,)).fetchone()
            cur.close()
            return dict(row) if row else None

    def set_stem_favorite(self, stem_id: str, favorite: bool) -> bool:
        with self._txn() as cur:
            cur.execute(
                "UPDATE stems SET favorite = ? WHERE id = ?",
                (1 if favorite else 0, stem_id),
            )
            return cur.rowcount > 0

    def delete_stem(self, stem_id: str) -> bool:
        """Drop one stem row. Caller is responsible for deleting the file on
        disk (the path lives in ``audio_path``)."""
        with self._txn() as cur:
            cur.execute("DELETE FROM stems WHERE id = ?", (stem_id,))
            deleted = cur.rowcount > 0
            # Polymorphic edges may reference this stem id (stems-of / midi-of).
            cur.execute(
                "DELETE FROM relations WHERE from_id = ? OR to_id = ?",
                (stem_id, stem_id),
            )
            return deleted

    def add_midi(
        self,
        *,
        midi_id: str,
        entry_id: str,
        source: str,
        midi_path: str,
        source_ref: Optional[str] = None,
        engine: str = "",
        engine_version: str = "",
        notes_count: int = 0,
    ) -> None:
        prior = self.get_midi(midi_id)
        with self._txn() as cur:
            cur.execute(
                """
                INSERT OR REPLACE INTO midis
                    (id, entry_id, source, source_ref, midi_path,
                     engine, engine_version, notes_count, converted_at, version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                """,
                (
                    midi_id,
                    entry_id,
                    source,
                    source_ref,
                    midi_path,
                    engine,
                    engine_version,
                    notes_count,
                    _now(),
                ),
            )
        if prior is not None:
            self._supersede_unless_shared(
                str(prior.get("midi_path") or ""),
                midi_path,
                table="midis",
                row_id=midi_id,
                entry_id=entry_id,
            )

    def list_midis(self, entry_id: str) -> list[dict[str, Any]]:
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(
                "SELECT * FROM midis WHERE entry_id = ? ORDER BY converted_at",
                (entry_id,),
            ).fetchall()
            cur.close()
            return [dict(r) for r in rows]

    def get_midi(self, midi_id: str) -> Optional[dict[str, Any]]:
        """Look one MIDI row up by its globally-unique id."""
        with self._writelock:
            cur = self._conn.cursor()
            row = cur.execute("SELECT * FROM midis WHERE id = ?", (midi_id,)).fetchone()
            cur.close()
            return dict(row) if row else None

    def set_midi_favorite(self, midi_id: str, favorite: bool) -> bool:
        with self._txn() as cur:
            cur.execute(
                "UPDATE midis SET favorite = ? WHERE id = ?",
                (1 if favorite else 0, midi_id),
            )
            return cur.rowcount > 0

    def delete_midi(self, midi_id: str) -> bool:
        """Drop one MIDI row. Caller deletes the .mid file on disk
        (path lives in ``midi_path``)."""
        with self._txn() as cur:
            cur.execute("DELETE FROM midis WHERE id = ?", (midi_id,))
            deleted = cur.rowcount > 0
            cur.execute(
                "DELETE FROM relations WHERE from_id = ? OR to_id = ?",
                (midi_id, midi_id),
            )
            return deleted

    def add_notation_artifact(
        self,
        *,
        artifact_id: str,
        entry_id: str,
        kind: str,
        path: str,
        source_ref: Optional[str] = None,
        engine: str = "",
        engine_version: str = "",
        metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        prior = self.get_notation_artifact(artifact_id)
        with self._txn() as cur:
            cur.execute(
                """
                INSERT OR REPLACE INTO notation_artifacts
                    (id, entry_id, kind, source_ref, path, engine,
                     engine_version, metadata_json, created_at, version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                """,
                (
                    artifact_id,
                    entry_id,
                    kind,
                    source_ref,
                    path,
                    engine,
                    engine_version,
                    json.dumps(metadata or {}),
                    _now(),
                ),
            )
        if prior is not None:
            self._supersede_unless_shared(
                str(prior.get("path") or ""),
                path,
                table="notation_artifacts",
                row_id=artifact_id,
                entry_id=entry_id,
            )

    def list_notation_artifacts(
        self,
        entry_id: str,
        *,
        kind: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        clauses = ["entry_id = ?"]
        params: list[Any] = [entry_id]
        if kind:
            clauses.append("kind = ?")
            params.append(kind)
        where = " AND ".join(clauses)
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(
                f"SELECT * FROM notation_artifacts WHERE {where} ORDER BY created_at",
                params,
            ).fetchall()
            cur.close()
            return [dict(r) for r in rows]

    def get_notation_artifact(self, artifact_id: str) -> Optional[dict[str, Any]]:
        with self._writelock:
            cur = self._conn.cursor()
            row = cur.execute(
                "SELECT * FROM notation_artifacts WHERE id = ?", (artifact_id,)
            ).fetchone()
            cur.close()
            return dict(row) if row else None

    def delete_notation_artifact(self, artifact_id: str) -> bool:
        """Remove one notation artifact row. Returns True when a row was
        deleted, False when no row had that id. The file on disk is the
        caller's responsibility."""
        with self._txn() as cur:
            cur.execute("DELETE FROM notation_artifacts WHERE id = ?", (artifact_id,))
            return cur.rowcount > 0

    # ---- Bulk cross-entry reads ---------------------------------------------
    #
    # Batched siblings of list_stems / list_midis / list_notation_artifacts,
    # in the mold of get_all_analysis: the /_all/* endpoints and the genealogy
    # graph previously looped list_entries and issued one child query per
    # entry, an N+1 storm on a large library. Each method takes the writelock
    # ONCE and answers with a single JOIN. The parent_title / parent_id
    # columns reproduce the payload the old per-entry loops appended, and the
    # ORDER BY reproduces the loop order (entries newest-first, then the
    # per-entry child sort).

    def list_all_stems(self) -> list[dict[str, Any]]:
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(
                """
                SELECT s.*, e.title AS parent_title, s.entry_id AS parent_id
                FROM stems s JOIN entries e ON e.id = s.entry_id
                ORDER BY e.created_at DESC, s.stem_name
                """
            ).fetchall()
            cur.close()
            return [dict(r) for r in rows]

    def list_all_midis(self) -> list[dict[str, Any]]:
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(
                """
                SELECT m.*, e.title AS parent_title, m.entry_id AS parent_id
                FROM midis m JOIN entries e ON e.id = m.entry_id
                ORDER BY e.created_at DESC, m.converted_at
                """
            ).fetchall()
            cur.close()
            return [dict(r) for r in rows]

    def list_all_notation_artifacts(self) -> list[dict[str, Any]]:
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(
                """
                SELECT n.*, e.title AS parent_title, n.entry_id AS parent_id
                FROM notation_artifacts n JOIN entries e ON e.id = n.entry_id
                ORDER BY e.created_at DESC, n.created_at
                """
            ).fetchall()
            cur.close()
            return [dict(r) for r in rows]

    # The library tab strip's five category counts. One SELECT means one
    # consistent snapshot: the sub-counts cannot disagree with each other or
    # with ``revision``, which a writer could otherwise slip between. Children
    # are JOINed to ``entries`` so a row whose parent is gone (legacy data, a
    # DB restored from backup -- a live DB cascades) is never counted.
    _COUNTS_SQL = """
        SELECT
            (SELECT COUNT(*) FROM entries WHERE kind = 'audio') AS tracks,
            (SELECT COUNT(*) FROM stems s
                JOIN entries e ON e.id = s.entry_id) AS stems,
            (SELECT COUNT(*) FROM midis m
                JOIN entries e ON e.id = m.entry_id) AS midi,
            (SELECT COUNT(*) FROM entries WHERE kind IN ('video', 'image')) AS video,
            (SELECT COUNT(*) FROM notation_artifacts n
                JOIN entries e ON e.id = n.entry_id
                WHERE n.kind != 'midi') AS score,
            (SELECT value FROM schema_meta WHERE key = 'library_revision') AS revision
    """

    _COUNT_KEYS = ("tracks", "stems", "midi", "video", "score")

    def library_counts(self) -> dict[str, Any]:
        """``{'revision': int, 'counts': {tracks, stems, midi, video, score}}``.

        ``tracks`` is audio entries; ``video`` is the VIDEO tab's kinds
        (video + image); ``score`` is notation artifacts other than raw MIDI,
        matching ``/_all/scores``. ``revision`` rises once per committed
        mutating transaction (0 before the first one), so a client can tell a
        newer snapshot from an older one and drop a late response.
        """
        with self._writelock:
            cur = self._conn.cursor()
            row = cur.execute(self._COUNTS_SQL).fetchone()
            cur.close()
        counts = {key: int(row[key] or 0) for key in self._COUNT_KEYS}
        try:
            revision = int(row["revision"])
        except (TypeError, ValueError):
            revision = 0
        return {"revision": revision, "counts": counts}

    # ---- Shards (docs/design/loom.md) ----------------------------------------

    _SHARD_COLUMNS = (
        "id",
        "entry_id",
        "stem_name",
        "role",
        "start_sec",
        "end_sec",
        "beats",
        "bar_index",
        "bpm",
        "key",
        "scale",
        "camelot",
        "pc_root",
        "rms_db",
        "low_frac",
        "onset_density",
        "centroid_hz",
        "onset_mask",
        "energy",
        "section",
        "chord",
        "words",
        "chroma_json",
        "mfcc_json",
        "version",
    )

    def replace_shards(self, entry_id: str, rows: list[dict[str, Any]]) -> None:
        """Drop the entry's shards and insert ``rows`` (one transaction)."""
        cols = self._SHARD_COLUMNS
        sql = (
            f"INSERT OR REPLACE INTO shards ({', '.join(cols)}) "
            f"VALUES ({', '.join('?' for _ in cols)})"
        )
        with self._txn() as cur:
            cur.execute("DELETE FROM shards WHERE entry_id = ?", (entry_id,))
            cur.executemany(sql, [tuple(r.get(c) for c in cols) for r in rows])

    def list_shards(self, entry_id: str) -> list[dict[str, Any]]:
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(
                "SELECT * FROM shards WHERE entry_id = ? ORDER BY stem_name, beats, bar_index",
                (entry_id,),
            ).fetchall()
            cur.close()
            return [dict(r) for r in rows]

    def get_shard(self, shard_id: str) -> Optional[dict[str, Any]]:
        with self._writelock:
            cur = self._conn.cursor()
            row = cur.execute(
                "SELECT * FROM shards WHERE id = ?", (shard_id,)
            ).fetchone()
            cur.close()
            return dict(row) if row else None

    def select_shards(
        self,
        *,
        role: Optional[str] = None,
        beats: Optional[int] = None,
        entry_id: Optional[str] = None,
        exclude_entry: Optional[str] = None,
        section: Optional[str] = None,
        text: Optional[str] = None,
        limit: int = 5000,
    ) -> list[dict[str, Any]]:
        """SQL pre-filter for the ranker. ``role='drums'`` also admits the
        LARSNET drum parts; ``text`` matches chord symbols and lyric words."""
        clauses: list[str] = []
        params: list[Any] = []
        if role:
            if role == "drums":
                clauses.append(
                    "role IN ('drums','kick','snare','hihat','cymbals','toms')"
                )
            else:
                clauses.append("role = ?")
                params.append(role)
        if beats:
            clauses.append("beats = ?")
            params.append(int(beats))
        if entry_id:
            clauses.append("entry_id = ?")
            params.append(entry_id)
        if exclude_entry:
            clauses.append("entry_id != ?")
            params.append(exclude_entry)
        if section:
            clauses.append("section = ?")
            params.append(section)
        if text:
            clauses.append("(words LIKE ? OR chord LIKE ?)")
            like = f"%{text}%"
            params.extend([like, like])
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(
                f"SELECT * FROM shards {where} ORDER BY entry_id, stem_name, bar_index LIMIT ?",
                [*params, int(limit)],
            ).fetchall()
            cur.close()
            return [dict(r) for r in rows]

    def set_shard_sections(
        self, entry_id: str, spans: list[tuple[float, float, str]]
    ) -> int:
        """Write every shard of ``entry_id`` its section: the label of the
        span holding the shard's middle (before the first span, the first's;
        after the last, the last's; '' with no spans). One transaction;
        returns the number of rows whose section changed."""
        with self._txn() as cur:
            rows = cur.execute(
                "SELECT id, start_sec, end_sec, section FROM shards WHERE entry_id = ?",
                (entry_id,),
            ).fetchall()
            changes: list[tuple[str, str]] = []
            for r in rows:
                mid = (float(r["start_sec"]) + float(r["end_sec"])) / 2.0
                label = ""
                if spans:
                    label = spans[0][2] if mid < spans[0][0] else spans[-1][2]
                    for s0, s1, name in spans:
                        if s0 <= mid < s1:
                            label = name
                            break
                if label != (r["section"] or ""):
                    changes.append((label, r["id"]))
            cur.executemany("UPDATE shards SET section = ? WHERE id = ?", changes)
            return len(changes)

    def count_shards(self) -> int:
        with self._writelock:
            cur = self._conn.cursor()
            n = cur.execute("SELECT COUNT(*) FROM shards").fetchone()[0]
            cur.close()
            return int(n)

    def bump_pairing(self, a_id: str, b_id: str) -> float:
        """Record (or strengthen) a kept pairing; symmetric on (a, b)."""
        lo, hi = sorted((a_id, b_id))
        with self._txn() as cur:
            cur.execute(
                """
                INSERT INTO shard_pairings (a_id, b_id, weight, kept_at)
                VALUES (?, ?, 1, ?)
                ON CONFLICT(a_id, b_id) DO UPDATE SET weight = weight + 1, kept_at = excluded.kept_at
                """,
                (lo, hi, _now()),
            )
            row = cur.execute(
                "SELECT weight FROM shard_pairings WHERE a_id = ? AND b_id = ?",
                (lo, hi),
            ).fetchone()
            return float(row["weight"]) if row else 1.0

    def pairing_counts(self) -> dict[str, int]:
        """How many kept pairings each shard takes part in (novelty term)."""
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(
                """
                SELECT id, SUM(w) AS n FROM (
                    SELECT a_id AS id, weight AS w FROM shard_pairings
                    UNION ALL
                    SELECT b_id AS id, weight AS w FROM shard_pairings
                ) GROUP BY id
                """
            ).fetchall()
            cur.close()
            return {str(r["id"]): int(r["n"] or 0) for r in rows}

    # ---- Schema info --------------------------------------------------------

    def schema_version(self) -> int:
        return self._current_schema_version()
