"""Unit tests for the multi-region inpaint mask helpers in backend.server.

``_parse_inpaint_regions`` and ``_build_inpaint_mask`` are pure functions used
by POST /api/generate-jobs and POST /api/generate when the ``inpaint_regions``
form field is present. Importing ``backend.server`` must stay cheap: it must
not load a model or touch the heavy torch stack at module scope.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
import torch
import torch.nn.functional as F
from fastapi import HTTPException

from backend.server import _build_inpaint_mask, _parse_inpaint_regions

REPO_ROOT = Path(__file__).resolve().parents[1]

SR = 44100
SIZE = 10 * SR  # 10 s
LATENT_DS = 4096


def _zero_runs(mask: torch.Tensor) -> list[tuple[int, int]]:
    """Return [start, end) index pairs of every contiguous zero run in a [1, N] mask."""
    zeros = (mask[0] == 0).to(torch.int8)
    if zeros.numel() == 0:
        return []
    padded = torch.cat(
        [torch.zeros(1, dtype=torch.int8), zeros, torch.zeros(1, dtype=torch.int8)]
    )
    diff = padded[1:] - padded[:-1]
    starts = torch.nonzero(diff == 1).flatten().tolist()
    ends = torch.nonzero(diff == -1).flatten().tolist()
    return list(zip(starts, ends))


def test_import_does_not_load_a_model():
    """``import backend.server`` in a fresh interpreter must not pull torch, the
    stable_audio_3 model graph, or any checkpoint. The helpers under test are
    importable from that cheap module state."""
    code = """
import sys
import backend.server as s
assert "torch" not in sys.modules, "torch imported at module scope"
assert "stable_audio_3.pipeline" not in sys.modules, "pipeline imported"
assert s._GENERATION_MODELS_CACHE is None, "model catalog was resolved"
assert callable(s._parse_inpaint_regions)
assert callable(s._build_inpaint_mask)
print("OK")
"""
    proc = subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip().endswith("OK")


def test_parse_regions_pairs_and_dicts():
    assert _parse_inpaint_regions("") == []
    assert _parse_inpaint_regions("   ") == []
    assert _parse_inpaint_regions("null") == []
    assert _parse_inpaint_regions("[]") == []
    assert _parse_inpaint_regions("[[1, 2.5], [3, 4]]") == [(1.0, 2.5), (3.0, 4.0)]
    parsed = _parse_inpaint_regions('[{"start": 0.5, "end": 1.25}, [7, 8]]')
    assert parsed == [(0.5, 1.25), (7.0, 8.0)]
    assert all(isinstance(v, float) for pair in parsed for v in pair)
    assert _parse_inpaint_regions('[{"start_sec": 2, "end_sec": 3}]') == [(2.0, 3.0)]


@pytest.mark.parametrize(
    "raw",
    [
        "not json",
        "{}",
        '{"start": 1, "end": 2}',
        "[[1]]",
        "[[1, 2, 3]]",
        "[[2, 1]]",
        "[[1, 1]]",
        '[["a", "b"]]',
        "[[1, null]]",
        '[{"start": 1}]',
        "[[true, false]]",
        "[[1, Infinity]]",
        "[1, 2]",
        "3",
    ],
)
def test_parse_rejects_malformed(raw: str):
    with pytest.raises(HTTPException) as exc:
        _parse_inpaint_regions(raw)
    assert exc.value.status_code == 400
    assert "inpaint_regions" in exc.value.detail


def test_mask_zeros_exact_spans():
    mask = _build_inpaint_mask([(2.0, 3.0)], SR, SIZE)
    assert mask is not None
    assert mask.shape == (1, SIZE)
    assert mask.dtype == torch.float32
    assert mask.device.type == "cpu"
    assert _zero_runs(mask) == [(2 * SR, 3 * SR)]
    assert mask[0, 2 * SR - 1].item() == 1.0
    assert mask[0, 3 * SR].item() == 1.0
    assert mask.sum().item() == SIZE - SR


def test_short_region_widened_to_half_second():
    mask = _build_inpaint_mask([(4.0, 4.1)], SR, SIZE)
    assert mask is not None
    runs = _zero_runs(mask)
    assert len(runs) == 1
    start, end = runs[0]
    # Widened symmetrically around 4.05 s to [3.8, 4.3).
    assert start == int(3.8 * SR)
    assert end == int(4.3 * SR)
    assert (end - start) == pytest.approx(0.5 * SR, abs=2)


def test_custom_min_region_sec_is_honoured():
    mask = _build_inpaint_mask([(5.0, 5.01)], SR, SIZE, min_region_sec=1.0)
    assert mask is not None
    (start, end), *rest = _zero_runs(mask)
    assert not rest
    assert (end - start) == pytest.approx(1.0 * SR, abs=2)


def test_regions_clipped_to_sample_size():
    mask = _build_inpaint_mask([(9.5, 12.0), (-1.0, 0.2)], SR, SIZE)
    assert mask is not None
    assert mask.shape == (1, SIZE)
    runs = _zero_runs(mask)
    assert runs == [(0, int(0.2 * SR)), (int(9.5 * SR), SIZE)]
    # A region entirely past the end contributes nothing.
    assert _build_inpaint_mask([(20.0, 25.0)], SR, SIZE) is None


def test_overlapping_regions_merge():
    mask = _build_inpaint_mask(
        [(1.5, 2.5), (1.0, 2.0), (6.0, 6.5), (6.5, 7.0)], SR, SIZE
    )
    assert mask is not None
    runs = _zero_runs(mask)
    assert runs == [(int(1.0 * SR), int(2.5 * SR)), (int(6.0 * SR), int(7.0 * SR))]


def test_empty_returns_none():
    assert _build_inpaint_mask([], SR, SIZE) is None
    assert _build_inpaint_mask([(1.0, 2.0)], SR, 0) is None


def test_mask_survives_latent_downsample():
    regions = [(0.7, 0.75), (3.0, 3.05), (8.9, 9.95)]
    mask = _build_inpaint_mask(regions, SR, SIZE)
    assert mask is not None
    latent_size = SIZE // LATENT_DS
    latent = F.interpolate(mask.unsqueeze(1), size=latent_size, mode="nearest")
    assert latent.shape == (1, 1, latent_size)
    runs = _zero_runs(latent[0])
    assert len(runs) == len(regions)
    for start, end in runs:
        assert end - start >= 1
    # Each latent zero run lands where its (widened) region sits in time.
    frame_sec = SIZE / SR / latent_size
    for (start, end), (r0, r1) in zip(runs, regions):
        centre = (r0 + r1) / 2.0
        assert start * frame_sec - 0.5 <= centre <= end * frame_sec + 0.5
