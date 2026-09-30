// The editor store OWNS the routing graph (T10b, plan §3.6 step 2).
//
// T10a shipped `state/routingGraph.ts` — buses, sends and `outputTo` as edges of
// one directed graph — with no production caller. This file pins the store half
// of giving it one: `routing` is document state (undo, snapshot, autosave),
// the store keeps it consistent with `tracks` on its own, and every refusal the
// model can return reaches the caller instead of being swallowed.
//
// What is pinned here:
//
//   1. Every track-creating / track-removing path keeps the graph in step:
//      the initial document, `loadProject`, `addTrack`, `removeTrack`. Those
//      four are the ONLY places `tracks` membership changes.
//   2. Migration: a project loaded with no `routing` (i.e. every document that
//      exists today) gets `emptyGraph()` plus one node per track, so an old
//      `.tasmo` and a restored autosave are both audible without a routing
//      picker ever having been opened.
//   3. Bus CRUD and the send actions, each ONE undo step (they call
//      `beginUndoStep()` first, so two actions 1 ms apart are two steps, not
//      one coalesced step).
//   4. Refusals surface: `setTrackOutput` / `addSend` hand back the model's
//      `RoutingRefusal` and leave the graph untouched.
//   5. `routing` + `buses` ride in the undo snapshot AND in the autosave
//      manifest, and come back out of both.
//   6. VALUE actions do NOT open an undo step of their own: a bus fader ride and
//      a coalescing send-knob drag fold into the step their pointer-down cut,
//      exactly as `updateTrack` and `stretchClipToFit` do.
//   7. Migration PRUNES as well as adds: a node whose strip is in neither
//      `tracks` nor `buses` is dropped, so a graph cannot outlive the document
//      it describes.
//
// Run: npx tsx src/state/editorStore.routing.test.ts
import assert from 'node:assert/strict';
// Static imports are safe despite the global installs below: neither module
// reads `window` or `navigator` at module scope, only inside its functions.
import { beginUndoStep, DEFAULT_TRACK_COUNT, useEditorStore, type EditorBus, type EditorTrack } from './editorStore.ts';
import { MASTER_ID, outputOf, sendsFrom, validateGraph } from './routingGraph.ts';
import { initEditorAutosave, flushPendingAutosave, useAutosaveRecoveryStore } from '../lib/editorAutosave.ts';

const flush = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/* ── fake OPFS + window, installed before the autosave module runs anything ──
   editorAutosave reads `navigator.storage` / `window` only inside its
   functions, so installing the globals here (rather than fighting ESM hoisting)
   is enough. The point is a REAL round trip: buildManifest -> JSON bytes ->
   restoreFromAutosave, not a hand-written manifest literal. */

interface FakeFile { text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }

