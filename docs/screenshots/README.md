# StableDAW screenshots

Captured by the playwright-driven script at
[`scripts/screenshots/capture.ts`](../../scripts/screenshots/capture.ts).
Each scene drives the live app through a real interaction sequence
and snaps the resulting state — these are features **in action**,
not just the chrome.

## How to regenerate

1. Launch SA3 via `start-dev.bat` (backend + frontend + tunnel + VJ
   sidecar all up). Wait until http://localhost:5173 responds.
2. From the repo root:

   ```cmd
   npm --prefix frontend run screenshots
   ```

   This invokes the same `scripts/screenshots/capture.ts` runner.
   Override the showcase track if you don't have "Chungus 9003" in
   your library:

   ```cmd
   set SA3_SHOWCASE_TRACK=My Best Track
   npm --prefix frontend run screenshots
   ```

3. PNGs land in this directory, ready to be committed or pasted
   into the README.

## Run only one scene

```cmd
set SCENES=05-library-entry-right-click
npm --prefix frontend run screenshots
```

Names are listed in `scripts/screenshots/capture.ts` (`SCENES`
array). Comma-separate to run several.

## Showcase-track logic

`scripts/screenshots/pickShowcaseTrack.ts`:

- `pickShowcaseTrack()` — exact title match on `"Chungus 9003"`
  (overridable via `SA3_SHOWCASE_TRACK`), falls back to
  case-insensitive substring, falls back to longest entry by
  duration if nothing matches. Used for single-track demos
  (library detail, download submenu, right-click, VJ track meta).
- `pickCohort(n)` — picks N entries within ±25% duration of the
  showcase track so multi-track demos (chimera-fusion screenshot,
  multi-select toolbar state) feel coherent. Falls back to the
  most-recent N entries if the duration filter doesn't yield
  enough matches.

## Scene index

| # | File | Shows |
|---|------|-------|
| 01 | `01-shell-make.png` | App on MAKE tab, top bar + tabs visible. |
| 02 | `02-library-with-showcase-selected.png` | Library panel with the showcase track selected. |
| 03 | `03-library-actions-toolbar.png` | Icon-only toolbar (SELECT / DOWNLOAD / DELETE / FUSE / INPAINT / OPTIONS) with selection. |
| 04 | `04-library-download-submenu.png` | DOWNLOAD submenu open showing Songs / MIDI / JSON / Bundle / Lineage. |
| 05 | `05-library-entry-right-click.png` | Per-row right-click menu (Send to Init, Run analysis, Separate stems, Convert to MIDI, Download bundle, Show lineage). |
| 06 | `06-learn-tab-3d-graph.png` | LEARN tab — 3D lineage graph with cluster halos and node-details panel. |
| 07 | `07-settings-modal-with-shutdown.png` | SETTINGS modal — pinned Restart + Shutdown footer at the bottom. |
| 08 | `08-vj-tab-loading.png` | VJ tab — either the loading state during sidecar spawn or the iframe ready state. |
| 09 | `09-chimera-cohort-multi-select.png` | Library with a multi-track cohort selected (FUSE-ready). |

## Headless-vs-headed

The script runs headless by default. To watch the browser drive
through the scenes, edit `capture.ts` and change `headless: true`
to `headless: false`. Useful for diagnosing a flaky scene.
