# Underfit Propagation

How the Underfit LoRA trainer is installed, launched, diagnosed, and updated
in theDAW.

## 1. Background

theDAW's `main` previously shipped the UNDERFIT center tab
(`frontend/src/views/UnderfitView.tsx`, an iframe on `http://localhost:8791`)
and the backend sidecar module (`backend/modules/underfit/`) that spawns the
dashboard at backend startup. The sidecar assumed an existing checkout at
`<repo-root>/underfit/` with a prepared `.venv`. On a machine without that
checkout, the tab polled `:8791` indefinitely and showed a spinner; the
sidecar's diagnostic ("checkout not found", "venv missing") was only available
from `GET /api/underfit/status`, which nothing displayed. Installing the
checkout and venv was a manual, undocumented step.

## 2. Design

Underfit's code is vendored into theDAW's repository as a
[git-subrepo](https://github.com/ingydotnet/git-subrepo) at `underfit/` (§3),
so a clone of theDAW includes it. The per-machine venv is created by the
existing first-run setup, `theDAW.bat` → `install/setup.ps1` (§4). The backend
sidecar spawns the dashboard on `:8791` (§5). While that port is down, the tab
shows the sidecar's diagnosis and the fix (§6). An update checker reports when
upstream has moved; syncing is a maintainer action (§7).

## 3. The vendored subrepo (`underfit/`)

The full Underfit project (dashboard server, training engine, docs) is tracked
in theDAW's history at `underfit/`. `underfit/.gitrepo` records the upstream
remote (`https://github.com/dada-bots/underfit`, branch `main`) and the last
synced commit, which is what allows later `git subrepo pull` syncs.

Excluded from tracking via the root `.gitignore`:

| Path | Reason |
|---|---|
| `underfit/state/` | training runs/checkpoints — multi-GB, per-machine |
| `underfit/.venv/` | Python environment — rebuilt per machine (§4) |
| `underfit/.gradio/` | runtime cache |
| `underfit/**/node_modules/`, `underfit/**/__pycache__/` | generated |

Vendoring was chosen because a first-run clone of an external repo requires
the network, depends on the upstream URL staying stable, and pins nothing —
whatever upstream is that day can drift from the sidecar's contract (ports,
endpoints, launch argv). The VJ engine's upstream rename broke first-run
resolution once already; the sibling-path convention was the fix there.
Vendoring pins the Underfit version to the theDAW commit that shipped it.

## 4. First-run environment setup

Underfit runs from its own venv at `underfit/.venv/`; its dependency stack
(PyTorch/CUDA pins) is isolated from theDAW's.

`theDAW.bat` preflights prerequisites on every launch and calls
`install/setup.ps1` for consent-based installation of anything missing. This
branch adds one check: when `underfit/` exists and `underfit/.venv` is
missing, the preflight offers `setup.ps1 -UnderfitVenv` (the script's standard
`Ask` consent flow), which runs `uv sync --inexact` in `underfit/` — the same
venv-create step as underfit's own `install.sh`.

The bootstrap creates the venv and stops there. That is enough to launch the
dashboard, where browsing and configuration work before any trainer backend
exists. Underfit's full setup wizard (`uv run python -m underfit.cli.setup`)
downloads model packs, clones the SA3 backend, and can prompt interactively,
so it stays an on-demand step run from a terminal when training is actually
wanted.

After clone + one consented `theDAW.bat` run, the dashboard is operational.

## 5. Runtime: the sidecar

`backend/modules/underfit/` (`module.json`, `router.py`, `sidecar.py`):

- On backend startup, spawns `underfit/dashboard/server.py` with Underfit's
  venv python on port `8791` (`UNDERFIT_DASHBOARD_PORT`), in a background
  thread, so a broken checkout cannot delay theDAW's boot.
- `GET /api/underfit/status` — non-spawning probe: `project_path`, `port`,
  `listening`, `process_alive`, `issues[]`, `ok`.
- `POST /api/underfit/start` — explicit spawn; no-ops when the port already
  answers, so a manually started instance is left alone.
- `POST /api/underfit/stop` — terminates the dashboard process this module
  spawned. Training runs are detached child processes and keep running
  through dashboard restarts.
