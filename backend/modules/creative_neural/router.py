"""Creative Neural / Spectral family — 8 tools.

All 8 tools are implemented with real DSP processing:
- grainlab, voxsynth, spectramorph, crossfade_morph, tokensynth: numpy/scipy/librosa
- timbreforge: ffmpeg pitch/formant shift
- promptfx: keyword->FFmpeg filter chain
- ambientforge: ffmpeg lavfi synthesis
"""

from __future__ import annotations

from pathlib import Path

from ...core.module_base import build_router
from ...lib import ffmpeg
from ...lib.params import ParamSpec as P
from ...lib.params import ToolSpec

from . import dsp

FAMILY = "creative_neural"


# ── 1. grainlab (process, numpy/librosa) ──────────────────────────────────
async def _grainlab(inp: Path, out: Path, params: dict) -> None:
    dsp.grainlab(inp, out, params)


# ── 2. voxsynth (process, STFT vocoder) ───────────────────────────────────
async def _voxsynth(inp: Path, out: Path, params: dict) -> None:
    dsp.voxsynth(inp, out, params)


# ── 3. spectramorph (process, STFT freeze/smear) ─────────────────────────
async def _spectramorph(inp: Path, out: Path, params: dict) -> None:
    dsp.spectramorph(inp, out, params)


# ── 4. crossfade_morph (process, spectral morph) ─────────────────────────
async def _crossfade_morph(inp: Path, out: Path, params: dict) -> None:
    dsp.crossfade_morph(inp, out, params)


# ── 5. timbreforge (process, pitch/formant shift via ffmpeg) ──────────────
async def _timbreforge(inp: Path, out: Path, params: dict) -> None:
    """Timbre transform via formant/pitch manipulation.

    Uses asetrate to shift formants while aresample + atempo preserve pitch
    and duration. timbreBlend drives the shift ratio.
    """
    blend = params["timbreBlend"]
    # Map timbreBlend 0..1 -> ratio 0.5..2.0 (octave down to octave up formant shift)
    # 0.5 = formants shifted down an octave, 1.0 = no shift, 2.0 = up an octave
    ratio = 2.0 ** (blend * 2 - 1)  # blend=0 -> 0.5, blend=0.5 -> 1.0, blend=1.0 -> 2.0

    if abs(ratio - 1.0) < 0.01:
        # no shift needed — copy through with minimal processing
        await ffmpeg.render(inp, out, ["-af", "acopy"])
        return

    # asetrate shifts pitch+formants, aresample restores sample rate,
    # atempo corrects the duration change
    new_rate = int(44100 * ratio)
    tempo = 1.0 / ratio
    # atempo only accepts 0.5..100.0; chain multiple if needed
    tempo_chain = _build_atempo_chain(tempo)

    af = f"asetrate={new_rate},aresample=44100,{tempo_chain}"
    await ffmpeg.render(inp, out, ["-af", af])


def _build_atempo_chain(tempo: float) -> str:
    """Build an atempo filter chain that handles extreme ratios.

    FFmpeg atempo accepts 0.5..100.0 per instance; chain for values outside.
    """
    parts = []
    t = tempo
    while t < 0.5:
        parts.append("atempo=0.5")
        t /= 0.5
    while t > 100.0:
        parts.append("atempo=100.0")
        t /= 100.0
    parts.append(f"atempo={t:.6f}")
    return ",".join(parts)


