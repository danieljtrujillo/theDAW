"""A score rendered to audio by MuseScore 4 with Muse Sounds.

:func:`musescore_status` finds the user's MuseScore 4 (``MUSESCORE_BIN``, the
path saved in Settings, the registry and ``Program Files`` on Windows, the CLI
names on ``PATH``, the usual install folders) and whether Muse Sounds is
installed, which MuseScore plays through the MuseSampler library MuseHub
installs. :func:`render_audio` runs

    MuseScore4 -o <out>.wav --sound-profile "Muse Sounds" <score>

(MuseScore Studio handbook, "Command line usage": ``-o`` writes the file type
its extension names, wav included; ``--sound-profile`` takes "MuseScore Basic"
or "Muse Sounds") and adds the WAV to the Library as a new entry, as generated
audio is (``LibraryStore.import_blob``), linked to the score it came from.

MuseScore 3 has no Muse Sounds, so only MuseScore 4 renders.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable, Optional

log = logging.getLogger(__name__)

MUSE_SOUNDS_PROFILE = "Muse Sounds"
MUSE_HUB_URL = "https://www.musehub.com/"

# MuseScore 4 CLI names on PATH, newest naming first.
_MUSESCORE4_NAMES = (
    "MuseScore4",
    "MuseScore4.exe",
    "mscore4portable",
    "MuseScore4Portable",
    "musescore4",
    "mscore",
    "musescore",
)

# A render of a long score with Muse Sounds takes minutes.
RENDER_TIMEOUT_SEC = 1800

_VERSION_4_RE = re.compile(r"(?<![\d.])4\.\d+")

REASON_NO_MUSESCORE = "MuseScore 4 is not installed"
REASON_NO_MUSE_SOUNDS = "Muse Sounds is not installed (MuseHub)"


def _registry_candidates() -> list[Path]:
    """MuseScore 4 executables the Windows registry names: its App Paths
    entry and any uninstall entry for MuseScore 4 / MuseScore Studio 4."""
    if sys.platform != "win32":
        return []
    try:
        import winreg
    except ImportError:
        return []
    out: list[Path] = []
    hives = (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER)
    for hive in hives:
        try:
            with winreg.OpenKey(
                hive,
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\MuseScore4.exe",
            ) as key:
                value, _kind = winreg.QueryValueEx(key, "")
                if value:
                    out.append(Path(str(value).strip('"')))
        except OSError:
            pass
    uninstall_roots = (
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    )
    for hive in hives:
        for root in uninstall_roots:
            try:
                with winreg.OpenKey(hive, root) as parent:
                    count = winreg.QueryInfoKey(parent)[0]
                    for index in range(count):
                        try:
                            with winreg.OpenKey(
                                parent, winreg.EnumKey(parent, index)
                            ) as entry:
                                out += _uninstall_entry_exes(winreg, entry)
                        except OSError:
                            continue
            except OSError:
                continue
    return out


def _uninstall_entry_exes(winreg: Any, entry: Any) -> list[Path]:
    """The MuseScore 4 executable an uninstall entry points at, if it is one."""

    def value(name: str) -> str:
        try:
            return str(winreg.QueryValueEx(entry, name)[0] or "")
        except OSError:
            return ""

    name = value("DisplayName")
    if not re.match(r"MuseScore( Studio)? 4", name):
        return []
    out: list[Path] = []
    location = value("InstallLocation").strip('"')
    if location:
        out.append(Path(location) / "bin" / "MuseScore4.exe")
    icon = value("DisplayIcon").split(",")[0].strip('"')
    if icon.lower().endswith(".exe"):
        out.append(Path(icon))
    return out


def musescore4_candidates() -> list[Path]:
    """Every place MuseScore 4 may be, in the order they are tried."""
    from .engine import _musescore_install_candidates, _musescore_settings_path

    out: list[Path] = []
    override = os.environ.get("MUSESCORE_BIN")
    if override:
        out.append(Path(override))
    chosen = _musescore_settings_path()
    if chosen:
        out.append(Path(chosen).expanduser())
    out += _registry_candidates()
    for name in _MUSESCORE4_NAMES:
        found = shutil.which(name)
        if found:
            out.append(Path(found))
    out += _musescore_install_candidates()
    return out


def is_musescore4(binary: Path, version: Optional[Callable[[str], str]] = None) -> bool:
    """Whether ``binary`` is MuseScore 4: its name says so (``MuseScore4``,
    ``mscore4portable``), or, for a name that does not (``mscore``,
    ``musescore``, an AppImage), ``--version`` prints a 4.x version."""
    name = binary.name.lower()
    if "musescore3" in name or "mscore3" in name:
        return False
    if (
        "musescore4" in name
        or "mscore4" in name
        or "musescore 4" in str(binary).lower()
    ):
        return True
    if version is None:
        version = _cached_version
    return bool(_VERSION_4_RE.search(version(str(binary)) or ""))


# ``--version`` of each binary asked about, by (path, modified time), so the
# capabilities call does not start MuseScore every time.
_VERSIONS: dict[tuple[str, float], str] = {}


def _cached_version(binary: str) -> str:
    from .engine import _musescore_version

    try:
        key = (binary, Path(binary).stat().st_mtime)
    except OSError:
        return _musescore_version(binary)
    if key not in _VERSIONS:
        _VERSIONS[key] = _musescore_version(binary)
    return _VERSIONS[key]


def find_musescore4() -> Optional[Path]:
    """The first MuseScore 4 executable of :func:`musescore4_candidates`."""
    seen: set[str] = set()
    for candidate in musescore4_candidates():
        key = str(candidate).lower()
        if key in seen:
            continue
        seen.add(key)
        if candidate.is_file() and is_musescore4(candidate):
            return candidate
    return None


def muse_sampler_paths() -> list[Path]:
    """Where MuseHub installs the MuseSampler library MuseScore 4 plays Muse
    Sounds through, for this platform."""
    home = Path.home()
    if sys.platform == "win32":
        env = os.environ
        out = []
        for root in (env.get("LOCALAPPDATA"), env.get("ProgramData")):
            if root:
                out.append(
                    Path(root) / "MuseSampler" / "lib" / "MuseSamplerCoreLib.dll"
                )
        common = env.get("CommonProgramFiles")
        if common:
            out.append(Path(common) / "MuseSampler" / "lib" / "MuseSamplerCoreLib.dll")
        return out
    if sys.platform == "darwin":
        lib = Path("Library") / "Application Support" / "MuseSampler" / "lib"
        return [
            Path("/") / lib / "libMuseSamplerCoreLib.dylib",
            home / lib / "libMuseSamplerCoreLib.dylib",
        ]
    return [
        home / ".local" / "share" / "MuseSampler" / "lib" / "libMuseSamplerCoreLib.so",
        Path("/usr/lib/libMuseSamplerCoreLib.so"),
        Path("/usr/local/lib/libMuseSamplerCoreLib.so"),
    ]


def muse_sounds_installed() -> bool:
    return any(path.is_file() for path in muse_sampler_paths())


def musescore_status() -> dict[str, Any]:
    """``{found, path, muse_sounds, reason}``: whether MuseScore 4 is here and
    where, whether Muse Sounds is installed, and, when a render cannot run,
    why in a few words (empty when it can)."""
    binary = find_musescore4()
    muse_sounds = muse_sounds_installed()
    if binary is None:
        reason = REASON_NO_MUSESCORE
    elif not muse_sounds:
        reason = REASON_NO_MUSE_SOUNDS
    else:
        reason = ""
    return {
        "found": binary is not None,
        "path": str(binary) if binary is not None else None,
        "muse_sounds": muse_sounds,
        "reason": reason,
    }


def render_command(binary: Path, source: Path, output: Path) -> list[str]:
    """The argv that renders ``source`` to ``output`` with Muse Sounds."""
    return [
        str(binary),
        "-o",
        str(output),
        "--sound-profile",
        MUSE_SOUNDS_PROFILE,
        str(source),
    ]


def _wav_duration(path: Path) -> float:
    try:
        import soundfile

        return float(soundfile.info(str(path)).duration)
    except (ImportError, RuntimeError, OSError, ValueError):
        return 0.0


def render_audio(
    db: Any,
    *,
    entry_id: str,
    source_path: Path,
    output_path: Path,
    source_ref: Optional[str] = None,
    title: str = "",
    artist: str = "",
    register_source: Optional[Path] = None,
    extra_metadata: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Render the score at ``source_path`` (MusicXML, or MIDI staged through
    music21 as MusicXML) to a WAV with MuseScore 4 and Muse Sounds, and add
    the WAV to the Library as a new entry.

    ``output_path`` is where MuseScore writes the WAV; the Library keeps its
    own copy in the new entry, and the file is removed afterwards. Returns
    ``{ok, engine, library_entry_id, title, audio_url, artifact: None}``, or
    ``{ok: False, engine, error}`` naming what is missing or what failed.
    Never raises.
    """
    from backend.lib.launch_token import child_env

    from .engine import _is_musicxml, _stage_musicxml, artist_name, clean_title

    status = musescore_status()
    if status["reason"]:
        return {"ok": False, "engine": "musescore", "error": status["reason"]}
    binary = Path(status["path"])

    output_path.parent.mkdir(parents=True, exist_ok=True)
    scratch: Optional[Path] = None
    source = source_path
    try:
        if not _is_musicxml(source_path):
            scratch = output_path.with_name(f"{output_path.stem}__render_src.musicxml")
            try:
                source = _stage_musicxml(
                    source_path, scratch, title, artist=artist or artist_name()
                )
            except Exception as exc:  # reported, never raised
                return {"ok": False, "engine": "musescore", "error": repr(exc)}
        creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        try:
            proc = subprocess.run(
                render_command(binary, source, output_path),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=RENDER_TIMEOUT_SEC,
                stdin=subprocess.DEVNULL,
                creationflags=creationflags,
                env=child_env(),
            )
        except (subprocess.TimeoutExpired, OSError) as exc:
            return {"ok": False, "engine": "musescore", "error": repr(exc)}
        if (
            proc.returncode != 0
            or not output_path.is_file()
            or not output_path.stat().st_size
        ):
            detail = (proc.stderr or proc.stdout or "MuseScore wrote no audio").strip()
            return {"ok": False, "engine": "musescore", "error": detail[-400:]}
        return _add_to_library(
            db,
            wav=output_path,
            entry_id=entry_id,
            title=clean_title(title) or source_path.stem,
            source=register_source or source_path,
            source_ref=source_ref,
            binary=binary,
            extra_metadata=extra_metadata,
        )
    finally:
        if scratch is not None:
            scratch.unlink(missing_ok=True)
        output_path.unlink(missing_ok=True)


