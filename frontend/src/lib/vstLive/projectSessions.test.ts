/**
 * vstLive/projectSessions — the project holds its plugins.
 *
 * Run: npx tsx src/lib/vstLive/projectSessions.test.ts
 */
import assert from 'node:assert/strict';

import { createProjectSessions, PROJECT_HOLDER } from './projectSessions.ts';
import type { ChainEntry } from '../../state/effectChainStore.ts';

const plugin = (id: string, path = `C:/VST3/${id}.vst3`): ChainEntry => ({
  id,
  effect: 'vst3',
  params: {},
  enabled: true,
  vst: { plugin_path: path, plugin_name: id },
});
const builtin = (id: string): ChainEntry => ({ id, effect: 'reverb', params: {}, enabled: true }) as ChainEntry;

function setup(initial: ChainEntry[], hostAvailable: boolean | null = true) {
  const log: string[] = [];
  let rateReads = 0;
  const state = { entries: initial, hostAvailable };
  const sessions = createProjectSessions({
    registry: {
      hold: async (entry, sampleRate, holder) => {
        log.push(`hold ${entry.id} @${sampleRate} as ${holder}`);
        return null;
      },
      forget: (entryId) => void log.push(`forget ${entryId}`),
      hostAvailable: () => state.hostAvailable,
    },
    entries: () => state.entries,
    sampleRate: () => {
      rateReads += 1;
      return 48000;
    },
  });
  return { log, sessions, state, rateReads: () => rateReads };
}

/* ── a project with no plugins never touches the audio context ── */
{
  const { log, sessions, rateReads } = setup([builtin('r1')]);
  sessions.reconcile();
  assert.deepEqual(log, []);
  assert.equal(rateReads(), 0, 'the sample rate (and with it the AudioContext) is only read for a plugin');
}

/* ── every plugin in the project is held once, however often the racks change ── */
{
  const { log, sessions, state } = setup([plugin('a'), builtin('r1'), plugin('b')]);
  sessions.reconcile();
  assert.deepEqual(log, [`hold a @48000 as ${PROJECT_HOLDER}`, `hold b @48000 as ${PROJECT_HOLDER}`]);
  state.entries = [plugin('a'), plugin('b')]; // new objects, same ids: a fader move, a param edit
  sessions.reconcile();
  sessions.reconcile();
  assert.equal(log.length, 2, 'an entry that is already held is not held again');
  assert.deepEqual(sessions.heldIds().sort(), ['a', 'b']);
}

/* ── an entry that left the project is forgotten, whatever removed it; an undo holds it again ── */
{
  const { log, sessions, state } = setup([plugin('a'), plugin('b')]);
  sessions.reconcile();
  log.length = 0;
  state.entries = [plugin('b')];
  sessions.reconcile();
  assert.deepEqual(log, ['forget a']);
  state.entries = [plugin('a'), plugin('b')]; // undo
  sessions.reconcile();
  assert.deepEqual(log, ['forget a', `hold a @48000 as ${PROJECT_HOLDER}`]);
}

/* ── an entry with no plugin path is a broken import, not something to host ── */
{
  const broken: ChainEntry = { id: 'x', effect: 'vst3', params: {}, enabled: true };
  const { log, sessions } = setup([broken]);
  sessions.reconcile();
  assert.deepEqual(log, []);
}

/* ── no host binary here: nothing is started, and nothing is remembered as held ── */
{
  const { log, sessions, state } = setup([plugin('a')], false);
  sessions.reconcile();
  assert.deepEqual(log, []);
  assert.deepEqual(sessions.heldIds(), []);
  state.hostAvailable = true; // the host was built, a retry re-probed
  sessions.reconcile();
  assert.deepEqual(log, [`hold a @48000 as ${PROJECT_HOLDER}`], 'the next pass picks the plugin up');
}

/* ── not probed yet is not a no ── */
{
  const { log, sessions } = setup([plugin('a')], null);
  sessions.reconcile();
  assert.equal(log.length, 1);
}

/* ── reset(): the registry was closed wholesale; the next pass holds everything afresh ── */
{
  const { log, sessions } = setup([plugin('a')]);
  sessions.reconcile();
  sessions.reset();
  assert.deepEqual(sessions.heldIds(), []);
  sessions.reconcile();
  assert.deepEqual(log, [`hold a @48000 as ${PROJECT_HOLDER}`, `hold a @48000 as ${PROJECT_HOLDER}`]);
  assert.ok(!log.some((l) => l.startsWith('forget')), 'reset gives nothing back: there is nothing left to give');
}

console.log('vstLive/projectSessions: ok');
