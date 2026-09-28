"""Restoration & Cleanup family — 11 tools.

All 11 tools are implemented:
 - FFmpeg filter-mode: De-Hum, De-Ess, De-Click, De-Clip.
 - FFmpeg process-mode (afftdn-based, needs the real source rate to
   compensate afftdn's own algorithmic delay exactly — see
   ``_afftdn_delay_samples``): Neural Denoise, De-Reverb, Restore All (whose
   prompt adds the repairs it names — see ``_restore_prompt_plan``).
 - Process mode (numpy/scipy/librosa): Vocal Isolate & Cleanup (with its
   denoise and dereverb stages), Stem Separation, Spectral Repair, Breath /
   Mouth-Click Removal.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path
from typing import Callable

import soundfile as sf

from ...core.module_base import build_router
from ...lib import audio_analysis, ffmpeg
from ...lib.audio_depth import ffmpeg_pcm_args, probe_depth
from ...lib.params import ParamSpec as P
from ...lib.params import ToolSpec

from . import dsp

FAMILY = "restoration"


def _afftdn_delay_samples(sample_rate: int) -> int:
    """Exact algorithmic group delay ffmpeg's ``afftdn`` introduces.

    Derived from ffmpeg's own source (libavfilter/af_afftdn.c,
    ``config_input``): ``sample_advance = sample_rate // 80`` (int
    truncation), ``window_length = 3 * sample_advance``, and its overlap-add
    output delay is ``window_length - sample_advance = 2 * sample_advance``
    samples — independent of ``nr``. Verified against real ffmpeg with a
    single-sample impulse: 44100 Hz -> 1102 samples (exact), 48000 Hz ->
    1200 (exact), 22050 Hz -> 550 (exact). See the identical, more fully
    documented copy of this derivation in
    ``backend/modules/enhance/router.py`` (duplicated rather than imported
    across families to keep each family's write set self-contained).
    """
    sample_advance = sample_rate // 80
    return 2 * sample_advance


def _probe_sample_rate(path: Path) -> int:
    """Source sample rate via ffprobe.

    Raises instead of silently falling back to 44.1 kHz when ffprobe is
    missing or the probe fails (``probe_file`` never raises, it returns
    ``{}`` instead) — see the identical, more fully documented copy of this
    fix in ``backend/modules/enhance/router.py``'s ``_probe_audio_format``.
    A loud failure beats quiet corruption.
    """
    from backend.modules.analysis.ffprobe import probe_file

    info = probe_file(path)
    rate = info.get("_summary", {}).get("sample_rate")
    if not rate:
        raise RuntimeError(
            f"Could not probe sample rate for {path}: ffprobe returned {info!r}"
        )
    return int(rate)


# ``_decoded_frame_count`` used to be a byte-for-byte duplicate of
# ``enhance/router.py``'s copy of the same helper; both now import the
# single shared implementation from ``backend.lib.audio_analysis`` so a
# future fix lands once instead of needing to be re-applied to both
# families.
_decoded_frame_count = audio_analysis.decoded_frame_count


def _frame_count(path: Path, sample_rate: int) -> int:
    """Frame count for the ``atrim=...:end_sample=`` bound.

    ``sf.info`` raises ``LibsndfileError`` on containers libsndfile cannot
    open (m4a/aac/wma uploaded as .wav); falls back to the exact decoded
    count from ``_decoded_frame_count``, and only to ``duration *
    sample_rate`` (inexact and one-directional — encoder priming/padding
    means container duration is never larger than the real decode, so this
    estimate always truncates, never overcounts; measured -824 samples on
    one real file — see ``_decoded_frame_count``) if ffprobe's per-frame
    probe itself is unavailable.
    """
    try:
        return sf.info(str(path)).frames
    except Exception:
        exact = _decoded_frame_count(path)
        if exact is not None:
            return exact

        from backend.modules.analysis.ffprobe import probe_file

        summary = probe_file(path).get("_summary") or {}
        duration = summary.get("duration_sec")
        if not duration:
            raise
        return round(float(duration) * sample_rate)


async def _render_with_source_rate(
    input_path: Path,
    output_path: Path,
    build_args: Callable[[int, int], list[str]],
    needs_frame_count: bool = True,
) -> None:
    """Process-mode render for filter-only tools whose filter graph needs
    the ACTUAL source sample rate for exact afftdn delay compensation.
    Replicates the bit-depth preservation filter-mode tools get for free
    from ``build_router.process()``, since process-mode handlers own their
    own render call.

    ``build_args(sample_rate, n_frames)`` — ``n_frames`` is the input's own
    frame count, for chains that end in an explicit
    ``atrim=...:end_sample=`` bound (see ``_restore_all``) — loudnorm's
    implicit 192 kHz round-trip does not divide evenly back to every source
    rate (e.g. 88.2 kHz), so a chain relying on its own natural output
    length coming out exactly ``n_frames`` samples can be one sample long;
    an explicit end bound is exact regardless.

    ``needs_frame_count`` is False for callers whose ``build_args`` never
    reads ``n_frames`` (``_neural_denoise``, ``_dereverb``) — they get ``0``
    and skip the extra probe entirely, rather than paying for a count they
    discard."""
    sr = await asyncio.to_thread(_probe_sample_rate, input_path)
    n_frames = (
        await asyncio.to_thread(_frame_count, input_path, sr)
        if needs_frame_count
        else 0
    )
    filter_args = build_args(sr, n_frames)
    ext = output_path.suffix.lstrip(".")
    pcm_args = ffmpeg_pcm_args(probe_depth(input_path), ext)
    await ffmpeg.render(input_path, output_path, filter_args, extra_out_args=pcm_args)


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


async def _neural_denoise(input_path: Path, output_path: Path, params: dict) -> None:
    """FFmpeg afftdn broadband noise removal. nr = amount*40+5 → range 5..45 dB.

    Process-mode so the output can be trimmed back to afftdn's own exact
    algorithmic delay (see ``_afftdn_delay_samples``) — otherwise the whole
    render comes out ~25ms late relative to the input, every time."""
    amount = float(params["amount"])
    nr = amount * 40.0 + 5.0
    afftdn_stage = f"afftdn=nr={nr:.0f}:nt=w"

    def build(sr: int, n_frames: int) -> list[str]:
        delay = _afftdn_delay_samples(sr)
        # apad BEFORE afftdn: without it, the head-trim below shrinks the
        # output by `delay` samples relative to the input, silently
        # dropping the LAST `delay` samples of real tail content (afftdn
        # never gets to flush them) — verified: an impulse 300 samples
        # from the end was reduced to noise-floor without apad, present
        # at the exact right position (shift=0) with it.
        chain = f"apad=pad_len={delay},{afftdn_stage}"
        return ["-af", f"{chain},atrim=start_sample={delay},asetpts=PTS-STARTPTS"]

    await _render_with_source_rate(
        input_path, output_path, build, needs_frame_count=False
    )


def _declip(params: dict) -> list[str]:
    """FFmpeg adeclip — real de-clipping filter."""
    threshold = float(params["clipThreshold"])
    # adeclip 'a' parameter range is 0-25 (amplitude threshold in %)
    # Map our 0.1-1.0 param range → 2.5-25
    t = threshold * 25.0
    return ["-af", f"adeclip=a={t:.1f}"]


async def _dereverb(input_path: Path, output_path: Path, params: dict) -> None:
    """Spectral-gate de-reverb: aggressive afftdn + highpass + downward
    expansion. Process-mode for the same exact-delay-compensation reason
    as ``_neural_denoise``."""
    dry_wet = float(params["dryWet"])
    # Stronger effect → higher noise reduction + narrower band
    nr = dry_wet * 30.0 + 5.0  # 5-35 dB noise reduction
    hp_freq = 80.0 + dry_wet * 120.0  # 80-200 Hz highpass
    # Chain: highpass to remove room rumble, afftdn for spectral gating,
    # compand for downward expansion of quiet reverb tails
    highpass_stage = f"highpass=f={hp_freq:.0f}"
    afftdn_stage = f"afftdn=nr={nr:.0f}:nt=w"
    compand_stage = (
        f"compand=attacks=0.01:decays=0.1:points=-80/-80|-45/-45|"
        f"-30/{-30 - dry_wet * 10:.0f}|0/0"
    )

    def build(sr: int, n_frames: int) -> list[str]:
        delay = _afftdn_delay_samples(sr)
        # apad BEFORE afftdn — see _neural_denoise's identical comment for
        # the tail-content-loss this prevents.
        chain = ",".join(
            [highpass_stage, f"apad=pad_len={delay}", afftdn_stage, compand_stage]
        )
        return ["-af", f"{chain},atrim=start_sample={delay},asetpts=PTS-STARTPTS"]

    await _render_with_source_rate(
        input_path, output_path, build, needs_frame_count=False
    )


# Restore All's prompt vocabulary: each word set names one repair. The chain
# has no text model, so the prompt steers it by these words; anything else in
# the prompt is ignored.
_PROMPT_DECLIP = {
    "clip",
    "clipped",
    "clipping",
    "distorted",
    "distortion",
    "overdriven",
}
_PROMPT_DECLICK = {
    "click",
    "clicks",
    "clicky",
    "crackle",
    "crackles",
    "crackling",
    "pop",
    "pops",
    "popping",
    "vinyl",
    "scratchy",
}
_PROMPT_HUM = {"hum", "hums", "humming", "buzz", "buzzing", "mains"}
_PROMPT_HISS = {"hiss", "hissy", "hissing", "noise", "noisy", "static", "fuzz"}
_PROMPT_RUMBLE = {"rumble", "rumbly", "wind", "handling", "thump", "thumps"}
_PROMPT_MUDDY = {"muddy", "mud", "boomy", "boxy", "woolly"}
_PROMPT_HARSH = {"harsh", "shrill", "piercing", "brittle"}
_PROMPT_SIBILANT = {"sibilance", "sibilant", "esses", "essy"}
_PROMPT_DULL = {"dull", "muffled", "dark", "veiled", "lifeless"}
_PROMPT_THIN = {"thin", "tinny"}
_PROMPT_REVERB = {"reverb", "reverby", "echo", "echoey", "echoy", "room", "roomy"}

RESTORE_PROMPT_HELP = (
    "Words that steer the chain: hum or buzz (add 50 for 50 Hz mains, 60 Hz "
    "otherwise), hiss or noise, rumble or wind, muddy or boxy, harsh, "
    "sibilance, dull or muffled, thin or tinny, clicks, crackle or vinyl, "
    "clipping or distorted, reverb, echo or room."
)


def _restore_prompt_plan(prompt: str) -> tuple[float, list[str]]:
    """Turn Restore All's prompt into extra repair stages.

    Returns the extra afftdn reduction in dB and the ffmpeg stages to run
    after afftdn, in a fixed order: the waveform repairs (declip, then
    declick) come before the tonal moves, so no EQ boost ever reaches the
    click detector. Every stage here is delay-free (measured against real
    ffmpeg with band-limited noise at 22.05, 44.1, 48 and 96 kHz: zero lag,
    same length), so the chain's afftdn delay compensation still holds. An
    empty prompt, or one with none of these words, returns ``(0.0, [])`` and
    leaves the chain unchanged.
    """
    words = set(re.findall(r"[a-z0-9]+", prompt.lower()))
    extra_nr = 0.0
    stages: list[str] = []
    if words & _PROMPT_DECLIP:
        stages.append("adeclip")
    if words & _PROMPT_DECLICK:
        stages.append("adeclick")
    if words & _PROMPT_HUM:
        mains = 50.0 if words & {"50", "50hz"} else 60.0
        stages += [
            f"equalizer=f={mains * k:.0f}:width_type=q:w=30:g=-30" for k in range(1, 6)
        ]
    if words & _PROMPT_HISS:
        extra_nr += 12.0
    if words & _PROMPT_REVERB:
        # De-Reverb's downward expansion at its full amount: quiet tails sink.
        stages.append(
            "compand=attacks=0.01:decays=0.1:points=-80/-80|-45/-45|-30/-40|0/0"
        )
        extra_nr += 5.0
    if words & _PROMPT_RUMBLE:
        stages.append("highpass=f=80")
    if words & _PROMPT_MUDDY:
        stages.append("equalizer=f=300:width_type=o:w=1:g=-4")
    if words & _PROMPT_HARSH:
        stages.append("equalizer=f=3500:width_type=o:w=1:g=-4")
    if words & _PROMPT_SIBILANT:
        stages.append("deesser=i=0.5:m=0.5:f=0.5:s=o")
    if words & _PROMPT_DULL:
        stages.append("treble=g=4:f=6000")
    if words & _PROMPT_THIN:
        stages.append("bass=g=3:f=150")
    return extra_nr, stages


async def _restore_all(input_path: Path, output_path: Path, params: dict) -> None:
    """DSP restore chain: afftdn + presence EQ + loudnorm, plus the repairs
    the prompt names (see ``_restore_prompt_plan``). Process-mode for the
    same exact-delay-compensation reason as ``_neural_denoise``."""
    strength = float(params["strength"])
    extra_nr, prompt_stages = _restore_prompt_plan(str(params.get("prompt", "")))
    nr = strength * 25.0 + 5.0 + extra_nr  # 5-30 dB noise reduction, + prompt
    # Presence boost around 3-5 kHz scaled by strength
    eq_gain = strength * 3.0  # 0-3 dB
    afftdn_stage = f"afftdn=nr={nr:.0f}:nt=w"
    tail_parts = [
        *prompt_stages,
        f"equalizer=f=4000:width_type=o:w=1.5:g={eq_gain:.1f}",
        "loudnorm=I=-14:TP=-1:LRA=11",
    ]

    def build(sr: int, n_frames: int) -> list[str]:
        delay = _afftdn_delay_samples(sr)
        # apad BEFORE afftdn — see _neural_denoise's identical comment for
        # the tail-content-loss this prevents.
        chain = ",".join([f"apad=pad_len={delay}", afftdn_stage, *tail_parts])
        # loudnorm only operates at 192 kHz — ffmpeg silently inserts an
        # implicit resampler before it, and its OUTPUT stays at 192 kHz.
        # `delay` was computed in SOURCE-rate samples; atrim executed
        # straight after loudnorm would then count 192 kHz samples,
        # trimming the wrong amount and leaving the output at 192 kHz
        # (measured: +19.25ms/+18.75ms residual shift and 192000 Hz output
        # at 44.1k/48k before this explicit resample was added). Resample
        # back to the source rate BEFORE atrim so start_sample's units
        # match `delay`'s.
        #
        # `(N+2204)*320/147` (this apad/afftdn/192k-round-trip/resample-back
        # arithmetic) is non-integral at 88.2 kHz specifically, and the
        # natural output length rounds up by one sample there — measured
        # in_n=88200 -> out_n=88201 with no explicit end bound. An explicit
        # `end_sample=` makes the trim exact at every rate, not just the
        # ones where the arithmetic happens to divide evenly.
        return [
            "-af",
            f"{chain},aresample={sr},"
            f"atrim=start_sample={delay}:end_sample={delay + n_frames},"
            f"asetpts=PTS-STARTPTS",
        ]

    await _render_with_source_rate(input_path, output_path, build)


# ── process-mode wrappers (delegate to dsp.py) ──────────────────────────────
# Plain sync on purpose: build_router offloads non-coroutine handlers to a
# worker thread via asyncio.to_thread, keeping the event loop responsive
# during CPU-bound DSP.


def _vocal_isolate(input_path: Path, output_path: Path, params: dict) -> None:
    dsp.vocal_isolate_sync(input_path, output_path, params)


def _stem_separation(input_path: Path, output_path: Path, params: dict) -> None:
    dsp.stem_separation(input_path, output_path, params)


def _spectral_repair(input_path: Path, output_path: Path, params: dict) -> None:
    dsp.spectral_repair(input_path, output_path, params)


def _breath_removal(input_path: Path, output_path: Path, params: dict) -> None:
    dsp.breath_removal_sync(input_path, output_path, params)


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
        engine="mid/side extraction + spectral cleanup (Mel-Roformer later)",
        handler=_vocal_isolate,
        description=(
            "Vocal extraction via mid/side stereo processing with wet/dry "
            "blend, then cleanup: spectral-subtraction denoise and "
            "late-reverb suppression."
        ),
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
            P(
                "denoiseAmount",
                "float",
                0,
                1,
                0.5,
                "",
                "ParamKnob",
                "Denoise",
                help="Spectral-subtraction noise reduction; 0 is off, 1 cuts noise up to 30 dB.",
            ),
            P(
                "dereverbAmount",
                "float",
                0,
                1,
                0.0,
                "",
                "ParamKnob",
                "Dereverb",
                help="Late-reverb suppression; 0 is off, 1 removes the room tail hardest.",
            ),
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
        description=(
            "2 = harmonic; 3-6 = percussive with increasing separation "
            "strength (HPSS margin). Outputs one track, not N stems."
        ),
        # Param name kept as "stems" for API/preset compatibility; it does
        # not select a stem count (HPSS only ever produces one track here).
        params=[P("stems", "int", 2, 6, 4, "", "Dropdown", "Output / Strength")],
    ),
    ToolSpec(
        id="neural_denoise",
        name="Neural Denoise",
        family=FAMILY,
        viz="spectro",
        # process (not filter): needs the real source sample rate to
        # compensate afftdn's algorithmic delay exactly.
        mode="process",
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
        # process (not filter): same reason as neural_denoise.
        mode="process",
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
        # process (not filter): same reason as neural_denoise.
        mode="process",
        gpu=False,
        flagship=True,
        license="Apache-2.0",
        engine="DSP restore chain (SonicMaster later)",
        handler=_restore_all,
        description=(
            "One-click restoration: denoise + presence EQ + loudnorm. The "
            "prompt adds the repairs it names: hum, hiss, rumble, muddy, "
            "harsh, sibilance, dull, thin, clicks, clipping, reverb."
        ),
        params=[
            P("strength", "float", 0, 1, 0.7, "", "ParamKnob", "Strength"),
            P(
                "prompt",
                "string",
                default="",
                control="TextInput",
                label="Prompt",
                help=RESTORE_PROMPT_HELP,
            ),
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
        engine="numpy breath + click detect",
        handler=_breath_removal,
        description=(
            "Auto-detect and attenuate breaths (RMS + spectral centroid) and "
            "mouth clicks (short high-frequency bursts)."
        ),
        params=[
            P("breathReduction", "float", 0, 1, 0.8, "", "ParamKnob", "Breath"),
            P(
                "clickReduction",
                "float",
                0,
                1,
                0.7,
                "",
                "ParamKnob",
                "Clicks",
                help="Mouth-click removal; higher finds quieter clicks and removes more of each.",
            ),
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
