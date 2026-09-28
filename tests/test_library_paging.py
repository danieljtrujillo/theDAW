"""Paged + searchable library listing: the query layer that survives 200,000 rows.

``GET /api/library/entries`` used to answer with the WHOLE table, every row
carrying a JSON re-parse, a filesystem stat and an in-memory sort, plus a full
re-read of ``entries`` for play counts and of ``analysis`` for the analysis
blob. At the size the user is importing at (~200k songs) that is a very long
response measured in gigabytes.

These tests pin the replacement: pure-SQL filtering / sorting / counting in
``db``, record building for the PAGE only in ``store``, and a byte-identical
response for a caller that passes none of the new parameters. The last test in
the file is the one that matters most — it builds a real 200,000-row database
and asserts the deep-offset page, the search and the count all come back inside
the budget.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.library import router as library_router_module
from backend.modules.library.db import SORTS, EntryFilters, LibraryDB
from tests.test_library_search_parity import (
    _assert_search_index_intact as check_search_index,
)
from tests.test_library_store import _seed_generate_entry

# Budgets from the ticket, at 200,000 rows.
PAGE_BUDGET_MS = 250.0
SEARCH_BUDGET_MS = 300.0
COUNT_BUDGET_MS = 150.0
#: The stats chips are one more request per search, held to a page's budget.
STATS_BUDGET_MS = PAGE_BUDGET_MS
PERF_ROWS = 200_000


def _payload(entry_id: str, **overrides) -> dict:
    payload: dict = {
        "id": entry_id,
        "kind": "audio",
        "title": entry_id,
        "prompt": "",
        "notes": "",
        "source": "generate",
        "favorite": False,
        "duration": 1.0,
        "audio_filename": "output.wav",
        "timestamp": "2026-09-18T00:00:00Z",
        "metadata_json": {},
    }
    payload.update(overrides)
    return payload


def _set_created_at(db: LibraryDB, entry_id: str, created_at: float) -> None:
    """Force one row's ``created_at``.

    ``upsert_entry`` stamps ``time.time()``, so rows written in a tight loop can
    share a timestamp and the created-order assertions would be testing the
    tiebreaker rather than the sort. The tests own the clock instead.
    """
    db._conn.execute(
        "UPDATE entries SET created_at = ? WHERE id = ?", (created_at, entry_id)
    )
    db._conn.commit()


def _ids(rows: list[dict]) -> list[str]:
    return [str(r["id"]) for r in rows]


def _build_has_fts5() -> bool:
    """Whether this SQLite has fts5 AND its trigram tokenizer, which is what
    the library's search index needs."""
    probe = sqlite3.connect(":memory:")
    try:
        probe.execute("CREATE VIRTUAL TABLE t USING fts5(a, tokenize='trigram')")
        return True
    except sqlite3.OperationalError:
        return False
    finally:
        probe.close()


def _assert_search_index_intact(db: LibraryDB) -> None:
    """fts5's own integrity checks, and the one- and two-character index
    compared with the text it was built from (see the parity suite)."""
    check_search_index(db)


# ---------------------------------------------------------------------------
# db.list_entries_page / count_entries_filtered / list_entry_ids
# ---------------------------------------------------------------------------


@pytest.fixture
def seeded_db(tmp_path: Path) -> LibraryDB:
    db = LibraryDB(tmp_path / "library.db")
    # created_at ascending, so created_desc is e4..e0.
    for i in range(5):
        db.upsert_entry(
            _payload(
                f"e{i}",
                title=f"Title {chr(ord('a') + i)}",
                duration=float(10 - i),
                favorite=(i % 2 == 0),
                source="folder" if i < 2 else "generate",
                prompt=f"prompt number {i}",
            )
        )
        _set_created_at(db, f"e{i}", 1000.0 + i)
    for _ in range(3):
        db.increment_play_count("e1")
    db.increment_play_count("e3")
    return db


def test_page_slices_the_result_set(seeded_db: LibraryDB):
    every = seeded_db.list_entries_page(EntryFilters(), limit=10, offset=0)
    assert _ids(every) == ["e4", "e3", "e2", "e1", "e0"]

    first = seeded_db.list_entries_page(EntryFilters(), limit=2, offset=0)
    second = seeded_db.list_entries_page(EntryFilters(), limit=2, offset=2)
    assert _ids(first) == ["e4", "e3"]
    assert _ids(second) == ["e2", "e1"]
    # A page past the end is empty, not an error.
    assert seeded_db.list_entries_page(EntryFilters(), limit=2, offset=99) == []


