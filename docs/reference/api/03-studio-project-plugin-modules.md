## theDAW "studio-tools" HTTP API

Every module is auto-discovered by `backend/modules/loader.py`: for each `backend/modules/<name>/` that has both `module.json` and `router.py`, the router is mounted at `config["api_prefix"]`, falling back to `/api/<dirname>` when `api_prefix` is absent (`backend/modules/loader.py:41-42`). All the modules below set an explicit `api_prefix`; two do not match their directory name:

- `delivery` → **`/api/edit/delivery`** (its router is `build_router("delivery", TOOLS)` from `backend/core/module_base.py`)
- `modeldl` → **`/api/models`**

No endpoint below enforces an API key at the HTTP layer. Auth-adjacent notes: `hfauth` reads/writes a Hugging Face token; `modeldl` uses the stored HF token server-side for gated repos (and falls back to a public mirror); `broadcast` reads optional TURN/public-base env vars; `updates` calls the public GitHub releases API.

### foundry — `/api/foundry` (VST Foundry sidecar)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/foundry/url` | Return sidecar URL, spawning on first call → `{url}` (`foundry/router.py:10`) |
| GET | `/api/foundry/status` | Non-spawning health probe + `ok` (`:19`) |
| POST | `/api/foundry/start` | Explicit (re)spawn → `{ok, url}` (`:26`) |
| POST | `/api/foundry/stop` | Terminate → `{ok, stopped}` (`:35`) |

### project — `/api/project` (.tasmo save/load)
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/project/save` | Serialize `SaveRequest{project,path,embed_audio}` to .tasmo (`project/router.py:98`) |
| POST | `/api/project/save-session` | Save live EDIT session, embedding uploaded clip audio (multipart) (`:128`) |
| POST | `/api/project/load` | Load .tasmo → `{project, manifest}` (`:169`) |
| GET | `/api/project/info?path=` | Manifest only (`:185`) |
| GET | `/api/project/recent` | Recent projects list (`:196`) |
| GET | `/api/project/default-dir` | Suggested save folder (`:202`) |
| GET | `/api/project/clip-audio?path=` | Stream clip audio, transcoding DAW-native formats (`:231`) |
| POST | `/api/project/export/audio` | Extract embedded audio to a dir (`:263`) |
| GET | `/api/project/list-audio?path=` | List embedded audio names (`:275`) |

### dawimport — `/api/dawimport` (DAW project import)
All import routes take `PathRequest{path}` and return a DawProject dict.
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/dawimport/detect` | Detect DAW from extension → `{daw,name,format}` (`dawimport/router.py:34`) |
| POST | `/api/dawimport/ableton` | Parse `.als` (`:63`) |
| POST | `/api/dawimport/reaper` | Parse `.RPP` (`:78`) |
| POST | `/api/dawimport/logic` | Parse `.logicx` (`:93`) |
| GET | `/api/dawimport/logic/export-hint` | Logic export instructions (`:108`) |
| POST | `/api/dawimport/fl-studio` | Parse `.flp` (`:119`) |
| POST | `/api/dawimport/audacity` | Parse `.aup3` (`:134`) |
| POST | `/api/dawimport/audition` | Parse `.sesx` (`:149`) |
| POST | `/api/dawimport/bitwig` | Parse `.bwproject` (`:164`) |
| POST | `/api/dawimport/resolume` | Parse `.avc` (`:179`) |
| GET | `/api/dawimport/cubase/export-hint` | Cubase export instructions (`:194`) |
| GET | `/api/dawimport/pro-tools/export-hint` | Pro Tools export instructions (`:208`) |

### underfit — `/api/underfit` (Underfit sidecar)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/underfit/status` | Health probe + `ok` (`underfit/router.py:38`) |
| POST | `/api/underfit/setup` | Build `.venv` (uv sync) (`:45`) |
| GET | `/api/underfit/setup-status` | Setup progress (`:52`) |
| POST | `/api/underfit/start` | Spawn dashboard → `{ok,url}` (`:57`) |
| POST | `/api/underfit/stop` | Stop spawned sidecar (`:66`) |
| GET | `/api/underfit/update-status?force=` | Upstream ahead? (`:72`) |
| POST | `/api/underfit/update` | Pull upstream (409 dirty tree) (`:78`) |

### vj — `/api/vj` (VJ sidecar + export)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/vj/url` | VJ dev-server URL (+ mobile/LAN) (`vj/router.py:70`) |
| GET | `/api/vj/mobile` | LAN mobile URL (503 if none) (`:106`) |
| GET | `/api/vj/lan-ip` | This machine's LAN IPv4 (`:129`) |
| GET | `/api/vj/status` | Diagnostics + `ok` (`:137`) |
| POST | `/api/vj/start` | Foreground start (`:147`) |
| POST | `/api/vj/stop` | Stop sidecar (`:159`) |
| GET | `/api/vj/export-folder` | Current export folder (`:190`) |
| POST | `/api/vj/export-folder/pick` | Native folder picker + persist (`:201`) |
| POST | `/api/vj/export` | Transcode uploaded `.webm` take (multipart: file, codec, resolution, subfolder) (`:227`) |

