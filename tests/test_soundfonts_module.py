"""/api/soundfonts: the user's SF2, SF3 and DLS banks, their presets and the
bank-select offset each one is loaded at."""

from __future__ import annotations

import io
import json
import struct
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.lib import known_paths, launch_token
from backend.modules.soundfonts import bankfile, store
from backend.modules.soundfonts.router import router


def _chunk(cid: bytes, body: bytes) -> bytes:
    pad = b"\x00" if len(body) & 1 else b""
    return cid + struct.pack("<I", len(body)) + body + pad


def _list(kind: bytes, body: bytes) -> bytes:
    return _chunk(b"LIST", kind + body)


def make_sf2(name: str, presets: list[tuple[str, int, int]]) -> bytes:
    """A minimal SF2: INFO with its name, a few sample bytes, and a phdr
    listing ``presets`` as (name, program, bank) with the EOP terminal."""
    info = _list(
        b"INFO",
        _chunk(b"ifil", struct.pack("<HH", 2, 1))
        + _chunk(b"INAM", name.encode() + b"\x00"),
    )
    sdta = _list(b"sdta", _chunk(b"smpl", b"\x00\x00" * 64))
    recs = b""
    for i, (pname, program, bank) in enumerate([*presets, ("EOP", 0, 0)]):
        recs += pname.encode().ljust(20, b"\x00") + struct.pack(
            "<HHHIII", program, bank, i, 0, 0, 0
        )
    pdta = _list(b"pdta", _chunk(b"phdr", recs) + _chunk(b"pbag", b"\x00" * 4))
    body = b"sfbk" + info + sdta + pdta
    return b"RIFF" + struct.pack("<I", len(body)) + body


def make_dls(name: str, instruments: list[tuple[str, int, int, int, bool]]) -> bytes:
    """A minimal DLS: (name, program, msb, lsb, drum) per instrument."""
    ins = b""
    for iname, program, msb, lsb, drum in instruments:
        bank = (msb << 8) | lsb | (bankfile.DLS_DRUM_FLAG if drum else 0)
        insh = _chunk(b"insh", struct.pack("<III", 1, bank, program))
        ins += _list(
            b"ins ", insh + _list(b"INFO", _chunk(b"INAM", iname.encode() + b"\x00"))
        )
    colh = _chunk(b"colh", struct.pack("<I", len(instruments)))
    body = (
        b"DLS "
        + colh
        + _list(b"lins", ins)
        + _list(b"INFO", _chunk(b"INAM", name.encode() + b"\x00"))
    )
    return b"RIFF" + struct.pack("<I", len(body)) + body


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    store.set_root_for_tests(tmp_path / "soundfonts")
    monkeypatch.setattr(
        known_paths, "_STORE_PATH", tmp_path / "state" / "known_paths.json"
    )
    monkeypatch.delenv(launch_token.ENV_VAR, raising=False)
    app = FastAPI()
    app.include_router(router, prefix="/api/soundfonts")
    yield TestClient(app, client=("127.0.0.1", 51000))
    store.set_root_for_tests(None)


def _upload(client: TestClient, name: str, data: bytes):
    return client.post(
        "/api/soundfonts/upload",
        files={"file": (name, io.BytesIO(data), "application/octet-stream")},
    )


# ── reading banks ──────────────────────────────────────────────────────────


def test_an_sf2_lists_its_presets_by_bank_with_kits_apart() -> None:
    data = make_sf2(
        "Strings", [("Violin", 40, 0), ("Viola Soft", 41, 2), ("Orch Kit", 48, 128)]
    )
    info = bankfile.read_bank(io.BytesIO(data))
    assert info.name == "Strings"
    assert [(p.bank, p.program, p.name, p.drum) for p in info.presets] == [
        (0, 40, "Violin", False),
        (2, 41, "Viola Soft", False),
        (0, 48, "Orch Kit", True),
    ]
    # Melodic banks 0-2: the bank needs three bank selects from its offset.
    assert info.melodic_span == 3


def test_a_dls_reads_its_bank_msb_lsb_and_drum_flag() -> None:
    data = make_dls("Hall", [("Horn", 60, 1, 5, False), ("Timps", 0, 0, 0, True)])
    info = bankfile.read_bank(io.BytesIO(data))
    assert info.format == "dls" and info.name == "Hall"
    horn, timps = info.presets
    assert (horn.bank, horn.bank_lsb, horn.program, horn.drum) == (1, 5, 60, False)
    assert (timps.program, timps.drum) == (0, True)


def test_something_that_is_not_a_bank_is_refused() -> None:
    with pytest.raises(bankfile.BankFileError):
        bankfile.read_bank(io.BytesIO(b"RIFF\x04\x00\x00\x00WAVE"))
    with pytest.raises(bankfile.BankFileError):
        bankfile.read_bank(io.BytesIO(b"not riff at all"))


# ── offsets ────────────────────────────────────────────────────────────────


def test_offsets_start_past_the_bundled_banks_and_never_overlap() -> None:
    assert store.allocate_offset(1, []) == store.USER_OFFSET_FIRST
    assert store.allocate_offset(2, [(32, 3)]) == 35
    # A gap wide enough is reused.
    assert store.allocate_offset(2, [(32, 1), (36, 1)]) == 33
    assert store.allocate_offset(3, [(32, 1), (35, 1)]) == 36
    with pytest.raises(store.BankStoreError):
        store.allocate_offset(100, [])


# ── the routes ─────────────────────────────────────────────────────────────


