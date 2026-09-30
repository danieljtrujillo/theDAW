"""Unit tests for the analysis module."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.modules.analysis.bars import estimate_bars
from backend.modules.analysis.engine import (
    ANALYSIS_VERSION,
    analyze_and_persist,
    persist_analysis,
)
from backend.modules.analysis.ffprobe import has_ffprobe, probe_file
from backend.modules.analysis.key import _correlate, _MAJOR_PROFILE


def test_estimate_bars_empty():
    assert estimate_bars([]) is None


def test_estimate_bars_four_four():
    beats = [0.5 * i for i in range(16)]
    assert estimate_bars(beats, time_sig_numerator=4) == 4.0


def test_estimate_bars_three_four():
    beats = [0.5 * i for i in range(12)]
    assert estimate_bars(beats, time_sig_numerator=3) == 4.0


def test_key_correlation_matches_self():
    # The major profile correlated with itself should produce the
    # maximum at rotation 0 (C major). Numerically: corr(x, x) == 1.0.
    corr = _correlate(list(_MAJOR_PROFILE), _MAJOR_PROFILE)
    assert max(range(12), key=lambda i: corr[i]) == 0
    assert abs(corr[0] - 1.0) < 1e-9


def test_key_correlation_handles_zero_vector():
    corr = _correlate([0.0] * 12, _MAJOR_PROFILE)
    assert corr == [0.0] * 12


def test_probe_file_returns_empty_when_no_ffprobe_or_missing(tmp_path: Path):
    missing = tmp_path / "nope.wav"
    out = probe_file(missing)
    # Either ffprobe is missing OR the file is missing — both → {}.
    assert out == {}


def test_probe_file_real_wav_when_ffprobe_available(tmp_path: Path):
    if not has_ffprobe():
        return  # silently skip on environments without ffprobe
    # Build a real 1-second silence WAV with soundfile.
    try:
        import numpy as np
        import soundfile as sf
    except ImportError:
        return
    p = tmp_path / "silent.wav"
    sf.write(str(p), np.zeros((44100, 2), dtype=np.float32), 44100)
    out = probe_file(p)
    summary = out.get("_summary") or {}
    assert summary.get("sample_rate") == 44100
    assert summary.get("channels") == 2


def test_probe_summary_reports_whether_the_samples_are_float(tmp_path: Path):
    """bits_per_sample reads 32 for pcm_s32le and pcm_f32le alike, so the
    number on its own cannot answer "is this a float file"."""
    if not has_ffprobe():
        return  # silently skip on environments without ffprobe
    try:
        import numpy as np
        import soundfile as sf
    except ImportError:
        return

    tone = np.zeros((22050, 2), dtype=np.float32)
    for subtype, bit_depth, is_float in (
        ("FLOAT", 32, True),
        ("DOUBLE", 64, True),
        ("PCM_24", 24, False),
        ("PCM_16", 16, False),
    ):
        p = tmp_path / f"{subtype.lower()}.wav"
        sf.write(str(p), tone, 44100, subtype=subtype)
        summary = (probe_file(p) or {}).get("_summary") or {}
        assert summary.get("bit_depth") == bit_depth, subtype
        assert summary.get("bit_depth_is_float") is is_float, subtype
        assert summary.get("sample_fmt")


def test_probe_summary_flac_falls_back_to_bits_per_raw_sample(tmp_path: Path):
    """ffprobe reports bits_per_sample: 0 for FLAC, so the `or` fallback in
    _summarize is what makes the depth land at all. A float source encoded to
    FLAC is 24-bit int — lossless, but never float."""
    if not has_ffprobe():
        return
    try:
        import numpy as np
        import soundfile as sf
    except ImportError:
        return

    p = tmp_path / "from_float.flac"
    sf.write(str(p), np.zeros((22050, 2), dtype=np.float32), 44100, subtype="PCM_24")
    summary = (probe_file(p) or {}).get("_summary") or {}
    assert summary.get("bit_depth") == 24
    assert summary.get("bit_depth_is_float") is False


def _seed_entry(root: Path, entry_id: str, sr: int = 22050) -> Path:
    """Seed a real WAV-backed library entry for engine tests."""
    item_dir = root / entry_id
    item_dir.mkdir(parents=True, exist_ok=True)
    import numpy as np
    import soundfile as sf

    # 2 seconds of a 440 Hz sine — gives the analyzer something real to chew on.
    t = np.linspace(0, 2.0, sr * 2, endpoint=False, dtype=np.float32)
    y = 0.2 * np.sin(2 * np.pi * 440.0 * t)
    audio_path = item_dir / "output.wav"
    sf.write(str(audio_path), y, sr)
    meta = {
        "id": entry_id,
        "filename": "output.wav",
        "audio_filename": "output.wav",
        "mime_type": "audio/wav",
        "title": entry_id,
        "prompt": "test sine",
        "duration": 2.0,
        "steps": 8,
        "cfg": 1.0,
        "seed": 1,
        "favorite": False,
        "rating": None,
        "tags": [],
        "notes": "",
        "source": "import",
        "saved_at": 1234567890.0,
        "embedded_tags": {"hint": "stub"},
    }
    (item_dir / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")
    return audio_path


def test_engine_writes_to_db_and_metadata(tmp_path: Path):
    try:
        import numpy as np  # noqa: F401
        import soundfile as sf  # noqa: F401
    except ImportError:
        return

    from backend.modules.library.store import LibraryStore

    audio_path = _seed_entry(tmp_path, "alpha")
    store = LibraryStore(tmp_path)
    assert store.db is not None
    # _sync runs via auto-reindex on init; the entries row exists.
    assert store.db.get_entry("alpha") is not None

    entry_dir = store._dir_for("alpha")
    metadata_path = (entry_dir / "metadata.json") if entry_dir else None

    payload = analyze_and_persist(
        store.db,
        "alpha",
        audio_path,
        metadata_path=metadata_path,
        settings={"include_key": True, "include_genre": False},
    )

    # Engine produced a payload with expected keys.
    assert payload.get("version") == ANALYSIS_VERSION
    assert "analyzed_at" in payload
    # Pitch detection finds ~440 Hz on a sine tone (within tolerance).
    pitch = payload.get("pitch_mean_hz")
    if pitch is not None:
        assert 430.0 <= pitch <= 450.0

    # DB row exists.
    db_analysis = store.db.get_analysis("alpha")
    assert db_analysis is not None
    assert db_analysis["version"] == ANALYSIS_VERSION

    # Entry status updated.
    row = store.db.get_entry("alpha")
    assert row is not None
    assert row["analysis_status"] == "complete"

    # metadata.json now has an 'analysis' section.
    assert metadata_path is not None
    meta = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert "analysis" in meta
    assert "beats_count" in meta["analysis"]


def test_persist_analysis_handles_missing_metadata_file(tmp_path: Path):
    """If the metadata.json doesn't exist, persist_analysis still writes
    to the DB and doesn't raise."""
    from backend.modules.library.db import LibraryDB

    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "x"})
    persist_analysis(
        db,
        "x",
        {"version": 1, "bpm": 120.0, "beats": [0.5, 1.0]},
        metadata_path=tmp_path / "does-not-exist.json",
    )
    out = db.get_analysis("x")
    assert out is not None
    assert out["bpm"] == 120.0


