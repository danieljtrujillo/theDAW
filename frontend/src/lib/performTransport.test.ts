/**
 * PERFORM's session grid is the transport a VST3 on one of its columns follows.
 *
 * The sequence a user makes: open a set in PERFORM whose column carries a
 * tempo-synced VST3, press a clip. The grid hands the set's tempo to the shared
 * beat clock (its `claimClock`), the press lands on the clock's grid line, the
 * column's FX chain is built the moment its first clip fires (so the plugin's
 * host only starts opening then), and the plugin goes live a couple of seconds
 * later. Everything here is the app's own code — the beat clock, the engine
 * context, the column's chain entries, `buildEffectChain`, the live VST node and
 * its transport broadcast — with Web Audio and the plugin host faked at their
 * edges.
 *
 * Before the grid had a transport, the plugin went live told what EDIT had last
 * said (stopped, position 0, no tempo) and heard nothing from the grid after
 * that, so a gate or a synced delay on a PERFORM column could not follow it.
 *
 *   cd frontend && npx tsx src/lib/performTransport.test.ts
 */
import assert from 'node:assert/strict';

import { beatClock } from './beatClock.ts';
import { createLaunchQueue, launchSlotId } from './launchQueue.ts';
import { performChainEntries } from './performModel.ts';
import { createPerformTransport } from './performTransport.ts';
import { buildEffectChain } from './rackEffects.ts';
import { createVstLiveNode } from './vstLive/vstLiveNode.ts';
import type { VstLiveSession, VstSessionRegistry } from './vstLive/sessionRegistry.ts';
import type { DawTrack } from './dawImportClient.ts';
import type { ChainEntry } from '../state/effectChainStore.ts';
import { useVstLiveStore } from '../state/vstLiveStore.ts';
import { getEngineCtx } from '../state/playerStore.ts';

/* ── Web Audio, faked at its edge ──────────────────────────────────────────── */

class FakeParam {
  value = 1;
  setValueAtTime(v: number): this { this.value = v; return this; }
  linearRampToValueAtTime(v: number): this { this.value = v; return this; }
  setTargetAtTime(v: number): this { this.value = v; return this; }
  cancelScheduledValues(): this { return this; }
}
class FakeNode {
  gain = new FakeParam();
  fftSize = 0;
  smoothingTimeConstant = 0;
  connect<T>(dest: T): T { return dest; }
  disconnect(): void { /* nothing to undo */ }
}
class FakePort {
  posted: Array<Record<string, unknown>> = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  postMessage(msg: Record<string, unknown>): void { this.posted.push(msg); }
  close(): void {}
}
class FakeWorklet extends FakeNode {
  static made: FakeWorklet[] = [];
  port = new FakePort();
  onprocessorerror: (() => void) | null = null;
  constructor() {
    super();
    FakeWorklet.made.push(this);
  }
}
class FakeEngineCtx {
  currentTime = 0;
  sampleRate = 48000;
  state = 'running';
  destination = new FakeNode();
  audioWorklet = { addModule: async () => {} };
  createGain(): FakeNode { return new FakeNode(); }
  createAnalyser(): FakeNode { return new FakeNode(); }
  createMediaElementSource(): FakeNode { return new FakeNode(); }
  resume(): Promise<void> { return Promise.resolve(); }
}
class FakeAudio {
  crossOrigin = '';
  preload = '';
  addEventListener(): void { /* no media plays here */ }
}
const g = globalThis as unknown as Record<string, unknown>;
g.window = { AudioContext: FakeEngineCtx, addEventListener: () => {}, removeEventListener: () => {} };
g.Audio = FakeAudio;

/** The one engine context: the clock reads its time, the grid plays on it. */
const ctx = getEngineCtx() as unknown as FakeEngineCtx;

/* ── the plugin host, faked at its edge ────────────────────────────────────── */

function fakeSession(entryId: string): VstLiveSession {
  return {
    entryId,
    sessionId: `s-${entryId}`,
    wsUrl: 'ws://x',
    pid: 1,
    client: { ready: true, blockSize: 512, sendAudio: () => {}, setParam: () => {}, close: () => {} } as never,
    stateDirty: false,
    userMovedOnRejectedState: false,
    stateSent: true,
  };
}

