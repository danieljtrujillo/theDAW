/**
 * Contract regression for the Edit Tool Stack module pages
 * (frontend/public/edit-modules/*.html):
 *   - every catalogued page (and the generic tool page) speaks the host
 *     postMessage protocol EffectGuiStage relies on;
 *   - every `effect` id a page posts exists in the backend tool stack;
 *   - the Character FX page posts exactly the knob names its macros declare
 *     (BACKLOG FX-001: two of three modes used to send names the backend
 *     never read, so ten of fifteen knobs did nothing).
 * Run with:  npx tsx src/components/audio/effects/editModulesContract.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STUDIO_MODULES } from '../../../lib/moduleCatalog.ts';
import { ALL_EDIT_TOOL_IDS, CHARACTER_MACRO_KNOBS, EDIT_TOOL_FAMILIES } from './editToolStack.ts';

const here = dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = join(here, '..', '..', '..', '..', 'public', 'edit-modules');
const read = (file: string) => readFileSync(join(MODULES_DIR, file), 'utf8');

assert.equal(EDIT_TOOL_FAMILIES.reduce((n, f) => n + f.tools.length, 0), 49, 'the Edit Tool Stack mirrors 49 tools');

/* ── host protocol on every catalogued page + the generic page ───────────── */
// EffectGuiStage's contract: receive 'thedaw-audio' (load paused), obey
// 'thedaw-transport' play/pause, echo 'thedaw-transport-state'. Buffer-source
// pages do that via prepareFile(); eq/dynamics do it through their <audio>
// element, so the loader function name itself is not part of the contract.
const HOST_TOKENS = ['thedaw-audio', "'thedaw-transport'", 'thedaw-transport-state'];
const pages = [...new Set([...STUDIO_MODULES.map((m) => m.file), 'parametric-eq.html', 'tool.html'])];
for (const file of pages) {
  const html = read(file);
  for (const tok of HOST_TOKENS) assert.ok(html.includes(tok), `${file}: missing host protocol token ${tok}`);
  assert.ok(html.includes('module-kit.js'), `${file}: should load the shared module kit (keyboard/aria for custom controls)`);
}

/* ── every posted effect id is a real tool ───────────────────────────────── */
const effectLiteral = /(?:fd|formData)\.append\(\s*['"]effect['"]\s*,\s*['"]([a-z_]+)['"]\s*\)/g;
for (const file of readdirSync(MODULES_DIR).filter((f) => f.endsWith('.html'))) {
  const html = read(file);
  for (const m of html.matchAll(effectLiteral)) {
    assert.ok(ALL_EDIT_TOOL_IDS.has(m[1]), `${file}: posts unknown tool id "${m[1]}"`);
  }
}

/* ── FX-001: Character FX knob names == backend macro knobs ──────────────── */
const charFx = read('character-fx.html');
const modeMap = charFx.match(/const MODE_TO_EFFECT\s*=\s*(\{[\s\S]*?\});/);
assert.ok(modeMap, 'character-fx.html: MODE_TO_EFFECT table missing');
const knobMap = charFx.match(/const BACKEND_KNOBS\s*=\s*(\{[\s\S]*?\});/);
assert.ok(knobMap, 'character-fx.html: BACKEND_KNOBS table missing');
const modeToEffect = new Function(`return ${modeMap![1]}`)() as Record<string, string>;
const backendKnobs = new Function(`return ${knobMap![1]}`)() as Record<string, string[]>;
const macroIds = Object.keys(CHARACTER_MACRO_KNOBS);
assert.deepEqual(Object.values(modeToEffect).sort(), macroIds.sort(), 'character-fx.html exposes every Character-FX macro');
for (const [effect, knobs] of Object.entries(CHARACTER_MACRO_KNOBS)) {
  assert.deepEqual(backendKnobs[effect], [...knobs], `character-fx.html: ${effect} must post exactly ${knobs.join(', ')}`);
}
for (const stale of ['drive', 'bias', 'warmth', 'crackle', 'rumble', 'filtering']) {
  assert.ok(!Object.values(backendKnobs).flat().includes(stale), `character-fx.html still posts the phantom knob "${stale}"`);
}

console.log('edit-modules contract regression passed');
