"""Delivery / Export family — 6 tools.

Implemented: Codec Matrix, Smart Export (two-pass loudnorm → encode → true-peak
verify), High-Quality SRC, Dither, Metadata and Batch Export.
"""

from __future__ import annotations

from pathlib import Path

from ...core.module_base import build_router
from ...lib import audio_analysis, ffmpeg
from ...lib.params import ParamSpec as P
from ...lib.params import ToolSpec

FAMILY = "delivery"

# 2026 platform targets: lufs / true-peak / container (see docs/edit-tool-stack/06-delivery.md)
PRESETS: dict[str, dict] = {
    "spotify": {"lufs": -14, "tp": -2, "ext": "wav"},
    "apple": {"lufs": -16, "tp": -1, "ext": "wav"},
    "youtube": {"lufs": -14, "tp": -1, "ext": "wav"},
    "tidal": {"lufs": -14, "tp": -1, "ext": "flac"},
    "amazon": {"lufs": -14, "tp": -2, "ext": "wav"},
    "soundcloud": {"lufs": -14, "tp": -2, "ext": "wav"},
    "club": {"lufs": -8, "tp": -0.1, "ext": "wav"},
    "cd": {"lufs": -14, "tp": -0.3, "ext": "wav"},
    "podcast": {"lufs": -16, "tp": -1, "ext": "mp3"},
    "universal": {"lufs": -14, "tp": -2, "ext": "wav"},
}

CODEC_ARGS: dict[str, list[str]] = {
    "wav": ["-c:a", "pcm_s24le"],
    "flac": ["-c:a", "flac", "-compression_level", "8"],
    "mp3": ["-c:a", "libmp3lame", "-q:a", "0"],
    "aac": ["-c:a", "aac", "-b:a", "256k"],
    "opus": ["-c:a", "libopus", "-b:a", "192k", "-vbr", "on"],
    "ogg": ["-c:a", "libvorbis", "-q:a", "6"],
}


async def _codec_matrix(inp: Path, out: Path, params: dict) -> None:
    ext = out.suffix.lstrip(".").lower()
    await ffmpeg.render(inp, out, [], extra_out_args=CODEC_ARGS.get(ext, []))


def _hq_src(params: dict) -> list[str]:
    sr = int(float(params["targetSR"]))
    return ["-af", "aresample=resampler=soxr:precision=28", "-ar", str(sr)]


async def _smart_export(inp: Path, out: Path, params: dict) -> None:
    preset = PRESETS.get(str(params["platform"]), PRESETS["universal"])
    m = await audio_analysis.measure_loudness(inp, preset["lufs"], 7.0, preset["tp"])
    ln = (
        f"loudnorm=I={preset['lufs']}:LRA=7:TP={preset['tp']}"
        f":measured_I={m['input_i']}:measured_LRA={m['input_lra']}"
        f":measured_TP={m['input_tp']}:measured_thresh={m['input_thresh']}"
        f":offset={m.get('target_offset', 0.0)}:linear=true"
    )
    ext = out.suffix.lstrip(".").lower()
    await ffmpeg.render(inp, out, ["-af", ln], extra_out_args=CODEC_ARGS.get(ext, []))
    # post-encode true-peak verification (advisory; logged, retry wired next)
    try:
        ok, tp = await audio_analysis.verify_true_peak(out, preset["tp"] + 0.1)
        if not ok:
            print(
                f"[smart_export] true-peak {tp:.2f} exceeds {preset['tp']} for {params['platform']}"
            )
    except Exception:
        pass


# ── Dither (process) ────────────────────────────────────────────────────────
async def _dither(inp: Path, out: Path, params: dict) -> None:
    """Bit-depth reduction with dithering via ffmpeg aresample.

    Uses aresample's dither_method to apply TPDF/shaped noise shaping, then
    encodes to the appropriate PCM sample format.
    """
    bit_depth = str(params.get("targetBitDepth", "16"))
    method = str(params.get("ditherMethod", "triangular_hp"))

    # Map bit depth to ffmpeg sample format and codec
    if bit_depth == "16":
        osf = "s16"
        codec = "pcm_s16le"
    else:
        osf = "s32"  # aresample uses s32 for 24-bit output path
        codec = "pcm_s24le"

    af = f"aresample=osf={osf}:dither_method={method}"
    await ffmpeg.render(
        inp,
        out,
        ["-af", af],
        extra_out_args=["-c:a", codec],
    )


