"""Restoration & Cleanup family — 11 tools.

All 11 tools are implemented:
 - FFmpeg filter-mode: De-Hum, De-Ess, De-Click, Neural Denoise, De-Clip,
   De-Reverb, Restore All.
 - Process mode (numpy/scipy/librosa): Vocal Isolate, Stem Separation,
   Spectral Repair, Breath Removal.
"""

from __future__ import annotations

from pathlib import Path

from ...core.module_base import build_router
from ...lib.params import ParamSpec as P
from ...lib.params import ToolSpec

from . import dsp

FAMILY = "restoration"


# ── existing FFmpeg filter handlers (untouched) ──────────────────────────────


def _dehum(params: dict) -> list[str]:
    f0 = float(params["fundamental"])
    n = int(params["harmonics"])
    g = -40.0 * params["reduction"]
    notches = [
        f"equalizer=f={f0 * (i + 1):.0f}:width_type=q:w=30:g={g:.1f}" for i in range(n)
    ]
    return ["-af", ",".join(notches)]


def _deess(params: dict) -> list[str]:
    return [
        "-af",
        f"deesser=i={params['intensity']:.3f}:m={params['maxReduction']:.3f}:f={params['frequency']:.3f}:s=o",
    ]


def _declick(params: dict) -> list[str]:
    return [
        "-af",
        f"adeclick=w={params['window']}:o={params['overlap']}:t={params['threshold']}",
    ]


# ── new FFmpeg filter handlers ───────────────────────────────────────────────


def _neural_denoise(params: dict) -> list[str]:
    """FFmpeg afftdn broadband noise removal. nr = amount*40+5 → range 5..45 dB."""
    amount = float(params["amount"])
    nr = amount * 40.0 + 5.0
    return ["-af", f"afftdn=nr={nr:.0f}:nt=w"]


def _declip(params: dict) -> list[str]:
    """FFmpeg adeclip — real de-clipping filter."""
    threshold = float(params["clipThreshold"])
    # adeclip 'a' parameter range is 0-25 (amplitude threshold in %)
    # Map our 0.1-1.0 param range → 2.5-25
    t = threshold * 25.0
    return ["-af", f"adeclip=a={t:.1f}"]


def _dereverb(params: dict) -> list[str]:
    """Spectral-gate de-reverb: aggressive afftdn + highpass + downward expansion."""
    dry_wet = float(params["dryWet"])
    # Stronger effect → higher noise reduction + narrower band
    nr = dry_wet * 30.0 + 5.0  # 5-35 dB noise reduction
    hp_freq = 80.0 + dry_wet * 120.0  # 80-200 Hz highpass
    # Chain: highpass to remove room rumble, afftdn for spectral gating,
    # compand for downward expansion of quiet reverb tails
    filters = [
        f"highpass=f={hp_freq:.0f}",
        f"afftdn=nr={nr:.0f}:nt=w",
        f"compand=attacks=0.01:decays=0.1:points=-80/-80|-45/-45|-30/{-30 - dry_wet * 10:.0f}|0/0",
    ]
    return ["-af", ",".join(filters)]


def _restore_all(params: dict) -> list[str]:
    """DSP restore chain: afftdn + presence EQ + loudnorm."""
    strength = float(params["strength"])
    nr = strength * 25.0 + 5.0  # 5-30 dB noise reduction
    # Presence boost around 3-5 kHz scaled by strength
    eq_gain = strength * 3.0  # 0-3 dB
    filters = [
        f"afftdn=nr={nr:.0f}:nt=w",
        f"equalizer=f=4000:width_type=o:w=1.5:g={eq_gain:.1f}",
        "loudnorm=I=-14:TP=-1:LRA=11",
    ]
    return ["-af", ",".join(filters)]


# ── process-mode async wrappers (delegate to dsp.py) ────────────────────────


async def _vocal_isolate(input_path: Path, output_path: Path, params: dict) -> None:
    await dsp.vocal_isolate(input_path, output_path, params)


async def _stem_separation(input_path: Path, output_path: Path, params: dict) -> None:
    await dsp.stem_separation(input_path, output_path, params)


async def _spectral_repair(input_path: Path, output_path: Path, params: dict) -> None:
    await dsp.spectral_repair(input_path, output_path, params)


async def _breath_removal(input_path: Path, output_path: Path, params: dict) -> None:
    await dsp.breath_removal(input_path, output_path, params)


# ── tool specifications ─────────────────────────────────────────────────────

