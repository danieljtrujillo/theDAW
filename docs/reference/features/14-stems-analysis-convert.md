## Stems, Analysis & Conversion

theDAW turns any imported or generated track into stems, structured analysis, and alternate formats. These are auto-discovered backend modules under `backend/modules/`, plus a vendored, self-isolating stem-separation sidecar (`integration-package/backend`). Nearly everything runs fully local; only URL import and the optional LLM enrichment reach the network.

### Stem separation (Stems)
`/api/stems` drives a dedicated FastAPI sidecar that runs **Demucs** in its own venv, so its heavy ML dependencies (`demucs`, `torch`, `torchaudio`, `torchcrepe`) never collide with the main app.

- **2 / 4 / 6-stem** modes map to Demucs models: 2-stem `mdx_extra` (vocals / no_vocals), 4-stem `htdemucs` or `htdemucs_ft`, 6-stem `htdemucs_6s` (adds guitar/piano).
- **Quality presets** `fast` / `balanced` / `hq` trade model, `overlap`, and `shifts` for runtime so separation stays usable on CPU.
- **12-stem** first runs a 6-stem Demucs pass, then splits the drums into **kick / snare / hihat / cymbals / toms** with **LARSNET** U-Net checkpoints (`pretrained_{stem}_unet.pth`, per `larsnet/config.yaml`) on CPU. If LARSNET can't load, it keeps the original drums.
- **Lead/backing vocal split** (optional) uses **`torchcrepe`** (model `"full"`) F0 pitch tracking to build harmonic masks over the STFT, writing `vocals_lead.wav` / `vocals_back.wav`.
- Stems are written to `data/generations/<entry>/stems/`, re-encoded to PCM_16 to halve disk use, and registered in the library DB with a `stem_of` relation.
- A **BS-RoFormer** path (via `audio-separator`) exists in the sidecar with a Demucs fallback, but the launcher deliberately filters `audio-separator` out of the venv (scipy pin conflict), so Demucs is the shipped engine.

The sidecar never auto-starts: it is lazily spawned on opt-in, installs its deps on first run, and on Windows auto-provisions FFmpeg shared DLLs for `torchcodec` decode.

### Analysis
`/api/analysis` runs opt-in during idle (or on demand) and persists to SQLite + `metadata.json`:

- **Tempo / beats** — `aubio` streaming first (fast on WAV), falling back to `librosa.beat.beat_track` for MP3/M4A the aubio wheel can't open (shared with the Chimera mashup engine).
- **Key** — `librosa` `chroma_cqt` correlated against Krumhansl-Schmuckler major/minor profiles (key, scale, confidence).
- **Pitch** — `librosa.pyin` mean/std/median F0 + voiced ratio.
- **Bars, RMS loudness, ffprobe** metadata (sample rate, bit depth, codec, duration).
- **Prompt guess** — a deterministic Stable Audio-style prompt + semantic tags derived from the numbers.

A single shared decode feeds tempo/RMS/key/pitch, and a version stamp re-analyzes stale rows.

### AI Analyzer
`/api/edit/analyzer` extracts a full low/mid/high **descriptor bundle** (LUFS + true-peak via `pyloudnorm`/FFmpeg `ebur128`, spectral features, MFCCs, band energies, Krumhansl key, and a speech/music/noise classification), then generates prioritized fix "cards" from deterministic rules. It can optionally re-rank and explain them via the theDAW LLM assistant (default provider `gemini`) and assemble an ordered effect chain. LLM enrichment is optional, sends only numeric descriptors (never raw audio), and degrades to rules-only when offline.

### Convert
`/api/convert` is a generic FFmpeg catalog behind the right-click "Convert to..." menu: audio (`wav`, `wav24`, `flac`, `mp3` 320k, `ogg`, `opus`, `m4a`, `aiff`), video (`mp4`/`mov`/`mkv` H.264, `webm` VP9, animated `gif`), and image (`png`/`jpg`/`webp`/`bmp`/`tiff`), enforcing sensible source→target rules and streaming the result back as a download.

### URL / YouTube import
`/api/ytimport/fetch` uses **`yt-dlp`** to pull the best audio from a pasted YouTube / SoundCloud / Bandcamp link, preferring an **Opus stream-copy** (no re-encode) and only transcoding non-Opus sources to Opus 192k, then handing the file to the Media Bucket. Spotify links are rejected as DRM-protected. This feature is inherently online.

> Offline note: separation, analysis, the analyzer descriptor bundle, and conversion all run locally. First-run separation downloads Demucs weights (and, on Windows, FFmpeg DLLs); 12-stem LARSNET needs its pretrained weights present (absent in the current checkout).
