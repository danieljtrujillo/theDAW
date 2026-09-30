/**
 * A hardware keyboard through lib/keyboardMonitor, replayed as the raw Web MIDI
 * messages App.tsx receives.
 *
 * At 8039b45 every note-on played a fixed 180 ms blip and note-offs and the
 * sustain pedal were ignored, so a held chord died at once and a pedalled
 * passage never rang. The voice was always the picker's, whatever track was
 * armed. Run from `frontend/`:
 *   npx tsx src/lib/keyboardMonitor.test.ts
 */
import assert from 'node:assert/strict';
import { createKeyboardMonitor, monitorVoice, type HeldKey } from './keyboardMonitor.ts';
import type { ClipVoice, GlobalVoice } from './clipProgram.ts';

function run(name: string, fn: () => void): void {
  fn();
  console.log(`  ok - ${name}`);
}

/** A sound engine that logs every start and stop. */
function recorder(voice: () => ClipVoice) {
  const log: string[] = [];
  let seq = 0;
  const monitor = createKeyboardMonitor({
    voice,
    start: (key: HeldKey) => {
      seq += 1;
      log.push(`on ${key.note} v${key.velocity} p${key.voice.program ?? '-'}${key.voice.percussion ? ' drum' : ''} #${seq}`);
      return seq;
    },
    stop: (handle, key) => {
      log.push(`off ${key.note} #${String(handle)}`);
    },
  });
  return { monitor, log };
}

const piano = (): ClipVoice => ({ program: 0, percussion: false });

run('a held key sounds until its note-off, whichever form the note-off takes', () => {
  const { monitor, log } = recorder(piano);
  monitor.message([0x90, 60, 100]);
  monitor.message([0x90, 64, 90]);
  assert.deepEqual(log, ['on 60 v100 p0 #1', 'on 64 v90 p0 #2']);
  assert.equal(monitor.sounding().length, 2, 'both keys still sound while held');
  monitor.message([0x80, 60, 0]); // note-off
  monitor.message([0x90, 64, 0]); // note-on at velocity 0
  assert.deepEqual(log.slice(2), ['off 60 #1', 'off 64 #2']);
  assert.equal(monitor.sounding().length, 0);
});

run('the sustain pedal holds released keys until it lifts', () => {
  const { monitor, log } = recorder(piano);
  monitor.message([0xb0, 64, 127]); // pedal down
  monitor.message([0x90, 48, 100]);
  monitor.message([0x80, 48, 0]);
  monitor.message([0x90, 52, 100]);
  monitor.message([0x80, 52, 0]);
  monitor.message([0x90, 55, 100]); // still held when the pedal lifts
  assert.deepEqual(log, ['on 48 v100 p0 #1', 'on 52 v100 p0 #2', 'on 55 v100 p0 #3'], 'nothing released under the pedal');
  monitor.message([0xb0, 64, 0]); // pedal up
  assert.deepEqual(log.slice(3), ['off 48 #1', 'off 52 #2'], 'the pedalled keys release, the held one keeps sounding');
  monitor.message([0x80, 55, 0]);
  assert.deepEqual(log.slice(5), ['off 55 #3']);
});

run('a key struck again under the pedal restarts on a fresh voice', () => {
  const { monitor, log } = recorder(piano);
  monitor.message([0xb0, 64, 100]);
  monitor.message([0x90, 60, 80]);
  monitor.message([0x80, 60, 0]);
  monitor.message([0x90, 60, 110]);
  assert.deepEqual(log, ['on 60 v80 p0 #1', 'off 60 #1', 'on 60 v110 p0 #2']);
  monitor.message([0xb0, 64, 0]);
  assert.deepEqual(log.slice(3), [], 'the re-struck key is still held');
});

run('the pedal is per MIDI channel, and all-notes-off releases its channel', () => {
  const { monitor, log } = recorder(piano);
  monitor.message([0xb1, 64, 127]); // pedal on channel 2 only
  monitor.message([0x90, 60, 100]);
  monitor.message([0x91, 62, 100]);
  monitor.message([0x80, 60, 0]);
  monitor.message([0x81, 62, 0]);
  assert.deepEqual(log.slice(2), ['off 60 #1'], 'channel 1 releases, channel 2 is pedalled');
  monitor.message([0xb1, 123, 0]);
  assert.deepEqual(log.slice(3), ['off 62 #2']);
});

run('panic releases everything, pedalled or held', () => {
  const { monitor, log } = recorder(piano);
  monitor.message([0xb0, 64, 127]);
  monitor.message([0x90, 60, 100]);
  monitor.message([0x80, 60, 0]);
  monitor.message([0x90, 72, 100]);
  monitor.panic();
  assert.deepEqual(log.slice(2).sort(), ['off 60 #1', 'off 72 #2']);
  monitor.message([0x90, 74, 100]);
  monitor.message([0x80, 74, 0]);
  assert.equal(log.at(-1), 'off 74 #3', 'the pedal is up after a panic');
});

run('each key keeps the voice it started with when the armed track changes', () => {
  let current: ClipVoice = { program: 40, percussion: false };
  const { monitor, log } = recorder(() => current);
  monitor.message([0x90, 60, 100]);
  current = { program: 0, percussion: true };
  monitor.message([0x90, 36, 100]);
  monitor.message([0x80, 60, 0]);
  assert.deepEqual(log, ['on 60 v100 p40 #1', 'on 36 v100 p0 drum #2', 'off 60 #1']);
});

run('the voice is the armed MIDI track, its kit on a drum track, else the picker', () => {
  const global: GlobalVoice = { useSoundfont: true, activeProgram: 1 };
  const tracks = [
    { id: 'audio', color: '#fff' },
    { id: 'viola', color: '#fff', instrumentProgram: 41 },
    { id: 'drums', color: '#fff', isPercussion: true },
  ];
  const clips: never[] = [];
  assert.deepEqual(monitorVoice([], tracks, clips, global), { program: 1, percussion: false });
  assert.deepEqual(monitorVoice(['audio'], tracks, clips, global), { program: 1, percussion: false }, 'an audio track records the mic');
  assert.deepEqual(monitorVoice(['viola'], tracks, clips, global), { program: 41, percussion: false });
  assert.deepEqual(monitorVoice(['drums'], tracks, clips, global), { program: 0, percussion: true });
  assert.deepEqual(monitorVoice(['drums', 'viola'], tracks, clips, global), { program: 41, percussion: false }, 'the first armed track in track order');
  assert.deepEqual(monitorVoice([], tracks, clips, { useSoundfont: false, activeProgram: 1 }), { program: undefined, percussion: false });
});

console.log('keyboardMonitor: ok');