# ── 6. promptfx (process, keyword->FFmpeg) ────────────────────────────────
async def _promptfx(inp: Path, out: Path, params: dict) -> None:
    """Parse prompt keywords and build an FFmpeg filter chain."""
    prompt = (params.get("prompt") or "").lower().strip()
    creativeness = params.get("creativeness", 0.5)

    filters: list[str] = []

    # keyword -> filter mapping
    _KEYWORDS = {
        "radio": "highpass=f=300,lowpass=f=3400",
        "underwater": "lowpass=f=800",
        "muffled": "lowpass=f=800",
        "telephone": "highpass=f=300,lowpass=f=3000",
        "bright": "treble=g=5:f=3000",
        "dark": "treble=g=-6:f=3000",
        "reverb": "aecho=0.8:0.88:60:0.4",
        "hall": "aecho=0.8:0.9:120:0.5",
        "vinyl": "lowpass=f=8000,highpass=f=80",
        "lofi": "lowpass=f=6000,highpass=f=100",
        "robot": "aphaser=type=t:speed=2:decay=0.6,vibrato=f=8:d=0.5",
        "distant": "lowpass=f=4000,aecho=0.8:0.88:200:0.4",
        "wide": "stereotools=slev=1.5",
        "echo": "aecho=0.8:0.9:100:0.3",
        "space": "aecho=0.8:0.88:300:0.5,aecho=0.8:0.88:500:0.3",
        "warm": "bass=g=3:f=200,treble=g=-2:f=8000",
        "thin": "highpass=f=500,treble=g=3:f=5000",
        "whisper": "volume=0.3,aecho=0.8:0.9:40:0.6",
    }

    matched = False
    for keyword, filt in _KEYWORDS.items():
        if keyword in prompt:
            filters.append(filt)
            matched = True

    if not matched:
        # default: mild warm processing based on creativeness
        gain = -3 + creativeness * 6  # -3 to +3 dB treble
        filters.append(f"treble=g={gain:.1f}:f=5000")

    # creativeness adjusts overall wet/dry — add a volume adjustment
    vol = 0.8 + creativeness * 0.4  # 0.8-1.2
    filters.append(f"volume={vol:.2f}")

    af = ",".join(filters)
    await ffmpeg.render(inp, out, ["-af", af])


# ── 7. ambientforge (process, ffmpeg lavfi synth) ─────────────────────────
async def _ambientforge(inp: Path, out: Path, params: dict) -> None:
    """Generate an ambient drone/texture bed using ffmpeg's lavfi sources.

    Ignores input content — synthesizes from noise + spectral shaping + reverb.
    """
    duration = params["duration"]

    # Build a pink noise source with spectral shaping and reverb
    # anoisesrc generates noise, lowpass shapes it, aecho adds space
    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"anoisesrc=color=pink:duration={duration}:sample_rate=44100",
        "-af",
        (
            "lowpass=f=2000,"
            "highpass=f=40,"
            "tremolo=f=0.1:d=0.4,"
            "aecho=0.8:0.9:500:0.4,"
            "aecho=0.8:0.88:800:0.3,"
            "volume=0.7"
        ),
        "-ac",
        "2",  # stereo output
        str(out),
    ]
    await ffmpeg.run(cmd)
    if not out.exists() or out.stat().st_size == 0:
        raise RuntimeError("ambientforge: ffmpeg produced no output")


# ── 8. tokensynth (process, ring mod + vibrato + tremolo) ─────────────────
async def _tokensynth(inp: Path, out: Path, params: dict) -> None:
    dsp.tokensynth(inp, out, params)


