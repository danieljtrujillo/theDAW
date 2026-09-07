import assert from 'node:assert/strict';
import { euclidPattern, genCell, generationOf, lifePopulation, sectionOf, type GenTile } from './loomGen.ts';
import { parseLoom, serializeLoom } from './loomScore.ts';
import { breedScores, fragmentScore, mutateScore } from './loomEvolve.ts';

const k = { role: 'kick' as const };
const s = { role: 'snare' as const };
const h = { role: 'hihat' as const };
const gen = (g: GenTile['gen'], alphabet: GenTile['alphabet'], span: number, opts: GenTile['opts'] = {}): GenTile =>
  ({ kind: 'gen', gen: g, alphabet, span, opts, roll: 0 });

// Euclidean rhythms: the classic counts, and rotation keeps the count.
{
  const e = euclidPattern(5, 16);
  assert.equal(e.filter(Boolean).length, 5);
  assert.equal(e[0], true, 'first hit lands on step 0');
  assert.equal(euclidPattern(3, 8).map((b) => (b ? 'x' : '.')).join(''), 'x..x..x.');
  assert.equal(euclidPattern(5, 16, 3).filter(Boolean).length, 5);
  assert.equal(euclidPattern(0, 8).some(Boolean), false);
}

// Fibonacci word over two symbols is the golden sequence, and drifts by lap.
{
  const t = gen('fib', [k, s], 13, { drift: 1 });
  const lap0 = Array.from({ length: 13 }, (_, i) => genCell(t, i, 0, 7)?.query?.role?.[0] ?? '.').join('');
  assert.equal(lap0, 'kskkskskkskks');
  const lap1 = Array.from({ length: 13 }, (_, i) => genCell(t, i, 1, 7)?.query?.role?.[0] ?? '.').join('');
  assert.equal(lap1, lap0.slice(1) + 'k', 'lap 1 is lap 0 shifted by the drift');
}

// Thue–Morse and Cantor dust.
{
  const tm = gen('fractal', [k, s], 8, { kind: 'thue' });
  assert.equal(Array.from({ length: 8 }, (_, i) => genCell(tm, i, 0, 1)?.query?.role?.[0]).join(''), 'ksskskks');
  const cd = gen('fractal', [k], 9, { kind: 'cantor', depth: 2 });
  assert.equal(Array.from({ length: 9 }, (_, i) => (genCell(cd, i, 0, 1)?.query ? 'x' : '.')).join(''), 'x.x...x.x');
}

// Life is deterministic per seed, differs per seed, and a form replays sections.
{
  const t = gen('life', [k, s, h], 16, { density: 0.4 });
  const a = Array.from({ length: 16 }, (_, i) => genCell(t, i, 3, 42)?.query?.role ?? '.');
  const b = Array.from({ length: 16 }, (_, i) => genCell(t, i, 3, 42)?.query?.role ?? '.');
  assert.deepEqual(a, b, 'same seed, same lap → same cells');
  const c = Array.from({ length: 16 }, (_, i) => genCell(t, i, 3, 43)?.query?.role ?? '.');
  assert.notDeepEqual(a, c, 'another seed rolls another world');
  assert.ok(lifePopulation(t, 42, 5) > 0, 'the world never goes silent');
  assert.equal(sectionOf('AABA', 5), 'A');
  assert.equal(generationOf('AABA', 1), 0, 'the second A replays the first A');
  assert.equal(generationOf('AABA', 2), 2);
  assert.equal(generationOf('AABA', 4), 4, 'the next cycle keeps evolving');
  const lapA1 = Array.from({ length: 16 }, (_, i) => genCell(t, i, 0, 9, 'AABA')?.query?.role ?? '.');
  const lapA2 = Array.from({ length: 16 }, (_, i) => genCell(t, i, 1, 9, 'AABA')?.query?.role ?? '.');
  assert.deepEqual(lapA1, lapA2, 'form AABA: laps 1 and 2 are the same A');
}

// Echo decays, accel warps, gliss sweeps.
{
  const e = gen('echo', [{ role: 'vocals' }], 12, { every: 3, decay: 6, depth: 3 });
  assert.equal(genCell(e, 0, 0, 1)?.gain, -0);
  assert.equal(genCell(e, 3, 0, 1)?.gain, -6);
  assert.equal(genCell(e, 6, 0, 1)?.gain, -12);
  assert.equal(genCell(e, 1, 0, 1)?.query, null);
  const a = gen('accel', [k], 8, { from: 1, to: 2 });
  assert.equal(genCell(a, 0, 0, 1)?.warp, 1);
  assert.equal(genCell(a, 7, 0, 1)?.warp, 0.5);
  const g = gen('gliss', [{ role: 'vocals' }], 5, { from: -12, to: 12 });
  assert.equal(genCell(g, 2, 0, 1)?.transpose, 0);
  assert.equal(genCell(g, 4, 0, 1)?.transpose, 12);
}

