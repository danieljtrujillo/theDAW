## XR / Quest Suite

Seven auto-discovered backend modules bridge a Meta Quest headset, an Azure Kinect, and a phone into theDAW over adb/USB and localhost WebSockets. They are transport plumbing plus two sidecars; the browser and VJ deck do the decoding and rendering. Each module ships a `module.json` (enable/disable in Settings) and mounts under its own `/api/...` prefix.

### Quest Deploy (`/api/quest`)
One-click install of the theDAW-XR APK onto a USB-connected headset. It auto-discovers `adb` across Android SDK, Unity Hub, and Meta Quest Developer Hub install paths, flags a Quest by hardware codename (monterey/hollywood/eureka/panther/seacliff/cambria), runs `adb install -r`, and launches via `monkey`. It can also pull the newest `.apk` from the `gantasmo/theDAW-XR` GitHub release rather than requiring a local Unity build.
- Deploy-only, no Unity build. Libraries: `httpx`, `adb` via subprocess. Evidence: `backend/modules/quest/service.py:44`, `:139`, `:228`, `:315`, `:33`.

### Quest MIDI (`/api/questmidi`)
The loopMIDI-free MIDI path. A pure-asyncio TCP listener (default `127.0.0.1:8765`) receives the Quest app's MIDI over `adb reverse`; inbound MIDI is relayed to the browser `midiBus` over a WebSocket, and return MIDI is framed back to the headset (e.g. to drive the GANTASMO Visor). It also reverses the backend HTTP port (8600) so the tethered headset reaches the whole API — including the XR control bus — on loopback.
- No models; stdlib asyncio + `backend.core.adb`. Evidence: `backend/modules/questmidi/bridge.py:30`, `:35`, `:120`, `:184`; `frontend/src/state/questMidiClient.ts:96`.

### Quest Cast (`/api/questcast`)
Mirrors the Quest display into the VJ as a live camera with no terminal, OBS, or external scrcpy app. A Node sidecar speaks the scrcpy protocol over the shared adb, pushes a version-matched scrcpy **server 3.3.3** to the device (video-only H.264, maxSize 1920, 60 fps, 8 Mbps), and relays raw H.264 over a WebSocket (default port 8930). The VJ decodes with **WebCodecs** onto an offscreen canvas and `captureStream()`s it into the normal camera pipeline, with optional full or per-eye stereo crop.
- Libraries (verbatim, `sidecars/questcast/package.json:11`): `@yume-chan/adb ^2.6.0`, `@yume-chan/adb-scrcpy ^2.3.2`, `@yume-chan/adb-server-node-tcp ^2.5.2`, `@yume-chan/scrcpy ^2.3.0`, `@yume-chan/stream-extra ^2.6.1`, `@yume-chan/fetch-scrcpy-server ^1.0.0`, `ws ^8.18.0`. scrcpy server pinned via `AdbScrcpyOptions3_3_3` + postinstall (`server.mjs:25`, `package.json:9`). Decode: `useQuestCast.ts:189`, `:243`.

### Quest Stitch (`/api/queststitch`)
Brings only the CLEAN stitched Quest passthrough into the VJ (distinct from Quest Cast, which mirrors the whole display). The Quest app MediaCodec-encodes the stitch RenderTexture to H.264 and pushes NAL units over `adb reverse` to a pure-asyncio TCP listener (default `127.0.0.1:8940`), which re-frames them into the exact Quest Cast WebSocket wire format so the VJ's WebCodecs decoder is reused verbatim. No Node sidecar, no PC-side encoder.
- Evidence: `backend/modules/queststitch/bridge.py:42`, `:143`, `:183`; `useQuestStitch.ts:88`.

