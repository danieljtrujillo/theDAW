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

from backend import ports
from backend._update_sync import UPDATE_EXIT_CODE, run_dependency_sync
from backend.lib import lan_https, launch_token

RESTART_EXIT_CODE = 88
FRONTEND_URL = f"http://localhost:{ports.FRONTEND_PORT}"
#: The port the web UI binds this launch: ports.FRONTEND_PORT. main() stops the
#: stack instead of moving it; see ports.frontend_port_blocker for why.
_frontend_port = ports.FRONTEND_PORT
IS_WINDOWS = os.name == "nt"

# One ANSI color per stream so the merged feed stays readable. Blanked at
# startup if the console cannot do virtual-terminal sequences.
COLORS = {
    "backend": "\033[36m",  # cyan
    "frontend": "\033[35m",  # magenta
    "tunnel": "\033[33m",  # yellow
    "lan": "\033[94m",  # bright blue (the LAN HTTPS listener)
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
    # The port the web UI ACTUALLY took (main() chose it before this thread
    # starts). The backend advertises the web UI's address to other devices
    # through GET /api/network/lan; without this it would hand a phone :5173,
    # which in the case that moved us is another program entirely.
    env[ports.FRONTEND_PORT_ENV] = str(_frontend_port)
    cmd = [sys.executable, "-m", "backend.run"]
    while not _shutdown.is_set():
        _emit("stack", "launching backend: " + " ".join(cmd))
        proc = _spawn(cmd, cwd=os.getcwd(), env=env)
        if not _register_child(children, proc):
            # This loop can pass the _shutdown check above and spawn a backend
            # after main()'s kill loop has taken its snapshot: nothing else
            # would ever kill it, and it would hold :8600 against the next
            # launch. Same gate as the LAN listener.
            _kill_tree(proc)
            _emit("stack", "the stack is stopping - backend dropped")
            return
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


#: ``children`` is created on the main thread but appended to from the backend
#: supervisor thread and, now that the LAN listener no longer runs inline, from
#: the listener thread too -- which can still be waiting on a 120 s openssl when
#: the user hits Ctrl-C. A plain append races ``main()``'s final kill loop, and
#: one that lands after it leaves a vite holding the TLS port against the next
#: launch. So the list is CLOSED before that loop runs and a child registered
#: too late is killed by the thread that started it instead.
_children_lock = threading.Lock()
_children_closed = False


def _register_child(children: list, proc: subprocess.Popen) -> bool:
    """Add ``proc`` to the shutdown list.

    False when the stack is already tearing down, in which case the caller owns
    the process and must kill it itself.
    """
    with _children_lock:
        if _children_closed:
            return False
        children.append(proc)
        return True


def _close_children(children: list) -> list:
    """Take a snapshot of the shutdown list and refuse every later register."""
    global _children_closed
    with _children_lock:
        _children_closed = True
        return list(children)


def _start_lan_listener(children: list, frontend_dir: str) -> bool:
    """Start the second Vite listener — the same app over TLS — beside the
    plain http one, so another device on the network gets a SECURE CONTEXT
    and therefore an audio engine, a microphone and Web MIDI.

    Never fatal, at any step. The listener is a convenience; the stack has to
    come up without it, and the user has to be told in one line why it did
    not rather than left wondering why the LAN address is still plain http.
    A port that is already taken is reported through
    ``backend.ports.describe_occupant`` — the same sentence the backend's own
    port clash produces — instead of letting Vite die on strictPort.

    The child's environment starts from ``launch_token.child_env()``: vite
    runs the frontend's own devDependencies, and none of that may be able to
    send the desktop shell's ``X-TheDAW-Launch-Token``.
    """
    try:
        plan = lan_https.resolve_plan()
    except Exception as exc:  # pragma: no cover - resolve_plan does not raise
        _emit("stack", f"LAN (https): off - could not be worked out ({exc})")
        return False

    if not plan.enabled:
        _emit("stack", plan.log_line())
        return False

    occupant = ports.describe_occupant(plan.port)
    if occupant:
        _emit("stack", f"LAN (https): port {plan.port} is taken - {occupant}")
        return False

    try:
        env = lan_https.listener_env(plan, launch_token.child_env())
        proc = _spawn(lan_https.listener_command(plan), cwd=frontend_dir, env=env)
    except Exception as exc:
        _emit("stack", f"LAN (https): off - the listener could not start ({exc})")
        return False

    if not _register_child(children, proc):
        # The stack started stopping while openssl was running: nothing is left
        # to kill this on the way out, so it goes now.
        _kill_tree(proc)
        _emit("stack", "LAN (https): the stack is stopping - listener dropped")
        return False
    threading.Thread(target=_pump, args=("lan", proc), daemon=True).start()
    _emit("stack", plan.log_line())
    return True


def _port_open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.25):
            return True
    except OSError:
        return False


