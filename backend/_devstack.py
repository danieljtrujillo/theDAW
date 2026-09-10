"""theDAW dev stack — ONE console for the whole app.

Runs the backend, the Vite frontend, and (optionally) the localtunnel in a
single terminal, multiplexing their output as prefixed ``[backend]`` /
``[frontend]`` / ``[tunnel]`` log lines. ``theDAW.bat`` invokes this so the
user watches everything in one window instead of three.

The backend keeps the supervisor contract: it runs ``backend.run`` with
``SA3_SUPERVISOR_PRESENT=1`` and respawns it when it exits with code 88, so
the in-app Settings -> Restart Server button still works (POST
``/api/admin/restart`` schedules ``os._exit(88)``). Any other backend exit
code, or Ctrl-C, tears the whole stack down.

Run:  python -m backend._devstack
"""

from __future__ import annotations

import os
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

from backend._update_sync import UPDATE_EXIT_CODE, run_dependency_sync

RESTART_EXIT_CODE = 88
FRONTEND_URL = "http://localhost:5173"
IS_WINDOWS = os.name == "nt"

# One ANSI color per stream so the merged feed stays readable. Blanked at
# startup if the console cannot do virtual-terminal sequences.
COLORS = {
    "backend": "\033[36m",  # cyan
    "frontend": "\033[35m",  # magenta
    "tunnel": "\033[33m",  # yellow
    "stack": "\033[32m",  # green (our own notices)
}
RESET = "\033[0m"

_print_lock = threading.Lock()
_shutdown = threading.Event()
_browser_opened = threading.Event()


def _enable_ansi() -> bool:
    """Turn on virtual-terminal processing on legacy Windows consoles."""
    if not IS_WINDOWS:
        return True
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
        mode = ctypes.c_uint32()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            return False
        # ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
        return bool(kernel32.SetConsoleMode(handle, mode.value | 0x0004))
    except Exception:
        return False


def _emit(tag: str, line: str) -> None:
    color = COLORS.get(tag, "")
    with _print_lock:
        sys.stdout.write(f"{color}[{tag}]{RESET} {line.rstrip()}\n")
        sys.stdout.flush()


def _spawn(cmd, cwd=None, env=None) -> subprocess.Popen:
    # On Windows a string command goes through the shell so `npm` / `lt` resolve
    # their .cmd shims. POSIX has no such shim, and shell=False with a string
    # makes Popen exec a file literally named "npm run dev" -> FileNotFoundError,
    # which is why this module could not start the stack on Linux/macOS. Split
    # into argv there instead of turning the shell on (no quoting surprises).
    if not IS_WINDOWS and isinstance(cmd, str):
        cmd = shlex.split(cmd)
    return subprocess.Popen(
        cmd,
        cwd=cwd,
        env=env,
        shell=IS_WINDOWS and isinstance(cmd, str),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )


def _pump(tag: str, proc: subprocess.Popen) -> None:
    """Stream one child's merged stdout/stderr as prefixed log lines."""
    if proc.stdout is None:
        return
    for line in proc.stdout:
        _emit(tag, line)


