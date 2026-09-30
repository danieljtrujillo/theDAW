/**
 * The cross-origin isolation switch, tested without starting a dev server.
 *
 * `isolationHeaders()` is a pure function of one boolean precisely so this file
 * can exist: the alternative is booting Vite and curling it, which no suite
 * here does. Both halves matter and both are easy to get subtly wrong.
 *
 * OFF must be an EMPTY object, not the two keys with empty values — Vite
 * spreads the map into `server.headers`, and a present-but-empty header still
 * goes on the wire, which would be a behaviour change on the default path that
 * nobody asked for.
 *
 * ON must be exactly `COOP: same-origin` + `COEP: require-corp`. Those two
 * exact values are what the browser requires before it will set
 * `crossOriginIsolated`; `same-origin-allow-popups` (the tempting relaxation,
 * since COOP is what severs the VJ pop-out handle) does NOT grant isolation,
 * so a well-meant softening here would silently cost the whole feature.
 *
 * Run: `npx tsx src/lib/isolationHeaders.test.ts`
 */
import assert from 'node:assert/strict';

import { isolationHeaders } from '../../vite.config.ts';

// --- off ------------------------------------------------------------------
const off = isolationHeaders(false);
assert.deepEqual(off, {}, 'disabled yields no headers at all');
assert.equal(Object.keys(off).length, 0, 'not even an empty-valued key');

// --- on -------------------------------------------------------------------
const on = isolationHeaders(true);
assert.deepEqual(
  on,
  {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  },
  'enabled yields exactly the pair that grants cross-origin isolation',
);
assert.deepEqual(
  Object.keys(on).sort(),
  ['Cross-Origin-Embedder-Policy', 'Cross-Origin-Opener-Policy'],
  'exactly two keys — nothing extra rides along',
);
assert.equal(on['Cross-Origin-Opener-Policy'], 'same-origin');
assert.equal(on['Cross-Origin-Embedder-Policy'], 'require-corp');

// A fresh object each call: the map is spread into Vite config, and a shared
// mutable singleton would let one caller's edit reach the other.
assert.notEqual(isolationHeaders(true), on, 'each call returns its own object');

console.log('isolationHeaders: all assertions passed');
