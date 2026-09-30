"""Advisory one-line status check for the native live-VST host.

``theDAW.bat`` runs this on startup so a user sees, in one line, whether the
native live-VST host (``native/vst-host``) is built and usable -- it is an
optional capability, not a requirement to launch the app. It imports nothing
from ``backend`` and touches the network never, so it runs on a bare
interpreter, with or without the project's virtual environment on top of it
-- the launcher reaches it with whichever Python it has. ``main()`` never
raises and
never exits non-zero: a missing or broken host is reported as a status, not
treated as a failure, and plugins still work offline without it.
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
from typing import Mapping, Optional, Sequence

#: Host binary lookup env var. Mirrors ``HOST_ENV_VAR`` in
#: ``backend/modules/vst/live_host.py`` -- this script cannot import that
#: module (no venv yet), so the name is duplicated rather than shared.
HOST_ENV_VAR = "THEDAW_VST_HOST"

#: ``subprocess.run`` kwargs that stop a console window from flashing when
#: this script spawns the host to ask its version. Only meaningful on
#: win32, and only when this interpreter's ``subprocess`` exposes the flag
#: (guarded with ``hasattr`` rather than a bare platform check).
_NO_WINDOW_KWARGS: dict[str, int] = (
    {"creationflags": subprocess.CREATE_NO_WINDOW}
    if sys.platform == "win32" and hasattr(subprocess, "CREATE_NO_WINDOW")
    else {}
)


def host_path(env: Optional[Mapping[str, str]] = None) -> Optional[pathlib.Path]:
    """Where the live-VST host binary is expected.

    ``THEDAW_VST_HOST`` wins when set to a non-empty value. Otherwise this
    returns the path ``native/vst-host/build.ps1`` copies the built exe to.
    The path is returned whether or not anything exists there yet --
    existence is the caller's check, not this function's.
    """
    env = os.environ if env is None else env
    configured = env.get(HOST_ENV_VAR, "")
    if configured:
        return pathlib.Path(configured)
    repo_root = pathlib.Path(__file__).resolve().parents[1]
    return repo_root / "native" / "vst-host" / "bin" / "thedaw-vst-host.exe"


def probe_version(exe: pathlib.Path) -> Optional[str]:
    """Ask ``exe --version`` what it is, tolerating anything short of a hang.

    Returns ``None`` on a non-zero exit or any ``OSError`` /
    ``subprocess.SubprocessError`` (including a timeout) -- a broken or
    missing host is exactly the case this whole script exists to report
    calmly. On success, the first non-empty stdout line is parsed as JSON
    for its ``version`` field; a host that prints something else still gets
    that line back (truncated) rather than being treated as a failure.
    """
    try:
        done = subprocess.run(
            [str(exe), "--version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5.0,
            **_NO_WINDOW_KWARGS,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode != 0:
        return None
    for line in (done.stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except ValueError:
            return line[:120]
        if isinstance(payload, dict) and payload.get("version"):
            return str(payload["version"])[:120]
        return line[:120]
    return None


def status_line(
    env: Optional[Mapping[str, str]] = None, platform: Optional[str] = None
) -> str:
    """One human-readable line describing whether live VST hosting works."""
    platform = sys.platform if platform is None else platform
    if platform != "win32":
        return "live VST host: not available on this platform"

    exe = host_path(env)
    if exe is not None and exe.exists():
        version = probe_version(exe)
        if version is not None:
            return f"live VST host: ready ({version})"

    return (
        "live VST host: not built - run native\\vst-host\\build.ps1 "
        "(needs CMake + Visual Studio Build Tools); plugins still work offline"
    )


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Print the status line and exit 0, no matter what goes wrong."""
    try:
        print(status_line())
    except Exception:
        print(
            "live VST host: not built - run native\\vst-host\\build.ps1 "
            "(needs CMake + Visual Studio Build Tools); plugins still work offline"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
