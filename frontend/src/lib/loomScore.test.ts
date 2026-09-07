import assert from 'node:assert/strict';

import { parseLoom, serializeLoom, STARTER_SCORE, type LoomTile } from './loomScore.ts';

const shardAt = (tiles: (LoomTile | null)[], i: number) => {
  const t = tiles[i];
  if (!t || t.kind !== 'shard') throw new Error(`expected a shard at ${i}`);
  return t;
};

// The starter score parses clean and lands where the picture says.
{
  const { score, errors } = parseLoom(STARTER_SCORE);
  assert.deepEqual(errors, []);
  assert.equal(score.bpm, 120);
  assert.equal(score.key, 'follow');
  assert.deepEqual(score.lanes.map((l) => l.name), ['drums', 'bass', 'vox']);
  const drums = score.lanes[0];
  assert.equal(drums.div, 16);
  assert.equal(drums.length, 16);
  assert.equal(drums.rows.length, 2);
  assert.deepEqual(drums.rows[0][6], { kind: 'chance', pct: 50 });
  assert.deepEqual(drums.rows[0][14], { kind: 'cycle', period: 4, laps: [2] });
  assert.equal(shardAt(drums.rows[1], 0).query.role, 'kick');
  assert.equal(shardAt(drums.rows[1], 2).query.role, 'hihat');
}

// Ties extend the previous shard and come back out as ties.
{
  const { score, errors } = parseLoom('lane bass 1/8 x8\n  b:2 - . b . b:2 - .\n');
  assert.deepEqual(errors, []);
  const rail = score.lanes[0].rows[0];
  assert.equal(shardAt(rail, 0).steps, 3);
  assert.equal(rail[1], null);
  assert.equal(shardAt(rail, 3).steps, 1);
  // On the rail the length rides as ties; the parse of that is the same score.
  const text = serializeLoom(score);
  assert.deepEqual(text.split('\n')[1].trim().split(/\s+/).slice(0, 3), ['b', '-', '-']);
  assert.equal(shardAt(parseLoom(text).score.lanes[0].rows[0], 0).steps, 3);
  // In an upper row (or past the lane end) ties cannot carry it, so `:N` does.
  const upper = parseLoom('lane a 1/16 x4\n  v:3 . . .\n  k . . k:2\n');
  assert.deepEqual(upper.errors, []);
  const out = serializeLoom(upper.score);
  assert.match(out, /v:3/);
  assert.match(out, /k:2/);
  assert.equal(shardAt(parseLoom(out).score.lanes[0].rows[0], 0).steps, 3);
  assert.equal(shardAt(parseLoom(out).score.lanes[0].rows[1], 3).steps, 2);
}

// Text → score → text is a fixed point.
{
  const once = serializeLoom(parseLoom(STARTER_SCORE).score);
  const twice = serializeLoom(parseLoom(once).score);
  assert.equal(twice, once);
}

// Pins, query literals (with comparators and spaces), locks, jumps, suffixes.
{
  const src = [
    'key F#m',
    'lane a 1/16 x4',
    '  =gain-6,cut.35 +trans12 ->b .',
    '  <eacc:bass#12> {role=drums energy>0.7 entry!=eacc} k^ <#song__mix__3x4>:2^4',
    'lane b 1/16 x4 @target',
    '  s s s s',
  ].join('\n');
  const { score, errors } = parseLoom(src);
  assert.deepEqual(errors, []);
  assert.equal(score.key, 'F#');
  assert.equal(score.scale, 'minor');
  const [a, b] = score.lanes;
  assert.equal(b.isTarget, true);
  assert.deepEqual(a.rows[0][0], { kind: 'lock', mode: 'abs', params: { gain: -6, cutoff: 0.35 } });
  assert.deepEqual(a.rows[0][1], { kind: 'lock', mode: 'rel', params: { transpose: 12 } });
  assert.deepEqual(a.rows[0][2], { kind: 'jump', target: 'b' });
  assert.deepEqual(shardAt(a.rows[1], 0).query, { entry: 'eacc', role: 'bass', bar: 12 });
  assert.deepEqual(shardAt(a.rows[1], 1).query, { role: 'drums', energyMin: 0.7, excludeEntry: 'eacc' });
  assert.equal(shardAt(a.rows[1], 2).roll, 1);
  const pinned = shardAt(a.rows[1], 3);
  assert.equal(pinned.query.shardId, 'song__mix__3x4');
  assert.equal(pinned.steps, 2);
  assert.equal(pinned.roll, 4);
  const text = serializeLoom(score);
  for (const needle of ['=gain-6,cut.35', '+trans12', '->b', '<eacc:bass#12>', '{role=drums entry!=eacc energy>.7}', '<#song__mix__3x4>:2^4']) {
    assert.ok(text.includes(needle), `serialized text should contain ${needle}\n${text}`);
  }
}

// The errors a performer needs.
{
  assert.ok(parseLoom('lane a 1/16 x4\n  k ->nowhere . .\n').errors.some((e) => /nowhere/.test(e.message)));
  assert.ok(parseLoom('lane a 1/16 x4 @target\n  k . . .\n').errors.some((e) => /nothing would ever play/.test(e.message)));
  assert.match(parseLoom('  k . . .\n').errors[0].message, /needs a lane/);
  assert.match(parseLoom('lane a 1/16 x2\n  k . . .\n').errors[0].message, /row has 4 steps/);
  assert.match(parseLoom('bpm 900\n').errors[0].message, /20–300/);
  assert.match(parseLoom('lane a 1/16 x4\n  ?x . . .\n').errors[0].message, /chance gate/);
}

// Every shipped template parses clean, names real lanes, and round-trips.
{
  const { LOOM_TEMPLATES } = await import('../data/loomTemplates.ts');
  assert.ok(LOOM_TEMPLATES.length >= 4);
  assert.equal(LOOM_TEMPLATES.filter((t) => t.level === 'simple').length, 2);
  assert.equal(LOOM_TEMPLATES.filter((t) => t.level === 'complex').length, 2);
  for (const t of LOOM_TEMPLATES) {
    const { score, errors } = parseLoom(t.text);
    assert.deepEqual(errors, [], `${t.name}:\n${errors.map((e) => `line ${e.line}: ${e.message}`).join('\n')}`);
    assert.ok(score.lanes.length >= 3, `${t.name} has ${score.lanes.length} lanes`);
    assert.ok(score.lanes.some((l) => !l.isTarget), `${t.name} needs a channel lane`);
    const again = parseLoom(serializeLoom(score));
    assert.deepEqual(again.errors, [], `${t.name} re-parse`);
    assert.equal(serializeLoom(again.score), serializeLoom(score), `${t.name} round-trip`);
    // Quoted song titles survive the literal syntax.
    for (const lane of score.lanes) for (const row of lane.rows) for (const tile of row) {
      if (tile && tile.kind === 'shard' && tile.query.entry) assert.ok(!/["']/.test(tile.query.entry), `${t.name}: quotes leaked into ${tile.query.entry}`);
    }
  }
  const complex = LOOM_TEMPLATES.filter((t) => t.level === 'complex');
  for (const t of complex) {
    const { score } = parseLoom(t.text);
    const kinds = new Set(score.lanes.flatMap((l) => l.rows.flatMap((r) => r.filter(Boolean).map((x) => x!.kind))));
    for (const k of ['shard', 'chance', 'cycle', 'lock', 'jump']) assert.ok(kinds.has(k as never), `${t.name} should use a ${k} tile`);
    assert.ok(score.lanes.some((l) => l.isTarget), `${t.name} should have a @target lane`);
  }
}

console.log('loomScore: all assertions passed');
