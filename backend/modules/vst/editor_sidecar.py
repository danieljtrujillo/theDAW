"""Standalone VST3 editor sidecar.

``pedalboard.VST3Plugin.show_editor()`` opens the plugin's REAL native GUI
window, but it blocks the calling thread until the window is closed and must run
on the process main thread, so it cannot run inside the FastAPI server. The
``/api/vst/open-editor`` endpoint spawns this script as a subprocess: it loads
the plugin (optionally restoring prior state), shows the editor, and on close
writes the plugin's full state to a JSON file so the chain entry can reuse
exactly what the user dialed in.

Usage::

    python -m backend.modules.vst.editor_sidecar \
        --plugin-path "C:/.../Plugin.vst3" \
        --preset-out  state_out.json \
        --preset-in   state_in.json   # optional

The captured state is ``pedalboard``'s opaque ``raw_state`` (the plugin's entire
internal state, including GUI-only tweaks), base64-encoded. It round-trips
exactly via ``plugin.raw_state = bytes`` at process time.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path


def _read_state_in(path: str | None) -> bytes | None:
    if not path:
        return None
    p = Path(path)
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        b64 = data.get("raw_state")
        return base64.b64decode(b64) if b64 else None
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Open a VST3 plugin's native editor.")
    ap.add_argument("--plugin-path", required=True)
    ap.add_argument("--preset-in", default=None)
    ap.add_argument("--preset-out", required=True)
    # Embedding (Windows): reparent the editor under this HWND and track this rect
    # file. 0/absent keeps today's floating-window behavior.
    ap.add_argument("--parent-hwnd", type=int, default=0)
    ap.add_argument("--rect-file", default=None)
    args = ap.parse_args()

    out = Path(args.preset_out)
    out.parent.mkdir(parents=True, exist_ok=True)

    def write_out(payload: dict) -> None:
        out.write_text(json.dumps(payload), encoding="utf-8")

    # Mark in-progress so the poller can distinguish "opening" from a stale result.
    write_out({"status": "opening", "plugin_path": args.plugin_path})

    # When embedding, become DPI-aware BEFORE the editor window is created so its
    # physical pixels line up with the rect the frontend reports.
    if args.parent_hwnd:
        try:
            from backend.modules.vst.win_embed import enable_dpi_awareness

            enable_dpi_awareness()
        except Exception:
            pass

    try:
        # Reuse the server's pedalboard accessor + resilient loader so resolution
        # and multi-shell handling behave identically here (this runs as
        # `python -m backend.modules.vst...`).
        from backend.modules.vst.host import _get_pedalboard, load_plugin_file

        pedalboard = _get_pedalboard()
    except Exception as e:
        write_out({"status": "error", "error": f"pedalboard import failed: {e}"})
        return 1

    try:
        plugin = load_plugin_file(pedalboard, args.plugin_path)
    except Exception as e:
        write_out({"status": "error", "error": f"load failed: {e}"})
        return 1

    # Restore prior GUI state if we have it, so the editor opens where the user
    # left off rather than at plugin defaults.
    prior = _read_state_in(args.preset_in)
    if prior is not None:
        try:
            plugin.raw_state = prior
        except Exception:
            pass

    # Embed the editor under the Electron window (Windows). The watcher runs on a
    # daemon thread because show_editor() below blocks the main thread; it finds
    # the editor window by our PID, reparents it, and tracks the rect file. No-op
    # off win32 / without a parent HWND -> the editor floats as before.
    if args.parent_hwnd:
        try:
            from backend.modules.vst.win_embed import start_embed_watcher

            start_embed_watcher(args.parent_hwnd, args.rect_file)
        except Exception:
            pass

    try:
        print(
            f"[sidecar] show_editor() for {args.plugin_path} "
            f"(parent_hwnd={args.parent_hwnd})",
            flush=True,
        )
        plugin.show_editor()  # blocks until the window is closed
        print("[sidecar] show_editor() returned (window closed)", flush=True)
    except Exception as e:
        import traceback

        traceback.print_exc()
        write_out({"status": "error", "error": f"editor unavailable: {e}"})
        return 1

    try:
        raw = bytes(plugin.raw_state)
        b64 = base64.b64encode(raw).decode("ascii")
    except Exception as e:
        write_out({"status": "error", "error": f"state capture failed: {e}"})
        return 1

    write_out({"status": "ok", "plugin_path": args.plugin_path, "raw_state": b64})
    return 0


if __name__ == "__main__":
    sys.exit(main())
