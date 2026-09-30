"""Creative Neural / Spectral family — 8 tools.

All 8 tools are implemented with real DSP processing:
- grainlab, voxsynth, spectramorph, crossfade_morph, tokensynth: numpy/scipy/librosa
  (tokensynth's prompt picks its synth voice by keyword)
- timbreforge: ffmpeg pitch/formant shift, then numpy Structure and Wander
- promptfx: keyword->FFmpeg filter chain
- ambientforge: ffmpeg lavfi synthesis, shaped by its prompt's keywords
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

from ...core.module_base import build_router
from ...lib import ffmpeg, ffmpeg_tools
from ...lib.params import ParamSpec as P
from ...lib.params import ToolSpec

from . import dsp

FAMILY = "creative_neural"


# The numpy/librosa handlers below are plain sync functions on purpose:
# build_router offloads non-coroutine handlers to a worker thread via
# asyncio.to_thread, keeping the event loop responsive during CPU-bound DSP.


# ── 1. grainlab (process, numpy/librosa) ──────────────────────────────────
def _grainlab(inp: Path, out: Path, params: dict) -> None:
    dsp.grainlab(inp, out, params)


# ── 2. voxsynth (process, STFT vocoder) ───────────────────────────────────
def _voxsynth(inp: Path, out: Path, params: dict) -> None:
    dsp.voxsynth(inp, out, params)


# ── 3. spectramorph (process, STFT freeze/smear) ─────────────────────────
def _spectramorph(inp: Path, out: Path, params: dict) -> None:
    dsp.spectramorph(inp, out, params)


# ── 4. crossfade_morph (process, spectral morph) ─────────────────────────
def _crossfade_morph(inp: Path, out: Path, params: dict) -> None:
    dsp.crossfade_morph(inp, out, params)


# ── 5. timbreforge (process, pitch/formant shift via ffmpeg) ──────────────
async def _timbreforge(inp: Path, out: Path, params: dict) -> None:
    """Timbre transform via combined pitch+formant manipulation, then the
    Structure and Wander stages (``dsp.timbreforge_shape``).

    ``asetrate`` reinterprets the sample rate, which shifts BOTH pitch and
    formants together (that combined shift is the effect — it is not
    undone). ``atempo`` only restores the original DURATION (the tempo
    change asetrate introduced); it does not, and cannot, restore pitch.
    ``aresample`` afterwards just puts the stream back at a standard rate
    for downstream stages. timbreBlend drives the shift ratio.

    structureWeight pulls the shifted result's loudness contour (attacks,
    dynamics, rhythm) back toward the source's; latentWander lets the shift
    drift slowly around its setting. A missing key means off. Every stage
    runs on float intermediates and the result is written at the upload's
    bit depth; an ffmpeg render straight to ``out`` wrote 16-bit whatever
    came in.
    """
    blend = params["timbreBlend"]
    structure = float(params.get("structureWeight", 0.0))
    wander = float(params.get("latentWander", 0.0))
    # Map timbreBlend 0..1 -> ratio 0.5..2.0 (octave down to octave up formant shift)
    # 0.5 = formants shifted down an octave, 1.0 = no shift, 2.0 = up an octave
    ratio = 2.0 ** (blend * 2 - 1)  # blend=0 -> 0.5, blend=0.5 -> 1.0, blend=1.0 -> 2.0

    decoded = out.with_name(f"{out.stem}.source.wav")
    shifted = out.with_name(f"{out.stem}.shifted.wav")
    shaped = out.with_name(f"{out.stem}.shaped.wav")
    float_wav = ["-c:a", "pcm_f32le"]
    try:
        # A float decode of the upload: the shaping stage reads its samples
        # whatever container it came in.
        await ffmpeg.render(inp, decoded, [], extra_out_args=float_wav)
        if abs(ratio - 1.0) < 0.01:
            # no shift needed — the shaping stages run on the source itself
            shifted_src = decoded
        else:
            # asetrate/aresample must reinterpret+restore at the SOURCE's own
            # rate, not a hardcoded 44.1 kHz — a 48 kHz source resampled
            # through a 44.1 kHz asetrate/aresample pair audibly shifts
            # pitch/duration beyond what timbreBlend asked for. Best-effort
            # probe via ffprobe; falls back to the CD-standard 44.1 kHz only
            # when the source rate can't be read.
            source_rate = await asyncio.to_thread(_probe_sample_rate, inp)
            new_rate = int(source_rate * ratio)
            tempo = 1.0 / ratio
            # atempo only accepts 0.5..100.0; chain multiple if needed
            tempo_chain = _build_atempo_chain(tempo)

            af = f"asetrate={new_rate},aresample={source_rate},{tempo_chain}"
            await ffmpeg.render(decoded, shifted, ["-af", af], extra_out_args=float_wav)
            shifted_src = shifted
        await asyncio.to_thread(
            dsp.timbreforge_shape, decoded, shifted_src, shaped, inp, structure, wander
        )
        if out.suffix.lower() == ".wav":
            shaped.replace(out)
        else:
            # Any other container: ffmpeg picks the encoder from the extension.
            await ffmpeg.render(shaped, out, [])
    finally:
        for temp in (decoded, shifted, shaped):
            temp.unlink(missing_ok=True)


def _probe_sample_rate(path: Path, default: int = 44100) -> int:
    """Best-effort source sample rate via ffprobe.

    Falls back to 44.1 kHz (CD-standard) when ffprobe is missing or the
    probe fails — ``probe_file`` never raises, it returns ``{}`` instead.
    """
    from backend.modules.analysis.ffprobe import probe_file

    info = probe_file(path)
    rate = info.get("_summary", {}).get("sample_rate")
    return int(rate) if rate else default


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
_AMBIENT_ECHO_ROOM = ["aecho=0.8:0.9:500:0.4", "aecho=0.8:0.88:800:0.3"]
_AMBIENT_ECHO_VAST = ["aecho=0.8:0.9:1200:0.5", "aecho=0.8:0.88:1900:0.4"]

AMBIENT_PROMPT_HELP = (
    "Words that shape the bed: white/hiss, brown/ocean/deep, rain, wind "
    "(noise colour); dark/murky or bright/airy; waves, pulsing or calm "
    "(motion); space/cathedral/cave or dry/close; drone/pad/chord adds a "
    "tone, and a note name such as A2 or C#3 sets its pitch."
)


def _ambient_plan(prompt: str) -> dict:
    """Read AmbientForge's prompt into the bed it describes.

    The synth has no text model, so the prompt steers the lavfi graph by
    word: the noise colour, the low-pass (brightness), the tremolo (motion),
    the echo taps (space) and an optional tonal drone whose root is the first
    note name in the prompt (A2 = 110 Hz when none is given). With none of
    these words the plan is the pink-noise bed the tool has always made.
    """
    words = set(re.findall(r"[a-z0-9#]+", prompt.lower()))
    plan: dict = {
        "color": "pink",
        "lowpass": 2000.0,
        "highpass": 40.0,
        "tremolo": (0.1, 0.4),
        "echoes": _AMBIENT_ECHO_ROOM,
        "drone": None,
    }
    if words & {"white", "hiss", "hissy", "static"}:
        plan["color"] = "white"
    elif words & {
        "brown",
        "ocean",
        "waves",
        "sea",
        "surf",
        "tide",
        "rumble",
        "thunder",
        "deep",
    }:
        plan["color"] = "brown"
    if words & {"rain", "rainy", "shower", "drizzle"}:
        plan["highpass"], plan["lowpass"] = 800.0, 9000.0
    if words & {"wind", "windy", "breeze", "gust"}:
        plan["lowpass"], plan["tremolo"] = 1200.0, (0.15, 0.7)
    if words & {"dark", "murky", "underwater", "muffled", "low"}:
        plan["lowpass"] = 600.0
    elif words & {"bright", "airy", "shimmer", "glassy", "crisp"}:
        plan["lowpass"] = 9000.0
    if words & {"ocean", "waves", "sea", "surf", "tide"}:
        plan["tremolo"] = (0.1, 0.85)
    elif words & {"pulse", "pulsing", "breathing", "throb", "throbbing"}:
        plan["tremolo"] = (0.5, 0.6)
    elif words & {"still", "calm", "steady", "frozen"}:
        plan["tremolo"] = (0.1, 0.1)
    if words & {"space", "cathedral", "cave", "cavern", "vast", "hall", "huge"}:
        plan["echoes"] = _AMBIENT_ECHO_VAST
    elif words & {"dry", "close", "small", "intimate"}:
        plan["echoes"] = []
    root = dsp.note_frequency(prompt)
    if root is not None or words & {"drone", "pad", "hum", "tone", "organ", "chord"}:
        root = root or 110.0
        # a chord is root, major third and fifth; otherwise root, fifth, octave
        steps = (1.0, 1.26, 1.5) if "chord" in words else (1.0, 1.5, 2.0)
        plan["drone"] = [root * s for s in steps]
    return plan


async def _ambientforge(inp: Path, out: Path, params: dict) -> None:
    """Generate an ambient drone/texture bed using ffmpeg's lavfi sources,
    shaped by the prompt (see ``_ambient_plan``).

    Ignores input content — synthesizes from noise (+ an optional sine
    drone) + spectral shaping + reverb.
    """
    # The process dispatch always passes the uploaded file; this tool synthesizes
    # its bed from lavfi sources and deliberately never reads it.
    _ = inp
    duration = params["duration"]
    plan = _ambient_plan(str(params.get("prompt", "")))

    # anoisesrc generates noise, lowpass/highpass shape it, tremolo moves it,
    # aecho adds space
    rate, depth = plan["tremolo"]
    chain = ",".join(
        [
            f"lowpass=f={plan['lowpass']:g}",
            f"highpass=f={plan['highpass']:g}",
            f"tremolo=f={rate:g}:d={depth:g}",
            *plan["echoes"],
            "volume=0.7",
        ]
    )
    noise = f"anoisesrc=color={plan['color']}:duration={duration}:sample_rate=44100"
    if plan["drone"] is None:
        graph_args = ["-f", "lavfi", "-i", noise, "-af", chain]
    else:
        # sine sources play at 1/8 full scale; the weights set each partial
        # over a quieter noise floor so the drone leads.
        tones = [
            f"sine=frequency={f:.3f}:duration={duration}:sample_rate=44100[s{i}]"
            for i, f in enumerate(plan["drone"])
        ]
        labels = "".join(f"[s{i}]" for i in range(len(tones)))
        weights = " ".join(["0.35", "2", "1.2", "0.8"][: len(tones) + 1])
        graph = ";".join(
            [
                f"{noise}[n]",
                *tones,
                f"[n]{labels}amix=inputs={len(tones) + 1}:weights='{weights}'"
                f":normalize=0,{chain}[out]",
            ]
        )
        graph_args = ["-filter_complex", graph, "-map", "[out]"]
    cmd = [
        await ffmpeg_tools.ffmpeg_exe_async(),
        "-y",
        *graph_args,
        "-ac",
        "2",  # stereo output
        str(out),
    ]
    await ffmpeg.run(cmd)
    if not out.exists() or out.stat().st_size == 0:
        raise RuntimeError("ambientforge: ffmpeg produced no output")


# ── 8. tokensynth (process, ring mod + vibrato + tremolo) ─────────────────
TOKENSYNTH_PROMPT_HELP = (
    "Words that pick the voice: sine, square, saw or triangle; a note name "
    "such as C3 for the pitch, or sub/bass, low/deep, high/lead to move it "
    "by octaves; steady, wobble or tremolo for the LFOs; dark/warm or "
    "bright/crisp for the tone."
)


def _tokensynth(inp: Path, out: Path, params: dict) -> None:
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
        engine="pitch/formant shift + envelope/drift shaping (RAVE later)",
        handler=_timbreforge,
        description=(
            "Formant/pitch color shift via asetrate + atempo resampling, driven "
            "by the Timbre knob. Structure pulls the result's dynamics and "
            "attacks back to the source's; Wander lets the shift drift slowly."
        ),
        params=[
            P(
                "structureWeight",
                "float",
                0,
                1,
                0.5,
                "",
                "ParamKnob",
                "Structure",
                help="How closely the result follows the source's loudness contour: 0 leaves the shift as rendered, 1 matches the source's dynamics and attacks.",
            ),
            P("timbreBlend", "float", 0, 1, 0.5, "", "ParamKnob", "Timbre"),
            P(
                "latentWander",
                "float",
                0,
                1,
                0.0,
                "",
                "ParamKnob",
                "Wander",
                help="Slow random drift of the shift around its setting; 1 drifts up to a semitone either way.",
            ),
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
        description=(
            "Ring-modulate the input with vibrato + tremolo LFOs into a "
            "tonal synth texture, shaped by Temp. The prompt picks the voice: "
            "wave, pitch (a note name such as C3), LFOs and tone."
        ),
        params=[
            P(
                "prompt",
                "string",
                default="",
                control="TextInput",
                label="Prompt",
                help=TOKENSYNTH_PROMPT_HELP,
            ),
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
        description="Spectrally morph a sound toward a heavily smeared version of itself (single input).",
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
        description=(
            "Generate a noise drone/texture bed via lowpass/highpass, tremolo "
            "and echo, shaped by the prompt: noise colour, brightness, motion, "
            "space and an optional tonal drone (ignores the input audio)."
        ),
        params=[
            P(
                "prompt",
                "string",
                default="",
                control="TextInput",
                label="Prompt",
                help=AMBIENT_PROMPT_HELP,
            ),
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
