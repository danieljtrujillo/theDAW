"""Which FFmpeg build the backend runs, chosen once per process.

Several FFmpeg builds can live on one machine, and the first ``ffmpeg`` on PATH
is often not the one theDAW needs: gyan.dev's "essentials" build, which other
apps ship and put on PATH, has no libsoxr, so every filter that asks for
``aresample=...:resampler=soxr`` (Classical Upsample, Super-Res, High-Quality
SRC) fails with "Could not open encoder before EOF". This module lists every
candidate, probes each with a real soxr resample, and keeps the best one:

1. ``THEDAW_FFMPEG`` (a path to an ffmpeg executable or to its folder), when set.
2. Every ``ffmpeg`` on PATH, in PATH order. The desktop app puts its bundled
   ``resources/tools`` folder first on PATH, so its copy is probed here.
3. The winget install of ``Gyan.FFmpeg`` (the user-scope and machine-scope
   ``WinGet\\Links`` folders and ``WinGet\\Packages\\Gyan.FFmpeg*``), then the
   scoop and Chocolatey shims, on Windows; Homebrew and ``/usr`` on macOS and
   Linux.

The first candidate that has both libsoxr and librubberband wins; failing that
the first with libsoxr; failing that the first that runs at all. ffprobe comes
from the chosen build's own folder, so the two binaries always match.

A command that asks for soxr on a build without libsoxr fails before it runs
with ``soxr_missing_message`` (see ``backend.lib.ffmpeg.run``), which names the
FFmpeg in use. High-Quality SRC, Classical Upsample and Super-Res never send
one: ``backend.lib.resampler`` gives them swr at matching quality on such a
build, and their manifest carries the same message as a notice.

The result is cached for the process. Nothing is cached while no candidate
runs, so an FFmpeg installed while the backend is up is found on the next call.
"""

from __future__ import annotations

import asyncio
import glob
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Optional

from backend.lib.launch_token import child_env

log = logging.getLogger(__name__)

#: Environment variable naming an ffmpeg executable (or its folder) to try first.
ENV_VAR = "THEDAW_FFMPEG"

#: The substring every soxr filter in the backend carries.
SOXR_MARKER = "resampler=soxr"

#: A 50 ms sine resampled through soxr into the null muxer. A build without
#: libsoxr exits non-zero with "Requested resampling engine is unavailable".
SOXR_PROBE_ARGS = (
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=d=0.05",
    "-af",
    "aresample=48000:resampler=soxr",
    "-f",
    "null",
    "-",
)

_PROBE_TIMEOUT_SEC = 20.0


@dataclass(frozen=True)
class FFmpegBuild:
    """One probed ffmpeg executable and what it can do."""

    ffmpeg: str
    version: str
    soxr: bool
    rubberband: bool
    #: ffprobe from the same folder as ``ffmpeg``, or None when the build has none.
    ffprobe: Optional[str] = None


@dataclass
class Resolution:
    """The chosen build plus every candidate that was looked at."""

    build: Optional[FFmpegBuild]
    #: Each candidate path and whether it had libsoxr (None = it did not run).
    checked: list[tuple[str, Optional[bool]]] = field(default_factory=list)
    #: The ffprobe the backend runs. Matches the build unless the build has no
    #: ffprobe of its own, in which case it is the first ffprobe on PATH.
    ffprobe: Optional[str] = None

    @property
    def ffprobe_same_build(self) -> bool:
        return (
            self.build is not None
            and self.ffprobe is not None
            and self.ffprobe == self.build.ffprobe
        )


_lock = threading.Lock()
#: The cached choice. Set only once a working build was found.
_resolution: Optional[Resolution] = None
#: The most recent resolution, found or not, for status reporting.
_last: Optional[Resolution] = None


# --------------------------------------------------------------------------- #
#  candidates
# --------------------------------------------------------------------------- #


def _exe_name(stem: str) -> str:
    return f"{stem}.exe" if sys.platform == "win32" else stem


def _key(path: str) -> str:
    return os.path.normcase(os.path.abspath(path))


def _from_env() -> list[str]:
    raw = os.environ.get(ENV_VAR, "").strip().strip('"')
    if not raw:
        return []
    p = Path(raw)
    if p.is_dir():
        p = p / _exe_name("ffmpeg")
    return [str(p)] if p.is_file() else []


def _on_path(stem: str) -> list[str]:
    """Every ``stem`` executable on PATH, in PATH order."""
    found: list[str] = []
    for entry in os.environ.get("PATH", "").split(os.pathsep):
        entry = entry.strip().strip('"')
        if not entry:
            continue
        hit = shutil.which(stem, path=entry)
        if hit:
            found.append(hit)
    return found


def _version_key(path: str) -> list[tuple[int, int | str]]:
    """Sort key that orders digit runs numerically: 'ffmpeg-10.0' > 'ffmpeg-9.1'."""
    return [
        (0, int(part)) if part.isdigit() else (1, part.lower())
        for part in re.split(r"(\d+)", path)
        if part
    ]


