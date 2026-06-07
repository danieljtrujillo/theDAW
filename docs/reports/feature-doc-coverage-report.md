# Feature Documentation Coverage Report

> [!NOTE]
> Generated: 2026-06-07T17:38:20.718Z · Git revision: `8001dab5090b` · Repomix tracked: **no**

## Audit Dashboard

| Metric | Value |
|---|---:|
| Documentation coverage | **94%** |
| Features inventoried | **18** |
| Documented features | **17** |
| Missing docs | **0** |
| Partial docs | **1** |
| Full screenshot scenes | **9** |
| Cropped screenshot assets | **10** |

> [!IMPORTANT]
> Repomix context: not present; tracked=false. Repomix context was not present for this run.

## Coverage Matrix

| Feature ID | Feature | Domain | Status | Coverage | Anchors | Notes |
|---|---|---|---|---|---|---|
| `shell-center-tabs-right-library` | Center-tab workspace shell with collapsible right library rail | daw | implemented | **documented** | #5-ui-shell<br>#zustand-store-architecture | Matched 3/4 guide terms. |
| `docs-modal-download-print-rag` | In-app docs modal with raw Markdown download, print/PDF, anchors, and RAG source copy | assistant | implemented | **documented** | #5-ui-shell<br>#19-11-assistant<br>#25-4-documentation-maintenance-rule | Matched 2/4 guide terms. |
| `assistant-orb-providers-keys-attachments` | AI Assistant orb with provider/model selection, key pools, attachments, voice input, and streaming chat | assistant | implemented | **documented** | #5-ui-shell<br>#19-11-assistant | Matched 4/5 guide terms. |
| `create-advanced-generation-templates-prompts-spectrograms` | Advanced generation controls with templates, saved prompts, prompt enhancer, output settings, and spectrogram viewer | create | implemented | **documented** | #6-1-primary-synthesis-prompt<br>#6-3-advanced-generation-panel | Matched 4/4 guide terms. |
| `create-chimera-fusion-stack` | Chimera multi-clip fusion stack with BPM alignment, base clip, noise weights, and weave scheduling | chimera | implemented | **documented** | #1-repository-anatomy<br>#purpose<br>#6-3-1-chimera-fusion-stack<br>#6-4-init-signal-conditioning<br>#12-2-3d-graph-controls<br>#13-1-automatic-entry-creation<br>#13-5-bundle-downloads-and-lineage<br>#19-14-chimera<br>#25-3-current-feature-to-screenshot-map | Matched 5/5 guide terms. |
| `create-mic-recorder-send-targets` | Browser microphone recorder that can send recordings to editor, init, inpaint, or library | create | implemented | **documented** | #6-3-1-chimera-fusion-stack<br>#6-4-1-microphone-recorder<br>#10-1-inputs<br>#10-4-export<br>#13-1-automatic-entry-creation | Matched 5/5 guide terms. |
| `edit-advanced-effects-chain-analyzer` | Advanced effects chain with categorized FFmpeg processors, column resizing, waveform previews, and source/output stats | edit | implemented | **partial** | #8-3-effect-catalog-and-chain | Only matched 1/5 guide terms: Effect Catalog |
| `library-backend-local-storage` | Disk-backed backend library provider with range-streamed audio and mutable metadata | library | implemented | **documented** | #6-4-1-microphone-recorder<br>#purpose<br>#13-1-automatic-entry-creation<br>#19-13-disk-backed-library<br>#19-15-stems<br>#library-storage-fills-the-disk<br>#zustand-store-architecture | Matched 4/5 guide terms. |
| `library-bundle-download-lineage-export` | Library bundle downloads and lineage graph exports including metadata, stems, MIDI, and relations | library | implemented | **documented** | #12-2-3d-graph-controls<br>#13-4-per-entry-controls<br>#13-5-bundle-downloads-and-lineage<br>#19-13-disk-backed-library | Matched 2/4 guide terms. |
| `library-stems-sidecar` | Stem separation sidecar with install/start/stop/status/progress/abort and persisted stem rows | library | implemented | **documented** | #13-4-per-entry-controls<br>#13-6-stem-separation<br>#19-15-stems | Matched 3/4 guide terms. |
| `library-midi-conversion` | Audio-to-MIDI conversion with installable engines, persisted MIDI rows, and editor send targets | library | implemented | **documented** | #6-4-1-microphone-recorder<br>#13-4-per-entry-controls<br>#13-7-midi-conversion<br>#19-16-midi | Matched 4/4 guide terms. |
| `settings-feature-toggles-modules-admin` | Settings modal for feature toggles, module enablement, restart, and shutdown controls | settings | implemented | **documented** | #one-shot-launcher-windows<br>#19-8-jobs-list<br>#19-11-assistant<br>#19-12-module-loader<br>#api-unreachable-banner-in-the-header<br>#backend-job-persistence<br>#25-3-current-feature-to-screenshot-map | Matched 4/5 guide terms. |
| `waveform-editor-inpaint-review` | Waveform editor paintbrush inpainting workflow with crop-aware mask submission and accept/discard review | daw | implemented | **documented** | #frontend-dependencies<br>#6-5-inpainting-regen-region<br>#6-8-run-generation<br>#7-4-inpainting-from-the-editor<br>#14-2-voice-synthesis<br>#16-5-media<br>#controls<br>#19-4-generation-async-thedaw-ui<br>#19-12-module-loader<br>#19-13-disk-backed-library<br>#19-14-chimera | Matched 5/5 guide terms. |
| `sequencer-midi-export-render` | Step sequencer Standard MIDI export plus single-track/multi-track render-to-editor flows | daw | implemented | **documented** | #13-7-midi-conversion<br>#14-5-midi-export<br>#15-5-midi-import-and-export | Matched 2/4 guide terms. |
| `piano-roll-linked-clip-editing` | Piano roll MIDI import/export, render-to-editor, and linked clip re-editing | daw | implemented | **documented** | #15-5-midi-import-and-export<br>#15-7-edit-in-piano-roll<br>#16-6-slide | Matched 4/4 guide terms. |
| `media-bucket-routing` | Media Bucket send targets for editor, library, init audio, and Chimera stack | daw | implemented | **documented** | #6-3-1-chimera-fusion-stack<br>#8-4-source-output-and-routing<br>#13-4-per-entry-controls<br>#16-5-media | Matched 3/4 guide terms. |
| `vj-sidecar-tab-mobile-share` | VJ tab and mobile share link for iframe/tunnel-backed performance access | vj | experimental | **documented** | #table-of-contents<br>#5-ui-shell<br>#10-vj-tab<br>#purpose<br>#10-3-bridges<br>#10-4-export<br>#19-17-vj | Matched 3/4 guide terms. |
| `backend-module-loader-settings` | Backend module loader with module manifests and runtime enable/disable settings | backend-module | implemented | **documented** | #1-repository-anatomy<br>#19-12-module-loader<br>#adding-a-backend-module<br>#zustand-store-architecture | Matched 4/4 guide terms. |

