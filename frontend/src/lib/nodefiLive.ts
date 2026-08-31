/**
 * Nodefi LIVE — real-time performance engine for the node graph.
 *
 * Compiles the graph's live-capable subgraph into a Web Audio graph and plays
 * it: stems / library tracks loop as buffer sources, Live FX (filter / VCA /
 * echo / crossfade) run as native AudioNodes, and LFO nodes drive mod-port
 * automation at audio rate — filter sweeps, gates, ducks, delay throws,
 * crossfade drifts. NO AI model is involved: the generate / magenta / effect /
 * merge / feedback / output kinds are simply inert here (they belong to the
 * offline Run path, which stays untouched).
 *
 * While live, inspector edits stream into the running graph via
 * `updateParams` (smoothed with setTargetAtTime) — tweak a filter, retime an
 * echo, re-shape an LFO mid-performance. Structural edits (add/remove/rewire)
 * require re-arming LIVE; the view stops the engine when it sees one.
 *
 * BPM comes from the Live Out node and feeds every synced LFO
 * (rate = bpm/60 ÷ beats-per-cycle; a bar is four beats).
 */
import { nodeDef, type GraphEdge, type GraphNode, type NodeKind, type NodeRunStatus } from './nodefiTypes';
import { useLibraryStore } from '../state/libraryStore';
import { getEngineCtx } from '../state/playerStore';
import {
  getRackEffect,
  rackEffectDefaults,
  ensureChopModule,
  ensureGranularModule,
  ensureSubharmonicModule,
} from './rackEffects';

export interface LiveCallbacks {
  onStatus: (nodeId: string, status: NodeRunStatus, message?: string) => void;
  onLog?: (msg: string) => void;
}

export interface LiveController {
  stop: () => void;
  /** Push a node's (possibly changed) params into the running graph. */
  updateParams: (node: GraphNode) => void;
}

const LIVE_KINDS: ReadonlySet<NodeKind> = new Set([
  'stem',
  'input',
  'lfilter',
  'lgain',
  'ldelay',
  'xfade',
  'lrack',
  'lfo',
  'lout',
]);

/** Kinds that only exist for the LIVE path (an `input` is shared with Run). */
export const isLiveOnlyKind = (k: NodeKind): boolean => LIVE_KINDS.has(k) && k !== 'input';

export const isLiveKind = (k: NodeKind): boolean => LIVE_KINDS.has(k);

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Beats per LFO cycle for each sync division (a bar is 4 beats). */
const SYNC_BEATS: Record<string, number> = {
  '1/16': 0.25,
  '1/8': 0.5,
  '1/4': 1,
  '1/2': 2,
  '1bar': 4,
  '2bar': 8,
  '4bar': 16,
};

const lfoRateHz = (params: Record<string, string | number>, bpm: number): number => {
  const sync = String(params.sync ?? 'free');
  const beats = SYNC_BEATS[sync];
  if (beats) return bpm / 60 / beats;
  return Math.max(0.01, num(params.rate, 0.5));
};

/** Fetch the audio blob for a stem node: a named demucs stem of the entry, or
 *  the full mix. Stem ids come from the stems registry, not guessed. */
export async function fetchStemBlob(entryId: string, stemName: string): Promise<Blob> {
  if (!entryId) throw new Error('no song selected');
  if (!stemName || stemName === 'mix') {
    const lib = useLibraryStore.getState();
    let entry = lib.entries.find((e) => e.id === entryId);
    if (!entry) {
      await lib.load();
      entry = useLibraryStore.getState().entries.find((e) => e.id === entryId);
    }
    if (!entry) throw new Error('library entry not found');
    return useLibraryStore.getState().fetchAudioBlob(entry);
  }
  const res = await fetch(`/api/stems/${encodeURIComponent(entryId)}`);
  if (!res.ok) throw new Error(`stems lookup failed: ${res.status}`);
  const data = (await res.json()) as { stems?: Array<{ id: string; stem_name: string }> };
  const stem = (data.stems ?? []).find((s) => s.stem_name === stemName);
  if (!stem) throw new Error(`no "${stemName}" stem — run stem separation on this song first`);
  const audio = await fetch(`/api/library/stems/${encodeURIComponent(stem.id)}/audio`);
  if (!audio.ok) throw new Error(`stem audio failed: ${audio.status}`);
  return audio.blob();
}

interface Inst {
  /** Audio inputs by port id (multi-port nodes like xfade have several). */
  inputs: Record<string, AudioNode>;
  output: AudioNode | null;
  /** Connect an incoming mod signal to this node's given mod port. */
  modConnect: Record<string, (mod: AudioNode) => void>;
  /** The LFO's post-depth output (mod signal source). */
  modOut: AudioNode | null;
  apply: (params: Record<string, string | number>) => void;
  startables: Array<AudioScheduledSourceNode>;
  disconnectAll: () => void;
}

