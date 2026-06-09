export type FeatureDomain =
  | 'create'
  | 'edit'
  | 'train'
  | 'library'
  | 'daw'
  | 'assistant'
  | 'settings'
  | 'chimera'
  | 'vj'
  | 'backend-module';

export type FeatureStatus = 'implemented' | 'stubbed' | 'experimental';

export interface FeatureDescriptor {
  id: string;
  name: string;
  domain: FeatureDomain;
  sourcePaths: string[];
  evidence: string[];
  status: FeatureStatus;
  docSearchTerms: string[];
}

export interface DocCoverageEntry {
  featureId: string;
  docAnchors: string[];
  coverage: 'documented' | 'partial' | 'missing';
  notes: string;
}

export interface CropRegion {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  purpose: string;
  featureRefs: string[];
}

export interface ScreenshotSpec {
  sceneId: string;
  outputFile: string;
  viewport: { width: number; height: number };
  captureMode: 'full' | 'crop' | 'full+crop';
  cropRegions?: CropRegion[];
  featureRefs: string[];
  docsSections: string[];
}

export interface ScreenshotManifestEntry {
  file: string;
  label: string;
  features: string[];
  docsSections: string[];
  kind: 'full' | 'crop';
  sourceScene: string;
}

export interface CoverageReport {
  generatedAt: string;
  repoRevision: string;
  repomixContext: {
    path: string;
    present: boolean;
    tracked: boolean;
    note: string;
  };
  features: FeatureDescriptor[];
  coverage: DocCoverageEntry[];
  missingFeatureIds: string[];
  partialFeatureIds: string[];
  screenshotSpecs: ScreenshotSpec[];
  screenshotManifest: ScreenshotManifestEntry[];
}

export const VIEWPORT = { width: 1920, height: 1080 };

