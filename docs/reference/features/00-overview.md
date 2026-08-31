# Overview: how theDAW fits together

theDAW is a full studio built around a local text-to-audio model. This page is the
map; each linked page is the detail.

## The two-stage audio pipeline

Generation is two stages, and the same autoencoder appears in both
(`CLAUDE.md:105`, `stable_audio_3/pipeline.py:77`):

1. **DiT** — a conditional diffusion transformer denoises latents, conditioned on
   text (a T5Gemma encoder) and on the requested duration.
2. **SAME autoencoder** — decodes those latents to 44.1 kHz stereo audio. The same
   autoencoder that encodes audio is the one bundled inside the checkpoints.

Sizes named in `CLAUDE.md:111` are Small (433M), Medium (1.4B) and Large (2.7B);
only the small/medium families resolve from the local catalog
(`stable_audio_3/model_configs.py:454-506`) — Large is API-only and is not in it.

Full detail: [Generation core](01-generation-core.md).

## Frontend: one tab per workspace

The workspace tabs are declared in one place, `CENTER_TABS`
(`frontend/src/state/appUiStore.ts:17`):

| Tab | What it is | Page |
|---|---|---|
| MAKE | Generate audio from a text prompt | [02](02-make-tab.md), [03 Chimera](03-chimera.md), [04 compose tools](04-compose-draw-vocal-notation-arp.md) |
| EDIT | Timeline arrangement, automation, export | [05](05-edit.md) |
| MIX | Effect/module rack, mastering | [06](06-mix-effects-mastering.md) |
| PERFORM | Live scene/clip grid | [08](08-perform-foundry-nodefi.md) |
| DJ | Two-deck console | [07](07-dj.md) |
| VJ | Live visuals engine | [09](09-vj-live-visuals.md) |
| FOUNDRY | Plugin/VST interface designer | [08](08-perform-foundry-nodefi.md) |
| UNDERFIT | LoRA finetune trainer | [11](11-underfit-lora.md) |
| NODEFI | Node-graph generation pipelines | [08](08-perform-foundry-nodefi.md) |
| LEARN | Guides, docs, in-app assistant | [13](13-assistant-llm-suno.md) |
| TOUR | Venue discovery and tour routing | [12](12-tour-planner.md) |

## Backend: a small core plus auto-discovered modules

`backend/server.py` is the FastAPI app. Nearly every feature is a **module** — a
directory under `backend/modules/` with a `router.py` and a `module.json` — that
`backend/modules/loader.py` discovers and mounts at `/api/<module name>`
(`loader.py:12`, `:41`). Modules can be disabled in Settings, in which case their
routes simply do not exist (`loader.py:36`).

This is why the app is large but not monolithic: each capability (stems, chimera,
mastering, tour, quest, foundry, …) is an isolated module, several with their own
sidecar process and virtualenv so heavy dependencies never load into the main app.

Full detail: [Infra and models](15-infra-models-offline.md),
[API conventions](../api/00-conventions.md).


## Local first

Model weights resolve local folder → Hugging Face cache → optional download, and
`SA3_LOCAL_ONLY` can block the download step entirely
(`stable_audio_3/model_configs.py:147`, `:334`). Once weights are on disk the core
studio needs no network. See [Offline and performance](../../OFFLINE-AND-PERFORMANCE.md)
for the full local-vs-optional-cloud breakdown.