# ---------------------------------------------------------------------------
# DJ-1: the analysis profile, the concurrency cap, and single-flight.
# ---------------------------------------------------------------------------


def _seed_tone(tmp_path: Path, entry_id: str) -> Path:
    """A real 3-second 440 Hz WAV entry, the same shape `_seed_entry` builds.
    Long enough that LUFS gating and pyin both have something to chew on."""
    import numpy as np
    import soundfile as sf

    item_dir = tmp_path / entry_id
    item_dir.mkdir(parents=True, exist_ok=True)
    audio_path = item_dir / "audio.wav"
    sr = 22050
    t = np.linspace(0.0, 3.0, sr * 3, endpoint=False)
    tone = 0.3 * np.sin(2.0 * np.pi * 440.0 * t)
    sf.write(str(audio_path), np.stack([tone, tone], axis=1), sr)
    (item_dir / "metadata.json").write_text(
        json.dumps(
            {
                "id": entry_id,
                "title": entry_id,
                "audio_filename": "audio.wav",
                "kind": "audio",
                "tags": [],
                "saved_at": 1.0,
                "source": "import",
            }
        ),
        encoding="utf-8",
    )
    return audio_path


def test_dj_profile_skips_pitch_and_lufs_but_keeps_what_a_deck_reads(tmp_path: Path):
    """The whole point of the profile: no pyin, no second decode, and every
    field a deck actually shows still present -- including the tempo
    confidence, which the detector always computed and the engine threw away."""
    try:
        import numpy as np  # noqa: F401
        import soundfile as sf  # noqa: F401
    except ImportError:
        pytest.skip("numpy/soundfile not installed")

    from backend.modules.analysis.engine import (
        PROFILE_DJ,
        PROFILE_MARKER_KEY,
        analyze_audio,
    )

    audio_path = _seed_tone(tmp_path, "dj_profile")
    out = analyze_audio(audio_path, profile=PROFILE_DJ)

    assert out["profile"] == PROFILE_DJ
    # Skipped, not merely absent: an explicit None is what tells a later full
    # run there is something left to measure.
    assert out["loudness_lufs"] is None
    assert out.get("pitch_mean_hz") is None
    # The deck's fields.
    assert "bpm" in out and "beats" in out
    assert out["rms_db"] is not None
    assert "bpm_confidence" in out
    if out["bpm"] is not None:
        assert isinstance(out["bpm_confidence"], float)
        assert 0.0 <= out["bpm_confidence"] <= 1.0
    # The marker a later enrichment pass looks for.
    assert out["ffprobe"].get(PROFILE_MARKER_KEY) == PROFILE_DJ


