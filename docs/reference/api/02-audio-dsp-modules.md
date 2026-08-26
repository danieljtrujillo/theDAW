# theDAW HTTP API — "generation-media" router group

All routes are mounted by the auto-discovery loader at `backend/modules/loader.py:41`. The mount prefix defaults to `/api/<module_dir_name>` but each `module.json` overrides it with an explicit `api_prefix`, so the effective prefix is what's shown below (e.g. `effects` mounts at `/api/studio`, and several "edit" families mount under `/api/edit/*`). None of these routers declare `Depends`/auth — **no API key or auth is required** on any endpoint. These are local FastAPI routes (backend default `:8600`).

Five families (`enhance`, `restoration`, `mastering`, `creative_fx`, `creative_neural`) are built by the shared `build_router(family, tools)` factory (`backend/core/module_base.py:45`), so they all expose the identical 3-endpoint contract: `GET /tools`, `GET /tools/{tool_id}`, `POST /process`. The `effects` module hand-rolls its own router and exposes only `POST /process` (at `/api/studio/process`).

## Mashup — Chimera (`/api/chimera`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/chimera/probe` | Toolchain availability (ffmpeg/aubio/librubberband) |
| POST | `/api/chimera/probe/refresh` | Force re-detect the toolchain |
| POST | `/api/chimera/analyze` | Analyze one clip: BPM + beats + key (multipart `file`) |
| POST | `/api/chimera/mashup` | BPM-aware multi-clip mashup (multipart `files[]` + form controls); returns `mix_base64` + `per_clip[]` |

## Stem separation (`/api/stems`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/stems/probe` | Sidecar health snapshot |
| GET | `/api/stems/status` | `{running, port, package_path, python_exe}` |
| POST | `/api/stems/start` | Spawn Demucs sidecar |
| POST | `/api/stems/install` | Pip-install integration-package deps (demucs, torchcrepe, audio-separator) |
| POST | `/api/stems/stop` | Stop sidecar |
| POST | `/api/stems/{entry_id}/abort` | Cancel an in-flight separation |
| GET | `/api/stems/{entry_id}/progress` | Progress snapshot / `{phase:'idle'}` |
| GET | `/api/stems/{entry_id}` | List persisted stems |
| POST | `/api/stems/{entry_id}/run` | Separate (query `stems`=2/4/6/12, `device`, `quality`) |

## Analysis (`/api/analysis`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/analysis` (and `/`) | Capability report (ffprobe, aubio/librosa engines) |
| GET | `/api/analysis/{entry_id}/prompt` | Stable Audio-style prompt + tags from stored analysis |
| GET | `/api/analysis/{entry_id}` | Analysis row, or `{status:'pending'}` (200) |
| POST | `/api/analysis/{entry_id}/run` | Run + persist analysis (foreground) |

## AI Analyzer (`/api/edit/analyzer`)
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/edit/analyzer/analyze` | Full descriptor bundle (multipart `audio`) |
| POST | `/api/edit/analyzer/recommend` | Decision cards (rules + optional LLM); form `target` JSON |
| POST | `/api/edit/analyzer/build-stack` | Cards -> ordered effect chain; form `cards`, `variant`, `source_type` |

## Convert (`/api/convert`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/convert/formats` | Target-format catalog + source->target rules |
| POST | `/api/convert/library/{entry_id}` | Convert a library entry (JSON `{format}`) -> binary download |
| POST | `/api/convert/file` | Convert an uploaded file (multipart + form `format`) -> binary |

## URL Import (`/api/ytimport`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/ytimport` (and `/`) | Capability report (`yt_dlp`, `ffmpeg`, `codec:'opus'`) |
| POST | `/api/ytimport/fetch` | Download best audio from a URL via yt-dlp (JSON `{url}`); returns Opus bytes + `X-*` metadata headers. Spotify rejected (DRM) |

## Edit tool families (shared `build_router` contract)
Each family below exposes `GET /tools`, `GET /tools/{tool_id}`, and `POST /process` (multipart `audio` + form `effect`, `params` JSON, `output_format`). Unwired tool handlers return HTTP 501 with an honest JSON body rather than fake audio.

