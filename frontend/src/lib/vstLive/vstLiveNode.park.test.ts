/**
 * vstLive/vstLiveNode — a live node survives the graph rebuild that follows its dispose.
 *
 * The engine rebuilds every FX chain on Play, on every seek while playing and on every loop wrap:
 * dispose, then create again for the same entry a few milliseconds later. A new bridge worklet starts
 * unprimed, so each rebuild used to let the DRY signal through until the play-out buffer had refilled —
 * an audible blip at every loop point. A disposed node is parked instead, and the next create for the
 * same entry hands the very same worklet back.
 *
 * Run: npx tsx src/lib/vstLive/vstLiveNode.park.test.ts
 */
import assert from 'node:assert/strict';

import { createVstLiveNode } from './vstLiveNode.ts';
import { useVstLiveStore } from '../../state/vstLiveStore.ts';
import type { ChainEntry } from '../../state/effectChainStore.ts';
import type { VstLiveSession, VstSessionRegistry } from './sessionRegistry.ts';

/* ── fakes ─────────────────────────────────────────────────────────────────── */

const edges = new Set<string>();
class FakeParam {
  value = 1;
  setValueAtTime(v: number): this { this.value = v; return this; }
  linearRampToValueAtTime(v: number): this { this.value = v; return this; }
  cancelScheduledValues(): this { return this; }
}
let gainSeq = 0;
class FakeGain {
  gain = new FakeParam();
  readonly name: string;
  constructor() { gainSeq += 1; this.name = `G${gainSeq}`; }
  connect(dest: { name: string }): unknown { edges.add(`${this.name}->${dest.name}`); return dest; }
  disconnect(dest?: { name: string }): void {
    if (dest) edges.delete(`${this.name}->${dest.name}`);
    else for (const e of [...edges]) if (e.startsWith(`${this.name}->`)) edges.delete(e);
  }
}
class FakeWorklet {
  static made: FakeWorklet[] = [];
  port = { posted: [] as unknown[], onmessage: null as unknown, postMessage(m: unknown) { this.posted.push(m); } };
  name = 'WORKLET';
  onprocessorerror: (() => void) | null = null;
  constructor() { FakeWorklet.made.push(this); }
  connect(dest: { name: string }): unknown { edges.add(`${this.name}->${dest.name}`); return dest; }
  disconnect(): void { for (const e of [...edges]) if (e.startsWith(`${this.name}->`)) edges.delete(e); }
}
class FakeCtx {
  currentTime = 1;
  sampleRate = 48000;
  audioWorklet = { addModule: async () => {} };
  createGain(): FakeGain { return new FakeGain(); }
}

class FakeRegistry {
  acquired: string[] = [];
  released: string[] = [];
  sent: unknown[] = [];
  give: VstLiveSession | null = null;
  session(entryId: string): VstLiveSession {
    const client = { ready: true, blockSize: 512, sendAudio: () => {}, setParam: (i: number, v: number) => this.sent.push([i, v]), close: () => {} };
    return {
      entryId,
      sessionId: `s-${entryId}`,
      wsUrl: 'ws://x',
      pid: 1,
      client: client as never,
      stateDirty: false,
      userMovedOnRejectedState: false,
      stateSent: true,
    };
  }
  /** A session whose client can take a MessagePort — a worker-backed one. */
  portSession(entryId: string): VstLiveSession {
    const session = this.session(entryId);
    const client = session.client as unknown as { ports: unknown[]; attachAudioPort: (p: unknown) => void };
    client.ports = [];
    client.attachAudioPort = (port: unknown) => client.ports.push(port);
    return session;
  }
  acquire(e: ChainEntry): Promise<VstLiveSession | null> { this.acquired.push(e.id); return Promise.resolve(this.give); }
  release(id: string): void { this.released.push(id); }
  get(): VstLiveSession | undefined { return this.give ?? undefined; }
  hold(): Promise<null> { return Promise.resolve(null); }
  unhold(): void {}
  forget(): void {}
  close(): void {}
  closeAll(): void {}
  retry(): void {}
  hostAvailable(): boolean | null { return true; }
  sessionIds(): string[] { return []; }
  sessions(): VstLiveSession[] { return []; }
  markParamsChanged(): void {}
}

const entry = (id: string, params: Record<string, number> = {}): ChainEntry => ({
  id, effect: 'vst3', params, enabled: true, vst: { plugin_path: 'C:/VST3/X.vst3', plugin_name: 'X' },
});
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const ready = (id: string) =>
  useVstLiveStore.getState().setReady(id, {
    plugin: { name: 'X', vendor: 'v', version: '1', category: 'Fx', identifier: 'ID', format: 'VST3' },
    pluginLatencySamples: 0, bridgeLatencySamples: 1536, sampleRate: 48000, hasEditor: true,
  });

function setup(parkMs: number) {
  edges.clear();
  gainSeq = 0;
  FakeWorklet.made = [];
  useVstLiveStore.setState({ entries: {}, host: { available: null } });
  const reg = new FakeRegistry();
  const deps = {
    registry: reg as unknown as VstSessionRegistry,
    parkMs,
    ensureModule: async () => {},
    makeWorklet: () => new FakeWorklet() as never,
  };
  return { reg, deps, ctx: new FakeCtx() as unknown as BaseAudioContext };
}

/** A node that has gone live, wired between an upstream and a downstream the way a chain wires it. */
async function liveNode(id: string, s: ReturnType<typeof setup>, params: Record<string, number> = {}) {
  s.reg.give = s.reg.session(id);
  const inst = createVstLiveNode(s.ctx, entry(id, params), s.deps)!;
  await tick();
  ready(id);
  await tick();
  assert.equal(FakeWorklet.made.length, 1, 'setup: the worklet is attached');
  const downstream = new FakeGain();
  (inst.output as unknown as FakeGain).connect(downstream);
  return { inst, downstream };
}

