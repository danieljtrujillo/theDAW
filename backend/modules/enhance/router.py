"""Enhance / Super-Resolution family — 5 tools.

All 5 are implemented via FFmpeg DSP:
  - Classical Upsample: libsoxr VHQ sample-rate conversion.
  - Super-Res:          soxr upsample + aexciter + treble shelf for bandwidth extension.
  - Un-Crush:           afftdn denoiser + equalizer dip + aexciter for codec artifact removal.
  - Studio Enhance:     afftdn + presence EQ boost + EBU R128 loudnorm.
  - Neural Codec:       Opus encode/decode re-synthesis for RVQ-like degradation.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from ...core.module_base import build_router
from ...lib import ffmpeg
from ...lib.params import ParamSpec as P
from ...lib.params import ToolSpec

FAMILY = "enhance"


# ── Classical Upsample (filter) ──────────────────────────────────────────────


def _upsample(params: dict) -> list[str]:
    sr = int(float(params["targetSR"]))
    prec = int(params["precision"])
    return ["-af", f"aresample=resampler=soxr:precision={prec}", "-ar", str(sr)]


# ── Super-Res / Bandwidth Extension (filter) ─────────────────────────────────


def _super_res(params: dict) -> list[str]:
    sr = int(float(params["targetSR"]))
    guidance = float(params["guidance"])
    # Map guidance (1-7) to aexciter amount (2-14) and treble gain (1-6 dB)
    exciter_amount = guidance * 2
    treble_gain = max(1.0, guidance * 0.86)  # ~1-6 dB
    chain = (
        f"aresample=resampler=soxr:precision=28,"
        f"aexciter=amount={exciter_amount:.1f}:freq=7500,"
        f"treble=g={treble_gain:.1f}:f=12000"
    )
    return ["-af", chain, "-ar", str(sr)]


# ── Un-Crush (filter) ────────────────────────────────────────────────────────


def _uncrush(params: dict) -> list[str]:
    strength = float(params["strength"])
    # Map strength (0-1) to DSP parameters
    denoise_amount = strength * 30  # afftdn noise reduction 0-30 dB
    eq_dip = -(strength * 4)  # 0 to -4 dB dip at 3kHz harshness
    exciter_amount = strength * 4  # gentle harmonic restoration
    chain = (
        f"afftdn=nr={denoise_amount:.0f}:nt=w,"
        f"equalizer=f=3000:t=q:w=1.5:g={eq_dip:.1f},"
        f"aexciter=amount={exciter_amount:.1f}:freq=8000"
    )
    return ["-af", chain]


# ── Studio Enhance (filter) ──────────────────────────────────────────────────


def _studio_enhance(params: dict) -> list[str]:
    enhance = float(params["enhance"])
    denoise = float(params["denoise"])
    # Build filter chain: denoise → presence EQ boost → loudnorm
    denoise_nr = denoise * 25  # 0-25 dB noise reduction
    presence_gain = enhance * 4  # 0-4 dB presence boost at 3.5kHz
    parts = []
    if denoise > 0:
        parts.append(f"afftdn=nr={denoise_nr:.0f}:nt=w")
    if enhance > 0:
        parts.append(f"equalizer=f=3500:t=q:w=2:g={presence_gain:.1f}")
    parts.append("loudnorm=I=-16:TP=-1:LRA=11")
    chain = ",".join(parts)
    return ["-af", chain]


# ── Neural Codec Re-Synth (process) ──────────────────────────────────────────


async def _neural_codec(input_path: Path, output_path: Path, params: dict) -> None:
    """Encode through Opus at a mapped bitrate, then decode back to wav.

    nQuantizers (1-32) maps to bitrate: fewer quantizers = lower bitrate = more
    degradation, mimicking the quality ladder of neural RVQ codecs like DAC/EnCodec.
    Formula: bitrate = 6 + nQuantizers * 4  kbps  (range: 10k - 134k).
    """
    n_q = int(params["nQuantizers"])
    bitrate_kbps = 6 + n_q * 4

    tmp_opus = Path(tempfile.mktemp(suffix=".opus", prefix="codec_"))
    try:
        # Step 1: encode input to Opus at the target bitrate
        await ffmpeg.render(
            input_path,
            tmp_opus,
            [],
            extra_out_args=["-c:a", "libopus", "-b:a", f"{bitrate_kbps}k"],
        )
        # Step 2: decode Opus back to wav
        await ffmpeg.render(tmp_opus, output_path, [])
    finally:
        if tmp_opus.exists():
            tmp_opus.unlink()


TOOLS: list[ToolSpec] = [
    ToolSpec(
        id="super_res",
        name="Super-Res / Bandwidth Extension",
        family=FAMILY,
        viz="spectro",
        mode="filter",
        gpu=False,
        flagship=True,
        license="MIT (weights CC-BY-NC, OK free-use)",
        engine="soxr + exciter (AudioSR later)",
        handler=_super_res,
        description="Reconstruct missing highs; upscale low-rate audio to 48 kHz studio quality.",
        params=[
            P(
                "targetSR",
                "enum",
                default="48000",
                options=["44100", "48000"],
                control="RoundToggle",
                label="Target SR",
            ),
            P("guidance", "float", 1, 7, 3.5, "", "ParamKnob", "Guidance"),
            P("mix", "float", 0, 1, 1.0, "", "ParamKnob", "Mix"),
        ],
    ),
    ToolSpec(
        id="uncrush",
        name="Un-Crush",
        family=FAMILY,
        viz="spectro",
        mode="filter",
        gpu=False,
        flagship=True,
        license="CC-BY-SA",
        engine="ffmpeg DSP (Apollo later)",
        handler=_uncrush,
        description="Remove MP3/AAC codec artifacts and reconstruct lost harmonics.",
        params=[
            P("strength", "float", 0, 1, 0.8, "", "ParamKnob", "Strength"),
            P("mix", "float", 0, 1, 1.0, "", "ParamKnob", "Mix"),
        ],
    ),
    ToolSpec(
        id="studio_enhance",
        name="Studio Enhance",
        family=FAMILY,
        viz="vortex",
        mode="filter",
        gpu=False,
        license="MIT",
        engine="DSP enhance (Resemble later)",
        handler=_studio_enhance,
        description="One-button 'studio sound' for voice and music.",
        params=[
            P("enhance", "float", 0, 1, 0.8, "", "ParamKnobMacro", "Enhance"),
            P("denoise", "float", 0, 1, 0.7, "", "ParamKnob", "Denoise"),
        ],
    ),
    ToolSpec(
        id="neural_codec",
        name="Neural Codec Re-Synth",
        family=FAMILY,
        viz="spectro",
        mode="process",
        gpu=False,
        license="MIT",
        engine="opus re-synthesis (DAC/EnCodec later)",
        handler=_neural_codec,
        description="Encode through neural codecs for re-synthesis or creative RVQ degradation.",
        params=[
            P("nQuantizers", "int", 1, 32, 9, "", "ParamSlider", "RVQ Levels"),
            P("mix", "float", 0, 1, 1.0, "", "ParamKnob", "Mix"),
        ],
    ),
    # ── implemented (FFmpeg) ──
    ToolSpec(
        id="classical_upsample",
        name="Classical Upsample",
        family=FAMILY,
        viz="spectro",
        license="LGPL",
        engine="ffmpeg:soxr",
        handler=_upsample,
        description="Transparent libsoxr VHQ sample-rate conversion (the non-neural fallback).",
        params=[
            P(
                "targetSR",
                "enum",
                default="48000",
                options=["44100", "48000", "88200", "96000"],
                control="Dropdown",
                label="Target SR",
            ),
            P("precision", "int", 20, 28, 28, "", "ParamKnob", "Precision"),
        ],
    ),
]

router = build_router(FAMILY, TOOLS)
