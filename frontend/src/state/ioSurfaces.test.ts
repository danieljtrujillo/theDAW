/**
 * The surface registry is a promise to the user: every row the I/O menu draws
 * under "Per-surface" claims that changing it changes a device somewhere. This
 * suite makes that claim checkable — each id has to be read by real code
 * outside the registry, or the row is a control that does nothing.
 *
 * It fails in the useful direction too: adding a surface here and forgetting to
 * wire it up is caught before it ships as a dead dropdown.
 *
 * Run: npx tsx src/state/ioSurfaces.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GLOBAL_SLOT_FOR_KIND, IO_SURFACES, surfaceById } from './ioSurfaces.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['ioSurfaces.ts', 'ioSurfaces.test.ts']);
/**
 * Directories under src/ that are NOT part of theDAW's app bundle. They are
 * built by their own vite entry into another page on another origin, with its
 * own localStorage and no /api/settings of ours — so a surface id read only
 * from there resolves to the default forever and the Settings row is a
 * dropdown that does nothing. `assistantVoice` shipped exactly that way once.
 *
 *   src/orb-standalone   -> vite.orb.config.ts, underfit's dashboard on :8791
 *   src/views/underfit   -> the orb component that entry mounts
 */
const OTHER_ORIGIN = ['orb-standalone', join('views', 'underfit')];

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (/\.tsx?$/.test(entry.name) && !SKIP.has(entry.name)) out.push(full);
  }
  return out;
}

const inAppBundle = (file: string): boolean =>
  !OTHER_ORIGIN.some((d) => file.includes(join(SRC, d)));

const sources = collect(SRC)
  .filter(inAppBundle)
  .map((f) => readFileSync(f, 'utf8'));

/* ── every surface is actually wired to something ────────────────────────── */

for (const surface of IO_SURFACES) {
  const quoted = [`'${surface.id}'`, `"${surface.id}"`];
  const users = sources.filter((src) => quoted.some((q) => src.includes(q))).length;
  assert.ok(
    users > 0,
    `surface "${surface.id}" is offered in Settings but no call site in theDAW's own bundle reads it — it would be a dropdown that does nothing`,
  );
}

/* ── the registry itself is coherent ─────────────────────────────────────── */

const ids = IO_SURFACES.map((s) => s.id);
assert.equal(new Set(ids).size, ids.length, 'surface ids are unique (they are React keys and DOM ids)');

for (const surface of IO_SURFACES) {
  assert.equal(surfaceById(surface.id)?.id, surface.id);
  assert.ok(surface.label.length > 0, `${surface.id} needs a row label`);
  assert.ok(surface.hint.length > 0, `${surface.id} needs hover copy saying what it changes`);
  assert.ok(
    GLOBAL_SLOT_FOR_KIND[surface.kind],
    `${surface.id} has kind "${surface.kind}" with no global slot to fall back to`,
  );
  // The DOM id the select builds must be a valid, stable one.
  assert.match(surface.id, /^[A-Za-z][A-Za-z0-9]*$/, `${surface.id} must be safe in an element id`);
}

assert.equal(surfaceById('not-a-surface'), undefined, 'an unknown id resolves to nothing, not a throw');
assert.deepEqual(Object.keys(GLOBAL_SLOT_FOR_KIND).sort(), ['audioIn', 'audioOut']);

console.log('ioSurfaces registry passed');