### broadcast — `/api/broadcast` (VJ watch-link / WebRTC signaling)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/broadcast/link?room=&port=` | Watch URLs + ICE config (`broadcast/router.py:74`) |
| WS | `/api/broadcast/ws?room=&role=` | Signaling relay (broadcaster/viewer) (`:94`) |
| GET | `/api/broadcast/watch/{room}` | Self-contained HTML viewer (`:170`) |

### magenta — `/api/magenta` (Magenta RT2 sidecar proxy)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/magenta/probe` | Sidecar health (`magenta/router.py:143`) |
| POST | `/api/magenta/engine/start` | Park SA3, spawn WSL engine (412 if unset) (`:156`) |
| POST | `/api/magenta/engine/stop` | Stop engine, restore SA3 (`:195`) |
| GET | `/api/magenta/engine/status` | Health + process/setup state (`:211`) |
| GET | `/api/magenta/jobs/{job_id}?summary=` | Poll generation job (`:224`) |
| POST | `/api/magenta/generate` | Start generation job (multipart Form; `audio_file` optional) → `{ok,job:{id}}` (`:237`) |

### plugin — `/api/plugin` (.gan web plugins)
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/plugin/import-owl` | Import VST Foundry export → .gan (`plugin/router.py:87`) |
| GET | `/api/plugin/list` | Installed .gan plugins (`:114`) |
| GET | `/api/plugin/info?path=` | Manifest at a path (`:139`) |
| POST | `/api/plugin/open` | Open by id or install+open by path (`:150`) |
| POST | `/api/plugin/package-owl` | Build bundled 'The Owl' .gan (`:178`) |
| POST | `/api/plugin/package-ares` | Build bundled 'Ares' .gan (`:201`) |
| POST | `/api/plugin/reveal` | Reveal a file in OS file manager (`:231`) |
| DELETE | `/api/plugin/{plugin_id}` | Remove plugin + runtime (`:250`) |
| GET | `/api/plugin/{plugin_id}/runtime/{asset_path}` | Serve extracted asset to iframe (`:266`) |

### vst — `/api/vst` (VST3 hosting)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/vst/scan?refresh=` | Scan standard VST3 dirs (cached) (`vst/router.py:99`) |
| GET | `/api/vst/scan/{path}` | Scan a custom dir (live) (`:111`) |
| POST | `/api/vst/load` | Load a plugin → params (`:118`) |
| GET | `/api/vst/plugins` | List loaded instances (`:135`) |
| POST | `/api/vst/process` | Process on-disk file through an instance chain (`:141`) |
| POST | `/api/vst/process-file` | Process uploaded audio through one plugin → WAV bytes (`:208`) |
| POST | `/api/vst/open-editor` | Open native GUI in sidecar (optional HWND embed) (`:259`) |
| POST | `/api/vst/editor-rect` | Live embed-rect / close update (`:348`) |
| GET | `/api/vst/editor-size?plugin_path=` | Embedded editor natural size (`:377`) |
| GET | `/api/vst/editor-result?plugin_path=` | Captured editor state (`:392`) |
| GET | `/api/vst/param/{instance_id}` | Read all params (`:408`) |
| PUT | `/api/vst/param/{instance_id}` | Set one param (`:418`) |
| DELETE | `/api/vst/unload/{instance_id}` | Unload instance (`:429`) |
| GET | `/api/vst/builtin` | Built-in pedalboard effects (`:439`) |

### library — `/api/library` (disk-backed library)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/library/entries?kind=` | List entries (audio/video/image/media/all) (`library/router.py:194`) |
| GET | `/api/library/entries/{id}` | Single entry (`:215`) |
| GET | `/api/library/audio/{id}` | Stream audio (CDN proxy fallback) (`:227`) |
| GET | `/api/library/stems/{stem_id}/audio` | Stream one stem WAV (`:272`) |
| PATCH | `/api/library/stems/{stem_id}` | Mutate stem (favorite) (`:295`) |
| DELETE | `/api/library/stems/{stem_id}` | Delete one stem (`:312`) |
| GET | `/api/library/media/{id}` | Stream media (Range) (`:332`) |
| GET | `/api/library/media/{id}/thumb` | Poster thumbnail (`:348`) |
| POST | `/api/library/import-media` | Import video/image upload (`:358`) |
| POST | `/api/library/import-folder` | Add a folder as reference-in-place entries (`:407`) |
| POST | `/api/library/reindex` | Re-sync SQLite mirror (`:444`) |
| PATCH | `/api/library/entries/{id}` | Update entry fields (`:456`) |
| POST | `/api/library/entries/{id}/play` | Increment play count (`:464`) |
| POST | `/api/library/suggest-playlist` | Analysis-driven playlist (`:497`) |
| DELETE | `/api/library/entries/{id}` | Delete entry (`:520`) |
| GET | `/api/library/{id}/bundle` | Download zip bundle (`:530`) |
| GET | `/api/library/{id}/lineage?depth=` | Lineage nodes+edges (`:584`) |
| GET | `/api/library/_all/stems` | All stems (`:649`) |
| GET | `/api/library/_all/midi` | All MIDI (`:660`) |
| GET | `/api/library/_all/scores` | All score artifacts (`:671`) |
| GET | `/api/library/_graph/all` | Full genealogy graph (`:687`) |
| POST | `/api/library/import` | Import audio upload (`:767`) |

