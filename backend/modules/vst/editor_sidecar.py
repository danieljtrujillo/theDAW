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
        --plugin-name "Ozone 11"      # optional; required sub-plugin of a shell

The captured state is ``pedalboard``'s opaque ``raw_state`` (the plugin's entire
internal state, including GUI-only tweaks), base64-encoded. It round-trips
exactly via ``plugin.raw_state = bytes`` at process time.

A .vst3 file can contain SEVERAL plugins. Without ``--plugin-name`` the loader
picks the first one, which is not necessarily the one the chain entry uses — so
the editor would edit a different plugin than the one that renders.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

# Identity fields pedalboard exposes; not every plugin populates all of them.
_IDENTITY_FIELDS = ("name", "identifier", "version", "manufacturer_name", "category")


def _log(msg: str) -> None:
    print(f"[sidecar] {msg}", flush=True)


def _read_state_in(path: str | None) -> tuple[str | None, str | None]:
    """Read the prior editor state file. Returns ``(base64_state, error)``.

    ``(None, None)`` means there is nothing to restore — no ``--preset-in``, or
    the file does not exist. A non-None error means the file WAS there and could
    not be used, which is the case that used to look identical to "no prior
    state" and silently reopened the plugin at its defaults.
    """
    if not path:
        return None, None
    p = Path(path)
    if not p.is_file():
        return None, None
    try:
        text = p.read_text(encoding="utf-8")
    except OSError as e:
        return None, f"could not read {p.name}: {e}"
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        return None, f"{p.name} is not valid JSON: {e}"
    if not isinstance(data, dict):
        return None, f"{p.name} is not a JSON object (got {type(data).__name__})"
    b64 = data.get("raw_state")
    if b64 is None:
        return None, f"{p.name} has no 'raw_state' field"
    if not isinstance(b64, str) or not b64:
        return None, f"{p.name} 'raw_state' is not a non-empty string"
    try:
        base64.b64decode(b64, validate=True)
    except Exception as e:
        return None, f"{p.name} 'raw_state' is not valid base64: {e}"
    return b64, None


def _sub_plugin_names(pedalboard, plugin_path: str) -> list[str]:
    """Names inside a (possibly multi-plugin) .vst3 file; [] when unavailable."""
    try:
        return list(pedalboard.VST3Plugin.get_plugin_names_for_file(plugin_path))
    except Exception:
        return []


def _identity(plugin) -> dict[str, str]:
    """Who actually got loaded — the answer to "is this the right plugin?"."""
    out: dict[str, str] = {}
    for field in _IDENTITY_FIELDS:
        try:
            value = getattr(plugin, field, None)
        except Exception:
            value = None
        if value is not None:
            out[field] = str(value)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Open a VST3 plugin's native editor.")
    ap.add_argument("--plugin-path", required=True)
    ap.add_argument("--preset-in", default=None)
    ap.add_argument("--preset-out", required=True)
    # Which plugin inside the file to open. Omitted -> whatever the loader picks
    # first, which for a multi-plugin shell may not be the chain entry's plugin.
    ap.add_argument("--plugin-name", default=None)
    # Embedding (Windows): reparent the editor under this HWND and track this rect
    # file. 0/absent keeps today's floating-window behavior.
    ap.add_argument("--parent-hwnd", type=int, default=0)
    ap.add_argument("--rect-file", default=None)
    args = ap.parse_args()

    out = Path(args.preset_out)
    out.parent.mkdir(parents=True, exist_ok=True)

    # Diagnostics that must ride along on EVERY result the poller reads, so a
    # state that could not be restored is visible to the app, not just the log.
    extra: dict[str, str] = {}

    def write_out(payload: dict) -> None:
        out.write_text(json.dumps({**payload, **extra}), encoding="utf-8")

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
        from backend.modules.vst.host import (
            _apply_raw_state,
            _get_pedalboard,
            load_plugin_file,
        )

        pedalboard = _get_pedalboard()
    except Exception as e:
        write_out({"status": "error", "error": f"pedalboard import failed: {e}"})
        return 1

    names = _sub_plugin_names(pedalboard, args.plugin_path)
    if names:
        _log(f"plugins in file: {names}")
    if len(names) > 1 and not args.plugin_name:
        _log(
            "WARNING: multi-plugin file and no --plugin-name; the loader picks "
            f"'{names[0]}', which may not be the plugin the chain entry uses"
        )

    try:
        if args.plugin_name:
            # Explicit name: do NOT fall back to another sub-plugin — opening a
            # different one than was asked for is the bug, not the fix.
            _log(f"loading '{args.plugin_name}' from {args.plugin_path}")
            plugin = pedalboard.load_plugin(
                args.plugin_path, plugin_name=args.plugin_name
            )
        else:
            plugin = load_plugin_file(pedalboard, args.plugin_path)
    except Exception as e:
        hint = f" (plugins in file: {names})" if names else ""
        write_out({"status": "error", "error": f"load failed: {e}{hint}"})
        return 1

    identity = _identity(plugin)
    _log(f"loaded plugin identity: {json.dumps(identity, ensure_ascii=False)}")

    # Restore prior GUI state if we have it, so the editor opens where the user
    # left off rather than at plugin defaults. A failure here is REPORTED: a
    # plugin silently back at its defaults looks exactly like a working editor.
    state_b64, state_error = _read_state_in(args.preset_in)
    if state_error:
        extra["restore_error"] = state_error
        _log(f"WARNING: prior editor state not restored — {state_error}")
    elif state_b64 is None:
        where = args.preset_in or "--preset-in not given"
        _log(f"no prior editor state to restore ({where})")
    else:
        reason = _apply_raw_state(plugin, state_b64)
        if reason:
            extra["restore_error"] = reason
            _log(f"WARNING: prior editor state not restored — {reason}")
        else:
            _log(f"restored prior editor state ({len(state_b64)} base64 chars)")

    # Embed the editor under the Electron window (Windows). The watcher runs on a
    # daemon thread because show_editor() below blocks the main thread; it finds
    # the editor window by our PID, reparents it, and tracks the rect file. No-op
    # off win32 / without a parent HWND -> the editor floats as before.
    if args.parent_hwnd:
        try:
            from backend.modules.vst.win_embed import start_embed_watcher

            # The window title otherwise reads "Pedalboard" (the host library's
            # own), which tells the user nothing about what they are editing.
            display_name = (
                identity.get("name") or args.plugin_name or Path(args.plugin_path).stem
            )
            start_embed_watcher(args.parent_hwnd, args.rect_file, display_name)
        except Exception:
            pass

    try:
        _log(
            f"show_editor() for {args.plugin_path} "
            f"(plugin_name={args.plugin_name!r} parent_hwnd={args.parent_hwnd})"
        )
        plugin.show_editor()  # blocks until the window is closed
        _log("show_editor() returned (window closed)")
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
