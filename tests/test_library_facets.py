"""Facet counts: the filter dropdowns, answered by the database.

The library's model / provider / source dropdowns used to be built from
whatever rows the client happened to have loaded, so at 200,000 entries they
listed the 200 values on the current page and nothing else. These tests pin the
replacement: one aggregate query per requested field, honouring exactly the
filters the paged list honours, with the values the WHOLE filtered set has.

The last test builds a real 200,000-row database and asserts every facet query
answers inside the budget, on every filter combination the endpoint accepts.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.library import router as library_router_module
from backend.modules.library.db import (
    FACET_FIELDS,
    MAX_FACET_VALUES,
    EntryFilters,
    LibraryDB,
    infer_provider,
)
from tests.test_library_store import _seed_generate_entry

#: The ticket's budget for one facet query at 200,000 rows.
FACET_BUDGET_MS = 300.0
PERF_ROWS = 200_000


def _payload(entry_id: str, **overrides) -> dict:
    payload: dict = {
        "id": entry_id,
        "kind": "audio",
        "title": entry_id,
        "prompt": "",
        "notes": "",
        "model": "small",
        "source": "generate",
        "favorite": False,
        "duration": 1.0,
        "audio_filename": "output.wav",
        "timestamp": "2026-09-18T00:00:00Z",
        "metadata_json": {},
    }
    payload.update(overrides)
    return payload


def _pairs(facet: list[dict]) -> list[tuple]:
    return [(row["value"], row["count"]) for row in facet]


@pytest.fixture
def seeded_db(tmp_path: Path) -> LibraryDB:
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entries_bulk(
        [
            _payload("a1", model="medium", source="generate", favorite=True),
            _payload("a2", model="medium", source="generate"),
            _payload("a3", model="medium", source="folder"),
            _payload("a4", model="suno", source="folder", title="neon drift"),
            _payload("a5", model="", source="folder"),
            _payload("v1", kind="video", model="small", source="import"),
        ]
    )
    return db


# ---------------------------------------------------------------------------
# db.facet_counts
# ---------------------------------------------------------------------------


def test_facets_count_every_matching_row_not_just_a_page(seeded_db: LibraryDB):
    facets = seeded_db.facet_counts(EntryFilters(), ["model", "source", "kind"])
    assert _pairs(facets["model"]) == [
        ("medium", 3),
        ("small", 1),
        ("suno", 1),
        (None, 1),
    ]
    assert _pairs(facets["source"]) == [("folder", 3), ("generate", 2), ("import", 1)]
    assert _pairs(facets["kind"]) == [("audio", 5), ("video", 1)]


def test_only_the_requested_fields_come_back(seeded_db: LibraryDB):
    facets = seeded_db.facet_counts(EntryFilters(), ["source"])
    assert list(facets) == ["source"]


def test_an_unknown_field_is_rejected(seeded_db: LibraryDB):
    with pytest.raises(ValueError):
        seeded_db.facet_counts(EntryFilters(), ["title"])


def test_an_unset_value_is_reported_as_one_null_bucket(seeded_db: LibraryDB):
    """``model`` is NOT NULL DEFAULT '', so "unset" reaches SQL as the empty
    string. The facet reports it as ``null`` -- one bucket, never a stray ``""``
    entry a dropdown would render as a blank option. (``NULLIF`` folds a real
    SQL NULL into the same bucket too, which is what keeps this true if the
    column is ever relaxed.)"""
    values = _pairs(seeded_db.facet_counts(EntryFilters(), ["model"])["model"])
    assert (None, 1) in values
    assert [value for value, _ in values].count(None) == 1
    assert "" not in [value for value, _ in values]


def test_facets_honour_the_kind_filter(seeded_db: LibraryDB):
    audio = EntryFilters(kinds=frozenset({"audio"}))
    assert _pairs(seeded_db.facet_counts(audio, ["source"])["source"]) == [
        ("folder", 3),
        ("generate", 2),
    ]


def test_facets_honour_favorite_source_and_search(seeded_db: LibraryDB):
    fav = seeded_db.facet_counts(EntryFilters(favorite=True), ["model"])
    assert _pairs(fav["model"]) == [("medium", 1)]

    src = seeded_db.facet_counts(EntryFilters(source="folder"), ["model"])
    assert _pairs(src["model"]) == [("medium", 1), ("suno", 1), (None, 1)]

    hit = seeded_db.facet_counts(EntryFilters(q="neon"), ["model"])
    assert _pairs(hit["model"]) == [("suno", 1)]
    # A search string with nothing searchable in it matches nothing, exactly as
    # it does for the page.
    assert seeded_db.facet_counts(EntryFilters(q="!!!"), ["model"])["model"] == []


def test_values_are_sorted_by_count_then_value(tmp_path: Path):
    db = LibraryDB(tmp_path / "sorted.db")
    db.upsert_entries_bulk(
        [_payload(f"b{i}", model="bravo") for i in range(3)]
        + [_payload(f"a{i}", model="alpha") for i in range(5)]
        # 'charlie' and 'delta' tie at 2, so the tiebreak is the value itself.
        + [_payload(f"d{i}", model="delta") for i in range(2)]
        + [_payload(f"c{i}", model="charlie") for i in range(2)]
    )
    assert _pairs(db.facet_counts(EntryFilters(), ["model"])["model"]) == [
        ("alpha", 5),
        ("bravo", 3),
        ("charlie", 2),
        ("delta", 2),
    ]


def test_a_field_is_capped_at_two_hundred_values(tmp_path: Path):
    db = LibraryDB(tmp_path / "wide.db")
    rows = []
    # 200 models with two entries each, then 10 with one: the cap has to keep
    # the 200 biggest, not the first 200 it happens to scan.
    for i in range(200):
        rows += [_payload(f"m{i:03d}_{j}", model=f"model-{i:03d}") for j in range(2)]
    for i in range(200, 210):
        rows.append(_payload(f"m{i:03d}_0", model=f"model-{i:03d}"))
    db.upsert_entries_bulk(rows)
    facet = db.facet_counts(EntryFilters(), ["model"])["model"]
    assert len(facet) == MAX_FACET_VALUES == 200
    assert {row["count"] for row in facet} == {2}


# ---------------------------------------------------------------------------
# provider: derived from model + source, never stored
# ---------------------------------------------------------------------------


def test_infer_provider_matches_the_frontend_rules():
    assert infer_provider("suno", "folder") == "suno"
    assert infer_provider("Suno-v4", "folder") == "suno"
    assert infer_provider("gemini-magenta", "generate") == "gemini-magenta"
    assert infer_provider("udio", "generate") == "udio"
    assert infer_provider("riffusion", "generate") == "riffusion"
    assert infer_provider("", "import") == "import"
    assert infer_provider("medium", "generate") == "stable-audio"
    assert infer_provider("mixdown", "studio") == "stable-audio"
    # T13: only a generation (or a studio bounce of one) is Stable Audio.
    # Everything else theDAW made -- a DJ set, VJ media, an unknown source --
    # is theDAW's own, and is not an AI generation.
    assert infer_provider("", "performance-set") == "thedaw"
    assert infer_provider(None, "vj") == "thedaw"
    assert infer_provider(None, None) == "thedaw"


def test_provider_facet_folds_model_and_source_together(seeded_db: LibraryDB):
    facet = seeded_db.facet_counts(EntryFilters(), ["provider"])["provider"]
    # a1, a2 (source 'generate') -> stable-audio; a3 and a5 (source 'folder')
    # -> thedaw, NOT stable-audio, since T13: a folder scan is not a Stable
    # Audio generation. a4 (model 'suno') -> suno; v1 ('import') -> import.
    assert _pairs(facet) == [
        ("stable-audio", 2),
        ("thedaw", 2),
        ("import", 1),
        ("suno", 1),
    ]


def test_provider_facet_honours_the_filters(seeded_db: LibraryDB):
    folder = EntryFilters(source="folder")
    # a3 + a5 are 'folder', which is neither 'generate' nor 'studio' -> thedaw.
    assert _pairs(seeded_db.facet_counts(folder, ["provider"])["provider"]) == [
        ("thedaw", 2),
        ("suno", 1),
    ]


def test_provider_never_reports_a_null_bucket(tmp_path: Path):
    """Every entry has a provider (the derivation always answers), so unlike
    ``model`` the provider facet has no 'unset' group."""
    db = LibraryDB(tmp_path / "prov.db")
    # p1's blank source is stored as the column's default, 'generate' (the
    # column is NOT NULL DEFAULT 'generate'), so it is a Stable Audio
    # generation; p2 names a source the rule has never heard of and is theDAW's
    # own. Neither is an 'unset' bucket.
    db.upsert_entries_bulk(
        [
            _payload("p1", model="", source=""),
            _payload("p2", model="", source="performance-set"),
        ]
    )
    assert _pairs(db.facet_counts(EntryFilters(), ["provider"])["provider"]) == [
        ("stable-audio", 1),
        ("thedaw", 1),
    ]


# ---------------------------------------------------------------------------
# GET /entries/facets -- the contract T33 codes against
# ---------------------------------------------------------------------------


@pytest.fixture
def client_with_root(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    return TestClient(app)


def _seed_entries(root: Path) -> None:
    _seed_generate_entry(
        root, "jobA", 0, extra_meta={"title": "Neon Drift", "model": "medium"}
    )
    _seed_generate_entry(
        root, "jobB", 0, extra_meta={"title": "Calm Water", "model": "medium"}
    )
    _seed_generate_entry(
        root, "jobC", 0, extra_meta={"title": "Suno Song", "model": "suno"}
    )


def test_facets_endpoint_answers_the_frozen_shape(client_with_root, tmp_path):
    _seed_entries(tmp_path)
    body = client_with_root.get(
        "/api/library/entries/facets?fields=model,provider,source"
    ).json()
    assert set(body) == {"facets", "revision"}
    assert list(body["facets"]) == ["model", "provider", "source"]
    assert body["facets"]["model"] == [
        {"value": "medium", "count": 2},
        {"value": "suno", "count": 1},
    ]
    assert body["facets"]["provider"] == [
        {"value": "stable-audio", "count": 2},
        {"value": "suno", "count": 1},
    ]
    assert body["facets"]["source"] == [{"value": "generate", "count": 3}]
    assert isinstance(body["revision"], int)
    assert (
        body["revision"]
        == client_with_root.get("/api/library/summary").json()["revision"]
    )


def test_facets_endpoint_takes_the_same_filters_as_the_page(client_with_root, tmp_path):
    _seed_entries(tmp_path)
    body = client_with_root.get(
        "/api/library/entries/facets?fields=model&q=neon"
    ).json()
    assert body["facets"]["model"] == [{"value": "medium", "count": 1}]

    empty = client_with_root.get(
        "/api/library/entries/facets?fields=model&favorite=true"
    ).json()
    assert empty["facets"]["model"] == []

    by_source = client_with_root.get(
        "/api/library/entries/facets?fields=kind&source=generate"
    ).json()
    assert by_source["facets"]["kind"] == [{"value": "audio", "count": 3}]


def test_facets_endpoint_rejects_a_bad_request(client_with_root, tmp_path):
    _seed_entries(tmp_path)
    for url in (
        "/api/library/entries/facets",  # fields is required
        "/api/library/entries/facets?fields=",
        "/api/library/entries/facets?fields=title",
        "/api/library/entries/facets?fields=model,nonsense",
        "/api/library/entries/facets?fields=model&kind=nonsense",
    ):
        assert client_with_root.get(url).status_code in (400, 422), url


def test_repeated_fields_are_answered_once(client_with_root, tmp_path):
    _seed_entries(tmp_path)
    body = client_with_root.get(
        "/api/library/entries/facets?fields=model,model,source"
    ).json()
    assert list(body["facets"]) == ["model", "source"]


def test_every_documented_field_is_accepted(client_with_root, tmp_path):
    _seed_entries(tmp_path)
    body = client_with_root.get(
        f"/api/library/entries/facets?fields={','.join(FACET_FIELDS)}&kind=all"
    ).json()
    assert list(body["facets"]) == list(FACET_FIELDS)


def test_the_literal_path_is_not_swallowed_by_the_entry_id_route(
    client_with_root, tmp_path
):
    _seed_entries(tmp_path)
    r = client_with_root.get("/api/library/entries/facets?fields=kind")
    assert r.status_code == 200
    assert "facets" in r.json()


# ---------------------------------------------------------------------------
# 200,000 rows
# ---------------------------------------------------------------------------


def _perf_payloads(n: int) -> list[dict]:
    models = ("small", "medium", "medium-rf", "suno", "reference", "", "import")
    sources = ("folder", "generate", "import", "studio")
    adjectives = ("neon", "velvet", "glass", "iron", "amber", "quiet", "hollow")
    nouns = ("drift", "signal", "harbor", "ember", "static", "orbit", "field")
    return [
        {
            "id": f"perf{i:07d}",
            "kind": "audio" if i % 20 else "video",
            "title": f"{adjectives[i % 7]} {nouns[(i // 7) % 7]} {i:07d}",
            "prompt": f"{nouns[i % 7]} texture take {i % 97}",
            "notes": "",
            "model": models[i % len(models)],
            "source": sources[i % len(sources)],
            "favorite": (i % 50 == 0),
            "duration": float(30 + (i % 600)),
            "audio_filename": f"{i:07d}.flac",
            "timestamp": "2026-09-18T00:00:00Z",
            "metadata_json": {},
        }
        for i in range(n)
    ]


def test_every_facet_query_stays_inside_the_budget_at_two_hundred_thousand(
    tmp_path: Path,
):
    """Every field against every filter combination the endpoint accepts. The
    numbers are printed; the assertion is the ticket's 300 ms ceiling."""
    db = LibraryDB(tmp_path / "perf.db")
    t0 = time.perf_counter()
    assert db.upsert_entries_bulk(_perf_payloads(PERF_ROWS), batch=5000) == PERF_ROWS
    build_s = time.perf_counter() - t0

    audio = frozenset({"audio"})
    combos = {
        "kind=audio": EntryFilters(kinds=audio),
        "kind=all": EntryFilters(),
        "kind+favorite": EntryFilters(kinds=audio, favorite=True),
        "kind+source": EntryFilters(kinds=audio, source="folder"),
        "kind+favorite+source": EntryFilters(
            kinds=audio, favorite=True, source="folder"
        ),
        "kind+q": EntryFilters(kinds=audio, q="neon drift"),
    }
    timings: dict[tuple[str, str], float] = {}
    for label, filters in combos.items():
        for field in FACET_FIELDS:
            t0 = time.perf_counter()
            facet = db.facet_counts(filters, [field])[field]
            timings[(label, field)] = (time.perf_counter() - t0) * 1000
            assert isinstance(facet, list)

    print(f"\n[200k facets] build={build_s:.1f}s")
    for (label, field), ms in timings.items():
        print(f"[200k facets] {label:22s} {field:9s} {ms:7.1f}ms")
    worst_key = max(timings, key=lambda k: timings[k])
    print(f"[200k facets] worst: {worst_key} {timings[worst_key]:.1f}ms")

    for (label, field), ms in timings.items():
        assert ms < FACET_BUDGET_MS, f"{label}/{field} took {ms:.1f}ms"

    # The counts are the whole filtered set, not a page of it.
    everything = db.facet_counts(EntryFilters(), ["kind"])["kind"]
    assert sum(row["count"] for row in everything) == PERF_ROWS