export async function startLiveGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  cb: LiveCallbacks,
): Promise<LiveController> {
  const ctx = getEngineCtx();
  if (!ctx) throw new Error('audio engine unavailable');
  if (ctx.state === 'suspended') await ctx.resume();

  const live = nodes.filter((n) => LIVE_KINDS.has(n.kind));
  if (!live.some((n) => n.kind === 'stem' || n.kind === 'input')) {
    throw new Error('add a Stem or Library source');
  }
  const lout = live.find((n) => n.kind === 'lout');
  if (!lout) throw new Error('add a Live Out node');
  const bpm = num(lout.params.bpm, 120);

  // Rack effects that ride on AudioWorklets (chop / granular / kargyraa, and
  // Ares' grain engine) are silent without their modules — preload them so a
  // Rack FX node never plays as an accidental bypass.
  if (live.some((n) => n.kind === 'lrack')) {
    await Promise.allSettled([
      ensureChopModule(ctx),
      ensureGranularModule(ctx),
      ensureSubharmonicModule(ctx),
    ]);
  }

  const log = (m: string) => cb.onLog?.(m);
  const inst = new Map<string, Inst>();
  const lfoOscs = new Map<string, OscillatorNode>();
  const smooth = (p: AudioParam, v: number) => p.setTargetAtTime(v, ctx.currentTime, 0.05);

  // Build every live node's Web Audio structure. Sources decode first (async);
  // everything else is synchronous graph plumbing.
  const buildErrors: string[] = [];
  await Promise.all(
    live.map(async (n) => {
      try {
        if (n.kind === 'stem' || n.kind === 'input') {
          cb.onStatus(n.id, 'running', 'loading…');
          const blob =
            n.kind === 'stem'
              ? await fetchStemBlob(String(n.params.libraryId || ''), String(n.params.stem || 'mix'))
              : await fetchStemBlob(String(n.params.libraryId || ''), 'mix');
          const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          const g = ctx.createGain();
          g.gain.value = num(n.params.gain, 1);
          src.connect(g);
          inst.set(n.id, {
            inputs: {},
            output: g,
            modConnect: {},
            modOut: null,
            apply: (p) => smooth(g.gain, num(p.gain, 1)),
            startables: [src],
            disconnectAll: () => {
              try { src.stop(); } catch { /* not started */ }
              src.disconnect();
              g.disconnect();
            },
          });
        } else if (n.kind === 'lgain') {
          const g = ctx.createGain();
          g.gain.value = num(n.params.gain, 1);
          inst.set(n.id, {
            inputs: { in: g },
            output: g,
            modConnect: { gain: (m) => m.connect(g.gain) },
            modOut: null,
            apply: (p) => smooth(g.gain, num(p.gain, 1)),
            startables: [],
            disconnectAll: () => g.disconnect(),
          });
        } else if (n.kind === 'lfilter') {
          const f = ctx.createBiquadFilter();
          f.type = String(n.params.type || 'lowpass') as BiquadFilterType;
          f.frequency.value = num(n.params.freq, 800);
          f.Q.value = num(n.params.q, 1.2);
          inst.set(n.id, {
            inputs: { in: f },
            output: f,
            modConnect: { freq: (m) => m.connect(f.frequency) },
            modOut: null,
            apply: (p) => {
              f.type = String(p.type || 'lowpass') as BiquadFilterType;
              smooth(f.frequency, num(p.freq, 800));
              smooth(f.Q, num(p.q, 1.2));
            },
            startables: [],
            disconnectAll: () => f.disconnect(),
          });
        } else if (n.kind === 'ldelay') {
          const input = ctx.createGain();
          const out = ctx.createGain();
          const dry = ctx.createGain();
          const wet = ctx.createGain();
          const delay = ctx.createDelay(2.1);
          const fb = ctx.createGain();
          const mix = Math.min(1, Math.max(0, num(n.params.mix, 0.35)));
          dry.gain.value = 1 - mix * 0.5; // keep the dry present; wet rides on top
          wet.gain.value = mix;
          delay.delayTime.value = num(n.params.time, 0.375);
          fb.gain.value = Math.min(0.95, Math.max(0, num(n.params.feedback, 0.5)));
          input.connect(dry);
          dry.connect(out);
          input.connect(delay);
          delay.connect(wet);
          wet.connect(out);
          delay.connect(fb);
          fb.connect(delay);
          inst.set(n.id, {
            inputs: { in: input },
            output: out,
            modConnect: { mix: (m) => m.connect(wet.gain) },
            modOut: null,
            apply: (p) => {
              const mx = Math.min(1, Math.max(0, num(p.mix, 0.35)));
              smooth(dry.gain, 1 - mx * 0.5);
              smooth(wet.gain, mx);
              smooth(delay.delayTime, num(p.time, 0.375));
              smooth(fb.gain, Math.min(0.95, Math.max(0, num(p.feedback, 0.5))));
            },
            startables: [],
            disconnectAll: () => {
              input.disconnect();
              out.disconnect();
              dry.disconnect();
              wet.disconnect();
              delay.disconnect();
              fb.disconnect();
            },
          });
        } else if (n.kind === 'xfade') {
          const ga = ctx.createGain();
          const gb = ctx.createGain();
          const out = ctx.createGain();
          const pos = Math.min(1, Math.max(0, num(n.params.pos, 0.5)));
          ga.gain.value = 1 - pos;
          gb.gain.value = pos;
          ga.connect(out);
          gb.connect(out);
          const inverters: GainNode[] = [];
          inst.set(n.id, {
            inputs: { a: ga, b: gb },
            output: out,
            modConnect: {
              // A mod signal raises B while symmetrically lowering A.
              pos: (m) => {
                m.connect(gb.gain);
                const inv = ctx.createGain();
                inv.gain.value = -1;
                m.connect(inv);
                inv.connect(ga.gain);
                inverters.push(inv);
              },
            },
            modOut: null,
            apply: (p) => {
              const v = Math.min(1, Math.max(0, num(p.pos, 0.5)));
              smooth(ga.gain, 1 - v);
              smooth(gb.gain, v);
            },
            startables: [],
            disconnectAll: () => {
              ga.disconnect();
              gb.disconnect();
              out.disconnect();
              for (const inv of inverters) inv.disconnect();
            },
          });
        } else if (n.kind === 'lrack') {
          const effectId = String(n.params.effect || 'gater');
          const rdef = getRackEffect(effectId);
          if (!rdef) throw new Error(`unknown rack effect "${effectId}"`);
          const numeric: Record<string, number> = { ...rackEffectDefaults(effectId) };
          for (const [k, v] of Object.entries(n.params)) if (typeof v === 'number') numeric[k] = v;
          const rack = rdef.make(ctx, numeric);
          inst.set(n.id, {
            inputs: { in: rack.input },
            output: rack.output,
            // Rack params are not AudioParams — LFO mod runs at control rate
            // through the ticker below, so no audio-rate hookup here.
            modConnect: {},
            modOut: null,
            apply: (p) => {
              const np: Record<string, number> = { ...rackEffectDefaults(effectId) };
              for (const [k, v] of Object.entries(p)) if (typeof v === 'number') np[k] = v;
              rack.setParams(np);
            },
            startables: [],
            disconnectAll: () => {
              try { rack.input.disconnect(); } catch { /* gone */ }
              try { rack.output.disconnect(); } catch { /* gone */ }
              rack.dispose();
            },
          });
        } else if (n.kind === 'lfo') {
          const osc = ctx.createOscillator();
          osc.type = String(n.params.shape || 'sine') as OscillatorType;
          osc.frequency.value = lfoRateHz(n.params, bpm);
          const depth = ctx.createGain();
          depth.gain.value = num(n.params.depth, 0.5);
          osc.connect(depth);
          lfoOscs.set(n.id, osc);
          inst.set(n.id, {
            inputs: {},
            output: null,
            modConnect: {},
            modOut: depth,
            apply: (p) => {
              osc.type = String(p.shape || 'sine') as OscillatorType;
              smooth(osc.frequency, lfoRateHz(p, num(loutNodeParams().bpm, 120)));
              smooth(depth.gain, num(p.depth, 0.5));
            },
            startables: [osc],
            disconnectAll: () => {
              try { osc.stop(); } catch { /* not started */ }
              osc.disconnect();
              depth.disconnect();
            },
          });
        } else if (n.kind === 'lout') {
          const g = ctx.createGain();
          g.gain.value = num(n.params.gain, 0.9);
          g.connect(ctx.destination);
          inst.set(n.id, {
            inputs: { in: g },
            output: null,
            modConnect: {},
            modOut: null,
            apply: (p) => {
              smooth(g.gain, num(p.gain, 0.9));
              // BPM edits re-rate every synced LFO live.
              const nextBpm = num(p.bpm, 120);
              for (const lfoNode of latestNodes.filter((x) => x.kind === 'lfo')) {
                const osc = lfoOscs.get(lfoNode.id);
                if (osc) smooth(osc.frequency, lfoRateHz(lfoNode.params, nextBpm));
              }
            },
            startables: [],
            disconnectAll: () => g.disconnect(),
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        buildErrors.push(`${n.title || nodeDef(n.kind).label}: ${msg}`);
        cb.onStatus(n.id, 'error', msg);
      }
    }),
  );

  // Latest params snapshot, for cross-node reads (lout bpm → lfo rates).
  let latestNodes: GraphNode[] = nodes;
  const loutNodeParams = (): Record<string, string | number> =>
    latestNodes.find((x) => x.kind === 'lout')?.params ?? lout.params;

  if (!inst.size || buildErrors.length === live.length) {
    throw new Error(buildErrors[0] ?? 'nothing to play');
  }

  // Wire it up. Audio edges connect outputs to the target's input port; mod
  // edges route an LFO's depth output into the target's mod hookup.
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  let audioWires = 0;
  let modWires = 0;
  // Rack FX params are plain numbers (not AudioParams), so an LFO wired into a
  // Rack FX mod port modulates at CONTROL rate: a 30 Hz ticker computes the
  // LFO's wave from the audio clock and pushes base+wave·depth onto the
  // target's `modParam` key, clamped to the param's descriptor range.
  const controlMods: Array<{ lfoId: string; targetId: string }> = [];
  for (const e of edges) {
    const from = nodeById.get(e.from);
    const to = nodeById.get(e.to);
    if (!from || !to || !LIVE_KINDS.has(from.kind) || !LIVE_KINDS.has(to.kind)) continue;
    const src = inst.get(e.from);
    const dst = inst.get(e.to);
    if (!src || !dst) continue;
    const outPort = nodeDef(from.kind).outputs.find((p) => p.id === e.fromPort);
    if (!outPort) continue;
    if (outPort.type === 'mod') {
      if (to.kind === 'lrack' && from.kind === 'lfo') {
        controlMods.push({ lfoId: from.id, targetId: to.id });
        modWires += 1;
      } else if (src.modOut && dst.modConnect[e.toPort]) {
        dst.modConnect[e.toPort](src.modOut);
        modWires += 1;
      }
    } else if (src.output && dst.inputs[e.toPort]) {
      src.output.connect(dst.inputs[e.toPort]);
      audioWires += 1;
    }
  }
  if (!audioWires) {
    for (const i of inst.values()) i.disconnectAll();
    throw new Error('no live audio path — wire sources through to Live Out');
  }

  // Start every source on the same clock edge so stems stay phase-locked.
  const t0 = ctx.currentTime + 0.12;
  for (const i of inst.values()) for (const s of i.startables) s.start(t0);
  for (const n of live) {
    if (inst.has(n.id)) cb.onStatus(n.id, 'running');
  }
  log(`LIVE — ${inst.size} node(s), ${audioWires} audio + ${modWires} mod wire(s), ${bpm} BPM`);

  // Control-rate mod ticker (Rack FX targets only). Phase comes from the
  // audio clock so it stays coherent with the audio-rate LFO hookups.
  let modTimer: number | null = null;
  if (controlMods.length) {
    modTimer = window.setInterval(() => {
      const t = ctx.currentTime - t0;
      const bpmNow = num(loutNodeParams().bpm, 120);
      for (const m of controlMods) {
        const lfoNode = latestNodes.find((x) => x.id === m.lfoId);
        const target = latestNodes.find((x) => x.id === m.targetId);
        const rack = inst.get(m.targetId);
        if (!lfoNode || !target || !rack) continue;
        const key = String(target.params.modParam ?? '').trim();
        if (!key) continue;
        const desc = getRackEffect(String(target.params.effect || ''))?.params.find((p) => p.key === key);
        const base = num(target.params[key], desc?.default ?? 0);
        const rate = lfoRateHz(lfoNode.params, bpmNow);
        const depth = num(lfoNode.params.depth, 0.5);
        const cyc = (rate * t) % 1;
        const shape = String(lfoNode.params.shape || 'sine');
        const wave =
          shape === 'square' ? (cyc < 0.5 ? 1 : -1)
          : shape === 'sawtooth' ? 2 * cyc - 1
          : shape === 'triangle' ? 4 * Math.abs(cyc - 0.5) - 1
          : Math.sin(2 * Math.PI * cyc);
        let v = base + wave * depth;
        if (desc) v = Math.max(desc.min, Math.min(desc.max, v));
        rack.apply({ ...target.params, [key]: v });
      }
    }, 33);
  }

  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (modTimer !== null) window.clearInterval(modTimer);
      for (const i of inst.values()) i.disconnectAll();
      for (const n of live) cb.onStatus(n.id, 'idle');
      log('LIVE stopped');
    },
    updateParams: (node) => {
      if (stopped) return;
      latestNodes = latestNodes.map((x) => (x.id === node.id ? node : x));
      inst.get(node.id)?.apply(node.params);
    },
  };
}
