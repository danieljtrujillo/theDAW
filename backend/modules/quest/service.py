"""Quest deploy service: resolve adb, list devices, install + launch an APK.

Deploy-only (no Unity build). Everything shells out to the Android Debug
Bridge (``adb``), which the theDAW-XR companion already relies on. adb is
frequently NOT on PATH on a Windows dev box, so :func:`resolve_adb` searches
the usual SDK / Unity / Meta locations and honors an explicit override that the
user can set once (persisted to ``data/quest.json``).

All subprocess calls take timeouts and are meant to run in worker threads so
the FastAPI event loop is never blocked.
"""

from __future__ import annotations

import glob
import json
import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[3]
_CONFIG_PATH = PROJECT_ROOT / "data" / "quest.json"

_EXE = "adb.exe" if os.name == "nt" else "adb"

# Meta/Oculus hardware codenames reported in adb's product/device fields, used
# to flag a connected headset as a Quest even when the model string is terse.
_QUEST_CODENAMES = {
    "monterey",  # Quest 1
    "hollywood",  # Quest 2
    "eureka",  # Quest 3
    "panther",  # Quest 3S
    "seacliff",  # Quest Pro
    "cambria",  # Quest Pro (project name)
}

_DEVICES_TIMEOUT_S = 12.0
_LAUNCH_TIMEOUT_S = 20.0
_VERSION_TIMEOUT_S = 8.0
# Installing a multi-hundred-MB APK over USB/Wi-Fi can be slow.
_INSTALL_TIMEOUT_S = 600.0


# --- Config persistence --------------------------------------------------


def load_config() -> dict:
    """User-local Quest config (adb override, last APK, default package)."""
    try:
        raw = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return raw if isinstance(raw, dict) else {}


def save_config(patch: dict) -> dict:
    """Merge ``patch`` into the on-disk config and return the merged result."""
    cfg = load_config()
    cfg.update({k: v for k, v in patch.items() if v is not None})
    try:
        _CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        _CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    except OSError as exc:
        log.warning("quest: could not write %s: %s", _CONFIG_PATH, exc)
    return cfg


# --- adb resolution ------------------------------------------------------


def _candidate_adb_paths() -> list[str]:
    """Common adb locations on Windows/macOS/Linux, in priority order."""
    out: list[str] = []
    # Explicit env overrides win.
    for env in ("QUEST_ADB_PATH", "ADB_PATH"):
        val = os.environ.get(env)
        if val:
            out.append(val)
    # Android SDK locations.
    for env in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        root = os.environ.get(env)
        if root:
            out.append(str(Path(root) / "platform-tools" / _EXE))
    local = os.environ.get("LOCALAPPDATA")
    if local:
        out.append(str(Path(local) / "Android" / "Sdk" / "platform-tools" / _EXE))
    home = Path.home()
    out.append(
        str(home / "AppData" / "Local" / "Android" / "Sdk" / "platform-tools" / _EXE)
    )
    out.append(str(home / "Library" / "Android" / "sdk" / "platform-tools" / _EXE))
    out.append(str(home / "Android" / "Sdk" / "platform-tools" / _EXE))
    # Unity Hub's bundled Android SDK (any installed editor version).
    for base in (
        r"C:\Program Files\Unity\Hub\Editor",
        str(home / "Unity" / "Hub" / "Editor"),
    ):
        out.extend(
            glob.glob(
                os.path.join(
                    base,
                    "*",
                    "Editor",
                    "Data",
                    "PlaybackEngines",
                    "AndroidPlayer",
                    "SDK",
                    "platform-tools",
                    _EXE,
                )
            )
        )
    # Meta Quest Developer Hub ships its own platform-tools.
    if local:
        out.extend(
            glob.glob(
                os.path.join(local, "Programs", "*meta*", "**", _EXE), recursive=True
            )
        )
    return out