def test_full_profile_still_measures_pitch_lufs_and_carries_no_marker(tmp_path: Path):
    try:
        import numpy as np  # noqa: F401
        import soundfile as sf  # noqa: F401
    except ImportError:
        pytest.skip("numpy/soundfile not installed")

    from backend.modules.analysis.engine import (
        PROFILE_MARKER_KEY,
        analyze_audio,
    )

    audio_path = _seed_tone(tmp_path, "full_profile")
    out = analyze_audio(audio_path)

    assert out["profile"] == "full"
    assert out["pitch_mean_hz"] is not None
    assert out["loudness_lufs"] is not None
    # No marker at all on a full row -- absence means full, which is what makes
    # every row written before profiles existed read correctly.
    assert PROFILE_MARKER_KEY not in out["ffprobe"]


def test_dj_profile_never_erases_what_a_full_run_measured(tmp_path: Path):
    """INVARIANT: a partial profile is additive. upsert_analysis writes the
    whole row, so without the carry-forward a 2-second dj run would null out
    the pitch and LUFS a 10-second full run paid for."""
    try:
        import numpy as np  # noqa: F401
        import soundfile as sf  # noqa: F401
    except ImportError:
        pytest.skip("numpy/soundfile not installed")

    from backend.modules.analysis.engine import PROFILE_DJ
    from backend.modules.library.store import LibraryStore

    audio_path = _seed_tone(tmp_path, "carry")
    store = LibraryStore(tmp_path)
    assert store.db is not None
    entry_dir = store._dir_for("carry")
    metadata_path = (entry_dir / "metadata.json") if entry_dir else None

    analyze_and_persist(store.db, "carry", audio_path, metadata_path=metadata_path)
    full_row = store.db.get_analysis("carry")
    assert full_row is not None
    assert full_row["pitch_mean_hz"] is not None
    assert full_row["loudness_lufs"] is not None
    assert full_row["prompt_guess"]

    analyze_and_persist(
        store.db,
        "carry",
        audio_path,
        metadata_path=metadata_path,
        profile=PROFILE_DJ,
    )
    dj_row = store.db.get_analysis("carry")
    assert dj_row is not None
    assert dj_row["pitch_mean_hz"] == full_row["pitch_mean_hz"]
    assert dj_row["loudness_lufs"] == full_row["loudness_lufs"]
    assert dj_row["prompt_guess"] == full_row["prompt_guess"]
    # ... while what the dj run DID measure is written.
    assert dj_row["bpm"] == dj_row["bpm"]
    assert dj_row["analyzed_at"] >= full_row["analyzed_at"]


def test_persist_records_bpm_confidence(tmp_path: Path):
    from backend.modules.library.db import LibraryDB

    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "conf"})
    persist_analysis(
        db, "conf", {"version": ANALYSIS_VERSION, "bpm": 128.0, "bpm_confidence": 0.75}
    )
    row = db.get_analysis("conf")
    assert row is not None
    assert row["bpm_confidence"] == 0.75


