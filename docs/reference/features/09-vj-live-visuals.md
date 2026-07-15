## VJ — Live Visuals

theDAW's **VJ** tab is the GANTASMO-LIVE-VJ engine ("vj-9000") embedded as a same-origin iframe and driven by a FastAPI sidecar. The backend serves the compiled build locally at `/vj-app/` (no Node.js required on end-user machines) or, in dev mode, spawns a Vite server on port **5187**. A **Pop out** button detaches the visuals into their own window for a second monitor, and a **Mobile** popover exposes a LAN URL + QR for a phone on the same Wi-Fi.

*Libraries: `three ^0.184.0`, `react ^19.0.1`, `vite ^6.2.3`; backend `fastapi`.*

### Sources

The active source is one of 12 kinds, each rendered to an offscreen canvas and `captureStream(30)`'d into the pipeline like a webcam:

- **Camera / Screen** — webcam device or `getDisplayMedia` window capture.
- **Quest / QuestStitch** — WebCodecs-decoded Meta Quest headset relays (ADB/scrcpy or stitched passthrough).
- **Cymatics** — reflective black-chrome Three.js visual, modes `orb` / `cymatics` / `landscape-chrome` / `landscape-ferrofluid`.
- **Shader** — fullscreen GLSL ES 3.00 fragment shaders: `yotta` (Menger flythrough, Matthias Hurrle @atzedent, MIT) plus **Mandelbulb / Julia Bulb / Mandelbox / Kaleido IFS** distance-field fractals, with 8 shading materials and audio-mappable uniforms.
- **SPECTRA** — 3D audio-spectrogram terrain, 5 camera modes and 7 color themes, fed a 256-bin FFT column.
- **Quantum** — sacred-geometry lattice, 4 morph targets (Grand Torus / Cubic Frame / Merkabah Star / Cosmos Cage) and 4 palettes.
- **Depth-cloud** — any video turned into a live point cloud via **monocular depth** (`onnx-community/depth-anything-v2-small`) running in a Web Worker on WebGPU/WASM (`@huggingface/transformers ^4.2.0`).
- **Gesturecam / AKVJ / AKVJ3D** — MediaPipe hand+pose FaceViz compositor (`@mediapipe/tasks-vision ^0.10.35`), and Unity / Azure-Kinect point-cloud bridges.

Loaded **video / image / audio clips** are the alternate source, organized in a Resolume-style clip grid with banks and a Library Pool; media dragged from anywhere in theDAW drops straight into the performance bucket.

### Effects

Every frame is composited in `VideoOutput.tsx` through a live effect chain — color/optics, geometry (mirror, kaleidoscope, radial mirror, tiling, equirect, SBS/TB stereo), distortion/FX (video feedback/Droste, glitch, RGB split/ghost, chromatic aberration, strobe, pixelate, wave-warp), post (scanlines, vignette, CRT, sepia, grayscale, blur), timecode (slit-scan, echo trails, time-displace) and a GPU **ASCII** post-effect. On top, a data-driven **Plugins Manager** catalogs **38** CV/AI effects across 4 categories (GPU/geometry, depth/spatial/volumetric, object/concept masks, generative/optical-flow), each with an audio-reactive band and live-tunable params; **Effect SOLO** isolates one for MIDI setup.

### Reactivity, MIDI & output

An audio bridge reads SA3's master `AnalyserNode`, derives bass/mid/high/volume + a 256-bin spectrogram, and posts them into the iframe at ~30fps (or the VJ captures its own mic). A single host-owned Web MIDI listener forwards controller input; a **MIDI MAP** panel and SLIDE-tab control-sync move VJ parameters bidirectionally. The output canvas records via `MediaRecorder` (webm/VP9, 720p/1080p/4K) and `/api/vj/export` transcodes with **ffmpeg** to h264/h265 (.mp4, +AAC), ProRes (.mov, `prores_ks` + PCM), or a zipped PNG sequence + WAV.

### Watch-link / broadcast

`backend/modules/broadcast` is a room-based **WebRTC signaling relay** over WebSocket that serves a self-contained viewer page at `/api/broadcast/watch/{room}`. Viewers open a link and watch the live output **peer-to-peer** (media never transits the server — venue-LAN quality/latency); ICE uses Google STUN by default with optional TURN via env for off-LAN reach. *Status: signaling relay + viewer page exist; the in-VJ broadcaster client that publishes the stream is not yet wired.*

### Runs on modest hardware / offline

Static-mode serving (no Node), backgrounded-tab render-loop parking (~0% GPU when hidden), a throttled/pausable audio bridge, `high/medium/low` render-scale tiers, off-thread depth inference with a WASM fallback, and thumbnail-backed grid cells all keep it light. The core engine (camera, clips, all effects, and the Three.js/GLSL generative sources) runs **fully offline**; only the depth-cloud and gesturecam/pose sources need a one-time model download (HuggingFace / MediaPipe CDNs), and recording needs a local ffmpeg.