def _frontend_blocker() -> str | None:
    """Why the web UI cannot start, or None when its port is free.

    The launchers stop only theDAW's own stale listeners (backend.ports --free),
    so anything still on the port by now belongs to another program -- another
    project's Vite, or theDAW from another folder. That program is left running
    and theDAW does not start: moving to 5174 would open the app on a new
    browser origin with none of its saved settings and none of its microphone
    or MIDI permissions (ports.frontend_port_blocker has the whole reason).
    """
    return ports.frontend_port_blocker(ports.FRONTEND_PORT)


def _use_frontend_port(port: int) -> None:
    """Point everything that names the web UI's address at ``port``."""
    global _frontend_port, FRONTEND_URL
    _frontend_port = port
    FRONTEND_URL = f"http://localhost:{port}"


def _frontend_command(port: int) -> str:
    """How to start the web UI's Vite on ``port``.

    The preferred port keeps ``npm run dev`` exactly as before. Any other port
    runs the frontend's own Vite with an explicit ``--port``: the dev script
    already passes ``--port=5173``, and a second ``--port`` appended through
    ``npm run dev --`` reaches Vite as a list rather than a number.

    ``strictPort`` stays on, deliberately. The port was free when
    ``_frontend_blocker`` looked, and something else can still take it in
    the moment between that check and Vite's bind. With strictPort on, that
    race fails LOUDLY through Vite's own error, which the frontend pump prints
    in this console; with it off, Vite would silently slide to another port and
    every address this process then advertises -- the browser it opens, the
    tunnel, the LAN link -- would point at nothing. No retry loop here: a
    second guess would be just as racy, and the honest report is the error.
    """
    if port == ports.FRONTEND_PORT:
        return "npm run dev"
    return f"npx --no-install vite --port={port} --host=0.0.0.0"


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
        if _port_open("127.0.0.1", _frontend_port):
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
    if not _enable_ansi():
        for key in COLORS:
            COLORS[key] = ""
        globals()["RESET"] = ""

    here = os.getcwd()
    frontend_dir = os.path.join(here, "frontend")
    children: list[subprocess.Popen] = []

    _emit("stack", "theDAW dev stack — one console for backend + frontend + tunnel")

    # Before anything starts and before the console is minimized: when another
    # program holds the web UI's port, the stack stops here and this console,
    # still in front, says which program it is. theDAW.bat then waits for a
    # key, so the sentence stays on screen; theDAW.sh leaves it in its terminal.
    blocker = _frontend_blocker()
    if blocker:
        _emit("stack", f"theDAW cannot start: {blocker}")
        return 1

    # Drop the launcher console now so the user sees only the app, never the
    # log stream. It keeps running (restorable from the taskbar);
    # theDAW_KEEP_CONSOLE=1 keeps it in front for debugging.
    _minimize_console()

    # Frontend (Vite). ENABLE_HMR mirrors the previous launcher behavior.
    fe_env = os.environ.copy()
    fe_env["ENABLE_HMR"] = "true"
    port = ports.FRONTEND_PORT
    _use_frontend_port(port)
    frontend = _spawn(_frontend_command(port), cwd=frontend_dir, env=fe_env)
    children.append(frontend)
    threading.Thread(target=_pump, args=("frontend", frontend), daemon=True).start()

    # The same app over TLS on the LAN port, so another device gets a secure
    # context. Off, with a reason, when there is no network, no certificate or
    # the user turned it off; never blocks or fails the stack.
    #
    # On its own thread, like _warm_sidecars below, because getting to the
    # decision is slow: resolve_plan() shells out to openssl to mint an RSA key
    # (a 120 s timeout) and describe_occupant enumerates every listener on the
    # machine. Inline, all of that sat in front of the backend supervisor and
    # the browser, so a first launch waited on a certificate and a hung openssl
    # held the whole app for two minutes.
    threading.Thread(
        target=_start_lan_listener, args=(children, frontend_dir), daemon=True
    ).start()

    # Tunnel (optional) — only if localtunnel is installed.
    if shutil.which("lt"):
        tunnel = _spawn(
            f"lt --port {_frontend_port} --subdomain thedaw --print-requests"
        )
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
        # Closed first: a child registered after this point (the LAN listener
        # thread finishing its openssl call during shutdown) is killed by that
        # thread rather than missed by this loop.
        for proc in _close_children(children):
            _kill_tree(proc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