- Overrides: `theDAW_UNDERFIT_PROJECT` (checkout path),
  `theDAW_UNDERFIT_PORT`, `theDAW_UNDERFIT_NO_AUTO_SPAWN`.

## 6. The tab

`frontend/src/views/UnderfitView.tsx` keeps its resilient iframe mount
(no-cors ping of `:8791`; the iframe mounts once the server answers). While
`:8791` is down, the tab fetches `GET /api/underfit/status` and renders one of
three states:

| State | Trigger | Shown |
|---|---|---|
| Install problem | probe `issues[]` non-empty | the probe issues verbatim ("underfit checkout not found at …", "venv python missing at …"), the fix (`run theDAW.bat`), a Re-check button |
| Installed, not running | no issues, `listening: false` | checkout path, port, a Start Underfit button (`POST /api/underfit/start`) |
| Connecting | backend not up yet, or spawn in progress | spinner, auto-retry every 3 s |

## 7. Updates

`backend/modules/underfit/updater.py`:

- `check()` (`GET /api/underfit/update-status`) compares the synced upstream
  commit in `underfit/.gitrepo` against `dada-bots/underfit` using
  `git ls-remote`, and caches the result in `data/underfit_update.json`
  (gitignored, per-machine, 15-minute TTL). The backend runs one background
  check at startup and logs when upstream is ahead.
- `apply()` (`POST /api/underfit/update`) runs `git subrepo pull` for the
  vendored copy when a user requests it. It refuses on a dirty tree (409),
  aborts cleanly on merge conflict, and restarts the dashboard after a
  successful pull. The pull lands as a normal local commit and reaches other
  users through branch review, the same as any change. `git subrepo pull
  underfit` from a terminal is equivalent.

Users receive the Underfit version that shipped with their theDAW commit.

## 8. New-user walkthrough

1. `git clone https://github.com/gantasmo/theDAW` — `underfit/` arrives with
   the clone.
2. Run `theDAW.bat` — preflight sees `underfit/.venv` missing, asks, creates
   it.
3. theDAW backend starts — the sidecar spawns the dashboard on `:8791`.
4. Open the UNDERFIT tab — the iframe mounts the dashboard.
5. If steps 1–3 were skipped or broke (moved folder, declined setup, port
   clash), the tab shows the probe's diagnosis and the fix.

## 9. Review manifest

| Change | Files | Commit(s) |
|---|---|---|
| Vendored underfit subrepo + sync metadata | `underfit/**`, `underfit/.gitrepo` | `030f3d8`, `2589b99` |
| Runtime-dir exclusions | `.gitignore` | `91d4cbb` |
| Tab diagnosis + start button | `frontend/src/views/UnderfitView.tsx` | `d364145` |
| Update checker + applier | `backend/modules/underfit/updater.py`, `router.py`, `.gitignore` (`data/underfit_update.json`) | `8913d1e` |
| Assistant MCP config → vendored copy | `backend/underfit_mcp_config.json` | `a1d1761` |
| Venv bootstrap in first-run setup | `install/setup.ps1` (`-UnderfitVenv`), `theDAW.bat` | `d869e1f` |
| This document | `docs/guides/underfit-propagation.md` | single commit |

## 10. Verification checklist

- [ ] Fresh clone of this branch in a temp dir: `underfit/dashboard/server.py`
      exists; `underfit/state/` and `underfit/.venv/` are absent and ignored.
- [ ] `git status` stays clean after a training run (`state/` ignored).
- [ ] Delete `underfit/.venv`, run `theDAW.bat`: consent prompt, venv rebuilt,
      dashboard answers on `:8791`.
- [ ] Temporarily rename `underfit/`, open the tab: install-problem panel with
      the probe issues. Rename back, Re-check recovers.
- [ ] With `theDAW_UNDERFIT_NO_AUTO_SPAWN=1`: tab shows "installed but not
      running"; Start Underfit spawns the dashboard.
- [ ] Update checker: `data/underfit_update.json` written; vendored copy
      untouched afterward.
- [ ] `docs/index.md` / RAG registration for this guide (follow-up; doc/RAG
      changes are approval-based).
