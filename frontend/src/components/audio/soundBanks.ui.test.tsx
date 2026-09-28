/**
 * The controls for stage 4's sound: sound banks, tuning and a track's MIDI
 * out, driven the way a user does in jsdom.
 *
 * The sequence: a user bank is added in the Banks dialog (the upload goes to
 * the backend, which answers with the bank and its offset); it is listed in
 * the dialog and its presets appear at once in the MIDI dock's picker, EDIT's
 * track picker and a clip's picker; picking one sets the voice with its bank;
 * the bank is removed again. The tuning panel sets A = 415 and imports a
 * Scala file. The track's MIDI out panel picks a port, a channel, clock and
 * the expression channels. Every native control has a label that names it.
 *
 *   cd frontend && npx tsx src/components/audio/soundBanks.ui.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;
const globals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  HTMLSelectElement: win.HTMLSelectElement,
  HTMLInputElement: win.HTMLInputElement,
  Node: win.Node,
  Event: win.Event,
  PointerEvent: win.MouseEvent,
  getComputedStyle: win.getComputedStyle.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });

// The backend: the bank list, an upload, a remove. Every other call answers an empty list.
const bankEntry = {
  id: 'sb-0123456789ab',
  name: 'Chamber Strings',
  format: 'sf2',
  offset: 32,
  span: 2,
  size: 4096,
  path: 'C:/data/soundfonts/sb-0123456789ab.sf2',
  presets: [
    { bank: 0, bank_lsb: 0, program: 40, name: 'Solo Violin', drum: false },
    { bank: 1, bank_lsb: 0, program: 40, name: 'Violin Pizz', drum: false },
  ],
};
let listed: unknown[] = [];
const calls: string[] = [];
globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const u = String(url);
  const method = init?.method ?? 'GET';
  calls.push(`${method} ${u}`);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u === '/api/soundfonts' && method === 'GET') return json({ banks: listed, offset_range: [32, 119] });
  if (u === '/api/soundfonts/upload') {
    listed = [bankEntry];
    return json({ bank: bankEntry });
  }
  if (u.startsWith('/api/soundfonts/') && method === 'DELETE') {
    listed = [];
    return json({ removed: bankEntry.id });
  }
  if (u.startsWith('/api/places/recent')) return json({ items: [] });
  return json({});
}) as typeof fetch;

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { SoundBanksDialog } = await import('./SoundBanksDialog.tsx');
const { InstrumentPicker } = await import('./InstrumentPicker.tsx');
const { TrackInstrumentSelect, ClipInstrumentSelect } = await import('./WaveformEditor.tsx');
const { TuningControl } = await import('./TuningControl.tsx');
const { TrackMidiOut } = await import('./TrackMidiOut.tsx');
const { useSoundBankStore } = await import('../../state/soundBankStore.ts');
const { useSoundfontStore } = await import('../../lib/soundfontEngine.ts');
const { useEditorStore } = await import('../../state/editorStore.ts');
const { useTuningStore } = await import('../../state/tuningStore.ts');
const { setMidiOutputPorts } = await import('../../state/midiOutBus.ts');
const { clipVoice } = await import('../../lib/clipProgram.ts');

const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const change = (el: HTMLSelectElement | HTMLInputElement, value: string) =>
  act(async () => {
    el.value = value;
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
  });
const labelled = (el: Element) => {
  const id = el.getAttribute('id');
  assert.ok(id, `${el.tagName} has an id`);
  const label = win.document.querySelector(`label[for="${id}"]`);
  assert.ok(label && label.textContent?.trim(), `${el.tagName}#${id} has a label`);
  assert.ok(el.getAttribute('name'), `${el.tagName}#${id} has a name`);
};
const allLabelled = (scope: ParentNode) => scope.querySelectorAll('select, input').forEach(labelled);

const ed = () => useEditorStore.getState();
ed().loadProject({ tracks: [], clips: [] });
const trackId = ed().addTrack({ name: 'Violins', instrumentProgram: 40 });
const clipId = ed().addClipToTrack({
  trackId,
  label: 'Violins',
  audioBlob: null,
  mimeType: 'audio/wav',
  sourceDuration: 2,
  offsetIntoSource: 0,
  durationSec: 2,
  startSec: 0,
  color: '#f59e0b',
  sourceKind: 'piano-roll',
  sourcePianoRoll: [{ id: 'v1', note: 67, step: 0, length: 4, velocity: 90 }],
  sourceBpm: 120,
});
const track = () => ed().tracks.find((t) => t.id === trackId)!;
const clip = () => ed().clips.find((c) => c.id === clipId)!;

// ── the Banks dialog adds a bank ───────────────────────────────────────────
{
  await act(async () => root.render(<SoundBanksDialog onClose={() => undefined} />));
  await flush();
  const dialog = win.document.querySelector('[role="dialog"]')!;
  assert.ok(dialog.getAttribute('aria-labelledby'));
  assert.match(dialog.textContent ?? '', /No sound banks of your own yet/);
  allLabelled(win.document);
  const input = win.document.querySelector('input[type="file"]') as HTMLInputElement;
  assert.equal(input.getAttribute('accept'), '.sf2,.sf3,.dls');
  // Node's own File: the upload's FormData is node's.
  const file = new File([new Uint8Array([82, 73, 70, 70])], 'Chamber Strings.sf2');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new win.Event('change', { bubbles: true }));
  });
  await flush();
  assert.ok(calls.includes('POST /api/soundfonts/upload'), 'the file is uploaded');
  assert.match(dialog.textContent ?? '', /Chamber Strings/);
  assert.match(dialog.textContent ?? '', /bank select 32-33/, 'its offset range');
  assert.ok(win.document.querySelector('button[aria-label="Remove sound bank Chamber Strings"]'));
}

// ── every picker lists its presets at once ─────────────────────────────────
{
  await act(async () =>
    root.render(
      <div>
        <InstrumentPicker idPrefix="dock-instrument" compact />
        <TrackInstrumentSelect track={track()} />
        <ClipInstrumentSelect clip={clip()} />
      </div>,
    ),
  );
  allLabelled(host);
  const [dock, trackSel, clipSel] = [...host.querySelectorAll('select')] as HTMLSelectElement[];
  for (const sel of [dock, trackSel, clipSel]) {
    const groups = [...sel.querySelectorAll('optgroup')].map((g) => g.getAttribute('label'));
    assert.ok(groups.includes('Chamber Strings · bank 1'), `${sel.id} lists the bank by bank select`);
  }
  // The dock picker: the preset with its bank.
  await change(dock, 'b:sb-0123456789ab:1:40');
  const sf = useSoundfontStore.getState();
  assert.deepEqual([sf.activeProgram, sf.activeBankId, sf.activeBank, sf.useSoundfont], [40, 'sb-0123456789ab', 1, true]);
  // The track: its program, from the bank.
  await change(trackSel, 'b:sb-0123456789ab:0:40');
  assert.deepEqual([track().instrumentProgram, track().instrumentBankId, track().instrumentBank], [40, 'sb-0123456789ab', undefined]);
  assert.deepEqual(clipVoice(clip(), track(), { useSoundfont: true, activeProgram: 0 }), { program: 40, percussion: false, bank: 32 });
  // The clip: its own preset at bank 33.
  await act(async () => root.render(<ClipInstrumentSelect clip={clip()} />));
  const sel = host.querySelector('select') as HTMLSelectElement;
  await change(sel, 'b:sb-0123456789ab:1:40');
  assert.deepEqual([clip().instrumentProgram, clip().instrumentBank, clip().instrumentBankId], [40, 1, 'sb-0123456789ab']);
  assert.deepEqual(clipVoice(clip(), track(), { useSoundfont: true, activeProgram: 0 }), { program: 40, percussion: false, bank: 33 });
  await act(async () => root.render(<ClipInstrumentSelect clip={clip()} />));
  assert.equal((host.querySelector('select') as HTMLSelectElement).value, 'b:sb-0123456789ab:1:40', 'the select shows the bank preset');
  // A plain program drops the bank.
  await change(host.querySelector('select') as HTMLSelectElement, '41');
  assert.deepEqual([clip().instrumentProgram, clip().instrumentBank, clip().instrumentBankId], [41, undefined, undefined]);
}

// ── removing the bank ──────────────────────────────────────────────────────
{
  await act(async () => root.render(<SoundBanksDialog onClose={() => undefined} />));
  await flush();
  const remove = win.document.querySelector('button[aria-label="Remove sound bank Chamber Strings"]') as HTMLButtonElement;
  await act(async () => remove.click());
  await flush();
  assert.ok(calls.some((c) => c.startsWith('DELETE /api/soundfonts/sb-0123456789ab')));
  assert.equal(useSoundBankStore.getState().banks.filter((b) => b.kind === 'user').length, 0);
}

// ── tuning ─────────────────────────────────────────────────────────────────
{
  await act(async () => root.render(<TuningControl />));
  const button = host.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement;
  assert.match(button.getAttribute('aria-label') ?? '', /A=440 · Equal/);
  await act(async () => button.click());
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  const panel = win.document.getElementById(button.getAttribute('aria-controls')!)!;
  allLabelled(panel);
  const [ref, temperament] = [...panel.querySelectorAll('select')] as HTMLSelectElement[];
  await change(ref, '415');
  await change(temperament, 'werckmeister3');
  assert.equal(useTuningStore.getState().tuning.referenceHz, 415);
  assert.equal(useTuningStore.getState().tuning.temperament, 'werckmeister3');
  assert.match(button.textContent ?? '', /A=415 · Werckmeister III/);
  const scl = panel.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new win.File(['! meantone.scl\nQuarter-comma meantone\n12\n76.049\n193.157\n310.265\n386.314\n503.422\n579.471\n696.578\n772.627\n889.735\n1006.843\n1082.892\n2/1\n'], 'meantone.scl');
  Object.defineProperty(file, 'text', { value: async () => '! meantone.scl\nQuarter-comma meantone\n12\n76.049\n193.157\n310.265\n386.314\n503.422\n579.471\n696.578\n772.627\n889.735\n1006.843\n1082.892\n2/1\n' });
  Object.defineProperty(scl, 'files', { value: [file], configurable: true });
  await act(async () => {
    scl.dispatchEvent(new win.Event('change', { bubbles: true }));
  });
  await flush();
  const t = useTuningStore.getState().tuning;
  assert.equal(t.temperament, 'scala');
  assert.equal(t.scala?.cents.length, 12);
  assert.match(panel.textContent ?? '', /Quarter-comma meantone/);
  await act(async () => useTuningStore.getState().setTuning(null));
}

// ── a track's MIDI out ─────────────────────────────────────────────────────
{
  await act(async () => setMidiOutputPorts([{ id: 'p1', name: 'loopMIDI Port', send: () => undefined }]));
  await act(async () => root.render(<TrackMidiOut track={track()} />));
  const button = host.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement;
  assert.match(button.getAttribute('aria-label') ?? '', /Track Violins MIDI out/);
  await act(async () => button.click());
  const panel = win.document.getElementById(button.getAttribute('aria-controls')!)!;
  allLabelled(panel);
  const [port, channel, mpe] = [...panel.querySelectorAll('select')] as HTMLSelectElement[];
  await change(port, 'p1');
  assert.deepEqual(track().midiOut, { id: 'p1', label: 'loopMIDI Port', channel: 1 });
  await act(async () => root.render(<TrackMidiOut track={track()} />));
  const panel2 = win.document.getElementById(button.getAttribute('aria-controls')!)!;
  const [, channel2, mpe2] = [...panel2.querySelectorAll('select')] as HTMLSelectElement[];
  await change(channel2, '5');
  assert.equal(track().midiOut?.channel, 5);
  await act(async () => root.render(<TrackMidiOut track={track()} />));
  const clock = win.document.querySelector('input[type="checkbox"]') as HTMLInputElement;
  await act(async () => clock.click());
  assert.equal(track().midiOut?.clock, true);
  await change(mpe2, '4');
  assert.equal(track().mpeChannels, 4);
  void channel;
  void mpe;
}

// ── External only in the track's instrument select ────────────────────────
{
  await act(async () => root.render(<TrackInstrumentSelect track={track()} status={{ mode: 'live', external: true, channels: 1, reason: 'External only' }} />));
  const sel = host.querySelector('select') as HTMLSelectElement;
  const opt = [...sel.options].find((o) => o.value === 'external');
  assert.match(opt?.textContent ?? '', /External only \(loopMIDI Port\)/, 'names the port it plays through');
  await change(sel, 'external');
  assert.equal(track().externalOnly, true);
  assert.equal(track().instrumentProgram, undefined, "no program of theDAW's");
  await act(async () => root.render(<TrackInstrumentSelect track={track()} status={{ mode: 'live', external: true, channels: 1, reason: 'External only' }} />));
  assert.equal((host.querySelector('select') as HTMLSelectElement).value, 'external');
  assert.match(host.textContent ?? '', /Port/, 'the status reads Port');
  await change(host.querySelector('select') as HTMLSelectElement, 'gm:40');
  assert.deepEqual([track().externalOnly, track().instrumentProgram], [undefined, 40], 'an instrument brings the synth back');
}

await act(async () => root.unmount());
console.log('soundBanks.ui: ok');
