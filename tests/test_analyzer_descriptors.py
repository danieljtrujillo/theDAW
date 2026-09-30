"""The analyzer's descriptor bundle.

The first test here is the one that matters: ``descriptors`` is imported lazily
inside both analyzer endpoints, so an import error in it never showed up at
startup — it showed up as a 500 on every call, for as long as the module named
a package that does not exist. A bare import is the whole regression guard.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

SR = 22050


def _tone(path: Path, subtype: str, seconds: float = 2.0) -> Path:
    t = np.linspace(0, seconds, int(SR * seconds), endpoint=False, dtype=np.float64)
    y = 0.5 * np.sin(2 * np.pi * 440.0 * t)
    sf.write(str(path), np.column_stack([y, y]), SR, subtype=subtype)
    return path


def test_descriptors_module_imports():
    from backend.modules.analyzer import descriptors

    assert callable(descriptors.extract_descriptors)


def test_analyzer_endpoints_can_reach_their_lazy_import():
    """Both /analyze and /recommend do `from . import descriptors` inside the
    handler, so both 500'd on the same missing package."""
    from backend.modules.analyzer import recommender, router

    assert router.router.routes
    assert callable(recommender.recommend)


@pytest.mark.parametrize(
    ("subtype", "bits", "is_float", "label"),
    [
        ("FLOAT", 32, True, "32-bit float"),
        ("PCM_24", 24, False, "24-bit"),
        ("PCM_16", 16, False, "16-bit"),
    ],
)
def test_extract_descriptors_reports_the_real_sample_format(
    tmp_path: Path, subtype: str, bits: int, is_float: bool, label: str
):
    from backend.modules.analyzer.descriptors import extract_descriptors

    src = _tone(tmp_path / f"{subtype.lower()}.wav", subtype)
    bundle = asyncio.run(extract_descriptors(src))

    assert bundle["bit_depth"] == bits
    assert bundle["bit_depth_is_float"] is is_float
    assert bundle["sample_format"] == label
    assert bundle["sample_rate"] == SR
    assert bundle["channels"] == 2
    assert {"low_level", "mid_level", "high_level"} <= set(bundle)


def test_extract_descriptors_reports_null_rather_than_guessing(tmp_path: Path):
    """A subtype with no PCM word length used to come back as a fabricated 16.

    Vorbis has no bit depth to report, and saying so is more useful to a caller
    than a number that looks measured and is not.
    """
    from backend.modules.analyzer.descriptors import extract_descriptors

    src = tmp_path / "lossy.ogg"
    t = np.linspace(0, 2.0, int(SR * 2.0), endpoint=False, dtype=np.float64)
    sf.write(str(src), 0.5 * np.sin(2 * np.pi * 440.0 * t), SR, format="OGG")

    bundle = asyncio.run(extract_descriptors(src))
    assert bundle["bit_depth"] is None
    assert bundle["bit_depth_is_float"] is False
    assert bundle["sample_format"] == "unknown"


def test_clipping_report_carries_the_measured_peak(tmp_path: Path):
    """A float file that peaks at 1.5 with no flat-topped run is not clipped.

    The 0.99 threshold cannot say that on its own, so the peak rides along and
    a reader can tell headroom used from damage done.
    """
    from backend.modules.analyzer.descriptors import extract_descriptors

    src = tmp_path / "over.wav"
    t = np.linspace(0, 2.0, int(SR * 2.0), endpoint=False, dtype=np.float64)
    sf.write(str(src), 1.5 * np.sin(2 * np.pi * 220.0 * t), SR, subtype="FLOAT")

    bundle = asyncio.run(extract_descriptors(src))
    clipping = bundle["high_level"]["artifact_flags"]["clipping"]
    assert clipping["sample_peak"] == pytest.approx(1.5, abs=1e-3)


def test_extract_descriptors_reads_a_file_sampled_under_c7(tmp_path: Path):
    """The F0 search ran pyin over C2..C7 at any rate, and pyin refuses an
    fmax above Nyquist, which C7 (2093 Hz) is below 4186 Hz: a 4 kHz file
    raised ParameterError out of extract_descriptors, a 500 from both analyzer
    endpoints. The range now stops at Nyquist."""
    from backend.lib.audio_io import save_audio
    from backend.modules.analyzer.descriptors import extract_descriptors

    sr = 4000
    t = np.arange(sr * 4, dtype=np.float64) / sr
    y = 0.5 * np.sin(2 * np.pi * 220.0 * t)
    src = tmp_path / "tone-4k.wav"
    save_audio(src, np.stack([y, y]), sr, subtype="PCM_16")

    bundle = asyncio.run(extract_descriptors(src))
    assert bundle["sample_rate"] == sr
    assert bundle["mid_level"]["f0_hz"] == pytest.approx(220.0, rel=0.02)
