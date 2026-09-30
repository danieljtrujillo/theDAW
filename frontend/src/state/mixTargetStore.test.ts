/**
 * node:assert cover for mixTargetStore — the ONE binding both EDIT and MIX
 * read. Run from `frontend/`:
 *   npx tsx src/state/mixTargetStore.test.ts
 *
 * The point of this store is that two independent call sites (EDIT writing,
 * MIX reading) see the same binding with no copying, so most cases below
 * write through one `getState()` call and read back through another,
 * separate one — exactly what the two views do in the app.
 */
import assert from 'node:assert/strict';

import {
  makeMixTarget,
  resolveMixTarget,
  type MixTargetClipLike,
  type MixTargetTrackLike,
} from '../lib/mixTarget.ts';
import { bindMixTargetToClip, useMixTargetStore } from './mixTargetStore.ts';
import { useProjectStore } from './projectStore.ts';

const baseClip: MixTargetClipLike = {
  id: 'clip-1',
  trackId: 'track-1',
  label: 'Vox',
  startSec: 0,
  durationSec: 4,
  offsetIntoSource: 0,
};

/* -------------------------------- defaults -------------------------------- */
{
  assert.equal(useMixTargetStore.getState().target, null, 'no target by default');
}

/* --------------------------------- setTarget ------------------------------- */
{
  useProjectStore.setState({ projectName: 'Demo Set' });
  const target = makeMixTarget('Demo Set', baseClip);
  useMixTargetStore.getState().setTarget(target);

  // A second, independent getState() call stands in for the MIX view reading
  // what the EDIT view just wrote through a completely separate call site.
  assert.deepEqual(
    useMixTargetStore.getState().target,
    target,
    'setTarget binds and is readable from a second getState() caller (the MIX view reads what EDIT wrote)',
  );
}

/* ------------------------------ blank targets ------------------------------ */
{
  const before = useMixTargetStore.getState().target;

  const blankClip = makeMixTarget('Demo Set', { ...baseClip, id: '' });
  useMixTargetStore.getState().setTarget(blankClip);
  assert.equal(useMixTargetStore.getState().target, before, 'a blank clipId is ignored');

  const blankProject = makeMixTarget('', baseClip);
  useMixTargetStore.getState().setTarget(blankProject);
  assert.equal(useMixTargetStore.getState().target, before, 'a blank projectId is ignored too');
}

/* -------------------------------- clearTarget ------------------------------ */
{
  assert.notEqual(useMixTargetStore.getState().target, null, 'sanity: a target is bound before clearing');
  useMixTargetStore.getState().clearTarget();
  assert.equal(useMixTargetStore.getState().target, null, 'clearTarget unbinds');
}

/* -------------------------------- noteRevision ------------------------------ */
{
  const target = makeMixTarget('Demo Set', baseClip);
  useMixTargetStore.getState().setTarget(target);

  useMixTargetStore.getState().noteRevision('rev-2');
  const after = useMixTargetStore.getState().target;
  assert.equal(after?.clipRevision, 'rev-2', 'noteRevision updates only the revision');
  assert.equal(after?.clipId, target.clipId, 'noteRevision leaves clipId alone');
  assert.equal(after?.trackId, target.trackId, 'noteRevision leaves trackId alone');
  assert.equal(after?.projectId, target.projectId, 'noteRevision leaves projectId alone');
  assert.equal(after?.scope, target.scope, 'noteRevision leaves scope alone');

  useMixTargetStore.getState().clearTarget();
  useMixTargetStore.getState().noteRevision('should-not-appear');
  assert.equal(useMixTargetStore.getState().target, null, 'noteRevision is a no-op when there is no target bound');
}

/* ------------------------------ resolveMixTarget ---------------------------- */
{
  const clip: MixTargetClipLike = {
    id: 'clip-9',
    trackId: 'track-9',
    label: 'Drums',
    startSec: 0,
    durationSec: 4,
    offsetIntoSource: 0,
  };
  const track: MixTargetTrackLike = { id: 'track-9', name: 'Drums Bus' };
  useProjectStore.setState({ projectName: 'Demo Set' });
  useMixTargetStore.getState().setTarget(makeMixTarget('Demo Set', clip));

  const stillThere = resolveMixTarget(useMixTargetStore.getState().target, 'Demo Set', [clip], [track]);
  assert.equal(stillThere.status, 'ok', 'sanity: the clip resolves before being dropped');

  // The clip is deleted from the project (dropped from the list the caller
  // resolves against) while the binding stays exactly as it was.
  const dropped = resolveMixTarget(useMixTargetStore.getState().target, 'Demo Set', [], [track]);
  assert.deepEqual(
    dropped,
    { status: 'missing-clip' },
    'resolveMixTarget against the stored target reports missing-clip after the clip is dropped from the clip list',
  );
}

/* ---------------------------- bindMixTargetToClip --------------------------- */
{
  useMixTargetStore.getState().clearTarget();
  useProjectStore.setState({ projectName: 'My Song' });
  const clip: MixTargetClipLike = {
    id: 'clip-42',
    trackId: 'track-7',
    label: 'Lead',
    startSec: 2,
    durationSec: 6,
    offsetIntoSource: 0,
  };

  const bound = bindMixTargetToClip(clip);
  assert.ok(bound, 'bindMixTargetToClip returns the target it built');
  assert.equal(bound?.projectId, 'My Song', 'bindMixTargetToClip reads the current project name');
  assert.equal(bound?.clipId, 'clip-42');
  assert.deepEqual(
    useMixTargetStore.getState().target,
    bound,
    'bindMixTargetToClip stores what it returns, so a second getState() caller reads it too',
  );
}
{
  // A blank project name means nothing in a load/save round-trip, so binding
  // falls back to a stable project id rather than stamping a blank one.
  useProjectStore.setState({ projectName: '   ' });
  const clip: MixTargetClipLike = {
    id: 'clip-43',
    trackId: 'track-7',
    label: 'Lead 2',
    startSec: 0,
    durationSec: 3,
    offsetIntoSource: 0,
  };
  const bound = bindMixTargetToClip(clip);
  assert.equal(bound?.projectId, 'untitled', "a blank project name falls back to 'untitled'");
}
{
  // A clip with no id cannot be bound to anything a later resolveMixTarget
  // could ever find again, so bindMixTargetToClip must refuse it rather than
  // silently storing a binding that points nowhere.
  useProjectStore.setState({ projectName: 'My Song' });
  const before = useMixTargetStore.getState().target;
  const bound = bindMixTargetToClip({
    id: '',
    trackId: 'track-7',
    label: 'Nope',
    startSec: 0,
    durationSec: 1,
    offsetIntoSource: 0,
  });
  assert.equal(bound, null, 'bindMixTargetToClip returns null for a blank clip id');
  assert.equal(useMixTargetStore.getState().target, before, 'a rejected bind does not change the stored target');
}

console.log('mixTargetStore: ok');