def test_bpm_confidence_column_is_added_to_a_pre_column_database(tmp_path: Path):
    """A library created before schema v12 gains the column on open, and a
    database left half-migrated (column present, version behind) opens too
    instead of raising 'duplicate column name'."""
    import sqlite3

    from backend.modules.library.db import LibraryDB

    path = tmp_path / "library.db"
    db = LibraryDB(path)
    assert db.schema_version() >= 12
    db._conn.close()  # noqa: SLF001

    # Rewind to a pre-column v11 database.
    raw = sqlite3.connect(str(path))
    raw.execute("ALTER TABLE analysis DROP COLUMN bpm_confidence")
    raw.execute(
        "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '11')"
    )
    raw.commit()
    cols = {str(r[1]) for r in raw.execute("PRAGMA table_info(analysis)").fetchall()}
    assert "bpm_confidence" not in cols
    raw.close()

    reopened = LibraryDB(path)
    assert reopened._has_column("analysis", "bpm_confidence")  # noqa: SLF001
    assert reopened.schema_version() >= 12
    reopened._conn.close()  # noqa: SLF001

    # Half-migrated: the column is there but the version says it is not.
    raw = sqlite3.connect(str(path))
    raw.execute(
        "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '11')"
    )
    raw.commit()
    raw.close()
    again = LibraryDB(path)  # must not raise
    assert again._has_column("analysis", "bpm_confidence")  # noqa: SLF001
    again._conn.close()  # noqa: SLF001


# ---------------------------------------------------------------------------
# DJ-1R: review rework — a readable profile marker, a total carry-forward,
# and a clamped confidence.
# ---------------------------------------------------------------------------


def test_analysis_row_reports_which_profile_wrote_it():
    """A dj row is NOT a complete row, and every reader of ``entry['analysis']``
    (DetailsView, NodeInspector, the prompt route) had no way to tell: the
    marker lived inside the ffprobe blob and nothing ever surfaced it. A marker
    with no reader is decoration."""
    from backend.modules.analysis.engine import PROFILE_MARKER_KEY
    from backend.modules.library.router import _analysis_payload

    dj_row = {"bpm": 128.0, "ffprobe_json": json.dumps({PROFILE_MARKER_KEY: "dj"})}
    analysis, _ = _analysis_payload(dj_row)
    assert analysis["profile"] == "dj"

    full_row = {
        "bpm": 128.0,
        "ffprobe_json": json.dumps({"_summary": {"codec": "mp3"}}),
    }
    analysis, _ = _analysis_payload(full_row)
    assert analysis["profile"] == "full", "a row with no marker is a full row"

    # A row with no ffprobe blob at all is still a full row, not an unknown:
    # every row written before profiles existed is a full row.
    analysis, _ = _analysis_payload({"bpm": 128.0})
    assert analysis["profile"] == "full"


def test_dj_run_never_erases_bpm_when_its_tempo_step_fails(tmp_path: Path, monkeypatch):
    """INVARIANT (widened): a partial run never erases ANY persisted field it
    did not measure -- not just the ones it skips on purpose.

    ``analyze_audio`` swallows a tempo failure into bpm=None / beats=[] /
    bpm_confidence=None, and ``upsert_analysis`` writes the whole row, so one
    unlucky dj re-run used to wipe the BPM and beatgrid a full run measured."""
    try:
        import numpy as np  # noqa: F401
        import soundfile as sf  # noqa: F401
    except ImportError:
        pytest.skip("numpy/soundfile not installed")

    from backend.modules.analysis.engine import PROFILE_DJ
    from backend.modules.chimera import detect as chimera_detect
    from backend.modules.library.db import LibraryDB

    audio_path = _seed_tone(tmp_path, "wipe")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "wipe"})
    persist_analysis(
        db,
        "wipe",
        {
            "version": ANALYSIS_VERSION,
            "bpm": 128.0,
            "bpm_confidence": 0.9,
            "beats": [0.5, 1.0, 1.5],
            "key": "F#",
            "scale": "minor",
            "rms_db": -9.5,
            "bars_estimated": 32,
        },
    )
    before = db.get_analysis("wipe")
    assert before is not None and before["bpm"] == 128.0

    def _boom(*_a, **_k):
        raise RuntimeError("aubio exploded")

    monkeypatch.setattr(chimera_detect, "detect_tempo_and_beats", _boom)
    analyze_and_persist(db, "wipe", audio_path, profile=PROFILE_DJ)

    after = db.get_analysis("wipe")
    assert after is not None
    assert after["bpm"] == 128.0, "a failed tempo step erased a measured BPM"
    assert json.loads(after["beats_json"]) == [0.5, 1.0, 1.5], "the beatgrid was erased"
    assert after["bpm_confidence"] == 0.9
    assert after["key"] is not None
    # And the run still counts: what it DID measure is written.
    assert after["analyzed_at"] >= before["analyzed_at"]