# The holding page the browser is sent to BEFORE Vite is listening. See
# _open_browser() for why it exists; it redirects itself to FRONTEND_URL the
# instant the dev server answers.
_HOLDING_PAGE = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>theDAW · by GANTASMO</title>
    <style>
      html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
      body {
        display: flex; flex-direction: column; align-items: center; gap: 6px;
        padding-top: 40px; box-sizing: border-box; user-select: none;
      }
      .mark { position: relative; width: 100%; flex-shrink: 0; height: 50vh; }
      .mark span {
        position: absolute; inset: 0; display: flex; align-items: flex-end;
        justify-content: center; padding-bottom: 8px;
        font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
        font-size: 36px; line-height: 40px; font-weight: 900;
        text-transform: uppercase; letter-spacing: 0.36em; padding-left: 0.36em;
        color: #f4f4f5;
      }
      .by {
        font-family: system-ui, sans-serif; font-weight: 700;
        letter-spacing: 0.18em; font-size: clamp(11px, 2.2vh, 24px);
        color: #cbb9e8;
      }
      img { flex-shrink: 0; height: clamp(34px, 8vh, 110px); max-width: 70vw; object-fit: contain; }
      a { position: absolute; bottom: 8px; right: 12px; font: 9px monospace; color: #3f3f46; }
    </style>
  </head>
  <body>
    <div class="mark"><span>theDAW</span></div>
    <span class="by">by</span>
    <img src="__LOGO__" alt="GANTASMO" draggable="false" onerror="this.remove()" />
    <a href="__URL__">open manually</a>
    <script>
      var URL_ = "__URL__";
      // An <img> probe, not fetch(): this page is served from file://, whose
      // origin is "null", so fetch() to http://localhost is blocked by CORS.
      // Image loads are not subject to that check.
      function probe() {
        var i = new Image();
        i.onload = function () { location.replace(URL_); };
        i.onerror = function () { setTimeout(probe, 150); };
        i.src = URL_ + "/favicon.svg?probe=" + Date.now();
      }
      probe();
      // Hard backstop: go there anyway rather than hold this page forever.
      setTimeout(function () { location.replace(URL_); }, 60000);
    </script>
  </body>
</html>
"""


def _holding_page_url() -> str | None:
    """Write the holding page to a temp file and return its file:// URL.

    Returns None if it cannot be written, so the caller falls back to the plain
    behaviour of opening FRONTEND_URL directly.
    """
    try:
        tmp = Path(tempfile.gettempdir())
        # The logo has to be copied NEXT TO the page: Chromium refuses to load a
        # file:// subresource that lives in a different directory from the
        # file:// document requesting it, so referencing it in the repo renders
        # a broken-image icon. A sibling copy loads fine.
        logo_ref = ""
        src = (
            Path(__file__).resolve().parent.parent
            / "frontend"
            / "public"
            / "GANTASMO_LOGO.webp"
        )
        if src.exists():
            dst = tmp / "thedaw-starting-logo.webp"
            try:
                shutil.copyfile(src, dst)
                logo_ref = dst.name
            except OSError:
                logo_ref = ""
        html = _HOLDING_PAGE.replace("__URL__", FRONTEND_URL).replace(
            "__LOGO__", logo_ref
        )
        target = tmp / "thedaw-starting.html"
        target.write_text(html, encoding="utf-8")
        return target.as_uri()
    except Exception:
        return None


def _open_browser() -> None:
    """Open the browser IMMEDIATELY, on a holding page that waits for Vite.

    Previously this was called only once :5173 was accepting connections, which
    put the browser's own cold start (seconds, if it was not already running)
    AFTER Vite's ~1.4s boot instead of alongside it — and the user watched a
    blank window for the sum of the two. The holding page lets the two overlap:
    the browser starts up showing theDAW's own boot screen, and replaces itself
    with the real app the moment the dev server answers.

    If the temp file cannot be written we just open FRONTEND_URL as before.
    """
    if _browser_opened.is_set():
        return
    _browser_opened.set()
    try:
        webbrowser.open(_holding_page_url() or FRONTEND_URL)
    except Exception:
        pass


def _minimize_console() -> None:
    """Drop the launcher console out of sight once the app window is up — the
    user should only ever see theDAW, not the log stream. The console keeps
    running (logs land there, restorable from the taskbar). Set
    ``theDAW_KEEP_CONSOLE=1`` to keep it in front (debugging the stack)."""
    if not IS_WINDOWS or os.environ.get("theDAW_KEEP_CONSOLE"):
        return
    try:
        import ctypes

        hwnd = ctypes.windll.kernel32.GetConsoleWindow()
        if hwnd:
            ctypes.windll.user32.ShowWindow(hwnd, 6)  # SW_MINIMIZE
    except Exception:
        pass


def _kill_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        if IS_WINDOWS:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        else:
            proc.terminate()
    except Exception:
        pass


def _run_backend(children: list) -> None:
    """Backend supervisor loop: respawn on rc=88, else trip shutdown."""
    env = os.environ.copy()
    env["SA3_SUPERVISOR_PRESENT"] = "1"
    cmd = [sys.executable, "-m", "backend.run"]
    while not _shutdown.is_set():
        _emit("stack", "launching backend: " + " ".join(cmd))
        proc = _spawn(cmd, cwd=os.getcwd(), env=env)
        children.append(proc)
        _pump("backend", proc)  # blocks until the backend process exits
        rc = proc.wait()
        if rc == RESTART_EXIT_CODE and not _shutdown.is_set():
            _emit("stack", "restart requested (rc=88) — respawning backend")
            time.sleep(0.5)
            continue
        if rc == UPDATE_EXIT_CODE and not _shutdown.is_set():
            # In-app update: the code is pulled; sync wheels + npm packages
            # while no backend holds the venv, then respawn (see
            # backend/_update_sync.py). Vite keeps running and picks up new
            # frontend packages on the next request.
            _emit(
                "stack", "update pulled (rc=89) - syncing dependencies before respawn"
            )
            sync_rc = run_dependency_sync(
                Path(os.getcwd()), lambda line: _emit("update", line)
            )
            if sync_rc != 0:
                _emit("stack", f"dependency sync exited {sync_rc} - respawning anyway")
            continue
        if not _shutdown.is_set():
            _emit("stack", f"backend exited rc={rc} — stopping the stack")
        _shutdown.set()
        return


def _port_open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.25):
            return True
    except OSError:
        return False


def _wait_then_open_browser() -> None:
    """Send the browser to the holding page right away, then report readiness.

    The browser no longer waits on :5173 — _open_browser()'s holding page does
    that from inside the browser, so the browser's cold start and Vite's boot
    happen at the same time instead of one after the other. This thread stays
    only to log when the dev server actually came up.
    """
    _open_browser()
    deadline = time.time() + 60.0
    while not _shutdown.is_set() and time.time() < deadline:
        if _port_open("127.0.0.1", 5173):
            _emit("stack", f"frontend ready at {FRONTEND_URL}")
            return
        time.sleep(0.05)


def _warm_sidecars() -> None:
    """Optionally pre-spawn the VJ dev server (:5187) once the backend is up.

    OFF by default. Pre-warming spawns a SECOND full Vite/node process that then
    stays resident for the whole session even if the VJ tab is never opened.
    Opening the VJ tab calls /api/vj/url, which spawns it on demand anyway, so the
    only cost of deferring is a few seconds on first VJ open. Set
    ``THEDAW_PREWARM_VJ=1`` to restore eager warming (e.g. a VJ-first / live
    performance launch)."""
    prewarm = os.environ.get("THEDAW_PREWARM_VJ", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    if not prewarm:
        _emit(
            "stack",
            "VJ sidecar: lazy (spawns on first VJ-tab open; "
            "set THEDAW_PREWARM_VJ=1 to pre-warm)",
        )
        return
    base = "http://127.0.0.1:8600"
    deadline = time.time() + 120.0
    while not _shutdown.is_set() and time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{base}/api/health", timeout=2) as resp:
                if resp.status == 200:
                    break
        except Exception:
            pass
        time.sleep(0.5)
    if _shutdown.is_set():
        return
    try:
        with urllib.request.urlopen(f"{base}/api/vj/url", timeout=120) as resp:
            resp.read()
        _emit("stack", "VJ sidecar warmed (dev server spawning on :5187)")
    except Exception as exc:
        _emit("stack", f"VJ sidecar warm-up skipped: {exc}")


def main() -> int:
    # Drop the launcher console immediately so the user sees only the app, never
    # the log stream. It keeps running (restorable from the taskbar);
    # theDAW_KEEP_CONSOLE=1 keeps it in front for debugging.
    _minimize_console()

    if not _enable_ansi():
        for key in COLORS:
            COLORS[key] = ""
        globals()["RESET"] = ""

    here = os.getcwd()
    frontend_dir = os.path.join(here, "frontend")
    children: list[subprocess.Popen] = []

    _emit("stack", "theDAW dev stack — one console for backend + frontend + tunnel")

    # Frontend (Vite). ENABLE_HMR mirrors the previous launcher behavior.
    fe_env = os.environ.copy()
    fe_env["ENABLE_HMR"] = "true"
    frontend = _spawn("npm run dev", cwd=frontend_dir, env=fe_env)
    children.append(frontend)
    threading.Thread(target=_pump, args=("frontend", frontend), daemon=True).start()

    # Tunnel (optional) — only if localtunnel is installed.
    if shutil.which("lt"):
        tunnel = _spawn("lt --port 5173 --subdomain thedaw --print-requests")
        children.append(tunnel)
        threading.Thread(target=_pump, args=("tunnel", tunnel), daemon=True).start()
    else:
        _emit("stack", "localtunnel not installed — public link skipped")

    threading.Thread(target=_wait_then_open_browser, daemon=True).start()
    threading.Thread(target=_warm_sidecars, daemon=True).start()

    # Backend supervisor on its own thread so Ctrl-C lands in main().
    backend = threading.Thread(target=_run_backend, args=(children,), daemon=True)
    backend.start()

    try:
        while not _shutdown.is_set():
            time.sleep(0.3)
    except KeyboardInterrupt:
        _emit("stack", "Ctrl-C — stopping all processes")
    finally:
        _shutdown.set()
        for proc in children:
            _kill_tree(proc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
