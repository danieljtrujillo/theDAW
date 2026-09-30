"""Delivery / Export family — 6 tools.

Implemented: Codec Matrix, Smart Export (two-pass loudnorm → encode → true-peak
verify), High-Quality SRC, Dither, Metadata and Batch Export.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import weakref
from collections import deque
from pathlib import Path

from ...core.module_base import build_router
from ...lib import audio_analysis, ffmpeg
from ...lib.params import ParamSpec as P
from ...lib.params import ToolSpec
from ...lib.resampler import hq_resampler

FAMILY = "delivery"

log = logging.getLogger(__name__)

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
    "m4a": ["-c:a", "aac", "-b:a", "256k"],  # same bitrate as "aac", MP4 container
    "opus": ["-c:a", "libopus", "-b:a", "192k", "-vbr", "on"],
    "ogg": ["-c:a", "libvorbis", "-q:a", "6"],
}
# Every extension MIME (backend/core/module_base.py) accepts as an
# output_format must have an encode fallback here, or _metadata/_batch_export
# silently fall back to `-c:a copy`, which fails whenever the source codec
# doesn't already match the target container.
assert set(CODEC_ARGS) == {"wav", "flac", "mp3", "aac", "m4a", "opus", "ogg"}

# Codec Matrix at quality "max": every codec at its top setting. The lossy
# codecs take their highest bitrate or quality (MP3 320k CBR, AAC 320k, Opus
# 510k, Vorbis q10), WAV is 32-bit float so a float master keeps its overs,
# and FLAC takes its tightest compression (identical audio, smaller file).
# libopus accepts at most 256 kbps per channel, so a mono file gets 256k
# (see _opus_max_bitrate). Quality "high" is CODEC_ARGS.
CODEC_ARGS_MAX: dict[str, list[str]] = {
    "wav": ["-c:a", "pcm_f32le"],
    "flac": ["-c:a", "flac", "-compression_level", "12"],
    "mp3": ["-c:a", "libmp3lame", "-b:a", "320k"],
    "aac": ["-c:a", "aac", "-b:a", "320k"],
    "m4a": ["-c:a", "aac", "-b:a", "320k"],
    "opus": ["-c:a", "libopus", "-b:a", "510k", "-vbr", "on"],
    "ogg": ["-c:a", "libvorbis", "-q:a", "10"],
}
assert set(CODEC_ARGS_MAX) == set(CODEC_ARGS)


OPUS_MAX_BPS = 510_000
OPUS_MAX_BPS_PER_CHANNEL = 256_000


async def _opus_max_bitrate(inp: Path) -> int:
    """The highest bitrate libopus accepts for this input: 510 kbps, capped at
    256 kbps per channel. libopus rejects anything above the per-channel cap
    ("Invalid argument"), so 510k failed every mono upload. When the channel
    count cannot be probed, 256k, which every channel count accepts."""
    from backend.modules.analysis.ffprobe import probe_file

    try:
        info = await asyncio.to_thread(probe_file, inp)
        channels = int((info.get("_summary") or {}).get("channels") or 0)
    except Exception:
        log.warning("codec_matrix: could not probe %s for its channel count", inp)
        channels = 0
    if channels < 1:
        return OPUS_MAX_BPS_PER_CHANNEL
    return min(OPUS_MAX_BPS, OPUS_MAX_BPS_PER_CHANNEL * channels)


async def _codec_matrix(inp: Path, out: Path, params: dict) -> None:
    """Encode at the Quality the page asks for; the dropdown was declared and
    never read, so "max" encoded exactly like "high"."""
    ext = out.suffix.lstrip(".").lower()
    quality_max = params.get("quality", "high") == "max"
    args = list((CODEC_ARGS_MAX if quality_max else CODEC_ARGS).get(ext, []))
    if quality_max and ext == "opus":
        args[args.index("-b:a") + 1] = str(await _opus_max_bitrate(inp))
    await ffmpeg.render(inp, out, [], extra_out_args=args)


def _hq_src(params: dict) -> list[str]:
    """libsoxr at 28 bits, or swr at its matching quality when this ffmpeg
    has no libsoxr (see backend/lib/resampler.py); a hard-coded soxr failed
    the render outright on such a build."""
    sr = int(float(params["targetSR"]))
    return ["-af", f"aresample={hq_resampler(28)}", "-ar", str(sr)]


def _wave_tags(out: Path):
    """Open a WAV's ID3v2 tag chunk via ``mutagen.wave.WAVE``.

    ``mutagen.id3.ID3(path)`` on a plain ``.wav`` prepends a bare ID3v2 header
    *before* the file's own bytes: the result no longer starts with ``RIFF``,
    so stdlib ``wave`` and even ``mutagen.wave.WAVE`` itself reject it on the
    next read. ``mutagen.wave.WAVE`` instead writes/reads the ID3 data inside
    a proper RIFF ``id3 `` chunk, keeping the container valid.
    """
    from mutagen.wave import WAVE

    w = WAVE(str(out))
    if w.tags is None:
        w.add_tags()
    return w


_MP4_TRUEPEAK_ATOM = "----:com.apple.iTunes:TRUEPEAK_DBTP"


def _embed_true_peak_tag(out: Path, tp: float) -> None:
    """Embed the measured true-peak (dBTP) into the delivered file's own tags.

    ``/process`` (backend/core/module_base.py) returns only raw audio bytes plus
    a Content-Disposition header — there is no JSON side-channel back to the
    caller — so the file itself is the only place a measurement can travel.
    Mirrors ``_metadata``'s codec branching (mutagen FLAC / WAVE / ID3 / MP4 /
    Vorbis comment); never raises, matching that handler's "tagging is
    advisory" contract. Raw ``.aac`` (ADTS elementary stream) has no
    container-level tag format at all, so it is skipped with a debug log
    rather than silently doing nothing.
    """
    ext = out.suffix.lstrip(".").lower()
    value = f"{tp:.2f}"
    try:
        if ext == "flac":
            from mutagen.flac import FLAC

            f = FLAC(str(out))
            f["TRUEPEAK_DBTP"] = value
            f.save()
        elif ext == "wav":
            from mutagen.id3 import TXXX

            w = _wave_tags(out)
            w.tags.delall("TXXX:TRUEPEAK_DBTP")
            w.tags.add(TXXX(encoding=3, desc="TRUEPEAK_DBTP", text=[value]))
            w.save(str(out))
        elif ext == "mp3":
            import mutagen
            from mutagen.id3 import TXXX, ID3

            try:
                tags = ID3(str(out))
            except mutagen.id3.ID3NoHeaderError:
                tags = ID3()
            tags.delall("TXXX:TRUEPEAK_DBTP")
            tags.add(TXXX(encoding=3, desc="TRUEPEAK_DBTP", text=[value]))
            tags.save(str(out))
        elif ext == "m4a":
            from mutagen.mp4 import MP4, MP4FreeForm

            f = MP4(str(out))
            if f.tags is None:
                f.add_tags()
            f.tags[_MP4_TRUEPEAK_ATOM] = [MP4FreeForm(value.encode("utf-8"))]
            f.save()
        elif ext == "ogg":
            from mutagen.oggvorbis import OggVorbis

            f = OggVorbis(str(out))
            if f.tags is None:
                f.add_tags()
            f["TRUEPEAK_DBTP"] = value
            f.save()
        elif ext == "opus":
            from mutagen.oggopus import OggOpus

            f = OggOpus(str(out))
            if f.tags is None:
                f.add_tags()
            f["TRUEPEAK_DBTP"] = value
            f.save()
        elif ext == "aac":
            log.debug(
                "smart_export: true-peak %.2f dBTP not embedded on %s — raw "
                "AAC (ADTS) has no container-level tag format",
                tp,
                out,
            )
        else:
            log.debug(
                "smart_export: no true-peak tag embedding defined for .%s (%s)",
                ext,
                out,
            )
    except Exception:
        log.exception("smart_export: failed to embed true-peak tag on %s", out)


_MAX_TRIM_PASSES = 2


async def _smart_export(inp: Path, out: Path, params: dict) -> None:
    preset = PRESETS.get(str(params["platform"]), PRESETS["universal"])
    ceiling = preset["tp"]
    m = await audio_analysis.measure_loudness(inp, preset["lufs"], 7.0, ceiling)
    ln = (
        f"loudnorm=I={preset['lufs']}:LRA=7:TP={ceiling}"
        f":measured_I={m['input_i']}:measured_LRA={m['input_lra']}"
        f":measured_TP={m['input_tp']}:measured_thresh={m['input_thresh']}"
        f":offset={m.get('target_offset', 0.0)}:linear=true"
    )
    ext = out.suffix.lstrip(".").lower()

    # loudnorm's internal oversampled true-peak detection changes the output
    # sample rate (typically to 192 kHz) unless the encode step is told to
    # resample back down. Probe the source rate the same way
    # creative_neural/router.py's _probe_sample_rate already does, and pin
    # -ar to it so a 44.1k or 48k master doesn't silently leave at 192k.
    # probe_file() shells out to ffprobe synchronously — run it off the
    # event loop so one slow probe doesn't stall every other request.
    from backend.modules.analysis.ffprobe import probe_file

    info = await asyncio.to_thread(probe_file, inp)
    source_rate = (info.get("_summary") or {}).get("sample_rate")
    extra_out_args = list(CODEC_ARGS.get(ext, []))
    if ext == "opus":
        # libopus only accepts 48/24/16/12/8 kHz — pinning -ar to an
        # arbitrary source rate (e.g. 44.1k) makes the encoder reject the
        # stream outright. Let it run at its native 48k instead.
        extra_out_args += ["-ar", "48000"]
    elif source_rate:
        extra_out_args += ["-ar", str(source_rate)]

    await ffmpeg.render(inp, out, ["-af", ln], extra_out_args=extra_out_args)

    # Post-encode true-peak verification + corrective trim. Resampling
    # loudnorm's internal (often 192k) oversampled output back down to the
    # delivery rate adds inter-sample overshoot the pre-encode measurement
    # never saw — commonly ~0.1 dB, enough to put a lossless delivery file
    # over its platform ceiling even though loudnorm itself targeted it
    # correctly. Re-measure the ENCODED file and, if it's over the ceiling,
    # apply a corrective `volume` trim and re-encode; at most twice.
    tp: float | None = None
    trimmed_any = False
    for attempt in range(_MAX_TRIM_PASSES):
        try:
            _, tp = await audio_analysis.verify_true_peak(out, ceiling)
        except Exception:
            log.exception(
                "smart_export: true-peak verification failed for platform %s",
                params["platform"],
            )
            return
        if tp <= ceiling:
            break
        trim_db = ceiling - tp - 0.05
        trimmed_path = out.with_name(f"{out.stem}.trim{attempt}{out.suffix}")
        await ffmpeg.render(
            out,
            trimmed_path,
            ["-af", f"volume={trim_db:.3f}dB"],
            extra_out_args=extra_out_args,
        )
        trimmed_path.replace(out)
        trimmed_any = True
        log.info(
            "smart_export: true-peak %.2f dBTP over %.2f dBTP ceiling for "
            "platform %s — applied %.2f dB corrective trim (pass %d/%d)",
            tp,
            ceiling,
            params["platform"],
            trim_db,
            attempt + 1,
            _MAX_TRIM_PASSES,
        )

    # Final measurement of the file as actually delivered. When the loop
    # never trimmed, `tp` from the loop's own (single) measurement is
    # already the true state of `out` — re-measuring again would be a full
    # extra loudness analysis on every in-spec export, which is the common
    # case. Only re-verify when a trim pass actually changed the file.
    if trimmed_any:
        try:
            _, tp = await audio_analysis.verify_true_peak(out, ceiling)
        except Exception:
            log.exception(
                "smart_export: true-peak verification failed for platform %s",
                params["platform"],
            )
            return
    if tp <= ceiling:
        log.info(
            "smart_export: measured true-peak %.2f dBTP (ceiling %.2f) for platform %s",
            tp,
            ceiling,
            params["platform"],
        )
    else:
        log.warning(
            "smart_export: true-peak %.2f dBTP still exceeds %.2f dBTP ceiling "
            "for platform %s after corrective trim",
            tp,
            ceiling,
            params["platform"],
        )
    _embed_true_peak_tag(out, tp)


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


# A source codec is only safe to stream-copy into a given output container
# when it's already the codec that container needs — copying raw PCM into a
# FLAC/MP3 bitstream (or a compressed stream into another codec's container)
# fails in ffmpeg. "wav" is handled separately below via _is_wav_copy_safe.
_METADATA_COPY_SAFE_CODEC: dict[str, set[str]] = {
    "flac": {"flac"},
    "mp3": {"mp3"},
    "aac": {"aac"},
    "m4a": {"aac"},
    "ogg": {"vorbis"},
    "opus": {"opus"},
}


def _is_wav_copy_safe_codec(codec: str) -> bool:
    """WAV (RIFF) only supports little-endian PCM. An AIFF source reports a
    big-endian codec (``pcm_s16be``/``pcm_s24be``/``pcm_s32be``) — copying
    that straight into a WAV container is not safe and must be encoded
    instead; ``pcm_*le`` and the endian-less ``pcm_u8`` are fine."""
    return codec.startswith("pcm_") and not codec.endswith("be")


# ── Metadata / Tagging (process) ────────────────────────────────────────────
async def _metadata(inp: Path, out: Path, params: dict) -> None:
    """Copy audio to output when the source codec already fits the target
    container; otherwise encode with the codec the rest of this module uses
    for that format. Then embed metadata tags via mutagen (if available).

    ``-c:a copy`` used to run unconditionally: a WAV (pcm_s16le) upload with
    output_format=flac/mp3/m4a/ogg/opus made ffmpeg fail outright — you
    cannot copy raw PCM straight into a FLAC/MP3/AAC/Vorbis/Opus bitstream —
    which module_base.py's generic ``except ffmpeg.FFmpegError`` turned into
    a bare 500. Encoding is skipped only when the source codec already
    matches what the target container needs (and, for WAV specifically, is
    little-endian PCM — an AIFF's big-endian PCM is not a valid WAV payload).

    Never fails if mutagen is missing — falls back to whatever the render
    step produced.
    """
    title = str(params.get("title", ""))
    artist = str(params.get("artist", ""))
    ext = out.suffix.lstrip(".").lower()

    # probe_file() shells out to ffprobe synchronously — run it off the
    # event loop so one slow probe doesn't stall every other request.
    from backend.modules.analysis.ffprobe import probe_file

    info = await asyncio.to_thread(probe_file, inp)
    source_codec = str((info.get("_summary") or {}).get("codec") or "")
    copy_safe = (ext == "wav" and _is_wav_copy_safe_codec(source_codec)) or (
        source_codec in _METADATA_COPY_SAFE_CODEC.get(ext, set())
    )
    encode_args = (
        ["-c:a", "copy"] if copy_safe else CODEC_ARGS.get(ext, ["-c:a", "copy"])
    )
    await ffmpeg.render(inp, out, [], extra_out_args=encode_args)

    # Attempt to write tags with mutagen
    try:
        import mutagen
        from mutagen.flac import FLAC
        from mutagen.id3 import ID3, TIT2, TPE1

        if ext == "flac":
            f = FLAC(str(out))
            if title:
                f["title"] = title
            if artist:
                f["artist"] = artist
            f.save()
        elif ext == "wav":
            # WAV needs mutagen.wave.WAVE, not a bare ID3(path) — see
            # _wave_tags' docstring for why ID3(path) corrupts the RIFF header.
            w = _wave_tags(out)
            if title:
                w.tags.add(TIT2(encoding=3, text=[title]))
            if artist:
                w.tags.add(TPE1(encoding=3, text=[artist]))
            w.save(str(out))
        elif ext == "mp3":
            try:
                tags = ID3(str(out))
            except mutagen.id3.ID3NoHeaderError:
                tags = ID3()
            if title:
                tags.add(TIT2(encoding=3, text=[title]))
            if artist:
                tags.add(TPE1(encoding=3, text=[artist]))
            tags.save(str(out))
        elif ext == "m4a":
            from mutagen.mp4 import MP4

            f = MP4(str(out))
            if f.tags is None:
                f.add_tags()
            if title:
                f.tags["\xa9nam"] = [title]
            if artist:
                f.tags["\xa9ART"] = [artist]
            f.save()
        elif ext == "ogg":
            from mutagen.oggvorbis import OggVorbis

            f = OggVorbis(str(out))
            if f.tags is None:
                f.add_tags()
            if title:
                f["title"] = title
            if artist:
                f["artist"] = artist
            f.save()
        elif ext == "opus":
            from mutagen.oggopus import OggOpus

            f = OggOpus(str(out))
            if f.tags is None:
                f.add_tags()
            if title:
                f["title"] = title
            if artist:
                f["artist"] = artist
            f.save()
    except Exception:
        # mutagen missing or tagging failed — output is still valid audio
        pass


# Batch Export's Jobs knob: how many Batch Export renders may run at once,
# server-wide, the one being asked for included. /process (module_base.py)
# returns exactly one file per request, so a batch is a run of requests (one
# per stem, format or platform) and Jobs is how many of them encode side by
# side. Every running render's Jobs value holds for as long as it runs: a
# render that asked for Jobs=1 runs alone, even when later requests ask for
# more. The knob's own range (1-8) is the server-wide ceiling: no request can
# raise concurrency past 8, whatever it sends.
BATCH_JOBS_MAX = 8


def _affinity_cpus() -> int | None:
    """How many CPUs this process's affinity mask allows, from psutil (a base
    dependency), which reads it on Windows (GetProcessAffinityMask), Linux and
    the BSDs. None where psutil cannot read it: macOS has no affinity call, and
    Windows reports an empty mask for a process whose threads span processor
    groups."""
    try:
        import psutil
    except ImportError:
        return None
    try:
        read = getattr(psutil.Process(), "cpu_affinity", None)
        if read is None:
            return None
        count = len(read())
    except (OSError, psutil.Error) as e:
        log.debug("delivery: CPU affinity unreadable: %s", e)
        return None
    return count or None


def _usable_cpus() -> int | None:
    """The logical CPUs this process may run on, or None when unknown.

    The smallest of the counts the platform offers: the affinity mask
    (:func:`_affinity_cpus`), ``os.process_cpu_count`` (Python 3.13+, which also
    honours ``PYTHON_CPU_COUNT``), ``os.sched_getaffinity`` where it exists,
    and the machine's total. Python 3.12 on Windows has neither os function,
    so there the mask is read through psutil."""
    counts: list[int] = []
    affinity = _affinity_cpus()
    if affinity:
        counts.append(affinity)
    counter = getattr(os, "process_cpu_count", None)
    if counter is not None and (n := counter()):
        counts.append(n)
    sched = getattr(os, "sched_getaffinity", None)
    if sched is not None and (n := len(sched(0))):
        counts.append(n)
    if not counts and (n := os.cpu_count()):
        counts.append(n)
    return min(counts) if counts else None


def default_batch_jobs(cpus: int | None) -> int:
    """The Jobs knob's default for a machine with ``cpus`` logical CPUs: half
    of them, at least 1, at most the knob's ceiling. Each render is one ffmpeg
    encode; half the logical CPUs is one per physical core on the usual
    two-threads-per-core machine, and leaves the rest to playback and the UI.
    An unknown count gets 1, the one value that is safe everywhere."""
    if not cpus or cpus < 1:
        return 1
    return max(1, min(BATCH_JOBS_MAX, cpus // 2))


BATCH_JOBS_DEFAULT = default_batch_jobs(_usable_cpus())


class _ExportJobGate:
    """First-come admission for Batch Export renders on one event loop.

    A request waits until it is the oldest one waiting and fewer renders are
    running than both its own Jobs value and the lowest Jobs value among the
    renders already running, so no running render ever has more company than
    it asked for. A waiter that is cancelled (client gone) leaves the queue,
    so it never blocks the requests behind it.
    """

    def __init__(self) -> None:
        # the Jobs value of each render running now, one entry per render
        self._limits: list[int] = []
        self._queue: deque[object] = deque()
        self._cond = asyncio.Condition()

    @property
    def running(self) -> int:
        return len(self._limits)

    def _admits(self, jobs: int) -> bool:
        return len(self._limits) < min([jobs, *self._limits])

    @contextlib.asynccontextmanager
    async def slot(self, jobs: int):
        ticket = object()
        async with self._cond:
            self._queue.append(ticket)
            try:
                await self._cond.wait_for(
                    lambda: self._queue[0] is ticket and self._admits(jobs)
                )
            except BaseException:
                self._queue.remove(ticket)
                self._cond.notify_all()
                raise
            self._queue.popleft()
            self._limits.append(jobs)
            # the next waiter may fit too
            self._cond.notify_all()
        try:
            yield
        finally:
            async with self._cond:
                self._limits.remove(jobs)
                self._cond.notify_all()


# One gate per running event loop. asyncio's Condition (like a Semaphore)
# binds its wait queue to whichever loop first awaits it. FastAPI's
# TestClient (and, more importantly, every real request-serving worker loop)
# can run more than one event loop over the process lifetime — a second loop
# awaiting the same instance raises "got Future <Future pending> attached to
# a different loop", which surfaced as a bare 500. The WeakKeyDictionary drops
# a finished loop's entry automatically.
_BATCH_EXPORT_GATES: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, _ExportJobGate]" = weakref.WeakKeyDictionary()


def _batch_gate() -> _ExportJobGate:
    loop = asyncio.get_running_loop()
    gate = _BATCH_EXPORT_GATES.get(loop)
    if gate is None:
        gate = _ExportJobGate()
        _BATCH_EXPORT_GATES[loop] = gate
    return gate


# ── Batch Export (process) ───────────────────────────────────────────────────
async def _batch_export(inp: Path, out: Path, params: dict) -> None:
    """Single-file encode, admitted once fewer than parallelJobs Batch Export
    renders are running (see ``_ExportJobGate``)."""
    jobs = int(params.get("parallelJobs", BATCH_JOBS_DEFAULT))
    jobs = max(1, min(BATCH_JOBS_MAX, jobs))
    ext = out.suffix.lstrip(".").lower()
    codec_args = CODEC_ARGS.get(ext, [])
    async with _batch_gate().slot(jobs):
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
        engine="ffmpeg:soxr VHQ (swr HQ without libsoxr)",
        prefers=("soxr",),
        handler=_hq_src,
        description=(
            "Mastering-grade libsoxr sample-rate conversion for delivery "
            "(ffmpeg's swr at matching quality when ffmpeg lacks libsoxr)."
        ),
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
        name="Batch Export (single format)",
        family=FAMILY,
        viz="delivery",
        mode="process",
        license="LGPL",
        engine="ffmpeg encoders",
        handler=_batch_export,
        description=(
            "Encode to the requested output format. Jobs caps how many Batch "
            "Export renders run at once, this one included; the rest wait "
            "their turn."
        ),
        params=[
            P(
                "parallelJobs",
                "int",
                1,
                BATCH_JOBS_MAX,
                BATCH_JOBS_DEFAULT,
                "",
                "ParamKnob",
                "Jobs",
                help="The most Batch Export renders that may run while this one runs, this one included.",
            )
        ],
    ),
]

router = build_router(FAMILY, TOOLS)
