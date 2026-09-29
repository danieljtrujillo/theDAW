/**
 * Mount test for "Use song tempo" (SongTempoDialog.tsx) against the real
 * editor store and a real rhythm analysis read from the running app
 * (lib/__fixtures__/rhythm-owl-grinned.json).
 *
 * The sequence a user makes: a stem of the song sits on the timeline at 0;
 * they ask for its song tempo, read what will change (the tempo, where the
 * first downbeat lands, how many tempo changes, the meter), press Use song
 * tempo and undo it once. A song with no analysis yet offers to analyse it
 * first. Escape closes without changing anything.
 *
 *   cd frontend && npx tsx src/components/audio/SongTempoDialog.test.tsx
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;
for (const [key, value] of Object.entries({
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  Element: win.Element,
  Node: win.Node,
  localStorage: win.localStorage,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { SongTempoDialog } = await import('./SongTempoDialog.tsx');
const { useEditorStore } = await import('../../state/editorStore.ts');
const { editBarStartSec } = await import('../../lib/editTimeMap.ts');

const fx = JSON.parse(readFileSync(new URL('../../lib/__fixtures__/rhythm-owl-grinned.json', import.meta.url), 'utf8'));
const SONG: string = fx.rhythm.entry_id;

let analysed = true;
const requests: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  requests.push(`${init?.method ?? 'GET'} ${url}`);
  if (url === `/api/rhythm/${SONG}`) {
    return new Response(JSON.stringify(analysed ? { ...fx.rhythm, status: 'ready' } : { entry_id: SONG, status: 'pending' }), { status: 200 });
  }
  if (url === `/api/rhythm/${SONG}/run` && init?.method === 'POST') {
    analysed = true;
    return new Response(JSON.stringify({ ...fx.rhythm, status: 'ready' }), { status: 200 });
  }
  return new Response(JSON.stringify({ status: 'pending' }), { status: 200 });
}) as typeof fetch;

const st = () => useEditorStore.getState();
const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); });
const buttonNamed = (name: RegExp): HTMLButtonElement => {
  const b = [...document.querySelectorAll('button')].find((x) => name.test(x.textContent ?? '') || name.test(x.getAttribute('aria-label') ?? ''));
  assert.ok(b, `a button named ${name}`);
  return b as HTMLButtonElement;
};
const statusWord = () => document.querySelector('[role="status"]')?.textContent?.trim();
const dd = (term: string): string => {
  const dt = [...document.querySelectorAll('dt')].find((x) => x.textContent === term);
  assert.ok(dt, `a "${term}" row`);
  return dt.nextElementSibling?.textContent ?? '';
};

// A drums stem of the song on the timeline at 0, a fresh 120 BPM 4/4 project.
st().loadProject({ tracks: [], clips: [], bpm: 120, timeSignature: { num: 4, den: 4 } });
const trackId = st().addTrack({ name: 'Drums' });
const clipId = st().addClipToTrack({
  trackId, label: 'The Owl Grinned · drums', audioBlob: new Blob([new Uint8Array(4)]), mimeType: 'audio/wav',
  sourceDuration: 295.2, offsetIntoSource: 0, durationSec: 295.2, startSec: 0, color: '#fff',
  songTime: { entryId: SONG, bpm: 103.359375, offsetSec: 0, rate: 1 },
});

const host = document.createElement('div');
document.body.appendChild(host);
const root = createRoot(host);
let closed = 0;
const onClose = () => { closed += 1; st().dismissSongTempoRequest(); };

// 1. The preview, then Use song tempo, then one undo.
{
  st().requestSongTempo({ entryId: SONG, clipId });
  await act(async () => { root.render(<SongTempoDialog request={st().songTempoRequest!} onClose={onClose} />); });
  await settle();
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog, 'a dialog');
  assert.equal(document.activeElement, dialog, 'focus is in the dialog, so Escape reaches it');
  const heading = document.getElementById(dialog.getAttribute('aria-labelledby') ?? '');
  assert.ok(heading && /Use song tempo/.test(heading.textContent ?? ''), 'the dialog is named by its heading');
  assert.equal(statusWord(), 'Ready');
  assert.ok(requests.includes(`GET /api/rhythm/${SONG}`), 'the analysis was read, not run');
  assert.ok(!requests.some((r) => r.startsWith('POST')), 'nothing was run');
  assert.match(dd('First downbeat'), /^0:01\.56, which becomes bar 2$/);
  assert.match(dd('Tempo'), /^120 BPM now, [\d.]+-[\d.]+ BPM after/);
  assert.match(dd('Tempo changes'), /^\d+, following the song's downbeats bar by bar$/);
  assert.match(dd('Meter'), /^6\/8/);
  assert.match(dd('Bar lines'), /land on the song's downbeats, within 0\.\d\d ms/);
  assert.ok(/Bar 1 becomes a 5\/4 bar/.test(document.body.textContent ?? ''), 'the bar cut before the downbeat is named');
  assert.equal(st().tempoMap.length, 1, 'nothing changed yet');

  const use = buttonNamed(/^Use song tempo$/);
  assert.equal(use.disabled, false);
  const before = { tempoMap: st().tempoMap, meterMap: st().meterMap };
  await act(async () => { use.click(); });
  assert.equal(closed, 1, 'it closes once applied');
  assert.ok(st().tempoMap.length > 20, 'the tempo follows the song');
  assert.ok(Math.abs(editBarStartSec(st(), 1) - 1.5557) < 0.002, 'bar 2 is on the first downbeat');
  await act(async () => { st().undo(); });
  assert.equal(st().tempoMap, before.tempoMap, 'one undo takes the tempo back');
  assert.equal(st().meterMap, before.meterMap, 'and the meter');
  await act(async () => { root.render(<></>); });
}

// 2. A song with no analysis: Unanalysed, and a press analyses it.
{
  analysed = false;
  requests.length = 0;
  st().requestSongTempo({ entryId: SONG, clipId });
  await act(async () => { root.render(<SongTempoDialog request={st().songTempoRequest!} onClose={onClose} />); });
  await settle();
  assert.equal(statusWord(), 'Unanalysed');
  assert.equal(buttonNamed(/^Use song tempo$/).disabled, true, 'nothing to apply yet');
  await act(async () => { buttonNamed(/Analyse the song/).click(); });
  await settle();
  assert.ok(requests.includes(`POST /api/rhythm/${SONG}/run`), 'the press ran the analysis');
  assert.equal(statusWord(), 'Ready');
  assert.match(dd('First downbeat'), /becomes bar 2/);

  // 3. Escape closes without changing anything.
  const tempo = st().tempoMap;
  await act(async () => {
    document.querySelector('[role="dialog"]')!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  assert.equal(closed, 2);
  assert.equal(st().tempoMap, tempo);
  assert.equal(st().songTempoRequest, null);
}

// 4. A clip that is not from a library song says why there is nothing to use.
{
  await act(async () => { root.render(<></>); });
  const plainId = st().addClipToTrack({
    trackId, label: 'Recording', audioBlob: new Blob([new Uint8Array(4)]), mimeType: 'audio/wav',
    sourceDuration: 10, offsetIntoSource: 0, durationSec: 10, startSec: 300, color: '#fff',
  });
  await act(async () => { root.render(<SongTempoDialog request={{ entryId: SONG, clipId: plainId }} onClose={onClose} />); });
  await settle();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert && /not from a library song/.test(alert.textContent ?? ''), 'the reason is shown');
  assert.equal(buttonNamed(/^Use song tempo$/).disabled, true);
}

await act(async () => { root.unmount(); });
console.log('SongTempoDialog: ok');