def _add_to_library(
    db: Any,
    *,
    wav: Path,
    entry_id: str,
    title: str,
    source: Path,
    source_ref: Optional[str],
    binary: Path,
    extra_metadata: Optional[dict[str, Any]],
) -> dict[str, Any]:
    """The rendered WAV as a new Library entry, linked to the score's entry."""
    from backend.modules.library.router import get_store

    from .engine import _musescore_version

    render_title = f"{title} (MuseScore)"
    parts = (extra_metadata or {}).get("parts") or []
    notes = f"Rendered with MuseScore 4 and Muse Sounds from {source.name}"
    if parts:
        notes += (
            " (" + ", ".join(str(p.get("name") or p.get("index")) for p in parts) + ")"
        )
    try:
        record = get_store().import_blob(
            wav.read_bytes(),
            f"{render_title}.wav",
            "audio/wav",
            {
                "title": render_title,
                "model": "musescore",
                "source": "generate",
                "duration": _wav_duration(wav),
                "tags": ["musescore", "muse-sounds", f"score-of:{entry_id}"],
                "notes": notes,
            },
        )
    except Exception as exc:  # reported, never raised
        log.warning("notation: MuseScore render of %s not added: %s", source, exc)
        return {"ok": False, "engine": "musescore", "error": repr(exc)}
    try:
        db.add_relation(
            from_id=source_ref or str(source),
            to_id=record.id,
            kind="rendered_as_audio",
            metadata={
                "engine": "musescore",
                "engine_version": _musescore_version(str(binary)),
                "sound_profile": MUSE_SOUNDS_PROFILE,
                "entry_id": entry_id,
            },
        )
    except Exception as exc:  # the entry exists either way
        log.debug("notation: render relation skipped: %s", exc)
    return {
        "ok": True,
        "engine": "musescore",
        "library_entry_id": record.id,
        "title": render_title,
        "audio_url": str(getattr(record, "audio_url", "") or ""),
        "artifact": None,
    }
