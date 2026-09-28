"""scripts/build_hall_irs.py: how a seat's eight measured responses become the bundled files.

No network: the archive reader is not exercised, only the processing, on
synthetic responses whose onsets and levels are known.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import numpy as np

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build_hall_irs.py"
_spec = importlib.util.spec_from_file_location("build_hall_irs", SCRIPT)
assert _spec and _spec.loader
build = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build)

RATE = 48000


def _response(onset: int, level: float, frames: int = 24000) -> np.ndarray:
    ir = np.zeros((frames, 2), dtype=np.float64)
    ir[onset] = [level, level * 0.5]
    tail = np.exp(-np.arange(frames - onset - 1) / 400.0) * level * 0.1
    ir[onset + 1 :, 0] = tail
    ir[onset + 1 :, 1] = tail
    return ir


def _seat() -> dict[int, np.ndarray]:
    # Front row arrives first and louder, the back row 5 ms later and softer.
    return {
        k: _response(3200 if k <= 4 else 3440, 0.3 if k <= 4 else 0.2)
        for k in range(1, 9)
    }


def test_every_file_is_written_for_the_seat():
    out = build.prepare_seat(_seat(), RATE)
    assert sorted(out) == ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "stage"]
    for ir in out.values():
        assert ir.dtype == np.float32
        assert ir.shape[1] == 2


def test_the_trim_keeps_the_arrival_differences_between_rows():
    out = build.prepare_seat(_seat(), RATE)
    lead = round(build.LEAD_SEC * RATE)
    assert build.onset_index(out["s1"]) == lead
    assert build.onset_index(out["s5"]) == lead + 240


def test_one_gain_per_seat_keeps_the_level_differences():
    out = build.prepare_seat(_seat(), RATE)
    assert np.isclose(np.abs(out["s1"]).max(), build.PEAK, atol=1e-6)
    assert np.isclose(
        np.abs(out["s5"]).max() / np.abs(out["s1"]).max(), 2 / 3, atol=1e-6
    )
    assert np.isclose(np.abs(out["stage"]).max(), build.PEAK, atol=1e-6)


def test_every_file_fades_to_silence():
    out = build.prepare_seat(_seat(), RATE)
    for ir in out.values():
        assert np.abs(ir[-1]).max() < 1e-12


def test_the_stage_is_the_mean_of_the_eight():
    seat = _seat()
    out = build.prepare_seat(seat, RATE)
    start = 3200 - round(build.LEAD_SEC * RATE)
    mean = np.mean([ir[start:] for ir in seat.values()], axis=0)
    scale = build.PEAK / np.abs(mean).max()
    body = slice(0, len(mean) - round(build.FADE_SEC * RATE))
    assert np.allclose(out["stage"][body], (mean * scale)[body], atol=1e-6)
