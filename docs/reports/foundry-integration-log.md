# VST Foundry Integration Log

Last updated: 2026-06-27

This document records the StableDAW-side integration work for the standalone
VST Foundry app at `VST-Foundry-UI/VST-UI-FOUNDRY`, plus the validation and
cleanup that happened while keeping the rest of the codebase unchanged unless
integration required it.

## Scope

- Integrate VST Foundry as a StableDAW tab.
- Keep the existing app structure intact.
- Touch only the backend, frontend tab shell, and Foundry-side lifecycle code
  needed for the embed.
- Verify the result with build, lint, compile, and runtime lifecycle checks.

## What Changed

- Added a StableDAW backend module for Foundry under `backend/modules/foundry/`.
- Added a Foundry center tab to the main DAW UI.
- Added a lazy-loaded Foundry view that embeds the standalone app in an iframe.
- Updated the standalone Foundry server so StableDAW can identify it safely and
  shut it down cleanly.
- Fixed the Foundry sidecar stop path so it only reports success when the
  server is actually gone, instead of assuming a kill succeeded.

## Files Added Or Updated

- `backend/modules/foundry/module.json`
  - Registers the module as `foundry`.
  - Sets the StableDAW API prefix to `/api/foundry`.
  - Marks the module as backend-enabled and hidden from the sidebar.

- `backend/modules/foundry/router.py`
  - Exposes the Foundry URL endpoint used by the iframe view.
  - Exposes a stop endpoint for manual shutdown.
  - Returns an HTTP error when Foundry is still alive after a stop request.
  - Hooks Foundry shutdown into module teardown.

- `backend/modules/foundry/sidecar.py`
  - Resolves the standalone app path at `VST-Foundry-UI/VST-UI-FOUNDRY`.
  - Starts the Foundry server as a sidecar process.
  - Probes health using the Foundry-specific health contract.
  - Requests graceful shutdown before falling back to process termination.
  - Re-checks the port after shutdown so a stuck process is not treated as
    stopped.

- `frontend/src/state/appUiStore.ts`
  - Added `foundry` to the center tab list.

- `frontend/src/components/layout/CenterTabBar.tsx`
  - Added the Foundry tab entry and icon.

- `frontend/src/components/layout/DAWCenterPanel.tsx`
  - Lazy-loads the Foundry view.
  - Warms the Foundry chunk the same way other embedded tabs are handled.

- `frontend/src/views/FoundryView.tsx`
  - Fetches the Foundry URL from the backend.
  - Shows loading, ready, and error states.
  - Renders the standalone Foundry app in an iframe.

- `VST-Foundry-UI/VST-UI-FOUNDRY/server.ts`
  - Reports `{ app: "vst-foundry" }` from health so StableDAW can distinguish
    Foundry from any other process on the port.
  - Adds `/api/shutdown` for graceful stop requests.
  - Shuts down the HTTP server with connection cleanup before exiting.

## Validation

The current state was verified with:

- `python -m py_compile backend\modules\foundry\sidecar.py backend\modules\foundry\router.py`
- `npm run lint` in `frontend`
- `npm run build` in `VST-Foundry-UI/VST-UI-FOUNDRY`
- A direct sidecar lifecycle probe:
  - `probe-before` showed Foundry was not listening.
  - `ensure_running()` started the server at `http://localhost:5472`.
  - `probe-after-start` showed the server listening and alive.
  - `stop-after` returned `True`.
  - `probe-after-stop` showed the server fully stopped.

## Cleanup And Boundaries

- Unrelated package-file spillover was reverted so the integration stays focused.
- `.vscode/settings.json` was left untouched because it pre-existed this work.
- No broad frontend redesign or unrelated backend refactor was added.

## Production Hardening (2026-06-27)

A follow-up pass took the integration from "works on my machine" to something a
fresh clone can launch and a user can rely on.

- **Install-process integration.** Both launchers now provision Foundry as part
  of the normal startup, so there is no separate setup step:
  - `theDAW.bat` and `theDAW-desktop.bat` run `npm install` under
    `VST-Foundry-UI\VST-UI-FOUNDRY` when its `node_modules` is missing, and
    abort with a clear message if that install fails.
  - On every relaunch, both launchers kill any process still listening on
    port 5472 so a stale sidecar from a previous run cannot block the fresh one.

- **Sidecar logging + teardown robustness.** Sidecar output is captured to
  `data/logs/foundry-sidecar.log` for diagnosis, and shutdown was made
  defensive: graceful `/api/shutdown` first, then process terminate/kill, then a
  port re-check, and finally a PID-on-port fallback (`netstat` + signal) so a
  stuck server is never reported as stopped. Teardown is wired into FastAPI's
  shutdown event so closing the backend closes Foundry.

- **Responsive UI fixes.** The embedded view and the Foundry workspace were
  adjusted so panels, canvas, and toolbar resize cleanly inside theDAW's tab
  frame instead of overflowing or clipping.

- **Repo hygiene.** Editing/backup `*.bak-*` cruft from the vendored app was
  moved into `VST-Foundry-UI/VST-UI-FOUNDRY/deprecated/` (per the no-delete
  rule) and `*.bak` / `*.bak-*` were added to `.gitignore` so the noise stays
  out of the tree.

- **Docs + RAG.** Added a user-facing guide at `docs/guides/foundry.md`,
  registered it in `backend/rag.py` (`DOC_PATHS`) so the in-app assistant can
  answer Foundry questions, and added Foundry notes to the Windows setup and
  troubleshooting guides.

## Result

StableDAW now has a dedicated Foundry tab backed by a standalone Foundry
sidecar, and the sidecar can be started, embedded, and stopped reliably. A fresh
clone provisions and launches it through the normal `theDAW.bat` flow, the tab is
documented for users, and the assistant can answer questions about it.
