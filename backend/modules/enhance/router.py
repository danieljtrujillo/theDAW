"""Enhance / Super-Resolution family — 5 tools.

All 5 are implemented via FFmpeg DSP:
  - Classical Upsample: libsoxr VHQ sample-rate conversion.
  - Super-Res:          soxr upsample + aexciter + treble shelf for bandwidth extension.
  (Both fall back to swr at matching quality when this ffmpeg has no libsoxr —
  see backend/lib/resampler.py; a hard-coded soxr failed the render there.)
  - Un-Crush:           afftdn denoiser + equalizer dip + aexciter for codec artifact removal.
  - Studio Enhance:     afftdn + presence EQ boost + EBU R128 loudnorm.
  - Neural Codec:       Opus encode/decode re-synthesis for RVQ-like degradation.

Super-Res, Un-Crush and Neural Codec each declare a ``mix`` (wet/dry) param;
all three actually apply it. Un-Crush and Studio Enhance use ``afftdn``,
which has a real algorithmic group delay (see ``_afftdn_delay_samples``) —
both are process-mode so they can probe the ACTUAL source sample rate and
compensate that delay exactly on the whole output (no output-vs-input
timeline drift, even at mix=1). Un-Crush additionally compensates it
between its wet/dry branches (no flam at partial mix) — Studio Enhance's
ToolSpec declares no ``mix`` param and has no wet/dry branches at all, so
this clause applies to Un-Crush only. Super-Res uses no afftdn but its
exciter/treble boost can clip; its final resample+limiter stage prevents
that (see ``_super_res``).
"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path
from typing import Callable

import soundfile as sf

from ...core.module_base import build_router
from ...lib import audio_analysis, ffmpeg
from ...lib.audio_depth import ffmpeg_pcm_args, probe_depth
from ...lib.params import ParamSpec as P
from ...lib.params import ToolSpec
from ...lib.resampler import hq_resampler

FAMILY = "enhance"


def _afftdn_delay_samples(sample_rate: int) -> int:
    """Exact algorithmic group delay ffmpeg's ``afftdn`` introduces, derived
    from its own source (libavfilter/af_afftdn.c, ``config_input``)::

        sample_advance = sample_rate // 80        # int truncation, C semantics
        window_length  = 3 * sample_advance
        delay          = window_length - sample_advance = 2 * sample_advance

    Independent of ``nr`` — verified against real ffmpeg with an impulse and
    nr in {0.01, 5, 12, 30, 97} at a fixed rate: identical delay every time.

    Verified against real ffmpeg with a single-sample impulse at the three
    rates this family actually sees:
        44100 Hz -> formula gives 1102; measured 1102 (exact)  = 24.989 ms
        48000 Hz -> formula gives 1200; measured 1200 (exact)  = 25.000 ms
        22050 Hz -> formula gives  550; measured  550 (exact)  = 24.943 ms

    This MUST be computed from the actual sample rate, not assumed from a
    flat "25ms" constant: ffmpeg's own ``adelay``/``atrim`` duration options
    do not reproduce this formula exactly at every rate (they diverge from
    ``2*(sr//80)`` by exactly 1 sample whenever ``sr % 80 >= 40`` — true at
    22050 but not 44100 or 48000 — because ``floor(sr/40)`` and
    ``2*floor(sr/80)`` are mathematically different roundings), and
    ``adelay`` (ms, truncates) vs ``atrim start=`` (seconds, rounds via
    ``av_rescale_q``) do not even round the SAME way as each other (e.g.
    1102 vs 1103 at 44100 — measured). Using the literal sample count here
    (``NS``/``start_sample=N``) sidesteps all of that: it is exact at every
    rate, not just the three checked above.
    """
    sample_advance = sample_rate // 80
    return 2 * sample_advance


def _wet_dry_filter_args(
    wet_chain: str, mix: float, final_stage: str | None = None
) -> list[str]:
    """Wrap a single-input wet ``wet_chain`` (containing no ``afftdn``) in a
    filter_complex that crossfades it against the untouched dry input at
    ``mix`` (0=dry, 1=fully wet). Used by Super-Res only — Un-Crush and
    Studio Enhance need afftdn's exact per-rate delay compensation and build
    their own filter_complex in ``_render_with_source_rate`` instead.

    Both branches read from the same ``[0:a]`` input stream at the same
    native sample rate/channel layout, and the wet chain here (soxr/swr
    precision-only resample, aexciter, treble) does not change sample count
    or channel layout — so no explicit reformatting is needed before
    ``amix``. ``normalize=0`` + explicit weights makes ``amix`` do a true
    linear crossfade instead of its default even-split averaging.

    ``final_stage``, if given, is an extra filter chain applied to the
    MIXED output (not to either branch individually) — e.g. Super-Res's
    resample + limiter, which must see the final combined signal: a
    sample-peak limiter placed before a rate conversion does not guard
    against the inter-sample overshoot the resample itself can introduce.
    """
    mix = max(0.0, min(1.0, float(mix)))
    dry_w, wet_w = 1.0 - mix, mix
    fc = (
        f"[0:a]asplit=2[dry][wetin];"
        f"[wetin]{wet_chain}[wet];"
        f"[dry][wet]amix=inputs=2:duration=first:dropout_transition=0:"
        f"normalize=0:weights={dry_w:.4f} {wet_w:.4f}[outa]"
    )
    map_label = "[outa]"
    if final_stage:
        fc += f";[outa]{final_stage}[outf]"
        map_label = "[outf]"
    return ["-filter_complex", fc, "-map", map_label]


def _channel_layout(n_channels: int) -> str:
    """ffmpeg channel-layout name for aformat; falls back to the raw
    ``Nc`` channel-count syntax for anything beyond mono/stereo."""
    return {1: "mono", 2: "stereo"}.get(n_channels, f"{n_channels}c")


def _probe_audio_format(path: Path) -> tuple[int, int]:
    """(sample_rate, channels) via ffprobe.

    Raises instead of silently falling back to CD-standard stereo when
    ffprobe is missing or the probe fails (``probe_file`` never raises, it
    returns ``{}`` instead) — a wrong assumed rate here shifts afftdn's
    delay compensation away from the real source rate: on a real 96 kHz
    source with a failed probe, the assumed-44100 delay (1102) against the
    true 96 kHz delay (2400) shifts content +1298 samples (13.5 ms) and
    silently drops the last 1298 samples of tail, even though the output
    length is unchanged. A loud failure beats quiet corruption.
    """
    from backend.modules.analysis.ffprobe import probe_file

    info = probe_file(path)
    summary = info.get("_summary", {})
    rate = summary.get("sample_rate")
    channels = summary.get("channels")
    if not rate or not channels:
        raise RuntimeError(
            f"Could not probe audio format for {path}: ffprobe returned {info!r}"
        )
    return int(rate), int(channels)


# ``_decoded_frame_count`` used to be a byte-for-byte duplicate of
# ``restoration/router.py``'s copy of the same helper; both now import the
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
    the ACTUAL source sample rate (afftdn delay compensation must be exact
    per rate — see ``_afftdn_delay_samples``). ``build_args(sample_rate,
    n_frames)`` returns the ``-af``/``-filter_complex`` args to render with;
    ``n_frames`` is the input's own frame count, for chains that end in an
    explicit ``atrim=...:end_sample=`` bound (see ``_studio_enhance``) —
    loudnorm's implicit 192 kHz round-trip does not divide evenly back to
    every source rate (e.g. 88.2 kHz), so a chain relying on its own natural
    output length coming out exactly ``n_frames`` samples can be one sample
    long; an explicit end bound is exact regardless.

    ``needs_frame_count`` is False for callers whose ``build_args`` never
    reads ``n_frames`` (e.g. ``_uncrush``) — they get ``0`` and skip the
    extra probe (an ``sf.info`` call, or on an unreadable container an
    ffprobe subprocess) entirely, rather than paying for a count they
    discard.

    Filter-mode tools get bit-depth preservation for free from
    ``build_router.process()`` (``ffmpeg_pcm_args`` + ``probe_depth``);
    process-mode handlers own their own render call, so this replicates it
    rather than silently losing it for the tools converted to process mode.
    """
    sr, _ = await asyncio.to_thread(_probe_audio_format, input_path)
    n_frames = (
        await asyncio.to_thread(_frame_count, input_path, sr)
        if needs_frame_count
        else 0
    )
    filter_args = build_args(sr, n_frames)
    ext = output_path.suffix.lstrip(".")
    pcm_args = ffmpeg_pcm_args(probe_depth(input_path), ext)
    await ffmpeg.render(input_path, output_path, filter_args, extra_out_args=pcm_args)


# ── Classical Upsample (filter) ──────────────────────────────────────────────


def _upsample(params: dict) -> list[str]:
    sr = int(float(params["targetSR"]))
    prec = int(params["precision"])
    return ["-af", f"aresample={hq_resampler(prec)}", "-ar", str(sr)]


# ── Super-Res / Bandwidth Extension (filter) ─────────────────────────────────


def _super_res(params: dict) -> list[str]:
    sr = int(float(params["targetSR"]))
    guidance = float(params["guidance"])
    mix = float(params.get("mix", 1.0))
    # Map guidance (1-7) to aexciter amount (2-14) and treble gain (1-6 dB)
    exciter_amount = guidance * 2
    treble_gain = max(1.0, guidance * 0.86)  # ~1-6 dB
    hq = hq_resampler(28)
    wet_effect = (
        f"aresample={hq},"
        f"aexciter=amount={exciter_amount:.1f}:freq=7500,"
        f"treble=g={treble_gain:.1f}:f=12000"
    )
    # The exciter + treble boost can push a quiet source's true peak well
    # over 0 dBFS (measured up to ~1.27, tens of samples over, on realistic
    # broadband content at guidance=3.5 — a pure low-frequency sine barely
    # moves it, so a plain-tone smoke test would miss this entirely).
    #
    # The target-rate resample and the limiter are both folded into this
    # FINAL stage, applied to the fully-combined signal, in that exact
    # order — NEVER via the bare `-ar` output option, and never limiter
    # before resample. A sample-peak limiter placed before a rate
    # conversion does not guard against the inter-sample overshoot the
    # resample's reconstruction filter can itself introduce (verified:
    # limit-then-resample still measured peaks above 1.0 on the same
    # content that resample-then-limit measured at exactly 0.98, 0 samples
    # over, across guidance 1-7 and several source levels).
    # `latency=true` makes alimiter compensate its own ~5ms lookahead
    # buffering so the limiter doesn't reintroduce a timeline offset of
    # its own (verified: impulse lag 219 samples without it, 0 with it).
    final_stage = f"aresample={sr}:{hq},alimiter=limit=0.98:level=false:latency=true"
    if mix >= 1.0:
        return ["-af", f"{wet_effect},{final_stage}"]
    if mix <= 0.0:
        # True dry passthrough: no exciter/treble ever ran, so there is
        # nothing for the limiter to guard against — routing dry through
        # it anyway silently squashed a legitimate 1.0 peak to 0.98. Only
        # the target-rate resample still applies (the resolution change
        # this tool exists for, independent of mix).
        return ["-af", f"anull,aresample={sr}:{hq}"]
    return _wet_dry_filter_args(wet_effect, mix, final_stage)


# ── Un-Crush (filter) ────────────────────────────────────────────────────────


async def _uncrush(input_path: Path, output_path: Path, params: dict) -> None:
    """Process-mode (not filter-mode) specifically so this can probe the
    real source sample rate and compensate afftdn's own algorithmic group
    delay exactly (see ``_afftdn_delay_samples``) — both between the
    wet/dry branches at a partial mix (no flam/comb) and on the whole
    output at any mix > 0 (no output-vs-input timeline drift)."""
    strength = float(params["strength"])
    mix = max(0.0, min(1.0, float(params.get("mix", 1.0))))
    # Map strength (0-1) to DSP parameters
    # ffmpeg's afftdn rejects nr=0 (valid range is 0.01-97), so a strength of
    # 0 must still clamp to its documented minimum rather than 500 on render.
    denoise_amount = max(strength * 30, 0.01)  # afftdn noise reduction 0.01-30 dB
    eq_dip = -(strength * 4)  # 0 to -4 dB dip at 3kHz harshness
    exciter_amount = strength * 4  # gentle harmonic restoration
    wet_chain = (
        f"afftdn=nr={denoise_amount:.2f}:nt=w,"
        f"equalizer=f=3000:t=q:w=1.5:g={eq_dip:.1f},"
        f"aexciter=amount={exciter_amount:.1f}:freq=8000"
    )

    def build(sr: int, n_frames: int) -> list[str]:
        if mix <= 0.0:
            # Never touches afftdn — already aligned, nothing to trim.
            return ["-af", "anull"]
        delay = _afftdn_delay_samples(sr)
        # apad BEFORE afftdn: without it, atrim's head-trim below shrinks
        # the output by `delay` samples relative to the input, silently
        # dropping the LAST `delay` samples of real tail content (afftdn
        # never gets to flush them) — verified: an impulse 300 samples
        # from the end was reduced to noise-floor (peak ~3.9e-6) without
        # apad, present at the exact right position (shift=0) with it.
        wet_padded = f"apad=pad_len={delay},{wet_chain}"
        trim = f"atrim=start_sample={delay},asetpts=PTS-STARTPTS"
        # The exciter here can push a quiet source's true peak over 0 dBFS
        # the same way Super-Res's does (see ``_super_res``) -- Un-Crush
        # shares ``aexciter`` but previously had no limiter guarding it
        # (measured: 3228 of 44100 samples hard-clipped on an integer-depth
        # source at strength=1 mix=1). `latency=true` makes alimiter
        # compensate its own ~5ms lookahead buffering so it doesn't
        # reintroduce a timeline offset of its own (measured impulse lag
        # +219 samples without it, 0 with it -- same verification as
        # ``_super_res``).
        limiter = "alimiter=limit=0.98:level=false:latency=true"
        if mix >= 1.0:
            return ["-af", f"{wet_padded},{trim},{limiter}"]
        dry_w, wet_w = 1.0 - mix, mix
        fc = (
            f"[0:a]asplit=2[dry][wetin];"
            f"[dry]adelay={delay}S:all=1[dryd];"
            f"[wetin]{wet_padded}[wet];"
            f"[dryd][wet]amix=inputs=2:duration=first:dropout_transition=0:"
            f"normalize=0:weights={dry_w:.4f} {wet_w:.4f}[outa];"
            f"[outa]{trim},{limiter}[outt]"
        )
        return ["-filter_complex", fc, "-map", "[outt]"]

    await _render_with_source_rate(
        input_path, output_path, build, needs_frame_count=False
    )


# ── Studio Enhance (filter) ──────────────────────────────────────────────────


async def _studio_enhance(input_path: Path, output_path: Path, params: dict) -> None:
    """Process-mode so the afftdn leg (when denoise > 0) can be aligned back
    to the input's own timeline exactly — see ``_afftdn_delay_samples``."""
    enhance = float(params["enhance"])
    denoise = float(params["denoise"])
    # Build filter chain: denoise → presence EQ boost → loudnorm
    denoise_nr = denoise * 25  # 0-25 dB noise reduction
    presence_gain = enhance * 4  # 0-4 dB presence boost at 3.5kHz
    has_denoise = denoise > 0
    # ffmpeg's afftdn rejects nr=0 (valid range is 0.01-97). A low but
    # non-zero denoise (e.g. 0.01 -> denoise_nr=0.25) still rounds to 0 at
    # :.0f, so clamp to the documented minimum and keep 2 decimals.
    afftdn_stage = (
        f"afftdn=nr={max(denoise_nr, 0.01):.2f}:nt=w" if has_denoise else None
    )
    tail_parts = []
    if enhance > 0:
        tail_parts.append(f"equalizer=f=3500:t=q:w=2:g={presence_gain:.1f}")
    tail_parts.append("loudnorm=I=-16:TP=-1:LRA=11")

    def build(sr: int, n_frames: int) -> list[str]:
        if not has_denoise:
            # loudnorm (always the last of tail_parts) forces the same
            # implicit 192 kHz resample whether or not afftdn ran — the
            # denoise=0 path (a reachable knob position, the ToolSpec's own
            # declared minimum) still needs the explicit resample back to
            # the source rate, not just the has_denoise branch below.
            return ["-af", ",".join([*tail_parts, f"aresample={sr}"])]
        delay = _afftdn_delay_samples(sr)
        # apad BEFORE afftdn so the head-trim below doesn't drop the last
        # `delay` samples of real tail content (see _uncrush's identical
        # comment/verification for the exact failure mode this prevents).
        chain = ",".join([f"apad=pad_len={delay}", afftdn_stage, *tail_parts])
        # loudnorm only operates at 192 kHz — ffmpeg silently inserts an
        # implicit resampler before it, and its OUTPUT stays at 192 kHz.
        # `delay` was computed in SOURCE-rate samples; atrim executed
        # straight after loudnorm would then count 192 kHz samples,
        # trimming the wrong amount and leaving the output at 192 kHz
        # (both confirmed: measured +19.25ms/+18.75ms residual shift and
        # 192000 Hz output at 44.1k/48k before this explicit resample was
        # added). Resample back to the source rate BEFORE atrim so
        # start_sample's units match `delay`'s.
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


# ── Neural Codec Re-Synth (process) ──────────────────────────────────────────


async def _neural_codec(input_path: Path, output_path: Path, params: dict) -> None:
    """Encode through Opus at a mapped bitrate, then decode back to wav.

    nQuantizers (1-32) maps to bitrate: fewer quantizers = lower bitrate = more
    degradation, mimicking the quality ladder of neural RVQ codecs like DAC/EnCodec.
    Formula: bitrate = 6 + nQuantizers * 4  kbps  (range: 10k - 134k).

    ``mix`` (0=dry, 1=fully re-synthesized) blends the decoded/degraded
    signal back against the untouched original. Opus decodes at ITS OWN
    internal rate (48 kHz, confirmed against real ffmpeg regardless of the
    source's rate) so, for a partial mix, both branches are explicitly
    reformatted to the dry input's sample rate/channel layout before
    ``amix`` — without that, ``amix`` errors or silently mismatches
    instead of crossfading.
    """
    n_q = int(params["nQuantizers"])
    bitrate_kbps = 6 + n_q * 4
    mix = max(0.0, min(1.0, float(params.get("mix", 1.0))))
    # process-mode handlers own their render call, so — unlike filter-mode,
    # which gets this for free from build_router.process() — bit-depth
    # preservation must be applied explicitly here, on every path
    # (including mix<=0): without it every render came back at ffmpeg's
    # WAV default (16-bit) regardless of a 24/32-bit or float source.
    ext = output_path.suffix.lstrip(".")
    pcm_args = ffmpeg_pcm_args(probe_depth(input_path), ext)

    if mix <= 0.0:
        # No processing requested: dry passthrough, still re-encoded to the
        # container build_router expects at output_path. Checked BEFORE the
        # Opus encode/decode round-trip — there is no reason to pay for it
        # when the result is discarded outright.
        await ffmpeg.render(input_path, output_path, [], extra_out_args=pcm_args)
        return

    dry_rate, dry_channels = await asyncio.to_thread(_probe_audio_format, input_path)
    layout = _channel_layout(dry_channels)

    tmp_opus = Path(tempfile.mktemp(suffix=".opus", prefix="codec_"))
    try:
        # Step 1: encode input to Opus at the target bitrate
        await ffmpeg.render(
            input_path,
            tmp_opus,
            [],
            extra_out_args=["-c:a", "libopus", "-b:a", f"{bitrate_kbps}k"],
        )

        if mix >= 1.0:
            # Step 2: decode Opus back to wav, reformatted to the dry
            # input's own rate/channels — Opus decodes at ITS OWN internal
            # rate (48 kHz here) regardless of the source's rate, so a
            # fully-wet render must not silently answer 48k always while
            # mix<1 answers the source rate; both now agree.
            await ffmpeg.render(
                tmp_opus,
                output_path,
                ["-af", f"aformat=sample_rates={dry_rate}:channel_layouts={layout}"],
                extra_out_args=pcm_args,
            )
            return

        tmp_wet = Path(tempfile.mktemp(suffix=".wav", prefix="codec_wet_"))
        try:
            await ffmpeg.render(tmp_opus, tmp_wet, [])
            dry_w, wet_w = 1.0 - mix, mix
            fc = (
                f"[0:a]aformat=sample_rates={dry_rate}:channel_layouts={layout}[dry];"
                f"[1:a]aformat=sample_rates={dry_rate}:channel_layouts={layout}[wet];"
                f"[dry][wet]amix=inputs=2:duration=first:dropout_transition=0:"
                f"normalize=0:weights={dry_w:.4f} {wet_w:.4f}[outa]"
            )
            await ffmpeg.render_multi(
                [input_path, tmp_wet],
                output_path,
                fc,
                out_map="[outa]",
                extra_out_args=pcm_args,
            )
        finally:
            if tmp_wet.exists():
                tmp_wet.unlink()
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
        engine="soxr (swr HQ without libsoxr) + exciter (AudioSR later)",
        prefers=("soxr",),
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
        # process (not filter): needs the real source sample rate to
        # compensate afftdn's algorithmic delay exactly — see
        # `_afftdn_delay_samples`.
        mode="process",
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
        # process (not filter): same reason as uncrush — the afftdn leg
        # needs the real source sample rate for exact delay compensation.
        mode="process",
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
        engine="ffmpeg:soxr (swr HQ without libsoxr)",
        prefers=("soxr",),
        handler=_upsample,
        description=(
            "Transparent libsoxr VHQ sample-rate conversion (the non-neural "
            "fallback); ffmpeg's swr at matching quality when ffmpeg lacks libsoxr."
        ),
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
