/**
 * Settings → Models: provider cards (dense two-column grid), the Hugging Face
 * token on one row, the register-a-checkpoint form (collapsed behind Add),
 * and the registered local checkpoints.
 *
 * Cards render immediately from the last known set (localStorage) so they
 * never pop into existence while you're reading elsewhere; a background
 * refresh updates them, and while something is in flight (engine starting,
 * Lyria installing) the panel re-polls every few seconds on its own.
 */
import React, { useEffect, useState } from 'react';
import { HardDrive, Plus, RefreshCw, ToggleLeft, ToggleRight } from 'lucide-react';
import {
  addCheckpoint, fetchCheckpoints, fetchModelStatus, generateCheckpointConfig, inspectCheckpoint,
  openLocation, removeCheckpoint, setLocalOnly,
  type CheckpointInspection, type RegisteredCheckpoint,
} from '../../../lib/storageClient';
import { HfTokenField } from '../../ui/HfTokenField';
import { PathInput } from '../../ui/PathInput';
import { ModelProviderCard } from './ProviderCards';
import type { ProviderStatus } from './providerTypes';
import { BTN_AMBER, BTN_GHOST, BTN_PURPLE, BTN_ROSE, CARD, INPUT, SectionHeader } from './shared';

const PROVIDERS_CACHE_KEY = 'thedaw-model-providers-cache';
function loadCachedProviders(): ProviderStatus[] {
  try {
    const raw = localStorage.getItem(PROVIDERS_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function saveCachedProviders(p: ProviderStatus[]): void {
  try {
    localStorage.setItem(PROVIDERS_CACHE_KEY, JSON.stringify(p));
  } catch {
    /* storage full / unavailable — caching is best-effort */
  }
}

const inFlight = (p: ProviderStatus): boolean =>
  p.state === 'starting' || p.engine_state === 'starting' || Boolean(p.lyria?.installing);

export const ModelsSection: React.FC = () => {
  const [registered, setRegistered] = useState<RegisteredCheckpoint[]>([]);
  const [localOnly, setLocalOnlyState] = useState(true);
  const [providers, setProviders] = useState<ProviderStatus[]>(() => loadCachedProviders());
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addPath, setAddPath] = useState('');
  const [addName, setAddName] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [inspection, setInspection] = useState<CheckpointInspection | null>(null);
  const [generating, setGenerating] = useState(false);

  // The MAKE no-model warning opens Settings with {section:'models'}; pulse it.
  const sectionRef = React.useRef<HTMLElement>(null);
  const [highlight, setHighlight] = useState(false);
  useEffect(() => {
    const onFocusModels = (e: Event) => {
      if ((e as CustomEvent).detail?.section !== 'models') return;
      setHighlight(true);
      setTimeout(() => sectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60);
      setTimeout(() => setHighlight(false), 2600);
    };
    window.addEventListener('thedaw:open-settings', onFocusModels);
    return () => window.removeEventListener('thedaw:open-settings', onFocusModels);
  }, []);

  const reload = React.useCallback(() => {
    fetchCheckpoints()
      .then((d) => { setRegistered(d.registered); setLocalOnlyState(d.local_only); })
      .catch(() => undefined);
  }, []);

  const reloadModelStatus = React.useCallback(() => {
    setStatusLoading(true);
    setStatusError(null);
    fetchModelStatus()
      .then((d) => {
        const next = d.providers as ProviderStatus[];
        setProviders(next);
        saveCachedProviders(next);
        setLocalOnlyState(d.local_only);
      })
      .catch((e) => {
        setStatusError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setStatusLoading(false));
  }, []);

  useEffect(() => {
    reload();
    reloadModelStatus();
    // The install watcher fires this when the Magenta installer lands.
    window.addEventListener('thedaw:magenta-installed', reloadModelStatus);
    return () => window.removeEventListener('thedaw:magenta-installed', reloadModelStatus);
  }, [reload, reloadModelStatus]);

  // Live states re-poll themselves so a Start/Install shows its progress here.
  const busy = providers.some(inFlight);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(reloadModelStatus, 4000);
    return () => clearInterval(t);
  }, [busy, reloadModelStatus]);

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

  const toggleDownload = () => {
    // "Download missing" is the inverse of local-only; local-only is the safe
    // default, so downloading is what you opt INTO.
    void setLocalOnly(!localOnly)
      .then((enabled) => { setLocalOnlyState(enabled); reloadModelStatus(); })
      .catch(() => undefined);
  };
  const downloadMissing = !localOnly;

  return (
    <section
      ref={sectionRef}
      aria-labelledby="settings-models-title"
      className={highlight ? 'rounded ring-2 ring-purple-500/60 transition-shadow' : undefined}
    >
      {/* Header: title + tip + refresh, then Download toggle + Add on the right */}
      <SectionHeader icon={<HardDrive className="w-3.5 h-3.5 text-purple-400" />} title="Models"
        tip="Models load on demand at the first CREATE. Safe default is local-only: theDAW never downloads weights until you turn on Download. Register checkpoints you already have, or connect a cloud API. Each card's buttons fix what blocks it; hover a card or chip for the details.">
        <button type="button" onClick={reloadModelStatus} title="Re-check local models and APIs" aria-label="Re-check local models and APIs"
          className="text-zinc-400 hover:text-zinc-100 transition-colors">
          <RefreshCw className={`w-3 h-3 ${statusLoading ? 'animate-spin' : ''}`} />
        </button>
        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={toggleDownload} aria-pressed={downloadMissing}
            title="On: missing models download on first use. Off: local-only (safe default) — missing models warn instead."
            className="flex items-center gap-1 text-[11px] font-mono uppercase tracking-widest text-zinc-300 hover:text-white transition-colors">
            {downloadMissing
              ? <ToggleRight className="w-4 h-4 text-amber-400" />
              : <ToggleLeft className="w-4 h-4 text-emerald-400" />}
            Download
          </button>
          <button type="button" onClick={() => setAddOpen((v) => !v)} aria-expanded={addOpen} aria-controls="settings-add-checkpoint"
            title="Register a checkpoint you already have on disk"
            className={addOpen ? `${BTN_PURPLE} bg-purple-500/25 border-purple-400/60 text-purple-100` : BTN_PURPLE}>
            <Plus className="w-3 h-3" /> Add
          </button>
        </div>
      </SectionHeader>
      <span id="settings-models-title" className="sr-only">Models</span>

      {statusError && <p role="alert" className="mb-1 truncate text-[11px] text-rose-300" title={statusError}>Model status failed: {statusError}</p>}
      {statusLoading && providers.length === 0 ? (
        <div className="flex items-center gap-2 px-2 py-3 text-[11px] font-mono text-zinc-400">
          <RefreshCw className="w-3 h-3 animate-spin" /> Checking local models and APIs…
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {providers.map((provider) => (
            <ModelProviderCard key={provider.id} provider={provider} onFixed={reloadModelStatus} />
          ))}
        </div>
      )}

      {/* Hugging Face token — the one field that unblocks gated downloads.
          Always present, one row, so it is where you would look for it rather
          than something you have to be told about. Signing in re-checks model
          status, so the pills above stop lying. */}
      <div className={`${CARD} mt-1.5 px-2 py-1`}>
        <HfTokenField compact idPrefix="settings-models" onSignedIn={reloadModelStatus} />
      </div>

      {/* Add-a-checkpoint form (collapsed; opened from the header) */}
      <div id="settings-add-checkpoint" hidden={!addOpen} className="mt-1.5 flex flex-col gap-1.5 p-2 rounded border border-purple-500/20 bg-purple-500/5">
        <PathInput
          inline
          id="settings-ckpt-path"
          name="settings-ckpt-path"
          label="Checkpoint"
          value={addPath}
          onChange={setAddPath}
          kind="folder"
          onEnter={() => void onAdd()}
          placeholder="D:\models\my-finetune"
          description="Browse or paste a folder (or .safetensors) path. The folder needs a model config JSON next to one .safetensors file. Get the config JSON from the matching Hugging Face repo or the training/export artifact. The entry appears in the MAKE model picker."
        />
        <div className="flex gap-1.5">
          <label htmlFor="settings-ckpt-name" className="sr-only">Display name (optional)</label>
          <input
            id="settings-ckpt-name"
            name="settings-ckpt-name"
            type="text"
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void onAdd(); }}
            spellCheck={false}
            placeholder="Name (optional)"
            title="Shown in the MAKE model picker"
            className={`${INPUT} flex-1`}
          />
          <button type="button" onClick={() => void onAdd()} disabled={adding || !addPath.trim()} className={BTN_PURPLE}>
            {adding ? 'Checking…' : 'Add'}
          </button>
          {inspection && !inspection.resolves && inspection.recognized?.config_available && (
            <button
              type="button"
              onClick={() => void onGenerateConfig()}
              disabled={generating}
              className={BTN_AMBER}
              title={`Copies the official ${inspection.recognized.config_name} from your local/cached copy next to the checkpoint. Nothing is guessed and nothing downloads.`}
            >
              {generating ? 'Generating…' : `Generate config (${inspection.recognized.model})`}
            </button>
          )}
        </div>
        {addError && <p role="alert" className="text-[11px] text-rose-300">{addError}</p>}
      </div>

      {/* Registered local checkpoints — one line each */}
      {registered.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1">
          {registered.map((ck) => (
            <div key={ck.id} className={`flex items-center gap-2 px-2 py-1 rounded border ${ck.resolves ? 'border-white/10 bg-white/3' : 'border-red-500/30 bg-red-500/5'}`}>
              <span className="text-xs font-bold text-zinc-200 truncate shrink-0 max-w-[40%]">{ck.name}</span>
              <span className="text-[11px] font-mono text-zinc-500 truncate flex-1 min-w-0" title={ck.path}>{ck.path}</span>
              {!ck.resolves && <span className="text-[11px] font-mono text-red-300 shrink-0">missing</span>}
              <button
                type="button"
                onClick={() => { void openLocation(ck.path).catch(() => undefined); }}
                className={BTN_GHOST}
                aria-label={`Open ${ck.name} in Explorer`}
              >
                Open
              </button>
              <button
                type="button"
                onClick={() => { void removeCheckpoint(ck.id).then(() => { reload(); reloadModelStatus(); }).catch(() => undefined); }}
                className={BTN_ROSE}
                aria-label={`Remove ${ck.name} from the list (files stay on disk)`}
                title="Removes the dropdown entry only — the files stay on disk."
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