export const FEATURE_DESCRIPTORS: FeatureDescriptor[] = [
  {
    id: 'shell-center-tabs-right-library',
    name: 'Center-tab workspace shell with collapsible right library rail',
    domain: 'daw',
    sourcePaths: ['frontend/src/state/appUiStore.ts', 'frontend/src/components/layout/CenterTabBar.tsx', 'frontend/src/components/layout/Shell.tsx'],
    evidence: ['CENTER_TABS = make/edit/mix/train/learn/dj/vj', 'rightPanelWidth', 'Collapse/Expand library panel'],
    status: 'implemented',
    docSearchTerms: ['CENTER_TABS', 'right-side library', 'right library rail', 'MAKE / EDIT / MIX / TRAIN / LEARN / DJ / VJ'],
  },
  {
    id: 'docs-modal-download-print-rag',
    name: 'In-app docs modal with raw Markdown download, print/PDF, anchors, and RAG source copy',
    domain: 'assistant',
    sourcePaths: ['frontend/src/components/layout/DocsModal.tsx', 'backend/rag.py', 'backend/assistant_routes.py'],
    evidence: ['fetch(/USER_GUIDE.md)', 'Download raw Markdown', 'Print → Save as PDF', '/api/assistant/reindex'],
    status: 'implemented',
    docSearchTerms: ['Download raw Markdown', 'Save as PDF', 'Docs modal', 'RAG reindex'],
  },
  {
    id: 'assistant-orb-providers-keys-attachments',
    name: 'AI Assistant orb with provider/model selection, key pools, attachments, voice input, and streaming chat',
    domain: 'assistant',
    sourcePaths: ['frontend/src/orb-kit/AssistantPanel.tsx', 'frontend/src/orb-kit/promptEnhancer.ts', 'backend/assistant_routes.py', 'backend/key_pool.py'],
    evidence: ['/api/assistant/providers', '/api/assistant/chat', '/api/assistant/keys', 'Attach files', 'Voice input'],
    status: 'implemented',
    docSearchTerms: ['Provider catalog', 'Key pool management', 'Attach files', 'Voice input', 'claudeMode'],
  },
  {
    id: 'create-advanced-generation-templates-prompts-spectrograms',
    name: 'Advanced generation controls with templates, saved prompts, prompt enhancer, output settings, and spectrogram viewer',
    domain: 'create',
    sourcePaths: ['frontend/src/views/AdvancedGenPanel.tsx', 'frontend/src/data/generationPresets.ts', 'frontend/src/orb-kit/promptEnhancer.ts'],
    evidence: ['TemplatesPanel', 'SavedPromptsDropdown', 'enhanceStableAudioPrompt', 'Spectrogram Viewer'],
    status: 'implemented',
    docSearchTerms: ['Templates Panel', 'Saved Prompts', 'Spectrogram Viewer', 'Magic prompt'],
  },
  {
    id: 'create-chimera-fusion-stack',
    name: 'Chimera multi-clip fusion stack with BPM alignment, base clip, noise weights, and weave scheduling',
    domain: 'chimera',
    sourcePaths: ['frontend/src/components/chimera/ChimeraStack.tsx', 'frontend/src/components/chimera/ChimeraControls.tsx', 'frontend/src/lib/chimeraClient.ts', 'backend/modules/chimera/router.py'],
    evidence: ['/api/chimera/mashup', 'target_bpm', 'base_index', 'align_mode=start/downbeat/weave', 'weave_max_polyphony'],
    status: 'implemented',
    docSearchTerms: ['Chimera', 'FUSE', 'weave', 'target BPM', 'base clip'],
  },
  {
    id: 'create-mic-recorder-send-targets',
    name: 'Browser microphone recorder that can send recordings to editor, init, inpaint, or library',
    domain: 'create',
    sourcePaths: ['frontend/src/components/audio/MicRecorder.tsx', 'frontend/src/lib/sendToTargets.ts'],
    evidence: ['navigator.mediaDevices.getUserMedia', 'MediaRecorder', 'sendAudioToEditor', 'sendAudioToInit', 'sendAudioToInpaint', '/api/library/import'],
    status: 'implemented',
    docSearchTerms: ['Microphone', 'Mic Recorder', 'MediaRecorder', 'getUserMedia', 'recording'],
  },
  {
    id: 'edit-advanced-effects-chain-analyzer',
    name: 'Advanced effects chain with categorized FFmpeg processors, column resizing, waveform previews, and source/output stats',
    domain: 'edit',
    sourcePaths: ['frontend/src/views/AdvancedEditorPanel.tsx', 'frontend/src/state/effectChainStore.ts', 'backend/modules/effects/router.py'],
    evidence: ['EFFECT_CATALOG', 'PARAM_BOUNDS', 'analyzeAudio', 'process chain'],
    status: 'implemented',
    docSearchTerms: ['Effect Catalog', 'Quick Master', 'EFFECT_CATALOG', 'PARAM_BOUNDS', '/api/studio/process'],
  },
  {
    id: 'library-backend-local-storage',
    name: 'Disk-backed backend library provider with range-streamed audio and mutable metadata',
    domain: 'library',
    sourcePaths: ['frontend/src/lib/backendLocalProvider.ts', 'frontend/src/state/libraryStore.ts', 'backend/modules/library/router.py', 'backend/modules/library/store.py'],
    evidence: ['/api/library/entries', '/api/library/audio/{id}', '/api/library/import', 'BackendLocalProvider'],
    status: 'implemented',
    docSearchTerms: ['BackendLocalProvider', 'disk-backed', '/api/library/entries', 'data/generations', 'range requests'],
  },
  {
    id: 'library-bundle-download-lineage-export',
    name: 'Library bundle downloads and lineage graph exports including metadata, stems, MIDI, and relations',
    domain: 'library',
    sourcePaths: ['backend/modules/library/router.py', 'backend/modules/library/bundle.py', 'frontend/src/components/library/LineageModal.tsx'],
    evidence: ['/api/library/{entry_id}/bundle', '/api/library/{entry_id}/lineage', '/api/library/_graph/all'],
    status: 'implemented',
    docSearchTerms: ['Download bundle', 'Show lineage', 'lineage graph', '/api/library/_graph/all'],
  },
  {
    id: 'library-stems-sidecar',
    name: 'Stem separation sidecar with install/start/stop/status/progress/abort and persisted stem rows',
    domain: 'library',
    sourcePaths: ['backend/modules/stems/router.py', 'backend/modules/stems/engine.py', 'frontend/src/components/library/StemsRunModal.tsx'],
    evidence: ['/api/stems/probe', '/api/stems/install', '/api/stems/{entry_id}/run', '/api/stems/{entry_id}/progress', '/api/library/stems/{stem_id}/audio'],
    status: 'implemented',
    docSearchTerms: ['Separate stems', 'stems sidecar', '/api/stems', 'stem separation'],
  },
  {
    id: 'library-midi-conversion',
    name: 'Audio-to-MIDI conversion with installable engines, persisted MIDI rows, and editor send targets',
    domain: 'library',
    sourcePaths: ['backend/modules/midi/router.py', 'backend/modules/midi/runner.py', 'frontend/src/lib/sendToTargets.ts'],
    evidence: ['/api/midi/install', '/api/midi/{entry_id}/run', '/api/midi/file/{midi_id}', 'basic_pitch'],
    status: 'implemented',
    docSearchTerms: ['Convert to MIDI', 'basic_pitch', '/api/midi', 'MIDI conversion'],
  },
  {
    id: 'settings-feature-toggles-modules-admin',
    name: 'Settings modal for feature toggles, module enablement, restart, and shutdown controls',
    domain: 'settings',
    sourcePaths: ['frontend/src/components/layout/SettingsModal.tsx', 'frontend/src/state/featureToggleStore.ts', 'backend/modules/settings/router.py', 'backend/admin_routes.py'],
    evidence: ['/api/settings', '/api/modules/all', '/api/modules/{dirName}/enabled', '/api/admin/restart', '/api/admin/shutdown'],
    status: 'implemented',
    docSearchTerms: ['Feature toggles', 'module enablement', 'Restart', 'Shutdown', '/api/settings'],
  },
  {
    id: 'waveform-editor-inpaint-review',
    name: 'Waveform editor paintbrush inpainting workflow with crop-aware mask submission and accept/discard review',
    domain: 'daw',
    sourcePaths: ['frontend/src/components/audio/WaveformEditor.tsx', 'frontend/src/state/editorStore.ts'],
    evidence: ['INPAINT REGION', 'cropAudioBlob', 'mask_start', 'mask_end', 'Accept', 'Discard'],
    status: 'implemented',
    docSearchTerms: ['INPAINT REGION', 'Accept', 'Discard', 'cropAudioBlob', 'paintbrush'],
  },
  {
    id: 'sequencer-midi-export-render',
    name: 'Step sequencer Standard MIDI export plus single-track/multi-track render-to-editor flows',
    domain: 'daw',
    sourcePaths: ['frontend/src/components/audio/StepSequencer.tsx', 'frontend/src/utils/midi.ts'],
    evidence: ['Download this pattern as a Standard MIDI File', 'single mixed track', 'multi-track MIDI', 'Render this pattern to audio'],
    status: 'implemented',
    docSearchTerms: ['Export as a single mixed track', 'multi-track MIDI', 'Standard MIDI File', 'bars to render'],
  },
  {
    id: 'piano-roll-linked-clip-editing',
    name: 'Piano roll MIDI import/export, render-to-editor, and linked clip re-editing',
    domain: 'daw',
    sourcePaths: ['frontend/src/components/audio/PianoRoll.tsx', 'frontend/src/state/pianoRollStore.ts', 'frontend/src/utils/midi.ts'],
    evidence: ['Import MIDI file', 'Download as a Standard MIDI File', 'Edit in Piano Roll', 'Detach'],
    status: 'implemented',
    docSearchTerms: ['Edit in Piano Roll', 'Detach', 'Import MIDI', 'Export MIDI'],
  },
  {
    id: 'media-bucket-routing',
    name: 'Media Bucket send targets for editor, library, init audio, and Chimera stack',
    domain: 'daw',
    sourcePaths: ['frontend/src/components/layout/MediaBucketView.tsx', 'frontend/src/lib/sendToTargets.ts', 'frontend/src/lib/audioDnD.ts'],
    evidence: ['Send to INIT (Chimera stack)', 'Send to a new editor track', 'Save to library', 'application/x-stabledaw-library-id'],
    status: 'implemented',
    docSearchTerms: ['Media Bucket', 'Send to INIT', 'Chimera stack', 'application/x-stabledaw-library-id'],
  },
  {
    id: 'vj-sidecar-tab-mobile-share',
    name: 'VJ tab and mobile share link for iframe/tunnel-backed performance access',
    domain: 'vj',
    sourcePaths: ['frontend/src/views/VJView.tsx', 'frontend/src/components/layout/Shell.tsx', 'backend/modules/vj/router.py'],
    evidence: ['VJ tab', 'Open mobile access QR/link', 'iframe', '/api/vj'],
    status: 'experimental',
    docSearchTerms: ['VJ tab', 'mobile access QR', 'share URL', '/api/vj'],
  },
  {
    id: 'backend-module-loader-settings',
    name: 'Backend module loader with module manifests and runtime enable/disable settings',
    domain: 'backend-module',
    sourcePaths: ['backend/modules/loader.py', 'backend/modules/settings/router.py', 'frontend/src/components/layout/SettingsModal.tsx'],
    evidence: ['module.json', 'api_prefix', '/api/modules', '/api/modules/all'],
    status: 'implemented',
    docSearchTerms: ['Module Loader', 'module.json', '/api/modules/all', 'enabled flag'],
  },
  {
    id: 'suno-cloud-generation',
    name: 'Suno cloud generation (Aurora Cloud Console) with simple/custom/cover/mashup, server-side key, and library lineage',
    domain: 'create',
    sourcePaths: ['backend/modules/suno/router.py', 'frontend/src/suno/SunoGenPanel.tsx', 'frontend/src/suno/sunoApi.ts', 'frontend/src/suno/sunoStore.ts'],
    evidence: ['/api/suno/simple', '/api/suno/custom', '/api/suno/cover', '/api/suno/mashup', 'sunoid:<clip_id> library tag', 'cover/mashup lineage edges'],
    status: 'implemented',
    docSearchTerms: ['Aurora Cloud Console', 'sunoid', '/api/suno/simple', 'mashup', 'Suno'],
  },
  {
    id: 'magenta-rt2-generate',
    name: 'Magenta RealTime 2 generation (text/notes/audio-style) via the WSL2 NVIDIA sidecar, the first non-Mac MRT2 port',
    domain: 'create',
    sourcePaths: ['backend/modules/magenta/router.py', 'backend/modules/magenta/sidecar.py', 'sidecars/magenta/server.py', 'frontend/src/views/AdvancedGenPanel.tsx'],
    evidence: ['/api/magenta/probe', '/api/magenta/generate', 'MagentaRT2Jax', 'text/notes/audio-style conditioning', 'patch_cmake.py removes macOS-only guard'],
    status: 'experimental',
    docSearchTerms: ['Magenta RealTime 2', 'MRT2', 'first non-Mac port', 'audio-style', '/api/magenta/probe'],
  },
  {
    id: 'edit-tool-stack-modules',
    name: 'Edit Tool Stack: six /api/edit/* processor families (mastering, restoration, enhance, delivery, creative-fx, creative-neural) plus AI analyzer',
    domain: 'edit',
    sourcePaths: ['backend/modules/mastering/router.py', 'backend/modules/restoration/router.py', 'backend/modules/enhance/router.py', 'backend/modules/delivery/router.py', 'backend/modules/creative_fx/router.py', 'backend/modules/creative_neural/router.py', 'backend/core/module_base.py'],
    evidence: ['/api/edit/mastering/process', '/api/edit/restoration/process', '/api/edit/creative-neural/process', 'GET {prefix}/tools', 'public/edit-modules iframes', '/api/edit/analyzer'],
    status: 'implemented',
    docSearchTerms: ['Edit Tool Stack', '/api/edit/mastering', 'creative-neural', 'AI Analyzer', 'edit-modules'],
  },
  {
    id: 'catalogue-cross-provider-browser',
    name: 'Catalogue cross-provider library gallery with provider badges, inspector spectrograms, and lineage',
    domain: 'library',
    sourcePaths: ['frontend/src/catalog/CatalogueView.tsx', 'frontend/src/catalog/CatalogueInspector.tsx', 'frontend/src/catalog/catalogProviders.ts', 'frontend/src/catalog/CatalogueLineage.tsx'],
    evidence: ['CatalogueView', 'provider badges', '/api/library/{id}/lineage', 'on-demand spectrograms', 'Suno cover/mashup from entry'],
    status: 'implemented',
    docSearchTerms: ['Catalogue', 'CatalogueView', 'provider badges', 'cross-provider gallery', 'on-demand spectrograms'],
  },
  {
    id: 'controller-vision-detect-identify',
    name: 'Controller Vision: detect/identify a MIDI controller from a photo (OpenCV + vision-LLM) with LAN phone pairing',
    domain: 'daw',
    sourcePaths: ['backend/modules/controllervision/router.py', 'frontend/src/components/layout/ControllerVisionModal.tsx'],
    evidence: ['/api/controllervision/detect', '/api/controllervision/identify', '/api/controllervision/session', 'OpenCV control detection', 'vision-LLM identify'],
    status: 'implemented',
    docSearchTerms: ['Controller Vision', '/api/controllervision', 'phone pairing', 'vision-LLM', 'OpenCV'],
  },
  {
    id: 'ytimport-youtube-import',
    name: 'YouTube import: fetch audio from a URL into the Library as a first-class, lineage-tracked entry',
    domain: 'library',
    sourcePaths: ['backend/modules/ytimport/router.py'],
    evidence: ['/api/ytimport', '/api/ytimport/fetch', 'imported Library entry', 'imported nodes in LEARN graph'],
    status: 'implemented',
    docSearchTerms: ['YouTube Import', '/api/ytimport', 'ytimport', 'imported nodes'],
  },
];

