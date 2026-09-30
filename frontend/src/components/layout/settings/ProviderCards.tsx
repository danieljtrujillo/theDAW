/**
 * Provider cards for Settings → Models.
 *
 * One card per provider (Stable Audio, Magenta RT2, Suno, Lyria, Demucs,
 * MIDI): name + state pill, a one-line summary (full text on hover), then the
 * fix buttons for whatever blocks it and the model chips. Every fixable state
 * gets its button here, before anything is run — a provider that needs setup
 * must never be discovered by a failed generation.
 *
 * Magenta's chips are the REAL model list (what the vendored sidecar can load):
 * the active one is starred, an installed one offers "Use", a missing one
 * offers a download that lands in the Download dock. Lyria's card carries the
 * clone + npm install and its two ordered key lists (Gemini and OpenRouter)
 * plus the provider the sidecar should start on and the switch that shares the
 * assistant's key pool with it.
 */
import React, { useEffect, useState } from 'react';
import { CheckCircle2, Download, Eye, EyeOff, Loader2, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';
import { pairingHeaderFor } from '../../../lib/apiJson';
import { setLocalOnly } from '../../../lib/storageClient';
import { useDownloadStore } from '../../../state/downloadStore';
import { useSunoStore } from '../../../suno/sunoStore';
import {
  ensureMagentaEngine,
  fetchMagentaEngineStatus,
  installMagentaEngine,
  restartMagentaEngine,
  setMagentaModel,
  stopMagentaEngine,
} from '../../../lib/magentaEngineClient';
import type { LyriaProvider, ModelOption, ProviderStatus } from './providerTypes';
import {
  BTN_AMBER,
  BTN_GHOST,
  BTN_GHOST_12,
  BTN_PURPLE,
  BTN_PURPLE_12,
  BTN_ROSE,
  BTN_SKY,
  CARD,
  FIELD_LABEL,
  FIELD_LABEL_12,
  INPUT,
  SELECT,
  postFix,
  sleep,
} from './shared';
import { SecretFieldLabel } from '../../ui/SecretFieldLabel';

export const MODEL_STATE_LABELS: Record<string, string> = {
  active: 'Active',
  ready: 'Ready',
  starting: 'Starting',
  cached: 'Cached',
  local: 'Local',
  needs_setup: 'Setup',
  needs_key: 'Needs key',
  missing_config: 'No config',
  download_blocked: 'Blocked',
  unavailable: 'Unavailable',
};

const EMERALD = 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
const AMBER = 'border-amber-500/30 bg-amber-500/10 text-amber-200';
const SKY = 'border-sky-500/30 bg-sky-500/10 text-sky-200';
const ROSE = 'border-rose-500/30 bg-rose-500/10 text-rose-200';
const ZINC = 'border-zinc-600/40 bg-white/3 text-zinc-300';

const modelStateClass = (state: string) => {
  if (state === 'active' || state === 'ready' || state === 'local' || state === 'cached') return EMERALD;
  if (state === 'starting') return SKY;
  if (state === 'needs_key' || state === 'needs_setup' || state === 'missing_config' || state === 'download_blocked') return AMBER;
  if (state === 'unavailable') return ROSE;
  return ZINC;
};

const modelSourceClass = (source: string) => {
  if (source === 'local' || source === 'registered' || source === 'api') return EMERALD;
  if (source === 'cached') return SKY;
  if (source === 'download') return ZINC;
  return ROSE;
};

const modelTooltip = (model: ModelOption) =>
  [
    model.label,
    model.repo_id ? `repo: ${model.repo_id}` : null,
    model.path ? `path: ${model.path}` : null,
    model.checkpoint ? `file: ${model.checkpoint}` : null,
    model.reason || null,
  ]
    .filter(Boolean)
    .join('\n');

const CHIP = 'max-w-full truncate rounded border px-1 py-px text-xs font-bold';

/** A provider card: name + state, one-line summary, fix buttons + model chips. */
export const ModelProviderCard: React.FC<{ provider: ProviderStatus; onFixed: () => void }> = ({ provider, onFixed }) => {
  const isSuno = provider.id === 'suno';
  const isLyria = provider.id === 'lyria';
  const isMagenta = provider.id === 'magenta';
  const models = provider.models ?? [];
  // Every option is shown. This used to slice to three, which permanently hid
  // at least one Stable Audio model behind a "+N" chip — and with it that
  // model's download button, the only way to get the thing.
  const visible = [...models].sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)));
  // Stable Audio "download" chips become live download triggers. The dock owns
  // all progress/error state — these chips only fire the request and read job
  // status for a compact in-place indicator.
  const downloadJobs = useDownloadStore((s) => s.jobs);
  const startDownload = useDownloadStore((s) => s.startDownload);
  const gpu = provider.magenta?.gpu;
  const hover = [
    provider.summary,
    gpu?.gpus?.length ? `GPU: ${gpu.gpus.map((g) => `${g.name} · ${g.vram_gb} GB`).join(', ')}` : null,
    provider.location ? `location: ${provider.location}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <article className={`${CARD} min-w-0 px-2 py-1.5 flex flex-col gap-1`} aria-label={`${provider.label} provider`}>
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-xs font-bold text-zinc-100 truncate flex-1 min-w-0" title={hover}>{provider.label}</span>
        {provider.state === 'starting' && <Loader2 className="w-3 h-3 animate-spin text-sky-300 shrink-0" aria-label="Starting" />}
        <span className={`shrink-0 rounded border px-1 py-px text-xs font-bold uppercase tracking-wide ${modelStateClass(provider.state)}`}>
          {MODEL_STATE_LABELS[provider.state] ?? provider.state}
        </span>
      </div>
      {/* One line, full text on hover: a state that needs setup still SAYS so
          on sight, without a three-line paragraph per card. */}
      {provider.summary && (
        <p className="text-xs font-bold leading-snug text-zinc-400 truncate" title={provider.summary}>{provider.summary}</p>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <ProviderFixButtons provider={provider} onFixed={onFixed} />
        {isMagenta ? (
          <MagentaModelChips provider={provider} onFixed={onFixed} />
        ) : isSuno ? null : (
          visible.map((model) => {
            const isDownloadable = provider.id === 'stable' && model.source === 'download';
            if (isDownloadable) {
              const job = downloadJobs.find((j) => (j.kind ?? 'model') === 'model' && j.name === model.id);
              const downloading = job?.status === 'downloading' || job?.status === 'queued';
              return (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => void startDownload(model.id)}
                  disabled={downloading}
                  aria-label={`Download ${model.label} model`}
                  title={modelTooltip(model)}
                  className={`inline-flex items-center gap-1 ${CHIP} transition-colors ${modelSourceClass(model.source)} hover:bg-purple-500/15 hover:border-purple-400/50 hover:text-purple-100 disabled:cursor-default disabled:opacity-80`}
                >
                  {downloading ? <Loader2 className="w-2.5 h-2.5 animate-spin shrink-0" /> : <Download className="w-2.5 h-2.5 shrink-0" />}
                  <span className="truncate">{model.recommended ? '★ ' : ''}{model.label}</span>
                </button>
              );
            }
            return (
              <span key={model.id} title={modelTooltip(model)} className={`${CHIP} ${modelSourceClass(model.source)}`}>
                {model.recommended ? '★ ' : ''}{model.label}
              </span>
            );
          })
        )}
      </div>
      {isSuno && <SunoKeyInput />}
      {isLyria && <LyriaKeyLists onSaved={onFixed} />}
    </article>
  );
};

/* ── fix buttons ─────────────────────────────────────────────────────────── */

interface ProviderFix {
  key: string;
  label: string;
  title: string;
  /** Runs pip/npm/an engine start and can take minutes — the button says so. */
  slow?: boolean;
  tone?: 'amber' | 'sky' | 'rose' | 'ghost';
  run: (progress: (msg: string) => void) => Promise<unknown>;
}

const TONE: Record<NonNullable<ProviderFix['tone']>, string> = {
  amber: BTN_AMBER,
  sky: BTN_SKY,
  rose: BTN_ROSE,
  ghost: BTN_GHOST,
};

const restartEngine = async () => {
  if (!(await restartMagentaEngine())) throw new Error('Not restarted — see the card at the bottom right.');
};

/**
 * The actions that clear a provider's blocked state, in the order they
 * should read. Providers whose setup has no API behind it get NO button: an
 * honest summary beats a control that cannot deliver.
 */
const providerFixes = (p: ProviderStatus): ProviderFix[] => {
  const fixes: ProviderFix[] = [];
  const { id, state } = p;
  if (id === 'stable' && state === 'download_blocked') {
    fixes.push({
      key: 'allow',
      label: 'Allow downloads',
      title: 'Turn off local-only so missing Stable Audio models can download on first use.',
      run: () => setLocalOnly(false),
    });
  }
  if (id === 'magenta') {
    const es = p.engine_state ?? (state === 'needs_setup' ? 'not_installed' : state === 'ready' ? 'not_running' : undefined);
    if (es === 'not_installed') {
      fixes.push({
        key: 'install',
        label: 'Install',
        title: 'Install the Magenta RT2 engine. It opens its own window, checks the PC, says how large the downloads are, and asks before installing anything.',
        run: () => installMagentaEngine(),
      });
    } else if (es === 'not_running') {
      fixes.push({
        key: 'start',
        label: 'Start engine',
        title: 'Start the Magenta engine now (about 2-3 minutes; the first start compiles once). Stable Audio parks in RAM to free the GPU. It also starts on its own at the first Magenta action.',
        slow: true,
        run: async () => {
          if (!(await ensureMagentaEngine())) throw new Error('Not started — see the card at the bottom right.');
        },
      });
    } else if (es === 'running') {
      if (p.magenta?.restart_required) {
        fixes.push({
          key: 'restart',
          label: `Restart with ${p.magenta.active_model}`,
          title: `The engine is serving ${p.magenta.running_model}. Restart it to load ${p.magenta.active_model} (about 2-3 minutes).`,
          slow: true,
          tone: 'sky',
          run: restartEngine,
        });
      }
      fixes.push({
        key: 'stop',
        label: 'Stop engine',
        title: 'Stop the Magenta engine and give the GPU back to Stable Audio.',
        tone: 'ghost',
        run: () => stopMagentaEngine(),
      });
    } else if (es === 'error') {
      fixes.push({
        key: 'restart',
        label: 'Restart engine',
        title: 'The engine is up but its model failed to load. Restart it (or pick another model below).',
        slow: true,
        tone: 'rose',
        run: restartEngine,
      });
    } else if (es === 'probe_failed') {
      fixes.push({
        key: 'recheck',
        label: 'Retry check',
        title: 'The install check did not answer (WSL may have been starting). Ask again.',
        run: async () => {
          const s = await fetchMagentaEngineStatus({ refresh: true });
          if (!s || s.state === 'probe_failed') throw new Error(s?.setup?.probe_error || 'Still no answer from WSL.');
        },
      });
    }
  }
  if (id === 'demucs' && state === 'needs_setup') {
    fixes.push({
      key: 'install',
      label: 'Install dependencies',
      title: 'Install the stem-separation dependencies into the sidecar.',
      slow: true,
      run: () => postFix('/api/stems/install'),
    });
  }
  if (id === 'demucs' && state === 'ready') {
    fixes.push({
      key: 'start',
      label: 'Start sidecar',
      title: 'Start the stem-separation sidecar now.',
      run: () => postFix('/api/stems/start'),
    });
  }
  if (id === 'midi' && state === 'needs_setup') {
    fixes.push({
      key: 'install',
      label: 'Install Basic Pitch',
      title: 'Install the Basic Pitch engine so audio can be converted to MIDI.',
      slow: true,
      run: () => postFix('/api/midi/install?engine=basic_pitch'),
    });
  }
  if (id === 'lyria' && state === 'needs_setup' && p.lyria?.installable && !p.lyria.installing) {
    const ly = p.lyria;
    const needsClone = ly.missing.includes('project');
    fixes.push({
      key: 'install',
      label: needsClone ? 'Install' : 'Install dependencies',
      title: needsClone
        ? `Clone ${ly.repo} into ${ly.project_path} (git) and run its npm install. Output goes to data/logs/lyria-sidecar.log.`
        : `Run npm install in ${ly.project_path}. Output goes to data/logs/lyria-sidecar.log.`,
      slow: true,
      run: async (progress) => {
        // The route is loopback/launch-token/pairing gated: a paired phone
        // gets through with its pairing header.
        await postFix('/api/lyria/install', { headers: pairingHeaderFor('/api/lyria/install') });
        const deadline = Date.now() + 20 * 60_000;
        while (Date.now() < deadline) {
          await sleep(2500);
          const s = (await fetch('/api/lyria/install/status').then((r) => r.json())) as {
            status: string;
            message?: string;
            error?: string | null;
          };
          if (s.status === 'done') return;
          if (s.status === 'error') throw new Error(s.error || 'Install failed.');
          progress(s.message || s.status);
        }
        throw new Error('Still installing — check back in a minute.');
      },
    });
  }
  return fixes;
};

const ProviderFixButtons: React.FC<{ provider: ProviderStatus; onFixed: () => void }> = ({ provider, onFixed }) => {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fixes = providerFixes(provider);
  if (fixes.length === 0) return null;

  const run = async (fix: ProviderFix) => {
    setBusyKey(fix.key);
    setError(null);
    setProgress(fix.slow ? 'This can take a few minutes.' : null);
    try {
      await fix.run((msg) => setProgress(msg));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusyKey(null);
      setProgress(null);
      // Re-probe even after a failure: the slow installs are synchronous and
      // can outlive the request, so the response is not the source of truth
      // about whether the thing is now installed. The probe is.
      onFixed();
    }
  };

  return (
    <>
      {fixes.map((fix) => {
        const busy = busyKey === fix.key;
        return (
          <button
            key={fix.key}
            type="button"
            onClick={() => void run(fix)}
            disabled={busyKey !== null}
            title={fix.title}
            className={TONE[fix.tone ?? 'amber']}
          >
            {busy && <Loader2 className="w-2.5 h-2.5 animate-spin shrink-0" />}
            {busy ? 'Working' : fix.label}
          </button>
        );
      })}
      {progress && busyKey && (
        <span className="basis-full truncate text-xs font-bold text-zinc-400" title={progress}>{progress}</span>
      )}
      {error && (
        <p role="alert" className="basis-full truncate text-xs font-bold text-rose-300" title={error}>{error}</p>
      )}
    </>
  );
};

/* ── Magenta model chips: the real list, selectable, downloadable ────────── */

const runnableClass = (m: ModelOption) => {
  if (m.runnable === 'no') return ROSE;
  if (m.runnable === 'tight') return AMBER;
  return m.installed ? EMERALD : ZINC;
};

const MagentaModelChips: React.FC<{ provider: ProviderStatus; onFixed: () => void }> = ({ provider, onFixed }) => {
  const models = provider.models ?? [];
  const jobs = useDownloadStore((s) => s.jobs);
  const startDownload = useDownloadStore((s) => s.startDownload);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = provider.magenta?.running_model;

  const select = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await setMagentaModel(id);
      onFixed();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not pick that model.');
    } finally {
      setBusy(null);
    }
  };
  const download = async (id: string) => {
    setError(null);
    try {
      await startDownload(id, 'magenta');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download did not start.');
    }
  };

  return (
    <>
      {models.map((m) => {
        const job = jobs.find((j) => j.kind === 'magenta' && j.name === m.id);
        const downloading = job?.status === 'downloading';
        const tip = modelTooltip(m);
        if (!m.installed) {
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => void download(m.id)}
              disabled={downloading}
              aria-label={`Download ${m.label} checkpoint`}
              title={`Download ${m.checkpoint ?? m.id} into the sidecar (WSL) with its own CLI.\n${tip}`}
              className={`inline-flex items-center gap-1 ${CHIP} transition-colors ${runnableClass(m)} hover:bg-purple-500/15 hover:border-purple-400/50 hover:text-purple-100 disabled:cursor-default disabled:opacity-80`}
            >
              {downloading ? <Loader2 className="w-2.5 h-2.5 animate-spin shrink-0" /> : <Download className="w-2.5 h-2.5 shrink-0" />}
              <span className="truncate">
                {m.label}
                {downloading && typeof job?.percent === 'number' && job.percent > 0 ? ` · ${job.percent}%` : ''}
              </span>
            </button>
          );
        }
        if (m.active) {
          return (
            <span key={m.id} title={`In use for the next engine start.\n${tip}`} className={`${CHIP} ${runnableClass(m)}`}>
              ★ {m.label}
              {running === m.id ? ' · running' : ''}
            </span>
          );
        }
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => void select(m.id)}
            disabled={busy !== null}
            aria-label={`Use ${m.label} as the Magenta engine model`}
            title={`Use ${m.label} for the next engine start.\n${tip}`}
            className={`inline-flex items-center gap-1 ${CHIP} transition-colors ${runnableClass(m)} hover:bg-purple-500/15 hover:border-purple-400/50 hover:text-purple-100`}
          >
            {busy === m.id && <Loader2 className="w-2.5 h-2.5 animate-spin shrink-0" />}
            <span className="truncate">Use {m.label}{running === m.id ? ' · running' : ''}</span>
          </button>
        );
      })}
      {error && (
        <p role="alert" className="basis-full truncate text-xs font-bold text-rose-300" title={error}>{error}</p>
      )}
    </>
  );
};

/* ── API-key fields ──────────────────────────────────────────────────────── */

/** Inline Suno API-key field, rendered inside the Suno provider card. */
const SunoKeyInput: React.FC = () => {
  const [configured, setConfigured] = useState(false);
  const [keyPrefix, setKeyPrefix] = useState<string | null>(null);
  const [val, setVal] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const refresh = React.useCallback(async () => {
    try {
      const r = await fetch('/api/suno/status');
      const d = await r.json();
      setConfigured(!!d.configured);
      setKeyPrefix(d.key_prefix ?? null);
    } catch {
      setConfigured(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const save = async () => {
    if (!val.trim()) return;
    setBusy(true);
    setSaved(false);
    try {
      const r = await fetch('/api/suno/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: val.trim() }),
      });
      if (r.ok) {
        setVal('');
        setSaved(true);
        await refresh();
        void useSunoStore.getState().checkStatus();
        window.setTimeout(() => setSaved(false), 2000);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-wrap items-center gap-1" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {/* Visible, not sr-only: this was an unlabelled box you had to recognise
          by its placeholder, and the placeholder disappears the moment a key is
          configured. The key glyph says what goes in it, in every state. */}
      <SecretFieldLabel
        htmlFor="settings-suno-api-key"
        className={`shrink-0 ${FIELD_LABEL}`}
        title="Suno API key — saved to the backend; cloud generation reconnects on save."
      >
        API key
      </SecretFieldLabel>
      <div className="relative flex-1 min-w-0">
        <input
          id="settings-suno-api-key"
          name="settings-suno-api-key"
          type={show ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder={configured ? `Connected · ${keyPrefix ?? ''} — paste to replace` : 'sk_live_…  (platform.suno.com)'}
          title="Suno API key — saved to the backend; cloud generation reconnects on save."
          className={`${INPUT} w-full pr-6`}
        />
        <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide key' : 'Show key'} aria-pressed={show}
          className="absolute right-1 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300">
          {show ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
        </button>
      </div>
      <button type="submit" disabled={busy || !val.trim()} title="Save the key to the backend and reconnect cloud generation" className={BTN_PURPLE}>
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : saved ? <CheckCircle2 className="w-3 h-3" /> : 'Save'}
      </button>
    </form>
  );
};

/** Counts and sources for one provider. The backend never sends key values. */
interface LyriaProviderKeys {
  /** Keys theDAW holds for the sidecar, de-duplicated across the sources. */
  count: number;
  /** How many of them this Lyria checkout receives: one for a checkout that
   *  reads a single key per provider, up to ten for one with server/keys.ts. */
  handed?: number;
  source: string;
  configured: boolean;
  /** Keys from the OS environment — removed where they were set, not here. */
  env: number;
  /** Keys saved through this panel: the ones a position can be removed by. */
  stored: number;
  /** Keys from the assistant's key pool that go to the sidecar. */
  pool: number;
  /** Every key the assistant's key pool holds for this provider. */
  pool_available?: number;
}

interface LyriaKeySummary {
  providers: Record<LyriaProvider, LyriaProviderKeys>;
  provider_preference: LyriaProvider | null;
  /** The "use the assistant's key pool too" switch. */
  share_pool?: boolean;
  /** True when the checkout takes a key list and fails over between keys. */
  reads_key_lists?: boolean;
  mock?: boolean;
  /** A Lyria this backend did not start still serves the port with its old
   *  keys (only on answers to a change). */
  external_running?: boolean;
}

const LYRIA_PROVIDER_LABEL: Record<LyriaProvider, string> = {
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
};

const LYRIA_PROVIDER_HINT: Record<LyriaProvider, string> = {
  gemini: 'GEMINI_API_KEY (aistudio.google.com)',
  openrouter: 'OPENROUTER_API_KEY (openrouter.ai/keys)',
};

export const lyriaKeyCounts = (p: LyriaProviderKeys | undefined): string => {
  if (!p || p.count === 0) return 'no keys';
  const parts = [
    p.env ? `${p.env} from the environment` : null,
    p.stored ? `${p.stored} saved here` : null,
    p.pool ? `${p.pool} from the key pool` : null,
  ].filter(Boolean);
  const handed =
    typeof p.handed === 'number' && p.handed < p.count
      ? ` · Lyria uses the first ${p.handed === 1 ? 'one' : p.handed}`
      : '';
  return `${p.count} key${p.count === 1 ? '' : 's'} · ${parts.join(' · ')}${handed}`;
};

/** One provider's ordered key list: count + source, add, remove by position. */
const LyriaProviderKeyList: React.FC<{
  provider: LyriaProvider;
  keys: LyriaProviderKeys | undefined;
  busy: boolean;
  /** Resolves true once saved; false when refused, with the reason already
   *  shown in the card's alert line. Never rejects. */
  onAdd: (provider: LyriaProvider, key: string) => Promise<boolean>;
  onRemove: (provider: LyriaProvider, index: number) => Promise<boolean>;
}> = ({ provider, keys, busy, onAdd, onRemove }) => {
  const [val, setVal] = useState('');
  const [show, setShow] = useState(false);
  const id = `settings-lyria-${provider}-key`;
  const label = LYRIA_PROVIDER_LABEL[provider];
  const title = `Keys theDAW hands the Lyria sidecar for ${label}, in the order it tries them: the environment's first, then the ones saved here, then the assistant's key pool when it is shared. A running Lyria restarts to pick them up.`;
  return (
    <form
      className="flex flex-wrap items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (!val.trim()) return;
        // A refused key keeps what was typed, so it can be corrected.
        void onAdd(provider, val.trim()).then((saved) => {
          if (saved) setVal('');
        });
      }}
    >
      <SecretFieldLabel htmlFor={id} className={`shrink-0 ${FIELD_LABEL_12}`} title={title}>
        {label}
      </SecretFieldLabel>
      <div className="relative flex-1 min-w-0">
        <input
          id={id}
          name={id}
          type={show ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder={`Add a ${label} key — ${LYRIA_PROVIDER_HINT[provider]}`}
          title={title}
          className={`${INPUT} w-full pr-6`}
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? `Hide the ${label} key being typed` : `Show the ${label} key being typed`}
          aria-pressed={show}
          className="absolute right-1 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
        >
          {show ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
        </button>
      </div>
      <button type="submit" disabled={busy || !val.trim()} title={`Add this ${label} key to the end of the list`} className={BTN_PURPLE_12}>
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Add'}
      </button>
      <span
        data-lyria-key-count={provider}
        className="basis-full truncate text-xs font-bold text-zinc-400"
        title={`${label}: ${lyriaKeyCounts(keys)}`}
      >
        {lyriaKeyCounts(keys)}
        {keys?.configured ? ` · first from ${keys.source}` : ''}
      </span>
      {Array.from({ length: keys?.stored ?? 0 }, (_, i) => (
        <button
          key={i}
          type="button"
          onClick={() => void onRemove(provider, i)}
          disabled={busy}
          aria-label={`Forget saved ${label} key ${i + 1}`}
          title={`Forget saved ${label} key ${i + 1} (position ${i + 1} of the keys saved here)`}
          className={BTN_GHOST_12}
        >
          <Trash2 className="w-3 h-3" />
          {`#${i + 1}`}
        </button>
      ))}
    </form>
  );
};

