/**
 * Device resolution: the table the whole I/O menu rests on.
 *
 * These are the orderings a real machine produces, not just end states — a
 * device list that is still label-less because nothing has opened the mic yet,
 * an id that rotated between two origins, an interface that was unplugged
 * mid-session. Getting any of them wrong is silent: the user picks a device and
 * hears nothing, or hears the wrong one and is never told.
 *
 * Run: npx tsx src/lib/ioResolve.test.ts
 */
import assert from 'node:assert/strict';

import {
  FOLLOW_GLOBAL,
  isSystemDefault,
  labelsAreKnown,
  missingNoticeId,
  overrideFromSelect,
  overrideSelectValue,
  resolveRef,
  resolveSlot,
  type LiveDevice,
} from './ioResolve.ts';

const live: LiveDevice[] = [
  { id: 'default', label: 'Default - Speakers (Realtek)' },
  { id: 'aaa111', label: 'Scarlett 2i2 USB' },
  { id: 'bbb222', label: 'Headphones (WH-1000XM4)' },
];

/* ── empty ref = system default ──────────────────────────────────────────── */

assert.equal(isSystemDefault({ id: '', label: '' }), true);
assert.equal(isSystemDefault(null), true);
assert.equal(isSystemDefault({ id: 'aaa111', label: '' }), false);

{
  const r = resolveRef({ id: '', label: '' }, live);
  assert.equal(r.source, 'system');
  assert.equal(r.deviceId, '', 'system default hands the browser an empty id');
  assert.equal(r.label, '');
  assert.equal(r.rewrite, undefined);
}

/* ── exact id hit ────────────────────────────────────────────────────────── */

{
  const r = resolveRef({ id: 'aaa111', label: 'Scarlett 2i2 USB' }, live);
  assert.equal(r.source, 'exact');
  assert.equal(r.deviceId, 'aaa111');
  assert.equal(r.label, 'Scarlett 2i2 USB');
  assert.equal(r.rewrite, undefined, 'nothing to re-persist when the id still fits');
}

{
  // The OS renamed the device; the live name wins over the frozen one so the
  // menu never shows a name the system no longer uses.
  const r = resolveRef({ id: 'bbb222', label: 'Headphones (old name)' }, live);
  assert.equal(r.source, 'exact');
  assert.equal(r.label, 'Headphones (WH-1000XM4)');
}

/* ── id gone, label matches: recovered across an origin/id rotation ──────── */

{
  const r = resolveRef({ id: 'salted-from-the-other-origin', label: 'Scarlett 2i2 USB' }, live);
  assert.equal(r.source, 'label');
  assert.equal(r.deviceId, 'aaa111', 'recovered by label');
  assert.deepEqual(r.rewrite, { id: 'aaa111', label: 'Scarlett 2i2 USB' }, 'the new id is handed back to be written');
  assert.equal(r.missing, undefined);
}

/* ── neither matches: fall back to the system default AND say so ─────────── */

{
  const gone = { id: 'ccc333', label: 'Focusrite 18i20' };
  const r = resolveRef(gone, live);
  assert.equal(r.source, 'missing');
  assert.equal(r.deviceId, '', 'falls back to the OS default rather than failing');
  assert.deepEqual(r.missing, gone, 'the caller can name the device in the notice');
  // One notice per (kind, id): the same absent device resolved from three
  // surfaces must refresh one card, never stack three.
  assert.equal(missingNoticeId('audioOut', gone), missingNoticeId('audioOut', { ...gone }));
  assert.notEqual(missingNoticeId('audioOut', gone), missingNoticeId('audioIn', gone));
  assert.notEqual(missingNoticeId('audioOut', gone), missingNoticeId('audioOut', { id: 'ddd', label: 'x' }));
}

/* ── pre-permission: a label-less list proves nothing ────────────────────── */

// What Chrome actually returns before any getUserMedia has resolved.
const blind: LiveDevice[] = [{ id: '', label: '' }];
assert.equal(labelsAreKnown(blind), false);
assert.equal(labelsAreKnown([]), false, 'an empty list is not "labels known" either');
assert.equal(labelsAreKnown(live), true);