def test_every_documented_sort_orders_the_page(seeded_db: LibraryDB):
    expected = {
        "created_desc": ["e4", "e3", "e2", "e1", "e0"],
        "created_asc": ["e0", "e1", "e2", "e3", "e4"],
        "title_asc": ["e0", "e1", "e2", "e3", "e4"],
        "title_desc": ["e4", "e3", "e2", "e1", "e0"],
        "duration_desc": ["e0", "e1", "e2", "e3", "e4"],
        "duration_asc": ["e4", "e3", "e2", "e1", "e0"],
        # starred rows (e0, e2, e4) by name, then the rest by name
        "favorites_first": ["e0", "e2", "e4", "e1", "e3"],
    }
    for sort, order in expected.items():
        rows = seeded_db.list_entries_page(EntryFilters(), sort=sort, limit=10)
        assert _ids(rows) == order, sort
    # plays_desc only pins the two rows that have plays; the rest tie at 0.
    plays = _ids(
        seeded_db.list_entries_page(EntryFilters(), sort="plays_desc", limit=10)
    )
    assert plays[:2] == ["e1", "e3"]
    assert set(SORTS) == set(expected) | {"plays_desc"}


def test_unknown_sort_is_rejected(seeded_db: LibraryDB):
    with pytest.raises(ValueError):
        seeded_db.list_entries_page(EntryFilters(), sort="title_sideways", limit=5)


def test_play_count_comes_back_on_the_page_row(seeded_db: LibraryDB):
    rows = {r["id"]: r for r in seeded_db.list_entries_page(EntryFilters(), limit=10)}
    assert rows["e1"]["play_count"] == 3
    assert rows["e0"]["play_count"] == 0


def test_page_row_carries_the_columns_the_store_builds_from(seeded_db: LibraryDB):
    row = seeded_db.list_entries_page(EntryFilters(), limit=1)[0]
    assert {
        "id",
        "kind",
        "title",
        "duration_sec",
        "favorite",
        "play_count",
        "last_played_at",
        "metadata_json",
    } <= set(row)


def test_filters_narrow_both_the_page_and_the_count(seeded_db: LibraryDB):
    fav = EntryFilters(favorite=True)
    assert _ids(seeded_db.list_entries_page(fav, limit=10)) == ["e4", "e2", "e0"]
    assert seeded_db.count_entries_filtered(fav) == 3

    folder = EntryFilters(source="folder")
    assert _ids(seeded_db.list_entries_page(folder, limit=10)) == ["e1", "e0"]
    assert seeded_db.count_entries_filtered(folder) == 2

    seeded_db.upsert_entry(_payload("clip", kind="video", title="Clip"))
    audio = EntryFilters(kinds=frozenset({"audio"}))
    assert "clip" not in _ids(seeded_db.list_entries_page(audio, limit=10))
    assert seeded_db.count_entries_filtered(audio) == 5
    assert seeded_db.count_entries_filtered(EntryFilters()) == 6
    media = EntryFilters(kinds=frozenset({"video", "image"}))
    assert _ids(seeded_db.list_entries_page(media, limit=10)) == ["clip"]


def test_entry_ids_returns_one_extra_row_past_the_cap(seeded_db: LibraryDB):
    assert seeded_db.list_entry_ids(EntryFilters(), cap=10) == [
        "e4",
        "e3",
        "e2",
        "e1",
        "e0",
    ]
    # cap=2 → three ids, so the caller can answer 413 without a second COUNT.
    assert len(seeded_db.list_entry_ids(EntryFilters(), cap=2)) == 3
    assert len(seeded_db.list_entry_ids(EntryFilters(), cap=5)) == 5


def test_library_revision_is_the_one_from_the_summary(seeded_db: LibraryDB):
    assert seeded_db.library_revision() == seeded_db.library_counts()["revision"]
    before = seeded_db.library_revision()
    seeded_db.upsert_entry(_payload("e9"))
    assert seeded_db.library_revision() > before


# ---------------------------------------------------------------------------
# Search: FTS5 when the build has it, LIKE when it does not
# ---------------------------------------------------------------------------