export const SCREENSHOT_SPECS: ScreenshotSpec[] = [
  {
    sceneId: '01-shell-make',
    outputFile: '01-shell-make.png',
    viewport: VIEWPORT,
    captureMode: 'full+crop',
    featureRefs: ['shell-center-tabs-right-library', 'create-advanced-generation-templates-prompts-spectrograms', 'docs-modal-download-print-rag', 'assistant-orb-providers-keys-attachments'],
    docsSections: ['§5 UI Shell', '§6 CREATE Tab', '§22 Screenshot Manifest'],
    cropRegions: [
      { id: 'header-actions', x: 0, y: 0, width: 1920, height: 150, purpose: 'Header controls, Docs, Settings, share link, assistant orb', featureRefs: ['docs-modal-download-print-rag', 'settings-feature-toggles-modules-admin', 'assistant-orb-providers-keys-attachments', 'vj-sidecar-tab-mobile-share'] },
      { id: 'make-controls', x: 0, y: 80, width: 560, height: 900, purpose: 'MAKE panel generation controls and Chimera banner', featureRefs: ['create-advanced-generation-templates-prompts-spectrograms', 'create-chimera-fusion-stack', 'create-mic-recorder-send-targets'] },
    ],
  },
  {
    sceneId: '02-library-with-showcase-selected',
    outputFile: '02-library-with-showcase-selected.png',
    viewport: VIEWPORT,
    captureMode: 'full+crop',
    featureRefs: ['library-backend-local-storage', 'media-bucket-routing'],
    docsSections: ['§9 LIBRARY Tab', '§13 Bottom Panel Tabs'],
    cropRegions: [
      { id: 'library-details', x: 1400, y: 90, width: 500, height: 840, purpose: 'Right-side library list/detail rail', featureRefs: ['shell-center-tabs-right-library', 'library-backend-local-storage'] },
    ],
  },
  {
    sceneId: '03-library-actions-toolbar',
    outputFile: '03-library-actions-toolbar.png',
    viewport: VIEWPORT,
    captureMode: 'full+crop',
    featureRefs: ['library-stems-sidecar', 'library-midi-conversion', 'library-bundle-download-lineage-export', 'create-chimera-fusion-stack'],
    docsSections: ['§9 LIBRARY Tab', '§16 Backend API Reference'],
    cropRegions: [
      { id: 'library-toolbar', x: 1390, y: 95, width: 520, height: 220, purpose: 'Toolbar action cluster for selection-based workflows', featureRefs: ['library-stems-sidecar', 'library-midi-conversion', 'library-bundle-download-lineage-export', 'create-chimera-fusion-stack'] },
    ],
  },
  {
    sceneId: '04-library-download-submenu',
    outputFile: '04-library-download-submenu.png',
    viewport: VIEWPORT,
    captureMode: 'full+crop',
    featureRefs: ['library-bundle-download-lineage-export', 'library-midi-conversion'],
    docsSections: ['§9 LIBRARY Tab'],
    cropRegions: [
      { id: 'download-submenu', x: 1420, y: 120, width: 470, height: 380, purpose: 'Download submenu entries for songs, MIDI, JSON, bundle, and lineage', featureRefs: ['library-bundle-download-lineage-export', 'library-midi-conversion'] },
    ],
  },
  {
    sceneId: '05-library-entry-right-click',
    outputFile: '05-library-entry-right-click.png',
    viewport: VIEWPORT,
    captureMode: 'full+crop',
    featureRefs: ['library-stems-sidecar', 'library-midi-conversion', 'library-bundle-download-lineage-export', 'media-bucket-routing'],
    docsSections: ['§9 LIBRARY Tab', '§16 Backend API Reference'],
    cropRegions: [
      { id: 'entry-context-menu', x: 1320, y: 170, width: 560, height: 520, purpose: 'Per-entry context menu actions', featureRefs: ['library-stems-sidecar', 'library-midi-conversion', 'library-bundle-download-lineage-export', 'media-bucket-routing'] },
    ],
  },
  {
    sceneId: '06-learn-tab-3d-graph',
    outputFile: '06-learn-tab-3d-graph.png',
    viewport: VIEWPORT,
    captureMode: 'full+crop',
    featureRefs: ['library-bundle-download-lineage-export'],
    docsSections: ['§9 LIBRARY Tab'],
    cropRegions: [
      { id: 'lineage-graph', x: 360, y: 100, width: 1180, height: 760, purpose: '3D lineage graph and node relationship context', featureRefs: ['library-bundle-download-lineage-export'] },
    ],
  },
  {
    sceneId: '07-settings-modal-with-shutdown',
    outputFile: '07-settings-modal-with-shutdown.png',
    viewport: VIEWPORT,
    captureMode: 'full+crop',
    featureRefs: ['settings-feature-toggles-modules-admin', 'backend-module-loader-settings'],
    docsSections: ['§5 UI Shell', '§16 Backend API Reference'],
    cropRegions: [
      { id: 'settings-toggles', x: 430, y: 120, width: 1060, height: 840, purpose: 'Settings feature toggles, module list, restart, and shutdown footer', featureRefs: ['settings-feature-toggles-modules-admin', 'backend-module-loader-settings'] },
    ],
  },
  {
    sceneId: '08-vj-tab-loading',
    outputFile: '08-vj-tab-loading.png',
    viewport: VIEWPORT,
    captureMode: 'full+crop',
    featureRefs: ['vj-sidecar-tab-mobile-share'],
    docsSections: ['§5 UI Shell', '§16 Backend API Reference'],
    cropRegions: [
      { id: 'vj-panel', x: 360, y: 95, width: 1180, height: 780, purpose: 'VJ iframe/loading surface', featureRefs: ['vj-sidecar-tab-mobile-share'] },
    ],
  },
  {
    sceneId: '09-chimera-cohort-multi-select',
    outputFile: '09-chimera-cohort-multi-select.png',
    viewport: VIEWPORT,
    captureMode: 'full+crop',
    featureRefs: ['create-chimera-fusion-stack', 'library-backend-local-storage'],
    docsSections: ['§6 CREATE Tab', '§9 LIBRARY Tab'],
    cropRegions: [
      { id: 'chimera-multi-select', x: 1350, y: 90, width: 550, height: 760, purpose: 'Multi-selection cohort ready for FUSE/Chimera workflows', featureRefs: ['create-chimera-fusion-stack', 'library-backend-local-storage'] },
    ],
  },
];

