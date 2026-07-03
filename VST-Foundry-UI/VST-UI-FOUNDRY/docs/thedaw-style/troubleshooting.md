# Troubleshooting — Ports, Spawns, and Common Failures

Reference for when Foundry will not start, a port is stuck, an import is rejected,
or the native VST3 shell will not build. It covers the two ways Foundry runs
(embedded as a theDAW sidecar, and standalone from `launch.bat`), the ports each
uses, the exact error messages the code emits and what each one means, where the
logs land, and the copy-paste commands to clear a jammed port. Plain descriptions
of what each failure is and how to resolve it. For how the sidecar is wired into
theDAW see [thedaw-integration.md](thedaw-integration.md); for the `.gan`
container see [gan-format.md](gan-format.md); for the native shell see
[vst3-export.md](vst3-export.md).

## Ports at a glance

Foundry serves everything — UI, API, SSE relay — from a single port. Vite runs in
middleware mode on that same port, so there is no separate frontend port.

| Port | Owner | Where set | Notes |
|---|---|---|---|
| `5472` | Foundry relay + dev server | `server/config.ts` (`THEDAW_FOUNDRY_PORT` \|\| `PORT` \|\| `5472`) | Bound to `127.0.0.1` only. The one port Foundry actually listens on. |
| `5473` (`PORT+1`) | Vite HMR WebSocket, standalone only | `server.ts` (`hmr: { port: PORT + 1 }`) | Only opened when HMR is on. Disabled entirely when embedded. |
| `24678` | Vite's default HMR port | Vite default | Foundry overrides it to `PORT+1` so multiple instances never collide on it. |
| `8600` | theDAW backend (FastAPI) | theDAW | Not Foundry, but `theDAW.bat` clears it on launch. |
| `5173` | theDAW frontend (Vite) | theDAW | Not Foundry, but `theDAW.bat` clears it on launch. |
| `5187` | theDAW auxiliary service | theDAW | Not Foundry, but `theDAW.bat` clears it on launch. |

> The relay binds `127.0.0.1`, never `0.0.0.0`. Foundry is a local-only tool; you
> cannot reach it from another machine, and that is intentional. A CORS
> allow-list (`server/config.ts`) further rejects any browser `Origin` other than
> `http://localhost:5472` / `http://127.0.0.1:5472`. Extra origins can be added
> via `FOUNDRY_ALLOWED_ORIGINS` (comma-separated).

## Relay / dev-server port conflicts

The default port is `5472`. Override it with `THEDAW_FOUNDRY_PORT` (both the
sidecar and the server read the same variable), or with `PORT` when run
standalone.

The symptom depends on who hits the busy port first:

| Symptom | Origin | Meaning |
|---|---|---|
| Console: `Port 5472 is already in use. Stop the existing process and try again.` then exit | `server.ts` `EADDRINUSE` handler | The Foundry server itself could not bind. Another process (often a previous Foundry that did not shut down) holds the port. |
| `Port 5472 is already in use, but it is not VST Foundry.` (503 from `/api/foundry/url`) | `sidecar.ensure_running()` | The port is listening, but `GET /api/health` did not return `"app":"vst-foundry"`. Some other service grabbed `5472`. |

The sidecar distinguishes "our server is already up" from "someone else is on the
port" by probing `http://127.0.0.1:5472/api/health` and checking the body for
`"app":"vst-foundry"`. If that string is present it reuses the running instance;
if the port is merely listening it refuses to spawn and raises the second error
above.

To find and clear whatever holds the port on Windows:

```bat
netstat -ano | findstr ":5472 " | findstr "LISTENING"
taskkill /F /PID <pid-from-the-last-column>
```

Then reopen the Foundry tab (or re-run `launch.bat`). To move Foundry off `5472`
entirely instead of clearing the port:

```bat
set THEDAW_FOUNDRY_PORT=5480
```

## Stale :5472 listeners — theDAW.bat clears them