### storage — `/api/storage` (model/data locations)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/storage/locations?refresh=` | Locations + sizes + inventory (`storage/router.py:308`) |
| GET | `/api/storage/resolution-log?since=` | Resolution decisions (`:341`) |
| GET | `/api/storage/hf-cache` | HF cache per-repo breakdown (`:351`) |
| GET | `/api/storage/checkpoints` | Registered + catalog availability (`:403`) |
| GET | `/api/storage/model-status` | Provider readiness summary (`:675`) |
| POST | `/api/storage/checkpoints` | Register local checkpoint (`:700`) |
| POST | `/api/storage/checkpoints/inspect` | Inspect a path pre-register (`:802`) |
| POST | `/api/storage/checkpoints/generate-config` | Copy catalog config next to a recognized ckpt (`:807`) |
| DELETE | `/api/storage/checkpoints/{ck_id}` | Unregister (files kept) (`:852`) |
| GET | `/api/storage/local-only` | No-download mode state (`:863`) |
| PUT | `/api/storage/local-only` | Toggle no-download mode (`:868`) |
| POST | `/api/storage/open` | Open a known location (Windows) (`:891`) |
| POST | `/api/storage/pick-folder` | Native folder picker (Windows) (`:957`) |
| POST | `/api/storage/pick-file` | Native file picker (Windows) (`:991`) |
| POST | `/api/storage/pick-save` | Native Save As dialog (`:1022`) |

### backup — `/api/backup` (user-data backup/restore)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/backup/manifest` | User-data roots + sizes (`backup/router.py:29`) |
| POST | `/api/backup/export` | Start zip export → `{job,state}` (`:42`) |
| GET | `/api/backup/export/status?job=` | Poll export (`:56`) |
| POST | `/api/backup/import` | Restore from zip (merge/replace) (`:69`) |
| GET | `/api/backup/import/status?job=` | Poll import (`:81`) |
| GET | `/api/backup/pick-folder` | Native folder picker (`:89`) |

### settings — `/api/settings`
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/settings` (and `/api/settings/`) | Full settings payload (`settings/router.py:41`) |
| PATCH | `/api/settings` (and `/api/settings/`) | Partial nested update → merged payload (`:47`) |

### updates — `/api/updates`
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/updates/check?force=` | Compare installed vs latest GitHub release (`updates/router.py:177`) |
| GET | `/api/updates/releases` | Up to 10 recent releases (`:218`) |

### delivery — `/api/edit/delivery` (delivery/export tool family)
Router is built by `build_router("delivery", TOOLS)` (`backend/core/module_base.py:45`), so it exposes the shared tool-family surface. Tools: codec_matrix, smart_export, high_quality_src, dither, metadata, batch_export (`backend/modules/delivery/router.py:154`).
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/edit/delivery/tools` | Family manifest (`core/module_base.py:49`) |
| GET | `/api/edit/delivery/tools/{tool_id}` | One tool descriptor (`:57`) |
| POST | `/api/edit/delivery/process` | Run a tool on uploaded audio (multipart: effect, params, output_format, audio) (`:64`) |

### modeldl — `/api/models` (model downloads)
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/models/{name}/download` | Start/rejoin a catalog-model HF download (config + checkpoint) (`modeldl/router.py:216`) |
| GET | `/api/models/downloads` | All download jobs with live progress (`:251`) |
| POST | `/api/models/downloads/clear` | Drop finished jobs (`:258`) |

### hfauth — `/api/hfauth` (Hugging Face auth)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/hfauth/status` | Login state (env/stored token, whoami-validated) (`hfauth/router.py:132`) |
| POST | `/api/hfauth/login` | Validate token (body) + persist to hub store (`:173`) |
| POST | `/api/hfauth/logout` | Remove stored token (`:223`) |
| GET | `/api/hfauth/login-url` | Browser URL to mint a token (`:249`) |
