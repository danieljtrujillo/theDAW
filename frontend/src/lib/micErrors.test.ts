// Run with: npx tsx src/lib/micErrors.test.ts
//
// The case that mattered: a machine with no microphone logged
// "mic monitor unavailable: NotFoundError: Requested device not found"
// as a warning, on every open of the MIDI tab. These tests pin that it is now
// classified benign, worded without a stack, and announced once.
import assert from 'node:assert/strict';
import {
  describeMicFailure,
  resetMicFailureLog,
  shouldAnnounceMicFailure,
  type MicFailureKind,
} from './micErrors.ts';

/** A DOMException as Chromium actually throws it from getUserMedia. */
const domError = (name: string, message = ''): Error => {
  const e = new Error(message || name);
  e.name = name;
  return e;
};

const WHAT = 'the level meter';

// The reported error: no microphone attached. Benign, and it names the surface.
{
  const f = describeMicFailure(domError('NotFoundError', 'Requested device not found'), WHAT);
  assert.equal(f.kind, 'no-device');
  assert.equal(f.benign, true);
  assert.ok(f.message.includes('No microphone is attached'), f.message);
  assert.ok(f.message.includes(WHAT), f.message);
  // The raw exception text must not leak into a benign message.
  assert.ok(!f.message.includes('NotFoundError'), f.message);
  assert.ok(!f.message.includes('Requested device not found'), f.message);
}

// The legacy alias for the same condition.
{
  assert.equal(describeMicFailure(domError('DevicesNotFoundError'), WHAT).kind, 'no-device');
}

// A mic exists but was refused: NOT benign, and it says what to do.
{
  const f = describeMicFailure(domError('NotAllowedError'), WHAT);
  assert.equal(f.kind, 'denied');
  assert.equal(f.benign, false);
  assert.ok(/allow the microphone/i.test(f.message), f.message);
}

// Held by another program: its own case, its own fix.
{
  for (const name of ['NotReadableError', 'TrackStartError', 'AbortError']) {
    const f = describeMicFailure(domError(name), WHAT);
    assert.equal(f.kind, 'busy', name);
    assert.equal(f.benign, false, name);
    assert.ok(/another program/i.test(f.message), f.message);
  }
}

// Constraints: reachable only for a constraint that is not the device id,
// because the device id is passed soft on purpose.
{
  const f = describeMicFailure(domError('OverconstrainedError'), WHAT);
  assert.equal(f.kind, 'overconstrained');
  assert.ok(f.message.includes('system default'), f.message);
}

// No capture support at all.
{
  assert.equal(describeMicFailure(domError('TypeError'), WHAT).kind, 'unsupported');
}

// Anything unrecognised keeps the raw text rather than inventing a cause.
{
  const f = describeMicFailure(domError('WeirdError', 'something odd'), WHAT);
  assert.equal(f.kind, 'unknown');
  assert.equal(f.benign, false);
  assert.ok(f.message.includes('something odd'), f.message);
}

// A non-Error rejection must not throw the classifier.
{
  for (const thrown of [undefined, null, 'a string', 42, {}]) {
    const f = describeMicFailure(thrown, WHAT);
    assert.equal(f.kind, 'unknown');
    assert.ok(typeof f.message === 'string' && f.message.length > 0);
  }
}

// Announced once per (surface, kind) — the effect re-runs on every device
// change and remount, and the LOG must not fill with the same line.
{
  resetMicFailureLog();
  const none = describeMicFailure(domError('NotFoundError'), WHAT);
  assert.equal(shouldAnnounceMicFailure(none, WHAT), true, 'first time announces');
  assert.equal(shouldAnnounceMicFailure(none, WHAT), false, 'second time is silent');

  // A CHANGE of state is still worth saying, even on the same surface.
  const denied = describeMicFailure(domError('NotAllowedError'), WHAT);
  assert.equal(shouldAnnounceMicFailure(denied, WHAT), true, 'a different kind announces');
  assert.equal(shouldAnnounceMicFailure(denied, WHAT), false);

  // A different surface tracks separately.
  assert.equal(shouldAnnounceMicFailure(none, 'SING pitch'), true, 'other surface announces');
  assert.equal(shouldAnnounceMicFailure(none, WHAT), false, 'first surface still silent');

  resetMicFailureLog();
  assert.equal(shouldAnnounceMicFailure(none, WHAT), true, 'reset re-arms');
}

// Every kind is reachable from some real DOMException name, so no branch is dead.
{
  const seen = new Set<MicFailureKind>();
  for (const name of [
    'NotFoundError',
    'NotAllowedError',
    'NotReadableError',
    'OverconstrainedError',
    'TypeError',
    'Nonsense',
  ]) {
    seen.add(describeMicFailure(domError(name), WHAT).kind);
  }
  assert.deepEqual(
    [...seen].sort(),
    ['busy', 'denied', 'no-device', 'overconstrained', 'unknown', 'unsupported'],
  );
}

console.log('micErrors tests passed');
