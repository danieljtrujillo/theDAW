import React, { useState, useEffect } from 'react';
import { Settings, X, Package, RefreshCw, AlertTriangle, ToggleLeft, ToggleRight, Activity, Scissors, Music, Power, CheckCircle2, AlertCircle, PowerOff, ChevronRight, LayoutGrid, HardDrive } from 'lucide-react';
import { useFeatureToggleStore } from '../../state/featureToggleStore';
import {
  addCheckpoint, fetchCheckpoints, fetchHfCache, fetchLocations, fetchModelStatus, formatBytes,
  generateCheckpointConfig, inspectCheckpoint, openLocation, removeCheckpoint, setLocalOnly,
  type CheckpointInspection, type HfRepo, type ModelOptionStatus, type ModelProviderStatus,
  type RegisteredCheckpoint, type StorageLocation,
} from '../../lib/storageClient';
import { useLayoutPrefs, UI_SCALE_MIN, UI_SCALE_MAX } from '../../state/layoutPrefsStore';
import { SlideTrack } from '../audio/SlideTrack';
import { PathInput } from '../ui/PathInput';
// CHANGED: Suno cloud-generation API key section (surfaced in Settings).
import { SunoKeySettings } from '../../suno/SunoKeySettings';
import { useModuleStore, type ModuleConfig } from '../../state/moduleStore';