A Foundry sidecar that was force-killed (crash, closed console, killed parent) can
leave a Node process still bound to `5472`. On the next theDAW launch this would
surface as the "already in use, but it is not VST Foundry" error above — except
`theDAW.bat` pre-clears it. Before starting anything, the launcher kills stale
`LISTENING` processes on all of theDAW's ports, `5472` included:

```bat
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5472 " ^| findstr "LISTENING"') do taskkill /F /PID %%a
```

So a fresh `.\theDAW.bat` is the sanctioned fix for a stuck port — it clears
`5173`, `8600`, `5187`, and `5472`, waits one second, then boots. In normal
operation you should not need to run `taskkill` by hand; theDAW also stops the
sidecar cleanly on backend exit (`POST /api/shutdown`, then terminate/kill, then a
Windows `netstat` PID sweep as a last resort), plus an `atexit` hook and the
FastAPI `shutdown` event.

## Sidecar spawn failures

When you open the Foundry tab, `FoundryView.tsx` calls `GET /api/foundry/url`,
which runs `sidecar.ensure_running()`. That function reuses a live server if one
answers, otherwise it runs `npm install` (only if `node_modules` is missing) and
spawns `npm run dev`, then polls `/api/health` for up to **90 seconds**
(`PORT_READY_TIMEOUT_SEC`) at a 0.5 s interval. Every failure raises a
`RuntimeError` that the route returns as a `503` with the message as `detail`, and
the tab shows "VST Foundry did not start" with that text.

