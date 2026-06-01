# SPECTRA-RIDER

SPECTRA-RIDER is a real-time 3D audio visualizer built with React, Vite, Three.js, and React Three Fiber. It turns microphone input or a local audio file into a glowing spectrogram terrain with camera flight modes, color themes, particles, bloom, and playback controls.

## Current status

The app installs, type-checks, and builds successfully. The main cleanup need was documentation: the previous README was still the generated Google AI Studio template and referenced a Gemini API key that this app does not currently use.

## Features

- Live microphone visualization.
- Local audio file playback and visualization.
- 3D spectrogram terrain driven by Web Audio FFT data.
- Curved side spectrogram walls.
- Multiple camera modes:
  - Canyon Flight
  - Dynamic Orbit
  - Bird's Eye
  - Deep Horizon
  - Free Flight
- Adjustable visualizer settings:
  - Sensitivity
  - FFT smoothing
  - Noise gate
  - Wave amplitude
  - Beat impact force
- Theme selector with several color atmospheres.
- Bloom, vignette, particles, fog, and shader-based visual effects.

## Tech stack

- React 19
- Vite 6
- TypeScript
- Three.js
- `@react-three/fiber`
- `@react-three/drei`
- `@react-three/postprocessing`
- Tailwind CSS 4
- Lucide React icons

## Requirements

- Node.js
- npm
- A modern browser with Web Audio and WebGL support
- Microphone permission if using live audio input

## Quick start

Install dependencies:

```bash
npm install
```

Run the development server:

```bash
npm run dev
```

Open the local URL printed by Vite. The dev server is configured for port `3000`.

Build for production:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

Type-check the project:

```bash
npm run lint
```

Clean generated build output:

```bash
npm run clean
```

## Controls

### Audio input

- Microphone button: starts live microphone visualization.
- Upload button: loads a local audio file and starts track playback.
- Playback HUD: appears for uploaded tracks and includes play/pause, time, and seek controls.

### Camera modes

- **Canyon Flight**: automatic forward-feeling flight through the terrain.
  - `A` / `D` or left/right arrows: steer horizontally.
  - `W` / `S` or up/down arrows: adjust altitude.
- **Free Flight**: user-controlled flight camera.
  - `WASD` or arrow keys: steer.
  - `Space`: faster flight.
  - `Shift`: slower flight.
- **Dynamic Orbit**, **Bird's Eye**, and **Deep Horizon**:
  - Drag to orbit.
  - Scroll to zoom.
- **Auto-Pan**: enables automatic orbit rotation for orbit-style camera modes.

## Project layout

```text
src/
  App.tsx                    Main HUD and app state
  main.tsx                   React entry point
  index.css                  Tailwind import, theme fonts, global styles
  components/
    Visualizer.tsx           3D scene, camera rig, particles, shaders, themes
  lib/
    audio.ts                 Web Audio setup, FFT data, playback helpers
```

## Known issues and improvement opportunities

### Confirmed by quick audit

- `src/components/Visualizer.tsx` is very large and should be split into focused modules.
- `VisualizerProps` is declared twice in `Visualizer.tsx`; this currently type-checks but should be deduplicated.
- The production bundle is large because the app loads the visual stack up front. Vite reports a chunk-size warning during build.
- Some package dependencies look like leftover scaffolding and should be audited before removal.
- `vite.config.ts` has a minor malformed comment encoding artifact from generated template text.

### Browser/runtime caveats

- Microphone mode requires browser permission and a secure context in many browsers.
- Browsers may block autoplay until the user interacts with the page.
- WebGL/postprocessing performance depends heavily on GPU and browser.

## Roadmap / TODO

### Immediate cleanup

- [ ] Remove unused dependencies after confirming they are not planned for near-term features.
- [ ] Fix generated-template leftovers in config comments and metadata.
- [ ] Add project description, repository, license, and keywords to package metadata when finalized.

### Code quality

- [ ] Split `Visualizer.tsx` into smaller modules:
  - `CameraRig.tsx`
  - `Particles.tsx`
  - `SpectrogramWalls.tsx`
  - `themes.ts`
  - `shaders/`
- [ ] Deduplicate shared types and move them to a focused types module.
- [ ] Move large shader strings out of JSX-heavy component code.
- [ ] Add comments around shader/audio math where behavior is non-obvious.

### Reliability

- [ ] Add CI for `npm install`, `npm run lint`, and `npm run build`.
- [ ] Add a simple smoke test or browser launch check.
- [ ] Add error handling for unsupported Web Audio/WebGL environments.
- [ ] Revoke object URLs when replacing uploaded tracks to avoid leaking blob URLs.
- [ ] Stop old microphone media tracks when switching audio modes.

### Performance

- [ ] Investigate code splitting or lazy loading for the 3D visualizer path.
- [ ] Tune particle count and postprocessing for lower-end devices.
- [ ] Consider exposing a quality/performance preset selector.

### UX polish

- [ ] Add a collapsible help/controls overlay.
- [ ] Persist selected theme and visualizer settings in local storage.
- [ ] Add a reset-settings button.
- [ ] Add optional FPS/performance diagnostics.

## Audit notes

The following commands passed during this quick review:

```bash
npm run lint
npm run build
```

Build currently emits a chunk-size warning, but it is not a build failure.
