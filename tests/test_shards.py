"""Shard Index: schema, DAO, ranking and the notation-free parts of extraction."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from backend.modules.library.db import LibraryDB
from backend.modules.shards import extract, service


@pytest.fixture()
def db(tmp_path: Path) -> LibraryDB:
    d = LibraryDB(tmp_path / "library.db")
    d.upsert_entry(
        {
            "id": "song_a",
            "kind": "audio",
            "title": "Song A",
            "prompt": "",
            "model": "import",
            "duration_sec": 8.0,
            "created_at": 0.0,
            "updated_at": 0.0,
            "metadata_json": "{}",
        }
    )
    yield d
    d.close()


def _row(i: int, **over):
    base = {
        "id": f"song_a__mix__{i}x4",
        "entry_id": "song_a",
        "stem_name": "mix",
        "role": "mix",
        "start_sec": i * 2.0,
        "end_sec": i * 2.0 + 2.0,
        "beats": 4,
        "bar_index": i,
        "bpm": 120.0,
        "key": "A",
        "scale": "minor",
        "camelot": "8A",
        "pc_root": 9,
        "rms_db": -20.0 + i,
        "low_frac": 0.3,
        "onset_density": 2.0,
        "centroid_hz": 1500.0,
        "onset_mask": 0b1000100010001000,
        "energy": i / 3.0,
        "section": "",
        "chord": "Am",
        "words": "",
        "chroma_json": "[]",
        "mfcc_json": "[]",
        "version": 1,
    }
    base.update(over)
    return base


def test_schema_has_shard_tables(db: LibraryDB) -> None:
    assert db.schema_version() >= 6
    assert db.count_shards() == 0


def test_replace_select_and_pairings(db: LibraryDB) -> None:
    db.replace_shards("song_a", [_row(i) for i in range(4)])
    assert db.count_shards() == 4
    assert [r["bar_index"] for r in db.list_shards("song_a")] == [0, 1, 2, 3]
    assert db.get_shard("song_a__mix__2x4")["energy"] == pytest.approx(2 / 3)
    # role='drums' admits LARSNET parts; 'mix' is exact.
    db.replace_shards(
        "song_a", [_row(0, role="kick", id="k"), _row(1, role="mix", id="m")]
    )
    assert {r["id"] for r in db.select_shards(role="drums")} == {"k"}
    assert {r["id"] for r in db.select_shards(role="mix")} == {"m"}
    assert db.select_shards(text="Am")  # chord text match
    # Replacing drops the old rows.
    db.replace_shards("song_a", [])
    assert db.count_shards() == 0
    # Pairings are symmetric and strengthen.
    assert db.bump_pairing("b", "a") == 1.0
    assert db.bump_pairing("a", "b") == 2.0
    assert db.pairing_counts() == {"a": 2, "b": 2}


def test_rank_prefers_key_tempo_and_energy() -> None:
    cands = [
        _row(0, id="far", camelot="2B", bpm=90.0, energy=0.1),
        _row(1, id="near", camelot="8A", bpm=122.0, energy=0.8),
        _row(2, id="neighbour", camelot="9A", bpm=120.0, energy=0.8),
    ]
    ranked = service.rank_shards(cands, camelot="8A", bpm=120.0, energy=(0.7, 1.0))
    assert [r["id"] for r in ranked][:2] == ["near", "neighbour"]
    assert ranked[0]["tempo_ratio"] == pytest.approx(120 / 122, abs=1e-3)


def test_complements_reward_interlock_and_low_end_split() -> None:
    ref = _row(0, id="ref", onset_mask=0b1000100010001000, low_frac=0.8)
    cands = [
        _row(
            1,
            id="same",
            entry_id="b",
            stem_name="x",
            onset_mask=0b1000100010001000,
            low_frac=0.8,
        ),
        _row(
            2,
            id="interlock",
            entry_id="b",
            stem_name="y",
            onset_mask=0b0010001000100010,
            low_frac=0.05,
        ),
    ]
    out = service.rank_complements(ref, cands)
    assert out[0]["id"] == "interlock"


def test_fold_ratio_and_camelot_distance() -> None:
    assert service.fold_ratio(2.0) == pytest.approx(1.0)
    assert service.fold_ratio(0.5) == pytest.approx(1.0)
    assert 0.7 < service.fold_ratio(1.3) < 1.42
    assert service.camelot_distance("8A", "8A") == 0
    assert service.camelot_distance("8A", "9A") == 1
    assert service.camelot_distance("8A", "8B") == 0
    assert service.camelot_distance("12A", "1A") == 1
    assert service.camelot_distance("", "1A") is None


def test_transpose_semitones_minimal() -> None:
    assert service.transpose_semitones("A", "minor", "A", "minor") == 0
    assert service.transpose_semitones("A", "minor", "B", "minor") == 2
    assert service.transpose_semitones("A", "minor", "F#", "minor") == -3
    # A minor → C major is the relative pair: no shift.
    assert service.transpose_semitones("A", "minor", "C", "major") == 0


def test_role_and_id_helpers() -> None:
    assert extract.role_for("drums") == "drums"
    assert extract.role_for("hihat") == "hihat"
    assert extract.role_for("Vocals") == "vocals"
    assert extract.role_for("weird") == "other"
    assert extract.shard_id("e", "bass", 3, 4) == "e__bass__3x4"
    assert extract.shard_id("e", "kick", 3, 1, 2) == "e__kick__3x1b2"


def test_extract_on_synthetic_click_track(db: LibraryDB, tmp_path: Path) -> None:
    """A 120 BPM click train through the real extractor: one-bar shards land on
    the beat grid and the onset mask marks the four beats."""
    librosa = pytest.importorskip("librosa")
    sf = pytest.importorskip("soundfile")
    del librosa
    sr = 22050
    seconds = 8.0
    y = np.zeros(int(sr * seconds), dtype=np.float32)
    beat = 0.5
    for k in range(int(seconds / beat)):
        i = int(k * beat * sr)
        y[i : i + 400] = np.sin(np.arange(400) * 0.3).astype(np.float32) * (
            1.0 if k % 4 == 0 else 0.6
        )
    audio = tmp_path / "click.wav"
    sf.write(str(audio), y, sr)
    beats = [k * beat for k in range(int(seconds / beat))]
    db.upsert_analysis(
        "song_a",
        {
            "bpm": 120.0,
            "beats": beats,
            "key": "A",
            "scale": "minor",
            "rms_db": -20.0,
            "version": 2,
        },
    )
    assert json.loads(db.get_analysis("song_a")["beats_json"]) == beats
    rows = extract.extract_shards(db, "song_a", audio, tmp_path)
    bars = [r for r in rows if r["beats"] == 4]
    assert len(bars) >= 3
    assert bars[0]["start_sec"] == pytest.approx(0.0, abs=0.01)
    assert bars[0]["end_sec"] == pytest.approx(2.0, abs=0.01)
    # Beats at slots 0, 4, 8, 12 of the 16-slot mask.
    assert bars[1]["onset_mask"] & 0b0001000100010001 == 0b0001000100010001
    assert bars[0]["camelot"] == "8A"
    assert db.count_shards() == len(rows)
    assert any(r["beats"] == 8 for r in rows) and any(r["beats"] == 16 for r in rows)
