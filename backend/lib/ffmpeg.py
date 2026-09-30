"""Async FFmpeg subprocess helpers.

Centralizes the run-ffmpeg-to-a-temp-file pattern used across every filter-based
tool, matching the conventions in ``backend/modules/effects/router.py`` (stream
upload to disk, run with a timeout, read output back, clean up).
"""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

from backend.lib import ffmpeg_tools
from backend.lib.launch_token import child_env


class FFmpegError(RuntimeError):
    """Raised when ffmpeg exits non-zero. Carries the tail of stderr."""

    def __init__(self, returncode: int, stderr: str):
        self.returncode = returncode
        self.stderr = stderr
        super().__init__(f"ffmpeg exited {returncode}: {stderr[-500:]}")


class FFmpegCapabilityError(FFmpegError):
    """Raised before running a command the chosen FFmpeg build cannot do (a
    soxr filter on a build without libsoxr). The message names the problem and
    the FFmpeg in use, and is meant to reach the user whole."""

    def __init__(self, message: str):
        self.returncode = -1
        self.stderr = message
        RuntimeError.__init__(self, message)


async def _prepare(cmd: list[str]) -> list[str]:
    """Point a bare ``ffmpeg``/``ffprobe`` argv[0] at the resolved build, and
    refuse a soxr filter the build cannot run."""
    if not cmd:
        return cmd
    resolution = await ffmpeg_tools.aresolve()
    build = resolution.build
    head = cmd[0]
    if head == "ffmpeg" and build is not None:
        cmd = [build.ffmpeg, *cmd[1:]]
    elif head == "ffprobe" and resolution.ffprobe:
        cmd = [resolution.ffprobe, *cmd[1:]]
    problem = ffmpeg_tools.soxr_problem(cmd, resolution)
    if problem:
        raise FFmpegCapabilityError(problem)
    return cmd


async def run(cmd: list[str], timeout: float = 600.0) -> str:
    """Run an ffmpeg/ffprobe command. Returns stderr text. Raises on failure.

    A bare ``"ffmpeg"`` or ``"ffprobe"`` in argv[0] runs the build
    ``backend.lib.ffmpeg_tools`` chose. A command that asks for the soxr
    resampler raises ``FFmpegCapabilityError`` when that build has no libsoxr."""
    cmd = await _prepare(cmd)
    # stdin=DEVNULL: the backend does not always own a real console (Pinokio's
    # ConPTY shells, service wrappers). An inherited stdin handle makes
    # ffmpeg's console input reader block forever, which presents as a timeout
    # on a job that takes under a second in a terminal.
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
        env=child_env(),
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
        await ffmpeg_tools.ffmpeg_exe_async(),
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
    cmd = [await ffmpeg_tools.ffmpeg_exe_async(), "-y"]
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
