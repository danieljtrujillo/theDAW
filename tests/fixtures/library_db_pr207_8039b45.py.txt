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

Zero external deps — stdlib ``sqlite3`` only. JSON1 is enabled by default
in CPython's bundled SQLite, so flexible JSON blobs work out of the box.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Optional, Sequence

from .provider import PROVIDER_SLUG_MAX, detect_provider

log = logging.getLogger(__name__)


SCHEMA_VERSION = 12

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


# ---- Full-text search ------------------------------------------------------
#
# ``entries_fts`` is a CONTENTLESS fts5 table (``content=''``): it stores the
# inverted index only, keyed by ``entries.rowid``. That keeps it small, but it
# also means a row can only be removed by handing fts5 back the EXACT values
# that were inserted for it. Hence the invariant every writer below obeys:
#
#   For each ``entries.rowid``, ``entries_fts`` holds exactly the values
#   ``_fts_projection()`` produces for that row against the committed state of
#   ``entries`` + ``tag_index``. Any statement that changes those inputs must,
#   in the SAME transaction, run the 'delete' form BEFORE the change and the
#   insert form AFTER it.
#
# Deriving both forms from one projection is what makes that hold: the delete
# reads the pre-write state, so the values always match what was indexed.
# ``tests/test_library_paging.py`` checks the index against a brute-force scan
# after a churn of edits and deletes, because a mismatched delete corrupts the
# index silently (phantom hits, no error).

_FTS_COLUMNS = ("title", "prompt", "tags", "notes", "lyrics")

#: ``schema_meta`` key holding the highest ``entries.rowid`` that
#: ``_backfill_fts`` has durably indexed. Written in the same commit as the
#: batch it covers so the backfill can resume after a crash instead of
#: re-scanning from the top.
FTS_BACKFILL_ROWID_KEY = "fts_backfill_rowid"

#: fts5 spells "remove this rowid" as an insert whose first value is the
#: literal string 'delete', followed by the values originally indexed.
_FTS_DELETE_LEAD = "'delete'"

_FTS_TABLE_SQL = """
    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
        title, prompt, tags, notes, lyrics, content=''
    )
"""


def _fts_projection(lead: str = "") -> str:
    """The indexed text for a set of entries, straight from SQL.

    ``lead`` is prepended as an extra leading column, used to emit the literal
    ``'delete'`` fts5 expects as the first value of a removal. ``json_extract``
    is guarded by ``json_valid`` inside a CASE so a hand-edited or truncated
    ``metadata_json`` degrades to an empty lyrics field instead of aborting the
    transaction.
    """
    prefix = f"{lead}, " if lead else ""
    return f"""
        SELECT {prefix}e.rowid, e.title, e.prompt,
               COALESCE((SELECT group_concat(t.tag, ' ') FROM tag_index t
                         WHERE t.entry_id = e.id), ''),
               e.notes,
               COALESCE(CASE WHEN json_valid(e.metadata_json)
                             THEN json_extract(e.metadata_json, '$.lyrics') END, '')
        FROM entries e
    """


#: Letters and digits only (underscore excluded, matching fts5's unicode61
#: tokenizer, which treats it as a separator). Everything a user can type that
#: fts5 would read as an operator -- quotes, ``*``, ``^``, ``NEAR()``, ``:`` --
#: is dropped here rather than escaped later, so a search string is never a
#: query expression.
_TOKEN_RE = re.compile(r"[^\W_]+", re.UNICODE)

#: Bounds the cost of a pathological query string.
MAX_SEARCH_TOKENS = 16


def search_tokens(q: Optional[str]) -> list[str]:
    """The searchable tokens in ``q``. Empty when the string holds nothing a
    tokenizer would keep -- in which case the search matches NOTHING, in both
    the fts5 and the LIKE path, rather than silently matching everything."""
    return [t.lower() for t in _TOKEN_RE.findall(q or "")][:MAX_SEARCH_TOKENS]


def _fts_match_expr(tokens: Sequence[str]) -> str:
    """An fts5 MATCH expression: every token quoted as a string literal and
    prefix-matched, implicitly ANDed. ``_TOKEN_RE`` already excludes ``"``; the
    doubling is kept so the quoting stays correct if the tokenizer widens."""
    return " ".join('"' + t.replace('"', '""') + '"*' for t in tokens)


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


