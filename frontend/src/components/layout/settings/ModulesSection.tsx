/**
 * Backend modules as a dense grid: tiny group headings spanning the row, one
 * tile per module (name + running dot + toggle). Descriptions live in hover
 * titles. A change marks the tile "restart" and the header says so once.
 */
import React, { useState } from 'react';
import { AlertTriangle, Package, RefreshCw } from 'lucide-react';
import { useModuleStore, type ModuleConfig } from '../../../state/moduleStore';
import { BTN_PURPLE, CARD, IconToggle, SectionHeader } from './shared';

const MODULE_GROUPS: Record<string, string> = {
  chimera: 'Generation', magenta: 'Generation', suno: 'Generation', lyria: 'Generation', foundry: 'Generation',
  analysis: 'Audio', effects: 'Audio', stems: 'Audio', midi: 'Audio', mastering: 'Audio', restoration: 'Audio',
  enhance: 'Audio', vocal: 'Audio', creative_fx: 'Audio', creative_neural: 'Audio', convert: 'Audio', analyzer: 'Audio',
  library: 'Library', ytimport: 'Library', dawimport: 'Library', sheetimport: 'Library', project: 'Library',
  notation: 'Library', delivery: 'Library', backup: 'Library', storage: 'Library', modeldl: 'Library', hfauth: 'Library',
  vj: 'Performance', controllervision: 'Performance', sway: 'Performance', quest: 'Performance', questcast: 'Performance',
  questmidi: 'Performance', queststitch: 'Performance', xrcontrol: 'Performance', akvj: 'Performance', broadcast: 'Performance',
  settings: 'System', updates: 'System', tour: 'System', genaiproxy: 'System', plugin: 'System', vst: 'System', underfit: 'System',
};
const GROUP_ORDER = ['Generation', 'Audio', 'Library', 'Performance', 'System', 'Other'];

export const ModulesSection: React.FC = () => {
  // Modules come from the shared store, preloaded on backend-ready (App.tsx).
  const modules = useModuleStore((s) => s.modules);
  const loading = useModuleStore((s) => s.loading && !s.loaded);
  const moduleError = useModuleStore((s) => s.error);
  const loadModules = useModuleStore((s) => s.load);
  const setModuleEnabled = useModuleStore((s) => s.setEnabled);
  // Per-open state: the section unmounts with the modal, so this resets on reopen.
  const [changed, setChanged] = useState<Set<string>>(() => new Set());
  const [toggling, setToggling] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  React.useEffect(() => {
    void loadModules();
  }, [loadModules]);

  const toggleModule = async (dirName: string, enabled: boolean) => {
    setToggling(dirName);
    setToggleError(null);
    try {
      const ok = await setModuleEnabled(dirName, enabled);
      if (ok) setChanged((prev) => new Set(prev).add(dirName));
      else setToggleError(`Could not ${enabled ? 'enable' : 'disable'} ${dirName} — the backend refused or is unreachable.`);
    } finally {
      setToggling(null);
    }
  };

  const groups: Record<string, ModuleConfig[]> = {};
  for (const m of Array.isArray(modules) ? modules : []) {
    const g = MODULE_GROUPS[m.name] ?? 'Other';
    (groups[g] ??= []).push(m);
  }
  const names = GROUP_ORDER.filter((g) => groups[g]?.length);
  const onCount = modules.filter((m) => m.enabled).length;

  return (
    <section aria-labelledby="settings-modules-title">
      <SectionHeader icon={<Package className="w-3.5 h-3.5 text-purple-400" />} title="Modules"
        tip="Enable or disable backend modules (effects, stems, MIDI, VJ, and more). Changes take effect after a backend restart — use the restart icon in the header."
        meta={changed.size > 0 ? 'restart to apply' : `${onCount}/${modules.length} on`}>
        {changed.size > 0 && (
          <span className="inline-flex items-center gap-1 rounded border border-amber-500/20 bg-amber-500/10 px-1 text-[11px] font-mono text-amber-300" title="Restart the backend (header icon) for module changes to take effect.">
            <AlertTriangle className="w-3 h-3" /> {changed.size} changed
          </span>
        )}
      </SectionHeader>
      <span id="settings-modules-title" className="sr-only">Modules</span>
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-4 text-zinc-400">
          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
          <span className="text-[11px] font-mono">Loading modules...</span>
        </div>
      ) : moduleError ? (
        <div className="flex flex-col items-center gap-2 py-3 text-center">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          <span className="text-[11px] font-mono text-amber-300">Couldn't reach the backend ({moduleError}).</span>
          <button type="button" onClick={() => void loadModules({ force: true })} className={BTN_PURPLE}>Retry</button>
        </div>
      ) : modules.length === 0 ? (
        <div className="text-center py-4 text-[11px] text-zinc-400 font-mono">No modules found in backend/modules/</div>
      ) : (
        <div className={`${CARD} px-2 py-1 grid grid-cols-3 lg:grid-cols-4 gap-x-1.5 gap-y-0.5`}>
          {names.map((name) => {
            const mods = groups[name];
            const on = mods.filter((m) => m.enabled).length;
            return (
              <React.Fragment key={name}>
                <div className="col-span-full flex items-center gap-2 pt-0.5 leading-4">
                  <span className="text-[10px] font-black uppercase tracking-widest text-purple-300">{name}</span>
                  <span className="text-[10px] font-mono text-zinc-500">{on}/{mods.length}</span>
                  <span className="h-px flex-1 bg-white/5" aria-hidden />
                </div>
                {mods.map((mod) => (
                  <ModuleTile
                    key={mod._dir || mod.name}
                    mod={mod}
                    busy={toggling === (mod._dir || mod.name)}
                    changed={changed.has(mod._dir || mod.name)}
                    onToggle={(dir, en) => void toggleModule(dir, en)}
                  />
                ))}
              </React.Fragment>
            );
          })}
        </div>
      )}
      {toggleError && (
        <p role="alert" className="mt-1 truncate text-[11px] text-rose-300" title={toggleError}>{toggleError}</p>
      )}
    </section>
  );
};

const ModuleTile: React.FC<{
  mod: ModuleConfig;
  busy: boolean;
  changed: boolean;
  onToggle: (dir: string, enabled: boolean) => void;
}> = ({ mod, busy, changed, onToggle }) => {
  const key = mod._dir || mod.name;
  const hoverInfo = [mod.description, mod.api_prefix].filter(Boolean).join('  ·  ');
  return (
    <article
      title={hoverInfo || undefined}
      className={`min-w-0 rounded border px-1.5 py-px flex items-center gap-1 transition-colors ${mod.enabled ? 'bg-black/25 border-white/10' : 'bg-black/15 border-white/5 opacity-70'}`}
    >
      <span className="text-xs text-zinc-100 truncate min-w-0 flex-1">{mod.label || mod.name}</span>
      {mod._loaded && <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-green-400" role="img" aria-label="Running" title="Running" />}
      {changed && <span className="shrink-0 text-[10px] font-mono uppercase text-amber-300" title="Restart the backend to apply">↻</span>}
      <IconToggle
        enabled={mod.enabled}
        busy={busy}
        onToggle={() => onToggle(key, !mod.enabled)}
        label={`${mod.enabled ? 'Disable' : 'Enable'} ${mod.label || mod.name} module`}
        title={mod.enabled ? 'Disable module' : 'Enable module'}
      />
    </article>
  );
};