// Notation: every generator round-trips through the text.
{
  const text = `bpm 120
seed 7
form AABA
ramp bpm 120 150 8

lane drums 1/16 x16
  .  accel(; from=1 to=1.5):8 . . . . . . . . . . . . . .
  euclid(k s; hits=5 rotate=1) - - - - - - - - - - - - - - -

lane tex 1/8 x8
  life(<eacc:bass> v .; density=.3 rule=B36/S23) - - - - - - -

lane fib 1/16 x16 @target
  fib(k s) - - - - - - - fractal(k . s; kind=dragon) - - - gliss(v; from=0 to=7) - - -
`;
  const { score, errors } = parseLoom(text);
  assert.deepEqual(errors, []);
  assert.equal(score.seed, 7);
  assert.equal(score.form, 'AABA');
  assert.deepEqual(score.ramp, { param: 'bpm', from: 120, to: 150, laps: 8, curve: undefined });
  const drums = score.lanes[0];
  const rail = drums.rows[drums.rows.length - 1];
  assert.equal(rail[0]?.kind, 'gen');
  if (rail[0]?.kind === 'gen') {
    assert.equal(rail[0].gen, 'euclid');
    assert.equal(rail[0].span, 16);
    assert.equal(rail[0].opts.hits, 5);
    assert.deepEqual(rail[0].alphabet, [k, s]);
  }
  const upper = drums.rows[0][1];
  assert.equal(upper?.kind, 'gen');
  if (upper?.kind === 'gen') assert.equal(upper.opts.to, 1.5);
  const tex = score.lanes[1].rows[0][0];
  if (tex?.kind === 'gen') {
    assert.equal(tex.opts.rule, 'B36/S23');
    assert.deepEqual(tex.alphabet, [{ entry: 'eacc', role: 'bass' }, { role: 'vocals' }, null]);
  }
  const again = parseLoom(serializeLoom(score));
  assert.deepEqual(again.errors, []);
  assert.equal(serializeLoom(again.score), serializeLoom(score), 'generator round-trip');
  // Defaults (hits=5 rotate=1) are omitted on the way out; non-defaults stay.
  assert.match(serializeLoom(score), /euclid\(k s\)/);
  assert.match(serializeLoom(score), /life\(<eacc:bass> v \.; density=0\.3 rule=B36\/S23\)/);
  assert.match(serializeLoom(score), /seed 7/);
  assert.match(serializeLoom(score), /ramp bpm 120 150 8/);
  // Errors that a performer needs to see.
  assert.match(parseLoom('lane a\n  bogus(k):4').errors[0].message, /unknown generator/);
  assert.match(parseLoom('lane a\n  fib(k; hits):4').errors[0].message, /name=value/);
  assert.match(parseLoom('ramp bpm 10 20 3').errors[0].message, /20–300/);
}

// Evolution: mutate changes something, keeps kept lanes, and stays parseable;
// breed mixes two parents; fragment turns rails into frag generators.
{
  const { score } = parseLoom(`bpm 100
lane drums 1/16 x16
  k . h . s . h . k . h k s . h .
lane bass 1/8 x8
  b - . b . b - .
`);
  const child = mutateScore(score, 3, { intensity: 3, keep: ['bass'] });
  assert.deepEqual(child.lanes[1].rows, score.lanes[1].rows, 'kept lane untouched');
  assert.notEqual(serializeLoom(child), serializeLoom(score), 'something changed');
  assert.deepEqual(parseLoom(serializeLoom(child)).errors, [], 'the child parses');
  const same = mutateScore(score, 3, { intensity: 3, keep: ['bass'] });
  assert.equal(serializeLoom(same), serializeLoom(child), 'same seed → same child');
  const other = parseLoom(`bpm 100
lane drums 1/16 x16
  s s s s s s s s s s s s s s s s
lane keys 1/4 x4
  p p p p
`).score;
  const bred = breedScores(score, other, 5);
  assert.deepEqual(parseLoom(serializeLoom(bred)).errors, []);
  const drumRail = bred.lanes[0].rows[bred.lanes[0].rows.length - 1];
  assert.ok(drumRail.some((t) => t?.kind === 'shard' && t.query.role === 'snare'), 'the child carries the partner\'s snares');
  const frag = fragmentScore(score);
  const fr = frag.lanes[0].rows[0][0];
  assert.equal(fr?.kind, 'gen');
  if (fr?.kind === 'gen') { assert.equal(fr.gen, 'frag'); assert.equal(fr.span, 16); }
  assert.deepEqual(parseLoom(serializeLoom(frag)).errors, []);
}

console.log('loomGen: all assertions passed');