{
  const r = resolveRef({ id: 'aaa111', label: 'Scarlett 2i2 USB' }, blind);
  assert.equal(r.source, 'unknown', 'no verdict while the labels are blank');
  assert.equal(r.deviceId, 'aaa111', 'the saved id is still handed through');
  assert.equal(r.missing, undefined, 'and NO "device is gone" notice is raised');
}

{
  // Same ordering, one step later: permission granted, list re-enumerated.
  const r = resolveRef({ id: 'aaa111', label: 'Scarlett 2i2 USB' }, live);
  assert.equal(r.source, 'exact', 'the choice survives the permission transition');
}

{
  // A label-only ref (saved on the other origin) cannot be matched blind.
  const r = resolveRef({ id: '', label: 'Scarlett 2i2 USB' }, blind);
  assert.equal(r.source, 'unknown');
  assert.equal(r.deviceId, '', 'nothing to pass through, so the OS default plays');
}

{
  // An EMPTY list is the same kind of ignorance, and the store leans on it:
  // MIDI is opt-in and off by default, so "no ports enumerated" must not be
  // read as "your controller is gone" and shown as a warning.
  const r = resolveRef({ id: 'port-2', label: 'Ableton Push 2' }, []);
  assert.equal(r.source, 'unknown');
  assert.equal(r.missing, undefined, 'no notice for a list that was never populated');
}

/* ── precedence: override > global > system ──────────────────────────────── */

{
  const r = resolveSlot({ live, global: { id: 'aaa111', label: 'Scarlett 2i2 USB' } });
  assert.equal(r.origin, 'global');
  assert.equal(r.deviceId, 'aaa111');
}

{
  const r = resolveSlot({
    live,
    global: { id: 'aaa111', label: 'Scarlett 2i2 USB' },
    override: { id: 'bbb222', label: 'Headphones (WH-1000XM4)' },
  });
  assert.equal(r.origin, 'override');
  assert.equal(r.deviceId, 'bbb222');
}

{
  // An EXPLICIT system-default override beats a non-empty global: that is the
  // whole reason '' and FOLLOW_GLOBAL have to be different option values.
  const r = resolveSlot({ live, global: { id: 'aaa111', label: 'Scarlett 2i2 USB' }, override: { id: '', label: '' } });
  assert.equal(r.origin, 'override');
  assert.equal(r.source, 'system');
  assert.equal(r.deviceId, '', 'ignores the global on purpose');
}

{
  // No override key at all = follow the global.
  const r = resolveSlot({ live, global: { id: 'aaa111', label: 'Scarlett 2i2 USB' }, override: undefined });
  assert.equal(r.origin, 'global');
  assert.equal(r.deviceId, 'aaa111');
}

{
  const r = resolveSlot({ live });
  assert.equal(r.origin, 'none');
  assert.equal(r.source, 'system');
}

{
  // A surface whose override is gone falls back on its own, WITHOUT quietly
  // inheriting the global — the user asked for a specific device here.
  const r = resolveSlot({
    live,
    global: { id: 'aaa111', label: 'Scarlett 2i2 USB' },
    override: { id: 'ccc333', label: 'Focusrite 18i20' },
  });
  assert.equal(r.origin, 'override');
  assert.equal(r.source, 'missing');
  assert.equal(r.deviceId, '');
}

/* ── select-value round trip ─────────────────────────────────────────────── */

assert.equal(overrideSelectValue(undefined), FOLLOW_GLOBAL);
assert.equal(overrideSelectValue(null), FOLLOW_GLOBAL);
assert.equal(overrideSelectValue({ id: '', label: '' }), '');
assert.equal(overrideSelectValue({ id: 'aaa111', label: 'Scarlett 2i2 USB' }), 'aaa111');

assert.equal(overrideFromSelect(FOLLOW_GLOBAL, live), null, 'follow-global deletes the entry');
assert.deepEqual(overrideFromSelect('', live), { id: '', label: '' });
assert.deepEqual(
  overrideFromSelect('aaa111', live),
  { id: 'aaa111', label: 'Scarlett 2i2 USB' },
  'the label is captured at write time — that is what survives an id rotation',
);
assert.deepEqual(overrideFromSelect('unknown-id', live), { id: 'unknown-id', label: '' });

console.log('ioResolve resolution table passed');