def resolve_adb() -> tuple[Optional[str], str]:
    """Locate an adb executable. Returns ``(path, source)``; ``path`` is None
    when adb cannot be found. ``source`` describes where it came from for the
    UI ('configured' | 'path' | 'discovered' | 'none')."""
    configured = load_config().get("adb_path")
    if isinstance(configured, str) and configured and Path(configured).is_file():
        return configured, "configured"
    on_path = shutil.which("adb")
    if on_path:
        return on_path, "path"
    for cand in _candidate_adb_paths():
        try:
            if cand and Path(cand).is_file():
                return cand, "discovered"
        except OSError:
            continue
    return None, "none"


def _run(adb: str, args: list[str], timeout: float) -> subprocess.CompletedProcess:
    """Run ``adb <args>`` capturing text output; never raises on nonzero exit."""
    return subprocess.run(
        [adb, *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def adb_version(adb: str) -> Optional[str]:
    """First line of ``adb version``, or None if the binary does not run."""
    try:
        proc = _run(adb, ["version"], _VERSION_TIMEOUT_S)
    except (OSError, subprocess.SubprocessError) as exc:
        log.warning("quest: adb version failed for %s: %s", adb, exc)
        return None
    line = (proc.stdout or proc.stderr or "").strip().splitlines()
    return line[0] if line else None


# --- Devices -------------------------------------------------------------


def _is_quest(fields: dict[str, str]) -> bool:
    blob = " ".join(fields.get(k, "") for k in ("model", "product", "device")).lower()
    if "quest" in blob or "oculus" in blob:
        return True
    return any(code in blob for code in _QUEST_CODENAMES)


def list_devices(adb: str) -> list[dict]:
    """Parse ``adb devices -l`` into structured device records."""
    try:
        proc = _run(adb, ["devices", "-l"], _DEVICES_TIMEOUT_S)
    except (OSError, subprocess.SubprocessError) as exc:
        log.warning("quest: adb devices failed: %s", exc)
        return []
    devices: list[dict] = []
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if not line or line.lower().startswith("list of devices"):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        serial, state = parts[0], parts[1]
        fields: dict[str, str] = {}
        for tok in parts[2:]:
            if ":" in tok:
                key, _, val = tok.partition(":")
                fields[key] = val
        model = fields.get("model", "").replace("_", " ") or serial
        devices.append(
            {
                "serial": serial,
                "state": state,  # device | unauthorized | offline
                "model": model,
                "product": fields.get("product", ""),
                "is_quest": _is_quest(fields),
                "ready": state == "device",
            }
        )
    return devices


# --- Deploy --------------------------------------------------------------


def install_apk(adb: str, apk_path: str, serial: Optional[str]) -> tuple[bool, str]:
    """``adb install -r`` the APK. Returns ``(ok, combined_output)``."""
    apk = Path(apk_path).expanduser()
    if not apk.is_file():
        return False, f"APK not found: {apk}"
    if apk.suffix.lower() != ".apk":
        return False, f"Not an .apk file: {apk}"
    args = (["-s", serial] if serial else []) + ["install", "-r", str(apk)]
    try:
        proc = _run(adb, args, _INSTALL_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return False, "adb install timed out"
    except (OSError, subprocess.SubprocessError) as exc:
        return False, f"adb install failed to run: {exc}"
    out = f"{proc.stdout}\n{proc.stderr}".strip()
    ok = proc.returncode == 0 and "Success" in out
    return ok, out


def launch_package(adb: str, package: str, serial: Optional[str]) -> tuple[bool, str]:
    """Launch an installed package's default activity via ``monkey``."""
    args = (["-s", serial] if serial else []) + [
        "shell",
        "monkey",
        "-p",
        package,
        "-c",
        "android.intent.category.LAUNCHER",
        "1",
    ]
    try:
        proc = _run(adb, args, _LAUNCH_TIMEOUT_S)
    except (OSError, subprocess.SubprocessError) as exc:
        return False, f"launch failed to run: {exc}"
    out = f"{proc.stdout}\n{proc.stderr}".strip()
    # monkey prints "No activities found" when the package/launcher is wrong.
    ok = proc.returncode == 0 and "No activities found" not in out
    return ok, out