def _search_db(tmp_path: Path, *, enable_fts: bool) -> LibraryDB:
    db = LibraryDB(tmp_path / f"search-{enable_fts}.db", enable_fts=enable_fts)
    db.upsert_entry(
        _payload(
            "neon",
            title="Neon Drift",
            prompt="a dark synthwave chase",
            metadata_json={"lyrics": "riding through the rain tonight"},
        )
    )
    db.upsert_entry(
        _payload("calm", title="Calm Water", prompt="ambient pads", notes="reference")
    )
    db.upsert_entry(
        _payload("drift", title="Drifting Slow", prompt="neon lights", tags=["chill"])
    )
    return db


@pytest.mark.parametrize("enable_fts", [True, False])
def test_search_matches_by_prefix_across_the_indexed_columns(
    tmp_path: Path, enable_fts: bool
):
    db = _search_db(tmp_path, enable_fts=enable_fts)
    assert db.fts_enabled is (enable_fts and _build_has_fts5())

    def found(q: str) -> set[str]:
        return set(_ids(db.list_entries_page(EntryFilters(q=q), limit=50)))

    # 'neon' is a title word of one entry and a prompt word of another.
    assert found("neon") == {"neon", "drift"}
    # Prefix, not whole word.
    assert found("neo") == {"neon", "drift"}
    # Inside a word too, as main's substring matcher found it.
    assert found("ynthw") == {"neon"}
    assert found("rifting") == {"drift"}
    # Prompt text is searched too.
    assert found("synthwave") == {"neon"}
    # Tokens are ANDed: only the entry with both wins.
    assert found("neon chase") == {"neon"}
    assert found("neon nothingatall") == set()
    # Tags are searchable.
    assert found("chill") == {"drift"}
    # Counting agrees with the page.
    assert db.count_entries_filtered(EntryFilters(q="neon")) == 2


@pytest.mark.parametrize("enable_fts", [True, False])
def test_search_input_is_escaped_not_interpreted(tmp_path: Path, enable_fts: bool):
    db = _search_db(tmp_path, enable_fts=enable_fts)
    # Every one of these is FTS5 query syntax; none may raise.
    for hostile in ('"', 'neon" OR "', "neon*", "NEAR(a b)", "^neon", "a AND b"):
        assert isinstance(
            db.list_entries_page(EntryFilters(q=hostile), limit=50), list
        ), hostile
    # OR is not an operator here: the three tokens are ANDed, and nothing has
    # all three.
    assert db.list_entries_page(EntryFilters(q="neon OR calm"), limit=50) == []
    # Punctuation alone is matched literally, as main's substring matcher
    # matched it: nothing here contains "!!! ---", and it never matches
    # everything.
    assert db.list_entries_page(EntryFilters(q="!!! ---"), limit=50) == []


@pytest.mark.parametrize("enable_fts", [True, False])
def test_search_reaches_the_lyrics(tmp_path: Path, enable_fts: bool):
    db = _search_db(tmp_path, enable_fts=enable_fts)
    assert _ids(db.list_entries_page(EntryFilters(q="tonight"), limit=50)) == ["neon"]


def test_fts_is_used_when_the_build_has_it(tmp_path: Path):
    """Feature detection, so the parametrized pair above is honest about which
    path this interpreter actually exercised."""
    db = LibraryDB(tmp_path / "probe.db")
    assert db.fts_enabled is _build_has_fts5()


def test_search_index_follows_edits_and_deletes(tmp_path: Path):
    db = LibraryDB(tmp_path / "sync.db")
    if not db.fts_enabled:
        pytest.skip("build has no FTS5; the LIKE path reads live columns")
    db.upsert_entry(_payload("x", title="Original Name", prompt="first"))
    assert _ids(db.list_entries_page(EntryFilters(q="original"), limit=5)) == ["x"]

    db.upsert_entry(_payload("x", title="Renamed Thing", prompt="second"))
    assert db.list_entries_page(EntryFilters(q="original"), limit=5) == []
    assert _ids(db.list_entries_page(EntryFilters(q="renamed"), limit=5)) == ["x"]
    assert db.list_entries_page(EntryFilters(q="first"), limit=5) == []

    db.delete_entry("x")
    assert db.list_entries_page(EntryFilters(q="renamed"), limit=5) == []
    _assert_search_index_intact(db)