def _now() -> float:
    return time.time()


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
        # os.rename, NOT shutil.move: deprecated/ is a sub-directory of the
        # file's own parent, so the move never crosses a filesystem and needs no
        # copy fallback. shutil.move WOULD fall back to copy-then-unlink when the
        # rename is refused (a Windows handle held on the file), leaving a COPY in
        # deprecated/ beside the still-live original -- precisely the duplicate
        # this function exists to prevent. A failed rename simply changes nothing.
        os.rename(old, dest)
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


class LibraryDB:
    """Thin DAO over a single SQLite file.

    The connection uses ``check_same_thread=False`` so it survives
    FastAPI's threadpool, gated by an internal ``RLock``. All writes go
    through ``_writelock`` so concurrent updates serialize cleanly.
    """

    #: One log line per process when the SQLite build has no FTS5, not one per
    #: opened database.
    _fts_warned = False

    def __init__(self, path: Path, *, enable_fts: bool = True) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._writelock = threading.RLock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
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
        self._enable_fts = bool(enable_fts)
        #: Whether library search runs on fts5. False when this SQLite build
        #: lacks the module or a caller asked for the LIKE path; read it rather
        #: than assuming, and see :meth:`_search_clause` for what changes.
        self.fts_enabled = False
        self._migrate()
        self._ensure_fts()

    def close(self) -> None:
        with self._writelock:
            self._conn.close()

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
                            continue
                        self._conn.execute(stmt)
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

    def _has_column(self, table: str, column: str) -> bool:
        rows = self._conn.execute(f"PRAGMA table_info({table})").fetchall()
        return any(str(row[1]) == column for row in rows)

    # ---- Search index -------------------------------------------------------

    def _ensure_fts(self) -> None:
        """Create ``entries_fts`` and backfill it once.

        Deliberately NOT a migration statement: FTS5 is a property of the
        SQLite build, not of the database file. A library first opened by a
        Python without the module must pick the index up when it is next opened
        by one that has it, which a bumped ``schema_version`` would prevent.
        """
        if not self._enable_fts:
            return
        with self._writelock:
            try:
                self._conn.execute(_FTS_TABLE_SQL)
                self._conn.commit()
            except sqlite3.OperationalError as e:
                self._conn.rollback()
                if not LibraryDB._fts_warned:
                    LibraryDB._fts_warned = True
                    log.warning(
                        "library.db: this SQLite build has no FTS5 (%s); "
                        "library search falls back to LIKE",
                        e,
                    )
                return
            self.fts_enabled = True
            self._backfill_fts()

    def _backfill_fts(self, *, batch: int = 5000) -> None:
        """Index every pre-existing entry, in batches, exactly once.

        Commits directly instead of going through ``_txn``: building an index
        is not a library mutation, and a 200k backfill would otherwise push
        ``library_revision`` forward 40 times on first open and make every
        connected client refetch.
        """
        cur = self._conn.cursor()
        try:
            done = cur.execute(
                "SELECT value FROM schema_meta WHERE key = 'fts_backfill'"
            ).fetchone()
            if done and str(done["value"]) == "1":
                return
            indexed = 0
            last_rowid = 0
            while True:
                rows = cur.execute(
                    "SELECT rowid FROM entries WHERE rowid > ? ORDER BY rowid LIMIT ?",
                    (last_rowid, batch),
                ).fetchall()
                if not rows:
                    break
                lo, hi = last_rowid, int(rows[-1]["rowid"])
                cur.execute(
                    f"INSERT INTO entries_fts(rowid, {', '.join(_FTS_COLUMNS)}) "
                    f"{_fts_projection()} WHERE e.rowid > ? AND e.rowid <= ?",
                    (lo, hi),
                )
                indexed += len(rows)
                last_rowid = hi
                self._conn.commit()
            cur.execute(
                "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('fts_backfill', '1')"
            )
            self._conn.commit()
            if indexed:
                log.info("library.db: indexed %d entries for search", indexed)
        except Exception:
            self._conn.rollback()
            raise
        finally:
            cur.close()

    def _fts_forget(self, cur: sqlite3.Cursor, entry_ids: Sequence[str]) -> None:
        """Remove these entries from the search index, using the values the
        index currently holds. MUST run BEFORE the rows change."""
        if not self.fts_enabled or not entry_ids:
            return
        for chunk in _chunks(entry_ids, _MAX_SQL_PARAMS):
            marks = ", ".join("?" * len(chunk))
            cur.execute(
                f"INSERT INTO entries_fts(entries_fts, rowid, {', '.join(_FTS_COLUMNS)}) "
                f"{_fts_projection(_FTS_DELETE_LEAD)} WHERE e.id IN ({marks})",
                list(chunk),
            )

    def _fts_index(self, cur: sqlite3.Cursor, entry_ids: Sequence[str]) -> None:
        """Add these entries to the search index. MUST run AFTER the rows (and
        their tags) are written."""
        if not self.fts_enabled or not entry_ids:
            return
        for chunk in _chunks(entry_ids, _MAX_SQL_PARAMS):
            marks = ", ".join("?" * len(chunk))
            cur.execute(
                f"INSERT INTO entries_fts(rowid, {', '.join(_FTS_COLUMNS)}) "
                f"{_fts_projection()} WHERE e.id IN ({marks})",
                list(chunk),
            )

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
    # today only :meth:`set_entry_metadata`, whose added keys are read by SQL
    # and were already in the response that caused the write. Anything that
    # changes what a client could be showing keeps the default.
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
        with self._txn() as cur:
            # Before the row changes: the index still holds the OLD values, and
            # a contentless fts5 table can only be corrected with those.
            self._fts_forget(cur, [entry_id])
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
            # After the row AND its tags are final, so the indexed values are
            # exactly what the next _fts_forget will hand back.
            self._fts_index(cur, [entry_id])

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
        # A payload repeated inside one batch must not be forgotten/indexed
        # twice: the IN-list statements below are set operations.
        unique_ids = list(dict.fromkeys(r["id"] for r in rows))
        tag_rows: list[tuple[str, str]] = []
        prompt_rows: list[tuple[str, str, str]] = []
        for payload, row in zip(payloads, rows):
            tag_rows.extend(_entry_tag_rows(payload, row["id"]))
            prompt_rows.extend(_entry_prompt_rows(row))

        with self._txn() as cur:
            self._fts_forget(cur, unique_ids)
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
            self._fts_index(cur, unique_ids)
        return len(rows)

    def set_entry_metadata(
        self, metadata_by_id: Mapping[str, Mapping[str, Any]]
    ) -> int:
        """Replace ``metadata_json`` on rows that ALREADY exist, and nothing else.

        Deliberately narrower than :meth:`upsert_entry`, which is the path a
        user edit takes: no column is written, so ``updated_at`` keeps the
        value the last real edit left on it and every sort order stays where
        it was; the tag index, the prompt corpus and the fts index are not
        rebuilt; and an id with no row inserts nothing. That is what lets the
        read path record a fact it DERIVED about a row without the row looking
        edited.

        The ONE exception is the ``provider`` column, which is written in the
        same statement from the same dict (:func:`resolved_provider_slug`).
        That is not a second write to keep in step -- it is the same write:
        :data:`PROVIDER_SQL` reads the column, so a metadata update that
        renamed an entry's provider while leaving the column behind would
        label the row one way and file it another, which is the exact
        disagreement this method's caller exists to end. Neither is an edit:
        no sort order, index or timestamp can notice either.

        Otherwise only safe for metadata keys nothing else mirrors.
        ``$.lyrics`` is projected into the fts index and the remaining entry
        columns are written from their own payload fields, so a caller that
        changes either of those must go through :meth:`upsert_entry` instead.
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

    def list_entries(self) -> list[dict[str, Any]]:
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(
                "SELECT * FROM entries ORDER BY created_at DESC"
            ).fetchall()
            cur.close()
            return [dict(r) for r in rows]

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
            ORDER BY e.created_at DESC
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
            ORDER BY e.created_at DESC
        """
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute(sql).fetchall()
            cur.close()
            return [dict(r) for r in rows]

    def delete_entry(self, entry_id: str) -> bool:
        with self._txn() as cur:
            # While the row is still there to be read back out of the index.
            self._fts_forget(cur, [entry_id])
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
        search index is corrected from the values it currently holds BEFORE the
        rows change, the rows go (cascading to analysis / stems / midis / tags /
        prompts / notation / shards), and the polymorphic ``relations`` edges
        that name these ids are wiped by hand because they have no foreign key.

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
        for chunk in _chunks(ids, size):
            marks = ", ".join("?" * len(chunk))
            params = list(chunk)
            with self._txn() as cur:
                # While the rows are still there to be read back out of it.
                self._fts_forget(cur, chunk)
                cur.execute(f"DELETE FROM entries WHERE id IN ({marks})", params)
                removed += cur.rowcount
                # Split rather than ``from_id IN (...) OR to_id IN (...)`` so
                # one batch is never two parameter lists wide, and so each half
                # can use its own index.
                cur.execute(f"DELETE FROM relations WHERE from_id IN ({marks})", params)
                cur.execute(f"DELETE FROM relations WHERE to_id IN ({marks})", params)
        return removed

    def all_entry_ids(self) -> list[str]:
        with self._writelock:
            cur = self._conn.cursor()
            rows = cur.execute("SELECT id FROM entries").fetchall()
            cur.close()
            return [r["id"] for r in rows]

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

    def _search_clause(self, tokens: Sequence[str]) -> tuple[str, list[Any]]:
        """``(clause, params)`` for a free-text search.

        With fts5 this is a prefix MATCH per token, implicitly ANDed, phrased
        as ``rowid IN (subquery)``. The phrasing is load-bearing, not style:
        written as ``JOIN entries_fts ON entries_fts.rowid = e.rowid``, SQLite
        drives the query from the ``kind`` index and asks fts5 "does THIS rowid
        match?" once per row, re-running the full-text query 200,000 times --
        measured at 18.8 s for one page and 5 minutes for the COUNT. The
        subquery is materialized once instead: 5-32 ms for a page and <100 ms
        for the count across every match size from 0 to 200,000 rows.

        Without fts5 (a SQLite built without the module) the fallback is an
        index-usable prefix LIKE on ``title`` plus an unindexed substring LIKE
        on prompt / notes / tags / lyrics -- slower, and title matches are
        anchored at the start rather than at any word, which is why it is only
        ever the fallback. ``search_tokens`` has already dropped every fts5
        operator, so neither form can be injected into.
        """
        if not tokens:
            # A search string with nothing searchable in it matches nothing.
            return "0", []
        if self.fts_enabled:
            return (
                "e.rowid IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?)",
                [_fts_match_expr(tokens)],
            )
        parts: list[str] = []
        params: list[Any] = []
        for token in tokens:
            parts.append(
                "(e.title LIKE ?"
                " OR e.prompt LIKE ?"
                " OR e.notes LIKE ?"
                " OR COALESCE(CASE WHEN json_valid(e.metadata_json)"
                "             THEN json_extract(e.metadata_json, '$.lyrics') END, '') LIKE ?"
                " OR EXISTS (SELECT 1 FROM tag_index t"
                "            WHERE t.entry_id = e.id AND t.tag LIKE ?))"
            )
            # Tokens are letters and digits only, so they carry no LIKE
            # wildcard and need no ESCAPE clause.
            params.extend([f"{token}%", *([f"%{token}%"] * 4)])
        return " AND ".join(parts), params

    def _filter_sql(self, filters: EntryFilters) -> tuple[str, list[Any]]:
        """``(where, params)`` for one :class:`EntryFilters`."""
        clauses: list[str] = []
        params: list[Any] = []
        if filters.q is not None:
            search_clause, search_params = self._search_clause(search_tokens(filters.q))
            clauses.append(search_clause)
            params.extend(search_params)
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
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        return where, params

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
        where, params = self._filter_sql(filters)
        with self._writelock:
            cur = self._conn.cursor()
            row = cur.execute(
                f"SELECT COUNT(*) AS c FROM entries e {where}", params
            ).fetchone()
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
