"""Async FFmpeg subprocess helpers.

Centralizes the run-ffmpeg-to-a-temp-file pattern used across every filter-based
tool, matching the conventions in ``backend/modules/effects/router.py`` (stream
upload to disk, run with a timeout, read output back, clean up).
"""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path


class FFmpegError(RuntimeError):
    """Raised when ffmpeg exits non-zero. Carries the tail of stderr."""

    def __init__(self, returncode: int, stderr: str):
        self.returncode = returncode
        self.stderr = stderr
        super().__init__(f"ffmpeg exited {returncode}: {stderr[-500:]}")


async def run(cmd: list[str], timeout: float = 600.0) -> str:
    """Run an ffmpeg/ffprobe command. Returns stderr text. Raises on failure."""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise FFmpegError(-1, f"timed out after {timeout}s")
    text = (stderr or b"").decode("utf-8", errors="replace")
    if proc.returncode != 0:
        raise FFmpegError(proc.returncode or -1, text)
    return text


async def render(
    input_path: Path,
    output_path: Path,
    filter_args: list[str],
    extra_out_args: list[str] | None = None,
    timeout: float = 600.0,
) -> Path:
    """Render input → output applying ``filter_args`` (e.g. ['-af', '...'] or
    ['-filter_complex', '...', '-map', '[out]']). Returns output_path."""
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(input_path),
        *filter_args,
        *(extra_out_args or []),
        str(output_path),
    ]
    await run(cmd, timeout=timeout)
    if not output_path.exists() or output_path.stat().st_size == 0:
        raise FFmpegError(-1, "ffmpeg produced no output")
    return output_path


async def render_multi(
    inputs: list[Path],
    output_path: Path,
    filter_complex: str,
    out_map: str | None = None,
    extra_out_args: list[str] | None = None,
    timeout: float = 600.0,
) -> Path:
    """Render with multiple inputs through a -filter_complex graph."""
    cmd = ["ffmpeg", "-y"]
    for p in inputs:
        cmd += ["-i", str(p)]
    cmd += ["-filter_complex", filter_complex]
    if out_map:
        cmd += ["-map", out_map]
    cmd += [*(extra_out_args or []), str(output_path)]
    await run(cmd, timeout=timeout)
    if not output_path.exists() or output_path.stat().st_size == 0:
        raise FFmpegError(-1, "ffmpeg produced no output")
    return output_path


async def stream_upload_to(path: Path, upload, chunk: int = 1 << 20) -> Path:
    """Stream a Starlette UploadFile to disk in chunks (no full-file copy)."""
    with open(path, "wb") as f:
        while data := await upload.read(chunk):
            f.write(data)
    return path


def cleanup(tmp_dir: str | Path) -> None:
    shutil.rmtree(str(tmp_dir), ignore_errors=True)