def test_an_existing_library_gains_the_search_index_on_reopen(tmp_path: Path):
    """The upgrade path a real user hits: a database written before the index
    existed (or by a SQLite build with no FTS5) is backfilled the first time it
    is opened by one that has it -- and only the first time."""
    path = tmp_path / "upgrade.db"
    old = LibraryDB(path, enable_fts=False)
    old.upsert_entries_bulk(
        [_payload(f"o{i}", title=f"Harbor Light {i}") for i in range(2500)]
    )
    assert old.fts_enabled is False
    revision_before = old.library_revision()
    old.close()

    upgraded = LibraryDB(path)
    if not upgraded.fts_enabled:
        pytest.skip("build has no FTS5")
    assert len(upgraded.list_entries_page(EntryFilters(q="harbor"), limit=3000)) == 2500
    # Building an index is not a library mutation: it must not look like 2500
    # writes to a client watching the revision.
    assert upgraded.library_revision() == revision_before
    upgraded.close()

    # Re-opening does not index anything a second time (which would leave the
    # contentless index holding two copies of every row).
    again = LibraryDB(path)
    assert len(again.list_entries_page(EntryFilters(q="harbor"), limit=3000)) == 2500
    _assert_search_index_intact(again)
    again.delete_entry("o7")
    assert len(again.list_entries_page(EntryFilters(q="harbor"), limit=3000)) == 2499


def test_search_index_agrees_with_a_brute_force_scan(tmp_path: Path):
    """An fts5 row is only correctable by deleting the exact values that were
    inserted, so a wrong delete leaves phantom hits that no query ever reports
    as an error. This churns writes and then checks the index against a scan of
    the source columns."""
    db = LibraryDB(tmp_path / "churn.db")
    if not db.fts_enabled:
        pytest.skip("build has no FTS5")
    words = ["alpha", "bravo", "charlie", "delta", "echo"]
    for i in range(40):
        db.upsert_entry(
            _payload(f"c{i}", title=f"{words[i % 5]} {i}", prompt=words[(i + 2) % 5])
        )
    for i in range(0, 40, 3):
        db.upsert_entry(_payload(f"c{i}", title=f"{words[(i + 1) % 5]} rewritten {i}"))
    for i in range(0, 40, 7):
        db.delete_entry(f"c{i}")

    live = db._conn.execute("SELECT id, title, prompt FROM entries").fetchall()
    for word in words:
        via_fts = set(_ids(db.list_entries_page(EntryFilters(q=word), limit=100)))
        brute = {r["id"] for r in live if word in f"{r['title']} {r['prompt']}".lower()}
        assert via_fts == brute, word


# ---------------------------------------------------------------------------
# Router: the frozen contract T31 codes against
# ---------------------------------------------------------------------------