function fakeRegistry(session: VstLiveSession): VstSessionRegistry {
  return {
    acquire: () => Promise.resolve(session),
    hold: () => Promise.resolve(null),
    unhold: () => {},
    forget: () => {},
    release: () => {},
    close: () => {},
    closeAll: () => {},
    retry: () => {},
    get: () => session,
    hostAvailable: () => true,
    sessionIds: () => [session.entryId],
    sessions: () => [session],
    markParamsChanged: () => {},
    markUserParamsChanged: () => {},
  } as unknown as VstSessionRegistry;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/** The session going live the way the registry reports it. */
const goLive = (entryId: string) =>
  useVstLiveStore.getState().setReady(entryId, {
    plugin: { name: 'Gate', vendor: 'V', version: '1', category: 'Fx', identifier: 'ID', format: 'VST3' },
    pluginLatencySamples: 0,
    bridgeLatencySamples: 1536,
    sampleRate: 48000,
    hasEditor: false,
  });

const transportOf = (port: FakePort) => port.posted.filter((m) => m.type === 'transport');

/* ── the set: one audio column whose chain holds a VST3 gate ───────────────── */

const column: DawTrack = {
  name: 'Pad',
  type: 'audio',
  volume_db: 0,
  pan: 0,
  mute: false,
  solo: false,
  clips: [{ name: 'Pad', start_time: 0, end_time: 4, file_path: 'C:/set/pad.wav', track_index: 0, scene_index: 0 }],
  devices: [{ name: 'Gate', plugin_type: 'vst3', plugin_path: 'C:/VST3/Gate.vst3', parameters: {} }],
};

/* ── press, fire, go live, change tempo, stop, play again ──────────────────── */
{
  useVstLiveStore.setState({ entries: {}, host: { available: null } });
  const SR = ctx.sampleRate;

  // The grid claims the clock with the set's tempo and meter on the first press.
  ctx.currentTime = 10;
  beatClock.setBpm(128, 'perform');
  beatClock.setMeterMap([{ bar: 0, meter: { num: 4, den: 4, groups: [] } }]);

  // The press: queued on the clock's bar line. A cold clock makes the press bar 0.
  const queue = createLaunchQueue({
    nextGrid: (grid, from) => beatClock.nextGrid(grid, from),
    now: () => getEngineCtx().currentTime,
    lead: 0.05,
  });
  queue.queue(launchSlotId(0), { grid: 'bar', action: 'play' });
  const [ticket] = queue.advance(ctx.currentTime);
  assert.ok(ticket, 'the press fires on the pump');
  assert.equal(ticket.at, 10, 'on the cold clock the press is bar 0');

  // The fire builds the column's chain: its VST3 is a live node opening in the
  // background, and the clip starts, which starts the grid's transport.
  const entries: ChainEntry[] = performChainEntries(column, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'perform-0-0');
  assert.equal(entries[0].effect, 'vst3');
  const session = fakeSession(entries[0].id);
  const chain = buildEffectChain(ctx as unknown as BaseAudioContext, new FakeNode() as never, new FakeNode() as never, entries, {
    vstFactory: (c, e) =>
      createVstLiveNode(c, e, {
        registry: fakeRegistry(session),
        parkMs: 0,
        ensureModule: async () => {},
        makeWorklet: () => new FakeWorklet() as never,
      }),
  });
  const transport = createPerformTransport();
  transport.play();
  assert.equal(transport.isPlaying(), true);

  // Two seconds later the plugin's host is up and the node goes live.
  await settle();
  ctx.currentTime = 12;
  goLive(entries[0].id);
  await settle();
  assert.equal(FakeWorklet.made.length, 1, 'the column plugin is live');
  const port = FakeWorklet.made[0].port;
  const onLive = transportOf(port).at(-1);
  // At 128 the grid is 2 s = 4.2667 beats past bar 0; as samples at 128 that is 2 s of frames.
  assert.deepEqual(
    onLive,
    { type: 'transport', playing: true, positionSamples: 2 * SR, tempoBpm: 128, discontinuity: true },
    'a plugin that goes live while the grid plays is told it plays, where the grid is now, and at what tempo',
  );

  // A tempo change on the clock while the grid plays: same beat, new tempo.
  ctx.currentTime = 14;
  beatClock.setBpm(140, 'perform');
  const beatsAt14 = (4 * 128) / 60;
  assert.deepEqual(
    transportOf(port).at(-1),
    {
      type: 'transport',
      playing: true,
      positionSamples: Math.round(((beatsAt14 * 60) / 140) * SR),
      tempoBpm: 140,
      discontinuity: false,
    },
    'a new tempo keeps the beat the grid is on, so the plugin is not reset',
  );

  // The grid's Stop.
  ctx.currentTime = 16;
  transport.stop();
  const beatsAt16 = beatsAt14 + (2 * 140) / 60;
  assert.deepEqual(
    transportOf(port).at(-1),
    {
      type: 'transport',
      playing: false,
      positionSamples: Math.round(((beatsAt16 * 60) / 140) * SR),
      tempoBpm: 140,
      discontinuity: false,
    },
    'Stop tells the plugin the transport stopped where the grid stopped',
  );
  assert.equal(transport.isPlaying(), false);

  // A clock change while stopped says nothing to the plugin.
  const quiet = transportOf(port).length;
  ctx.currentTime = 17;
  beatClock.setBpm(150, 'perform');
  assert.equal(transportOf(port).length, quiet, 'a stopped grid sends no tempo');

  // The next launch starts the transport again, from where the clock is.
  ctx.currentTime = 20;
  transport.play();
  const beatsAt17 = beatsAt16 + (1 * 140) / 60;
  const beatsAt20 = beatsAt17 + (3 * 150) / 60;
  assert.deepEqual(
    transportOf(port).at(-1),
    {
      type: 'transport',
      playing: true,
      positionSamples: Math.round(((beatsAt20 * 60) / 150) * SR),
      tempoBpm: 150,
      discontinuity: true,
    },
    'a launch after a stop starts the plugin from the grid position, as a jump',
  );

  // A second clip on another column does not restart what is already playing.
  const before = transportOf(port).length;
  transport.play();
  assert.equal(transportOf(port).length, before, 'the transport is already running');

  transport.stop();
  chain.dispose();
}

console.log('performTransport: ok');