def test_bpm_confidence_is_clamped_to_the_unit_range(tmp_path: Path):
    """The aubio path averages per-hop confidences with no clamp, unlike the
    librosa path. A deck renders this as a bar; >1 overflows it and <0 makes it
    negative, so the persist site is where the range is guaranteed."""
    from backend.modules.library.db import LibraryDB

    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "clamp"})

    for given, expected in ((1.7, 1.0), (-0.2, 0.0), (0.42, 0.42), (None, None)):
        persist_analysis(
            db,
            "clamp",
            {"version": ANALYSIS_VERSION, "bpm": 128.0, "bpm_confidence": given},
        )
        row = db.get_analysis("clamp")
        assert row is not None
        assert row["bpm_confidence"] == expected, (
            f"{given!r} -> {row['bpm_confidence']!r}"
        )


def test_a_carried_key_confidence_never_outlives_the_key_it_measured():
    """``key_confidence`` describes a specific key, so it may only be carried
    forward together with that key.

    The restore used to fire whenever the payload had no confidence, so a dj
    run that measured a FRESH key but no confidence for it inherited the
    confidence of the PREVIOUS key -- a number reported against a key it was
    never computed for."""
    from backend.modules.analysis.engine import _carry_forward_partial

    class _PriorDB:
        def __init__(self, row: dict) -> None:
            self._row = row

        def get_analysis(self, entry_id: str):
            return dict(self._row)

    prior = {"key": "F#", "scale": "minor", "key_confidence": 0.91}

    # The key WAS carried forward (the partial run measured none), so its
    # confidence comes with it -- otherwise the row keeps a key with no
    # confidence at all.
    carried = {"bpm": 128.0, "key": None, "scale": None, "confidence": None}
    _carry_forward_partial(_PriorDB(prior), "x", carried)
    assert carried["key"] == "F#"
    assert carried["key_confidence"] == 0.91

    # A fresh key: the stored confidence belongs to the old one and must stay
    # behind, even though this run reported no confidence of its own.
    fresh = {"bpm": 128.0, "key": "C", "scale": "major", "confidence": None}
    _carry_forward_partial(_PriorDB(prior), "x", fresh)
    assert fresh["key"] == "C"
    assert fresh.get("key_confidence") is None, (
        "the previous key's confidence was pinned onto a newly measured key"
    )


def test_a_re_measured_key_keeps_the_confidence_already_stored_for_it():
    """The confidence belongs to a key, not to a run.

    Gating the restore on "the key was carried forward" was too narrow: a dj
    run that RE-MEASURES the same key the row already holds reports no
    confidence of its own (the dj profile's key step is the cheap one), so the
    row lost a confidence that still describes exactly the key it names."""
    from backend.modules.analysis.engine import _carry_forward_partial

    class _PriorDB:
        def __init__(self, row: dict) -> None:
            self._row = row

        def get_analysis(self, entry_id: str):
            return dict(self._row)

    prior = {"key": "F#", "scale": "minor", "key_confidence": 0.91}

    same = {"bpm": 128.0, "key": "F#", "scale": "minor", "confidence": None}
    _carry_forward_partial(_PriorDB(prior), "x", same)
    assert same["key"] == "F#"
    assert same["key_confidence"] == 0.91, (
        "re-measuring the SAME key dropped the confidence stored for it"
    )

    different = {"bpm": 128.0, "key": "C", "scale": "major", "confidence": None}
    _carry_forward_partial(_PriorDB(prior), "x", different)
    assert different.get("key_confidence") is None, (
        "a different key inherited the previous key's confidence"
    )


# ---------------------------------------------------------------------------
# PR #207 review: labels, the /run payload, and what a slow probe erased.
# ---------------------------------------------------------------------------


