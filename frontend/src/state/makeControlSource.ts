/**
 * MAKE control source for the XR control bus.
 *
 * Mirrors xrControlDjSource: publishes MAKE_TARGETS as manifest entries and
 * routes an inbound control-set straight to each target's wired `invoke`, so the
 * MAKE surface is bidirectional on XR exactly like DJ, with no per-control code.
 * makeTargets (and through it makeBridge) is imported lazily so it stays out of
 * app boot.
 *
 * Beyond the Magenta live params, the source exposes the FULL SA3 CREATE
 * surface so a headset can run MAKE end to end without the desktop UI:
 *
 *   Make (Create):  make.prompt (text), make.model (select, options populated
 *   with the same built-ins + registered local checkpoints as the desktop
 *   picker), make.duration (fader), make.generate (button — desktop CREATE
 *   toggle semantics: idle starts a run, generating cancels the watch), and
 *   make.generating (readonly toggle mirroring generateStore.isGenerating).
 *
 *   Make (Chimera): stack a mashup from recent library takes using only
 *   existing widget kinds — make.chimera.pick (select of recent takes) +
 *   make.chimera.add / make.chimera.clear (buttons), make.chimera.bpmAuto
 *   (toggle) + make.chimera.bpm (fader), make.chimera.align (select), and a
 *   readonly make.chimera.status text.
 *
 * These live HERE, not in MAKE_TARGETS, on purpose: MAKE_TARGETS also feeds
 * Sway gesture routing, and a gesture-bindable generation trigger or stack
 * mutation would fire expensive jobs by accident.
 */
import { publishControlChanged } from './xrControlClient';
import type { XrControlSource, XrManifestEntry, XrControlValue } from './xrControlClient';
import type { BindableTarget } from '../components/surface/widgetTypes';

let cache: BindableTarget[] | null = null;

async function targets(): Promise<BindableTarget[]> {
  if (!cache) {
    const mod = await import('./makeTargets');
    cache = mod.MAKE_TARGETS;
  }
  return cache;
}

const CREATE_GROUP = 'Make (Create)';
const CHIMERA_GROUP = 'Make (Chimera)';

/** Same built-ins as the desktop picker (AdvancedGenPanel); suno is excluded
 *  because it routes to its own cloud panel, not the job API. */
const MODEL_LABELS: Array<[id: string, label: string]> = [
  ['small', 'Small (ARC)'],
  ['medium', 'Medium (ARC)'],
  ['small-rf', 'Small-RF'],
  ['medium-rf', 'Medium-RF'],
  ['magenta-small', 'Magenta RT2'],
];

const ALIGN_MODES = ['start', 'downbeat', 'weave'] as const;

/** Lazy like makeTargets: these pull the whole CREATE/library flow, which has
 *  no business in app boot just because the control source is registered. */
async function generate() {
  return import('./generateStore');
}
async function params() {
  return import('./generateParamsStore');
}
async function library() {
  return import('./libraryStore');
}

// ── Module state rebuilt on every manifest build ────────────────────────────
/** Model option label -> model id (locals resolve dynamically). */
let modelByLabel = new Map<string, string>();
/** Local checkpoint id -> ckpt_path/name, for the RF sampler-default rule. */
let localPaths = new Map<string, string>();
/** Chimera pick option label -> library entry id. */
let pickByLabel = new Map<string, string>();
/** The controller's current chimera pick (entry id), consumed by .add. */
let pendingPickId: string | null = null;
let pendingPickLabel = '';
/** Last numeric BPM so toggling auto off restores something sensible. */
let lastNumericBpm = 120;

function modelLabelFor(id: string): string {
  for (const [mid, label] of MODEL_LABELS) if (mid === id) return label;
  for (const [label, mid] of modelByLabel) if (mid === id) return label;
  return id;
}

async function fetchLocalCheckpoints(): Promise<Array<{ id: string; name: string; ckptPath: string }>> {
  try {
    const r = await fetch('/api/storage/checkpoints');
    if (!r.ok) return [];
    const j = (await r.json()) as {
      registered?: Array<{ id?: string; name?: string; resolves?: boolean; ckpt_path?: string }>;
    };
    return (j.registered ?? [])
      .filter((c) => c.resolves && c.id)
      .map((c) => ({
        id: c.id as string,
        name: c.name || (c.id as string),
        ckptPath: c.ckpt_path || '',
      }));
  } catch {
    return [];
  }
}

