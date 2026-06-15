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
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser

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


def _open_browser() -> None:
    if _browser_opened.is_set():
        return
    _browser_opened.set()
    try:
        webbrowser.open(FRONTEND_URL)
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
    """Open the browser the instant Vite is actually accepting connections on
    5173, instead of parsing its (buffered, colored) stdout for a "Local:" line
    that rarely matches and left the launch waiting on a 10s timer. Falls back to
    opening anyway after a long wait so the launch never hangs."""
    deadline = time.time() + 60.0
    while not _shutdown.is_set() and time.time() < deadline:
        if _port_open("127.0.0.1", 5173):
            _open_browser()
            return
        time.sleep(0.2)
    if not _shutdown.is_set():
        _open_browser()


def _warm_sidecars() -> None:
    """Pre-spawn the lazily-started sidecars once the backend is up, so they are
    ready before the user needs them instead of cold-starting on first use. The
    VJ dev server (port 5187) is the important one: a GET to /api/vj/url makes the
    backend ``vj`` module spawn it, so the VJ tab is already warm when opened."""
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
        tunnel = _spawn("lt --port 5173 --subdomain stabledaw --print-requests")
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