/* ── a rebuild (dispose, then create for the same entry) gets the SAME live bridge back ── */
{
  const s = setup(50);
  const { inst } = await liveNode('a', s, { p0: 0.25 });
  const internalBefore = [...edges].filter((e) => !e.endsWith(`->G${gainSeq}`)).sort();

  inst.dispose(); // the chain tears down on Play / seek / loop wrap
  assert.deepEqual(s.reg.released, [], 'the session claim is NOT given back: the rebuild is milliseconds away');
  assert.deepEqual([...edges].sort(), internalBefore, 'only the way OUT is cut; input -> worklet -> wet -> output stays wired');

  const again = createVstLiveNode(s.ctx, entry('a', { p0: 0.25, p1: 0.75 }), s.deps)!;
  assert.equal(again.input, inst.input, 'the same node comes back');
  assert.equal(again.output, inst.output);
  assert.equal(FakeWorklet.made.length, 1, 'no second worklet: the primed play-out buffer is kept, so no dry blip');
  assert.deepEqual(s.reg.acquired, ['a'], 'and no second acquire');
  assert.deepEqual(s.reg.sent, [[0, 0.25], [1, 0.75]], 'only the parameter that actually moved is sent on the way back in');

  inst.dispose(); // the old owner's handle is dead: it cannot park or destroy the node the new chain holds
  inst.setParams({ p0: 0.9 });
  assert.deepEqual(s.reg.sent.length, 2, 'a stale handle cannot push parameters either');
  await tick(80);
  assert.deepEqual(s.reg.released, [], 'the park timer was cancelled by the revive');

  again.dispose();
  await tick(80);
  assert.deepEqual(s.reg.released, ['a'], 'nobody came back for it: torn down, claim released once');
  assert.deepEqual([...edges].filter((e) => e.startsWith('G1->') || e.startsWith('WORKLET->')), [], 'and the internal graph is gone');
}

/* ── a real removal: nothing re-creates the entry, so the node goes after the park time ── */
{
  const s = setup(30);
  const { inst } = await liveNode('b', s);
  inst.dispose();
  await tick(10);
  assert.deepEqual(s.reg.released, []);
  await tick(60);
  assert.deepEqual(s.reg.released, ['b']);
  // a create AFTER that builds a fresh node
  const fresh = createVstLiveNode(s.ctx, entry('b'), s.deps)!;
  assert.notEqual(fresh.input, inst.input);
  fresh.dispose();
  await tick(60);
}

/* ── the session went away while parked (project closed): never revive onto a dead session ── */
{
  const s = setup(200);
  const { inst } = await liveNode('c', s);
  inst.dispose();
  s.reg.give = s.reg.session('c'); // closeAll + a new open: the registry now has a DIFFERENT session object
  const fresh = createVstLiveNode(s.ctx, entry('c'), s.deps)!;
  assert.notEqual(fresh.input, inst.input, 'a new node is built for the new session');
  assert.deepEqual(s.reg.released, ['c'], 'and the parked one is torn down at once, not left for its timer');
  fresh.dispose();
  await tick(250);
}

/* ── a node that never got its worklet has nothing worth keeping ── */
{
  const s = setup(200);
  s.reg.give = s.reg.session('d');
  const inst = createVstLiveNode(s.ctx, entry('d'), s.deps)!;
  await tick(); // acquired, but the host has not said ready: no worklet yet
  inst.dispose();
  assert.deepEqual(s.reg.released, ['d'], 'torn down immediately');
}

/* ── another context never gets a node that belongs to this one ── */
{
  const s = setup(200);
  const { inst } = await liveNode('e', s);
  inst.dispose();
  const other = createVstLiveNode(new FakeCtx() as unknown as BaseAudioContext, entry('e'), s.deps)!;
  assert.notEqual(other.input, inst.input);
  assert.deepEqual(s.reg.released, ['e']);
  other.dispose();
  await tick(250);
}

/* ── a revived node keeps the audio channel it already had ── */
{
  // The point of parking is that the rebuild costs nothing: the same worklet,
  // the same primed buffer, and now the same channel to the bridge worker. A
  // revive that opened a SECOND channel would close the port the worklet is
  // posting to — the worklet would fall back to the main thread's port, which
  // no longer forwards blocks, and the plugin would drop out of the path.
  const s = setup(50);
  s.reg.give = s.reg.portSession('p');
  const inst = createVstLiveNode(s.ctx, entry('p'), s.deps)!;
  await tick();
  ready('p');
  await tick();
  const client = s.reg.give.client as unknown as { ports: unknown[] };
  const port = FakeWorklet.made[0].port;
  const handovers = () => port.posted.filter((m) => (m as { type?: string })?.type === 'audio-port').length;
  assert.equal(handovers(), 1, 'setup: the worklet was handed one end of a channel');
  assert.equal(client.ports.length, 1, 'setup: the client holds the other');
  assert.equal(s.reg.give.audioSink ?? null, null, 'setup: no processed frame comes back through main');

  inst.dispose(); // Play / seek / loop wrap
  const again = createVstLiveNode(s.ctx, entry('p'), s.deps)!;
  assert.equal(again.input, inst.input, 'the same node comes back');
  assert.equal(FakeWorklet.made.length, 1, 'with the same worklet');
  assert.equal(handovers(), 1, 'and the same channel: no second handover');
  assert.equal(client.ports.length, 1);
  assert.equal(s.reg.give.audioSink ?? null, null, 'audio still never touches the main thread');

  again.dispose();
  await tick(80);
}

console.log('vstLive/vstLiveNode.park: ok');
