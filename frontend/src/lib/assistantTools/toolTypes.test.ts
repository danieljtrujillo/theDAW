// toolTypes: the assistant tool contract. The suite pins:
//  1. refuse/isRefusal is a round trip — the only way code should recognise a
//     refusal is the type guard, never a hand-rolled `'refused' in v` check,
//  2. dbToLinear/linearToDb are exact inverses (up to display rounding), and
//     linearToDb(0) is -Infinity rather than a NaN or a thrown error,
//  3. clampGainDb enforces the WaveformEditor clip-gain range (-24..+12 dB), and
//  4. refuseStaleReference only fires on a 'missing' resolution, and folds the
//     id and detail into the refusal reason so the failure is legible, and
//  5. splitClip's own doc names its `atSec` frame as TIMELINE-absolute (AST-1
//     rework finding): read back from source, since the contract has no
//     runtime body to exercise the claim against.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  refuse, isRefusal,
  dbToLinear, linearToDb, clampGainDb, roundTo,
  refuseStaleReference,
} from './toolTypes.ts';

// ── 'refuse/isRefusal round trip' ────────────────────────────────────────────
{
  assert.equal(isRefusal(refuse('x')), true);
  assert.equal(isRefusal({}), false);
  assert.equal(isRefusal(null), false);
  assert.equal(isRefusal('x'), false);
}

// ── 'dbToLinear/linearToDb invert' ───────────────────────────────────────────
{
  assert.equal(roundTo(linearToDb(dbToLinear(-6)), 6), -6);
  assert.equal(linearToDb(0), Number.NEGATIVE_INFINITY);
  assert.equal(dbToLinear(0), 1);
}

// ── 'clampGainDb clamps to the editor range' ─────────────────────────────────
{
  assert.equal(clampGainDb(20), 12);
  assert.equal(clampGainDb(-99), -24);
  assert.equal(clampGainDb(-3), -3);
}

// ── 'refuseStaleReference' ────────────────────────────────────────────────────
{
  const missing = refuseStaleReference('clip', 'clip-1', { status: 'missing', detail: 'it was deleted' });
  if (missing === null) throw new Error('expected a refusal for a missing reference');
  assert.equal(isRefusal(missing), true);
  assert.ok(missing.reason.includes('clip-1'), 'reason names the stale id');
  assert.ok(missing.reason.includes('it was deleted'), 'reason carries the resolver detail');

  assert.equal(refuseStaleReference('track', 'track-1', { status: 'ok', detail: 'fine' }), null);
  assert.equal(refuseStaleReference('track', 'track-1', { status: 'changed', detail: 'renamed' }), null);
}

// ── 'splitClip doc names the TIMELINE-absolute frame' ───────────────────────
{
  const src = readFileSync(new URL('./toolTypes.ts', import.meta.url), 'utf8');
  const declIdx = src.indexOf('splitClip(clipId: string, atSec: number): string | null;');
  assert.ok(declIdx >= 0, 'splitClip must still be declared with this exact signature');
  const docStart = src.lastIndexOf('/**', declIdx);
  const docEnd = src.lastIndexOf('*/', declIdx);
  assert.ok(docStart >= 0 && docEnd > docStart, 'splitClip must be documented with a /** */ block directly above it');
  const doc = src.slice(docStart, docEnd);

  // AST-1 rework finding: the doc used to call `atSec` "clip-relative", but
  // the store action it wraps (`editorStore.splitClipAt`) takes a
  // TIMELINE-absolute second — it computes `relSplit = atSec - clip.startSec`
  // itself, and every real call site (WaveformEditor's playhead position and
  // click-to-seconds conversion, orb-kit's action handler) passes an absolute
  // timeline position, never a clip-relative offset. This comment is the only
  // normative statement of the parameter's frame in the whole contract, so a
  // regression here silently tells every tool author the wrong unit.
  assert.ok(/TIMELINE-absolute/.test(doc), 'doc must name the TIMELINE-absolute frame');
  assert.ok(!/clip-relative/i.test(doc), 'doc must not claim atSec is clip-relative');
  assert.ok(doc.includes('ToolClip.startSec'), 'doc must anchor the frame to the other field that shares it');
  assert.ok(doc.includes('editorStore.splitClipAt'), 'doc must name the real action being wrapped');
}

console.log('toolTypes: passed');
