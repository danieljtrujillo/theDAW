/**
 * The assistant's MIDI stage 4 tools, driven through the dispatcher the chat
 * panel calls (orb-kit/actionHandlers handletheDAWAction): each is on the
 * browser's allowlist (assistantEvents), has its tier and receipt (tool-tiers),
 * and does to the stores what its catalog entry says.
 *
 *   cd frontend && npx tsx src/orb-kit/stage4Tools.test.ts
 */
import assert from 'node:assert/strict';
import { handletheDAWAction } from './actionHandlers.ts';
import { theDAW_ACTION_TYPES } from './assistantEvents.ts';
import { describeToolCall, getToolTier } from './tool-tiers.ts';
import { useEditorStore } from '../state/editorStore.ts';
import { symphonyTracks } from '../lib/symphonyTemplate.ts';
import { useTuningStore } from '../state/tuningStore.ts';
import { bankOffsetOf } from '../lib/bankRegistry.ts';

// The backend, as the tools reach it: the VST3 scan and the sound bank routes.
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const strings = {
  id: 'sb-0a1b2c3d4e5f',
  name: 'Chamber Strings',
  format: 'sf2',
  offset: 32,
  span: 1,
  presets: [
    { bank: 0, program: 40, name: 'Solo Violin', drum: false },
    { bank: 0, program: 48, name: 'Strings', drum: false },
  ],
};
let listed: unknown[] = [];
const asked: Array<{ url: string; body?: string }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  asked.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
  if (url.startsWith('/api/vst/scan')) {
    return json({
      plugins: [
        { name: 'Surge XT', display_name: 'Surge XT', path: 'C:/VST3/Surge XT.vst3', manufacturer: 'Surge', version: '1', category: 'instrument', file_size_mb: 1, last_modified: 0 },
        { name: 'Pro-Q 4', path: 'C:/VST3/Pro-Q 4.vst3', manufacturer: 'FabFilter', version: '4', category: 'effect', file_size_mb: 1, last_modified: 0 },
      ],
    });
  }
  if (url === '/api/soundfonts/add-path') {
    listed = [strings];
    return json({ bank: strings });
  }
  if (url === '/api/soundfonts') return json({ banks: listed });
  return json({ detail: `unexpected ${url}` }, 404);
}) as typeof fetch;

const ed = () => useEditorStore.getState();

// ── editor_add_symphony_template ────────────────────────────────────────────
{
  assert.ok(theDAW_ACTION_TYPES.has('editor_add_symphony_template'), 'the browser runs it');
  assert.equal(getToolTier('editor_add_symphony_template'), 'T1_inform', 'it adds and deletes nothing: a receipt');
  assert.match(describeToolCall('editor_add_symphony_template', { seating: 'european' }), /European seating/);

  ed().loadProject({ tracks: [], clips: [] });
  const before = ed().tracks.length;
  const said = await handletheDAWAction({ type: 'editor_add_symphony_template', payload: { seating: 'european' } });
  assert.match(said, /16 section tracks on 5 section buses/);
  const folder = ed().tracks[before];
  assert.equal(folder.isFolder, true, 'a folder holds the orchestra');
  const sections = ed().tracks.filter((t) => t.parentTrackId === folder.id);
  assert.deepEqual(sections.map((t) => t.name), symphonyTracks('european').map((t) => t.name), 'the European seating\'s sections');
  assert.ok(sections.every((t) => t.synthReverbSend === 0), 'the synth reverb is off on every section');
  assert.ok(ed().buses.some((b) => b.name === 'Hall'), 'the hall bus is there');
  // One undo takes the whole template back.
  ed().undo();
  assert.equal(ed().tracks.length, before);

  const refused = await handletheDAWAction({ type: 'editor_add_symphony_template', payload: { seating: 'japanese' } });
  assert.match(refused, /seating must be 'american' or 'european'/);
  assert.equal(ed().tracks.length, before, 'a refused call adds nothing');
}

