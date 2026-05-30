"""Transcode a browser-recorded VJ take into a deliverable file.

The VJ panel records its output canvas + audio to a single ``.webm``
(VP9 video + Opus audio) in the browser, then POSTs that blob to
``/api/vj/export``. ffmpeg re-encodes it into the user-chosen codec /
container — with the recorded audio muxed straight in — and writes the
result under ``<export_root>/<subfolder>/``.

Codec map (settled with the user):

    h264    -> .mp4   libx264   + AAC               universal delivery
    h265    -> .mp4   libx265   + AAC (hvc1 tag)    smaller, modern
    prores  -> .mov   prores_ks + PCM s16le         editing-grade
    pngseq  -> .zip   numbered PNG frames + a WAV    frame-accurate source

The recording canvas is already sized to the selected resolution
(720p/1080p/4K) in the browser, so the source is authoritative and we do
NOT rescale here — re-scaling would only soften a clean capture.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

# Resolved against the project root for a relative ``export_root``.
_PROJECT_ROOT = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class CodecSpec:
    ext: str
    args: list[str]


# Per-codec ffmpeg recipe. ``ext`` is the output container; ``args`` are
# the encode flags inserted between input and output. ``pngseq`` is
# handled specially (frame dump + zip) and is absent here.
_VIDEO_CODECS: dict[str, CodecSpec] = {
    "h264": CodecSpec(
        ext="mp4",
        args=[
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "320k",
            "-movflags",
            "+faststart",
        ],
    ),
    "h265": CodecSpec(
        ext="mp4",
        args=[
            "-c:v",
            "libx265",
            "-preset",
            "medium",
            "-crf",
            "20",
            "-tag:v",
            "hvc1",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "320k",
            "-movflags",
            "+faststart",
        ],
    ),
    "prores": CodecSpec(
        ext="mov",
        # profile 3 = ProRes 422 HQ; 10-bit 4:2:2; PCM audio is the
        # editing-grade norm inside a .mov.
        args=[
            "-c:v",
            "prores_ks",
            "-profile:v",
            "3",
            "-pix_fmt",
            "yuv422p10le",
            "-c:a",
            "pcm_s16le",
        ],
    ),
}

SUPPORTED_CODECS = (*_VIDEO_CODECS.keys(), "pngseq")


def resolve_export_dir(export_root: str, subfolder: str) -> Path:
    """Resolve ``<export_root>/<subfolder>`` into an absolute directory,
    creating it. A relative ``export_root`` resolves against the project
    root. ``subfolder`` is sanitised so it can never escape the root.
    """
    root = Path(export_root.strip() or "exports/vj").expanduser()
    if not root.is_absolute():
        root = _PROJECT_ROOT / root
    root = root.resolve()

    safe = _sanitize_subfolder(subfolder)
    target = (root / safe).resolve() if safe else root
    # Defence in depth: never let a crafted subfolder climb above root.
    if root not in target.parents and target != root:
        target = root
    target.mkdir(parents=True, exist_ok=True)
    return target


def _sanitize_subfolder(subfolder: str) -> str:
    """Strip a user-supplied subfolder down to a safe relative path:
    no drive letters, no leading slashes, no ``..`` segments."""
    raw = (subfolder or "").strip().replace("\\", "/")
    parts = [p for p in raw.split("/") if p and p not in (".", "..")]
    return "/".join(parts)


def transcode(src_webm: Path, codec: str, out_dir: Path) -> Path:
    """Transcode ``src_webm`` into ``codec`` inside ``out_dir`` and return
    the written path. Raises RuntimeError on unknown codec / ffmpeg error.
    """
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg is not installed or not on PATH.")

    codec = codec.lower().strip()
    stem = f"LUMINA_{time.strftime('%Y%m%d_%H%M%S')}"

    if codec == "pngseq":
        return _export_png_sequence(src_webm, out_dir, stem)

    spec = _VIDEO_CODECS.get(codec)
    if spec is None:
        raise RuntimeError(
            f"Unknown codec {codec!r}. Expected one of {SUPPORTED_CODECS}."
        )

    out_path = _unique_path(out_dir / f"{stem}.{spec.ext}")
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-y",
        "-i",
        str(src_webm),
        *spec.args,
        str(out_path),
    ]
    _run_ffmpeg(cmd)
    return out_path


def _export_png_sequence(src_webm: Path, out_dir: Path, stem: str) -> Path:
    """Dump every frame as a PNG plus a WAV of the audio, then bundle
    both into a single ``<stem>.zip`` so the deliverable is one file."""
    out_zip = _unique_path(out_dir / f"{stem}.zip")
    with tempfile.TemporaryDirectory(prefix="vj_pngseq_") as tmp:
        tmp_dir = Path(tmp)
        frame_pat = str(tmp_dir / "frame_%05d.png")
        _run_ffmpeg(
            [
                "ffmpeg",
                "-hide_banner",
                "-y",
                "-i",
                str(src_webm),
                "-c:v",
                "png",
                frame_pat,
            ]
        )
        # Audio as a sidecar WAV (PNG can't carry audio). Tolerate a take
        # with no audio track — ffmpeg returns non-zero, which we ignore.
        wav_path = tmp_dir / "audio.wav"
        try:
            _run_ffmpeg(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-y",
                    "-i",
                    str(src_webm),
                    "-vn",
                    "-c:a",
                    "pcm_s16le",
                    str(wav_path),
                ]
            )
        except RuntimeError:
            log.info("vj.export: pngseq take had no audio track; skipping WAV")

        with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in sorted(tmp_dir.glob("frame_*.png")):
                zf.write(f, f.name)
            if wav_path.is_file():
                zf.write(wav_path, wav_path.name)
    return out_zip


def _unique_path(path: Path) -> Path:
    """Avoid clobbering an existing file by suffixing _1, _2, … ."""
    if not path.exists():
        return path
    i = 1
    while True:
        candidate = path.with_name(f"{path.stem}_{i}{path.suffix}")
        if not candidate.exists():
            return candidate
        i += 1


def _run_ffmpeg(cmd: list[str]) -> None:
    log.info("vj.export: %s", " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()[-8:]
        raise RuntimeError("ffmpeg failed:\n" + "\n".join(tail))