def _winget_candidates() -> list[str]:
    exe = _exe_name("ffmpeg")
    out: list[str] = []
    bases: list[Path] = []
    local = os.environ.get("LOCALAPPDATA", "")
    if local:
        bases.append(Path(local) / "Microsoft" / "WinGet")  # user scope
    program_files = os.environ.get("ProgramFiles", "")
    if program_files:
        bases.append(Path(program_files) / "WinGet")  # machine scope
    for base in bases:
        out.append(str(base / "Links" / exe))
        # Newest version folder first, compared as numbers so ffmpeg-10.0 comes
        # before ffmpeg-9.1 and ffmpeg-8.1 before ffmpeg-8.0.
        pattern = str(base / "Packages" / "Gyan.FFmpeg*" / "*" / "bin" / exe)
        out.extend(sorted(glob.glob(pattern), key=_version_key, reverse=True))
    profile = os.environ.get("USERPROFILE", "")
    if profile:
        out.append(str(Path(profile) / "scoop" / "shims" / exe))
    program_data = os.environ.get("ProgramData", "")
    if program_data:
        out.append(str(Path(program_data) / "chocolatey" / "bin" / exe))
    return out


def _unix_candidates() -> list[str]:
    return ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]


def candidate_paths() -> list[str]:
    """Every ffmpeg executable worth probing, best-first, without duplicates."""
    ordered = [*_from_env(), *_on_path("ffmpeg")]
    ordered += _winget_candidates() if sys.platform == "win32" else _unix_candidates()
    seen: set[str] = set()
    out: list[str] = []
    for path in ordered:
        if not os.path.isfile(path):
            continue
        k = _key(path)
        if k in seen:
            continue
        seen.add(k)
        out.append(path)
    return out


def sibling_ffprobe(ffmpeg_path: str) -> Optional[str]:
    """ffprobe from the same build as ``ffmpeg_path``: its own folder first,
    then the folder a symlink (winget's Links entries) points into."""
    name = _exe_name("ffprobe")
    for folder in (
        Path(ffmpeg_path).parent,
        Path(os.path.realpath(ffmpeg_path)).parent,
    ):
        probe = folder / name
        if probe.is_file():
            return str(probe)
    return None


# --------------------------------------------------------------------------- #
#  probing + selection
# --------------------------------------------------------------------------- #


