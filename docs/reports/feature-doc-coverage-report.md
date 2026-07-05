# Feature Documentation Coverage Report

> [!NOTE]
> Generated: 2026-07-05T22:06:25.169Z · Git revision: `7ad08f45e187` · Repomix tracked: **no**

## Audit Dashboard

| Metric | Value |
|---|---:|
| Documentation coverage | **100%** |
| Features inventoried | **36** |
| Documented features | **36** |
| Missing docs | **0** |
| Partial docs | **0** |
| Full screenshot scenes | **40** |
| Cropped screenshot assets | **42** |

> [!IMPORTANT]
> Repomix context: present at `repomix-output.md`; tracked=false. Used as local analysis context only. It is intentionally gitignored and must not be staged.

## Coverage Matrix

| Feature ID | Feature | Domain | Status | Coverage | Anchors | Notes |
|---|---|---|---|---|---|---|
| `shell-center-tabs-right-library` | Center-tab workspace shell with collapsible right library rail | daw | implemented | **documented** | #5-ui-shell<br>#zustand-store-architecture | Matched 2/4 guide terms. |
| `docs-modal-download-print-rag` | In-app docs modal with raw Markdown download, print/PDF, anchors, and RAG source copy | assistant | implemented | **documented** | #5-ui-shell<br>#19-11-assistant<br>#25-4-documentation-maintenance-rule | Matched 2/4 guide terms. |
| `assistant-orb-providers-keys-attachments` | AI Assistant orb with provider/model selection, key pools, attachments, voice input, and streaming chat | assistant | implemented | **documented** | #5-ui-shell<br>#19-11-assistant<br>#29-catalogue | Matched 4/5 guide terms. |
| `create-advanced-generation-templates-prompts-spectrograms` | Advanced generation controls with templates, saved prompts, prompt enhancer, output settings, and spectrogram viewer | create | implemented | **documented** | #6-1-primary-synthesis-prompt<br>#6-3-advanced-generation-panel<br>#12-3-how-the-visualizations-are-rendered | Matched 4/4 guide terms. |
| `create-chimera-fusion-stack` | Chimera multi-clip fusion stack with BPM alignment, base clip, noise weights, and weave scheduling | chimera | implemented | **documented** | #1-repository-anatomy<br>#purpose<br>#6-3-1-chimera-fusion-stack<br>#6-4-init-signal-conditioning<br>#12-2-3d-graph-controls<br>#12-3-how-the-visualizations-are-rendered<br>#13-1-automatic-entry-creation<br>#13-5-bundle-downloads-and-lineage<br>#13-12-stems-and-midi-as-first-class-items<br>#19-14-chimera<br>#25-3-current-feature-to-screenshot-map<br>#27-1-the-sidecar-and-conditioning<br>#30-youtube-import<br>#38-2-feature-tour | Matched 5/5 guide terms. |
| `create-mic-recorder-send-targets` | Browser microphone recorder that can send recordings to editor, init, inpaint, or library | create | implemented | **documented** | #6-3-1-chimera-fusion-stack<br>#6-4-1-microphone-recorder<br>#10-1-inputs<br>#10-4-export<br>#13-1-automatic-entry-creation<br>#25-5-promo-video-capture | Matched 5/5 guide terms. |
| `edit-advanced-effects-chain-analyzer` | Advanced effects chain with categorized FFmpeg processors, column resizing, waveform previews, and source/output stats | edit | implemented | **documented** | #purpose<br>#8-1-layout<br>#8-2-quick-master<br>#8-3-effect-catalog-and-chain<br>#8-4-source-output-and-routing<br>#19-7-studio-processing<br>#adding-a-new-ffmpeg-effect | Matched 5/5 guide terms. |
| `library-backend-local-storage` | Disk-backed backend library provider with range-streamed audio and mutable metadata | library | implemented | **documented** | #6-4-1-microphone-recorder<br>#purpose<br>#13-1-automatic-entry-creation<br>#13-4-per-entry-controls<br>#13-8-video-and-image-media<br>#19-13-disk-backed-library<br>#19-15-stems<br>#library-storage-fills-the-disk<br>#zustand-store-architecture<br>#33-1-notation-artifacts | Matched 4/5 guide terms. |
| `library-bundle-download-lineage-export` | Library bundle downloads and lineage graph exports including metadata, stems, MIDI, and relations | library | implemented | **documented** | #12-2-3d-graph-controls<br>#13-4-per-entry-controls<br>#13-5-bundle-downloads-and-lineage<br>#19-13-disk-backed-library | Matched 2/4 guide terms. |
| `library-stems-sidecar` | Stem separation sidecar with install/start/stop/status/progress/abort and persisted stem rows | library | implemented | **documented** | #13-4-per-entry-controls<br>#13-6-stem-separation<br>#19-15-stems<br>#38-2-feature-tour<br>#credits | Matched 3/4 guide terms. |
| `library-midi-conversion` | Audio-to-MIDI conversion with installable engines, persisted MIDI rows, and editor send targets | library | implemented | **documented** | #6-4-1-microphone-recorder<br>#13-4-per-entry-controls<br>#13-7-midi-conversion<br>#13-9-format-conversion<br>#19-16-midi<br>#33-notation-score-tabs-and-arrangements | Matched 4/4 guide terms. |
| `settings-feature-toggles-modules-admin` | Settings modal for feature toggles, module enablement, restart, and shutdown controls | settings | implemented | **documented** | #one-shot-launcher-windows<br>#5-ui-shell<br>#13-4-per-entry-controls<br>#19-8-jobs-list<br>#19-11-assistant<br>#19-12-module-loader<br>#21-1-settings-models-local-checkpoints-and-the-no-download-guarantee<br>#api-unreachable-banner-in-the-header<br>#backend-job-persistence<br>#25-3-current-feature-to-screenshot-map<br>#32-admin-module-and-assistant-key-apis<br>#35-1-loading-a-project | Matched 4/5 guide terms. |
| `waveform-editor-inpaint-review` | Waveform editor paintbrush inpainting workflow with crop-aware mask submission and accept/discard review | daw | implemented | **documented** | #frontend-dependencies<br>#6-5-inpainting-regen-region<br>#6-8-run-generation<br>#7-4-inpainting-from-the-editor<br>#7-11-automation-lanes<br>#10-2-pop-out-and-mobile<br>#13-8-video-and-image-media<br>#14-2-voice-synthesis<br>#16-5-media<br>#controls<br>#19-4-generation-async-thedaw-ui<br>#19-12-module-loader<br>#19-13-disk-backed-library<br>#19-14-chimera<br>#21-2-manual-model-placement-download-links-and-folder-tree<br>#26-1-modes | Matched 5/5 guide terms. |
| `sequencer-midi-export-render` | Step sequencer Standard MIDI export plus single-track/multi-track render-to-editor flows | daw | implemented | **documented** | #13-7-midi-conversion<br>#14-5-midi-export<br>#15-5-midi-import-and-export | Matched 2/4 guide terms. |
| `piano-roll-linked-clip-editing` | Piano roll MIDI import/export, render-to-editor, and linked clip re-editing | daw | implemented | **documented** | #15-5-midi-import-and-export<br>#15-7-edit-in-piano-roll<br>#16-6-slide | Matched 4/4 guide terms. |
| `media-bucket-routing` | Media Bucket send targets for editor, library, init audio, and Chimera stack | daw | implemented | **documented** | #6-3-1-chimera-fusion-stack<br>#8-4-source-output-and-routing<br>#13-4-per-entry-controls<br>#13-12-stems-and-midi-as-first-class-items<br>#16-5-media<br>#38-2-feature-tour | Matched 4/4 guide terms. |
| `vj-sidecar-tab-mobile-share` | VJ tab and mobile share link for iframe/tunnel-backed performance access | vj | experimental | **documented** | #table-of-contents<br>#5-ui-shell<br>#10-vj-tab<br>#purpose<br>#10-3-bridges<br>#10-9-bpm-sync-and-pose-control<br>#13-8-video-and-image-media<br>#19-17-vj | Matched 3/4 guide terms. |
| `backend-module-loader-settings` | Backend module loader with module manifests and runtime enable/disable settings | backend-module | implemented | **documented** | #1-repository-anatomy<br>#19-12-module-loader<br>#adding-a-backend-module<br>#zustand-store-architecture<br>#32-admin-module-and-assistant-key-apis | Matched 4/4 guide terms. |
| `suno-cloud-generation` | Suno cloud generation (Aurora Cloud Console) with simple/custom/cover/mashup, server-side key, and library lineage | create | implemented | **documented** | #table-of-contents<br>#1-repository-anatomy<br>#6-2-generation-parameters<br>#6-3-1-chimera-fusion-stack<br>#12-3-how-the-visualizations-are-rendered<br>#19-14-chimera<br>#21-models<br>#21-1-settings-models-local-checkpoints-and-the-no-download-guarantee<br>#26-cloud-generation-suno<br>#26-1-modes<br>#26-2-flow-and-library-integration<br>#26-3-endpoints<br>#29-catalogue<br>#credits | Matched 5/5 guide terms. |
| `magenta-rt2-generate` | Magenta RealTime 2 generation (text/notes/audio-style) via the WSL2 NVIDIA sidecar, the first non-Mac MRT2 port | create | experimental | **documented** | #table-of-contents<br>#6-2-generation-parameters<br>#8-6-categorized-effect-rail<br>#21-models<br>#21-1-settings-models-local-checkpoints-and-the-no-download-guarantee<br>#21-2-manual-model-placement-download-links-and-folder-tree<br>#27-magenta-realtime-2<br>#27-1-the-sidecar-and-conditioning<br>#27-2-first-non-mac-port-of-magenta-realtime-2<br>#33-6-prompt-inference | Matched 5/5 guide terms. |
| `edit-tool-stack-modules` | Edit Tool Stack: six /api/edit/* processor families (mastering, restoration, enhance, delivery, creative-fx, creative-neural) plus AI analyzer | edit | implemented | **documented** | #table-of-contents<br>#1-repository-anatomy<br>#28-edit-tool-stack | Matched 5/5 guide terms. |
| `catalogue-cross-provider-browser` | Catalogue cross-provider library gallery with provider badges, inspector spectrograms, and lineage | library | implemented | **documented** | #table-of-contents<br>#5-ui-shell<br>#26-2-flow-and-library-integration<br>#29-catalogue | Matched 5/5 guide terms. |
| `controller-vision-detect-identify` | Controller Vision: detect/identify a MIDI controller from a photo (OpenCV + vision-LLM) with LAN phone pairing | daw | implemented | **documented** | #table-of-contents<br>#31-controller-vision | Matched 5/5 guide terms. |
| `ytimport-youtube-import` | YouTube import: fetch audio from a URL into the Library as a first-class, lineage-tracked entry | library | implemented | **documented** | #table-of-contents<br>#1-repository-anatomy<br>#prerequisites<br>#30-youtube-import | Matched 4/4 guide terms. |
| `edit-insert-fx-rack` | EDIT real-time psychoacoustic insert-FX rack on the master bus and per track, baked into COMMIT EDIT | edit | implemented | **documented** | #7-6-commit-edit<br>#7-7-insert-fx-rack-psychoacoustic<br>#8-6-categorized-effect-rail<br>#8-9-how-chain-nodes-process-together<br>#15-8-instrument-soundfont-and-synth-voices | Matched 6/6 guide terms. |
| `edit-spatializer-teleport-autopilot` | EDIT HRTF spatializer with 12 motion modes including onset-driven Teleport and the live Autopilot choreographer | edit | implemented | **documented** | #7-6-commit-edit<br>#7-7-insert-fx-rack-psychoacoustic<br>#7-8-spatializer-teleport-and-autopilot<br>#10-6-autopilot-visual-effects<br>#10-8-effect-chain<br>#10-9-bpm-sync-and-pose-control | Matched 6/6 guide terms. |
| `edit-metamorph-granular-morph` | Metamorph granular identity-bleed morph: rebuild a host sound out of a donor sound, live and to a clip | edit | implemented | **documented** | #7-9-metamorph-granular-identity-bleed-morph<br>#14-4-send-to-editor<br>#15-6-send-to-editor<br>#16-4-details<br>#16-5-media | Matched 6/6 guide terms. |
| `edit-timeline-live-midi-soundfont` | Live MIDI timeline playback through the SpessaSynth soundfont engine with a GM and synth-voice instrument picker | daw | implemented | **documented** | #7-10-live-midi-playback-in-the-timeline<br>#15-8-instrument-soundfont-and-synth-voices | Matched 6/6 guide terms. |
| `library-stems-midi-first-class` | Stems and MIDI as first-class library rows: play, favorite, delete, and route, in their own sub-tabs | library | implemented | **documented** | #1-repository-anatomy<br>#5-ui-shell<br>#6-4-1-microphone-recorder<br>#purpose<br>#9-4-live-stems-and-fx<br>#12-1-views<br>#13-3-search-filter-sort<br>#13-4-per-entry-controls<br>#13-5-bundle-downloads-and-lineage<br>#13-6-stem-separation<br>#13-7-midi-conversion<br>#13-8-video-and-image-media<br>#13-12-stems-and-midi-as-first-class-items<br>#19-13-disk-backed-library<br>#19-15-stems<br>#19-16-midi<br>#21-1-settings-models-local-checkpoints-and-the-no-download-guarantee<br>#25-3-current-feature-to-screenshot-map<br>#38-2-feature-tour<br>#39-1-backup-and-restore | Matched 4/5 guide terms. |
| `xr-quest-integrations` | Quest / XR integrations: delinQuest video, queststitch passthrough, two-way Quest MIDI bridge, hand-tracked control of theDAW, and Quest colocation, without Quest Link or MQDH | vj | implemented | **documented** | #1-repository-anatomy<br>#dedicated-in-app-sources-delinquest-stitch-cymatics-and-screen-capture<br>#34-quest-and-xr-integrations<br>#34-1-delinquest-quest-video-into-the-vj<br>#34-2-stitch-clean-passthrough-into-the-vj<br>#34-3-quest-midi-bridge<br>#34-4-hand-tracked-control-of-thedaw<br>#34-5-quest-colocation<br>#34-6-setup-notes<br>#34-8-deploy-to-quest | Matched 7/7 guide terms. |
| `vj-camera-sources` | VJ dedicated sources: delinQuest, STITCH passthrough, procedural cymatics, and screen/window capture, alongside webcam/phone/Quest-browser inputs | vj | implemented | **documented** | #1-repository-anatomy<br>#8-1-layout<br>#dedicated-in-app-sources-delinquest-stitch-cymatics-and-screen-capture<br>#12-3-how-the-visualizations-are-rendered<br>#25-5-promo-video-capture<br>#34-1-delinquest-quest-video-into-the-vj<br>#34-2-stitch-clean-passthrough-into-the-vj<br>#34-6-setup-notes | Matched 5/5 guide terms. |
| `vj-broadcast-watch-link` | VJ broadcast watch-link: WebRTC signaling for a live peer-to-peer viewer URL of the VJ output | vj | experimental | **documented** | #1-repository-anatomy<br>#10-5-broadcast-and-watch-link | Matched 4/4 guide terms. |
| `dj-two-deck-console` | DJ two-deck console with crossfader, EQ/filter/pitch, hotcues, beat loops, and per-deck live stems | daw | implemented | **documented** | #5-ui-shell<br>#purpose<br>#9-1-waveform-hero-and-decks<br>#9-2-per-deck-transport-and-cueing<br>#9-3-center-mixer<br>#9-6-midi-learn<br>#9-9-design-mode<br>#dedicated-in-app-sources-delinquest-stitch-cymatics-and-screen-capture<br>#34-4-hand-tracked-control-of-thedaw | Matched 4/6 guide terms. |
| `session-perform-scene-grid` | PERFORM session view that imports a DAW project and plays its scene / clip grid live | daw | implemented | **documented** | #table-of-contents<br>#5-ui-shell<br>#purpose<br>#dedicated-in-app-sources-delinquest-stitch-cymatics-and-screen-capture<br>#10-2-pop-out-and-mobile<br>#10-4-export<br>#13-9-format-conversion<br>#34-quest-and-xr-integrations<br>#34-2-stitch-clean-passthrough-into-the-vj<br>#34-4-hand-tracked-control-of-thedaw<br>#34-5-quest-colocation<br>#34-7-midi-reactor<br>#35-perform-tab<br>#35-3-routing-panel<br>#35-4-daw-project-into-a-scene<br>#37-2-the-tasmo-project-format<br>#37-3-daw-import-parser-set<br>#38-1-home-overlay | Matched 2/5 guide terms. |
| `foundry-plugin-ui-builder` | Foundry plugin-UI builder that designs and exports custom VST / plugin interfaces | backend-module | experimental | **documented** | #table-of-contents<br>#1-repository-anatomy<br>#5-ui-shell<br>#8-8-the-gan-web-plugin-loader<br>#36-foundry-tab<br>#purpose<br>#36-1-the-sidecar<br>#36-2-exports-into-mix<br>#38-1-home-overlay | Matched 3/4 guide terms. |
| `underfit-lora-trainer` | Underfit LoRA trainer dashboard embedded as a tab (localhost:8791) | train | experimental | **documented** | #table-of-contents<br>#1-repository-anatomy<br>#checkpoint-flavors<br>#5-ui-shell<br>#6-2-generation-parameters<br>#6-6-lora-adaptive-layers<br>#11-underfit-tab<br>#purpose<br>#11-1-the-embedded-dashboard<br>#11-2-sidecar-lifecycle<br>#11-3-missing-environment-state<br>#11-4-dataset-to-lora-flow<br>#producers<br>#19-9-training-and-autoencoder-stub-endpoints<br>#20-4-autoencoder<br>#20-5-lora-at-inference<br>#21-models<br>#21-2-manual-model-placement-download-links-and-folder-tree<br>#22-lora-adapter-types<br>#training-configuration<br>#underfit-tab-reports-a-missing-environment-or-stays-on-connecting<br>#38-1-home-overlay<br>#38-2-feature-tour | Matched 4/4 guide terms. |

## Screenshot Mapping

| File | Kind | Source scene | Feature IDs | Docs sections |
|---|---|---|---|---|
| `01-shell-make.png` | full | 01-shell-make | `shell-center-tabs-right-library`<br>`create-advanced-generation-templates-prompts-spectrograms`<br>`docs-modal-download-print-rag`<br>`assistant-orb-providers-keys-attachments` | §5 UI Shell<br>§6 MAKE Tab<br>§22 Screenshot Manifest |
| `01-shell-make__header-actions.png` | crop | 01-shell-make | `docs-modal-download-print-rag`<br>`settings-feature-toggles-modules-admin`<br>`assistant-orb-providers-keys-attachments`<br>`vj-sidecar-tab-mobile-share` | §5 UI Shell<br>§6 MAKE Tab<br>§22 Screenshot Manifest |
| `01-shell-make__make-controls.png` | crop | 01-shell-make | `create-advanced-generation-templates-prompts-spectrograms`<br>`create-chimera-fusion-stack`<br>`create-mic-recorder-send-targets` | §5 UI Shell<br>§6 MAKE Tab<br>§22 Screenshot Manifest |
| `02-make-model-picker.png` | full | 02-make-model-picker | `create-advanced-generation-templates-prompts-spectrograms`<br>`magenta-rt2-generate`<br>`suno-cloud-generation` | §6 MAKE Tab |
| `02-make-model-picker__model-control.png` | crop | 02-make-model-picker | `create-advanced-generation-templates-prompts-spectrograms`<br>`magenta-rt2-generate`<br>`suno-cloud-generation` | §6 MAKE Tab |
| `03-make-init-audio.png` | full | 03-make-init-audio | `create-advanced-generation-templates-prompts-spectrograms`<br>`waveform-editor-inpaint-review` | §6 MAKE Tab |
| `03-make-init-audio__init-audio.png` | crop | 03-make-init-audio | `create-advanced-generation-templates-prompts-spectrograms`<br>`waveform-editor-inpaint-review` | §6 MAKE Tab |
| `04-make-chimera.png` | full | 04-make-chimera | `create-chimera-fusion-stack` | §6 MAKE Tab |
| `04-make-chimera__chimera-stack.png` | crop | 04-make-chimera | `create-chimera-fusion-stack` | §6 MAKE Tab |
| `05-edit-timeline.png` | full | 05-edit-timeline | `edit-advanced-effects-chain-analyzer`<br>`edit-timeline-live-midi-soundfont`<br>`library-stems-midi-first-class` | §7 EDIT Tab |
| `05-edit-timeline__edit-timeline.png` | crop | 05-edit-timeline | `edit-advanced-effects-chain-analyzer`<br>`edit-timeline-live-midi-soundfont` | §7 EDIT Tab |
| `06-edit-automation.png` | full | 06-edit-automation | `edit-insert-fx-rack`<br>`edit-advanced-effects-chain-analyzer` | §7 EDIT Tab |
| `06-edit-automation__automation-lane.png` | crop | 06-edit-automation | `edit-insert-fx-rack`<br>`edit-advanced-effects-chain-analyzer` | §7 EDIT Tab |
| `07-edit-fx-rack.png` | full | 07-edit-fx-rack | `edit-insert-fx-rack`<br>`edit-spatializer-teleport-autopilot` | §7 EDIT Tab |
| `07-edit-fx-rack__fx-rack.png` | crop | 07-edit-fx-rack | `edit-insert-fx-rack`<br>`edit-spatializer-teleport-autopilot` | §7 EDIT Tab |
| `08-mix-effect-rail.png` | full | 08-mix-effect-rail | `edit-advanced-effects-chain-analyzer`<br>`edit-tool-stack-modules` | §8 MIX Tab |
| `08-mix-effect-rail__mix-rail.png` | crop | 08-mix-effect-rail | `edit-advanced-effects-chain-analyzer`<br>`edit-tool-stack-modules` | §8 MIX Tab |
| `09-mix-vst-node.png` | full | 09-mix-vst-node | `edit-tool-stack-modules`<br>`edit-advanced-effects-chain-analyzer` | §8 MIX Tab |
| `09-mix-vst-node__vst-node.png` | crop | 09-mix-vst-node | `edit-tool-stack-modules` | §8 MIX Tab |
| `10-mix-gan-node.png` | full | 10-mix-gan-node | `edit-tool-stack-modules` | §8 MIX Tab |
| `10-mix-gan-node__gan-stage.png` | crop | 10-mix-gan-node | `edit-tool-stack-modules` | §8 MIX Tab |
| `11-perform-grid.png` | full | 11-perform-grid | `session-perform-scene-grid` | §12 PERFORM Tab |
| `11-perform-grid__perform-grid.png` | crop | 11-perform-grid | `session-perform-scene-grid` | §12 PERFORM Tab |
| `12-dj-console.png` | full | 12-dj-console | `dj-two-deck-console` | §10 DJ Tab |
| `12-dj-console__deck-a.png` | crop | 12-dj-console | `dj-two-deck-console` | §10 DJ Tab |
| `12-dj-console__deck-b.png` | crop | 12-dj-console | `dj-two-deck-console` | §10 DJ Tab |
| `13-dj-stems.png` | full | 13-dj-stems | `dj-two-deck-console`<br>`library-stems-midi-first-class` | §10 DJ Tab |
| `13-dj-stems__deck-stems.png` | crop | 13-dj-stems | `dj-two-deck-console`<br>`library-stems-midi-first-class` | §10 DJ Tab |
| `14-vj-visualizer.png` | full | 14-vj-visualizer | `vj-sidecar-tab-mobile-share`<br>`vj-camera-sources` | §11 VJ Tab |
| `14-vj-visualizer__vj-surface.png` | crop | 14-vj-visualizer | `vj-sidecar-tab-mobile-share`<br>`vj-camera-sources` | §11 VJ Tab |
| `15-foundry-canvas.png` | full | 15-foundry-canvas | `foundry-plugin-ui-builder` | §14 Foundry Tab |
| `15-foundry-canvas__foundry-canvas.png` | crop | 15-foundry-canvas | `foundry-plugin-ui-builder` | §14 Foundry Tab |
| `16-underfit-dashboard.png` | full | 16-underfit-dashboard | `underfit-lora-trainer` | §15 Underfit Tab |
| `16-underfit-dashboard__underfit-dash.png` | crop | 16-underfit-dashboard | `underfit-lora-trainer` | §15 Underfit Tab |
| `17-learn-graph.png` | full | 17-learn-graph | `library-bundle-download-lineage-export` | §9 LIBRARY Tab<br>§17 LEARN Tab |
| `17-learn-graph__lineage-graph.png` | crop | 17-learn-graph | `library-bundle-download-lineage-export` | §9 LIBRARY Tab<br>§17 LEARN Tab |
| `18-library-showcase-selected.png` | full | 18-library-showcase-selected | `library-backend-local-storage`<br>`catalogue-cross-provider-browser` | §9 LIBRARY Tab<br>§13 Bottom Panel Tabs |
| `18-library-showcase-selected__library-details.png` | crop | 18-library-showcase-selected | `shell-center-tabs-right-library`<br>`library-backend-local-storage` | §9 LIBRARY Tab<br>§13 Bottom Panel Tabs |
| `19-library-right-click.png` | full | 19-library-right-click | `library-stems-sidecar`<br>`library-midi-conversion`<br>`library-bundle-download-lineage-export`<br>`media-bucket-routing` | §9 LIBRARY Tab<br>§16 Backend API Reference |
| `19-library-right-click__entry-context-menu.png` | crop | 19-library-right-click | `library-stems-sidecar`<br>`library-midi-conversion`<br>`library-bundle-download-lineage-export`<br>`media-bucket-routing` | §9 LIBRARY Tab<br>§16 Backend API Reference |
| `20-library-download-submenu.png` | full | 20-library-download-submenu | `library-bundle-download-lineage-export`<br>`library-midi-conversion` | §9 LIBRARY Tab |
| `20-library-download-submenu__download-submenu.png` | crop | 20-library-download-submenu | `library-bundle-download-lineage-export`<br>`library-midi-conversion` | §9 LIBRARY Tab |
| `21-piano-roll.png` | full | 21-piano-roll | `piano-roll-linked-clip-editing` | §13 Bottom Panel Tabs |
| `21-piano-roll__piano-roll.png` | crop | 21-piano-roll | `piano-roll-linked-clip-editing` | §13 Bottom Panel Tabs |
| `22-step-sequencer.png` | full | 22-step-sequencer | `sequencer-midi-export-render` | §13 Bottom Panel Tabs |
| `22-step-sequencer__step-grid.png` | crop | 22-step-sequencer | `sequencer-midi-export-render` | §13 Bottom Panel Tabs |
| `23-score-arrange.png` | full | 23-score-arrange | `library-midi-conversion`<br>`piano-roll-linked-clip-editing` | §13 Bottom Panel Tabs |
| `23-score-arrange__sheet.png` | crop | 23-score-arrange | `library-midi-conversion` | §13 Bottom Panel Tabs |
| `24-score-tabs.png` | full | 24-score-tabs | `library-midi-conversion`<br>`piano-roll-linked-clip-editing` | §13 Bottom Panel Tabs |
| `24-score-tabs__tabs.png` | crop | 24-score-tabs | `library-midi-conversion` | §13 Bottom Panel Tabs |
| `25-audio-to-midi.png` | full | 25-audio-to-midi | `library-midi-conversion` | §9 LIBRARY Tab<br>§16 Backend API Reference |
| `25-audio-to-midi__convert-menu.png` | crop | 25-audio-to-midi | `library-midi-conversion` | §9 LIBRARY Tab<br>§16 Backend API Reference |
| `26-analyzer.png` | full | 26-analyzer | `edit-advanced-effects-chain-analyzer` | §13 Bottom Panel Tabs |
| `26-analyzer__analyzer.png` | crop | 26-analyzer | `edit-advanced-effects-chain-analyzer` | §13 Bottom Panel Tabs |
| `27-details-panel.png` | full | 27-details-panel | `library-backend-local-storage`<br>`catalogue-cross-provider-browser` | §13 Bottom Panel Tabs |
| `27-details-panel__details.png` | crop | 27-details-panel | `library-backend-local-storage` | §13 Bottom Panel Tabs |
| `28-settings-modal.png` | full | 28-settings-modal | `settings-feature-toggles-modules-admin`<br>`backend-module-loader-settings` | §5 UI Shell<br>§16 Backend API Reference |
| `28-settings-modal__settings-toggles.png` | crop | 28-settings-modal | `settings-feature-toggles-modules-admin`<br>`backend-module-loader-settings` | §5 UI Shell<br>§16 Backend API Reference |
| `29-app-menu.png` | full | 29-app-menu | `shell-center-tabs-right-library`<br>`settings-feature-toggles-modules-admin` | §5 UI Shell |
| `29-app-menu__app-menu.png` | crop | 29-app-menu | `shell-center-tabs-right-library`<br>`settings-feature-toggles-modules-admin` | §5 UI Shell |
| `30-home-screen.png` | full | 30-home-screen | `shell-center-tabs-right-library` | §5 UI Shell |
| `30-home-screen__home-overlay.png` | crop | 30-home-screen | `shell-center-tabs-right-library` | §5 UI Shell |
| `31-feature-tour.png` | full | 31-feature-tour | `create-chimera-fusion-stack`<br>`shell-center-tabs-right-library` | §5 UI Shell<br>§6 MAKE Tab |
| `31-feature-tour__tour-step.png` | crop | 31-feature-tour | `create-chimera-fusion-stack` | §5 UI Shell<br>§6 MAKE Tab |
| `32-backup-modal.png` | full | 32-backup-modal | `settings-feature-toggles-modules-admin` | §5 UI Shell |
| `32-backup-modal__backup.png` | crop | 32-backup-modal | `settings-feature-toggles-modules-admin` | §5 UI Shell |
| `33-update-modal.png` | full | 33-update-modal | `settings-feature-toggles-modules-admin` | §5 UI Shell |
| `33-update-modal__update.png` | crop | 33-update-modal | `settings-feature-toggles-modules-admin` | §5 UI Shell |
| `34-quest-deploy.png` | full | 34-quest-deploy | `xr-quest-integrations` | §5 UI Shell<br>§16 Backend API Reference |
| `34-quest-deploy__quest.png` | crop | 34-quest-deploy | `xr-quest-integrations` | §5 UI Shell<br>§16 Backend API Reference |
| `35-suno-cloud.png` | full | 35-suno-cloud | `suno-cloud-generation` | §6 MAKE Tab |
| `35-suno-cloud__suno-panel.png` | crop | 35-suno-cloud | `suno-cloud-generation` | §6 MAKE Tab |
| `36-magenta-live.png` | full | 36-magenta-live | `magenta-rt2-generate` | §6 MAKE Tab |
| `36-magenta-live__magenta-panel.png` | crop | 36-magenta-live | `magenta-rt2-generate` | §6 MAKE Tab |
| `37-assistant.png` | full | 37-assistant | `assistant-orb-providers-keys-attachments`<br>`docs-modal-download-print-rag` | §5 UI Shell |
| `37-assistant__assistant-panel.png` | crop | 37-assistant | `assistant-orb-providers-keys-attachments` | §5 UI Shell |
| `38-media-bucket.png` | full | 38-media-bucket | `media-bucket-routing` | §13 Bottom Panel Tabs |
| `38-media-bucket__bucket.png` | crop | 38-media-bucket | `media-bucket-routing` | §13 Bottom Panel Tabs |
| `39-url-import.png` | full | 39-url-import | `ytimport-youtube-import`<br>`media-bucket-routing` | §13 Bottom Panel Tabs<br>§16 Backend API Reference |
| `39-url-import__url-import.png` | crop | 39-url-import | `ytimport-youtube-import` | §13 Bottom Panel Tabs<br>§16 Backend API Reference |
| `40-controller-vision.png` | full | 40-controller-vision | `controller-vision-detect-identify` | §13 Bottom Panel Tabs<br>§16 Backend API Reference |
| `40-controller-vision__cv-modal.png` | crop | 40-controller-vision | `controller-vision-detect-identify` | §13 Bottom Panel Tabs<br>§16 Backend API Reference |

## Required Documentation Follow-up

> [!TIP]
> Coverage is currently clean. Keep it that way by updating `scripts/screenshots/specs.ts`, `docs/USER_GUIDE.md`, and screenshot mappings in the same change whenever a feature changes.