@pytest.fixture
def client_with_root(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    return TestClient(app)


def _seed_many(root: Path, n: int, **extra) -> None:
    for i in range(n):
        _seed_generate_entry(
            root, f"job{i:03d}", 0, extra_meta={"title": f"Song {i:03d}", **extra}
        )


def test_entries_without_the_new_params_is_untouched(client_with_root, tmp_path):
    _seed_many(tmp_path, 3)
    body = client_with_root.get("/api/library/entries").json()
    assert set(body) == {"entries", "count", "root", "kind"}
    assert body["count"] == 3
    assert body["kind"] == "audio"
    assert str(tmp_path) in body["root"]


def test_entries_with_limit_answers_the_paged_shape(client_with_root, tmp_path):
    _seed_many(tmp_path, 7)
    body = client_with_root.get(
        "/api/library/entries?limit=3&offset=3&sort=title_asc"
    ).json()
    assert body["limit"] == 3
    assert body["offset"] == 3
    assert body["total"] == 7
    assert body["count"] == 3
    assert isinstance(body["revision"], int)
    assert [e["title"] for e in body["entries"]] == ["Song 003", "Song 004", "Song 005"]
    # The entry shape is the one every other endpoint uses.
    assert {"id", "title", "audio_url", "play_count", "tags"} <= set(body["entries"][0])


def test_paged_entries_carry_play_counts_and_analysis(client_with_root, tmp_path):
    _seed_many(tmp_path, 2)
    assert (
        client_with_root.post("/api/library/entries/job000_00/play").status_code == 200
    )
    store = library_router_module.get_store()
    store.db.upsert_analysis("job000_00", {"bpm": 128.0, "key": "C"})

    body = client_with_root.get("/api/library/entries?limit=10&sort=title_asc").json()
    first, second = body["entries"]
    assert first["play_count"] == 1
    assert first["analysis"]["bpm"] == 128.0
    assert second["play_count"] == 0
    assert "analysis" not in second


def test_paged_rows_trim_long_lyrics_to_a_preview(client_with_root, tmp_path):
    long_lyrics = "la " * 200  # 600 chars
    _seed_generate_entry(
        tmp_path, "jobL", 0, extra_meta={"title": "Long", "lyrics": long_lyrics}
    )
    _seed_generate_entry(
        tmp_path, "jobS", 0, extra_meta={"title": "Short", "lyrics": "one line"}
    )
    body = client_with_root.get("/api/library/entries?limit=10&sort=title_asc").json()
    long_row, short_row = body["entries"]
    assert "lyrics" not in long_row
    assert long_row["lyrics_preview"] == long_lyrics[:280]
    assert long_row["has_lyrics"] is True
    # A short one is left exactly as it was.
    assert short_row["lyrics"] == "one line"
    assert "lyrics_preview" not in short_row

    # The full text is still on the single-entry read.
    assert client_with_root.get("/api/library/entries/jobL_00").json()["lyrics"] == (
        long_lyrics
    )


def test_search_and_filters_on_the_endpoint(client_with_root, tmp_path):
    _seed_generate_entry(tmp_path, "jobA", 0, extra_meta={"title": "Neon Drift"})
    _seed_generate_entry(tmp_path, "jobB", 0, extra_meta={"title": "Calm Water"})
    body = client_with_root.get("/api/library/entries?limit=10&q=neon").json()
    assert [e["title"] for e in body["entries"]] == ["Neon Drift"]
    assert body["total"] == 1

    fav = client_with_root.get("/api/library/entries?limit=10&favorite=true").json()
    assert fav["total"] == 0


def test_bad_paging_params_are_rejected(client_with_root):
    for url in (
        "/api/library/entries?limit=0",
        "/api/library/entries?limit=501",
        "/api/library/entries?limit=10&offset=-1",
        "/api/library/entries?limit=10&sort=sideways",
        "/api/library/entries?limit=10&kind=nonsense",
    ):
        assert client_with_root.get(url).status_code == 400, url


def test_entry_ids_endpoint_feeds_select_all(client_with_root, tmp_path):
    _seed_many(tmp_path, 4)
    body = client_with_root.get("/api/library/entries/ids?sort=title_asc").json()
    assert body["total"] == 4
    assert body["ids"] == ["job000_00", "job001_00", "job002_00", "job003_00"]
    # The literal path is not swallowed by /entries/{entry_id}.
    assert client_with_root.get("/api/library/entries/ids?q=song").json()["total"] == 4


def test_entry_ids_refuses_more_than_the_cap(client_with_root, tmp_path, monkeypatch):
    _seed_many(tmp_path, 4)
    monkeypatch.setattr(library_router_module, "MAX_SELECTABLE_IDS", 2)
    r = client_with_root.get("/api/library/entries/ids")
    assert r.status_code == 413
    assert "2" in r.json()["detail"]


# ---------------------------------------------------------------------------
# 200,000 rows. The reason this ticket exists.
# ---------------------------------------------------------------------------


def _perf_payloads(n: int) -> list[dict]:
    adjectives = ("neon", "velvet", "glass", "iron", "amber", "quiet", "hollow")
    nouns = ("drift", "signal", "harbor", "ember", "static", "orbit", "field")
    out: list[dict] = []
    for i in range(n):
        adj = adjectives[i % len(adjectives)]
        noun = nouns[(i // len(adjectives)) % len(nouns)]
        out.append(
            {
                "id": f"perf{i:07d}",
                "kind": "audio",
                "title": f"{adj} {noun} {i:07d}",
                "prompt": f"{noun} texture take {i % 97}",
                "notes": "",
                "source": "folder",
                "favorite": (i % 50 == 0),
                "duration": float(30 + (i % 600)),
                "audio_filename": f"{i:07d}.flac",
                "timestamp": "2026-09-18T00:00:00Z",
                "metadata_json": {"source_path": f"D:/music/{i:07d}.flac"},
            }
        )
    return out


def test_two_hundred_thousand_rows_stay_inside_the_budget(tmp_path: Path):
    """Runs in the normal suite: builds 200,000 rows through the bulk path and
    times the four operations the library UI depends on. Prints the numbers."""
    db = LibraryDB(tmp_path / "perf.db")
    t0 = time.perf_counter()
    written = db.upsert_entries_bulk(_perf_payloads(PERF_ROWS), batch=5000)
    build_s = time.perf_counter() - t0
    assert written == PERF_ROWS
    assert db.count_entries() == PERF_ROWS

    audio = EntryFilters(kinds=frozenset({"audio"}))

    t0 = time.perf_counter()
    total = db.count_entries_filtered(audio)
    count_ms = (time.perf_counter() - t0) * 1000
    assert total == PERF_ROWS

    deep = 150_000
    timings: dict[str, float] = {}
    for sort in SORTS:
        t0 = time.perf_counter()
        page = db.list_entries_page(audio, sort=sort, limit=200, offset=deep)
        timings[sort] = (time.perf_counter() - t0) * 1000
        assert len(page) == 200, sort
        nxt = db.list_entries_page(audio, sort=sort, limit=200, offset=deep + 200)
        assert not (set(_ids(page)) & set(_ids(nxt))), sort

    t0 = time.perf_counter()
    hits = db.list_entries_page(
        EntryFilters(kinds=frozenset({"audio"}), q="neon drift"), limit=200
    )
    search_ms = (time.perf_counter() - t0) * 1000
    assert hits, "the two-token search must match the synthesized titles"

    # Words of one and two characters, which match most of the library, and
    # the stats chips for them: what a user typing "a" or "ne" waits on.
    short_timings: dict[str, tuple[float, float, float]] = {}
    for q, expect_all in (("a", True), ("ne", False), ("3", False)):
        searched = EntryFilters(kinds=frozenset({"audio"}), q=q)
        runs: list[tuple[float, float, float]] = []
        for _ in range(3):
            t0 = time.perf_counter()
            rows = db.list_entries_page(searched, limit=200)
            t1 = time.perf_counter()
            n = db.count_entries_filtered(searched)
            t2 = time.perf_counter()
            stats = db.entry_stats(searched)
            t3 = time.perf_counter()
            runs.append(((t1 - t0) * 1000, (t2 - t1) * 1000, (t3 - t2) * 1000))
        assert len(rows) == 200, q
        assert stats["count"] == n, q
        if expect_all:
            assert n == PERF_ROWS, q
        short_timings[q] = tuple(sorted(r[i] for r in runs)[1] for i in range(3))

    t0 = time.perf_counter()
    capped = db.list_entry_ids(audio, cap=50_000)
    ids_ms = (time.perf_counter() - t0) * 1000
    assert len(capped) == 50_001, "one row past the cap signals 'too many'"

    print(
        f"\n[200k] build={build_s:.1f}s  count={count_ms:.1f}ms  "
        f"search(2 tokens)={search_ms:.1f}ms  ids(cap 50k)={ids_ms:.1f}ms"
    )
    for sort, ms in timings.items():
        print(f"[200k] page limit=200 offset={deep} sort={sort}: {ms:.1f}ms")
    for q, (page_ms, n_ms, stats_ms) in short_timings.items():
        print(
            f"[200k] q={q!r} (median of 3): page={page_ms:.1f}ms "
            f"count={n_ms:.1f}ms stats={stats_ms:.1f}ms"
        )

    assert count_ms < COUNT_BUDGET_MS, f"count took {count_ms:.1f}ms"
    assert search_ms < SEARCH_BUDGET_MS, f"search took {search_ms:.1f}ms"
    for sort, ms in timings.items():
        assert ms < PAGE_BUDGET_MS, f"{sort} page took {ms:.1f}ms"
    for q, (page_ms, n_ms, stats_ms) in short_timings.items():
        assert page_ms < PAGE_BUDGET_MS, f"q={q!r} page took {page_ms:.1f}ms"
        assert n_ms < COUNT_BUDGET_MS, f"q={q!r} count took {n_ms:.1f}ms"
        assert stats_ms < STATS_BUDGET_MS, f"q={q!r} stats took {stats_ms:.1f}ms"
