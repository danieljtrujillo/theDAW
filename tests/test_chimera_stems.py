"""Unit tests for backend.modules.chimera.stems.

Synthetic, deterministic, CPU-only. The library store is replaced with a
tiny fake so no SQLite / filesystem library is touched; stems are short
WAVs written into tmp_path.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from backend.modules.chimera import stems as stems_mod
from tests.chimera_synth import fft_peak_hz, write_wav


SR = 44100


def _tone(freq_hz: float, dur_sec: float, sr: int, amp: float = 0.2) -> np.ndarray:
    t = np.arange(int(dur_sec * sr), dtype=np.float64) / sr
    mono = (amp * np.sin(2 * np.pi * freq_hz * t)).astype(np.float32)
    return np.stack([mono, mono], axis=1)


def _fake_store(rows: list[dict], root: Path | None = None):
    db = SimpleNamespace(list_stems=lambda entry_id: rows)
    return SimpleNamespace(db=db, root=root)


def _read(path: Path) -> tuple[np.ndarray, int]:
    audio, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return audio, int(sr)


# ---------------------------------------------------------------------------
# resolve_cached_stems
# ---------------------------------------------------------------------------


def test_resolve_cached_stems_from_fake_store(tmp_path: Path, monkeypatch):
    entry_dir = tmp_path / "entry1" / "stems"
    names = ["drums", "bass", "vocals", "other"]
    paths = {n: write_wav(entry_dir, n, _tone(100.0, 0.1, SR), SR) for n in names}

    rows = [{"stem_name": n, "audio_path": str(p)} for n, p in paths.items()]
    # A stem whose file was deleted must be dropped, not returned.
    rows.append({"stem_name": "guitar", "audio_path": str(entry_dir / "gone.wav")})
    monkeypatch.setattr(stems_mod, "get_store", lambda: _fake_store(rows))

    out = stems_mod.resolve_cached_stems("entry1")
    assert out is not None
    assert set(out) == set(names)
    assert "guitar" not in out
    for n in names:
        assert out[n].is_file()
        assert out[n].is_absolute()
        assert out[n].resolve() == paths[n].resolve()


def test_resolve_relative_rows_resolve_against_store_root(tmp_path: Path, monkeypatch):
    entry_dir = tmp_path / "entry2" / "stems"
    write_wav(entry_dir, "drums", _tone(100.0, 0.05, SR), SR)
    write_wav(entry_dir, "bass", _tone(60.0, 0.05, SR), SR)
    rows = [
        # <root>/<relative>
        {"stem_name": "drums", "audio_path": "entry2/stems/drums.wav"},
        # bare filename -> <root>/<entry_id>/stems/<name>
        {"stem_name": "bass", "audio_path": "bass.wav"},
    ]
    monkeypatch.setattr(
        stems_mod, "get_store", lambda: _fake_store(rows, root=tmp_path)
    )
    out = stems_mod.resolve_cached_stems("entry2")
    assert out is not None
    assert set(out) == {"drums", "bass"}
    assert out["drums"].resolve() == (entry_dir / "drums.wav").resolve()
    assert out["bass"].resolve() == (entry_dir / "bass.wav").resolve()


def test_resolve_returns_none_on_error_or_unknown(tmp_path: Path, monkeypatch):
    # entry_id None / empty -> None without touching the store.
    def _boom():
        raise AssertionError("store must not be consulted without an entry id")

    monkeypatch.setattr(stems_mod, "get_store", _boom)
    assert stems_mod.resolve_cached_stems(None) is None
    assert stems_mod.resolve_cached_stems("") is None

    # get_store raising -> None (never propagates).
    def _raise():
        raise RuntimeError("library unavailable")

    monkeypatch.setattr(stems_mod, "get_store", _raise)
    assert stems_mod.resolve_cached_stems("entry1") is None

    # list_stems raising -> None.
    def _db_raise(entry_id):
        raise RuntimeError("db locked")

    monkeypatch.setattr(
        stems_mod,
        "get_store",
        lambda: SimpleNamespace(db=SimpleNamespace(list_stems=_db_raise), root=None),
    )
    assert stems_mod.resolve_cached_stems("entry1") is None

    # DB disabled -> None.
    monkeypatch.setattr(stems_mod, "get_store", lambda: SimpleNamespace(db=None))
    assert stems_mod.resolve_cached_stems("entry1") is None

    # Unknown entry (no rows) -> None.
    monkeypatch.setattr(stems_mod, "get_store", lambda: _fake_store([]))
    assert stems_mod.resolve_cached_stems("nope") is None

    # Rows whose files are all missing -> None.
    rows = [{"stem_name": "drums", "audio_path": str(tmp_path / "missing.wav")}]
    monkeypatch.setattr(stems_mod, "get_store", lambda: _fake_store(rows))
    assert stems_mod.resolve_cached_stems("entry1") is None


# ---------------------------------------------------------------------------
# build_role_sources
# ---------------------------------------------------------------------------


def test_build_role_sources_groups(tmp_path: Path):
    dur = 0.25
    src = tmp_path / "src"
    drums = _tone(100.0, dur, SR, amp=0.10)
    bass = _tone(60.0, dur, SR, amp=0.15)
    vocals = _tone(440.0, dur, SR, amp=0.12)
    other = _tone(880.0, dur, SR, amp=0.08)
    p = {
        "drums": write_wav(src, "drums", drums, SR),
        "bass": write_wav(src, "bass", bass, SR),
        "vocals": write_wav(src, "vocals", vocals, SR),
        "other": write_wav(src, "other", other, SR),
    }

    # Full set: found = drums + bass, layer = vocals + other.
    out = stems_mod.build_role_sources(dict(p), tmp_path / "w1", SR)
    assert out is not None and set(out) == {"found", "layer"}
    found, sr_f = _read(out["found"])
    layer, sr_l = _read(out["layer"])
    assert sr_f == SR and sr_l == SR
    assert found.shape == drums.shape and layer.shape == vocals.shape
    assert found.shape[1] == 2
    np.testing.assert_allclose(found, drums + bass, atol=1e-6)
    np.testing.assert_allclose(layer, vocals + other, atol=1e-6)

    # Partial set that still forms both groups: found = drums, layer = vocals.
    out = stems_mod.build_role_sources(
        {"drums": p["drums"], "vocals": p["vocals"]}, tmp_path / "w2", SR
    )
    assert out is not None
    found, _ = _read(out["found"])
    layer, _ = _read(out["layer"])
    np.testing.assert_allclose(found, drums, atol=1e-6)
    np.testing.assert_allclose(layer, vocals, atol=1e-6)

    # Only one group present -> None (fall back to the full mix).
    assert (
        stems_mod.build_role_sources({"drums": p["drums"]}, tmp_path / "w3", SR) is None
    )
    assert (
        stems_mod.build_role_sources(
            {"vocals": p["vocals"], "other": p["other"]}, tmp_path / "w4", SR
        )
        is None
    )
    assert stems_mod.build_role_sources({}, tmp_path / "w5", SR) is None
    assert stems_mod.build_role_sources(None, tmp_path / "w6", SR) is None

    # Stem names are matched case-insensitively.
    out = stems_mod.build_role_sources(
        {"Drums": p["drums"], "VOCALS": p["vocals"]}, tmp_path / "w7", SR
    )
    assert out is not None


def test_build_role_sources_never_raises_on_bad_file(tmp_path: Path):
    bad = tmp_path / "drums.wav"
    bad.write_bytes(b"not a wav")
    vocals = write_wav(tmp_path, "vocals", _tone(440.0, 0.1, SR), SR)
    assert (
        stems_mod.build_role_sources(
            {"drums": bad, "vocals": vocals}, tmp_path / "w", SR
        )
        is None
    )


def test_role_sources_resample_mismatched_sr(tmp_path: Path):
    dur = 0.5
    out_sr = SR
    low_sr = 22050
    # drums at 22050 Hz, everything else at 44100 Hz; the summed output must
    # be at out_sr with the same duration and the drums' tone preserved.
    drums_lo = _tone(300.0, dur, low_sr, amp=0.2)
    bass = _tone(60.0, dur, out_sr, amp=0.05)
    vocals_lo = _tone(440.0, dur, low_sr, amp=0.2)
    p = {
        "drums": write_wav(tmp_path, "drums", drums_lo, low_sr),
        "bass": write_wav(tmp_path, "bass", bass, out_sr),
        "vocals": write_wav(tmp_path, "vocals", vocals_lo, low_sr),
    }
    out = stems_mod.build_role_sources(p, tmp_path / "w", out_sr)
    assert out is not None
    found, sr_f = _read(out["found"])
    layer, sr_l = _read(out["layer"])
    assert sr_f == out_sr and sr_l == out_sr
    expected_n = int(dur * out_sr)
    assert abs(found.shape[0] - expected_n) <= 2
    assert abs(layer.shape[0] - expected_n) <= 2
    assert found.shape[1] == 2 and layer.shape[1] == 2
    # The resampled drums dominate found (0.2 vs 0.05) -> 300 Hz peak.
    assert abs(fft_peak_hz(found, out_sr) - 300.0) < 2.0
    assert abs(fft_peak_hz(layer, out_sr) - 440.0) < 2.0
    assert np.all(np.isfinite(found)) and np.all(np.isfinite(layer))
    assert float(np.max(np.abs(layer))) == pytest.approx(0.2, abs=0.02)