| Family | Prefix | Tools (`effect` ids) |
|---|---|---|
| Enhance / Super-Res | `/api/edit/enhance` | super_res, uncrush, studio_enhance, neural_codec, classical_upsample |
| Restoration & Cleanup | `/api/edit/restoration` | vocal_isolate, stem_separation, neural_denoise, dereverb, declip, restore_all, spectral_repair, breath_removal, dehum, deess, declick |
| Mastering & Tonal | `/api/edit/mastering` | parametric_eq, maximizer, stereo_imager, dynamic_eq, match_eq, multiband_dynamics, harmonic_exciter, transient_shaper, spectral_stabilizer, loudness_meter, master_assistant |
| Creative FX + Macros | `/api/edit/creative-fx` | ghost_voice, alien_transmission, broken_tape, radio_room, tunnel_pa, glitch_machine, neural_reverb, pitchlift |
| Creative Neural | `/api/edit/creative-neural` | spectramorph, timbreforge, promptfx, tokensynth, grainlab, crossfade_morph, ambientforge, voxsynth |

## Effects / Studio processing (`/api/studio`)
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/studio/process` | FFmpeg effect/export on multipart `audio` + form `effect`, `params` JSON, `output_format` (wav/flac/ogg/mp3/aac/opus). Effect names whitelisted (mastering_chain, compression, time_pitch, loudnorm, export_mp3, …). Note: this is the `effects` module; it exposes **no** `/tools` route. |

## Notation (`/api/notation`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/notation` (and `/`) | Capability report |
| GET | `/api/notation/{entry_id}/artifacts` | List notation artifacts (query `kind`) |
| POST | `/api/notation/{entry_id}/from-midi/{midi_id}` | Legacy MIDI row -> MusicXML artifact |
| POST | `/api/notation/{entry_id}/export` | Export artifact -> musicxml/abc/pdf/svg (JSON `{source_artifact_id, format}`) |
| POST | `/api/notation/{entry_id}/tabs` | MIDI -> guitar/bass tablature (alphaTex) |
| POST | `/api/notation/{entry_id}/arrange` | MIDI(s) -> MusicXML score (lead-sheet/piano-reduction/simplified/band-score) |
| POST | `/api/notation/backfill` | Backfill titled sheets for MIDI entries (idle-gated queue) |
| GET | `/api/notation/pack/{artifact_id}` | Download score as zip (source + engraved PDF) |
| GET | `/api/notation/file/{artifact_id}` | Download raw artifact file |

## Vocal Engine (`/api/vocal`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/vocal/health` | Engine health |
| POST | `/api/vocal/prepare` | Start prep pipeline job (JSON: `asset_id`, `isolate`, `isolation`, `cleanup`, `transcribe`, `language`) |
| GET | `/api/vocal/jobs/{job_id}` | Poll job status |
| POST | `/api/vocal/jobs/{job_id}/cancel` | Cancel job |
| GET | `/api/vocal/metadata/{asset_id}` | Canonical vocal artifact |
| POST | `/api/vocal/audio-to-notes` | Clip -> notes via basic-pitch (multipart `file`) |
| GET | `/api/vocal/midi/{asset_id}` | Download notes as a MIDI file |
| GET | `/api/vocal/validate/{asset_id}` | notes->MIDI->notes round-trip drift |
| POST | `/api/vocal/review/{asset_id}` | Mark reviewed + save notes (JSON `{reviewed, notes}`) |
| GET | `/api/vocal/transcription/probe` | Whisper sidecar venv status |
| POST | `/api/vocal/transcription/install` | Provision faster-whisper venv (background) |

## MIDI conversion (`/api/midi`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/midi` (and `/`) | Capability report (basic_pitch / piano_transcription_inference) |
| POST | `/api/midi/install` | Pip-install an engine (query `engine`, default `basic_pitch`) |
| GET | `/api/midi/file/{midi_id}` | Stream the `.mid` bytes |
| PATCH | `/api/midi/file/{midi_id}` | Mutate a MIDI row (only `favorite`) |
| DELETE | `/api/midi/file/{midi_id}` | Delete one MIDI conversion |
| GET | `/api/midi/{entry_id}` | List MIDI rows for an entry |
| POST | `/api/midi/{entry_id}/run` | Run audio->MIDI (query `from_stems`, default true) |

## Sheet Import (`/api/sheetimport`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/sheetimport/capabilities` | music21 availability + parseable formats |
| POST | `/api/sheetimport/parse` | Parse uploaded score -> piano-roll note batch (multipart `file`, <=25MB) |
| POST | `/api/sheetimport/parse-path` | Parse a server-side score path (JSON `{path}`, native picker) |
