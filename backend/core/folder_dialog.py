"""Native OS folder-picker dialog.

Lets the user click through to choose an output folder instead of typing a
path. Windows-first: a PowerShell ``FolderBrowserDialog`` forced topmost and
run in an STA, out-of-process so it can never block or corrupt the FastAPI
server's threads. Falls back to tkinter elsewhere (best effort).

Returns the chosen absolute path, or ``None`` when the user cancels / no GUI
is available.
"""

from __future__ import annotations

import logging
import subprocess
import sys
from typing import Optional

log = logging.getLogger(__name__)

# A blocking native dialog can sit open for a long time while the user
# navigates; give them a generous window before we give up on it.
_DIALOG_TIMEOUT_SEC = 600.0


def pick_folder(
    title: str = "Select folder", initial: Optional[str] = None
) -> Optional[str]:
    """Open a native folder picker and return the chosen absolute path.

    ``None`` means the user cancelled or no picker is available.
    """
    plat: str = sys.platform
    if plat == "win32":
        return _pick_folder_windows(title, initial)
    return _pick_folder_tk(title, initial)


def pick_save_file(
    title: str = "Save as",
    initial_dir: Optional[str] = None,
    initial_name: Optional[str] = None,
    default_ext: Optional[str] = None,
    filter_spec: Optional[str] = None,
) -> Optional[str]:
    """Open a native *Save As* dialog and return the chosen absolute path.

    ``None`` means the user cancelled or no picker is available. ``filter_spec``
    is a Windows-style filter (``"theDAW project (*.tasmo)|*.tasmo|All files
    (*.*)|*.*"``); the tkinter fallback parses it into filetypes.
    """
    plat: str = sys.platform
    if plat == "win32":
        return _pick_save_windows(
            title, initial_dir, initial_name, default_ext, filter_spec
        )
    return _pick_save_tk(title, initial_dir, initial_name, default_ext, filter_spec)


def _ps_quote(value: str) -> str:
    """Single-quote a string for safe interpolation into PowerShell."""
    return "'" + value.replace("'", "''") + "'"


def _pick_save_windows(
    title: str,
    initial_dir: Optional[str],
    initial_name: Optional[str],
    default_ext: Optional[str],
    filter_spec: Optional[str],
) -> Optional[str]:
    script = [
        "Add-Type -AssemblyName System.Windows.Forms;",
        "$f = New-Object System.Windows.Forms.SaveFileDialog;",
        f"$f.Title = {_ps_quote(title)};",
        "$f.AddExtension = $true;",
        "$f.OverwritePrompt = $true;",
    ]
    if initial_dir:
        script.append(f"$f.InitialDirectory = {_ps_quote(initial_dir)};")
    if initial_name:
        script.append(f"$f.FileName = {_ps_quote(initial_name)};")
    if default_ext:
        script.append(f"$f.DefaultExt = {_ps_quote(default_ext.lstrip('.'))};")
    if filter_spec:
        script.append(f"$f.Filter = {_ps_quote(filter_spec)};")
    script.append(
        "$owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true};"
        "$r = $f.ShowDialog($owner);"
        "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.FileName) }"
        "$owner.Dispose();"
    )
    cmd = [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-Command",
        " ".join(script),
    ]
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=_DIALOG_TIMEOUT_SEC
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        log.warning("folder_dialog: PowerShell save picker failed: %s", e)
        return None
    path = (proc.stdout or "").strip()
    return path or None


def _parse_filetypes(filter_spec: Optional[str]) -> list[tuple[str, str]]:
    """Turn a Windows filter string into tkinter filetypes pairs."""
    if not filter_spec:
        return []
    parts = [p for p in filter_spec.split("|")]
    pairs: list[tuple[str, str]] = []
    for i in range(0, len(parts) - 1, 2):
        pairs.append((parts[i], parts[i + 1]))
    return pairs


def _pick_save_tk(
    title: str,
    initial_dir: Optional[str],
    initial_name: Optional[str],
    default_ext: Optional[str],
    filter_spec: Optional[str],
) -> Optional[str]:
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception as e:  # noqa: BLE001 — headless / no Tk available
        log.warning("folder_dialog: tkinter unavailable: %s", e)
        return None
    try:
        root = tk.Tk()
        root.withdraw()
        try:
            root.attributes("-topmost", True)
        except Exception:  # noqa: BLE001 — topmost is cosmetic
            pass
        path = filedialog.asksaveasfilename(
            title=title,
            initialdir=initial_dir or None,
            initialfile=initial_name or None,
            defaultextension=(f".{default_ext.lstrip('.')}" if default_ext else None),
            filetypes=_parse_filetypes(filter_spec) or None,
        )
        root.destroy()
        return path or None
    except Exception as e:  # noqa: BLE001 — no display / not main thread
        log.warning("folder_dialog: tkinter save picker failed: %s", e)
        return None


def _pick_folder_windows(title: str, initial: Optional[str]) -> Optional[str]:
    script = [
        "Add-Type -AssemblyName System.Windows.Forms;",
        "$f = New-Object System.Windows.Forms.FolderBrowserDialog;",
        f"$f.Description = {_ps_quote(title)};",
        "$f.ShowNewFolderButton = $true;",
    ]
    if initial:
        script.append(f"$f.SelectedPath = {_ps_quote(initial)};")
    script.append(
        # Owning the dialog with a TopMost form forces it above theDAW so it
        # never opens hidden behind the app window.
        "$owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true};"
        "$r = $f.ShowDialog($owner);"
        "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) }"
        "$owner.Dispose();"
    )
    cmd = [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-Command",
        " ".join(script),
    ]
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=_DIALOG_TIMEOUT_SEC
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        log.warning("folder_dialog: PowerShell picker failed: %s", e)
        return None
    path = (proc.stdout or "").strip()
    return path or None


def _pick_folder_tk(title: str, initial: Optional[str]) -> Optional[str]:
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception as e:  # noqa: BLE001 — headless / no Tk available
        log.warning("folder_dialog: tkinter unavailable: %s", e)
        return None
    try:
        root = tk.Tk()
        root.withdraw()
        try:
            root.attributes("-topmost", True)
        except Exception:  # noqa: BLE001 — topmost is cosmetic
            pass
        path = filedialog.askdirectory(title=title, initialdir=initial or None)
        root.destroy()
        return path or None
    except Exception as e:  # noqa: BLE001 — no display / not main thread
        log.warning("folder_dialog: tkinter picker failed: %s", e)
        return None
