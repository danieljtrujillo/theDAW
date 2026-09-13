/**
 * A counter-zoom wrapper must not scale its own size by the layout zoom.
 *
 * The Shell renders under CSS `zoom: var(--layout-zoom)`. A panel that needs
 * unzoomed pointer math (the LEARN graphs) counter-zooms with
 * `zoom: calc(1 / var(--layout-zoom))` and keeps its size at 100%. A wrapper
 * sized `calc(100% * var(--layout-zoom))` covers `zoom` of its panel in each
 * direction below zoom 1 and overflows it above zoom 1, under Chromium's
 * standardized CSS zoom and under its legacy zoom. At zoom 0.85 the LEARN
 * graph canvas measured 1136x476 inside a 1337x560 panel.
 *
 * This reads every .tsx under src and fails on any element that counter-zooms
 * and also multiplies its width or height by --layout-zoom.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const tsxFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });

const COUNTER_ZOOM = /zoom:\s*['"`]calc\(1\s*\/\s*var\(--layout-zoom/;
const SCALED_SIZE = /(width|height):\s*['"`]calc\(100%\s*\*\s*var\(--layout-zoom/;

const offenders: string[] = [];
for (const file of tsxFiles(srcRoot)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!COUNTER_ZOOM.test(line)) return;
    // A style object spans a few lines; check the counter-zoom line and the
    // lines around it, which is where its width and height are written.
    const window = lines.slice(Math.max(0, i - 4), i + 5).join('\n');
    if (SCALED_SIZE.test(window)) offenders.push(`${relative(srcRoot, file)}:${i + 1}`);
  });
}

assert.deepEqual(
  offenders,
  [],
  'a counter-zoomed wrapper multiplies its size by --layout-zoom, so it fills only ' +
    'part of its panel below zoom 1 and overflows above it: ' +
    offenders.join(', '),
);

const lineage = readFileSync(join(srcRoot, 'components', 'library', 'LineageModal.tsx'), 'utf8');
assert.match(
  lineage,
  /zoom:\s*'calc\(1 \/ var\(--layout-zoom, 1\)\)',\s*width:\s*'100%',\s*height:\s*'100%'/,
  'the LEARN graph wrapper must counter-zoom and stay 100% of its panel',
);

console.log('lineage wrapper guards: ok');