// ── editor_set_tuning ───────────────────────────────────────────────────────
{
  assert.equal(getToolTier('editor_set_tuning'), 'T1_inform');
  const said = await handletheDAWAction({ type: 'editor_set_tuning', payload: { reference_hz: 415, temperament: 'meantone', root: 'Eb' } });
  assert.match(said, /A = 415 Hz, Quarter-comma meantone on E♭/);
  const t = useTuningStore.getState().tuning;
  assert.deepEqual([t.referenceHz, t.temperament, t.root], [415, 'meantone', 3]);
  assert.match(await handletheDAWAction({ type: 'editor_set_tuning', payload: { reference_hz: 500 } }), /reference_hz must be 380-480/);
  assert.match(await handletheDAWAction({ type: 'editor_set_tuning', payload: { temperament: 'scala' } }), /imported from its file/);
  assert.match(await handletheDAWAction({ type: 'editor_set_tuning', payload: { root: 'H' } }), /root must be 0-11 or a note name/);
  assert.match(await handletheDAWAction({ type: 'editor_set_tuning', payload: {} }), /pass reference_hz, temperament or root/);
  assert.equal(useTuningStore.getState().tuning.referenceHz, 415, 'a refused call changes nothing');
  await handletheDAWAction({ type: 'editor_set_tuning', payload: { reference_hz: 440, temperament: 'equal', root: 0 } });
}

// ── editor_load_sound_bank and editor_list_sound_banks ────────────────────────
{
  assert.equal(getToolTier('editor_list_sound_banks'), 'T0_silent', 'a list changes nothing');
  assert.equal(getToolTier('editor_load_sound_bank'), 'T1_inform');
  assert.match(await handletheDAWAction({ type: 'editor_list_sound_banks' }), /No sound banks of your own yet/);
  const before = asked.length;
  assert.match(await handletheDAWAction({ type: 'editor_load_sound_bank', payload: { path: 'C:/Sounds/notes.txt' } }), /not an \.sf2, \.sf3 or \.dls file/);
  assert.equal(asked.length, before, 'a file that is not a bank never reaches the backend');
  const said = await handletheDAWAction({ type: 'editor_load_sound_bank', payload: { path: 'C:/Sounds/Chamber Strings.sf2' } });
  assert.match(said, /Added the sound bank Chamber Strings \(sb-0a1b2c3d4e5f\) at bank select 32: 2 presets, 0:40 Solo Violin, 0:48 Strings/);
  const post = asked.find((a) => a.url === '/api/soundfonts/add-path');
  assert.deepEqual(JSON.parse(post?.body ?? '{}'), { path: 'C:/Sounds/Chamber Strings.sf2' });
  assert.equal(bankOffsetOf(strings.id), 32, 'every picker and synth resolves it at its offset');
  assert.match(await handletheDAWAction({ type: 'editor_list_sound_banks' }), /1 sound bank\(s\): Chamber Strings \(sb-0a1b2c3d4e5f, bank select 32, 2 presets\)/);
}

// ── editor_set_track_instrument ──────────────────────────────────────────────
{
  assert.equal(getToolTier('editor_set_track_instrument'), 'T1_inform');
  ed().loadProject({
    tracks: [{ id: 'tk', name: 'Lead', nameAutoGenerated: false, volume: 0.8, pan: 0, mute: false, solo: false, color: '#8b5cf6' }],
    clips: [],
    bpm: 120,
  });
  const lead = () => ed().tracks.find((t) => t.id === 'tk')!;
  assert.match(await handletheDAWAction({ type: 'editor_set_track_instrument', payload: { track_id: 'Lead', plugin: 'Pro-Q 4' } }), /no scanned VST3 instrument "Pro-Q 4"\. Scanned instruments: Surge XT/);
  assert.equal(lead().instrument, undefined, 'an effect is not an instrument');
  assert.match(await handletheDAWAction({ type: 'editor_set_track_instrument', payload: { track_id: 'Lead', plugin: 'surge xt' } }), /plays its MIDI through Surge XT/);
  assert.deepEqual([lead().instrument?.enabled, lead().instrument?.vst?.plugin_path], [true, 'C:/VST3/Surge XT.vst3']);
  assert.match(await handletheDAWAction({ type: 'editor_set_track_instrument', payload: { track_id: 'Lead', enabled: false } }), /is off: the track plays on EDIT's synths/);
  assert.equal(lead().instrument?.enabled, false);
  assert.match(await handletheDAWAction({ type: 'editor_set_track_instrument', payload: { track_id: 'Lead', remove: true } }), /plays its MIDI on EDIT's synths again/);
  assert.equal(lead().instrument, undefined);
  ed().undo();
  assert.equal(lead().instrument?.vst?.plugin_name, 'Surge XT', 'one undo puts the slot back');
  assert.match(await handletheDAWAction({ type: 'editor_set_track_instrument', payload: { track_id: 'Lead' } }), /pass plugin, enabled or remove/);
}

console.log('stage4Tools: ok');
