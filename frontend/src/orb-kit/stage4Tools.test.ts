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

console.log('stage4Tools: ok');
