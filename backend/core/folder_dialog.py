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
    if sys.platform == "win32":
        return _pick_folder_windows(title, initial)
    return _pick_folder_tk(title, initial)


def _ps_quote(value: str) -> str:
    """Single-quote a string for safe interpolation into PowerShell."""
    return "'" + value.replace("'", "''") + "'"


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