def probe_build(ffmpeg_path: str) -> Optional[FFmpegBuild]:
    """Run ``ffmpeg_path`` twice: ``-version`` for its identity and build flags,
    then the soxr resample. None when it does not run as an ffmpeg."""
    try:
        ver = subprocess.run(
            [ffmpeg_path, "-hide_banner", "-version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=_PROBE_TIMEOUT_SEC,
            stdin=subprocess.DEVNULL,
            env=child_env(),
        )
    except (OSError, subprocess.SubprocessError, ValueError) as e:
        log.info("ffmpeg probe: %s did not run: %s", ffmpeg_path, e)
        return None
    text = ver.stdout or ""
    if ver.returncode != 0 or not text.startswith("ffmpeg version"):
        log.info("ffmpeg probe: %s is not a working ffmpeg", ffmpeg_path)
        return None
    try:
        soxr_run = subprocess.run(
            [ffmpeg_path, *SOXR_PROBE_ARGS],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=_PROBE_TIMEOUT_SEC,
            stdin=subprocess.DEVNULL,
            env=child_env(),
        )
        soxr = soxr_run.returncode == 0
    except (OSError, subprocess.SubprocessError, ValueError) as e:
        log.info("ffmpeg probe: soxr test on %s failed to run: %s", ffmpeg_path, e)
        soxr = False
    return FFmpegBuild(
        ffmpeg=ffmpeg_path,
        version=text.splitlines()[0].strip(),
        soxr=soxr,
        rubberband="--enable-librubberband" in text,
        ffprobe=sibling_ffprobe(ffmpeg_path),
    )


def select_build(
    candidates: Iterable[str],
    probe: Callable[[str], Optional[FFmpegBuild]] = probe_build,
) -> Resolution:
    """Probe ``candidates`` in order and keep the best build.

    Stops at the first build with libsoxr and librubberband. Otherwise the first
    build with libsoxr wins, and with no libsoxr anywhere the first build that
    ran at all (so every non-soxr tool still works, and soxr tools report it).
    """
    checked: list[tuple[str, Optional[bool]]] = []
    first_soxr: Optional[FFmpegBuild] = None
    first_any: Optional[FFmpegBuild] = None
    for path in candidates:
        build = probe(path)
        checked.append((path, None if build is None else build.soxr))
        if build is None:
            continue
        if build.soxr and build.rubberband:
            return Resolution(build=build, checked=checked)
        if build.soxr and first_soxr is None:
            first_soxr = build
        if first_any is None:
            first_any = build
    return Resolution(build=first_soxr or first_any, checked=checked)


def resolve(force: bool = False) -> Resolution:
    """The process-wide FFmpeg choice. Probes on the first call (or ``force``)."""
    global _resolution, _last
    current = _resolution
    if current is not None and not force:
        return current
    with _lock:
        if _resolution is not None and not force:
            return _resolution
        result = select_build(candidate_paths(), probe_build)
        if result.build is not None:
            result.ffprobe = result.build.ffprobe or shutil.which("ffprobe")
            _resolution = result
            _log_choice(result)
        else:
            result.ffprobe = shutil.which("ffprobe")
            _resolution = None
            log.warning(
                "ffmpeg: no working ffmpeg found (checked %d candidates)",
                len(result.checked),
            )
        _last = result
        return result


def reset() -> None:
    """Forget the cached choice (tests, and after an install)."""
    global _resolution, _last
    with _lock:
        _resolution = None
        _last = None


def _log_choice(result: Resolution) -> None:
    build = result.build
    assert build is not None
    log.info(
        "ffmpeg: using %s (%s) soxr=%s rubberband=%s ffprobe=%s",
        build.ffmpeg,
        build.version,
        build.soxr,
        build.rubberband,
        result.ffprobe,
    )
    if not build.soxr:
        log.warning(
            "ffmpeg: %s", soxr_missing_message(build.ffmpeg, checked=result.checked)
        )


# --------------------------------------------------------------------------- #
#  what call sites use
# --------------------------------------------------------------------------- #


def find_ffmpeg() -> Optional[str]:
    """Path of the chosen ffmpeg, or None when there is none."""
    build = resolve().build
    return build.ffmpeg if build else None


def find_ffprobe() -> Optional[str]:
    """Path of the ffprobe that goes with the chosen ffmpeg, or None."""
    return resolve().ffprobe


def ffmpeg_exe() -> str:
    """The ffmpeg to put in argv[0]. The bare name when none was found, so the
    spawn fails the way it always has (FileNotFoundError)."""
    return find_ffmpeg() or "ffmpeg"


def ffprobe_exe() -> str:
    """The ffprobe to put in argv[0]; the bare name when none was found."""
    return find_ffprobe() or "ffprobe"


async def aresolve() -> Resolution:
    """``resolve`` for async code: the first probe runs on a worker thread so
    it never stalls the event loop."""
    current = _resolution
    if current is not None:
        return current
    return await asyncio.to_thread(resolve)


async def ffmpeg_exe_async() -> str:
    build = (await aresolve()).build
    return build.ffmpeg if build else "ffmpeg"


def needs_soxr(cmd: Iterable[str]) -> bool:
    """Whether an ffmpeg argv asks for the soxr resampler anywhere."""
    return any(SOXR_MARKER in str(arg) for arg in cmd)


def soxr_problem(cmd: Iterable[str], resolution: Resolution) -> Optional[str]:
    """The error to raise before running ``cmd``, or None when it can run:
    ``cmd`` asks for soxr and the resolved build has no libsoxr."""
    build = resolution.build
    if build is None or build.soxr or not needs_soxr(cmd):
        return None
    return soxr_missing_message(build.ffmpeg, resolution.checked)


def soxr_unavailable_reason() -> Optional[str]:
    """The soxr error for the last resolution, or None when its build has
    libsoxr or nothing has been resolved yet. Never probes."""
    result = _last
    if result is None or result.build is None or result.build.soxr:
        return None
    return soxr_missing_message(result.build.ffmpeg, result.checked)


def soxr_missing_message(
    ffmpeg_path: str, checked: Optional[list[tuple[str, Optional[bool]]]] = None
) -> str:
    """The error a soxr tool reports when the chosen FFmpeg has no libsoxr.
    The path in use comes last, with nothing after it, so it copies cleanly."""
    others = [p for p, _ in (checked or []) if _key(p) != _key(ffmpeg_path)]
    also = f" Also checked, none has libsoxr: {'; '.join(others)}." if others else ""
    return (
        "This FFmpeg has no libsoxr; install the full FFmpeg build "
        f"({_full_build_hint()}), then restart theDAW.{also} "
        f"FFmpeg in use: {ffmpeg_path}"
    )


def _full_build_hint() -> str:
    """Where the full build comes from on this platform."""
    if sys.platform == "win32":
        return "gyan.dev full build, winget package Gyan.FFmpeg"
    if sys.platform == "darwin":
        return "Homebrew's ffmpeg formula"
    return "your distribution's ffmpeg package"


def status() -> dict:
    """What /api/health reports. Reads the last resolution only; never probes.
    ``resolved`` is False until the first resolution has run."""
    result = _last
    if result is None or result.build is None:
        return {
            "resolved": result is not None,
            "path": None,
            "version": None,
            "soxr": None,
            "rubberband": None,
            "ffprobe": result.ffprobe if result else None,
            "ffprobe_same_build": False,
            "checked": [p for p, _ in result.checked] if result else [],
        }
    build = result.build
    return {
        "resolved": True,
        "path": build.ffmpeg,
        "version": build.version,
        "soxr": build.soxr,
        "rubberband": build.rubberband,
        "ffprobe": result.ffprobe,
        "ffprobe_same_build": result.ffprobe_same_build,
        "checked": [p for p, _ in result.checked],
    }