/**
 * The keys theDAW hands the Lyria sidecar: an ordered list per provider, which
 * provider the child should default to, and whether the assistant's key pool
 * goes to it as well.
 *
 * Two lists rather than one Gemini box because a checkout with server/keys.ts
 * fails over between keys and between providers, and Google's free tier grants
 * zero Lyria requests a day — a Gemini key alone often cannot generate at all,
 * while an OpenRouter key can. Counts and sources only: the backend never sends
 * a key value back, so none can be rendered.
 */
export const LyriaKeyLists: React.FC<{ onSaved: () => void }> = ({ onSaved }) => {
  const [summary, setSummary] = useState<LyriaKeySummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [externalRunning, setExternalRunning] = useState(false);

  const refresh = React.useCallback(async () => {
    try {
      const r = await fetch('/api/lyria/keys');
      if (r.ok) setSummary((await r.json()) as LyriaKeySummary);
    } catch {
      setSummary(null);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  /** One change. Resolves true on success; on a refusal it shows the
   *  backend's reason in the alert line and resolves false. Never rejects, so
   *  no caller can leave a rejection unhandled. */
  const send = async (url: string, method: string, body: unknown): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...pairingHeaderFor(url) },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const detail = await r.json().then((j) => j?.detail).catch(() => null);
        throw new Error(typeof detail === 'string' ? detail : `HTTP ${r.status}`);
      }
      const next = (await r.json()) as LyriaKeySummary;
      setSummary(next);
      setExternalRunning(Boolean(next.external_running));
      onSaved();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = (provider: LyriaProvider, key: string) => send('/api/lyria/keys', 'POST', { provider, key });
  const remove = (provider: LyriaProvider, index: number) => send('/api/lyria/keys', 'DELETE', { provider, index });
  const choose = (value: string) => send('/api/lyria/keys/provider', 'POST', { provider: value });
  const share = summary?.share_pool ?? false;
  const pooled = (summary?.providers?.gemini?.pool_available ?? 0) + (summary?.providers?.openrouter?.pool_available ?? 0);
  const shareLabel = 'Use the assistant’s key pool too';

  return (
    <div className="flex flex-col gap-1">
      {(['gemini', 'openrouter'] as LyriaProvider[]).map((provider) => (
        <LyriaProviderKeyList
          key={provider}
          provider={provider}
          keys={summary?.providers?.[provider]}
          busy={busy}
          onAdd={add}
          onRemove={remove}
        />
      ))}
      <div className="flex flex-wrap items-center gap-1">
        <label htmlFor="settings-lyria-provider" className={`shrink-0 ${FIELD_LABEL_12}`}>
          Provider
        </label>
        <select
          id="settings-lyria-provider"
          name="settings-lyria-provider"
          value={summary?.provider_preference ?? ''}
          disabled={busy}
          onChange={(e) => void choose(e.target.value)}
          title="Which provider the Lyria sidecar starts on. Let Lyria decide picks the only provider with keys, and otherwise leaves the app's own default alone."
          className={SELECT}
        >
          <option value="">Let Lyria decide</option>
          <option value="gemini">Gemini</option>
          <option value="openrouter">OpenRouter</option>
        </select>
      </div>
      {/* Off by default: the pool holds keys pasted for the assistant, and the
          sidecar gets them (every Gemini, OpenRouter and OpenRouter free key)
          only once the user says so here. */}
      <button
        type="button"
        onClick={() => void send('/api/lyria/keys/pool', 'POST', { share: !share })}
        disabled={busy || summary === null}
        aria-pressed={share}
        aria-label={shareLabel}
        title={
          share
            ? 'Lyria gets every key in the assistant’s key pool (Gemini, OpenRouter, OpenRouter free) after the keys above. Press to stop sharing them.'
            : 'Hand Lyria every key in the assistant’s key pool (Gemini, OpenRouter, OpenRouter free) after the keys above. Off, it gets the keys above and, when there is no Gemini key above, the pool’s first Gemini key.'
        }
        className="inline-flex items-center gap-1.5 self-start rounded disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-purple-400/70"
      >
        {share ? <ToggleRight className="w-5 h-5 text-purple-400" /> : <ToggleLeft className="w-5 h-5 text-zinc-500" />}
        <span className={`text-xs font-bold ${share ? 'text-purple-200' : 'text-zinc-300'}`}>
          {shareLabel}
          {pooled ? ` (${pooled} key${pooled === 1 ? '' : 's'})` : ''}
        </span>
      </button>
      <p className="text-xs font-bold leading-snug text-zinc-400">
        {summary?.reads_key_lists === false
          ? 'This Lyria checkout reads one key per provider, so it uses the first key of each list.'
          : 'Keys are tried in order and a rejected key is skipped for the next.'}
      </p>
      {externalRunning && (
        <p role="status" className="text-xs font-bold leading-snug text-amber-200">
          A Lyria started outside this session is still running with its old keys. Press Restart in the Lyria tab to hand it
          these.
        </p>
      )}
      {error && <p role="alert" className="truncate text-xs font-bold text-rose-300" title={error}>{error}</p>}
    </div>
  );
};
