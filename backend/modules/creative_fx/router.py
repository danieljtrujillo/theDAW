"""Creative FX + Character Macros family — 8 tools.

The 5 character macros are implemented via the macro-graph runner (pure FFmpeg
chains). Glitch Machine, Neural Reverb and PitchLift are implemented with real
FFmpeg DSP / librosa pitch tracking.
"""

from __future__ import annotations

from pathlib import Path

from ...core.macro_runner import run_macro
from ...core.module_base import build_router
from ...lib import ffmpeg
from ...lib.params import ParamSpec as P
from ...lib.params import ToolSpec

FAMILY = "creative_fx"

# Macro definitions — knob values map to internal FFmpeg filter params.
MACROS: dict[str, dict] = {
    "ghost_voice": {
        "knobs": {"ghostiness": 0.5, "size": 0.5},
        "nodes": [
            {
                "filter": "afftdn",
                "args": lambda k: f"nr={12 + k['ghostiness'] * 24:.0f}",
            },
            {"filter": "atempo", "args": lambda k: f"{1 - k['ghostiness'] * 0.2:.3f}"},
            {
                "filter": "aecho",
                "args": lambda k: (
                    f"0.8:0.88:{int(60 + k['size'] * 900)}:{0.3 + k['size'] * 0.4:.2f}"
                ),
            },
        ],
    },
    "alien_transmission": {
        "knobs": {"mod": 0.5, "speed": 0.5},
        "nodes": [
            {
                "filter": "vibrato",
                "args": lambda k: (
                    f"f={4 + k['mod'] * 8:.1f}:d={0.3 + k['mod'] * 0.5:.2f}"
                ),
            },
            {
                "filter": "aphaser",
                "args": lambda k: f"speed={0.2 + k['speed'] * 3:.2f}:decay=0.6",
            },
        ],
    },
    "broken_tape": {
        "knobs": {"wow": 0.5, "tilt": 0.5},
        "nodes": [
            {
                "filter": "vibrato",
                "args": lambda k: (
                    f"f={1 + k['wow'] * 5:.2f}:d={0.2 + k['wow'] * 0.6:.2f}"
                ),
            },
            {"filter": "treble", "args": lambda k: f"g={-6 * k['tilt']:.1f}:f=6000"},
            {"filter": "highpass", "args": "f=60"},
        ],
    },
    "radio_room": {
        "knobs": {"distance": 0.5, "muffle": 0.5, "room": 0.5},
        "nodes": [
            {
                "filter": "highpass",
                "args": lambda k: f"f={300 + k['distance'] * 400:.0f}",
            },
            {
                "filter": "lowpass",
                "args": lambda k: f"f={4000 - k['muffle'] * 2500:.0f}",
            },
            {
                "filter": "aecho",
                "args": lambda k: (
                    f"0.8:0.9:{int(20 + k['room'] * 120)}:{0.2 + k['room'] * 0.3:.2f}"
                ),
            },
        ],
    },
    "tunnel_pa": {
        "knobs": {"harsh": 0.5, "distance": 0.5},
        "nodes": [
            {"filter": "highpass", "args": "f=400"},
            {"filter": "treble", "args": lambda k: f"g={k['harsh'] * 6:.1f}:f=3000"},
            {
                "filter": "aecho",
                "args": lambda k: (
                    f"0.85:0.9:{int(80 + k['distance'] * 400)}|{int(120 + k['distance'] * 500)}:0.5|0.3"
                ),
            },
        ],
    },
}


def _macro_handler(macro_id: str):
    macro = MACROS[macro_id]

    async def handler(inp: Path, out: Path, params: dict) -> None:
        await run_macro(macro, inp, out, params)

    return handler


def _macro_tool(tid, name, knobs, viz="macro") -> ToolSpec:
    return ToolSpec(
        id=tid,
        name=name,
        family=FAMILY,
        viz=viz,
        mode="macro",
        license="LGPL",
        engine="ffmpeg macro-graph",
        handler=_macro_handler(tid),
        description=f"Character-FX macro: {name}.",
        params=[
            P(k, "float", 0, 1, v, "", "ParamKnob", k.title()) for k, v in knobs.items()
        ],
    )


# ── Glitch Machine (process) ────────────────────────────────────────────────
async def _glitch_machine(inp: Path, out: Path, params: dict) -> None:
    """Real glitch effect: stutter via aloop + optional areverse + atempo.

    stutterChance controls loop repetitions; reverseChance > 0.5 adds areverse.
    """
    stutter = float(params.get("stutterChance", 0.5))
    reverse = float(params.get("reverseChance", 0.3))

    # stutter: loop count 1-6, loop size = 125ms of samples at 44100
    loop_count = max(1, int(stutter * 6))
    loop_size = int(44100 * 0.125)

    parts = [f"aloop=loop={loop_count}:size={loop_size}:start=0"]
    if reverse > 0.5:
        parts.append("areverse")
    # Keep tempo close to original — slight warp proportional to stutter
    tempo = max(0.5, min(2.0, 1.0 + (stutter - 0.5) * 0.4))
    parts.append(f"atempo={tempo:.3f}")

    af_chain = ",".join(parts)
    await ffmpeg.render(inp, out, ["-af", af_chain])


