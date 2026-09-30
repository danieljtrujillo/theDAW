"""``GET /api/library/setlists`` lists bundled sets; it does not write.

The route scans ``<data>/performance-sets/<Set>/performance.json`` for the DJ
tab, and it used to *register* every audio file it found as a library entry on
the way -- ``store.register_reference`` per track, one committed write each,
plus a sidecar file rewritten in the user's own folder -- on a GET the frontend
fires on startup. ``tests/test_library_api_at_scale.py`` caught it: the read
sweep moved ``library_revision`` 11 -> 36.

Listing and registering are now two routes. The GET reports whatever the
sidecar already knows (``entryId: null`` for a file that has never been
registered -- a shape the frontend's ``SetlistEntry`` already allows), and
``POST /setlists/{set_id}/register`` -- the open action -- does the writing.
The set id is a hash of the *timeline* (file names, labels, cue points), not of
the entry ids, so it survives registration and the frontend keeps merging by
id.

Every path here is under ``tmp_path``: no test reads the developer's own
``data/performance-sets``.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
from pathlib import Path
from typing import Any, Iterator, Optional

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.library import router as library_router_module

PREFIX = "/api/library"
SIDECAR = ".thedaw-import.json"


def _write_set(root: Path, name: str, tracks: int = 2) -> Path:
    """One performance set on disk: N playable files plus the timeline."""
    set_dir = root / name
    set_dir.mkdir(parents=True)
    spec: list[dict[str, Any]] = []
    for index in range(tracks):
        fname = f"track{index}.wav"
        (set_dir / fname).write_bytes(b"RIFF\x00\x00\x00\x00WAVEdata")
        spec.append(
            {
                "file": fname,
                "title": f"Track {index}",
                "cue_in_s": float(index),
                "mix_out_s": 30.0 + index,
            }
        )
    (set_dir / "performance.json").write_text(
        json.dumps({"name": name, "tracks": spec}), encoding="utf-8"
    )
    return set_dir


@pytest.fixture
def perf_sets(tmp_path: Path) -> Path:
    """``<data>/performance-sets``, redirected into the test's own tree."""
    root = tmp_path / "data" / "performance-sets"
    root.mkdir(parents=True)
    return root


@pytest.fixture
def client(tmp_path: Path, perf_sets: Path) -> Iterator[TestClient]:
    """The real library router over a throwaway data + library root."""
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("theDAW_DATA_DIR", str(tmp_path / "data"))
        patch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path / "library"))
        patch.setattr(library_router_module, "_store", None)
        app = FastAPI()
        app.include_router(library_router_module.router, prefix=PREFIX)
        with TestClient(app) as test_client:
            try:
                yield test_client
            finally:
                store = library_router_module._store
                database = getattr(store, "db", None)
                if database is not None:
                    database.close()
                library_router_module._store = None


def _revision() -> int:
    return library_router_module.get_store().db.library_revision()


def _get_setlists(client: TestClient) -> list[dict[str, Any]]:
    response = client.get(f"{PREFIX}/setlists")
    assert response.status_code == 200, response.text[:400]
    body = response.json()
    return sorted(body["setlists"], key=lambda item: item["name"])


def test_the_listing_lists_unregistered_sets_without_writing(
    client: TestClient, perf_sets: Path
) -> None:
    """The startup GET must be a read. Nothing committed, nothing on disk."""
    _write_set(perf_sets, "NIGHT RIDE", tracks=2)
    _write_set(perf_sets, "TEST SET", tracks=3)
    before = _revision()

    setlists = _get_setlists(client)

    assert [s["name"] for s in setlists] == ["NIGHT RIDE", "TEST SET"]
    assert [len(s["entries"]) for s in setlists] == [2, 3]
    assert all(entry["entryId"] is None for s in setlists for entry in s["entries"]), (
        "a set nobody has opened must list with no entry ids, not register itself"
    )
    # The shape the frontend reads is otherwise unchanged.
    first = setlists[0]["entries"][0]
    assert first["file"] == "track0.wav"
    assert first["label"] == "Track 0"
    assert first["kind"] == "audio"
    assert first["perf"] == {"cueIn": 0.0, "mixOut": 30.0}
    assert setlists[0]["notes"] == "Imported performance set (Z-AutoDJ)"

    assert _revision() == before, "the setlists listing committed a write"
    assert not list(perf_sets.rglob(SIDECAR)), (
        "the listing rewrote a sidecar in the user's own set folder"
    )