class FakeDir {
  files = new Map<string, string>();
  dirs = new Map<string, FakeDir>();

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDir> {
    let d = this.dirs.get(name);
    if (!d) {
      if (!opts?.create) throw new Error(`no dir ${name}`);
      d = new FakeDir();
      this.dirs.set(name, d);
    }
    return d;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<{
    getFile(): Promise<FakeFile>;
    createWritable(): Promise<{ write(data: unknown): Promise<void>; close(): Promise<void> }>;
  }> {
    if (!this.files.has(name)) {
      if (!opts?.create) throw new Error(`no file ${name}`);
      this.files.set(name, '');
    }
    const self = this;
    return {
      async getFile() {
        const body = self.files.get(name) as string;
        return {
          async text() { return body; },
          async arrayBuffer() { return new TextEncoder().encode(body).buffer as ArrayBuffer; },
        };
      },
      async createWritable() {
        let buf = '';
        return {
          async write(data: unknown) { buf += typeof data === 'string' ? data : ''; },
          async close() { self.files.set(name, buf); },
        };
      },
    };
  }

  async removeEntry(name: string): Promise<void> { this.files.delete(name); this.dirs.delete(name); }
  async *keys(): AsyncIterable<string> { for (const k of this.files.keys()) yield k; }
}

const opfs = new FakeDir();
/** The autosave directory the module creates under the OPFS root. */
const saveDir = (): FakeDir => opfs.dirs.get('thedaw-editor-autosave') as FakeDir;
Object.defineProperty(globalThis, 'navigator', {
  value: { storage: { getDirectory: async () => opfs } },
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, 'window', {
  value: {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (h: number) => clearTimeout(h as unknown as NodeJS.Timeout),
    addEventListener: () => undefined,
  },
  configurable: true,
  writable: true,
});


const st = () => useEditorStore.getState();

const mkTrack = (id: string, name = id): EditorTrack => ({
  id, name, nameAutoGenerated: false, volume: 0.8, pan: 0, mute: false, solo: false, color: '#fff',
});

/** Node ids in the graph, master last-ish — sorted so order is not asserted. */
const nodeIds = (): string[] => st().routing.nodes.map((n) => n.id).sort();

/* ── 1. The graph exists from the first frame ────────────────────────────── */

function theInitialDocumentIsAlreadyRouted(): void {
  // The store ships with one track. Without a node for it the very first
  // `wireRouting` would have nothing to place and the mixer would be silent
  // until the user touched a routing control that does not exist yet.
  const g = st().routing;
  assert.ok(g.nodes.some((n) => n.id === MASTER_ID), 'the master is a node from the start');
  for (const t of st().tracks) {
    assert.ok(g.nodes.some((n) => n.id === t.id), `the initial track ${t.id} has a node`);
    assert.equal(outputOf(g, t.id), MASTER_ID, 'and it feeds the master');
  }
  assert.deepEqual(validateGraph(g), [], 'the initial graph is structurally sane');
  assert.deepEqual(st().buses, [], 'with no buses');
}

/* ── 2. Migration: a routing-less project is the normal case ──────────────── */

function aProjectWithNoRoutingIsMigratedOnLoad(): void {
  // Every document that exists today — every .tasmo on disk, every autosave
  // manifest written before this ticket — has no `routing` key at all.
  st().loadProject({ tracks: [mkTrack('a'), mkTrack('b'), mkTrack('c')], clips: [] });
  const g = st().routing;
  assert.deepEqual(nodeIds(), ['a', 'b', 'c', MASTER_ID].sort(), 'one node per loaded track, plus the master');
  for (const id of ['a', 'b', 'c']) assert.equal(outputOf(g, id), MASTER_ID, `${id} feeds the master`);
  assert.deepEqual(validateGraph(g), [], 'the migrated graph is sane');
  assert.deepEqual(st().buses, [], 'and a migrated project has no buses');

  // A load with NO tracks falls back to the six default lanes — every one of
  // which must be routed too.
  st().loadProject({ tracks: [], clips: [] });
  assert.equal(st().tracks.length, DEFAULT_TRACK_COUNT, 'an empty load still yields the default lanes');
  for (const t of st().tracks) assert.equal(outputOf(st().routing, t.id), MASTER_ID, `default lane ${t.id} is routed`);
}

function aLoadedGraphIsKeptButCompleted(): void {
  // A project saved AFTER this ticket carries its graph. It is kept verbatim —
  // except that a track with no node (hand-edited file, or a track added by an
  // importer after the graph was built) is still given one rather than dropped.
  const busId = st().addBus('Drums');
  st().setTrackOutput(st().tracks[0].id, busId);
  const withBus = st().routing;

  st().loadProject({
    tracks: [mkTrack('x'), mkTrack('y')],
    clips: [],
    routing: withBus,
    buses: st().buses,
  });
  assert.ok(st().routing.nodes.some((n) => n.id === busId), 'the loaded graph keeps its bus');
  for (const id of ['x', 'y']) {
    assert.ok(st().routing.nodes.some((n) => n.id === id), `${id} was completed into the loaded graph`);
    assert.equal(outputOf(st().routing, id), MASTER_ID, `${id} defaults to the master`);
  }
  assert.equal(st().buses.length, 1, 'and the loaded bus slice comes with it');
  // PRUNED. `track-1` had a node in `withBus` (it was the loaded document's only
  // track) and is in neither the new `tracks` nor the new `buses`, so it goes —
  // a graph must not outlive the document it describes.
  assert.ok(!st().routing.nodes.some((n) => n.id === 'track-1'), 'the previous project’s track node is pruned');
  assert.deepEqual(nodeIds(), ['x', 'y', busId, MASTER_ID].sort(), 'leaving exactly the loaded document');
  assert.deepEqual(validateGraph(st().routing), [], 'and no dangling edge behind it');
}

function pruningReHomesRatherThanOrphans(): void {
  // A track routed into a bus that the new document does not have: the bus node
  // goes, and `removeNode` re-homes the survivor instead of leaving it with a
  // dangling output edge that `topoOrder` could not resolve.
  st().loadProject({ tracks: [mkTrack('a')], clips: [] });
  const doomed = st().addBus('Doomed');
  assert.equal(st().setTrackOutput('a', doomed), null);
  const stale = st().routing;

  st().loadProject({ tracks: [mkTrack('a')], clips: [], routing: stale, buses: [] });
  assert.ok(!st().routing.nodes.some((n) => n.id === doomed), 'a bus with no strip is pruned');
  assert.equal(outputOf(st().routing, 'a'), MASTER_ID, 'and what fed it is re-homed to the master, not silenced');
  assert.deepEqual(validateGraph(st().routing), [], 'sanely');
}

/* ── 3. addTrack / removeTrack keep the graph in step ─────────────────────── */

function addTrackAndRemoveTrackMoveTheGraph(): void {
  st().loadProject({ tracks: [mkTrack('keep')], clips: [] });
  const id = st().addTrack({ name: 'New' });
  assert.ok(st().routing.nodes.some((n) => n.id === id), 'addTrack seeds a node');
  assert.equal(outputOf(st().routing, id), MASTER_ID, 'routed to the master by default');

  st().removeTrack(id);
  assert.ok(!st().routing.nodes.some((n) => n.id === id), 'removeTrack drops the node');
  assert.deepEqual(
    st().routing.edges.filter((e) => e.from === id || e.to === id), [],
    'and every edge that touched it',
  );
  assert.deepEqual(validateGraph(st().routing), [], 'leaving a sane graph');
}

function removingABusReHomesWhatFedIt(): void {
  st().loadProject({ tracks: [mkTrack('t1'), mkTrack('t2')], clips: [] });
  const busId = st().addBus('Drums');
  assert.equal(st().setTrackOutput('t1', busId), null, 't1 -> bus is accepted');
  assert.equal(st().setTrackOutput('t2', busId), null, 't2 -> bus is accepted');
  assert.equal(outputOf(st().routing, 't1'), busId);

  st().removeBus(busId);
  assert.deepEqual(st().buses, [], 'the bus leaves the slice');
  assert.ok(!st().routing.nodes.some((n) => n.id === busId), 'and the graph');
  // Re-homed, not orphaned: deleting a bus must never silence what fed it.
  assert.equal(outputOf(st().routing, 't1'), MASTER_ID, 't1 falls back to the master');
  assert.equal(outputOf(st().routing, 't2'), MASTER_ID, 't2 falls back to the master');
  assert.deepEqual(validateGraph(st().routing), [], 'and the graph stays sane');
}

/* ── 4. Refusals reach the caller ────────────────────────────────────────── */

function refusalsAreReturnedAndChangeNothing(): void {
  st().loadProject({ tracks: [mkTrack('t1')], clips: [] });
  const busId = st().addBus('Reverb');
  assert.equal(st().setTrackOutput('t1', busId), null);

  const before = st().routing;
  // The bus already receives t1, so bus -> t1 closes a loop. A Web Audio cycle
  // with no DelayNode in it is SILENCE, so this refusal is load-bearing.
  assert.equal(st().setTrackOutput(busId, 't1'), 'cycle', 'a feedback loop is refused by reason');
  assert.equal(st().routing, before, 'and the graph object is not even replaced');

  assert.equal(st().setTrackOutput('ghost', busId), 'missing-node', 'an unknown source is named');
  assert.equal(st().setTrackOutput('t1', 'ghost'), 'missing-node', 'so is an unknown destination');
  assert.equal(st().routing, before, 'none of which touched the graph');

  assert.equal(st().addSend('t1', busId, 0.5), null, 'a send onto the same bus is fine');
  assert.equal(st().addSend('t1', busId, 0.2), 'duplicate', 'a second send on the same pair is refused');
  assert.equal(sendsFrom(st().routing, 't1').length, 1, 'so exactly one send survives');
  assert.equal(sendsFrom(st().routing, 't1')[0].gain, 0.5, 'holding the gain it was created with');
}

function sendGainsAreEditableAndRemovable(): void {
  st().loadProject({ tracks: [mkTrack('t1')], clips: [] });
  const busId = st().addBus('Reverb');
  assert.equal(st().addSend('t1', busId, 0.25), null);

  st().setSendGain('t1', busId, 0.75);
  assert.equal(sendsFrom(st().routing, 't1')[0].gain, 0.75, 'the gain moves');

  st().removeSend('t1', busId);
  assert.deepEqual(sendsFrom(st().routing, 't1'), [], 'and the send can be dropped');
  assert.equal(outputOf(st().routing, 't1'), MASTER_ID, 'without disturbing the main output');
}

/* ── 5. One undo step per STRUCTURAL action; none per value ──────────────── */

function everyStructuralRoutingActionIsItsOwnUndoStep(): void {
  st().loadProject({ tracks: [mkTrack('t1')], clips: [] }); // resets history
  assert.equal(st()._undo.length, 0, 'a fresh load starts with empty history');

  // Back-to-back, inside the 300 ms coalescing window: each action calls
  // `beginUndoStep()` first, so each records its own step rather than folding
  // into the previous one.
  const busId = st().addBus('Drums');
  assert.equal(st()._undo.length, 1, 'addBus is one step');
  st().setTrackOutput('t1', busId);
  assert.equal(st()._undo.length, 2, 'setTrackOutput is its own step');
  st().addSend('t1', busId, 0.5);
  assert.equal(st()._undo.length, 3, 'addSend is its own step');

  st().undo();
  assert.deepEqual(sendsFrom(st().routing, 't1'), [], 'undo takes the send back');
  st().undo();
  assert.equal(outputOf(st().routing, 't1'), MASTER_ID, 'and then the output move');
  st().undo();
  assert.deepEqual(st().buses, [], 'and then the bus itself');
  assert.ok(!st().routing.nodes.some((n) => n.id === busId), 'graph and slice undo together');

  st().redo();
  assert.equal(st().buses.length, 1, 'redo puts the bus back');
  assert.ok(st().routing.nodes.some((n) => n.id === busId), 'in both places');
}

function valueActionsDoNotOpenAnUndoStepOfTheirOwn(): void {
  // A bus fader ride and a send-knob drag are CONTINUOUS gestures. If each
  // pointer move opened a step, one drag would fill the 100-entry history and
  // undo would walk back through it a pixel at a time.
  st().loadProject({ tracks: [mkTrack('t1')], clips: [] });
  const busId = st().addBus('Drums');
  assert.equal(st().addSend('t1', busId, 0.1), null);
  const steps = st()._undo.length;

  // The gesture's pointer-down cuts one step; every frame after folds into it.
  beginUndoStep();
  for (const v of [0.2, 0.3, 0.4, 0.5]) st().updateBus(busId, { volume: v });
  for (const v of [0.2, 0.3, 0.4]) st().setSendGain('t1', busId, v, { coalesce: true });
  assert.equal(st()._undo.length, steps + 1, 'the whole ride is ONE undo step');
  assert.equal(st().buses[0].volume, 0.5, 'and the last value is what stuck');
  assert.equal(sendsFrom(st().routing, 't1')[0].gain, 0.4);

  st().undo();
  assert.equal(st().buses[0].volume, 0.8, 'undo takes the whole ride back at once');
  assert.equal(sendsFrom(st().routing, 't1')[0].gain, 0.1, 'send gain included');
  st().redo();

  // A DISCRETE send edit — a typed value, a reset — still gets its own step.
  const before = st()._undo.length;
  st().setSendGain('t1', busId, 0.9);
  assert.equal(st()._undo.length, before + 1, 'a non-coalescing send edit is its own step');
  st().undo();
  assert.equal(sendsFrom(st().routing, 't1')[0].gain, 0.4, 'and undoes on its own');
}

function updateBusOnAnUnknownIdChangesNothing(): void {
  // `graphAddBus` is `ensureNode`, which CREATES — so an unguarded write here
  // would invent a node with no strip behind it: unplaceable by `wireRouting`
  // and reported as damage by `validateGraph`.
  st().loadProject({ tracks: [mkTrack('t1')], clips: [] });
  const before = st().routing;
  st().updateBus('never-existed', { name: 'Ghost', volume: 0.2 });
  assert.equal(st().routing, before, 'the graph object is not even replaced');
  assert.deepEqual(st().buses, [], 'and no strip is conjured');
  assert.deepEqual(validateGraph(st().routing), [], 'leaving a sane graph');
}

/* ── 6. Bus FX chains mirror the track ones ──────────────────────────────── */

function busEffectsMirrorTheTrackActions(): void {
  st().loadProject({ tracks: [mkTrack('t1')], clips: [] });
  const busId = st().addBus('Drums');
  const bus = (): EditorBus => st().buses.find((b) => b.id === busId) as EditorBus;

  assert.deepEqual(bus().fxChain, [], 'a new bus has an empty rack');
  st().addBusEffect(busId, 'compressor');
  assert.equal(bus().fxChain.length, 1, 'addBusEffect appends');
  const entryId = bus().fxChain[0].id;
  assert.equal(bus().fxChain[0].effect, 'compressor');
  assert.equal(bus().fxChain[0].enabled, true, 'enabled on arrival, like a track effect');
  assert.ok(Object.keys(bus().fxChain[0].params).length > 0, 'seeded with the catalog defaults');

  st().toggleBusEffect(busId, entryId);
  assert.equal(bus().fxChain[0].enabled, false, 'toggle bypasses');
  st().updateBusEffectParams(busId, entryId, { threshold: -12 });
  assert.equal(bus().fxChain[0].params.threshold, -12, 'params push through');
  st().removeBusEffect(busId, entryId);
  assert.deepEqual(bus().fxChain, [], 'and the entry can be removed');

  st().updateBus(busId, { volume: 0.4, mute: true, name: 'Drum Bus' });
  assert.equal(bus().volume, 0.4);
  assert.equal(bus().mute, true);
  assert.equal(bus().name, 'Drum Bus');
}

/* ── 7. Document state: snapshot + autosave round trip ───────────────────── */

function routingRidesInTheUndoSnapshot(): void {
  st().loadProject({ tracks: [mkTrack('t1')], clips: [] });
  const busId = st().addBus('Drums');
  // A bus RACK edit coalesces into the previous edit inside the 300 ms window,
  // exactly like a track rack edit; a real gesture opens its own step first.
  beginUndoStep();
  st().addBusEffect(busId, 'compressor');
  assert.equal(st().buses[0].fxChain.length, 1, 'the bus rack edit landed');
  st().undo();
  assert.equal(st().buses[0].fxChain.length, 0, 'a bus RACK edit is undoable, like a track rack edit');
  st().redo();
  assert.equal(st().buses[0].fxChain.length, 1, 'and redoable');
}

async function theAutosaveManifestCarriesRoutingAndBuses(): Promise<void> {
  initEditorAutosave();
  await flush(); // let the (empty) manifest read resolve and un-pause saving

  st().loadProject({ tracks: [mkTrack('t1'), mkTrack('t2')], clips: [] });
  const busId = st().addBus('Drums');
  st().setTrackOutput('t1', busId);
  st().addSend('t2', busId, 0.5);
  st().updateBus(busId, { volume: 0.6 });

  flushPendingAutosave();
  await flush(6);

  const raw = saveDir()?.files.get('manifest.json');
  assert.ok(raw, 'a manifest was written');
  const parsed = JSON.parse(raw as string) as { routing: unknown; buses: unknown[] };
  assert.ok(parsed.routing, 'the manifest carries the routing graph');
  assert.equal((parsed.buses as EditorBus[]).length, 1, 'and the bus slice');
  assert.equal((parsed.buses as EditorBus[])[0].volume, 0.6, 'with the bus fader value');

  // Wipe the document, then restore from those bytes.
  st().loadProject({ tracks: [mkTrack('gone')], clips: [] });
  assert.deepEqual(st().buses, [], 'the document really was replaced');

  await useAutosaveRecoveryStore.getState().restore();

  assert.equal(st().buses.length, 1, 'the bus came back');
  assert.equal(st().buses[0].id, busId, 'with its identity');
  assert.equal(st().buses[0].volume, 0.6, 'and its fader');
  assert.equal(outputOf(st().routing, 't1'), busId, 't1 is still routed into the bus');
  assert.equal(sendsFrom(st().routing, 't2')[0].gain, 0.5, 'and the send survived with its gain');
  assert.deepEqual(validateGraph(st().routing), [], 'the restored graph is sane');
}

/* ── 8. An old manifest (no routing key) still restores ──────────────────── */

async function anOldManifestWithoutRoutingStillRestores(): Promise<void> {
  const raw = JSON.parse(saveDir().files.get('manifest.json') as string) as Record<string, unknown>;
  delete raw.routing;
  delete raw.buses;
  raw.tracks = [mkTrack('old1'), mkTrack('old2')];
  raw.clips = [];
  saveDir().files.set('manifest.json', JSON.stringify(raw));

  await useAutosaveRecoveryStore.getState().restore();

  assert.deepEqual(st().buses, [], 'a pre-routing manifest restores with no buses');
  assert.deepEqual(nodeIds(), ['old1', 'old2', MASTER_ID].sort(), 'and a migrated graph');
  assert.equal(outputOf(st().routing, 'old1'), MASTER_ID, 'everything feeding the master');
  assert.deepEqual(validateGraph(st().routing), [], 'sanely');
}

theInitialDocumentIsAlreadyRouted();
aProjectWithNoRoutingIsMigratedOnLoad();
aLoadedGraphIsKeptButCompleted();
pruningReHomesRatherThanOrphans();
addTrackAndRemoveTrackMoveTheGraph();
removingABusReHomesWhatFedIt();
refusalsAreReturnedAndChangeNothing();
sendGainsAreEditableAndRemovable();
everyStructuralRoutingActionIsItsOwnUndoStep();
valueActionsDoNotOpenAnUndoStepOfTheirOwn();
updateBusOnAnUnknownIdChangesNothing();
busEffectsMirrorTheTrackActions();
routingRidesInTheUndoSnapshot();
await theAutosaveManifestCarriesRoutingAndBuses();
await anOldManifestWithoutRoutingStillRestores();

console.log('editorStore.routing: ok');
