/**
 * Regression cover for RS6-1: liveMixer must classify MIDI clips through the
 * ONE shared rule in lib/clipEditTarget, not a private copy that disagrees
 * with the piano roll / timeline about an emptied roll (the private copy
 * required `sourcePianoRoll.length > 0`, so emptying a roll left the engine
 * still playing its stale bounced audio). Run from `frontend/`:
 *   npx tsx src/state/liveMixerMidiClip.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isMidiClip } from '../lib/clipEditTarget.ts';

function run(name: string, fn: () => void): void {
  fn();
  console.log(`  ok - ${name}`);
}

run('an emptied piano roll is still a MIDI clip', () => {
  assert.equal(isMidiClip({ sourceKind: 'piano-roll', sourcePianoRoll: [] }), true);
});

run('a roll bounced before lanes existed is a MIDI clip', () => {
  assert.equal(isMidiClip({ sourceKind: 'piano-roll', sourceRollNotes: [{}] }), true);
});

run('an audio clip carrying leftover notes is not MIDI', () => {
  assert.equal(isMidiClip({ sourceKind: 'audio', sourcePianoRoll: [{}] }), false);
});

run('liveMixer has no private classifier', () => {
  const src = readFileSync(new URL('./liveMixer.ts', import.meta.url), 'utf8');
  assert.equal(
    /function\s+isMidiClip/.test(src),
    false,
    'liveMixer must not define its own isMidiClip — see lib/clipEditTarget',
  );
  assert.equal(
    /from '\.\.\/lib\/clipEditTarget'/.test(src),
    true,
    'liveMixer must import isMidiClip from lib/clipEditTarget',
  );
});

console.log('liveMixerMidiClip: ok');
