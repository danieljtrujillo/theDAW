"""What a file's samples actually are, and how to write them back that way.

theDAW reads 32-bit float audio as a first-class intake format — every decoder
in the app is float-native and none of them clip. Both serialization libraries
throw that away by default, though: ``soundfile.write`` with no ``subtype=``
writes PCM_16 for WAV no matter what array it is handed (and libsndfile
hard-clips anything outside [-1, 1] on the way down), and ffmpeg with a ``.wav``
output and no ``-c:a`` writes pcm_s16le for the same reason. So a tool that only
meant to EQ a file also requantized it, and a true peak above 0 dBFS was gone
before the user ever heard it.

This is the one place that knows a source's PCM depth, and the one place that
turns that into the format-specific answers the rest of the backend needs: a
libsndfile subtype, and an ffmpeg codec flag. There are two ffmpeg mappers
rather than one, and they disagree on purpose — ``ffmpeg_pcm_args`` preserves
whatever came in, while ``browser_pcm_args`` caps at 32-bit float because
Chromium has no pcm_f64le decoder and a 64-bit file handed to it verbatim
simply does not play.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class PcmDepth:
    """A sample format: how many bits, and whether they are float.

    ``bits == 0`` means we could not tell — a lossy codec, or a container
    nothing here can open. Every write helper falls back to 16-bit int for
    that case, which is what libsndfile and ffmpeg would have done anyway, so
    an unidentified source behaves exactly as it did before this module.
    """

    bits: int
    is_float: bool

    @property
    def known(self) -> bool:
        return self.bits > 0

    @property
    def label(self) -> str:
        if not self.known:
            return "unknown"
        return f"{self.bits}-bit float" if self.is_float else f"{self.bits}-bit"


UNKNOWN_DEPTH = PcmDepth(bits=0, is_float=False)

# libsndfile subtype → depth. Deliberately partial: subtypes that carry no PCM
# word length at all (MPEG_LAYER_III, VORBIS, ULAW, the ADPCM family) are absent
# so they resolve to UNKNOWN_DEPTH rather than being assigned a made-up 16.
_SUBTYPE_DEPTH: dict[str, PcmDepth] = {
    "PCM_S8": PcmDepth(8, False),
    "PCM_U8": PcmDepth(8, False),
    "PCM_16": PcmDepth(16, False),
    "PCM_24": PcmDepth(24, False),
    "PCM_32": PcmDepth(32, False),
    "FLOAT": PcmDepth(32, True),
    "DOUBLE": PcmDepth(64, True),
    "ALAC_16": PcmDepth(16, False),
    "ALAC_20": PcmDepth(20, False),
    "ALAC_24": PcmDepth(24, False),
    "ALAC_32": PcmDepth(32, False),
}

# Extensions whose muxer takes a raw little-endian PCM codec. Everything else
# (FLAC, OGG, MP3, M4A, CAF, AIFF) picks its own encoder and would reject one.
_LE_PCM_EXTS = {"wav", "wave", "w64", "rf64", "bwf"}


def probe_depth(path: Path | str) -> PcmDepth:
    """Read a file's sample format. Never raises — UNKNOWN_DEPTH on any failure.

    soundfile answers for everything libsndfile can open, which is every PCM
    container theDAW writes. ffprobe is the fallback for the containers it
    cannot (and it sniffs content, so it still answers for an mp3 that a
    caller happened to name ``input.wav``).
    """
    p = Path(path)
    try:
        import soundfile as sf

        return _SUBTYPE_DEPTH.get(sf.info(str(p)).subtype or "", UNKNOWN_DEPTH)
    except Exception:
        return _probe_depth_ffprobe(p)


def _probe_depth_ffprobe(path: Path) -> PcmDepth:
    try:
        from backend.modules.analysis.ffprobe import probe_file

        summary = (probe_file(path) or {}).get("_summary") or {}
        bits = int(summary.get("bit_depth") or 0)
    except Exception:
        return UNKNOWN_DEPTH
    if bits <= 0:
        return UNKNOWN_DEPTH
    return PcmDepth(bits=bits, is_float=bool(summary.get("bit_depth_is_float")))


def sf_subtype(depth: PcmDepth, out_format: str = "WAV") -> str | None:
    """The libsndfile subtype that carries ``depth`` in ``out_format``.

    ``None`` means the container has no PCM subtype to choose (OGG is Vorbis or
    Opus and nothing else) — hand it straight to ``sf.write`` as ``subtype=None``
    and let soundfile use the container default. Formats that cannot carry the
    source's format step down to the nearest one that can: FLAC has no float
    subtype, so a float source lands there as PCM_24 rather than raising.

    Depths at or under 16 bits resolve to PCM_16. Widening 8-bit to 16-bit loses
    nothing and keeps the signed/unsigned question out of every call site.
    """
    import soundfile as sf

    fmt = _sf_format_name(out_format)
    for candidate in _subtype_candidates(depth):
        try:
            if sf.check_format(fmt, candidate):
                return candidate
        except Exception:
            break
    return None


def _sf_format_name(out_format: str) -> str:
    name = (out_format or "WAV").strip().lstrip(".").upper()
    return {"AIF": "AIFF", "AIFC": "AIFF", "WAVE": "WAV"}.get(name, name)


def _subtype_candidates(depth: PcmDepth) -> list[str]:
    if not depth.known:
        return ["PCM_16"]
    if depth.is_float:
        head = ["DOUBLE", "FLOAT"] if depth.bits >= 64 else ["FLOAT"]
        return [*head, "PCM_32", "PCM_24", "PCM_16"]
    if depth.bits >= 32:
        return ["PCM_32", "PCM_24", "PCM_16"]
    if depth.bits > 16:
        return ["PCM_24", "PCM_16"]
    return ["PCM_16"]


def ffmpeg_pcm_args(depth: PcmDepth, ext: str) -> list[str]:
    """``-c:a`` flags that keep a render at the source's depth.

    Empty for every container that is not raw little-endian PCM — ffmpeg picks
    its own encoder there and a PCM codec name would just fail the mux — and
    empty for an unidentified source, which leaves ffmpeg's own default in
    place exactly as before.
    """
    if (ext or "").strip().lstrip(".").lower() not in _LE_PCM_EXTS:
        return []
    if not depth.known:
        return []
    if depth.is_float:
        return ["-c:a", "pcm_f64le" if depth.bits >= 64 else "pcm_f32le"]
    if depth.bits >= 32:
        return ["-c:a", "pcm_s32le"]
    if depth.bits > 16:
        return ["-c:a", "pcm_s24le"]
    return ["-c:a", "pcm_s16le"]


def widest(a: PcmDepth, b: PcmDepth) -> PcmDepth:
    """Whichever of the two carries more signal. Unknown always loses."""
    return a if _rank(a) >= _rank(b) else b


def _rank(depth: PcmDepth) -> int:
    if not depth.known:
        return -1
    # Float edges out an int of the same width: same word length, but the
    # exponent means it also carries peaks above 0 dBFS.
    return depth.bits * 2 + (1 if depth.is_float else 0)


def write_like_source(
    output_path: Path | str,
    data,
    samplerate: int,
    source_path: Path | str,
    *,
    min_depth: PcmDepth | None = None,
) -> str | None:
    """Write ``data`` back out at ``source_path``'s depth.

    This is the shape almost every process-mode tool wants: read a file, do
    something to the samples, write the result. Left to itself ``sf.write``
    would answer PCM_16 for all of them, so a float source came back
    requantized from a tool that was only asked to filter it.

    Int subtypes still get the safety clip — libsndfile would clamp on the way
    down anyway, and doing it here keeps the intent visible. Float subtypes do
    not: peaks above 0 dBFS surviving is the entire reason the source was float.

    ``min_depth`` raises the floor for tools whose output is synthesized rather
    than filtered, where the source depth is a lower bound rather than a target.
    Returns the subtype actually used.
    """
    import numpy as np
    import soundfile as sf

    out = Path(output_path)
    depth = probe_depth(source_path)
    if min_depth is not None:
        depth = widest(depth, min_depth)
    subtype = sf_subtype(depth, out.suffix or "WAV")
    if subtype not in ("FLOAT", "DOUBLE"):
        data = np.clip(data, -1.0, 1.0)
    sf.write(str(out), data, samplerate, subtype=subtype)
    return subtype


def browser_can_decode(depth: PcmDepth) -> bool:
    """Whether Chromium reads a file at this depth as-is.

    Its WAV decoder set covers 8/16/24-bit int and 32-bit float. 32-bit int and
    64-bit float are not in it, so a file at either depth has to be transcoded
    even when its extension says the browser could have had it directly.
    """
    if not depth.known:
        return True
    if depth.is_float:
        return depth.bits <= 32
    return depth.bits <= 24


def browser_pcm_args(depth: PcmDepth) -> list[str]:
    """``-c:a`` for a WAV the browser has to decode.

    Same intent as ``ffmpeg_pcm_args`` but capped: anything wider than 24-bit
    int becomes 32-bit float, which is the widest format Chromium reads and is
    lossless for every real converter's output. An unidentified source stays at
    pcm_s16le — the value this path hard-coded before.
    """
    if not depth.known:
        return ["-c:a", "pcm_s16le"]
    if depth.is_float or depth.bits >= 32:
        return ["-c:a", "pcm_f32le"]
    if depth.bits > 16:
        return ["-c:a", "pcm_s24le"]
    return ["-c:a", "pcm_s16le"]
