import assert from 'node:assert/strict';
import { barSeconds, groupStarts, parseColony, serializeColony, STARTER_COLONY, walkNodes } from './colony.ts';

// The starter parses, has the shapes the picture promises, and round-trips.
{
  const { score, errors } = parseColony(STARTER_COLONY);
  assert.deepEqual(errors, []);
  assert.equal(score.bpm, 120);
  assert.equal(score.seed, 11);
  assert.deepEqual(score.root.meter, { num: 4, den: 4, groups: [] });
  const kinds = score.root.nodes.map((n) => n.kind);
  assert.deepEqual(kinds, ['loop', 'loop', 'loop', 'rule', 'rule', 'gate', 'mod', 'colony']);
  const kick = score.root.nodes[0];
  if (kick.kind === 'loop') { assert.equal(kick.beats, 8); assert.equal(kick.hold, true); assert.equal(kick.query.role, 'drums'); assert.equal(kick.query.beats, 8); }
  const seven = score.root.nodes[7];
  assert.equal(seven.kind, 'colony');
  if (seven.kind === 'colony') {
    assert.deepEqual(seven.graph.meter, { num: 7, den: 8, groups: [3, 2, 2] });
    assert.equal(seven.graph.nodes.length, 2);
    assert.deepEqual(seven.graph.edges, [{ from: 'tick', to: 'hat', on: undefined }]);
  }
  // Chains expand into edges; on= filters survive.
  assert.deepEqual(score.root.edges, [
    { from: 'pulse', to: 'kick', on: undefined },
    { from: 'swarm', to: 'bass', on: 0 },
    { from: 'swarm', to: 'maybe', on: undefined },
    { from: 'maybe', to: 'dark', on: undefined },
    { from: 'dark', to: 'word', on: undefined },
    { from: 'pulse', to: 'seven', on: 0 },
  ]);
  const text = serializeColony(score);
  const again = parseColony(text);
  assert.deepEqual(again.errors, []);
  assert.equal(serializeColony(again.score), text, 'round-trip fixed point');
  assert.match(text, /colony seven meter=7\/8 groups=3\+2\+2 \{/);
  assert.match(text, /swarm -> bass on=0/);
  assert.equal(walkNodes(score.root).length, 10);
}

// Meter arithmetic: 7/8 at 120 BPM is 3.5 beats; groups accent 3+2+2.
{
  assert.equal(barSeconds({ num: 7, den: 8, groups: [] }, 0.5), 1.75);
  assert.equal(barSeconds({ num: 4, den: 4, groups: [] }, 0.5), 2);
  assert.deepEqual(groupStarts({ num: 7, den: 8, groups: [3, 2, 2] }, 7), [0, 3, 5]);
  assert.deepEqual(groupStarts({ num: 11, den: 8, groups: [3, 3, 3, 2] }, 22), [0, 6, 12, 18]);
  assert.deepEqual(groupStarts({ num: 4, den: 4, groups: [] }, 16), [0]);
}

// Fractal nesting: a colony in a colony in a colony, each with its own meter and tempo.
{
  const text = `bpm 100
meter 5/4 groups=3+2
rule a = fib(steps=10)
colony b meter=7/8 tempo=1.5 {
  rule c = euclid(hits=3 steps=7)
  colony d meter=11/8 groups=3+3+3+2 tempo=0.5 {
    loop e = <song:bass> beats=4
    rule f = rand(steps=11 p=.5)
    f -> e
  }
  c -> d
}
a -> b
`;
  const { score, errors } = parseColony(text);
  assert.deepEqual(errors, []);
  const b = score.root.nodes[1];
  assert.equal(b.kind, 'colony');
  if (b.kind === 'colony') {
    assert.equal(b.graph.tempo, 1.5);
    const d = b.graph.nodes[1];
    assert.equal(d.kind, 'colony');
    if (d.kind === 'colony') { assert.deepEqual(d.graph.meter, { num: 11, den: 8, groups: [3, 3, 3, 2] }); assert.equal(d.graph.tempo, 0.5); }
  }
  const again = parseColony(serializeColony(score));
  assert.deepEqual(again.errors, []);
  assert.equal(serializeColony(again.score), serializeColony(score));
}

// Errors a performer needs to see.
{
  assert.match(parseColony('loop x = k\nx -> nope').errors[0].message, /no such node/);
  assert.match(parseColony('meter 7/8 groups=3+3').errors[0].message, /add up to 7/);
  assert.match(parseColony('colony z meter=7/8 {\nloop x = k').errors.at(-1)!.message, /closing \}/);
  assert.match(parseColony('rule r = bogus(steps=4)').errors[0].message, /rule needs a generator/);
  assert.match(parseColony('gate g = 60').errors[0].message, /\?60/);
  assert.match(parseColony('wat').errors[0].message, /unknown line/);
}

// The shipped colony sample parses clean and round-trips.
{
  const { LOOM_TEMPLATES } = await import('../data/loomTemplates.ts');
  for (const t of LOOM_TEMPLATES.filter((x) => x.mode === 'colony')) {
    const { score, errors } = parseColony(t.text);
    assert.deepEqual(errors, [], `${t.name}: ${errors.map((e) => `line ${e.line}: ${e.message}`).join(' / ')}`);
    assert.ok(score.root.nodes.some((n) => n.kind === 'colony'), `${t.name} nests a colony`);
    const again = parseColony(serializeColony(score));
    assert.deepEqual(again.errors, []);
    assert.equal(serializeColony(again.score), serializeColony(score), `${t.name} round-trip`);
  }
}

console.log('colony: all assertions passed');
