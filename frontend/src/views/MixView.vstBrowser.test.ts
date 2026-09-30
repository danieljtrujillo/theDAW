/**
 * The VST3 browser in MIX is where an unpaired LAN device learns how to pair
 * (PAIR_THIS_DEVICE_TEXT from vstStore). It rendered that instruction as a
 * 10px italic line inside an `opacity-30` block, next to an 8px mono
 * "host: pedalboard" label and 10px/8px-mono plugin tiles, so the one
 * sentence the pairing fix exists to show could not be read.
 *
 * MixView needs the full store tree mounted to render, so per the house
 * pattern for a component-only fix (see Shell.qrcode.test.ts) this asserts
 * the VST branch at SOURCE level.
 *
 * Run: `npx tsx src/views/MixView.vstBrowser.test.ts`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'MixView.tsx'),
  'utf8',
);

const start = source.indexOf(") : p.activeCategory === 'vst' ? (");
const end = source.indexOf(") : p.activeCategory === 'plugins' ? (", start);
assert.ok(start > 0 && end > start, 'the VST branch of the MIX browser is found');
const vstBranch = source.slice(start, end);

// No text under 12px anywhere in the VST browser: no arbitrary px sizes below
// 12 and no small mono labels.
const small = [...vstBranch.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)]
  .map((m) => Number(m[1]))
  .filter((px) => px < 12);
assert.deepEqual(small, [], 'every VST browser label is 12px or larger');
assert.doesNotMatch(vstBranch, /font-mono/, 'VST browser labels are bold sans');

// The empty-state line (where the pairing instruction lands) is readable:
// its own element and every wrapper around it carry no opacity fade and no
// italic, and the text itself is bold.
const emptyAt = vstBranch.indexOf('vstBrowserEmptyText(');
assert.ok(emptyAt > 0, 'the empty-state text is rendered in the VST branch');
const emptyBlockStart = vstBranch.lastIndexOf('p.vstPlugins.length === 0 ?', emptyAt);
assert.ok(emptyBlockStart > 0, 'the empty-state block is found');
const emptyBlock = vstBranch.slice(emptyBlockStart, emptyAt);
assert.doesNotMatch(emptyBlock, /\bopacity-\d+/, 'the pairing instruction is not faded');
assert.doesNotMatch(emptyBlock, /\bitalic\b/, 'the pairing instruction is not italic');
const emptySpan = emptyBlock.slice(emptyBlock.lastIndexOf('<span'));
assert.match(emptySpan, /\bfont-(semibold|bold)\b/, 'the pairing instruction is bold');
assert.match(emptySpan, /\btext-(sm|xs|base)\b/, 'the pairing instruction has a readable size');

console.log('MixView.vstBrowser.test.ts: all assertions passed');