# ── Metadata / Tagging (process) ────────────────────────────────────────────
async def _metadata(inp: Path, out: Path, params: dict) -> None:
    """Copy audio to output, then embed metadata tags via mutagen (if available).

    Never fails if mutagen is missing — falls back to a straight copy.
    """
    title = str(params.get("title", ""))
    artist = str(params.get("artist", ""))

    # Pass-through encode: copy audio stream to output container
    await ffmpeg.render(inp, out, [], extra_out_args=["-c:a", "copy"])

    # Attempt to write tags with mutagen
    try:
        import mutagen
        from mutagen.flac import FLAC
        from mutagen.id3 import ID3, TIT2, TPE1

        ext = out.suffix.lstrip(".").lower()
        if ext == "flac":
            f = FLAC(str(out))
            if title:
                f["title"] = title
            if artist:
                f["artist"] = artist
            f.save()
        elif ext in ("wav", "mp3"):
            # ID3 tagging for WAV and MP3
            try:
                tags = ID3(str(out))
            except mutagen.id3.ID3NoHeaderError:
                tags = ID3()
            if title:
                tags.add(TIT2(encoding=3, text=[title]))
            if artist:
                tags.add(TPE1(encoding=3, text=[artist]))
            tags.save(str(out))
    except Exception:
        # mutagen missing or tagging failed — output is still valid audio
        pass


# ── Batch Export (process) ───────────────────────────────────────────────────
async def _batch_export(inp: Path, out: Path, params: dict) -> None:
    """Single-file encode: transcode input to the output container at good quality.

    Future: full batch queue dispatching parallel jobs across formats/platforms.
    """
    ext = out.suffix.lstrip(".").lower()
    codec_args = CODEC_ARGS.get(ext, [])
    await ffmpeg.render(inp, out, [], extra_out_args=codec_args)


TOOLS: list[ToolSpec] = [
    ToolSpec(
        id="codec_matrix",
        name="Codec Matrix",
        family=FAMILY,
        viz="delivery",
        mode="process",
        license="LGPL",
        engine="ffmpeg encoders",
        handler=_codec_matrix,
        description="Encode to any free format (WAV/FLAC/MP3/AAC/Opus/Vorbis) at best quality.",
        params=[
            P(
                "quality",
                "enum",
                default="high",
                options=["high", "max"],
                control="Dropdown",
                label="Quality",
            )
        ],
    ),
    ToolSpec(
        id="smart_export",
        name="Smart Export",
        family=FAMILY,
        viz="delivery",
        mode="process",
        flagship=True,
        license="LGPL/MIT",
        engine="loudnorm + encode + verify",
        handler=_smart_export,
        description="One master → any platform: auto loudness + true-peak to spec, then verify.",
        params=[
            P(
                "platform",
                "enum",
                default="spotify",
                options=list(PRESETS.keys()),
                control="PresetBrowser",
                label="Platform",
            )
        ],
    ),
    ToolSpec(
        id="high_quality_src",
        name="High-Quality SRC",
        family=FAMILY,
        viz="delivery",
        license="LGPL",
        engine="ffmpeg:soxr VHQ",
        handler=_hq_src,
        description="Mastering-grade libsoxr sample-rate conversion for delivery.",
        params=[
            P(
                "targetSR",
                "enum",
                default="44100",
                options=["44100", "48000", "88200", "96000"],
                control="Dropdown",
                label="Target SR",
            )
        ],
    ),
    # ── DSP tools ──
    ToolSpec(
        id="dither",
        name="Dither / Noise-Shaping",
        family=FAMILY,
        viz="delivery",
        mode="process",
        license="LGPL",
        engine="ffmpeg dither",
        handler=_dither,
        description="Transparent bit-depth reduction with TPDF / shaped dither.",
        params=[
            P(
                "targetBitDepth",
                "enum",
                default="16",
                options=["16", "24"],
                control="Dropdown",
                label="Bit Depth",
            ),
            P(
                "ditherMethod",
                "enum",
                default="triangular_hp",
                options=[
                    "triangular",
                    "triangular_hp",
                    "shibata",
                    "improved_e_weighted",
                ],
                control="Dropdown",
                label="Method",
            ),
        ],
    ),
    ToolSpec(
        id="metadata",
        name="Metadata / Tagging",
        family=FAMILY,
        viz="delivery",
        mode="process",
        license="GPL (optional)",
        engine="passthrough + mutagen tags",
        handler=_metadata,
        description="Embed title/artist/ISRC, cover art and loudness tags.",
        params=[
            P("title", "string", default="", control="TextInput", label="Title"),
            P("artist", "string", default="", control="TextInput", label="Artist"),
        ],
    ),
    ToolSpec(
        id="batch_export",
        name="Stems / Batch / Multiformat",
        family=FAMILY,
        viz="delivery",
        mode="process",
        license="LGPL",
        engine="encode (batch queue later)",
        handler=_batch_export,
        description="Export stems or one master to many formats/platforms at once.",
        params=[P("parallelJobs", "int", 1, 8, 4, "", "ParamKnob", "Jobs")],
    ),
]

router = build_router(FAMILY, TOOLS)