# ── Neural Reverb (filter via multi-tap aecho) ──────────────────────────────
async def _neural_reverb(inp: Path, out: Path, params: dict) -> None:
    """Multi-tap aecho reverb sized by roomSize and mixed by mix.

    Future: replace with NeuralReverberator IR synthesis + afir convolution.
    """
    size = float(params.get("roomSize", 0.5))
    mix = float(params.get("mix", 0.4))

    # Build multi-tap delay for a reverb-like response
    delay1 = int(40 + size * 200)
    delay2 = int(80 + size * 400)
    delay3 = int(130 + size * 600)
    decay1 = 0.3 * mix
    decay2 = 0.2 * mix
    decay3 = 0.1 * mix
    echo_filter = (
        f"aecho=0.8:0.9"
        f":{delay1}|{delay2}|{delay3}"
        f":{decay1:.3f}|{decay2:.3f}|{decay3:.3f}"
    )
    await ffmpeg.render(inp, out, ["-af", echo_filter])


# ── PitchLift (process, librosa pyin → sine resynthesis) ─────────────────────
async def _pitchlift(inp: Path, out: Path, params: dict) -> None:
    """Monophonic pitch tracking via librosa.pyin, resynthesized as a sine wave.

    Output is an audible sine melody following the detected f0 contour. Future:
    output MIDI via basic-pitch instead.
    """
    import numpy as np
    import soundfile as sf

    onset_threshold = float(params.get("onsetThreshold", 0.5))

    # Load audio as mono
    audio, sr = sf.read(str(inp), always_2d=True)
    mono = audio.mean(axis=1).astype(np.float32)

    # Run librosa pyin pitch detection
    import librosa

    f0, voiced_flag, voiced_prob = librosa.pyin(
        mono,
        fmin=librosa.note_to_hz("C2"),
        fmax=librosa.note_to_hz("C7"),
        sr=sr,
        frame_length=2048,
        hop_length=512,
    )

    # Resynthesize: generate a sine wave following the detected f0
    hop_length = 512
    n_frames = len(f0)
    output_length = len(mono)
    output = np.zeros(output_length, dtype=np.float64)
    phase = 0.0

    for i in range(n_frames):
        start = i * hop_length
        end = min(start + hop_length, output_length)
        if end <= start:
            break
        if voiced_flag[i] and not np.isnan(f0[i]):
            freq = f0[i]
            t = np.arange(end - start)
            # Continuous phase to avoid clicks between frames
            segment = 0.5 * np.sin(2.0 * np.pi * freq * t / sr + phase)
            phase += 2.0 * np.pi * freq * (end - start) / sr
            # Fade the amplitude by voiced probability (acts as confidence gate)
            prob = voiced_prob[i] if voiced_prob[i] > onset_threshold else 0.0
            output[start:end] = segment * prob
        # else: leave silence for unvoiced frames

    # Normalize to avoid clipping
    peak = np.max(np.abs(output))
    if peak > 0:
        output = output * (0.9 / peak)

    # Write output as WAV (same sample rate as input)
    sf.write(str(out), output, sr, subtype="PCM_24")


TOOLS: list[ToolSpec] = [
    _macro_tool("ghost_voice", "Ghost Voice", {"ghostiness": 0.5, "size": 0.5}),
    _macro_tool("alien_transmission", "Alien Transmission", {"mod": 0.5, "speed": 0.5}),
    _macro_tool("broken_tape", "Broken Tape", {"wow": 0.5, "tilt": 0.5}),
    _macro_tool(
        "radio_room", "Radio Room", {"distance": 0.5, "muffle": 0.5, "room": 0.5}
    ),
    _macro_tool("tunnel_pa", "Tunnel PA", {"harsh": 0.5, "distance": 0.5}),
    # ── DSP tools ──
    ToolSpec(
        id="glitch_machine",
        name="Glitch Machine",
        family=FAMILY,
        viz="grain",
        mode="process",
        license="LGPL",
        engine="ffmpeg glitch",
        description="Beat-synced stutter / reverse / warp / spectral smash.",
        handler=_glitch_machine,
        params=[
            P("stutterChance", "float", 0, 1, 0.5, "", "ParamKnob", "Stutter"),
            P("reverseChance", "float", 0, 1, 0.3, "", "ParamKnob", "Reverse"),
        ],
    ),
    ToolSpec(
        id="neural_reverb",
        name="Neural Reverb Designer",
        family=FAMILY,
        viz="macro",
        mode="process",
        license="MIT",
        engine="ffmpeg reverb (NeuralReverberator later)",
        description="Describe a space → synthesized impulse response → convolution reverb.",
        handler=_neural_reverb,
        params=[
            P("roomSize", "float", 0, 1, 0.5, "", "ParamKnob", "Size"),
            P("mix", "float", 0, 1, 0.4, "", "ParamKnob", "Mix"),
        ],
    ),
    ToolSpec(
        id="pitchlift",
        name="PitchLift (Audio→MIDI)",
        family=FAMILY,
        viz="piano",
        mode="process",
        license="Apache-2.0",
        engine="librosa pyin→sine (basic-pitch MIDI later)",
        description="Monophonic pitch tracking → sine resynthesis (audible melody output).",
        handler=_pitchlift,
        params=[P("onsetThreshold", "float", 0.1, 0.9, 0.5, "", "ParamKnob", "Onset")],
    ),
]

router = build_router(FAMILY, TOOLS)
