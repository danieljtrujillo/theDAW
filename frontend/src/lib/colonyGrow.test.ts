import assert from 'node:assert/strict';
import { parseColony, serializeColony, STARTER_COLONY, walkNodes } from './colony.ts';
import { allKeys, growColony, RIPEN_LAPS, vitalityOf, WITHER_LAPS, type Activity } from './colonyGrow.ts';

// The seed is one spore and declares growth.
const seed = parseColony(STARTER_COLONY);
assert.deepEqual(seed.errors, []);
assert.equal(seed.score.root.nodes.length, 1);
assert.deepEqual(seed.score.grow, { rate: 0.5, max: 18 });

// Eighty laps of everyone firing: the colony fills toward max, never past it,
// every generation parses and round-trips, and no wire dangles. Births ripen
// before they bud; deaths wither before they go.
{
  let score = seed.score;
  const activity: Activity = { fires: {}, born: {}, dying: {} };
  let peak = 0;
  let envelops = 0;
  for (let lap = 0; lap < 80; lap += 1) {
    for (const k of allKeys(score.root)) activity.fires[k] = lap;
    const res = growColony(score, lap, activity);
    for (const b of res.born) activity.born[b.key] = lap;
    for (const w of res.withering) activity.dying[w] = lap + WITHER_LAPS;
    for (const d of res.died) { delete activity.dying[d]; delete activity.born[d]; }
    for (const m of res.moved) { activity.born[m.to] = activity.born[m.from] ?? lap; delete activity.born[m.from]; }
    envelops += res.moved.length;
    score = res.score;
    const n = walkNodes(score.root).length;
    peak = Math.max(peak, n);
    assert.ok(n <= 18 + 2, `lap ${lap}: ${n} cells`);
    const text = serializeColony(score);
    const again = parseColony(text);
    assert.deepEqual(again.errors, [], `lap ${lap}: ${again.errors.map((e) => e.message).join(' / ')}`);
    assert.equal(serializeColony(again.score), text, `lap ${lap} round-trip`);
    for (const w of walkNodes(score.root)) assert.equal(w.graph.nodes.filter((x) => x.id === w.node.id).length, 1, `duplicate id ${w.node.id}`);
  }
  assert.ok(peak >= 8, `grew to ${peak} cells`);
  assert.ok(score.root.nodes.some((n) => n.kind === 'loop'), 'keeps a loop');
  // Grain 8 makes long loops: nothing shorter than 2 beats but percussion.
  for (const w of walkNodes(score.root)) if (w.node.kind === 'loop' && !['kick', 'snare', 'hihat', 'cymbals', 'toms', 'vocals'].includes(w.node.query.role ?? '')) assert.ok(w.node.beats >= 8, `${w.node.id} is ${w.node.beats} beats`);
  void envelops;
}

// Deterministic: the same inputs grow the same colony.
{
  const act: Activity = { fires: { spore: 3 }, born: {}, dying: {} };
  const a = growColony(seed.score, 3, act);
  const b = growColony(seed.score, 3, act);
  assert.equal(serializeColony(a.score), serializeColony(b.score));
}

// BUD forces a birth off the chosen cell even at rate 0, and never withers.
{
  const res = growColony({ ...seed.score, grow: { rate: 0, max: 18 } }, 0, { fires: {}, born: {}, dying: {} }, { force: 'spore' });
  assert.ok(res.born.length >= 1 || res.changed.includes('spore'), 'a bud makes a cell or a wire');
  assert.deepEqual(res.died, []);
  assert.deepEqual(res.withering, []);
}

// Wither: an orphan is marked dying once it is old enough, and only removed when its lap comes.
{
  const text = `grow 1 max=18\nmeter 4/4\nrule pulse = euclid(hits=2 steps=4)\nloop kick = k beats=1\nloop lost = s beats=1\npulse -> kick\n`;
  const { score } = parseColony(text);
  const act: Activity = { fires: {}, born: {}, dying: {} };
  let marked = -1;
  let lap = RIPEN_LAPS;
  for (; lap < 40 && marked < 0; lap += 1) {
    act.fires.kick = lap;
    const res = growColony(score, lap, act);
    if (res.withering.includes('lost')) { marked = lap; act.dying.lost = lap + WITHER_LAPS; }
    assert.deepEqual(res.died, [], 'nothing is removed before it withers');
  }
  assert.ok(marked >= 0, 'the orphan withers');
  assert.equal(vitalityOf(act, 'lost', marked + 1), 0.5);
  assert.deepEqual(growColony(score, marked + 1, act).died, [], 'still fading');
  assert.deepEqual(growColony(score, marked + WITHER_LAPS, act).died, ['lost']);
}

// Envelop: a colony forms AROUND a loop; the loop moves inside and keeps its wires.
{
  const text = `grow 1 max=18\nmeter 4/4\nrule pulse = euclid(hits=2 steps=4)\nloop kick = k beats=1\nloop bass = b beats=4\npulse -> kick\nkick -> kick\nkick -> bass\n`;
  const { score } = parseColony(text);
  let found = false;
  for (let lap = RIPEN_LAPS; lap < 200 && !found; lap += 1) {
    const res = growColony(score, lap, { fires: { kick: lap }, born: {}, dying: {} }, { force: 'kick' });
    if (res.moved.length) {
      found = true;
      const mv = res.moved[0];
      assert.equal(mv.from, 'kick');
      assert.match(mv.to, /^[a-z]+\/kick$/);
      const col = res.score.root.nodes.find((n) => n.kind === 'colony');
      assert.ok(col && col.kind === 'colony');
      if (col && col.kind === 'colony') {
        assert.ok(col.graph.nodes.some((n) => n.id === 'kick'), 'the loop is inside');
        assert.ok(col.graph.nodes.some((n) => n.kind === 'rule'), 'with its own pacemaker');
        assert.ok(col.graph.edges.some((e) => e.from === 'kick' && e.to === 'kick'), 'the repeat came along');
      }
      assert.ok(res.score.root.edges.some((e) => e.from === 'pulse' && e.to === col!.id), 'what pointed at the loop now starts the colony');
      assert.ok(res.score.root.edges.some((e) => e.from === col!.id && e.to === 'bass'), 'what the loop pointed at now follows the colony');
      assert.ok(!res.score.root.nodes.some((n) => n.id === 'kick'), 'and it is gone from the root');
      const again = parseColony(serializeColony(res.score));
      assert.deepEqual(again.errors, []);
    }
  }
  assert.ok(found, 'a forced bud eventually envelops');
}

// Vitality ripens and withers.
{
  const act: Activity = { fires: {}, born: { a: 10 }, dying: { b: 12 } };
  assert.equal(vitalityOf(act, 'a', 10), 0);
  assert.equal(vitalityOf(act, 'a', 10 + RIPEN_LAPS / 2), 0.5);
  assert.equal(vitalityOf(act, 'a', 20), 1);
  assert.equal(vitalityOf(act, 'b', 12), 0);
  assert.equal(vitalityOf(act, 'b', 11), 0.5);
  assert.equal(vitalityOf(act, 'c', 0), 1);
}

console.log('colonyGrow: all assertions passed');