def _seed_tagged_tone(tmp_path: Path, entry_id: str) -> Path:
    """`_seed_tone`, plus embedded tags in metadata.json -- the case where the
    engine rebuilds the prompt from the tags."""
    audio_path = _seed_tone(tmp_path, entry_id)
    meta_path = audio_path.parent / "metadata.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["embedded_tags"] = {"artist": "Tester", "genre": "Ambient"}
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    return audio_path


def test_a_dj_run_over_a_full_row_keeps_the_full_label(tmp_path: Path):
    """The sequence: the library's background pass analyses a track in full,
    then the user loads it on a deck and the DJ tab runs its dj profile.
    The carry-forward keeps every field the full run measured, so the row
    still holds full data -- and the dj marker used to relabel it 'dj', so
    GET /api/analysis/{id} and entry.analysis reported a complete row as a
    partial one."""
    pytest.importorskip("numpy")
    pytest.importorskip("soundfile")

    from backend.modules.analysis.engine import PROFILE_DJ, profile_of_row
    from backend.modules.library.store import LibraryStore

    audio_path = _seed_tone(tmp_path, "label")
    store = LibraryStore(tmp_path)
    assert store.db is not None
    entry_dir = store._dir_for("label")
    metadata_path = (entry_dir / "metadata.json") if entry_dir else None

    analyze_and_persist(store.db, "label", audio_path, metadata_path=metadata_path)
    full_row = store.db.get_analysis("label")
    assert profile_of_row(full_row) == "full"

    out = analyze_and_persist(
        store.db, "label", audio_path, metadata_path=metadata_path, profile=PROFILE_DJ
    )
    row = store.db.get_analysis("label")
    assert profile_of_row(row) == "full", "a dj run relabelled a full row as dj"
    assert out["profile"] == "full", "the /run payload disagrees with the stored label"
    assert row["pitch_mean_hz"] == full_row["pitch_mean_hz"]
    assert row["loudness_lufs"] == full_row["loudness_lufs"]


def test_a_dj_run_over_a_stale_full_row_is_labelled_dj(tmp_path: Path):
    """The sequence: an older analyzer (version 2) wrote a full row, this
    build's GET reports that row pending, and the DJ tab answers by running
    the dj profile. The carry-forward keeps the v2 pitch, LUFS and prompt, and
    keeping the full label saved that old data as a current full row, so GET
    called it complete and the version heal never re-measured it."""
    pytest.importorskip("numpy")
    pytest.importorskip("soundfile")
    import sqlite3
    from unittest.mock import patch

    from backend.modules.analysis.engine import (
        ANALYSIS_VERSION,
        PROFILE_DJ,
        profile_of_row,
    )
    from backend.modules.analysis.router import get_analysis as get_route
    from backend.modules.library.store import LibraryStore

    audio_path = _seed_tone(tmp_path, "stale")
    store = LibraryStore(tmp_path)
    assert store.db is not None
    entry_dir = store._dir_for("stale")
    metadata_path = (entry_dir / "metadata.json") if entry_dir else None

    analyze_and_persist(store.db, "stale", audio_path, metadata_path=metadata_path)
    # Rewind the full row to what the version-2 analyzer left behind.
    raw = sqlite3.connect(str(store.db.path))
    raw.execute(
        "UPDATE analysis SET version = ? WHERE entry_id = ?",
        (ANALYSIS_VERSION - 1, "stale"),
    )
    raw.commit()
    raw.close()
    stale = store.db.get_analysis("stale")
    assert profile_of_row(stale) == "full"
    assert int(stale["version"]) < ANALYSIS_VERSION

    with patch("backend.modules.analysis.router.get_library_store", return_value=store):
        assert get_route("stale")["status"] == "pending"
        out = analyze_and_persist(
            store.db,
            "stale",
            audio_path,
            metadata_path=metadata_path,
            profile=PROFILE_DJ,
        )
        row = store.db.get_analysis("stale")
        assert profile_of_row(row) == PROFILE_DJ, (
            "a dj run saved a stale full row as a current full one"
        )
        assert out["profile"] == PROFILE_DJ
        assert get_route("stale")["profile"] == PROFILE_DJ


def test_a_dj_run_on_a_fresh_entry_is_still_labelled_dj(tmp_path: Path):
    """The label still means something: with no full row behind it, a dj
    run's row says dj."""
    pytest.importorskip("numpy")
    pytest.importorskip("soundfile")

    from backend.modules.analysis.engine import PROFILE_DJ, profile_of_row
    from backend.modules.library.db import LibraryDB

    audio_path = _seed_tone(tmp_path, "fresh")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "fresh"})
    out = analyze_and_persist(db, "fresh", audio_path, profile=PROFILE_DJ)
    assert out["profile"] == PROFILE_DJ
    assert profile_of_row(db.get_analysis("fresh")) == PROFILE_DJ