export const SettingsModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  // Modules come from the shared store, preloaded on backend-ready (App.tsx).
  // The modal never fetches on open, so it can't show a false "no modules"
  // during a backend (re)start — the list is already cached and warm.
  const modules = useModuleStore((s) => s.modules);
  const loading = useModuleStore((s) => s.loading && !s.loaded);
  const moduleError = useModuleStore((s) => s.error);
  const loadModules = useModuleStore((s) => s.load);
  const setModuleEnabled = useModuleStore((s) => s.setEnabled);
  const [dirty, setDirty] = useState(false);
  const [changedModules, setChangedModules] = useState<Set<string>>(() => new Set());
  const [toggling, setToggling] = useState<string | null>(null);
  const featureSettings = useFeatureToggleStore((s) => s.settings);
  const refreshFeatures = useFeatureToggleStore((s) => s.refresh);
  const patchFeatures = useFeatureToggleStore((s) => s.patch);

  // Local mirror of the VJ export root so typing doesn't fire a PATCH per
  // keystroke — we commit on blur / Enter. Kept in sync when the backend
  // settings resolve.
  const [vjExportRoot, setVjExportRoot] = useState('');
  useEffect(() => {
    setVjExportRoot(featureSettings.vj?.export_root ?? 'exports/vj');
  }, [featureSettings.vj?.export_root]);

  useEffect(() => {
    if (!open) return;
    setDirty(false);
    setChangedModules(new Set());
    void refreshFeatures();
    // The catalog is normally already warm (preloaded on backend-ready). This
    // is a no-op when loaded; it only does work if the preload hasn't run yet
    // or a previous attempt errored.
    void loadModules();
  }, [open, refreshFeatures, loadModules]);

  const toggleModule = async (dirName: string, enabled: boolean) => {
    setToggling(dirName);
    try {
      const ok = await setModuleEnabled(dirName, enabled);
      if (ok) {
        setDirty(true);
        setChangedModules((prev) => new Set(prev).add(dirName));
      }
    } finally {
      setToggling(null);
    }
  };

  const commitVjExportRoot = () => {
    const v = vjExportRoot.trim() || 'exports/vj';
    if (v !== (featureSettings.vj?.export_root ?? 'exports/vj')) void patchFeatures({ vj: { export_root: v } });
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-[#0c0a14] border border-purple-500/30 rounded-lg w-120 max-h-[75vh] flex flex-col shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 shrink-0">
          <div className="flex items-center gap-2">
            <Settings className="w-3.5 h-3.5 text-purple-400" />
            <span className="text-[10px] font-black uppercase tracking-widest text-purple-300">Settings</span>
          </div>
          <button onClick={onClose} className="p-1 text-zinc-500 hover:text-white transition-colors rounded hover:bg-white/5">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Pinned Admin — always at the top, never scrolls away */}
        <div className="shrink-0 border-b border-white/5 bg-[#0a080f] px-4 py-3 flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <Power className="w-3 h-3 text-purple-400" />
            <span className="text-[9px] font-black uppercase tracking-widest text-zinc-300">Admin</span>
            <span className="text-[8px] font-mono text-zinc-600 ml-auto">supervisor required</span>
          </div>
          <div className="flex gap-2">
            <RestartServerButton />
            <ShutdownServerButton />
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3">

          <StorageSettingsSection />
          <LayoutSettingsSection />

          {/* Section: Modules */}
          <div className="flex items-center gap-1.5 mb-2 pt-2 border-t border-white/5">
            <Package className="w-3 h-3 text-purple-400" />
            <span className="text-[9px] font-black uppercase tracking-widest text-zinc-300">Backend Modules</span>
            <span className="text-[8px] font-mono text-zinc-600 ml-auto">restart required for changes</span>
          </div>

          {dirty && (
            <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded mb-3">
              <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />
              <span className="text-[9px] font-mono text-amber-300">Restart the backend server for module changes to take effect.</span>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-zinc-600">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              <span className="text-[9px] font-mono">Loading modules...</span>
            </div>
          ) : moduleError ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              <span className="text-[9px] font-mono text-amber-300">Couldn't reach the backend ({moduleError}).</span>
              <span className="text-[8px] font-mono text-zinc-600">Modules are loaded from the server — this is a connection issue, not missing modules.</span>
              <button
                onClick={() => void loadModules()}
                className="mt-1 px-3 py-1 rounded border border-purple-500/40 bg-purple-500/15 hover:bg-purple-500/25 text-purple-200 text-[9px] font-black uppercase tracking-widest"
              >
                Retry
              </button>
            </div>
          ) : modules.length === 0 ? (
            <div className="text-center py-10 text-[9px] text-zinc-600 font-mono">No modules found in backend/modules/</div>
          ) : (
            <ModuleTree modules={modules} toggling={toggling} changedModules={changedModules} onToggle={(dir, en) => void toggleModule(dir, en)} />
          )}

          {/* Section: Background features (auto-analysis / stems / midi) */}
          <div className="flex items-center gap-1.5 mb-2 pt-4 border-t border-white/5 mt-4">
            <Activity className="w-3 h-3 text-purple-400" />
            <span className="text-[9px] font-black uppercase tracking-widest text-zinc-300">Background features</span>
            <span className="text-[8px] font-mono text-zinc-600 ml-auto">runs during idle</span>
          </div>
          <p className="text-[9px] text-zinc-500 mb-3 leading-relaxed">
            Opt-in enrichment runs in the background when the app is idle. Toggles default OFF and persist across reloads.
          </p>

          <div className="flex flex-col gap-1.5 mb-4">
            <FeatureToggleGroup
              icon={<Activity className="w-3 h-3 text-purple-400" />}
              title="Auto-analysis"
              desc="Detect BPM, key, pitch, bars, codec, embedded prompts. Local-only, CPU-friendly."
              onImport={featureSettings.analysis.auto_on_import}
              onGenerate={featureSettings.analysis.auto_on_generate}
              onPatchImport={(v) => void patchFeatures({ analysis: { auto_on_import: v } })}
              onPatchGenerate={(v) => void patchFeatures({ analysis: { auto_on_generate: v } })}
            />
            <FeatureToggleGroup
              icon={<Scissors className="w-3 h-3 text-purple-400" />}
              title="Auto-stems"
              desc="Separate tracks into stems via Demucs sidecar. Requires the stems module + LARSNET weights for 12-stem."
              onImport={featureSettings.stems.auto_on_import}
              onGenerate={featureSettings.stems.auto_on_generate}
              onPatchImport={(v) => void patchFeatures({ stems: { auto_on_import: v } })}
              onPatchGenerate={(v) => void patchFeatures({ stems: { auto_on_generate: v } })}
              extra={
                <div className="flex flex-col gap-2 mt-2 pt-2 border-t border-white/5">
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] font-mono uppercase tracking-widest text-zinc-400 w-16 shrink-0">Stems:</span>
                    <div className="flex items-center gap-1 flex-wrap">
                      {[
                        { value: 2,  label: '2',  hint: 'vocals + accompaniment' },
                        { value: 4,  label: '4',  hint: 'vocals, drums, bass, other' },
                        { value: 6,  label: '6',  hint: '+ guitar, piano' },
                        { value: 12, label: '12', hint: '+ LARSNET drum sub-stems' },
                      ].map((opt) => {
                        const active = featureSettings.stems.default_count === opt.value;
                        return (
                          <button
                            key={opt.value}
                            onClick={() => void patchFeatures({ stems: { default_count: opt.value } })}
                            className={`text-[8px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border transition-colors ${
                              active
                                ? 'bg-purple-500/25 border-purple-400/60 text-purple-100'
                                : 'border-white/10 text-zinc-400 hover:text-zinc-100 hover:bg-white/5'
                            }`}
                            title={opt.hint}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] font-mono uppercase tracking-widest text-zinc-400 w-16 shrink-0">Device:</span>
                    <div className="flex items-center gap-1 flex-wrap">
                      {[
                        { value: 'cuda', label: 'GPU (cuda)', enabled: true },
                        { value: 'cpu',  label: 'CPU',        enabled: true },
                        { value: 'cloud-runpod',     label: 'RunPod',    enabled: false },
                        { value: 'cloud-cloudflare', label: 'Cloudflare', enabled: false },
                        { value: 'cloud-colab',      label: 'Colab',     enabled: false },
                      ].map((opt) => {
                        const active = featureSettings.stems.device === opt.value;
                        return (
                          <button
                            key={opt.value}
                            onClick={() => {
                              if (!opt.enabled) return;
                              void patchFeatures({ stems: { device: opt.value } });
                            }}
                            disabled={!opt.enabled}
                            className={`text-[8px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border transition-colors ${
                              active
                                ? 'bg-purple-500/25 border-purple-400/60 text-purple-100'
                                : opt.enabled
                                  ? 'border-white/10 text-zinc-400 hover:text-zinc-100 hover:bg-white/5'
                                  : 'border-white/5 text-zinc-700 cursor-not-allowed line-through'
                            }`}
                            title={opt.enabled ? opt.label : `${opt.label} — coming soon`}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] font-mono uppercase tracking-widest text-zinc-400 w-16 shrink-0">Quality:</span>
                    <div className="flex items-center gap-1 flex-wrap">
                      {[
                        { value: 'fast',     label: 'Fast',     hint: 'shifts=1, overlap=0.25 — ~30s per track' },
                        { value: 'balanced', label: 'Balanced', hint: 'shifts=2, overlap=0.5 — ~1-2 min per track' },
                        { value: 'hq',       label: 'HQ',       hint: 'shifts=10, overlap=0.9 — 5-15 min per track' },
                      ].map((opt) => {
                        const active = featureSettings.stems.quality === opt.value;
                        return (
                          <button
                            key={opt.value}
                            onClick={() => void patchFeatures({ stems: { quality: opt.value } })}
                            className={`text-[8px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border transition-colors ${
                              active
                                ? 'bg-purple-500/25 border-purple-400/60 text-purple-100'
                                : 'border-white/10 text-zinc-400 hover:text-zinc-100 hover:bg-white/5'
                            }`}
                            title={opt.hint}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              }
            />
            <FeatureToggleGroup
              icon={<Music className="w-3 h-3 text-purple-400" />}
              title="Auto-MIDI"
              desc="Convert tracks (and stems, if available) to MIDI via basic-pitch / piano-transcription."
              onImport={featureSettings.midi.auto_on_import}
              onGenerate={featureSettings.midi.auto_on_generate}
              onPatchImport={(v) => void patchFeatures({ midi: { auto_on_import: v } })}
              onPatchGenerate={(v) => void patchFeatures({ midi: { auto_on_generate: v } })}
            />
          </div>

          {/* Section: VJ recording */}
          <div className="flex items-center gap-1.5 mb-2 pt-2 border-t border-white/5">
            <Activity className="w-3 h-3 text-purple-400" />
            <span className="text-[9px] font-black uppercase tracking-widest text-zinc-300">VJ Recording</span>
          </div>
          <div className="mb-3">
            <PathInput
              id="settings-vj-export-root"
              name="settings-vj-export-root"
              label="Export root folder"
              value={vjExportRoot}
              onChange={setVjExportRoot}
              kind="folder"
              onBlur={commitVjExportRoot}
              onEnter={commitVjExportRoot}
              placeholder="exports/vj"
              description="Where VJ recordings are saved. A relative path sits inside the project; Browse fills an absolute folder such as D:\Renders. Each take adds the VJ record-bar subfolder, then ffmpeg transcodes to the chosen codec."
            />
          </div>

        </div>
      </div>
    </div>
  );
};

/* ── Models & Storage (local checkpoints, model locations, HF cache) ──────── */

/** Hover detail for a location's size: every model in the directory with its
 *  path and size, the recommended pick starred. */
const locationInventoryTitle = (loc: StorageLocation): string | undefined => {
  const models = loc.models ?? [];
  if (!models.length) return loc.files != null ? `${loc.files} files` : undefined;
  const lines = models.slice(0, 14).map((m) =>
    `${m.recommended ? '★ ' : ''}${m.name} — ${formatBytes(m.bytes)}\n    ${m.path}${m.note ? `\n    ${m.note}` : ''}`);
  if (models.length > 14) lines.push(`…and ${models.length - 14} more`);
  return lines.join('\n');
};

const StorageSettingsSection: React.FC = () => {
  const [registered, setRegistered] = useState<RegisteredCheckpoint[]>([]);
  const [localOnly, setLocalOnlyState] = useState(false);
  const [modelProviders, setModelProviders] = useState<ModelProviderStatus[]>([]);
  const [modelStatusLoading, setModelStatusLoading] = useState(false);
  const [modelStatusError, setModelStatusError] = useState<string | null>(null);
  const [locations, setLocations] = useState<StorageLocation[]>([]);
  const [hfRepos, setHfRepos] = useState<HfRepo[]>([]);
  const [hfTotal, setHfTotal] = useState(0);
  const [hfOpen, setHfOpen] = useState(false);
  const [addPath, setAddPath] = useState('');
  const [addName, setAddName] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [sizesLoading, setSizesLoading] = useState(false);
  const [inspection, setInspection] = useState<CheckpointInspection | null>(null);
  const [generating, setGenerating] = useState(false);

  // The MAKE no-model warning opens Settings with {section:'models'}; pulse
  // the section so first-time users land exactly where the fix lives.
  const sectionRef = React.useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState(false);
  useEffect(() => {
    const onFocusModels = (e: Event) => {
      if ((e as CustomEvent).detail?.section !== 'models') return;
      setHighlight(true);
      setTimeout(() => sectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60);
      setTimeout(() => setHighlight(false), 2600);
    };
    window.addEventListener('stabledaw:open-settings', onFocusModels);
    return () => window.removeEventListener('stabledaw:open-settings', onFocusModels);
  }, []);

  const reload = React.useCallback(() => {
    fetchCheckpoints()
      .then((d) => { setRegistered(d.registered); setLocalOnlyState(d.local_only); })
      .catch(() => undefined);
  }, []);

  const reloadModelStatus = React.useCallback(() => {
    setModelStatusLoading(true);
    setModelStatusError(null);
    fetchModelStatus()
      .then((d) => {
        setModelProviders(d.providers);
        setLocalOnlyState(d.local_only);
      })
      .catch((e) => {
        setModelProviders([]);
        setModelStatusError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setModelStatusLoading(false));
  }, []);

  useEffect(() => {
    reload();
    reloadModelStatus();
    setSizesLoading(true);
    fetchLocations().then(setLocations).catch(() => setLocations([])).finally(() => setSizesLoading(false));
    fetchHfCache().then((d) => { setHfRepos(d.repos); setHfTotal(d.total_bytes); }).catch(() => setHfRepos([]));
  }, [reload, reloadModelStatus]);

  const onAdd = async () => {
    const path = addPath.trim();
    if (!path) return;
    setAdding(true);
    setAddError(null);
    setInspection(null);
    try {
      await addCheckpoint(path, addName.trim() || undefined);
      setAddPath('');
      setAddName('');
      reload();
      reloadModelStatus();
    } catch (e) {
      // Inspect the path so the failure says exactly what is missing and,
      // for recognized built-in checkpoints, offers to generate the config.
      const info = await inspectCheckpoint(path).catch(() => null);
      setInspection(info);
      setAddError(info?.problem ?? (e instanceof Error ? e.message : String(e)));
    } finally {
      setAdding(false);
    }
  };

  const onGenerateConfig = async () => {
    const path = addPath.trim();
    if (!path) return;
    setGenerating(true);
    try {
      const r = await generateCheckpointConfig(path);
      if (r.created) {
        setAddError(null);
        setInspection(null);
        await onAdd();
      }
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div ref={sectionRef} className={highlight ? 'rounded ring-2 ring-purple-500/60 transition-shadow' : undefined}>
      {/* Section: Models & Storage */}
      <div className="flex items-center gap-1.5 mb-2 pt-2 border-t border-white/5">
        <HardDrive className="w-3 h-3 text-purple-400" />
        <span className="text-[9px] font-black uppercase tracking-widest text-zinc-300">Models</span>
        <span className="text-[8px] font-mono text-zinc-600 ml-auto">safe local-first setup</span>
      </div>
      <p className="text-[9px] text-zinc-500 mb-2 leading-relaxed">
        Models load on demand at the first CREATE. Safe default: theDAW will not download model weights until you explicitly allow it. Register checkpoints you already have, connect cloud APIs, or later turn off local-only for a one-time Stable Audio download.
      </p>

      {/* Local-only switch */}
      <button
        onClick={() => {
          void setLocalOnly(!localOnly)
            .then((enabled) => {
              setLocalOnlyState(enabled);
              reloadModelStatus();
            })
            .catch(() => undefined);
        }}
        aria-pressed={localOnly}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 mb-2 rounded border border-white/10 bg-white/3 hover:bg-white/5 transition-colors text-left"
      >
        {localOnly
          ? <ToggleRight className="w-4 h-4 text-emerald-400 shrink-0" />
          : <ToggleLeft className="w-4 h-4 text-zinc-600 shrink-0" />}
        <span className="text-[10px] text-zinc-200 font-bold">Local only (never download)</span>
        <span className="text-[8px] text-zinc-500 ml-auto">safe default · missing models warn instead of downloading</span>
      </button>

      <ModelReadinessCards
        providers={modelProviders}
        loading={modelStatusLoading}
        error={modelStatusError}
        localOnly={localOnly}
        onRefresh={reloadModelStatus}
      />

      {/* CHANGED: Suno cloud-generation API key entry now lives inside Models. */}
      <SunoKeySettings />

      {/* Registered local checkpoints */}
      <div className="flex flex-col gap-1 mb-2">
        {registered.map((ck) => (
          <div key={ck.id} className={`flex items-center gap-2 px-2.5 py-1.5 rounded border ${ck.resolves ? 'border-white/10 bg-white/3' : 'border-red-500/30 bg-red-500/5'}`}>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-bold text-zinc-200 truncate">{ck.name}</div>
              <div className="text-[8px] font-mono text-zinc-500 truncate" title={ck.path}>{ck.path}</div>
            </div>
            {!ck.resolves && <span className="text-[8px] font-mono text-red-300 shrink-0">missing</span>}
            <button
              onClick={() => { void openLocation(ck.path).catch(() => undefined); }}
              className="text-[8px] font-mono uppercase px-1.5 py-0.5 rounded border border-white/10 text-zinc-400 hover:text-white hover:bg-white/5 transition-colors shrink-0"
              aria-label={`Open ${ck.name} in Explorer`}
            >
              Open
            </button>
            <button
              onClick={() => {
                void removeCheckpoint(ck.id)
                  .then(() => {
                    reload();
                    reloadModelStatus();
                  })
                  .catch(() => undefined);
              }}
              className="text-[8px] font-mono uppercase px-1.5 py-0.5 rounded border border-red-500/30 text-red-300 hover:bg-red-500/10 transition-colors shrink-0"
              aria-label={`Remove ${ck.name} from the model list (files stay on disk)`}
              title="Removes the dropdown entry only — the files stay on disk."
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      {/* Add a checkpoint */}
      <div className="flex flex-col gap-1 mb-2">
        <PathInput
          id="settings-ckpt-path"
          name="settings-ckpt-path"
          label="Add a checkpoint you already have"
          value={addPath}
          onChange={setAddPath}
          kind="folder"
          onEnter={() => void onAdd()}
          placeholder="D:\models\my-finetune  (folder, or the .safetensors file)"
          description="Use Browse to pick the checkpoint folder, or paste a folder/.safetensors path. The folder needs a model config JSON next to one .safetensors file. Get config JSON from the matching Hugging Face model repo or from the training/export artifact that produced the checkpoint. Entries appear in the model picker in MAKE."
        />
        <div className="flex gap-1.5">
          <label htmlFor="settings-ckpt-name" className="sr-only">Display name for the checkpoint (optional)</label>
          <input
            id="settings-ckpt-name"
            name="settings-ckpt-name"
            type="text"
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void onAdd(); }}
            spellCheck={false}
            placeholder="Display name (optional)"
            className="flex-1 bg-black/40 border border-white/10 rounded px-2 py-1.5 text-[10px] font-mono text-zinc-200 focus:border-purple-500/50 focus:outline-none"
          />
          <button
            onClick={() => void onAdd()}
            disabled={adding || !addPath.trim()}
            className="text-[9px] font-black uppercase tracking-widest px-3 rounded border border-purple-500/40 text-purple-200 bg-purple-500/15 hover:bg-purple-500/25 transition-colors disabled:opacity-40"
          >
            {adding ? 'Checking…' : 'Add'}
          </button>
        </div>
        {addError && <p className="text-[8px] text-red-300">{addError}</p>}
        {inspection && !inspection.resolves && inspection.recognized?.config_available && (
          <button
            onClick={() => void onGenerateConfig()}
            disabled={generating}
            className="self-start text-[8px] font-mono uppercase tracking-widest px-2 py-1 rounded border border-amber-500/40 text-amber-200 bg-amber-500/10 hover:bg-amber-500/20 transition-colors disabled:opacity-40"
            title={`Copies the official ${inspection.recognized.config_name} from your local/cached copy next to the checkpoint. Nothing is guessed and nothing downloads.`}
          >
            {generating ? 'Generating…' : `Generate config (${inspection.recognized.model})`}
          </button>
        )}
        {inspection && !inspection.resolves && (inspection.safetensors.length > 0 || inspection.configs.length > 0) && (
          <p className="text-[8px] text-zinc-600">
            Found there: {inspection.safetensors.length} checkpoint file(s), {inspection.configs.filter((c) => c.valid).length} valid config(s) of {inspection.configs.length} JSON file(s).
          </p>
        )}
      </div>

      {/* Locations */}
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-[9px] font-mono uppercase tracking-wider text-zinc-400">Locations</span>
        {sizesLoading && <RefreshCw className="w-2.5 h-2.5 animate-spin text-zinc-600" />}
        <button
          onClick={() => {
            setSizesLoading(true);
            fetchLocations(true).then(setLocations).catch(() => undefined).finally(() => setSizesLoading(false));
          }}
          className="text-[8px] font-mono uppercase px-1.5 py-0.5 rounded border border-white/10 text-zinc-500 hover:text-white hover:bg-white/5 transition-colors ml-auto"
        >
          Refresh sizes
        </button>
      </div>
      <div className="flex flex-col gap-1 mb-2">
        {locations.map((loc) => (
          <div key={loc.key} className="flex items-center gap-2 px-2.5 py-1 rounded border border-white/5 bg-white/3">
            <div className="min-w-0 flex-1">
              <div className="text-[9px] text-zinc-300 truncate">{loc.label}</div>
              <div className="text-[8px] font-mono text-zinc-600 truncate" title={loc.path ?? undefined}>{loc.path ?? 'not found'}</div>
            </div>
            <span
              className={`text-[9px] font-mono text-zinc-400 tabular-nums shrink-0 ${loc.models?.length ? 'cursor-help underline decoration-dotted decoration-zinc-700 underline-offset-2' : ''}`}
              title={locationInventoryTitle(loc)}
            >
              {loc.exists ? formatBytes(loc.bytes) : '—'}
            </span>
            {loc.exists && loc.path && (
              <button
                onClick={() => { void openLocation(loc.path as string).catch(() => undefined); }}
                className="text-[8px] font-mono uppercase px-1.5 py-0.5 rounded border border-white/10 text-zinc-400 hover:text-white hover:bg-white/5 transition-colors shrink-0"
                aria-label={`Open ${loc.label} in Explorer`}
              >
                Open
              </button>
            )}
          </div>
        ))}
      </div>

      {/* HF cache breakdown */}
      <button
        onClick={() => setHfOpen((v) => !v)}
        aria-expanded={hfOpen}
        className="w-full flex items-center gap-1.5 mb-1 text-left"
      >
        <ChevronRight className={`w-3 h-3 text-zinc-500 transition-transform ${hfOpen ? 'rotate-90' : ''}`} />
        <span className="text-[9px] font-mono uppercase tracking-wider text-zinc-400">Hugging Face cache breakdown</span>
        <span className="text-[9px] font-mono text-zinc-500 tabular-nums ml-auto">{formatBytes(hfTotal)}</span>
      </button>
      {hfOpen && (
        <div className="flex flex-col gap-0.5 mb-3">
          {hfRepos.map((r) => (
            <div key={r.repo_id} className="flex items-center gap-2 px-2.5 py-1 rounded border border-white/5">
              <span className="text-[9px] font-mono text-zinc-300 truncate flex-1" title={r.path}>{r.repo_id}</span>
              <span className="text-[9px] font-mono text-zinc-500 tabular-nums shrink-0">{formatBytes(r.bytes)}</span>
              <button
                onClick={() => { void openLocation(r.path).catch(() => undefined); }}
                className="text-[8px] font-mono uppercase px-1.5 py-0.5 rounded border border-white/10 text-zinc-400 hover:text-white hover:bg-white/5 transition-colors shrink-0"
                aria-label={`Open ${r.repo_id} in Explorer`}
              >
                Open
              </button>
            </div>
          ))}
          {hfRepos.length === 0 && <p className="text-[8px] text-zinc-600 px-2.5">The cache is empty.</p>}
        </div>
      )}
    </div>
  );
};


const MODEL_STATE_LABELS: Record<string, string> = {
  active: 'Active',
  ready: 'Ready',
  cached: 'Cached',
  local: 'Local',
  needs_setup: 'Setup',
  needs_key: 'Needs key',
  missing_config: 'Missing config',
  download_blocked: 'Blocked',
  unavailable: 'Unavailable',
};

const MODEL_SOURCE_LABELS: Record<string, string> = {
  local: 'Local',
  cached: 'Cached',
  download: 'Download',
  registered: 'Registered',
  api: 'API',
  missing: 'Missing',
};

const modelStateClass = (state: string) => {
  if (state === 'active' || state === 'ready' || state === 'local' || state === 'cached') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
  }
  if (state === 'needs_key' || state === 'needs_setup' || state === 'missing_config' || state === 'download_blocked') {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
  }
  return 'border-zinc-600/40 bg-white/3 text-zinc-400';
};

const modelSourceClass = (source: string) => {
  if (source === 'local' || source === 'registered' || source === 'api') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
  }
  if (source === 'cached') return 'border-sky-500/30 bg-sky-500/10 text-sky-200';
  if (source === 'download') return 'border-zinc-600/40 bg-white/3 text-zinc-400';
  return 'border-rose-500/30 bg-rose-500/10 text-rose-200';
};

const modelTooltip = (model: ModelOptionStatus) => [
  model.label,
  model.repo_id ? `repo: ${model.repo_id}` : null,
  model.path ? `path: ${model.path}` : null,
  model.reason || null,
].filter(Boolean).join('\n');

const ModelReadinessCards: React.FC<{
  providers: ModelProviderStatus[];
  loading: boolean;
  error: string | null;
  localOnly: boolean;
  onRefresh: () => void;
}> = ({ providers, loading, error, localOnly, onRefresh }) => (
  <div className="mb-3 rounded border border-white/5 bg-black/15 p-2">
    <div className="flex items-center gap-2 mb-2">
      <span className="text-[8px] font-black uppercase tracking-widest text-zinc-400">Installed / Connected</span>
      <span className={`text-[7px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border ${localOnly ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-amber-500/30 bg-amber-500/10 text-amber-200'}`}>
        {localOnly ? 'Local only on' : 'Downloads allowed'}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        className="ml-auto inline-flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[8px] font-mono uppercase tracking-widest text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
      >
        <RefreshCw className={`w-2.5 h-2.5 ${loading ? 'animate-spin' : ''}`} />
        Refresh
      </button>
    </div>
    {error && <p className="mb-2 text-[8px] text-rose-300">Model status failed: {error}</p>}
    {loading && providers.length === 0 ? (
      <div className="flex items-center gap-2 px-2 py-3 text-[9px] font-mono text-zinc-600">
        <RefreshCw className="w-3 h-3 animate-spin" /> Checking local models and APIs…
      </div>
    ) : (
      <div className="grid grid-cols-2 gap-1.5">
        {providers.map((provider) => (
          <ModelProviderCard key={provider.id} provider={provider} />
        ))}
      </div>
    )}
  </div>
);

const ModelProviderCard: React.FC<{ provider: ModelProviderStatus }> = ({ provider }) => {
  const models = provider.models ?? [];
  const orderedModels = [...models].sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)));
  const visibleModels = orderedModels.slice(0, 4);
  const hiddenCount = Math.max(0, orderedModels.length - visibleModels.length);
  return (
    <article className="min-w-0 rounded border border-white/8 bg-white/3 p-2">
      <div className="flex items-start gap-2 mb-1">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-bold text-zinc-100 truncate">{provider.label}</div>
          {provider.location && <div className="text-[7px] font-mono text-zinc-600 truncate" title={provider.location}>{provider.location}</div>}
        </div>
        <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[7px] font-mono uppercase tracking-widest ${modelStateClass(provider.state)}`}>
          {MODEL_STATE_LABELS[provider.state] ?? provider.state}
        </span>
      </div>
      <p className="mb-1.5 min-h-7 text-[8px] leading-snug text-zinc-500" title={provider.summary}>{provider.summary}</p>
      {visibleModels.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {visibleModels.map((model) => (
            <span
              key={model.id}
              title={modelTooltip(model)}
              className={`max-w-full truncate rounded border px-1 py-0.5 text-[7px] font-mono uppercase tracking-wide ${modelSourceClass(model.source)}`}
            >
              {model.recommended ? '★ ' : ''}{model.label}: {MODEL_SOURCE_LABELS[model.source] ?? model.source}
            </span>
          ))}
          {hiddenCount > 0 && <span className="rounded border border-white/10 px-1 py-0.5 text-[7px] font-mono text-zinc-500">+{hiddenCount}</span>}
        </div>
      ) : (
        <div className="text-[8px] font-mono text-zinc-700">No model details reported.</div>
      )}
    </article>
  );
};

/* ── Edit Layout Settings (global surface prefs) ──────────────────────────── */
const LayoutSettingsSection: React.FC = () => {
  const fillMode = useLayoutPrefs((s) => s.fillMode);
  const gapPx = useLayoutPrefs((s) => s.gapPx);
  const snapPx = useLayoutPrefs((s) => s.snapPx);
  const showGuides = useLayoutPrefs((s) => s.showGuides);
  const matchSizes = useLayoutPrefs((s) => s.matchSizes);
  const setFillMode = useLayoutPrefs((s) => s.setFillMode);
  const setGapPx = useLayoutPrefs((s) => s.setGapPx);
  const setSnapPx = useLayoutPrefs((s) => s.setSnapPx);
  const setShowGuides = useLayoutPrefs((s) => s.setShowGuides);
  const setMatchSizes = useLayoutPrefs((s) => s.setMatchSizes);
  const uiScale = useLayoutPrefs((s) => s.uiScale);
  const setUiScale = useLayoutPrefs((s) => s.setUiScale);
  const scalePct = Math.round(uiScale * 100);
  return (
    <>
      <div className="flex items-center gap-1.5 mb-2">
        <LayoutGrid className="w-3 h-3 text-purple-400" />
        <span className="text-[9px] font-black uppercase tracking-widest text-zinc-300">Edit Layout Settings</span>
        <span className="text-[8px] font-mono text-zinc-600 ml-auto">applies to every workspace</span>
      </div>
      <div className="border border-white/5 rounded px-3 py-2.5 bg-white/3 mb-4 flex flex-col gap-3">
        {/* App-wide text/UI size — a clamped page-zoom so nothing gets too big or small. */}
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-mono uppercase tracking-widest text-zinc-400 w-16 shrink-0">Text size:</span>
          <SlideTrack
            min={Math.round(UI_SCALE_MIN * 100)}
            max={Math.round(UI_SCALE_MAX * 100)}
            step={5}
            value={scalePct}
            onChange={(v) => setUiScale(v / 100)}
            className="flex-1"
            ariaLabel="App-wide text and UI size"
          />
          <span className="text-[8px] font-mono text-zinc-400 w-9 text-right tabular-nums">{scalePct}%</span>
          <button
            onClick={() => setUiScale(1)}
            disabled={scalePct === 100}
            className="text-[8px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border border-white/10 text-zinc-400 hover:text-zinc-100 hover:bg-white/5 disabled:opacity-40 disabled:cursor-default transition-colors"
            title="Reset text size to 100%"
          >
            Reset
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-mono uppercase tracking-widest text-zinc-400 w-16 shrink-0">Fill:</span>
          <div className="flex items-center gap-1">
            {([['scale', 'Scale controls'], ['natural', 'Compact']] as const).map(([v, lbl]) => (
              <button
                key={v}
                onClick={() => setFillMode(v)}
                className={`text-[8px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border transition-colors ${
                  fillMode === v ? 'bg-purple-500/25 border-purple-400/60 text-purple-100' : 'border-white/10 text-zinc-400 hover:text-zinc-100 hover:bg-white/5'
                }`}
                title={v === 'scale' ? 'Controls grow to fill their cell' : 'Controls stay compact, centered'}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-mono uppercase tracking-widest text-zinc-400 w-16 shrink-0">Gap:</span>
          <SlideTrack min={0} max={24} step={1} value={gapPx}
            onChange={(v) => setGapPx(v)} className="flex-1" ariaLabel="Gap between panels" />
          <span className="text-[8px] font-mono text-zinc-400 w-8 text-right tabular-nums">{gapPx}px</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-mono uppercase tracking-widest text-zinc-400 w-16 shrink-0">Snap:</span>
          <SlideTrack min={0} max={24} step={1} value={snapPx}
            onChange={(v) => setSnapPx(v)} className="flex-1" ariaLabel="Snap step when dragging margins" />
          <span className="text-[8px] font-mono text-zinc-400 w-8 text-right tabular-nums">{snapPx === 0 ? 'off' : `${snapPx}px`}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-mono uppercase tracking-widest text-zinc-400 w-16 shrink-0">Guides:</span>
          <button
            onClick={() => setShowGuides(!showGuides)}
            className={`text-[8px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border transition-colors ${
              showGuides ? 'bg-purple-500/25 border-purple-400/60 text-purple-100' : 'border-white/10 text-zinc-400 hover:text-zinc-100 hover:bg-white/5'
            }`}
            title="Show centre + increment alignment guides while editing a layout"
          >
            {showGuides ? 'On' : 'Off'}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-mono uppercase tracking-widest text-zinc-400 w-16 shrink-0">Match:</span>
          <button
            onClick={() => setMatchSizes(!matchSizes)}
            className={`text-[8px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border transition-colors ${
              matchSizes ? 'bg-purple-500/25 border-purple-400/60 text-purple-100' : 'border-white/10 text-zinc-400 hover:text-zinc-100 hover:bg-white/5'
            }`}
            title="Match same-kind control sizes — equal height across a row, equal width down a column"
          >
            {matchSizes ? 'On' : 'Off'}
          </button>
        </div>
        <p className="text-[8px] text-zinc-600 leading-relaxed">
          Scale grows controls to fill empty space; Compact keeps them at a natural size. Gap sets the spacing between panels. Per-panel padding, mirror, and control placement are edited inside each workspace's Edit Layout mode.
        </p>
      </div>
    </>
  );
};

/* ── Modules as compact grouped tiles ─────────────────────────────────────── */
const MODULE_GROUPS: Record<string, string> = {
  chimera: 'Generation',
  analysis: 'Audio', effects: 'Audio', stems: 'Audio', midi: 'Audio',
  library: 'Library', ytimport: 'Library',
  vj: 'Performance', controllervision: 'Performance',
  settings: 'System',
};
const GROUP_ORDER = ['Generation', 'Audio', 'Library', 'Performance', 'System', 'Other'];

const ModuleTree: React.FC<{
  modules: ModuleConfig[];
  toggling: string | null;
  changedModules: Set<string>;
  onToggle: (dir: string, enabled: boolean) => void;
}> = ({ modules, toggling, changedModules, onToggle }) => {
  const groups: Record<string, ModuleConfig[]> = {};
  for (const m of Array.isArray(modules) ? modules : []) {
    const g = MODULE_GROUPS[m.name] ?? 'Other';
    (groups[g] ??= []).push(m);
  }
  const names = GROUP_ORDER.filter((g) => groups[g]?.length);
  return (
    <div className="flex flex-col gap-2 mb-4">
      {names.map((name) => {
        const mods = groups[name];
        const onCount = mods.filter((m) => m.enabled).length;
        return (
          <section key={name} className="rounded border border-white/5 bg-white/3 p-2">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[8px] font-black uppercase tracking-widest text-purple-300">{name}</span>
              <span className="text-[8px] font-mono text-zinc-600 ml-auto">{onCount}/{mods.length} enabled</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
          {mods.map((mod) => (
                <ModuleTile
                  key={mod._dir || mod.name}
                  mod={mod}
                  toggling={toggling}
                  changed={changedModules.has(mod._dir || mod.name)}
                  onToggle={onToggle}
                />
          ))}
            </div>
          </section>
        );
      })}
    </div>
  );
};

const ModuleTile: React.FC<{
  mod: ModuleConfig;
  toggling: string | null;
  changed: boolean;
  onToggle: (dir: string, enabled: boolean) => void;
}> = ({ mod, toggling, changed, onToggle }) => {
  const key = mod._dir || mod.name;
  const isToggling = toggling === key;
  return (
    <article className={`min-w-0 rounded border p-2 transition-colors ${mod.enabled ? 'bg-black/25 border-white/10' : 'bg-black/15 border-white/5 opacity-65'}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 mb-1 min-w-0">
            <span className="text-[10px] font-bold text-zinc-100 truncate">{mod.label || mod.name}</span>
            {mod.version && <span className="text-[7px] font-mono text-zinc-600 shrink-0">v{mod.version}</span>}
          </div>
          <div className="flex items-center gap-1 flex-wrap mb-1">
            <span className={`text-[7px] font-mono uppercase tracking-widest px-1 py-0.5 rounded border ${mod.enabled ? 'text-purple-200 bg-purple-500/10 border-purple-500/25' : 'text-zinc-500 bg-white/3 border-white/10'}`}>
              {mod.enabled ? 'Enabled' : 'Off'}
            </span>
            {mod._loaded && <span className="text-[7px] font-mono uppercase tracking-widest text-green-300 bg-green-500/10 border border-green-500/20 px-1 py-0.5 rounded">Running</span>}
            {changed && <span className="text-[7px] font-mono uppercase tracking-widest text-amber-300 bg-amber-500/10 border border-amber-500/20 px-1 py-0.5 rounded">Restart</span>}
          </div>
        </div>
        <button
          onClick={() => onToggle(key, !mod.enabled)}
          disabled={isToggling}
          className="shrink-0 transition-opacity disabled:opacity-50"
          title={mod.enabled ? 'Disable module' : 'Enable module'}
          aria-label={`${mod.enabled ? 'Disable' : 'Enable'} ${mod.label || mod.name}`}
        >
          {isToggling ? (
            <RefreshCw className="w-4 h-4 text-zinc-500 animate-spin" />
          ) : mod.enabled ? (
            <ToggleRight className="w-6 h-6 text-purple-400" />
          ) : (
            <ToggleLeft className="w-6 h-6 text-zinc-600" />
          )}
        </button>
      </div>
      {mod.description && <p className="text-[8px] text-zinc-500 leading-snug line-clamp-2 min-h-8" title={mod.description}>{mod.description}</p>}
      {mod.api_prefix && <div className="text-[8px] font-mono text-zinc-700 truncate mt-1" title={mod.api_prefix}>{mod.api_prefix}</div>}
    </article>
  );
};

/** Restarts the backend by hitting POST /api/admin/restart and then
 *  polling /api/health until the new process answers. The button
 *  surfaces three states: idle, restarting (spinner), and a short
 *  success/error flash that auto-resets after a few seconds.
 *
 *  Deadline is 90s because the backend's startup includes torch + CUDA
 *  module loading + ML model init, which on slower GPUs can comfortably
 *  push past a tighter window. We flash success as soon as /api/health
 *  returns 200 (which is decoupled from model loading on the backend
 *  side — health responds the moment uvicorn is up). */
const RestartServerButton: React.FC = () => {
  type Status = 'idle' | 'restarting' | 'success' | 'error';
  const [status, setStatus] = useState<Status>('idle');
  const [detail, setDetail] = useState<string>('');

  const handle = async () => {
    if (status === 'restarting') return;
    setStatus('restarting');
    setDetail('Sending restart signal…');
    try {
      const r = await fetch('/api/admin/restart', { method: 'POST' });
      if (r.status === 412) {
        // Backend isn't running under the supervisor — show its detail
        // verbatim so the user knows how to enable restart.
        const body = await r.json().catch(() => ({ detail: '' }));
        setStatus('error');
        setDetail(body.detail || 'Supervisor not detected. Launch via theDAW.bat to enable restart.');
        setTimeout(() => {
          setStatus('idle');
          setDetail('');
        }, 10_000);
        return;
      }
      if (!r.ok) throw new Error(`restart endpoint returned ${r.status}`);
      // Wait a beat for the process to exit, then poll /api/health.
      setDetail('Waiting for backend to come back…');
      const deadline = Date.now() + 90_000;
      // Brief initial sleep so we don't race the still-alive old
      // process before the supervisor re-spawns.
      await new Promise((res) => setTimeout(res, 1500));
      while (Date.now() < deadline) {
        try {
          const h = await fetch('/api/health', { cache: 'no-store' });
          if (h.ok) {
            setStatus('success');
            setDetail('Backend restarted.');
            setTimeout(() => {
              setStatus('idle');
              setDetail('');
            }, 4000);
            return;
          }
        } catch {
          // expected during the offline window
        }
        const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        setDetail(`Waiting for backend to come back… ${remaining}s left`);
        await new Promise((res) => setTimeout(res, 500));
      }
      throw new Error("backend didn't respond within 90s — it may still be loading; try refreshing the page");
    } catch (e) {
      setStatus('error');
      setDetail(e instanceof Error ? e.message : 'restart failed');
      setTimeout(() => {
        setStatus('idle');
        setDetail('');
      }, 10_000);
    }
  };

  const baseCls =
    'flex items-center justify-center gap-2 flex-1 px-3 py-2 rounded border text-[10px] font-black uppercase tracking-widest transition-colors';
  const stateCls: Record<Status, string> = {
    idle: 'border-purple-500/40 bg-purple-500/10 text-purple-200 hover:bg-purple-500/20 hover:border-purple-400/60',
    restarting: 'border-amber-500/40 bg-amber-500/10 text-amber-200 cursor-wait',
    success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200 cursor-default',
    error: 'border-rose-500/40 bg-rose-500/10 text-rose-200 cursor-default',
  };

  const icon =
    status === 'restarting' ? (
      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
    ) : status === 'success' ? (
      <CheckCircle2 className="w-3.5 h-3.5" />
    ) : status === 'error' ? (
      <AlertCircle className="w-3.5 h-3.5" />
    ) : (
      <Power className="w-3.5 h-3.5" />
    );

  const label =
    status === 'restarting'
      ? 'Restarting…'
      : status === 'success'
      ? 'Back online'
      : status === 'error'
      ? 'Restart failed'
      : 'Restart';

  return (
    <button
      type="button"
      onClick={handle}
      disabled={status === 'restarting'}
      className={`${baseCls} ${stateCls[status]}`}
      title={detail || label}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
};

/** Cleanly stops the theDAW backend (rc=0). The supervisor sees a non-
 *  restart exit code and terminates the loop, so the whole theDAW
 *  console closes and the user has to relaunch via theDAW.bat to
 *  bring it back up. Confirms before sending the shutdown signal
 *  because this can't be reversed from the browser side once fired. */
const ShutdownServerButton: React.FC = () => {
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  const handle = async () => {
    if (pending || done) return;
    const ok = window.confirm(
      'Shut down the theDAW backend?\n\nThe browser will lose its connection. Relaunch via theDAW.bat to bring it back.',
    );
    if (!ok) return;
    setPending(true);
    try {
      await fetch('/api/admin/shutdown', { method: 'POST' });
      setDone(true);
    } catch {
      // The fetch may abort mid-shutdown — that's expected. Treat it
      // as a successful trigger so the UI flips to the terminal state.
      setDone(true);
    } finally {
      setPending(false);
    }
  };

  const baseCls =
    'flex items-center justify-center gap-2 flex-1 px-3 py-2 rounded border text-[10px] font-black uppercase tracking-widest transition-colors';
  const cls = done
    ? 'border-rose-500/50 bg-rose-500/15 text-rose-200 cursor-default'
    : pending
    ? 'border-amber-500/40 bg-amber-500/10 text-amber-200 cursor-wait'
    : 'border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 hover:border-rose-400/60';

  const icon = done ? (
    <PowerOff className="w-3.5 h-3.5" />
  ) : pending ? (
    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
  ) : (
    <PowerOff className="w-3.5 h-3.5" />
  );
  const label = done ? 'Offline' : pending ? 'Shutting down…' : 'Shutdown';

  return (
    <button
      type="button"
      onClick={handle}
      disabled={pending || done}
      className={`${baseCls} ${cls}`}
      title="Stop the SA3 backend entirely (supervisor exits, no respawn)."
    >
      {icon}
      <span>{label}</span>
    </button>
  );
};


interface FeatureToggleGroupProps {
  icon: React.ReactNode;
  title: string;
  desc: string;
  onImport: boolean;
  onGenerate: boolean;
  onPatchImport: (next: boolean) => void;
  onPatchGenerate: (next: boolean) => void;
  /** Optional extra controls rendered below the on-import/on-generate
   *  toggles — e.g. the stems device picker. */
  extra?: React.ReactNode;
}

const FeatureToggleGroup: React.FC<FeatureToggleGroupProps> = ({
  icon, title, desc, onImport, onGenerate, onPatchImport, onPatchGenerate, extra,
}) => (
  <div className="border border-white/5 rounded px-3 py-2.5 bg-white/3">
    <div className="flex items-center gap-2 mb-1.5">
      {icon}
      <span className="text-[10px] font-bold text-zinc-100">{title}</span>
    </div>
    <p className="text-[9px] text-zinc-500 mb-2 leading-relaxed">{desc}</p>
    <div className="flex items-center gap-4">
      <ToggleRow label="on import" enabled={onImport} onToggle={() => onPatchImport(!onImport)} />
      <ToggleRow label="on generate" enabled={onGenerate} onToggle={() => onPatchGenerate(!onGenerate)} />
    </div>
    {extra}
  </div>
);


interface ToggleRowProps {
  label: string;
  enabled: boolean;
  onToggle: () => void;
}

const ToggleRow: React.FC<ToggleRowProps> = ({ label, enabled, onToggle }) => (
  <button
    onClick={onToggle}
    className="flex items-center gap-1.5 group"
    title={enabled ? `Disable: ${label}` : `Enable: ${label}`}
  >
    {enabled ? (
      <ToggleRight className="w-5 h-5 text-purple-400 group-hover:text-purple-300" />
    ) : (
      <ToggleLeft className="w-5 h-5 text-zinc-600 group-hover:text-zinc-500" />
    )}
    <span className={`text-[9px] font-mono uppercase tracking-widest ${enabled ? 'text-purple-200' : 'text-zinc-500'}`}>
      {label}
    </span>
  </button>
);

