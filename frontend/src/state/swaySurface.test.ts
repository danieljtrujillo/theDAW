/**
 * The Sway DAW-control mirror stands down while PERFORM or the SWAY tab is open.
 *
 * The mirror maps the Audima Sway's pads (notes 24-39 on channel 16) to a
 * General MIDI note, its Play button to EDIT's transport and its faders to
 * EDIT's mixer. PERFORM launches scenes and clips from the same controller and
 * the SWAY tab hands it to the cockpit, so with either open a pad press used to
 * launch (or fire a cockpit pad) AND sound a GM note on top. The sequence here
 * is the app's own: the mirror is enabled the way App.tsx auto-enables it for
 * the Sway, the tab is chosen through the app's UI store, and the pad arrives
 * on the global MIDI bus the way the Web MIDI listener publishes it.
 *
 *   cd frontend && npx tsx src/state/swaySurface.test.ts
 */
import assert from 'node:assert/strict';

import { startSwaySurface, swaySurfaceConsumes, type SwaySurfaceDeps } from './swaySurface.ts';
import { useSwaySurfaceStore } from './swaySurfaceStore.ts';
import { useAppUiStore } from './appUiStore.ts';
import { publishMidi } from './midiBus.ts';
import { registerEditorPlayback, unregisterEditorPlayback } from './editorPlaybackBridge.ts';
import { useEditorStore } from './editorStore.ts';

/** Every sound the mirror makes, as the synth it drives would receive it. */
const heard: string[] = [];
const deps: SwaySurfaceDeps = {
  liveSynthReady: () => true,
  warmSoundfont: () => {},
  oneShot: (note, velocity) => { heard.push(`one-shot ${note} ${velocity}`); },
  noteOn: (channel, _program, note, velocity) => { heard.push(`on ch${channel} ${note} ${velocity}`); },
  noteOff: (channel, note) => { heard.push(`off ch${channel} ${note}`); },
};

const transportPresses: string[] = [];
registerEditorPlayback(() => transportPresses.push('play'), () => transportPresses.push('stop'));

const PAD_ON = [0x9f, 24, 100];
const PAD_OFF = [0x8f, 24, 0];
const PLAY_ON = [0x90, 0, 127];
const FADER_1 = [0xb0, 1, 64];

useSwaySurfaceStore.setState({ enabled: false, touched: false, padMode: 'piano', sustain: false });
useSwaySurfaceStore.getState().autoEnable(); // the Sway was detected
useEditorStore.getState().addTrack({ name: 'Keys', volume: 1 });
assert.equal(useEditorStore.getState().tracks.length > 0, true, 'EDIT has a strip for fader 1 to move');
const stop = startSwaySurface(deps);

// ── PERFORM open: a pad press sounds nothing, and nothing reaches EDIT ────────
for (const tab of ['session', 'sway'] as const) {
  heard.length = 0;
  transportPresses.length = 0;
  useAppUiStore.getState().setCenterTab(tab);
  const volumeBefore = useEditorStore.getState().tracks[0]?.volume;
  publishMidi(PAD_ON);
  publishMidi(PAD_OFF);
  publishMidi(PLAY_ON);
  publishMidi(FADER_1);
  assert.deepEqual(heard, [], `${tab}: pad note 24 on channel 16 plays no General MIDI note`);
  assert.deepEqual(transportPresses, [], `${tab}: the Play button does not start EDIT under it`);
  assert.equal(useEditorStore.getState().tracks[0]?.volume, volumeBefore, `${tab}: a fader does not move an EDIT strip`);
  // The keyboard monitor stays out too: the pad is still the controller's, not a key.
  assert.equal(swaySurfaceConsumes(PAD_ON), true, `${tab}: the pad is kept from the keyboard monitor`);
}

// ── EDIT open: the mirror plays the pad as it always has ──────────────────────
{
  heard.length = 0;
  transportPresses.length = 0;
  useAppUiStore.getState().setCenterTab('edit');
  publishMidi(PAD_ON);
  assert.equal(heard.length, 1, 'with EDIT open the pad sounds');
  assert.match(heard[0], /^on ch\d+ \d+ 100$/);
  publishMidi(PAD_OFF);
  assert.equal(heard.length, 2);
  assert.match(heard[1], /^off ch\d+ \d+$/, 'and releases');
  publishMidi(PLAY_ON);
  assert.deepEqual(transportPresses, ['play'], 'the Play button drives EDIT');
}

// ── a pad held (or latched) when PERFORM opens is released, not left ringing ──
{
  heard.length = 0;
  useAppUiStore.getState().setCenterTab('make');
  useSwaySurfaceStore.setState({ sustain: true });
  publishMidi(PAD_ON);
  assert.equal(heard.length, 1, 'a latched pad sounds on MAKE');
  useAppUiStore.getState().setCenterTab('session');
  assert.equal(heard.length, 2, 'opening PERFORM releases it');
  assert.match(heard[1], /^off ch\d+ \d+$/);
  useSwaySurfaceStore.setState({ sustain: false });
}

stop();
unregisterEditorPlayback();
console.log('swaySurface: ok');