def test_opening_a_set_registers_it_once_and_is_idempotent(
    client: TestClient, perf_sets: Path
) -> None:
    """The open action is where the writes belong -- and only the first time."""
    set_dir = _write_set(perf_sets, "NIGHT RIDE", tracks=2)
    listed = _get_setlists(client)[0]
    set_id = listed["id"]
    before = _revision()

    response = client.post(f"{PREFIX}/setlists/{set_id}/register")
    assert response.status_code == 200, response.text[:400]
    registered = response.json()["setlist"]

    assert registered["id"] == set_id, (
        "the id is hashed from the timeline, so registering must not rename "
        "the set out from under the frontend's merge-by-id"
    )
    entry_ids = [entry["entryId"] for entry in registered["entries"]]
    assert all(isinstance(value, str) and value for value in entry_ids)
    assert len(set(entry_ids)) == 2
    assert [entry["label"] for entry in registered["entries"]] == [
        "Track 0",
        "Track 1",
    ]
    assert _revision() > before, "the open action never registered anything"
    sidecar = json.loads((set_dir / SIDECAR).read_text(encoding="utf-8"))
    assert sidecar == {"track0.wav": entry_ids[0], "track1.wav": entry_ids[1]}

    after_first = _revision()
    again = client.post(f"{PREFIX}/setlists/{set_id}/register")
    assert again.status_code == 200, again.text[:400]
    assert [e["entryId"] for e in again.json()["setlist"]["entries"]] == entry_ids
    assert _revision() == after_first, (
        "opening the same set twice registered its tracks twice"
    )

    relisted = _get_setlists(client)[0]
    assert relisted["id"] == set_id
    assert [entry["entryId"] for entry in relisted["entries"]] == entry_ids
    assert _revision() == after_first, "the listing wrote after registration"


def test_registering_a_set_that_is_not_there_is_a_404(client: TestClient) -> None:
    response = client.post(f"{PREFIX}/setlists/zad-nope-00000000/register")
    assert response.status_code == 404


