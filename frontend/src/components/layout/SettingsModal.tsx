import React, { useState, useEffect } from 'react';
import { Settings, X, Package, RefreshCw, AlertTriangle, ToggleLeft, ToggleRight, Activity, Scissors, Music } from 'lucide-react';
import { useFeatureToggleStore } from '../../state/featureToggleStore';

interface ModuleConfig {
  name: string;
  description?: string;
  version?: string;
  enabled: boolean;
  api_prefix?: string;
  _dir?: string;
  _loaded?: boolean;
}

export const SettingsModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const [modules, setModules] = useState<ModuleConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const featureSettings = useFeatureToggleStore((s) => s.settings);
  const refreshFeatures = useFeatureToggleStore((s) => s.refresh);
  const patchFeatures = useFeatureToggleStore((s) => s.patch);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setDirty(false);
    void refreshFeatures();
    fetch('/api/modules/all')
      .then((r) => r.json() as Promise<ModuleConfig[]>)
      .then(setModules)
      .catch(() => setModules([]))
      .finally(() => setLoading(false));
  }, [open, refreshFeatures]);

  const toggleModule = async (dirName: string, enabled: boolean) => {
    setToggling(dirName);
    try {
      const res = await fetch(`/api/modules/${dirName}/enabled`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) {
        setModules((prev) => prev.map((m) => (m._dir === dirName ? { ...m, enabled } : m)));
        setDirty(true);
      }
    } finally {
      setToggling(null);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-[#0c0a14] border border-purple-500/30 rounded-lg w-[480px] max-h-[75vh] flex flex-col shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 shrink-0">
          <div className="flex items-center gap-2">
            <Settings className="w-3.5 h-3.5 text-purple-400" />
            <span className="text-[10px] font-black uppercase tracking-widest text-purple-300">System Settings</span>
          </div>
          <button onClick={onClose} className="p-1 text-zinc-500 hover:text-white transition-colors rounded hover:bg-white/5">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3">

          {/* Section: Background features (auto-analysis / stems / midi) */}
          <div className="flex items-center gap-1.5 mb-2">
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
          ) : modules.length === 0 ? (
            <div className="text-center py-10 text-[9px] text-zinc-600 font-mono">No modules found in backend/modules/</div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {modules.map((mod) => {
                const key = mod._dir || mod.name;
                const isToggling = toggling === key;
                return (
                  <div
                    key={key}
                    className={`flex items-center gap-3 px-3 py-2.5 border rounded transition-colors ${
                      mod.enabled ? 'bg-white/3 border-white/8' : 'bg-black/20 border-white/5 opacity-60'
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-[10px] font-bold text-zinc-100 truncate">{mod.name}</span>
                        {mod.version && (
                          <span className="text-[8px] font-mono text-zinc-600 shrink-0">v{mod.version}</span>
                        )}
                        {mod._loaded && (
                          <span className="text-[7px] font-mono text-green-400 bg-green-500/10 border border-green-500/20 px-1 py-0.5 rounded shrink-0">RUNNING</span>
                        )}
                      </div>
                      {mod.description && (
                        <p className="text-[9px] text-zinc-500 truncate">{mod.description}</p>
                      )}
                      {mod.api_prefix && (
                        <span className="text-[8px] font-mono text-zinc-700">{mod.api_prefix}</span>
                      )}
                    </div>

                    {/* Toggle switch */}
                    <button
                      onClick={() => void toggleModule(key, !mod.enabled)}
                      disabled={isToggling}
                      className="shrink-0 transition-opacity disabled:opacity-50"
                      title={mod.enabled ? 'Disable module' : 'Enable module'}
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
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
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
}

const FeatureToggleGroup: React.FC<FeatureToggleGroupProps> = ({
  icon, title, desc, onImport, onGenerate, onPatchImport, onPatchGenerate,
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
