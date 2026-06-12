"""Tiny supervisor that wraps backend.run so the user can hit
POST /api/admin/restart and have the server come back inside the SAME
console window. The inner process exits with sentinel code 88 to
request a restart; any other exit code (including 0) terminates the
supervisor.

theDAW.bat launches the full one-console dev stack (backend + frontend
+ tunnel) via `backend._devstack`, which embeds this same respawn
contract. This module is the backend-only path, runnable standalone
via `python -m backend._supervisor`.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time

RESTART_EXIT_CODE = 88


def main() -> int:
    inner_cmd = [sys.executable, "-m", "backend.run"]
    # Pass an env var the inner can sense, so /api/admin/restart knows
    # it's safe to schedule os._exit(88). If the user launches
    # backend.run directly (without this supervisor), the var won't be
    # present and the restart endpoint refuses with 412.
    inner_env = os.environ.copy()
    inner_env["SA3_SUPERVISOR_PRESENT"] = "1"
    while True:
        print(
            f"[supervisor] launching: {' '.join(inner_cmd)}",
            flush=True,
        )
        try:
            rc = subprocess.call(inner_cmd, cwd=os.getcwd(), env=inner_env)
        except KeyboardInterrupt:
            print("[supervisor] KeyboardInterrupt — exiting", flush=True)
            return 130
        if rc == RESTART_EXIT_CODE:
            print(
                "[supervisor] inner requested restart (rc=88) — respawning in 0.5s\n",
                flush=True,
            )
            time.sleep(0.5)
            continue
        print(
            f"[supervisor] inner exited with rc={rc} — supervisor terminating",
            flush=True,
        )
        return rc


if __name__ == "__main__":
    sys.exit(main())
