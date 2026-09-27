/**
 * A loaded deck's Eject pad pulses red. DJView puts `dj-eject-heartbeat` on the
 * pad while the deck holds a track; this suite pins that index.css defines that
 * class where SlidePad's unlit utilities and the theme remaps cannot grey it
 * out, that the pulse never grows the pad past its cell, and that reduced
 * motion holds it still.
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

const reduced = blocks.find((b) => b.prelude.startsWith('@media (prefers-reduced-motion: reduce)') && b.body.includes('.dj-eject-heartbeat'));
assert.ok(reduced, 'reduced motion has a rule for the pad');
assert.match(reduced.body, /animation(-play-state)?:\s*(paused|none)/, 'reduced motion holds the pad still');

console.log('dj eject heartbeat: defined, unlayered, unscaled, still under reduced motion');