TOOLS: list[ToolSpec] = [
    ToolSpec(
        id="vocal_isolate",
        name="Vocal Isolate & Cleanup",
        family=FAMILY,
        viz="vortex",
        mode="process",
        gpu=False,
        flagship=True,
        license="MIT",
        engine="mid/side extraction (Mel-Roformer later)",
        handler=_vocal_isolate,
        description="Vocal extraction via mid/side stereo processing with wet/dry blend.",
        params=[
            P("processAmount", "float", 0, 1, 0.87, "", "ParamKnobMacro", "Process"),
            P(
                "output",
                "enum",
                default="vocals",
                options=["vocals", "instrumental"],
                control="RoundToggle",
                label="Output",
            ),
            P("denoiseAmount", "float", 0, 1, 0.5, "", "ParamKnob", "Denoise"),
            P("dereverbAmount", "float", 0, 1, 0.0, "", "ParamKnob", "Dereverb"),
        ],
    ),
    ToolSpec(
        id="stem_separation",
        name="Stem Separation",
        family=FAMILY,
        viz="spectro",
        mode="process",
        gpu=False,
        license="MIT",
        engine="librosa HPSS (Demucs/Roformer later)",
        handler=_stem_separation,
        description="Harmonic/percussive separation via librosa HPSS.",
        params=[P("stems", "int", 2, 6, 4, "", "Dropdown", "Stems")],
    ),
    ToolSpec(
        id="neural_denoise",
        name="Neural Denoise",
        family=FAMILY,
        viz="spectro",
        mode="filter",
        gpu=False,
        license="MIT",
        engine="ffmpeg afftdn (DeepFilterNet later)",
        handler=_neural_denoise,
        description="Broadband + spectral noise removal via FFmpeg afftdn.",
        params=[P("amount", "float", 0, 1, 0.5, "", "ParamKnob", "Amount")],
    ),
    ToolSpec(
        id="dereverb",
        name="De-Reverb",
        family=FAMILY,
        viz="vortex",
        mode="filter",
        gpu=False,
        license="MIT",
        engine="spectral gate (Sidon later)",
        handler=_dereverb,
        description="Remove room reverb via spectral gating + highpass + downward expansion.",
        params=[P("dryWet", "float", 0, 1, 1.0, "", "ParamKnob", "Amount")],
    ),
    ToolSpec(
        id="declip",
        name="De-Clip",
        family=FAMILY,
        viz="wave",
        mode="filter",
        gpu=False,
        license="MIT",
        engine="ffmpeg adeclip",
        handler=_declip,
        description="Restore clipped peaks using FFmpeg adeclip.",
        params=[
            P("clipThreshold", "float", 0.1, 1.0, 0.9, "", "ParamKnob", "Threshold")
        ],
    ),
    ToolSpec(
        id="restore_all",
        name="Restore All",
        family=FAMILY,
        viz="vortex",
        mode="filter",
        gpu=False,
        flagship=True,
        license="Apache-2.0",
        engine="DSP restore chain (SonicMaster later)",
        handler=_restore_all,
        description="One-click restoration: denoise + presence EQ + loudnorm.",
        params=[
            P("strength", "float", 0, 1, 0.7, "", "ParamKnob", "Strength"),
            P("prompt", "string", default="", control="TextInput", label="Prompt"),
        ],
    ),
    ToolSpec(
        id="spectral_repair",
        name="Spectral Repair",
        family=FAMILY,
        viz="paint",
        mode="process",
        license="BSD",
        engine="STFT median repair (neural inpaint later)",
        handler=_spectral_repair,
        description="STFT median filter across time to remove transient anomalies.",
        params=[P("attenuation", "float", 0, 1, 1.0, "", "ParamKnob", "Attenuation")],
    ),
    ToolSpec(
        id="breath_removal",
        name="Breath / Mouth-Click Removal",
        family=FAMILY,
        viz="wave",
        mode="process",
        license="BSD",
        engine="numpy breath detect",
        handler=_breath_removal,
        description="Auto-detect and attenuate breaths via RMS + spectral centroid analysis.",
        params=[
            P("breathReduction", "float", 0, 1, 0.8, "", "ParamKnob", "Breath"),
            P("clickReduction", "float", 0, 1, 0.7, "", "ParamKnob", "Clicks"),
        ],
    ),
    # ── existing FFmpeg tools (untouched) ──
    ToolSpec(
        id="dehum",
        name="De-Hum",
        family=FAMILY,
        viz="spectrum",
        license="LGPL",
        engine="ffmpeg:notch comb",
        handler=_dehum,
        description="Remove 50/60 Hz mains hum and harmonics with a notch comb.",
        params=[
            P(
                "fundamental",
                "enum",
                default="60",
                options=["50", "60"],
                control="RoundToggle",
                label="Mains",
            ),
            P("harmonics", "int", 1, 8, 5, "", "ParamKnob", "Harmonics"),
            P("reduction", "float", 0, 1, 1.0, "", "ParamKnob", "Depth"),
        ],
    ),
    ToolSpec(
        id="deess",
        name="De-Ess",
        family=FAMILY,
        viz="spectrum",
        license="LGPL",
        engine="ffmpeg:deesser",
        handler=_deess,
        description="Tame vocal sibilance with frequency-selective compression.",
        params=[
            P("intensity", "float", 0, 1, 0.4, "", "ParamKnob", "Intensity"),
            P("maxReduction", "float", 0, 1, 0.5, "", "ParamKnob", "Max Reduce"),
            P("frequency", "float", 0, 1, 0.55, "", "ParamKnob", "Frequency"),
        ],
    ),
    ToolSpec(
        id="declick",
        name="De-Click / De-Crackle",
        family=FAMILY,
        viz="wave",
        license="LGPL",
        engine="ffmpeg:adeclick",
        handler=_declick,
        description="Remove clicks, pops and crackle from records and field recordings.",
        params=[
            P("window", "float", 10, 100, 55, "ms", "ParamKnob", "Window"),
            P("overlap", "float", 50, 95, 75, "%", "ParamKnob", "Overlap"),
            P("threshold", "float", 1, 100, 2, "", "ParamKnob", "Threshold"),
        ],
    ),
]

router = build_router(FAMILY, TOOLS)