def test_two_clients_opening_the_same_set_register_each_file_once(
    client: TestClient, perf_sets: Path
) -> None:
    """Two tabs, one set, one entry per file.

    Both callers read the same empty sidecar, so without a claim on the file
    they each call ``register_reference`` and the library grows a second copy
    of every track -- invisible until the user sees each one twice. The route
    holds a per-folder lock, and the store refuses to register a
    ``source_path`` it already has, so the loser of the race reuses the
    winner's entries.
    """
    _write_set(perf_sets, "NIGHT RIDE", tracks=3)
    set_id = _get_setlists(client)[0]["id"]

    start = threading.Barrier(2)
    answers: list[Any] = []
    failures: list[BaseException] = []

    def register() -> None:
        try:
            start.wait(timeout=10)
            answers.append(client.post(f"{PREFIX}/setlists/{set_id}/register"))
        except BaseException as exc:  # noqa: BLE001 - re-raised below
            failures.append(exc)

    threads = [threading.Thread(target=register) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert not failures, failures
    assert [a.status_code for a in answers] == [200, 200]
    per_call = [
        [entry["entryId"] for entry in a.json()["setlist"]["entries"]] for a in answers
    ]
    assert per_call[0] == per_call[1], "the two callers registered different entries"
    assert len(set(per_call[0])) == 3

    listing = client.get(f"{PREFIX}/entries?limit=100")
    assert listing.status_code == 200, listing.text[:400]
    body = listing.json()
    assert body["total"] == 3, (
        f"{body['total']} entries for 3 files: the same file was registered twice"
    )
    store = library_router_module.get_store()
    assert len(store.db.registered_source_paths()) == 3


def test_the_register_route_refuses_a_cross_site_caller(
    client: TestClient, perf_sets: Path
) -> None:
    """It writes, so it carries the same guard as ``/import-folder``."""
    _write_set(perf_sets, "NIGHT RIDE", tracks=2)
    set_id = _get_setlists(client)[0]["id"]

    before = _revision()

    refused = client.post(
        f"{PREFIX}/setlists/{set_id}/register",
        headers={"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"},
    )

    assert refused.status_code == 403
    assert _revision() == before, "a refused caller still committed a write"
    assert not list(perf_sets.rglob(SIDECAR)), "a refused caller still registered"


def test_the_404_does_not_echo_the_id_back(client: TestClient) -> None:
    response = client.post(f"{PREFIX}/setlists/zad-%3Cscript%3E-1/register")
    assert response.status_code == 404
    assert "script" not in response.text


def _main_load_perf_set(store: Any, set_dir: Path) -> Optional[dict[str, Any]]:
    """``_load_perf_set`` as main (851f6a0) shipped it, transcribed verbatim
    from ``backend/modules/library/router.py`` minus its log lines. Main's
    listing registered every track as it listed and hashed the set id over the
    entry dicts it built, so running this is "main listed this folder": it
    writes main's sidecar and returns the id main's browser stored."""
    perf_path = set_dir / "performance.json"
    try:
        perf = json.loads(perf_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    tracks = perf.get("tracks")
    if not isinstance(tracks, list) or not tracks:
        return None

    sidecar_path = set_dir / ".thedaw-import.json"
    try:
        sidecar: dict[str, Any] = json.loads(sidecar_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        sidecar = {}
    if not isinstance(sidecar, dict):
        sidecar = {}
    sidecar_dirty = False

    resolved_set_dir = set_dir.resolve()
    entries: list[dict[str, Any]] = []
    for t in tracks:
        if not isinstance(t, dict):
            continue
        fname = t.get("file")
        if not isinstance(fname, str) or not fname:
            continue
        if (
            fname.startswith(("/", "\\"))
            or re.match(r"^[A-Za-z]:[\\/]", fname)
            or ".." in fname
        ):
            continue
        audio_path = (set_dir / fname).resolve()
        try:
            audio_path.relative_to(resolved_set_dir)
        except ValueError:
            continue
        if not audio_path.is_file():
            continue
        entry_id = sidecar.get(fname)
        if not (isinstance(entry_id, str) and store.get_entry(entry_id) is not None):
            rec = store.register_reference(
                str(audio_path),
                {
                    "source": "performance-set",
                    "title": t.get("title") or audio_path.stem,
                },
            )
            if rec is None:
                continue
            entry_id = rec.id
            sidecar[fname] = entry_id
            sidecar_dirty = True
        perf_block: dict[str, Any] = {}
        for src_key, dst_key in (
            ("cue_in_s", "cueIn"),
            ("mix_out_s", "mixOut"),
            ("transition_s", "transitionSec"),
        ):
            v = t.get(src_key)
            if isinstance(v, (int, float)) and v >= 0:
                perf_block[dst_key] = float(v)
        entry: dict[str, Any] = {
            "entryId": entry_id,
            "label": t.get("title") or audio_path.stem,
            "kind": "audio",
        }
        if perf_block:
            entry["perf"] = perf_block
        entries.append(entry)

    if sidecar_dirty:
        sidecar_path.write_text(json.dumps(sidecar, indent=2), encoding="utf-8")

    if not entries:
        return None
    name = perf.get("name") if isinstance(perf.get("name"), str) else set_dir.name
    digest = hashlib.sha1(
        json.dumps([e for e in entries], sort_keys=True).encode("utf-8")
    ).hexdigest()[:8]
    slug = re.sub(r"[^a-z0-9]+", "-", str(name).lower()).strip("-") or "set"
    mtime_ms = int(perf_path.stat().st_mtime * 1000)
    return {
        "id": f"zad-{slug}-{digest}",
        "name": str(name),
        "entries": entries,
        "createdAt": mtime_ms,
        "updatedAt": mtime_ms,
        "notes": "Imported performance set (Z-AutoDJ)",
    }


def test_a_set_main_listed_names_the_id_main_gave_it(
    client: TestClient, perf_sets: Path
) -> None:
    """Main listed the folder (registering its tracks and storing its id in
    the browser); this build lists it under a new id and says which old id is
    the same set, so the frontend retires that copy instead of showing the
    set twice. The listing still writes nothing."""
    set_dir = _write_set(perf_sets, "NIGHT RIDE", tracks=3)
    store = library_router_module.get_store()
    main_listed = _main_load_perf_set(store, set_dir)
    assert main_listed is not None
    main_id = main_listed["id"]
    before = _revision()

    listed = _get_setlists(client)[0]

    assert listed["id"] != main_id, "the id scheme changed; this test is about that"
    assert listed["legacyIds"] == [main_id], (
        "the listing must name the id main stored for this folder, or the "
        "frontend keeps both copies"
    )
    assert [e["entryId"] for e in listed["entries"]] == [
        e["entryId"] for e in main_listed["entries"]
    ], "main's sidecar ids are reused"
    assert _revision() == before, "the listing committed a write"

    # Opening the set on this build changes neither id.
    registered = client.post(f"{PREFIX}/setlists/{listed['id']}/register")
    assert registered.status_code == 200, registered.text[:400]
    assert registered.json()["setlist"]["id"] == listed["id"]
    assert registered.json()["setlist"]["legacyIds"] == [main_id]
    assert _revision() == before, "every track was registered by main already"


def test_a_set_main_never_listed_has_no_legacy_id(
    client: TestClient, perf_sets: Path
) -> None:
    """No sidecar, no entry ids: there is no copy main could have stored."""
    _write_set(perf_sets, "FRESH SET", tracks=2)
    assert _get_setlists(client)[0]["legacyIds"] == []


def test_a_register_that_dies_writing_the_sidecar_keeps_every_known_id(
    client: TestClient, perf_sets: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Main listed the folder and wrote its sidecar. The user adds a track and
    opens the set on this build, and the write of the updated sidecar dies
    half-way (a crash, a full disk, power loss). The sidecar written in place
    was left torn, read back as ``{}``, and the next listing forgot every
    entry id the folder had -- and with them the id main stored, so the set
    showed twice. Written atomically, the old sidecar survives the failure."""
    set_dir = _write_set(perf_sets, "NIGHT RIDE", tracks=2)
    store = library_router_module.get_store()
    main_listed = _main_load_perf_set(store, set_dir)
    assert main_listed is not None
    main_ids = [e["entryId"] for e in main_listed["entries"]]

    # The user drops a third track into the folder.
    (set_dir / "track2.wav").write_bytes(b"RIFF\x00\x00\x00\x00WAVEdata")
    spec = json.loads((set_dir / "performance.json").read_text(encoding="utf-8"))
    spec["tracks"].append({"file": "track2.wav", "title": "Track 2"})
    (set_dir / "performance.json").write_text(json.dumps(spec), encoding="utf-8")
    set_id = _get_setlists(client)[0]["id"]

    real_write_text = Path.write_text

    def dies_half_way(self: Path, data: str, *args: Any, **kwargs: Any) -> int:
        # The sidecar itself, or the scratch file an atomic write puts beside it.
        if self.name == SIDECAR or self.name.startswith(f".{SIDECAR}."):
            real_write_text(self, data[: len(data) // 2], *args, **kwargs)
            raise OSError("disk went away mid-write")
        return real_write_text(self, data, *args, **kwargs)

    monkeypatch.setattr(Path, "write_text", dies_half_way)
    response = client.post(f"{PREFIX}/setlists/{set_id}/register")
    monkeypatch.setattr(Path, "write_text", real_write_text)
    assert response.status_code == 200, response.text[:400]

    sidecar = json.loads((set_dir / SIDECAR).read_text(encoding="utf-8"))
    assert sidecar == {"track0.wav": main_ids[0], "track1.wav": main_ids[1]}, (
        "the failed write tore the sidecar the folder already had"
    )
    assert not [p.name for p in set_dir.iterdir() if p.name.endswith(".tmp")], (
        "the failed write left its scratch file behind"
    )
    listed = _get_setlists(client)[0]
    assert [e["entryId"] for e in listed["entries"]][:2] == main_ids
    assert main_listed["id"] in listed["legacyIds"], (
        "the listing lost the id main stored, so the set would show twice"
    )