def test_an_uploaded_bank_is_listed_with_its_offset_and_remembered(
    client: TestClient,
) -> None:
    resp = _upload(
        client,
        "Strings.sf2",
        make_sf2("Strings", [("Violin", 40, 0), ("Cello", 42, 1)]),
    )
    assert resp.status_code == 200, resp.text
    bank = resp.json()["bank"]
    assert bank["name"] == "Strings" and bank["format"] == "sf2"
    assert bank["offset"] == store.USER_OFFSET_FIRST and bank["span"] == 2
    assert [p["name"] for p in bank["presets"]] == ["Violin", "Cello"]
    assert Path(bank["path"]).is_file()

    second = _upload(
        client, "Hall.dls", make_dls("Hall", [("Horn", 60, 0, 0, False)])
    ).json()["bank"]
    assert second["offset"] == store.USER_OFFSET_FIRST + 2

    listed = client.get("/api/soundfonts").json()
    assert [b["id"] for b in listed["banks"]] == [bank["id"], second["id"]]
    assert listed["offset_range"] == [store.USER_OFFSET_FIRST, store.USER_OFFSET_LAST]

    # The app wrote the file, so it is remembered as a sound bank and servable.
    recent = known_paths.recent("soundfont", None, 10)
    assert {r["path"] for r in recent} >= {bank["path"], second["path"]}
    assert all(r["servable"] for r in recent)


def test_the_file_route_serves_the_stored_bytes(client: TestClient) -> None:
    data = make_sf2("Solo", [("Flute", 73, 0)])
    bank = _upload(client, "Solo.sf3", data).json()["bank"]
    assert bank["format"] == "sf3"
    got = client.get(f"/api/soundfonts/{bank['id']}/file")
    assert got.status_code == 200 and got.content == data
    assert client.get("/api/soundfonts/sb-missing00000/file").status_code == 404


def test_removing_a_bank_frees_its_offset_and_deletes_its_file(
    client: TestClient,
) -> None:
    a = _upload(client, "A.sf2", make_sf2("A", [("Oboe", 68, 0)])).json()["bank"]
    b = _upload(client, "B.sf2", make_sf2("B", [("Bassoon", 70, 0)])).json()["bank"]
    assert client.delete(f"/api/soundfonts/{a['id']}").json() == {"removed": a["id"]}
    assert not Path(a["path"]).exists()
    assert [x["id"] for x in client.get("/api/soundfonts").json()["banks"]] == [b["id"]]
    c = _upload(client, "C.sf2", make_sf2("C", [("Tuba", 58, 0)])).json()["bank"]
    assert c["offset"] == a["offset"], "the freed range is taken again"
    assert client.delete(f"/api/soundfonts/{a['id']}").status_code == 404


def test_a_bad_upload_says_why_and_leaves_nothing(
    client: TestClient, tmp_path: Path
) -> None:
    resp = _upload(client, "notes.txt", b"hello")
    assert resp.status_code == 400 and ".sf2" in resp.json()["detail"]
    resp = _upload(client, "broken.sf2", b"RIFF\x04\x00\x00\x00junk")
    assert resp.status_code == 400
    assert [
        p.name for p in (tmp_path / "soundfonts").iterdir() if p.name != store.REGISTRY
    ] == []


def test_add_path_copies_a_bank_on_this_machine_and_remembers_the_pick(
    client: TestClient, tmp_path: Path
) -> None:
    src = tmp_path / "Downloads" / "Choir.sf2"
    src.parent.mkdir()
    src.write_bytes(make_sf2("Choir", [("Aahs", 52, 0)]))
    resp = client.post("/api/soundfonts/add-path", json={"path": str(src)})
    assert resp.status_code == 200, resp.text
    bank = resp.json()["bank"]
    assert bank["source_path"] == str(src) and Path(bank["path"]).is_file()
    paths = {r["path"] for r in known_paths.recent("soundfont", None, 10)}
    assert str(src) in paths
    # The next sound-bank picker starts where this one was.
    assert known_paths.last_folder("soundfont") == str(src.parent)
    assert (
        client.post(
            "/api/soundfonts/add-path", json={"path": str(tmp_path / "nope.sf2")}
        ).status_code
        == 404
    )


def test_a_caller_on_another_machine_is_not_told_paths_and_cannot_add_by_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store.set_root_for_tests(tmp_path / "soundfonts")
    monkeypatch.setattr(
        known_paths, "_STORE_PATH", tmp_path / "state" / "known_paths.json"
    )
    monkeypatch.delenv(launch_token.ENV_VAR, raising=False)
    app = FastAPI()
    app.include_router(router, prefix="/api/soundfonts")
    local = TestClient(app, client=("127.0.0.1", 51000))
    _upload(local, "A.sf2", make_sf2("A", [("Oboe", 68, 0)]))
    lan = TestClient(app, client=("192.168.1.50", 51000))
    assert lan.get("/api/soundfonts").status_code == 403
    assert (
        lan.post("/api/soundfonts/add-path", json={"path": "C:/x.sf2"}).status_code
        == 403
    )
    store.set_root_for_tests(None)


def test_a_registry_that_went_bad_lists_no_banks(
    client: TestClient, tmp_path: Path
) -> None:
    root = tmp_path / "soundfonts"
    root.mkdir(exist_ok=True)
    (root / store.REGISTRY).write_text("{not json", encoding="utf-8")
    assert client.get("/api/soundfonts").json()["banks"] == []
    (root / store.REGISTRY).write_text(
        json.dumps({"banks": [{"id": "../evil", "file": "x"}]}), encoding="utf-8"
    )
    assert client.get("/api/soundfonts").json()["banks"] == []