| Message (from `sidecar.py`) | Cause | Fix |
|---|---|---|
| `VST Foundry project not found at <path>. Set THEDAW_FOUNDRY_PROJECT to override.` | The project directory does not exist at the resolved path. | Confirm `VST-Foundry-UI/VST-UI-FOUNDRY` exists next to theDAW, or set `THEDAW_FOUNDRY_PROJECT` to its absolute path. |
| `VST Foundry sidecar: npm not found (<err>). Install Node.js.` | `npm` is not on `PATH`. | Install Node.js; reopen the console so `PATH` refreshes. |
| `npm install failed in <path> (rc=<n>). Run it manually to see the full error output, then retry.` | The one-time dependency install failed (network, permissions, broken optional dep). | Run `npm install` in the project folder by hand and read the real error; see [npm install issues](#npm-install-issues). |
| `Failed to launch VST Foundry sidecar: <err>. Is npm on PATH?` | The `npm run dev` spawn itself failed to start. | Verify `npm` runs from a plain shell in the project folder. |
| `VST Foundry sidecar exited before becoming ready (rc=<n>). Check package.json scripts.` | The dev process started but died before opening the port (bad script, TypeScript error, missing dep). | Read `foundry-sidecar.log` (the message appends its tail); fix the underlying crash. |
| `VST Foundry sidecar didn't open port 5472 within 90s.` | The process is alive but never became reachable within the timeout. | Check the log tail included in the message; a slow first install or a hung build is the usual cause. |

The `RuntimeError` messages for the exit / timeout cases append the tail of
`foundry-sidecar.log` (see [Where the logs land](#where-the-logs-land)), so the
real stack trace travels with the error into the tab.

`GET /api/foundry/status` returns a structured probe you can read without opening
the tab — it reports the resolved `project_path`, the `port`, whether Foundry is
`listening`, whether the child `process_alive`, the `url`, and an `issues` list
(missing project dir, missing `package.json`, `npm` not on `PATH`).

> The tab does its own retry loop: `FoundryView.tsx` re-requests `/api/foundry/url`
> up to **20 times, every 2 s** (about 40 s of front-end patience) before it shows
> the error card. The Reload button resets that counter and starts over, which is
> the first thing to try after fixing a cause above.

## Dev-server restarts and HMR

The `dev` script is `tsx server.ts` — plain `tsx`, not `tsx --watch`. Editing
server source therefore does **not** hot-restart the Express process; you stop and
relaunch it (Reload the tab, or Ctrl+C and re-run `launch.bat`). Front-end module
edits are handled by Vite running in middleware mode inside the same server.

| Mode | HMR | Behavior |
|---|---|---|
| Embedded in theDAW | Off (`DISABLE_HMR=true`) | The sidecar passes `DISABLE_HMR=true`, so Vite opens no HMR WebSocket. This removes the unreachable HMR socket whose retries otherwise flood the browser console with `ERR_CONNECTION_REFUSED`. Reload the tab to pick up changes. |
| Standalone (`launch.bat`) | On, port `PORT+1` (`5473`) | Vite serves HMR on a per-instance port so multiple standalone Foundry instances never collide on Vite's fixed default (`24678`). Client edits refresh live; server edits still need a restart. |

> If the browser console fills with `ERR_CONNECTION_REFUSED` toward a WebSocket,
> you are almost certainly running embedded with HMR expected on. That is normal
> only when `DISABLE_HMR` was not set — inside theDAW it always is. There is no
> file-watch auto-restart of the Node process in this repo; do not wait for one.

## npm install issues

Dependencies install lazily the first time Foundry runs, from three entry points:

- `theDAW.bat` runs `npm install` in `VST-Foundry-UI/VST-UI-FOUNDRY` if its
  `node_modules` is missing, before launching the stack.
- The sidecar (`ensure_running`) runs `npm install` if `node_modules` is missing,
  capturing all output to `foundry-sidecar.log`.
- `launch.bat` (standalone) runs `npm install` if `node_modules` is missing.

| Symptom | Cause | Fix |
|---|---|---|
| `[WARN] Native binaries broken (known npm optional-dep bug)` in `launch.bat` | npm installed an optional native dep silently broken. `launch.bat` probes it with `node -e "require('./node_modules/@tailwindcss/oxide/index.js')"`. | `launch.bat` auto-heals: it deletes `node_modules` + `package-lock.json` and reinstalls. |
| Tailwind / CSS build errors mentioning `@tailwindcss/oxide` or `lightningcss` | The platform-specific optional dep (`@tailwindcss/oxide-win32-x64-msvc`, `lightningcss-win32-x64-msvc`) did not install. | Delete `node_modules` and `package-lock.json`, then `npm install` again (a clean reinstall, same as the auto-heal). |
| `npm install failed ... (rc=<n>)` from the sidecar | Install failed under theDAW; the error is swallowed into the log. | Run `npm install` manually in the project folder to see the full error, fix it, then reopen the tab. |

Manual clean reinstall (matches what `launch.bat` does on the native-binary
warning):

```bat
cd VST-Foundry-UI\VST-UI-FOUNDRY
rmdir /s /q node_modules
del /f /q package-lock.json
npm install
```

> Node.js must be on `PATH` for every path above. `launch.bat` and the sidecar
> both hard-fail with an install/spawn error if `npm` is not found. Node is
> already a theDAW prerequisite, so inside theDAW this is only an issue on a
> broken `PATH`.

## .gan import failures

Importing a Foundry export into theDAW goes through `POST /api/plugin/import-owl`
(`owl_import.import_vst_foundry`), which reads a `project.json` (plus a
`background.png` beside it) and composes a controller-kind `.gan`. Rejections
return `400`/`404` with the message shown.

| Message | Origin | Meaning / fix |
|---|---|---|
| `project.json not found at: <path>` | `router.import_owl` | The path (or `<path>/project.json` for a folder) does not resolve to a file. Point at the export's `project.json` or its containing folder. |
| `project.json not found: <path>` | `import_vst_foundry` | Same, raised deeper as `FileNotFoundError`. Confirm the export exists. |
| `Import failed: Invalid VST Foundry export: 'elements' is not a list` | `import_vst_foundry` (`ValueError`) | The export JSON has no valid `elements` array — it is not a Foundry `project.json`, or it is truncated/corrupt. Re-export from Foundry. |
| `Invalid .gan: missing manifest.json` | `GanFile.info` (`ValueError`) | The `.gan` (a ZIP) has no `manifest.json`. The file is corrupt or not a `.gan`. |
| `This .gan uses format v<N>, but theDAW supports up to v1. Please update theDAW.` | `GanFile.info` (`ValueError`) | The `.gan` was written by a newer format version. Update theDAW. |
| `Plugin not found: <id>` | `_ensure_runtime` / `open` | No installed `.gan` with that id in `data/plugins`. Import it first, or open by `path`. |
| `Asset not found` (404 from `/runtime/...`) | `serve_runtime` | The requested runtime asset does not exist or was blocked by the path-traversal guard. Re-open the plugin to re-extract its runtime. |

Import behavior worth knowing when a `.gan` looks wrong rather than erroring:

- **Canvas size** is taken from the `background.png` IHDR pixel size first, then
  explicit `canvasWidth`/`canvasHeight` (or `width`/`height`), then the element
  extents, then a default of `1672 x 941`. A misplaced layout usually means the
  background PNG was missing at import time, so the fallback size was used.
- **Element types**: `CustomCode` becomes its own `el_<id>.html` iframe; a native
  `Knob` becomes a draggable rotary; `Image` and unknown types render as
  non-interactive placeholders (the importer logs each one rather than dropping
  it). A control that "does nothing" is often an `Image`/unknown placeholder.
- **Stale runtime**: an installed `.gan` is extracted to
  `data/plugins/_runtime/<id>/` and stamped with the source `.gan`'s mtime. If a
  re-packaged plugin still renders the old layout, the stamp guards against that —
  re-opening re-extracts when the `.gan` is newer. `.html` is served
  `Cache-Control: no-cache` so an open iframe never keeps a stale copy.

See [gan-format.md](gan-format.md) for the container layout and
[custom-code.md](custom-code.md) for how `CustomCode` elements are wrapped.

## VST3 shell build prerequisites

The native `FoundryShell.vst3` is a separate artifact from the web app — a
WebView-hosted iPlug2 plugin built by MSBuild from
`vst3-shell/FoundryShell-src/projects/FoundryShell-vst3.vcxproj`. The web export
(`src/lib/vst3Export.ts`) only produces the DATA half (`manifest.json` + `ui/`)
that drops into an already-built shell; it compiles no binary. See
[vst3-export.md](vst3-export.md) for how the two halves fit together.

| Requirement | Detail |
|---|---|
| Toolset | MSBuild with `PlatformToolset v143` (Visual Studio 2022 / Build Tools 2022, C++ desktop workload). |
| Configs / platforms | `Debug`, `Release`, `Tracer` × `x64`, `ARM64EC`. Output: `build-win\vst3\<Platform>\<Configuration>\`, `TargetExt .vst3`. |
| NuGet: WebView2 | `Microsoft.Web.WebView2` **1.0.2903.40** (`WebView2LoaderPreference` is `Static`). |
| NuGet: WIL | `Microsoft.Windows.ImplementationLibrary` **1.0.240803.1**. |
| NuGet restorer | `vst3-shell/nuget.exe` restores the two packages above from `packages.config`. |
| iPlug2 SDK | Full clone at `vst3-shell/iPlug2/` (gitignored — never committed). |
| VST3 SDK | Steinberg VST3 SDK under `Dependencies/IPlug/VST3_SDK/` (gitignored). |

If the NuGet packages are not restored, the build stops early with the
`EnsureNuGetPackageBuildImports` error: *"This project references NuGet package(s)
that are missing on this computer. Use NuGet Package Restore to download them ...
The missing file is `..\packages\...`"*. Restore before building:

```bat
cd VST-Foundry-UI\VST-UI-FOUNDRY\vst3-shell
nuget.exe restore FoundryShell-src\projects\packages.config -PackagesDirectory FoundryShell-src\projects\packages
```

After a successful compile, the `CopyFoundryWebUI` post-build target copies
`resources/web/ui/**` into the built bundle's `Contents/Resources/ui/` (and into
the installed `VST3_X64_PATH` copy when present), so the shell runs standalone
with its default UI before any Foundry export is dropped in.

> **Note — build scaffolding is in flight.** The checked-in `FoundryShell-src`
> tree is missing files the `.vcxproj` imports: `config/FoundryShell-win.props`
> (which supplies `VST3_DEFS`, `VST3_INC_PATHS`, `WDL_PATH`, `BUILD_DIR`,
> `BINARY_NAME`, `VST3_X64_PATH`), `resources/resource.h`, `resources/main.rc`,
> `projects/packages.config`, and `projects/packages/`. The include paths are also
> iPlug2-example-relative (`..\..\..\IPlug`,
> `..\..\..\Dependencies\IPlug\VST3_SDK`), so the project is templated to live at
> `iPlug2/Examples/FoundryShell/projects/` inside the SDK clone. A clean checkout
> cannot build the shell as-is; it needs the iPlug2 + VST3 SDKs re-fetched and the
> project placed inside the SDK's `Examples` tree. Concurrent work is touching this
> area — treat the current `vst3-shell` layout as mid-change.

## Where the logs land

| Log | Path | Written by | Contents |
|---|---|---|---|
| Sidecar spawn log | `data/logs/foundry-sidecar.log` (theDAW repo root) | `sidecar.py` (`_open_log`) | All `npm install` and `npm run dev` stdout/stderr from the theDAW-spawned Foundry. First place to look when the tab says Foundry did not start. |
| Foundry app log | `data/logs/app.log` (under `VST-Foundry-UI/VST-UI-FOUNDRY/`) | `server/logging.ts` (`appendLog`) | Foundry's own runtime log. Rolls once to `app.log.1` past 5 MB; last 500 lines also kept in memory. |
| `.gan` library | `data/plugins/*.gan` and `data/plugins/_runtime/<id>/` (theDAW repo root) | `plugin/router.py` | Installed plugins and their extracted runtimes; inspect when an import "succeeds" but renders wrong. |
| theDAW console | `[backend]` / `[frontend]` / `[tunnel]` prefixed lines | `backend._devstack` | The live launch console; the sidecar's own crash text is echoed here via the `503` detail too. |

> Two `data/` trees exist and are easy to confuse. The **sidecar** log lives under
> **theDAW's** repo-root `data/logs/` (because theDAW spawns it), while Foundry's
> **own** `app.log` lives under **Foundry's** `data/logs/` (its `process.cwd()`).
> When embedded, both are present; read `foundry-sidecar.log` for start-up
> failures and `app.log` for runtime behavior once Foundry is up. See
> [projects-and-data.md](projects-and-data.md) for the full data layout.

## Quick diagnostics

| Question | Command / action |
|---|---|
| Is Foundry actually up? | `curl http://127.0.0.1:5472/api/health` — body contains `"app":"vst-foundry"` when it is. |
| What does theDAW think the sidecar state is? | `curl http://127.0.0.1:8600/api/foundry/status` — resolved path, port, `listening`, `process_alive`, `issues`. |
| Who holds 5472? | `netstat -ano \| findstr ":5472 " \| findstr "LISTENING"` then `taskkill /F /PID <pid>`. |
| Clear all stale theDAW ports and reboot | Re-run `.\theDAW.bat` (clears `5173`, `8600`, `5187`, `5472`). |
| Why did start-up fail? | Read the tail of `data/logs/foundry-sidecar.log`, or the `503` detail on the tab. |
| Force a clean dep reinstall | `rmdir /s /q node_modules && del /f /q package-lock.json && npm install` in the project folder. |
