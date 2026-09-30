/**
 * node:assert cover for mixTarget — the pure MIX-binding model. Run from
 * `frontend/`:
 *   npx tsx src/lib/mixTarget.test.ts
 *
 * These are the questions the model exists to answer: does an unchanged clip
 * hash to the same revision every time; does a trim/move change it; and does
 * `resolveMixTarget` correctly tell a live binding apart from one left over
 * (wrong project, deleted clip) or one that has drifted since MIX opened it.
 */
import assert from 'node:assert/strict';

import {
  clipRevision,
  isLiveRackEffect,
  makeMixTarget,
  mixTargetBannerText,
  mixTargetRackRows,
  MIX_TARGET_TRACK_SCOPE_NOTE,
  resolveMixTarget,
  type MixTargetClipLike,
  type MixTargetTrackLike,
} from './mixTarget.ts';

const baseClip: MixTargetClipLike = {
  id: 'clip-1',
  trackId: 'track-1',
  label: 'Vocal Take 1',
  startSec: 4,
  durationSec: 8,
  offsetIntoSource: 0,
};

const baseTrack: MixTargetTrackLike = {
  id: 'track-1',
  name: 'Vocals',
};

/* ------------------------------ clipRevision ------------------------------ */
{
  assert.equal(
    clipRevision(baseClip),
    clipRevision({ ...baseClip }),
    'clipRevision is stable for an unchanged clip',
  );
}
{
  const original = clipRevision(baseClip);
  const trimmed = clipRevision({ ...baseClip, durationSec: baseClip.durationSec + 2 });
  const moved = clipRevision({ ...baseClip, startSec: baseClip.startSec + 1 });
  assert.notEqual(trimmed, original, 'clipRevision changes when the clip is trimmed or moved (trim)');
  assert.notEqual(moved, original, 'clipRevision changes when the clip is trimmed or moved (move)');
}

/* ----------------------------- resolveMixTarget ---------------------------- */
{
  const result = resolveMixTarget(null, 'proj-1', [baseClip], [baseTrack]);
  assert.deepEqual(result, { status: 'none' }, 'resolveMixTarget: null target => none');
}
{
  const target = makeMixTarget('proj-1', baseClip);
  const result = resolveMixTarget(target, 'proj-2', [baseClip], [baseTrack]);
  assert.deepEqual(
    result,
    { status: 'other-project' },
    'resolveMixTarget: another project id => other-project',
  );
}
{
  const target = makeMixTarget('proj-1', baseClip);
  const result = resolveMixTarget(target, 'proj-1', [], [baseTrack]);
  assert.deepEqual(result, { status: 'missing-clip' }, 'resolveMixTarget: deleted clip => missing-clip');
}
{
  const target = makeMixTarget('proj-1', baseClip);
  const result = resolveMixTarget(target, 'proj-1', [baseClip], [baseTrack]);
  assert.deepEqual(
    result,
    {
      status: 'ok',
      clip: baseClip,
      track: baseTrack,
      revision: clipRevision(baseClip),
      revisionChanged: false,
    },
    'resolveMixTarget: live clip => ok with its track and revisionChanged false',
  );
}
{
  const target = makeMixTarget('proj-1', baseClip);
  const edited: MixTargetClipLike = { ...baseClip, durationSec: baseClip.durationSec + 4 };
  const result = resolveMixTarget(target, 'proj-1', [edited], [baseTrack]);
  assert.deepEqual(
    result,
    {
      status: 'ok',
      clip: edited,
      track: baseTrack,
      revision: clipRevision(edited),
      revisionChanged: true,
    },
    'resolveMixTarget: edited clip => ok with revisionChanged true',
  );
}

/* -------------------------------- banner text ------------------------------ */
{
  assert.equal(
    mixTargetBannerText('Vocal Take 1', 'Vocals'),
    'Editing: Vocal Take 1 — Vocals',
    'banner text uses the em dash form',
  );
  assert.equal(
    MIX_TARGET_TRACK_SCOPE_NOTE,
    'Changes apply to the whole track',
    'the track-scope note explains why the rack is not clip-local',
  );
}

/* ------------------------------ rack row rows ------------------------------ */
{
  const liveIds: ReadonlySet<string> = new Set(['reverb_delay', 'spatializer']);
  const entries = [
    { effect: 'reverb_delay', label: 'Reverb' },
    { effect: 'delay' },
    { effect: 'vst3', label: 'Ozone' },
  ];
  assert.deepEqual(
    mixTargetRackRows(entries, liveIds),
    [
      { effect: 'reverb_delay', label: 'Reverb', printedPreview: false },
      { effect: 'delay', printedPreview: true },
      { effect: 'vst3', label: 'Ozone', printedPreview: false },
    ],
    'mixTargetRackRows marks non-live effects printedPreview and vst3 live',
  );
  assert.equal(isLiveRackEffect('vst3', new Set()), true, 'vst3 is live even with an empty live-id set');
  assert.equal(isLiveRackEffect('delay', new Set()), false, 'a backend-only id is not live without vst3');
}

console.log('mixTarget: ok');
