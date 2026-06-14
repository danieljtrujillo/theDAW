"""Shared ADB discovery helpers for Quest/Android integrations.

Keep ADB resolution in one place so modules don't drift. The lookup order is:
explicit env override(s), PATH, then common Windows Android SDK / Oculus install
locations. No process is started here; callers decide whether to run adb.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Iterable, Optional


DEFAULT_ADB_ENV_VARS = ("theDAW_ADB", "theDAW_QUESTMIDI_ADB", "theDAW_QUESTCAST_ADB")


def resolve_adb_path(*env_vars: str) -> Optional[str]:
    """Return an adb executable path, or None when no local adb is discoverable."""

    for env_name in env_vars or DEFAULT_ADB_ENV_VARS:
        candidate = os.getenv(env_name)
        if candidate:
            path = Path(candidate).expanduser()
            if path.is_file():
                return str(path)

    for executable in ("adb", "adb.exe"):
        found = shutil.which(executable)
        if found and Path(found).is_file():
            return found

    for path in _common_adb_candidates():
        if path.is_file():
            return str(path)

    return None


def _common_adb_candidates() -> Iterable[Path]:
    """Best-effort Windows defaults for machines with Android Studio/Oculus tools."""

    sdk_roots = []
    for env_name in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        value = os.getenv(env_name)
        if value:
            sdk_roots.append(Path(value).expanduser())

    local_app_data = os.getenv("LOCALAPPDATA")
    if local_app_data:
        sdk_roots.append(Path(local_app_data) / "Android" / "Sdk")

    sdk_roots.append(Path.home() / "AppData" / "Local" / "Android" / "Sdk")
    sdk_roots.extend((Path("C:/Android"), Path("C:/platform-tools")))

    seen: set[str] = set()

    def unique(path: Path) -> Iterable[Path]:
        key = str(path).lower()
        if key not in seen:
            seen.add(key)
            yield path

    for root in sdk_roots:
        if root.name.lower() == "platform-tools":
            yield from unique(root / "adb.exe")
        else:
            yield from unique(root / "platform-tools" / "adb.exe")

    for env_name in ("PROGRAMFILES", "PROGRAMFILES(X86)"):
        value = os.getenv(env_name)
        if not value:
            continue
        root = Path(value)
        yield from unique(root / "Oculus" / "Support" / "oculus-adb" / "adb.exe")
        yield from unique(
            root / "Meta Quest Developer Hub" / "resources" / "bin" / "adb.exe"
        )