## Screenshot Mapping

| File | Kind | Source scene | Feature IDs | Docs sections |
|---|---|---|---|---|
| `01-shell-make.png` | full | 01-shell-make | `shell-center-tabs-right-library`<br>`create-advanced-generation-templates-prompts-spectrograms`<br>`docs-modal-download-print-rag`<br>`assistant-orb-providers-keys-attachments` | §5 UI Shell<br>§6 CREATE Tab<br>§22 Screenshot Manifest |
| `01-shell-make__header-actions.png` | crop | 01-shell-make | `docs-modal-download-print-rag`<br>`settings-feature-toggles-modules-admin`<br>`assistant-orb-providers-keys-attachments`<br>`vj-sidecar-tab-mobile-share` | §5 UI Shell<br>§6 CREATE Tab<br>§22 Screenshot Manifest |
| `01-shell-make__make-controls.png` | crop | 01-shell-make | `create-advanced-generation-templates-prompts-spectrograms`<br>`create-chimera-fusion-stack`<br>`create-mic-recorder-send-targets` | §5 UI Shell<br>§6 CREATE Tab<br>§22 Screenshot Manifest |
| `02-library-with-showcase-selected.png` | full | 02-library-with-showcase-selected | `library-backend-local-storage`<br>`media-bucket-routing` | §9 LIBRARY Tab<br>§13 Bottom Panel Tabs |
| `02-library-with-showcase-selected__library-details.png` | crop | 02-library-with-showcase-selected | `shell-center-tabs-right-library`<br>`library-backend-local-storage` | §9 LIBRARY Tab<br>§13 Bottom Panel Tabs |
| `03-library-actions-toolbar.png` | full | 03-library-actions-toolbar | `library-stems-sidecar`<br>`library-midi-conversion`<br>`library-bundle-download-lineage-export`<br>`create-chimera-fusion-stack` | §9 LIBRARY Tab<br>§16 Backend API Reference |
| `03-library-actions-toolbar__library-toolbar.png` | crop | 03-library-actions-toolbar | `library-stems-sidecar`<br>`library-midi-conversion`<br>`library-bundle-download-lineage-export`<br>`create-chimera-fusion-stack` | §9 LIBRARY Tab<br>§16 Backend API Reference |
| `04-library-download-submenu.png` | full | 04-library-download-submenu | `library-bundle-download-lineage-export`<br>`library-midi-conversion` | §9 LIBRARY Tab |
| `04-library-download-submenu__download-submenu.png` | crop | 04-library-download-submenu | `library-bundle-download-lineage-export`<br>`library-midi-conversion` | §9 LIBRARY Tab |
| `05-library-entry-right-click.png` | full | 05-library-entry-right-click | `library-stems-sidecar`<br>`library-midi-conversion`<br>`library-bundle-download-lineage-export`<br>`media-bucket-routing` | §9 LIBRARY Tab<br>§16 Backend API Reference |
| `05-library-entry-right-click__entry-context-menu.png` | crop | 05-library-entry-right-click | `library-stems-sidecar`<br>`library-midi-conversion`<br>`library-bundle-download-lineage-export`<br>`media-bucket-routing` | §9 LIBRARY Tab<br>§16 Backend API Reference |
| `06-learn-tab-3d-graph.png` | full | 06-learn-tab-3d-graph | `library-bundle-download-lineage-export` | §9 LIBRARY Tab |
| `06-learn-tab-3d-graph__lineage-graph.png` | crop | 06-learn-tab-3d-graph | `library-bundle-download-lineage-export` | §9 LIBRARY Tab |
| `07-settings-modal-with-shutdown.png` | full | 07-settings-modal-with-shutdown | `settings-feature-toggles-modules-admin`<br>`backend-module-loader-settings` | §5 UI Shell<br>§16 Backend API Reference |
| `07-settings-modal-with-shutdown__settings-toggles.png` | crop | 07-settings-modal-with-shutdown | `settings-feature-toggles-modules-admin`<br>`backend-module-loader-settings` | §5 UI Shell<br>§16 Backend API Reference |
| `08-vj-tab-loading.png` | full | 08-vj-tab-loading | `vj-sidecar-tab-mobile-share` | §5 UI Shell<br>§16 Backend API Reference |
| `08-vj-tab-loading__vj-panel.png` | crop | 08-vj-tab-loading | `vj-sidecar-tab-mobile-share` | §5 UI Shell<br>§16 Backend API Reference |
| `09-chimera-cohort-multi-select.png` | full | 09-chimera-cohort-multi-select | `create-chimera-fusion-stack`<br>`library-backend-local-storage` | §6 CREATE Tab<br>§9 LIBRARY Tab |
| `09-chimera-cohort-multi-select__chimera-multi-select.png` | crop | 09-chimera-cohort-multi-select | `create-chimera-fusion-stack`<br>`library-backend-local-storage` | §6 CREATE Tab<br>§9 LIBRARY Tab |

## Required Documentation Follow-up

Patch `docs/USER_GUIDE.md` for every feature marked missing or partial. One screenshot may intentionally cover multiple feature IDs; use the screenshot mapping above rather than duplicating captures.