/** Recent audio takes for the chimera pick select. Labels are de-duplicated
 *  by suffixing a counter so the option string maps back to exactly one id. */
async function recentTakeOptions(): Promise<string[]> {
  const { useLibraryStore } = await library();
  const lib = useLibraryStore.getState();
  if (!lib.loaded && !lib.loading) await lib.load();
  const entries = useLibraryStore.getState().entries
    .filter((e) => (e.kind ?? 'audio') === 'audio')
    .slice(0, 12);
  pickByLabel = new Map();
  const options: string[] = [];
  for (const e of entries) {
    let label = e.title || e.id;
    let n = 2;
    while (pickByLabel.has(label)) label = `${e.title || e.id} ·${n++}`;
    pickByLabel.set(label, e.id);
    options.push(label);
  }
  return options;
}

let watching = false;

/** Mirror host-side state to controllers once (first manifest build):
 *  isGenerating, plus the CREATE fields (prompt/model/duration) and chimera
 *  params, so a headset stays in sync with edits made ANYWHERE — desktop UI,
 *  assistant, orb, or another remote. */
async function watchHostState(): Promise<void> {
  if (watching) return;
  watching = true;
  const { useGenerateStore } = await generate();
  const { useGenerateParamsStore } = await params();

  let prevGen = useGenerateStore.getState().isGenerating;
  useGenerateStore.subscribe((s) => {
    if (s.isGenerating !== prevGen) {
      prevGen = s.isGenerating;
      publishControlChanged('make.generating', s.isGenerating);
    }
  });

  let p = useGenerateParamsStore.getState();
  let prevPrompt = p.prompt;
  let prevModel = p.model;
  let prevDuration = p.duration;
  let prevChimera = p.chimera;
  useGenerateParamsStore.subscribe((s) => {
    if (s.prompt !== prevPrompt) {
      prevPrompt = s.prompt;
      publishControlChanged('make.prompt', s.prompt);
    }
    if (s.model !== prevModel) {
      prevModel = s.model;
      publishControlChanged('make.model', modelLabelFor(s.model));
    }
    if (s.duration !== prevDuration) {
      prevDuration = s.duration;
      publishControlChanged('make.duration', s.duration);
    }
    if (s.chimera !== prevChimera) {
      const prev = prevChimera;
      prevChimera = s.chimera;
      if (s.chimera.clips.length !== prev.clips.length) {
        publishControlChanged('make.chimera.status', chimeraStatus(s.chimera.clips.length));
      }
      if (s.chimera.targetBpm !== prev.targetBpm) {
        publishControlChanged('make.chimera.bpmAuto', s.chimera.targetBpm === 'auto');
        if (typeof s.chimera.targetBpm === 'number') {
          lastNumericBpm = s.chimera.targetBpm;
          publishControlChanged('make.chimera.bpm', s.chimera.targetBpm);
        }
      }
      if (s.chimera.alignMode !== prev.alignMode) {
        publishControlChanged('make.chimera.align', s.chimera.alignMode);
      }
    }
  });
}

function chimeraStatus(count: number): string {
  if (count === 0) return 'empty';
  if (count === 1) return '1 clip — add one more to arm';
  return `${count} clips — armed (CREATE weaves them)`;
}

function toKind(k: BindableTarget['kind']): string {
  if (k === 'pad') return 'button';
  if (k === 'crossfader') return 'fader';
  return k; // knob | fader | toggle
}

