"""Tests for the candidates filesystem store.

A candidate is a generate-several result that is not yet in the library.
Every test here uses ``tmp_path`` for the store root — never the user's
real generations/candidates trees.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from backend.modules.candidates.store import (
    MAX_CANDIDATE_BYTES,
    MAX_CANDIDATES_PER_SET,
    CandidateStore,
    default_candidates_root,
    is_token,
)


@pytest.fixture
def store(tmp_path: Path) -> CandidateStore:
    return CandidateStore(tmp_path / "candidates")


def _wav_bytes(n: int = 16) -> bytes:
    return b"RIFF" + bytes(n)


def test_default_root_is_sibling_of_library(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path / "generations"))
    assert default_candidates_root() == tmp_path / "candidates"


def test_create_set_writes_set_json(store: CandidateStore) -> None:
    set_id = store.create_set(
        source={
            "kind": "track",
            "id": "abc123",
            "revision": 1,
            "start_sec": 0.0,
            "end_sec": 8.0,
        },
        provider="suno",
        params={"style": "lofi"},
        label="lofi variations",
    )

    assert is_token(set_id)
    set_json = store.root / set_id / "set.json"
    assert set_json.is_file()
    header = json.loads(set_json.read_text(encoding="utf-8"))
    assert header["id"] == set_id
    assert header["provider"] == "suno"
    assert header["label"] == "lofi variations"
    assert header["source"]["id"] == "abc123"
    assert isinstance(header["created_at"], float)


def test_add_candidate_writes_audio_and_meta(store: CandidateStore) -> None:
    set_id = store.create_set(
        source={"id": "abc"}, provider="suno", params={}, label="x"
    )

    candidate_id = store.add_candidate(
        set_id,
        audio_bytes=_wav_bytes(),
        filename="take.wav",
        mime_type="audio/wav",
        provider_job_id="job-1",
        params={"seed": 42},
        seed=42,
    )

    assert is_token(candidate_id)
    audio_path = store.root / set_id / f"{candidate_id}.wav"
    meta_path = store.root / set_id / f"{candidate_id}.json"
    assert audio_path.is_file()
    assert audio_path.read_bytes() == _wav_bytes()
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert meta["status"] == "ready"
    assert meta["filename"] == f"{candidate_id}.wav"
    assert meta["mime_type"] == "audio/wav"
    assert meta["provider_job_id"] == "job-1"
    assert meta["seed"] == 42


def test_a_take_cut_off_mid_write_leaves_nothing_at_its_name(
    store: CandidateStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The disk fills halfway through the take. Written in place, the take's
    own name held half a file for the next save or a re-scan to trip on; the
    atomic write leaves the set as it was: no take, no meta, no temp file."""
    set_id = store.create_set(
        source={"id": "abc"}, provider="suno", params={}, label="x"
    )
    before = sorted(p.name for p in (store.root / set_id).iterdir())
    real_write_bytes = Path.write_bytes

    def disk_fills(self: Path, data: bytes) -> int:
        real_write_bytes(self, data[: len(data) // 2])
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(Path, "write_bytes", disk_fills)
    with pytest.raises(OSError, match="No space"):
        store.add_candidate(
            set_id,
            audio_bytes=_wav_bytes(4096),
            filename="take.wav",
            mime_type="audio/wav",
            provider_job_id=None,
            params={},
            seed=None,
        )
    monkeypatch.undo()

    assert sorted(p.name for p in (store.root / set_id).iterdir()) == before
    listed = next(s for s in store.list_sets() if s["id"] == set_id)
    assert listed["candidates"] == []


def test_add_candidate_rejects_empty_and_oversize(store: CandidateStore) -> None:
    set_id = store.create_set(
        source={"id": "abc"}, provider="suno", params={}, label="x"
    )

    with pytest.raises(ValueError, match="empty"):
        store.add_candidate(
            set_id,
            audio_bytes=b"",
            filename="a.wav",
            mime_type="audio/wav",
            provider_job_id=None,
            params={},
            seed=None,
        )

    with pytest.raises(ValueError, match=str(MAX_CANDIDATE_BYTES)):
        store.add_candidate(
            set_id,
            audio_bytes=b"x" * (MAX_CANDIDATE_BYTES + 1),
            filename="a.wav",
            mime_type="audio/wav",
            provider_job_id=None,
            params={},
            seed=None,
        )


def test_set_full_raises(store: CandidateStore) -> None:
    set_id = store.create_set(
        source={"id": "abc"}, provider="suno", params={}, label="x"
    )

    for _ in range(MAX_CANDIDATES_PER_SET):
        store.add_candidate(
            set_id,
            audio_bytes=_wav_bytes(),
            filename="a.wav",
            mime_type="audio/wav",
            provider_job_id=None,
            params={},
            seed=None,
        )

    with pytest.raises(ValueError, match="full"):
        store.add_candidate(
            set_id,
            audio_bytes=_wav_bytes(),
            filename="a.wav",
            mime_type="audio/wav",
            provider_job_id=None,
            params={},
            seed=None,
        )


@pytest.mark.parametrize(
    "bad_id", ["../x", "abc", "", "not-a-token", "..\\..\\windows"]
)
def test_bad_id_raises_value_error(store: CandidateStore, bad_id: str) -> None:
    with pytest.raises(ValueError):
        store.get_set(bad_id)
    with pytest.raises(ValueError):
        store.audio_path(bad_id, bad_id)
    with pytest.raises(ValueError):
        store.dismiss(bad_id, bad_id)
    with pytest.raises(ValueError):
        store.mark_accepted(bad_id, bad_id, "lib-entry-1")


def test_audio_path_contained(store: CandidateStore) -> None:
    set_id = store.create_set(
        source={"id": "abc"}, provider="suno", params={}, label="x"
    )
    candidate_id = store.add_candidate(
        set_id,
        audio_bytes=_wav_bytes(),
        filename="take.wav",
        mime_type="audio/wav",
        provider_job_id=None,
        params={},
        seed=None,
    )

    resolved = store.audio_path(set_id, candidate_id)

    assert resolved is not None
    assert resolved.is_file()
    root_normcase = os.path.normcase(str(store.root.resolve()))
    assert os.path.normcase(str(resolved.resolve())).startswith(root_normcase)


def test_dismiss_moves_files_and_never_deletes(store: CandidateStore) -> None:
    set_id = store.create_set(
        source={"id": "abc"}, provider="suno", params={}, label="x"
    )
    candidate_id = store.add_candidate(
        set_id,
        audio_bytes=_wav_bytes(),
        filename="take.wav",
        mime_type="audio/wav",
        provider_job_id=None,
        params={},
        seed=None,
    )
    old_audio = store.root / set_id / f"{candidate_id}.wav"
    old_meta = store.root / set_id / f"{candidate_id}.json"

    result = store.dismiss(set_id, candidate_id)

    assert result["status"] == "dismissed"
    dismissed_audio = store.root / set_id / "dismissed" / f"{candidate_id}.wav"
    dismissed_meta = store.root / set_id / "dismissed" / f"{candidate_id}.json"
    assert dismissed_audio.is_file()
    assert dismissed_meta.is_file()
    assert not old_audio.exists()
    assert not old_meta.exists()
    # Never deleted: the bytes still exist somewhere under the set.
    assert dismissed_audio.read_bytes() == _wav_bytes()


def test_mark_accepted_sets_status_and_library_entry_id(store: CandidateStore) -> None:
    set_id = store.create_set(
        source={"id": "abc"}, provider="suno", params={}, label="x"
    )
    candidate_id = store.add_candidate(
        set_id,
        audio_bytes=_wav_bytes(),
        filename="take.wav",
        mime_type="audio/wav",
        provider_job_id=None,
        params={},
        seed=None,
    )

    result = store.mark_accepted(set_id, candidate_id, "lib-entry-1")

    assert result["status"] == "accepted"
    assert result["library_entry_id"] == "lib-entry-1"
    meta_path = store.root / set_id / f"{candidate_id}.json"
    on_disk = json.loads(meta_path.read_text(encoding="utf-8"))
    assert on_disk["status"] == "accepted"
    assert on_disk["library_entry_id"] == "lib-entry-1"


def test_sets_and_candidates_made_in_one_clock_tick_keep_their_order(
    store: CandidateStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Windows' time.time() moves in 15.6 ms steps, so sets and candidates
    made in quick succession got the same created_at. list_sets then fell
    back to folder order (random ids), and "newest first" was a coin toss:
    test_list_sets_filters_by_source_id failed on a full-suite run here."""
    import time

    monkeypatch.setattr(time, "time", lambda: 1_790_000_000.0)
    made = [
        store.create_set(source={"id": "t"}, provider="suno", params={}, label=str(i))
        for i in range(6)
    ]
    assert [s["id"] for s in store.list_sets()] == made[::-1]

    added = [
        store.add_candidate(
            made[0],
            audio_bytes=_wav_bytes(),
            filename=f"take{i}.wav",
            mime_type="audio/wav",
            provider_job_id=None,
            params={},
            seed=None,
        )
        for i in range(6)
    ]
    listed = next(s for s in store.list_sets() if s["id"] == made[0])
    assert [c["id"] for c in listed["candidates"]] == added


def test_list_sets_filters_by_source_id(store: CandidateStore) -> None:
    set_a = store.create_set(
        source={"id": "track-a"}, provider="suno", params={}, label="a"
    )
    set_b = store.create_set(
        source={"id": "track-b"}, provider="suno", params={}, label="b"
    )

    all_sets = store.list_sets()
    assert {s["id"] for s in all_sets} == {set_a, set_b}
    # newest first
    assert [s["id"] for s in all_sets] == [set_b, set_a]

    only_a = store.list_sets(source_id="track-a")
    assert [s["id"] for s in only_a] == [set_a]
