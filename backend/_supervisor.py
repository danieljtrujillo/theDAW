"""Tiny supervisor that wraps backend.run so the user can hit
POST /api/admin/restart and have the server come back inside the SAME
console window. The inner process exits with sentinel code 88 to
request a restart; any other exit code (including 0) terminates the
supervisor.

Run via `python -m backend._supervisor` (start-dev.bat invokes this
instead of backend.run directly).
"""

from __future__ import annotations

import os
import subprocess
import sys
import time

RESTART_EXIT_CODE = 88


def main() -> int:
    inner_cmd = [sys.executable, "-m", "backend.run"]
    while True:
        print(
            f"[supervisor] launching: {' '.join(inner_cmd)}",
            flush=True,
        )
        try:
            rc = subprocess.call(inner_cmd, cwd=os.getcwd())
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