export const makeControlSource: XrControlSource = {
  area: 'make',

  async buildEntries(): Promise<XrManifestEntry[]> {
    const list = await targets();
    void watchHostState();
    const { useGenerateStore } = await generate();
    const { useGenerateParamsStore } = await params();
    const p = useGenerateParamsStore.getState();

    // Model options: fixed built-ins + live local checkpoints, exactly like
    // the desktop picker. Rebuilt every manifest so new registrations appear.
    const locals = await fetchLocalCheckpoints();
    modelByLabel = new Map(MODEL_LABELS.map(([id, label]) => [label, id]));
    localPaths = new Map();
    for (const c of locals) {
      let label = `${c.name} (local)`;
      let n = 2;
      while (modelByLabel.has(label)) label = `${c.name} (local ·${n++})`;
      modelByLabel.set(label, c.id);
      localPaths.set(c.id, c.ckptPath || c.name);
    }
    const takeOptions = await recentTakeOptions();
    if (pendingPickId && !Array.from(pickByLabel.values()).includes(pendingPickId)) {
      pendingPickId = null;
      pendingPickLabel = '';
    }
    if (typeof p.chimera.targetBpm === 'number') lastNumericBpm = p.chimera.targetBpm;

    const entries: XrManifestEntry[] = list.map((t) => ({
      id: t.id,
      area: 'make',
      group: t.group,
      label: t.label,
      kind: toKind(t.kind),
      min: t.min,
      max: t.max,
      step: t.step,
      unit: t.unit,
    }));

    entries.push(
      {
        id: 'make.prompt',
        area: 'make',
        group: CREATE_GROUP,
        label: 'Prompt',
        kind: 'text',
        value: p.prompt,
      },
      {
        id: 'make.model',
        area: 'make',
        group: CREATE_GROUP,
        label: 'Model',
        kind: 'select',
        options: Array.from(modelByLabel.keys()),
        value: modelLabelFor(p.model),
      },
      {
        id: 'make.duration',
        area: 'make',
        group: CREATE_GROUP,
        label: 'Length',
        kind: 'fader',
        min: 5,
        max: 512,
        step: 1,
        unit: 's',
        value: p.duration,
      },
      {
        id: 'make.generate',
        area: 'make',
        group: CREATE_GROUP,
        label: 'Create',
        kind: 'button',
      },
      {
        id: 'make.generating',
        area: 'make',
        group: CREATE_GROUP,
        label: 'Generating',
        kind: 'toggle',
        value: useGenerateStore.getState().isGenerating,
        readonly: true,
      },
      {
        id: 'make.chimera.status',
        area: 'make',
        group: CHIMERA_GROUP,
        label: 'Stack',
        kind: 'text',
        value: chimeraStatus(p.chimera.clips.length),
        readonly: true,
      },
      {
        id: 'make.chimera.pick',
        area: 'make',
        group: CHIMERA_GROUP,
        label: 'Take',
        kind: 'select',
        options: takeOptions,
        value: pendingPickLabel,
      },
      {
        id: 'make.chimera.add',
        area: 'make',
        group: CHIMERA_GROUP,
        label: 'Add To Stack',
        kind: 'button',
      },
      {
        id: 'make.chimera.clear',
        area: 'make',
        group: CHIMERA_GROUP,
        label: 'Clear Stack',
        kind: 'button',
      },
      {
        id: 'make.chimera.bpmAuto',
        area: 'make',
        group: CHIMERA_GROUP,
        label: 'BPM Auto',
        kind: 'toggle',
        value: p.chimera.targetBpm === 'auto',
      },
      {
        id: 'make.chimera.bpm',
        area: 'make',
        group: CHIMERA_GROUP,
        label: 'Target BPM',
        kind: 'fader',
        min: 60,
        max: 200,
        step: 1,
        value: typeof p.chimera.targetBpm === 'number' ? p.chimera.targetBpm : lastNumericBpm,
      },
      {
        id: 'make.chimera.align',
        area: 'make',
        group: CHIMERA_GROUP,
        label: 'Align',
        kind: 'select',
        options: [...ALIGN_MODES],
        value: p.chimera.alignMode,
      },
    );
    return entries;
  },

  async apply(id: string, value: XrControlValue): Promise<boolean> {
    if (id === 'make.generating' || id === 'make.chimera.status') {
      // Readonly. A generic controller may still send a set with an
      // optimistic local echo; re-publish the REAL value so that echo
      // corrects in one frame instead of sticking on a phantom state.
      if (id === 'make.generating') {
        const { useGenerateStore } = await generate();
        publishControlChanged('make.generating', useGenerateStore.getState().isGenerating);
      } else {
        const { useGenerateParamsStore } = await params();
        publishControlChanged(
          'make.chimera.status',
          chimeraStatus(useGenerateParamsStore.getState().chimera.clips.length),
        );
      }
      return false;
    }

    if (id === 'make.generate') {
      if (!value) return true; // button release / falsy — ignore
      const { useGenerateStore, buildGenerateParamsFromState } = await generate();
      const { useGenerateParamsStore } = await params();
      const gen = useGenerateStore.getState();
      // Same toggle contract as the desktop CREATE button: a press while a
      // run is live cancels the watch instead of stacking another job.
      if (gen.isGenerating) {
        gen.cancelPolling();
        return true;
      }
      void gen.submitGeneration(buildGenerateParamsFromState(useGenerateParamsStore.getState()));
      return true;
    }

    if (id === 'make.prompt') {
      const { useGenerateParamsStore } = await params();
      useGenerateParamsStore.getState().patch({ prompt: String(value ?? '') });
      return true;
    }

    if (id === 'make.model') {
      const label = String(value ?? '');
      const modelId = modelByLabel.get(label) ?? (label && modelLabelFor(label) !== label ? label : null);
      if (!modelId) return false;
      const { useGenerateParamsStore } = await params();
      const prev = useGenerateParamsStore.getState().model;
      if (prev === modelId) return true;
      // Desktop-identical side effects (AdvancedGenPanel onChange): sampler
      // defaults follow the engine class, and the magenta/SA3 boundary swap
      // parks or restores the resident engine.
      const isMag = modelId.startsWith('magenta-');
      const isRf = modelId.endsWith('-rf')
        || /-rf\b|-rf[.-_]/i.test(localPaths.get(modelId) ?? '');
      useGenerateParamsStore.getState().patch({
        model: modelId,
        steps: isMag ? 1 : isRf ? 50 : 8,
        cfg: isMag ? 1.0 : isRf ? 7.0 : 1.0,
      });
      const { swapEngineForModel } = await import('../lib/magentaEngineClient');
      void swapEngineForModel(prev, modelId);
      return true;
    }

    if (id === 'make.duration') {
      const v = Number(value);
      if (!Number.isFinite(v)) return false;
      const { useGenerateParamsStore } = await params();
      useGenerateParamsStore.getState().patch({ duration: Math.min(512, Math.max(5, Math.round(v))) });
      return true;
    }

    if (id === 'make.chimera.pick') {
      const label = String(value ?? '');
      const entryId = pickByLabel.get(label);
      if (!entryId) return false;
      pendingPickId = entryId;
      pendingPickLabel = label;
      return true;
    }

    if (id === 'make.chimera.add') {
      if (!value) return true;
      if (!pendingPickId) return false;
      const { useLibraryStore } = await library();
      const entry = useLibraryStore.getState().entries.find((e) => e.id === pendingPickId);
      if (!entry) return false;
      // Same path as dropping a library take onto the desktop stack:
      // fetch the audio blob, then addBlobsToChimera kicks off analysis.
      const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
      const { addBlobsToChimera } = await import('../lib/chimeraClient');
      addBlobsToChimera([
        { blob, mimeType: blob.type || 'audio/wav', label: entry.title || entry.id, entryId: entry.id },
      ]);
      return true;
    }

    if (id === 'make.chimera.clear') {
      if (!value) return true;
      const { useGenerateParamsStore } = await params();
      useGenerateParamsStore.getState().setChimeraField('clips', []);
      return true;
    }

    if (id === 'make.chimera.bpmAuto') {
      const { useGenerateParamsStore } = await params();
      useGenerateParamsStore.getState().setChimeraField('targetBpm', value ? 'auto' : lastNumericBpm);
      return true;
    }

    if (id === 'make.chimera.bpm') {
      const v = Number(value);
      if (!Number.isFinite(v)) return false;
      lastNumericBpm = Math.min(200, Math.max(60, Math.round(v)));
      const { useGenerateParamsStore } = await params();
      useGenerateParamsStore.getState().setChimeraField('targetBpm', lastNumericBpm);
      return true;
    }

    if (id === 'make.chimera.align') {
      const mode = String(value ?? '');
      if (!(ALIGN_MODES as readonly string[]).includes(mode)) return false;
      const { useGenerateParamsStore } = await params();
      useGenerateParamsStore.getState().setChimeraField('alignMode', mode as (typeof ALIGN_MODES)[number]);
      return true;
    }

    const t = (await targets()).find((x) => x.id === id);
    if (!t) return false;
    if (t.kind === 'toggle') t.invoke(Boolean(value));
    else if (t.kind === 'pad') { if (value) t.invoke(true); return true; }
    else t.invoke(Number(value));
    return true;
  },
};