export function buildScreenshotManifestEntries(specs: ScreenshotSpec[] = SCREENSHOT_SPECS): ScreenshotManifestEntry[] {
  const entries: ScreenshotManifestEntry[] = [];
  for (const spec of specs) {
    entries.push({
      file: spec.outputFile,
      label: spec.sceneId,
      features: spec.featureRefs,
      docsSections: spec.docsSections,
      kind: 'full',
      sourceScene: spec.sceneId,
    });
    for (const crop of spec.cropRegions ?? []) {
      entries.push({
        file: `${spec.sceneId}__${crop.id}.png`,
        label: `${spec.sceneId} / ${crop.id}`,
        features: crop.featureRefs,
        docsSections: spec.docsSections,
        kind: 'crop',
        sourceScene: spec.sceneId,
      });
    }
  }
  return entries;
}

export function validateScreenshotSpecs(specs: ScreenshotSpec[] = SCREENSHOT_SPECS): void {
  for (const spec of specs) {
    for (const crop of spec.cropRegions ?? []) {
      if (crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0) {
        throw new Error(`Invalid crop dimensions for ${spec.sceneId}/${crop.id}`);
      }
      if (crop.x + crop.width > spec.viewport.width || crop.y + crop.height > spec.viewport.height) {
        throw new Error(`Crop ${spec.sceneId}/${crop.id} exceeds viewport bounds`);
      }
    }
  }
}