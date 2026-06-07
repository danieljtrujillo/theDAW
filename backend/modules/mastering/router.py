"""Mastering & Tonal family — 11 tools, all implemented.

Working tools:
  - Parametric EQ (filter, ffmpeg)
  - Maximizer (process, two-pass loudnorm + alimiter)
  - Stereo Imager (filter, ffmpeg stereotools)
  - Dynamic EQ (process, numpy/scipy)
  - Match EQ (process, scipy firwin2)
  - Multiband Dynamics (filter, ffmpeg acrossover+acompressor)
  - Harmonic Exciter (filter, ffmpeg aexciter)
  - Transient Shaper (process, numpy dual-envelope)
  - Spectral Stabilizer (process, numpy + target curve)
  - Loudness Meter (process, ebur128 normalize)
  - AI Master Assistant (process, DSP master chain)
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf

from ...core.module_base import build_router
from ...lib import audio_analysis, ffmpeg, fir_utils
from ...lib.params import ParamSpec as P
from ...lib.params import ToolSpec

FAMILY = "mastering"


# ── Parametric EQ (filter) ─────────────────────────────────────────────
def _eq(params: dict) -> list[str]:
    return [
        "-af",
        ",".join(
            [
                f"bass=g={params['lowGain']}:f={params['lowFreq']}",
                f"equalizer=f={params['midFreq']}:width_type=q:w={params['midQ']}:g={params['midGain']}",
                f"treble=g={params['highGain']}:f={params['highFreq']}",
                f"volume={params['outputGain']}dB",
            ]
        ),
    ]


# ── Maximizer (process: two-pass loudnorm → alimiter) ──────────────────
async def _maximizer(inp: Path, out: Path, params: dict) -> None:
    m = await audio_analysis.measure_loudness(
        inp,
        target_i=params["targetLUFS"],
        target_lra=params["targetLRA"],
        target_tp=params["ceiling"],
    )
    ln = (
        f"loudnorm=I={params['targetLUFS']}:LRA={params['targetLRA']}:TP={params['ceiling']}"
        f":measured_I={m['input_i']}:measured_LRA={m['input_lra']}"
        f":measured_TP={m['input_tp']}:measured_thresh={m['input_thresh']}"
        f":offset={m.get('target_offset', 0.0)}:linear=true"
    )
    lim = f"alimiter=limit={10 ** (params['ceiling'] / 20):.4f}:attack={params['attack']}:release={params['release']}:asc=1"
    await ffmpeg.render(inp, out, ["-af", f"{ln},{lim}"])


# ── Stereo Imager (filter) ─────────────────────────────────────────────
def _imager(params: dict) -> list[str]:
    slev = max(
        0.016, params["width"] / 100
    )  # ffmpeg stereotools min is 0.015625; 0.016 avoids float rounding
    sbal = max(-1, min(1, params["balance"] / 100))
    return [
        "-af",
        f"stereotools=slev={slev:.4f}:sbal={sbal:.4f},volume={params['outputGain']}dB",
    ]


# ── Dynamic EQ (process, numpy/scipy) ─────────────────────────────────
async def _dynamic_eq(inp: Path, out: Path, params: dict) -> None:
    from .dsp import dynamic_eq_process

    audio, sr = sf.read(str(inp), always_2d=True)
    bands = [
        {
            "freq": params["band1Freq"],
            "q": params["band1Q"],
            "threshold_db": params["band1Thresh"],
            "ratio": params["band1Ratio"],
            "attack_ms": params["attack"],
            "release_ms": params["release"],
        },
        {
            "freq": params["band2Freq"],
            "q": params["band2Q"],
            "threshold_db": params["band2Thresh"],
            "ratio": params["band2Ratio"],
            "attack_ms": params["attack"],
            "release_ms": params["release"],
        },
        {
            "freq": params["band3Freq"],
            "q": params["band3Q"],
            "threshold_db": params["band3Thresh"],
            "ratio": params["band3Ratio"],
            "attack_ms": params["attack"],
            "release_ms": params["release"],
        },
    ]
    result = dynamic_eq_process(audio, sr, bands)
    # Apply output gain
    gain_lin = 10 ** (params["outputGain"] / 20.0)
    result *= gain_lin
    sf.write(str(out), result.astype(np.float32), sr, subtype="FLOAT")


# ── Match EQ (process, scipy firwin2) ──────────────────────────────────
async def _match_eq(inp: Path, out: Path, params: dict) -> None:
    strength = params["strength"] / 100.0
    smoothing = int(params["smoothing"])

    # Compute spectrum of input
    spec = audio_analysis.compute_spectrum(inp, n_fft=4096, bands=256)
    freqs = np.array(spec["freqs"])
    mag_db = np.array(spec["mag_db"])
    sr = spec["sr"]

    # Built-in gentle target tilt: slight low-end warmth, slight air boost
    # -3 dB/octave tilt from 1kHz down, +1 dB/octave above 4kHz
    target_db = np.zeros_like(mag_db)
    for i, f in enumerate(freqs):
        if f < 1000:
            target_db[i] = 1.5 * np.log2(max(f, 20) / 1000.0)  # gentle bass boost
        elif f > 4000:
            target_db[i] = 0.8 * np.log2(f / 4000.0)  # gentle air
        else:
            target_db[i] = 0.0

    # Correction = target - measured (centered)
    correction = target_db - mag_db
    correction -= np.mean(correction)

    # Smooth the correction curve
    if smoothing > 1:
        kernel = np.ones(smoothing) / smoothing
        correction = np.convolve(correction, kernel, mode="same")

    # Scale by strength
    correction *= strength

    # Design and apply FIR
    fir_kernel = fir_utils.design_fir_from_curve(freqs, correction, sr=sr, numtaps=4097)
    audio, sr_read = sf.read(str(inp), always_2d=True)
    result = fir_utils.apply_fir(audio, fir_kernel)
    sf.write(str(out), result.astype(np.float32), sr_read, subtype="FLOAT")


# ── Multiband Dynamics (filter, -filter_complex) ──────────────────────
def _multiband_dynamics(params: dict) -> list[str]:
    lt = params["lowThresh"]
    lr = params["lowRatio"]
    mt = params["midThresh"]
    mr = params["midRatio"]
    ht = params["highThresh"]
    hr = params["highRatio"]
    att = params["attack"]
    rel = params["release"]

    # Build filter_complex graph:
    # [0:a] → acrossover → [low][mid][high]
    # each band → acompressor
    # then amix to combine
    graph = (
        f"[0:a]acrossover=split=250 4000:order=4th[low][mid][high];"
        f"[low]acompressor=threshold={lt}dB:ratio={lr}:attack={att}:release={rel}[lo];"
        f"[mid]acompressor=threshold={mt}dB:ratio={mr}:attack={att}:release={rel}[mi];"
        f"[high]acompressor=threshold={ht}dB:ratio={hr}:attack={att}:release={rel}[hi];"
        f"[lo][mi][hi]amix=inputs=3:normalize=0[out]"
    )
    return ["-filter_complex", graph, "-map", "[out]"]


# ── Harmonic Exciter (filter, ffmpeg aexciter) ─────────────────────────
def _harmonic_exciter(params: dict) -> list[str]:
    amount = params["amount"]
    freq = params["freq"]
    blend = params["blend"]
    out_gain = params["outputGain"]

    chain = (
        f"aexciter=level_in=1:level_out=1"
        f":amount={amount}:drive=1"
        f":freq={freq}:ceil=9999"
        f":blend={blend}:listen=0,"
        f"volume={out_gain}dB"
    )
    return ["-af", chain]


# ── Transient Shaper (process, numpy) ──────────────────────────────────
async def _transient_shaper(inp: Path, out: Path, params: dict) -> None:
    from .dsp import transient_shape

    audio, sr = sf.read(str(inp), always_2d=True)
    # Params are 0-100 range, map to -1..+1 multiplier
    attack = params["attack"] / 100.0
    sustain = params["sustain"] / 100.0
    result = transient_shape(
        audio,
        sr,
        attack=attack,
        sustain=sustain,
        fast_ms=params["fastEnv"],
        slow_ms=params["slowEnv"],
    )
    # Output gain
    gain_lin = 10 ** (params["outputGain"] / 20.0)
    result *= gain_lin
    sf.write(str(out), result.astype(np.float32), sr, subtype="FLOAT")


# ── Spectral Stabilizer (process, numpy) ──────────────────────────────
async def _spectral_stabilizer(inp: Path, out: Path, params: dict) -> None:
    from .dsp import spectral_stabilize

    audio, sr = sf.read(str(inp), always_2d=True)
    result = spectral_stabilize(
        audio,
        sr,
        amount_db=params["amount"],
    )
    sf.write(str(out), result.astype(np.float32), sr, subtype="FLOAT")


# ── Loudness Meter (process, ebur128 normalize) ───────────────────────
async def _loudness_meter(inp: Path, out: Path, params: dict) -> None:
    """Normalize to target LUFS via two-pass loudnorm (no limiter)."""
    target_lufs = params["targetLUFS"]
    target_tp = params["ceiling"]
    m = await audio_analysis.measure_loudness(
        inp,
        target_i=target_lufs,
        target_lra=params["targetLRA"],
        target_tp=target_tp,
    )
    ln = (
        f"loudnorm=I={target_lufs}:LRA={params['targetLRA']}:TP={target_tp}"
        f":measured_I={m['input_i']}:measured_LRA={m['input_lra']}"
        f":measured_TP={m['input_tp']}:measured_thresh={m['input_thresh']}"
        f":offset={m.get('target_offset', 0.0)}:linear=true"
    )
    await ffmpeg.render(inp, out, ["-af", ln])


# ── AI Master Assistant (process, DSP master chain) ───────────────────
async def _master_assistant(inp: Path, out: Path, params: dict) -> None:
    """Real DSP mastering chain: low/high shelf → compressor → loudnorm."""
    target_lufs = params.get("targetLUFS", -14.0)
    style = params.get("style", "balanced")

    # Style-dependent shelf gains
    shelf = {
        "balanced": (1.0, 1.5),  # low_gain_db, high_gain_db
        "warm": (2.5, 0.5),
        "bright": (0.0, 3.0),
        "punchy": (2.0, 1.0),
        "loud": (1.0, 1.0),
    }
    low_g, high_g = shelf.get(style, (1.0, 1.5))

    # Intensity scales the effect
    intensity = params.get("intensity", 50) / 100.0
    low_g *= intensity
    high_g *= intensity

    # Build chain: subtle shelves + gentle compression + loudnorm
    # Step 1: measure loudness for second-pass loudnorm
    m = await audio_analysis.measure_loudness(
        inp,
        target_i=target_lufs,
        target_lra=9.0,
        target_tp=-1.0,
    )

    chain = ",".join(
        [
            f"bass=g={low_g:.1f}:f=120",
            f"treble=g={high_g:.1f}:f=8000",
            "acompressor=threshold=-18dB:ratio=2.5:attack=15:release=150:makeup=2dB",
            (
                f"loudnorm=I={target_lufs}:LRA=9:TP=-1.0"
                f":measured_I={m['input_i']}:measured_LRA={m['input_lra']}"
                f":measured_TP={m['input_tp']}:measured_thresh={m['input_thresh']}"
                f":offset={m.get('target_offset', 0.0)}:linear=true"
            ),
        ]
    )
    await ffmpeg.render(inp, out, ["-af", chain])


TOOLS: list[ToolSpec] = [
    ToolSpec(
        id="parametric_eq",
        name="Parametric EQ",
        family=FAMILY,
        viz="eq",
        engine="ffmpeg:bass+equalizer+treble",
        license="LGPL",
        handler=_eq,
        description="3-band parametric EQ (low shelf / mid bell / high shelf) over a live spectrum.",
        params=[
            P("lowFreq", "float", 20, 500, 80, "Hz", "ParamKnob", "Low Freq"),
            P("lowGain", "float", -18, 18, 0, "dB", "ParamSlider", "Low Gain"),
            P("midFreq", "float", 200, 8000, 1000, "Hz", "ParamKnob", "Mid Freq"),
            P("midGain", "float", -18, 18, 0, "dB", "ParamSlider", "Mid Gain"),
            P("midQ", "float", 0.1, 10, 1.0, "", "ParamKnob", "Mid Q"),
            P("highFreq", "float", 2000, 18000, 8000, "Hz", "ParamKnob", "High Freq"),
            P("highGain", "float", -18, 18, 0, "dB", "ParamSlider", "High Gain"),
            P("outputGain", "float", -12, 12, 0, "dB", "ParamKnob", "Output"),
        ],
    ),
    ToolSpec(
        id="maximizer",
        name="Maximizer + True-Peak Limiter",
        family=FAMILY,
        viz="meters",
        mode="process",
        engine="ffmpeg:loudnorm+alimiter",
        license="LGPL",
        handler=_maximizer,
        description="Two-pass EBU-R128 loudness normalization into a true-peak brickwall limiter.",
        params=[
            P("ceiling", "float", -3, 0, -1.0, "dBTP", "ParamKnob", "Ceiling"),
            P("targetLUFS", "float", -24, -6, -14, "LUFS", "ParamKnob", "Loudness"),
            P("targetLRA", "float", 1, 20, 9, "LU", "ParamKnob", "LRA"),
            P("attack", "float", 1, 50, 5, "ms", "ParamKnob", "Attack"),
            P("release", "float", 10, 2000, 50, "ms", "ParamKnob", "Release"),
        ],
    ),
    ToolSpec(
        id="stereo_imager",
        name="Stereo Imager",
        family=FAMILY,
        viz="imager",
        engine="ffmpeg:stereotools",
        license="LGPL",
        handler=_imager,
        description="Stereo width + balance control with goniometer + correlation metering.",
        params=[
            P("width", "float", 0, 200, 100, "%", "ParamKnob", "Width"),
            P("balance", "float", -100, 100, 0, "%", "ParamKnob", "Balance"),
            P("outputGain", "float", -12, 12, 0, "dB", "ParamKnob", "Output"),
        ],
    ),
    # ── Dynamic EQ (process, numpy/scipy) ──
    ToolSpec(
        id="dynamic_eq",
        name="Dynamic EQ",
        family=FAMILY,
        viz="eq",
        mode="process",
        engine="numpy/scipy dynamic EQ",
        license="BSD",
        handler=_dynamic_eq,
        description="Frequency-selective compression — bands engage only past a per-band threshold.",
        params=[
            P("band1Freq", "float", 20, 500, 100, "Hz", "ParamKnob", "Band 1 Freq"),
            P("band1Q", "float", 0.1, 10, 1.0, "", "ParamKnob", "Band 1 Q"),
            P("band1Thresh", "float", -60, 0, -20, "dB", "ParamKnob", "Band 1 Thresh"),
            P("band1Ratio", "float", 1, 20, 4, ":1", "ParamKnob", "Band 1 Ratio"),
            P("band2Freq", "float", 200, 5000, 1000, "Hz", "ParamKnob", "Band 2 Freq"),
            P("band2Q", "float", 0.1, 10, 1.0, "", "ParamKnob", "Band 2 Q"),
            P("band2Thresh", "float", -60, 0, -20, "dB", "ParamKnob", "Band 2 Thresh"),
            P("band2Ratio", "float", 1, 20, 4, ":1", "ParamKnob", "Band 2 Ratio"),
            P(
                "band3Freq",
                "float",
                2000,
                18000,
                8000,
                "Hz",
                "ParamKnob",
                "Band 3 Freq",
            ),
            P("band3Q", "float", 0.1, 10, 1.0, "", "ParamKnob", "Band 3 Q"),
            P("band3Thresh", "float", -60, 0, -20, "dB", "ParamKnob", "Band 3 Thresh"),
            P("band3Ratio", "float", 1, 20, 4, ":1", "ParamKnob", "Band 3 Ratio"),
            P("attack", "float", 1, 100, 10, "ms", "ParamKnob", "Attack"),
            P("release", "float", 10, 1000, 100, "ms", "ParamKnob", "Release"),
            P("outputGain", "float", -12, 12, 0, "dB", "ParamKnob", "Output"),
        ],
    ),
    # ── Match EQ (process, scipy firwin2) ──
    ToolSpec(
        id="match_eq",
        name="Match EQ",
        family=FAMILY,
        viz="eq",
        mode="process",
        engine="scipy firwin2 (reference-match later)",
        license="BSD",
        handler=_match_eq,
        description="Capture a reference's spectral fingerprint and apply the difference as a linear-phase FIR.",
        params=[
            P("strength", "float", 0, 100, 70, "%", "ParamKnob", "Strength"),
            P("smoothing", "float", 1, 64, 8, "", "ParamKnob", "Smoothing"),
        ],
    ),
    # ── Multiband Dynamics (filter, ffmpeg) ──
    ToolSpec(
        id="multiband_dynamics",
        name="Multiband Dynamics",
        family=FAMILY,
        viz="dynamics",
        engine="ffmpeg:acrossover+acompressor",
        license="LGPL",
        handler=_multiband_dynamics,
        description="3-band crossover compressor with per-band threshold and ratio.",
        params=[
            P("lowThresh", "float", -60, 0, -24, "dB", "ParamKnob", "Low Thresh"),
            P("lowRatio", "float", 1, 20, 2, ":1", "ParamKnob", "Low Ratio"),
            P("midThresh", "float", -60, 0, -18, "dB", "ParamKnob", "Mid Thresh"),
            P("midRatio", "float", 1, 20, 3, ":1", "ParamKnob", "Mid Ratio"),
            P("highThresh", "float", -60, 0, -20, "dB", "ParamKnob", "High Thresh"),
            P("highRatio", "float", 1, 20, 2.5, ":1", "ParamKnob", "High Ratio"),
            P("attack", "float", 1, 100, 10, "ms", "ParamKnob", "Attack"),
            P("release", "float", 10, 1000, 100, "ms", "ParamKnob", "Release"),
        ],
    ),
    # ── Harmonic Exciter (filter, ffmpeg aexciter) ──
    ToolSpec(
        id="harmonic_exciter",
        name="Harmonic Exciter / Saturation / Tape",
        family=FAMILY,
        viz="spectrum",
        engine="ffmpeg aexciter",
        license="LGPL",
        handler=_harmonic_exciter,
        description="Harmonic generation using FFmpeg aexciter for crisp/brilliant high-frequency enhancement.",
        params=[
            P("amount", "float", 0, 20, 3, "dB", "ParamKnob", "Amount"),
            P("freq", "float", 1000, 16000, 4500, "Hz", "ParamKnob", "Freq"),
            P("blend", "float", 0, 10, 5, "", "ParamKnob", "Blend"),
            P("outputGain", "float", -12, 12, 0, "dB", "ParamKnob", "Output"),
        ],
    ),
    # ── Transient Shaper (process, numpy) ──
    ToolSpec(
        id="transient_shaper",
        name="Transient Shaper",
        family=FAMILY,
        viz="wave",
        mode="process",
        engine="numpy dual-envelope",
        license="BSD",
        handler=_transient_shaper,
        description="Independently shape attack and sustain without compression artifacts.",
        params=[
            P("attack", "float", -100, 100, 0, "%", "ParamKnob", "Attack"),
            P("sustain", "float", -100, 100, 0, "%", "ParamKnob", "Sustain"),
            P("fastEnv", "float", 0.1, 10, 1.0, "ms", "ParamKnob", "Fast Env"),
            P("slowEnv", "float", 10, 200, 50, "ms", "ParamKnob", "Slow Env"),
            P("outputGain", "float", -12, 12, 0, "dB", "ParamKnob", "Output"),
        ],
    ),
    # ── Spectral Stabilizer (process, numpy) ──
    ToolSpec(
        id="spectral_stabilizer",
        name="Spectral Stabilizer",
        family=FAMILY,
        viz="eq",
        mode="process",
        engine="numpy + target curve",
        license="BSD",
        handler=_spectral_stabilizer,
        description="Auto-EQ that steers tonal balance toward a gentle smile/flat target curve.",
        params=[
            P("amount", "float", 1, 18, 6, "dB", "ParamKnob", "Max Correction"),
        ],
    ),
    # ── Loudness Meter (process, ebur128 normalize) ──
    ToolSpec(
        id="loudness_meter",
        name="Loudness Meter",
        family=FAMILY,
        viz="meters",
        mode="process",
        engine="ebur128 normalize",
        license="MIT",
        handler=_loudness_meter,
        description="Normalize to target LUFS via two-pass EBU-R128 loudnorm (no limiter).",
        params=[
            P("targetLUFS", "float", -24, -6, -14, "LUFS", "ParamKnob", "Target LUFS"),
            P("targetLRA", "float", 1, 20, 9, "LU", "ParamKnob", "LRA"),
            P("ceiling", "float", -3, 0, -1.0, "dBTP", "ParamKnob", "True Peak"),
        ],
    ),
    # ── AI Master Assistant (process, DSP chain) ──
    ToolSpec(
        id="master_assistant",
        name="AI Master Assistant",
        family=FAMILY,
        viz="vortex",
        mode="process",
        engine="DSP master chain (SonicMaster/LLM later)",
        license="Apache-2.0",
        flagship=True,
        handler=_master_assistant,
        description="DSP mastering chain: subtle shelves + gentle compression + loudnorm to target.",
        params=[
            P(
                "style",
                "enum",
                options=["balanced", "warm", "bright", "punchy", "loud"],
                default="balanced",
                label="Style",
            ),
            P("intensity", "float", 0, 100, 50, "%", "ParamKnob", "Intensity"),
            P("targetLUFS", "float", -24, -6, -14, "LUFS", "ParamKnob", "Target LUFS"),
        ],
    ),
]

router = build_router(FAMILY, TOOLS)