### XR Control Bus (`/api/xr/control`)
A stateless WebSocket relay between theDAW (the browser host, which owns the control manifest and the wired setters) and controller peers (a theDAW-XR headset plus phone/companions). It forwards manifest / control-set / control-changed / pad-jog-trigger frames, enforces a pairing gate (open vs code), and restricts the privileged host role to a localhost origin. The browser aggregates a self-describing manifest from many sources (DJ, Sway, pose, MAKE, PROCESS, live-FX, transport), so new spatial controls surface in XR with no Unity edit.
- Evidence: `backend/modules/xrcontrol/router.py:91`, `:128`, `:165`; `frontend/src/state/xrControlClient.ts:60`, `:103`; `frontend/src/App.tsx:302`.

### Controller Vision (`/api/controllervision`)
Infers a MIDI controller's physical layout (knobs/faders/pads + normalized positions) from a product photo. The classical **OpenCV** path (no key, CPU-only, milliseconds) uses Hough circles for knobs and contour aspect-ratio for faders/pads. The accurate path sends the photo to a **vision LLM** (reusing the Assistant's provider keys). Images arrive by upload, Wikimedia Commons lookup by device name, or a phone that snaps the photo over the LAN via a QR-linked self-contained page. The result is always user-verified; MIDI mapping still comes from capture/MIDI-learn.
- Vision model picks, in order (`engine.py:276`): `gemini/gemini-flash-latest`, `anthropic/claude-sonnet-4-6`, `openai/gpt-4.1-mini`, `grok/grok-3`, `openrouter/google/gemini-flash-1.5`.
- Libraries: `opencv-python-headless>=4.9.0` (`pyproject.toml:65`), `numpy`, `httpx`, Wikimedia Commons API (`engine.py:202`). CV: `engine.py:121`; phone pairing: `session.py:45`.

### AKVJ Bridge (`/api/akvj`)
A frame-agnostic Unity-desktop-to-VJ bridge with two senders and one drop-to-latest relay: (1) legacy MJPEG from a Unity Akvj app, and (2) the default native `akvj3d` path, where a headless **pyk4a** sidecar opens the Azure Kinect directly (NFOV_UNBINNED 640x576 depth, 720p color) and streams a one-time XY unprojection table plus per-frame depth16 + depth-aligned JPEG color, framed with a small `AKV1` header. The VJ unprojects `position = (rayX, rayY, 1) * depth` in a **three.js** vertex shader into a live GPU point cloud, so the deck owns point size, per-style behaviors, bloom, and audio reactivity.
- Libraries: `pyk4a` (`kinect_sidecar.py:215`), `pyk4a-bundle` (`pyproject.toml:76`, ships matched `k4a.dll`/`depthengine` + `libk4a.so`), `websockets`, `numpy`, `pillow`; VJ uses `three` + addons `EffectComposer`/`UnrealBloomPass`/`AfterimagePass` (`AkvjCloudRenderer.ts:14`). Windows/Linux x64 only.

### Runs on modest hardware
- WebCodecs decode is hardware-accelerated and latency-optimized; data packets are dropped when the decode queue backs up (>8) or the tab is hidden, with a 5s watchdog that self-heals a stalled feed (`useQuestCast.ts:243`, `:327`, `:459`).
- The scrcpy relay caches and replays the last config packet to late joiners (`server.mjs:159`).
- The akvj relay is drop-to-latest per viewer; the Kinect sidecar disk-caches the XY table keyed by calibration, uses the SDK's vectorized point-cloud transform, and runs a depth-1 capture pipeline with reused scratch buffers that drops frames under a slow link (`kinect_sidecar.py:74`, `:298`, `:364`).
- Classical CV lazy-imports cv2 and downscales images to 1200px so the backend still boots without OpenCV (`engine.py:36`, `:105`).

### Offline / no-cloud
Quest MIDI, Quest Stitch, XR Control Bus, and the native Kinect path run fully local over USB adb-reverse and loopback WebSockets. Quest Cast and the Kinect path need network only on first run (npm install + scrcpy 3.3.3 server download; pip install of pyk4a-bundle et al.). Quest Deploy's APK release fetch, Controller Vision's AI identify, and the Wikimedia lookup are the only always-online calls; the classical CV path needs no key.
