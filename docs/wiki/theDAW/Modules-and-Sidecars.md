# Modules and Sidecars

## Plugin modules

The backend mounts a plugin system from `backend/modules/`. Each subdirectory provides a `module.json` and a `router.py`, and the loader mounts every enabled module and isolates failures so one broken module does not take down the server. Settings can enable or disable each module, and a restart applies the change.

| Module | Area |
|---|---|
| `analysis`, `analyzer` | Track analysis, loudness, and key and tempo detection. |
| `chimera` | The fusion engine that blends and beat-aligns several clips into one generation. |
| `effects` (at `/api/studio`) | The MIX effects and mastering chain. |
| `mastering`, `restoration`, `enhance`, `delivery`, `creative_fx`, `creative_neural` | The six-family Edit Tool Stack under `/api/edit/*`. |
| `library`, `storage` | The disk-backed library and storage map. |
| `stems` | Demucs stem separation. |
| `midi`, `notation` | Audio-to-MIDI, MusicXML, tabs, and arrangements. |
| `vj`, `broadcast` | The VJ engine bridge and the WebRTC watch-link. |
| `suno`, `magenta`, `modeldl` | Cloud and real-time generation and model download. |
| `questmidi`, `questcast`, `queststitch`, `xrcontrol` | The Meta Quest 3 MIDI, video, stitch, and control bridges. |
| `akvj` | The depth-camera point-cloud pipeline. |
| `controllervision` | Controller identification from a photo. |
| `convert`, `ytimport`, `settings` | Format conversion, URL import, and app settings. |

See [User Guide §19 Backend API Reference](https://github.com/gantasmo/theDAW/blob/main/docs/USER_GUIDE.md#19-backend-api-reference) for the endpoints each module exposes.

## Sidecars and companions

The backend spawns or embeds several processes and pairs with companion repositories.

| Project | Location | Role |
|---|---|---|
| [magenta-rt2-nvidia](https://github.com/gantasmo/magenta-rt2-nvidia) | `sidecars/magenta-rt2-nvidia` | The first non-Mac port of Magenta RealTime 2, run on a WSL2 GPU through JAX. |
| [VJ-9000](https://github.com/gantasmo/VJ-9000) | spawned, embedded by iframe | The WebGL audio-reactive visual engine in the VJ tab. |
| [theDAW-XR](https://github.com/gantasmo/theDAW-XR) | external, over ADB | The Meta Quest 3 spatial companion for hand-tracked MIDI and passthrough. |
| `questcast`, `queststitch`, `magenta` | `sidecars/` | The Quest video and stitch bridges and the studio sidecar. |

Each connected repo has its own README, badges, and wiki Home.
