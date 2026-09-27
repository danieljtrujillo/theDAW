/**
 * A loaded deck's Eject pad pulses red. DJView puts `dj-eject-heartbeat` on the
 * pad while the deck holds a track; this suite pins that index.css defines that
 * class where SlidePad's unlit utilities and the theme remaps cannot grey it
 * out, that its edge keeps the accent-border floor's solid rose step on dark
 * and light themes, that the pulse never grows the pad past its cell, and that
 * reduced motion holds it still.
 *
 * Run: npx tsx src/views/djEjectHeartbeat.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(SRC, 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const dj = readFileSync(join(SRC, 'views', 'DJView.tsx'), 'utf8');

/** Every top-level block of the stylesheet: its prelude and its body. */
const blocks: Array<{ prelude: string; body: string }> = [];
for (let i = 0; i < css.length; ) {
  const open = css.indexOf('{', i);
  if (open < 0) break;
  let depth = 0;
  let close = open;
  for (; close < css.length; close += 1) {
    if (css[close] === '{') depth += 1;
    else if (css[close] === '}' && --depth === 0) break;
  }
  blocks.push({ prelude: css.slice(i, open).trim(), body: css.slice(open + 1, close) });
  i = close + 1;
}

assert.match(dj, /hasTrack \? 'dj-eject-heartbeat' : ''/, 'DJView marks the Eject pad of a loaded deck');

const rule = blocks.find((b) => b.prelude === '.dj-eject-heartbeat');
assert.ok(rule, '.dj-eject-heartbeat is a top-level rule, outside every @layer');
assert.match(rule.body, /animation:\s*dj-eject-heartbeat\b/, 'the pad runs the heartbeat');

const frames = blocks.find((b) => b.prelude === '@keyframes dj-eject-heartbeat');
assert.ok(frames, 'the heartbeat keyframes exist');
for (const prop of ['color', 'border-color', 'background-color', 'box-shadow']) {
  assert.match(frames.body, new RegExp(`(^|[\\s;{])${prop}\\s*:`), `the keyframes carry ${prop}, which beats the unlit utilities`);
}
assert.doesNotMatch(frames.body, /transform|scale/, 'the pulse never scales the pad past its cell');
assert.doesNotMatch(frames.body, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'the reds come from the theme variables');

// The edge is solid, in the step the accent-border floor gives a rose control
// on each theme (it clears 3:1 there); only the fill and the glow pulse.
const edges = [...frames.body.matchAll(/(?:^|[\s;{])border-color\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
assert.ok(edges.length > 0 && edges.every((v) => v === 'var(--eject-edge)'), `the edge is drawn solid in --eject-edge (${edges.join(' | ')})`);
/** The colour variable the floor sets on a `.border-rose-500/30` control. */
const floorStep = (scope: string) => {
  const floor = blocks.find((b) => b.prelude.startsWith(`.edit-theme-scope${scope} :is(button`) && b.prelude.includes('.border-rose-500\\/30'));
  assert.ok(floor, `the accent-border floor has a rose rule (${scope || 'light'})`);
  return /border-color:\s*var\((--color-rose-\d+)/.exec(floor.body)?.[1];
};
const edgeOf = (b: { body: string } | undefined) => (b ? /--eject-edge:\s*var\((--color-rose-\d+)/.exec(b.body)?.[1] : undefined);
const light = blocks.find((b) => b.prelude === '.edit-theme-scope[data-et-light="1"] .dj-eject-heartbeat');
assert.equal(floorStep(':not([data-et-light="1"])'), '--color-rose-400');
assert.equal(edgeOf(rule), floorStep(':not([data-et-light="1"])'), 'dark themes draw the edge in the floor step, rose-400');
assert.equal(floorStep('[data-et-light="1"]'), '--color-rose-700');
assert.equal(edgeOf(light), floorStep('[data-et-light="1"]'), 'light themes draw the edge in the floor step, rose-700');

const reduced = blocks.find((b) => b.prelude.startsWith('@media (prefers-reduced-motion: reduce)') && b.body.includes('.dj-eject-heartbeat'));
assert.ok(reduced, 'reduced motion has a rule for the pad');
assert.match(reduced.body, /animation(-play-state)?:\s*(paused|none)/, 'reduced motion holds the pad still');

console.log('dj eject heartbeat: defined, unlayered, unscaled, still under reduced motion');
