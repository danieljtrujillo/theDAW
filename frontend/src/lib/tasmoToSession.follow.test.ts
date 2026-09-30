// A clip's follow action survives the .tasmo round-trip.
//
// The grid's placement already round-trips (track_index / scene_index / slot_index);
// a follow rule is the other half of what a session grid IS, and without it a saved
// set reopened with every column playing one clip forever. These pin the two pure
// mappers at the file boundary — `dawProjectToTasmo` on the way out,
// `tasmoLoadedToDawProject` on the way back — plus the shapes an older or
// hand-edited file can arrive in.
import assert from 'node:assert/strict';
import { dawProjectToTasmo } from './projectClient.ts';
import type { TasmoLoadedClip, TasmoLoadedTrack, TasmoProjectLoaded } from './projectClient.ts';
import { tasmoLoadedToDawProject } from './tasmoToSession.ts';
import type { DawClip, DawProject } from './dawImportClient.ts';
import type { FollowAction } from './followAction.ts';

const clip = (over: Partial<DawClip> = {}): DawClip => ({
  name: 'Kick',
  start_time: 0,
  end_time: 4,
  file_path: 'C:/set/kick.wav',
  track_index: 0,
  scene_index: 0,
  slot_index: 0,
  ...over,
});

const project = (clips: DawClip[]): DawProject => ({
  source_daw: 'ableton',
  source_version: '12',
  name: 'Follow Set',
  tempo: 124,
  time_signature: [4, 4],
  sample_rate: 44100,
  tracks: [{ name: 'Drums', type: 'audio', volume_db: 0, pan: 0, mute: false, solo: false, clips, devices: [] }],
  locators: [],
  controller_mappings: [],
  scenes: ['A', 'B'],
  plugins_used: [],
  warnings: [],
  missing_files: [],
});

/** The save payload read back as the loader sees it — the backend returns the
 *  model it was handed, so the two shapes meet at exactly these keys. */
const reload = (saved: ReturnType<typeof dawProjectToTasmo>): TasmoProjectLoaded => ({
  project_name: saved.project_name,
  tempo: saved.tempo,
  time_signature: saved.time_signature,
  sample_rate: saved.sample_rate,
  scenes: saved.scenes,
  tracks: (saved.tracks ?? []).map<TasmoLoadedTrack>((t) => ({
    id: t.id,
    name: t.name,
    type: t.type,
    clips: (t.clips ?? []).map<TasmoLoadedClip>((c) => ({
      id: c.id,
      name: c.name,
      clip_type: c.clip_type,
      audio_file: c.audio_file ?? null,
      start_time: c.start_time,
      end_time: c.end_time,
      track_index: c.track_index,
      scene_index: c.scene_index,
      slot_index: c.slot_index,
      follow_action: c.follow_action,
    })),
  })),
});

/* ------------------------------ save -> load ------------------------------- */

// A bars/beats rule with both actions and a real chance comes back byte-identical.
{
  const rule: FollowAction = { after: { bars: 2, beats: 1 }, a: 'next', b: 'stop', chance: 0.35 };
  const saved = dawProjectToTasmo(project([clip({ followAction: rule })]));
  assert.deepEqual(saved.tracks?.[0].clips?.[0].follow_action, rule);
  const back = tasmoLoadedToDawProject(reload(saved));
  assert.deepEqual(back.tracks[0].clips[0].followAction, rule);
}

// The `{plays}` form, one-sided, is the other half of the union.
{
  const rule: FollowAction = { after: { plays: 3 }, a: 'again', chance: 1 };
  const saved = dawProjectToTasmo(project([clip({ followAction: rule })]));
  assert.deepEqual(saved.tracks?.[0].clips?.[0].follow_action, rule);
  assert.deepEqual(tasmoLoadedToDawProject(reload(saved)).tracks[0].clips[0].followAction, rule);
}

// Per CLIP, not per track: two cells in the same column keep their own rules,
// and a cell with no rule stays without one rather than inheriting a neighbour's.
{
  const first: FollowAction = { after: { bars: 1, beats: 0 }, a: 'next', chance: 1 };
  const second: FollowAction = { after: { bars: 4, beats: 0 }, a: 'first', chance: 1 };
  const saved = dawProjectToTasmo(
    project([
      clip({ name: 'A', scene_index: 0, slot_index: 0, followAction: first }),
      clip({ name: 'B', scene_index: 1, slot_index: 1, followAction: second }),
      clip({ name: 'C', scene_index: 2, slot_index: 2 }),
    ]),
  );
  const clips = tasmoLoadedToDawProject(reload(saved)).tracks[0].clips;
  assert.deepEqual(clips.map((c) => c.followAction), [first, second, undefined]);
}

// A clip with no rule writes an explicit null rather than dropping the key, so
// the field is always present in the file and a reader never has to guess.
{
  const saved = dawProjectToTasmo(project([clip()]));
  assert.equal(saved.tracks?.[0].clips?.[0].follow_action, null);
  assert.equal(tasmoLoadedToDawProject(reload(saved)).tracks[0].clips[0].followAction, undefined);
}

/* ------------------------- files the app did not write --------------------- */

const loadedWith = (follow: unknown): DawClip =>
  tasmoLoadedToDawProject({
    project_name: 'Old',
    tempo: 120,
    sample_rate: 44100,
    tracks: [
      {
        name: 'Drums',
        type: 'audio',
        clips: [
          {
            name: 'Kick',
            clip_type: 'audio',
            audio_file: 'C:/set/kick.wav',
            scene_index: 0,
            slot_index: 0,
            follow_action: follow as TasmoLoadedClip['follow_action'],
          },
        ],
      },
    ],
  }).tracks[0].clips[0];

// A file written before follow actions existed has no key at all: it loads, with
// no rule, exactly as it did before.
assert.equal(loadedWith(undefined).followAction, undefined);
assert.equal(loadedWith(null).followAction, undefined);

// Interpretation is strict even though storage is tolerant: a kind this build
// does not know is no rule, not a rule that does something else.
assert.equal(loadedWith({ after: { bars: 1, beats: 0 }, a: 'sideways', chance: 1 }).followAction, undefined);
assert.equal(loadedWith({ after: {}, a: '', chance: 1 }).followAction, undefined);

// The shape the backend ACTUALLY writes for a rule with no period: every key of
// `after` defaulted to None and dumped as null. `Number(null)` is a finite 0, so
// read naively this loaded as a rule due on `dueAt`'s one-beat floor and
// relaunched its column every beat for as long as the set ran.
assert.equal(
  loadedWith({ after: { bars: null, beats: null, plays: null }, a: 'next', b: null, chance: 1.0 }).followAction,
  undefined,
);
// One real key among the nulls is still a real rule.
assert.deepEqual(
  loadedWith({ after: { bars: 2, beats: null, plays: null }, a: 'next', b: null, chance: 1.0 }).followAction,
  { after: { bars: 2, beats: 0 }, a: 'next', chance: 1 },
);
assert.deepEqual(
  loadedWith({ after: { bars: null, beats: null, plays: 3 }, a: 'again', b: null, chance: 1.0 }).followAction,
  { after: { plays: 3 }, a: 'again', chance: 1 },
);

// The backend defaults every field of the model, so a half-written entry is a
// shape the loader must survive: `a` present is enough, and `chance` defaults to
// a one-sided certainty.
assert.deepEqual(loadedWith({ after: { bars: 1, beats: 0 }, a: 'stop', b: '', chance: 1 }).followAction, {
  after: { bars: 1, beats: 0 },
  a: 'stop',
  chance: 1,
});

console.log('tasmoToSession.follow: ok');