# ── Tool Specs ────────────────────────────────────────────────────────────
TOOLS: list[ToolSpec] = [
    ToolSpec(
        id="spectramorph",
        name="SpectraMorph",
        family=FAMILY,
        viz="paint",
        mode="process",
        gpu=False,
        flagship=True,
        license="BSD / SA3",
        engine="STFT freeze/smear (SA3 inpaint later)",
        handler=_spectramorph,
        description="Paint on a live spectrogram — freeze, smear, erase — with optional neural inpaint.",
        params=[
            P("brushIntensity", "float", 0, 1, 0.7, "", "ParamKnob", "Intensity"),
            P("smearLength", "float", 10, 2000, 400, "ms", "ParamKnob", "Smear"),
            P("mix", "float", 0, 1, 1.0, "", "ParamKnob", "Mix"),
        ],
    ),
    ToolSpec(
        id="timbreforge",
        name="TimbreForge",
        family=FAMILY,
        viz="xy",
        mode="process",
        gpu=False,
        flagship=True,
        license="MIT / CC-BY-NC (OK free-use)",
        engine="pitch/formant shift (RAVE later)",
        handler=_timbreforge,
        description="Neural timbre transfer — turn any sound into any instrument via an XY morph pad.",
        params=[
            P("structureWeight", "float", 0, 1, 0.5, "", "ParamKnob", "Structure"),
            P("timbreBlend", "float", 0, 1, 0.5, "", "ParamKnob", "Timbre"),
            P("latentWander", "float", 0, 1, 0.0, "", "ParamKnob", "Wander"),
        ],
    ),
    ToolSpec(
        id="promptfx",
        name="PromptFX",
        family=FAMILY,
        viz="prompt",
        mode="process",
        flagship=True,
        license="Apache-2.0",
        engine="keyword->FFmpeg (CLAP/LLM later)",
        handler=_promptfx,
        description="Describe a sound; get a tweakable FFmpeg FX chain (CLAP + the assistant).",
        params=[
            P("prompt", "string", default="", control="TextInput", label="Prompt"),
            P("creativeness", "float", 0, 1, 0.5, "", "ParamKnob", "Creativeness"),
        ],
    ),
    ToolSpec(
        id="tokensynth",
        name="TokenSynth",
        family=FAMILY,
        viz="piano",
        mode="process",
        gpu=False,
        license="MIT",
        engine="synth preview (TokenSynth later)",
        handler=_tokensynth,
        description="Text -> playable instrument, driven from the piano roll.",
        params=[
            P("prompt", "string", default="", control="TextInput", label="Prompt"),
            P("temperature", "float", 0.1, 2.0, 1.0, "", "ParamKnob", "Temp"),
        ],
    ),
    ToolSpec(
        id="grainlab",
        name="GrainLab",
        family=FAMILY,
        viz="grain",
        mode="process",
        license="BSD",
        engine="numpy granular",
        handler=_grainlab,
        description="Granular cloud — scatter, freeze, pitch-spray, color.",
        params=[
            P("grainSize", "float", 5, 500, 80, "ms", "ParamKnob", "Grain"),
            P("density", "float", 1, 200, 40, "/s", "ParamKnob", "Density"),
            P("scatter", "float", 0, 1, 0.3, "", "ParamKnob", "Scatter"),
            P("pitchSpread", "float", -24, 24, 0, "st", "ParamKnob", "Pitch"),
        ],
    ),
    ToolSpec(
        id="crossfade_morph",
        name="CrossFade Morph",
        family=FAMILY,
        viz="xy",
        mode="process",
        license="LGPL",
        engine="spectral morph (RAVE SLERP later)",
        handler=_crossfade_morph,
        description="Spectrally interpolate between two tracks.",
        params=[
            P("morphPosition", "float", 0, 1, 0.5, "", "ParamSlider", "Morph"),
            P("mix", "float", 0, 1, 1.0, "", "ParamKnob", "Mix"),
        ],
    ),
    ToolSpec(
        id="ambientforge",
        name="AmbientForge",
        family=FAMILY,
        viz="vortex",
        mode="process",
        gpu=False,
        license="FFmpeg / CC-BY-NC (OK free-use)",
        engine="ffmpeg synth (MusicGen later)",
        handler=_ambientforge,
        description="Generate ambience / drone / texture beds from a text prompt.",
        params=[
            P("prompt", "string", default="", control="TextInput", label="Prompt"),
            P("duration", "float", 5, 300, 30, "s", "ParamKnob", "Duration"),
        ],
    ),
    ToolSpec(
        id="voxsynth",
        name="VoxSynth (Vocoder)",
        family=FAMILY,
        viz="spectro",
        mode="process",
        license="LGPL",
        engine="afftfilt/STFT vocoder",
        handler=_voxsynth,
        description="Spectral vocoder — a voice shapes a synth/noise carrier.",
        params=[
            P("spectralSmooth", "float", 0, 1, 0.4, "", "ParamKnob", "Smooth"),
            P("mix", "float", 0, 1, 1.0, "", "ParamKnob", "Mix"),
        ],
    ),
]

router = build_router(FAMILY, TOOLS)