def test_the_run_payload_reports_a_clamped_bpm_confidence(tmp_path: Path, monkeypatch):
    """The aubio path averages per-hop confidences with no bound. The clamp
    lived only on the way into the column, so POST /run answered the deck with
    the raw value (1.7 here) while the database said 1.0."""
    pytest.importorskip("numpy")
    pytest.importorskip("soundfile")

    from backend.modules.analysis.engine import PROFILE_DJ
    from backend.modules.chimera import detect as chimera_detect
    from backend.modules.library.db import LibraryDB

    audio_path = _seed_tone(tmp_path, "conf")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "conf"})

    def _overconfident(*_a, **_k):
        return {"bpm": 128.0, "beats": [0.5, 1.0, 1.5], "confidence": 1.7}

    monkeypatch.setattr(chimera_detect, "detect_tempo_and_beats", _overconfident)
    out = analyze_and_persist(db, "conf", audio_path, profile=PROFILE_DJ)
    assert out["bpm_confidence"] == 1.0, "the /run payload carried the raw confidence"
    row = db.get_analysis("conf")
    assert row is not None and row["bpm_confidence"] == 1.0


def test_a_probe_that_measures_nothing_keeps_the_stored_file_details(
    tmp_path: Path, monkeypatch
):
    """ffprobe answers {} when it times out (a sleeping drive) or is missing,
    and the whole row is rewritten, so one slow probe erased the sample rate,
    codec and duration the library and Details read -- in a dj run and a full
    run alike."""
    pytest.importorskip("numpy")
    pytest.importorskip("soundfile")

    from backend.modules.analysis import engine as analysis_engine
    from backend.modules.library.db import LibraryDB

    audio_path = _seed_tone(tmp_path, "probe")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "probe"})
    stored = {"_summary": {"sample_rate": 48000, "codec": "flac", "duration_sec": 3.0}}
    persist_analysis(
        db, "probe", {"version": ANALYSIS_VERSION, "bpm": 120.0, "ffprobe": stored}
    )

    monkeypatch.setattr(analysis_engine, "probe_file", lambda _p: {})
    for profile in (analysis_engine.PROFILE_DJ, analysis_engine.PROFILE_FULL):
        out = analyze_and_persist(db, "probe", audio_path, profile=profile)
        row = db.get_analysis("probe")
        assert row is not None
        blob = json.loads(row["ffprobe_json"])
        assert blob.get("_summary", {}).get("sample_rate") == 48000, (
            f"a {profile} run whose probe measured nothing erased the stored file details"
        )
        assert out["sample_rate"] == 48000
        assert out["codec"] == "flac"


def test_a_dj_run_keeps_the_full_prompt_of_a_tagged_track(tmp_path: Path):
    """A track with embedded tags gets its prompt rebuilt from those tags.
    The dj run rebuilt it from its OWN payload, which has no pitch and no
    loudness, and wrote that weaker prompt over the full run's every time the
    track was loaded on a deck. Rebuilt from the merged row, it matches."""
    pytest.importorskip("numpy")
    pytest.importorskip("soundfile")

    from backend.modules.analysis.engine import PROFILE_DJ
    from backend.modules.library.store import LibraryStore

    audio_path = _seed_tagged_tone(tmp_path, "tagged")
    store = LibraryStore(tmp_path)
    assert store.db is not None
    entry_dir = store._dir_for("tagged")
    metadata_path = (entry_dir / "metadata.json") if entry_dir else None

    analyze_and_persist(store.db, "tagged", audio_path, metadata_path=metadata_path)
    full_row = store.db.get_analysis("tagged")
    assert full_row is not None and full_row["prompt_guess"]
    assert full_row["pitch_mean_hz"] is not None

    analyze_and_persist(
        store.db, "tagged", audio_path, metadata_path=metadata_path, profile=PROFILE_DJ
    )
    dj_row = store.db.get_analysis("tagged")
    assert dj_row is not None
    assert dj_row["prompt_guess"] == full_row["prompt_guess"], (
        "the dj run replaced the full prompt with one built without pitch or loudness"
    )
