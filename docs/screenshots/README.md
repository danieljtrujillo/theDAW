# theDAW screenshots

Captured by the playwright-driven script at
[`scripts/screenshots/capture.ts`](../../scripts/screenshots/capture.ts).
Each scene drives the live app through a real interaction sequence
and snaps the resulting state — these are features **in action**,
not just the chrome.

The same runner now also emits targeted cropped screenshots for
feature-level documentation. The canonical mapping lives in
[`scripts/screenshots/specs.ts`](../../scripts/screenshots/specs.ts),
and generated manifests are written as `manifest.json` and
`manifest.md` in this directory.

## How to regenerate

The rig shoots against whichever frontend / backend pair the env points at,
so it can run against a second stack while the developer's own app stays
untouched:

```bash
# a second backend + frontend just for shooting (optional)
uv run uvicorn backend.server:app --port 8601
cd frontend && SA3_SHOTS_BACKEND=http://localhost:8601 npx vite --config vite.shots.config.ts   # :5174

# the gallery, in the README's theme
cd frontend && SA3_FRONTEND_URL=http://localhost:5174 SA3_BACKEND_URL=http://localhost:8601   SA3_SHOTS_THEME=brushed-steel SA3_SHOWCASE_TRACK="Et Tu Machina"   npx tsx ../scripts/screenshots/capture.ts
node _capture_readme_extra.mjs      # library rail, catalogue, LEARN, NODEFI
```

`SA3_SHOTS_THEME` seeds the persisted theme (`brushed-steel` for the README;
unset keeps the app default), `SA3_SHOWCASE_TRACK` / `SA3_NOTATION_TRACK`
pick the hero song by title, `SA3_LYRICS_TRACK` the song for the SING scene
(default: the entry with the most timed lyric words), and `SCENES=a,b` limits
the run. The README images under `docs/readme/` are copies of these frames.

### The original steps

1. Launch theDAW via `theDAW.bat` (backend + frontend + tunnel + VJ
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
   into the README. Full scenes use `<scene-id>.png`; crops use
   `<scene-id>__<crop-id>.png`.

4. Regenerate the feature/docs coverage report whenever screenshot
   specs change:

   ```cmd
   cd frontend
   npm exec -- tsx ../scripts/screenshots/featureCoverage.ts
   ```

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

| # | File | Shows | Feature IDs |
|---|------|-------|-------------|
| 01 | `01-shell-make.png` | App on MAKE tab, top bar + tabs visible. Crops: `header-actions`, `make-controls`. | `shell-center-tabs-right-library`, `create-advanced-generation-templates-prompts-spectrograms`, `docs-modal-download-print-rag`, `assistant-orb-providers-keys-attachments` |
| 02 | `02-library-with-showcase-selected.png` | Library panel with the showcase track selected. Crop: `library-details`. | `library-backend-local-storage`, `media-bucket-routing` |
| 03 | `03-library-actions-toolbar.png` | Icon-only toolbar (SELECT / DOWNLOAD / DELETE / FUSE / INPAINT / OPTIONS) with selection. Crop: `library-toolbar`. | `library-stems-sidecar`, `library-midi-conversion`, `library-bundle-download-lineage-export`, `create-chimera-fusion-stack` |
| 04 | `04-library-download-submenu.png` | DOWNLOAD submenu open showing Songs / MIDI / JSON / Bundle / Lineage. Crop: `download-submenu`. | `library-bundle-download-lineage-export`, `library-midi-conversion` |
| 05 | `05-library-entry-right-click.png` | Per-row right-click menu (Send to Init, Run analysis, Separate stems, Convert to MIDI, Download bundle, Show lineage). Crop: `entry-context-menu`. | `library-stems-sidecar`, `library-midi-conversion`, `library-bundle-download-lineage-export`, `media-bucket-routing` |
| 06 | `06-learn-tab-3d-graph.png` | LEARN tab — 3D lineage graph with cluster halos and node-details panel. Crop: `lineage-graph`. | `library-bundle-download-lineage-export` |
| 07 | `07-settings-modal-with-shutdown.png` | SETTINGS modal — pinned Restart + Shutdown footer at the bottom. Crop: `settings-toggles`. | `settings-feature-toggles-modules-admin`, `backend-module-loader-settings` |
| 08 | `08-vj-tab-loading.png` | VJ tab — either the loading state during sidecar spawn or the iframe ready state. Crop: `vj-panel`. | `vj-sidecar-tab-mobile-share` |
| 09 | `09-chimera-cohort-multi-select.png` | Library with a multi-track cohort selected (FUSE-ready). Crop: `chimera-multi-select`. | `create-chimera-fusion-stack`, `library-backend-local-storage` |

## Crop asset rules

- Define every crop in `scripts/screenshots/specs.ts`; do not hardcode
  crop rectangles inside scene functions.
- Keep rectangles inside the shared 1920×1080 viewport.
- Prefer one strong crop reused by multiple feature IDs over many nearly
  identical screenshots.
- When UI layout changes, update the spec, rerun screenshots, then rerun
  `featureCoverage.ts` so manifests stay aligned.

## Headless-vs-headed

The script runs headless by default. To watch the browser drive
through the scenes, set `HEADED=1` before running the script. Useful
for diagnosing a flaky scene or validating crop bounds visually.

